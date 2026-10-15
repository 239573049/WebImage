from __future__ import annotations

import base64
import importlib.util
import json
import socket
import sys
import threading
import unittest
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

from services.config import DEFAULT_SENTINEL_SOLVER, _normalize_sentinel_solver_settings
from services.sentinel_solver_service import SentinelSolverService
from utils.pow import _js_date_string

SOLVER_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sentinel_solver.py"


class FakeConfig:
    def __init__(self, settings: dict | None) -> None:
        self.settings = settings

    def get_sentinel_solver_settings(self) -> dict | None:
        return self.settings


def make_service(**overrides: object) -> SentinelSolverService:
    settings = dict(DEFAULT_SENTINEL_SOLVER)
    settings.update(overrides)
    service = SentinelSolverService()
    service.settings = lambda: dict(settings)      # type: ignore[method-assign]
    return service


class SentinelSolverSettingsTests(unittest.TestCase):
    def test_defaults_are_disabled_and_empty(self) -> None:
        self.assertEqual(
            _normalize_sentinel_solver_settings(None),
            {"enabled": False, "url": "", "key": "", "timeout_seconds": 180},
        )

    def test_url_is_trimmed_and_timeout_has_a_floor(self) -> None:
        normalized = _normalize_sentinel_solver_settings(
            {"enabled": 1, "url": "  http://127.0.0.1:8788/  ", "key": " s3cret ", "timeout_seconds": 0}
        )

        self.assertTrue(normalized["enabled"])
        self.assertEqual(normalized["url"], "http://127.0.0.1:8788")
        self.assertEqual(normalized["key"], "s3cret")
        self.assertEqual(normalized["timeout_seconds"], 1)


class SentinelSolverServiceTests(unittest.TestCase):
    def test_disabled_without_url_even_when_enabled(self) -> None:
        self.assertFalse(make_service(enabled=True, url="").enabled())
        self.assertFalse(make_service(enabled=False, url="http://127.0.0.1:8788").enabled())
        self.assertTrue(make_service(enabled=True, url="http://127.0.0.1:8788").enabled())

    def test_solve_returns_none_when_disabled(self) -> None:
        service = make_service(enabled=False, url="http://127.0.0.1:8788")

        self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "x"}}, "p"))

    def test_solve_posts_requirements_and_key_then_returns_token(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="test-key")
        captured: dict = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return json.dumps({"ok": True, "turnstile": "TOKEN"}).encode()

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.headers)
            captured["body"] = json.loads(request.data.decode())
            captured["timeout"] = timeout
            return FakeResponse()

        with patch("services.sentinel_solver_service.urllib.request.urlopen", fake_urlopen):
            token = service.solve_turnstile({"turnstile": {"dx": "d"}, "persona": "chatgpt-paid"}, "p-token")

        self.assertEqual(token, "TOKEN")
        self.assertEqual(captured["url"], "http://127.0.0.1:8788/turnstile")
        self.assertEqual(captured["headers"].get("X-solver-key"), "test-key")
        self.assertEqual(captured["body"], {"requirements": {"turnstile": {"dx": "d"}, "persona": "chatgpt-paid"},
                                            "p": "p-token"})
        self.assertEqual(captured["timeout"], 180)

    def test_solve_returns_none_when_solver_reports_failure(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="k")

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return json.dumps({"ok": False, "error": "vm timeout"}).encode()

        with patch("services.sentinel_solver_service.urllib.request.urlopen", lambda *a, **k: FakeResponse()):
            self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "d"}}, "p"))

    def test_solve_returns_none_on_network_error(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="k")

        with patch("services.sentinel_solver_service.urllib.request.urlopen", side_effect=OSError("boom")):
            self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "d"}}, "p"))

    def test_no_key_configured_means_no_key_header(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="")

        self.assertNotIn("X-Solver-Key", service._headers(service.settings()))


class SentinelDateStringTests(unittest.TestCase):
    """指纹里的 `"" + new Date`：UTC 或非 ASCII 时区名都会被上游判为不可信（404 Model not found）。"""

    def test_converts_to_utc_plus_8_with_browser_style_name(self) -> None:
        moment = datetime(2026, 10, 15, 6, 7, 8, tzinfo=timezone.utc)

        self.assertEqual(_js_date_string(moment), "Thu Oct 15 2026 14:07:08 GMT+0800 (China Standard Time)")

    def test_ignores_process_timezone(self) -> None:
        # 容器默认 TZ=UTC，结果仍必须是东八区且为 ASCII
        value = _js_date_string()

        self.assertTrue(value.endswith(" GMT+0800 (China Standard Time)"), value)
        self.assertTrue(value.isascii(), value)


def _load_solver_script():
    spec = importlib.util.spec_from_file_location("sentinel_solver_under_test", SOLVER_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _pump(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


class _EchoServer:
    """CONNECT 隧道的目标：收到什么回什么。"""

    def __init__(self) -> None:
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._echo, args=(conn,), daemon=True).start()

    @staticmethod
    def _echo(conn: socket.socket) -> None:
        with conn:
            while data := conn.recv(65536):
                conn.sendall(data)


def _start_upstream_proxy(expected_auth: str, seen: list[str]) -> ThreadingHTTPServer:
    """要求 Proxy-Authorization 的上游代理：CONNECT 透传，普通 http 直接回显请求目标。"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            return

        def _authorized(self) -> bool:
            seen.append(self.headers.get("Proxy-Authorization", ""))
            if seen[-1] == expected_auth:
                return True
            self.send_response(407)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False

        def do_CONNECT(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            host, port = self.path.rsplit(":", 1)
            target = socket.create_connection((host, int(port)), timeout=5)
            self.send_response(200, "Connection established")
            self.end_headers()
            threading.Thread(target=_pump, args=(target, self.connection), daemon=True).start()
            _pump(self.connection, target)

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            body = f"via-upstream {self.path}".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class PageProxyRelayTests(unittest.TestCase):
    """Chrome 不接受带凭据的代理：solver 在本机起转发，只用标准库（镜像里没有 curl_cffi）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.solver = _load_solver_script()

    def setUp(self) -> None:
        self.seen: list[str] = []
        self.expected_auth = "Basic " + base64.b64encode(b"user:p@ss").decode()
        upstream = _start_upstream_proxy(self.expected_auth, self.seen)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        self.echo = _EchoServer()
        self.addCleanup(self.echo.sock.close)
        # 凭据按 URL 编码书写（@ -> %40），转发时要解码
        proxy = f"http://user:p%40ss@127.0.0.1:{upstream.server_address[1]}"
        with patch.dict(sys.modules, {"curl_cffi": None, "curl_cffi.requests": None}):
            self.local, stop = self.solver.make_page_proxy(proxy)
        self.assertTrue(self.local.startswith("http://127.0.0.1:"), self.local)
        self.addCleanup(stop)

    def test_https_tunnel_goes_through_upstream_with_credentials(self) -> None:
        relay = urlparse(self.local)
        with socket.create_connection((relay.hostname, relay.port), timeout=5) as client:
            target = f"127.0.0.1:{self.echo.port}"
            client.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
            head = b""
            while b"\r\n\r\n" not in head:
                head += client.recv(4096)
            self.assertIn(b" 200 ", head.split(b"\r\n", 1)[0] + b" ")
            client.sendall(b"ping")
            echoed = b""
            while len(echoed) < 4:
                echoed += client.recv(4)

        self.assertEqual(echoed, b"ping")
        self.assertEqual(self.seen, [self.expected_auth])

    def test_plain_http_is_forwarded_with_credentials(self) -> None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": self.local}))
        with opener.open("http://example.invalid/hello?x=1", timeout=5) as response:
            body = response.read()

        self.assertEqual(body, b"via-upstream http://example.invalid/hello?x=1")
        self.assertEqual(self.seen, [self.expected_auth])

    def test_proxy_without_credentials_is_handed_to_chrome_as_is(self) -> None:
        self.assertEqual(self.solver.make_page_proxy("http://10.0.0.1:8080"), ("http://10.0.0.1:8080", None))
        self.assertEqual(self.solver.make_page_proxy(""), ("", None))


if __name__ == "__main__":
    unittest.main()
