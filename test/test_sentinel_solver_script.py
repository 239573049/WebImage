"""scripts/sentinel_solver.py 的单元测试（不需要真实 Chromium）。

脚本不是包内模块，用 importlib 按路径加载；浏览器、页面、browser 级 CDP 连接都用 fake 替换。
转发器测试用本机假上游（HTTP CONNECT / HTTPS / SOCKS5）+ echo 服务端到端跑字节，并屏蔽 curl_cffi。
"""

from __future__ import annotations

import base64
import importlib
import importlib.util
import json
import selectors
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from unittest import mock
from urllib.parse import quote, urlsplit

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sentinel_solver.py"


def load_solver(name: str = "sentinel_solver_script_under_test") -> Any:
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


solver = load_solver()

REQS = {"turnstile": {"dx": "abc"}}


# ---------------------------------------------------------------------------
# socket 小工具与假服务
# ---------------------------------------------------------------------------


def _read_head(sock: socket.socket) -> tuple[bytes, bytes]:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError(f"closed before head completed: {buf!r}")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head, rest


def _recv_exact(sock: socket.socket, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("closed early")
        data += chunk
    return data


def _recv_all(sock: socket.socket) -> bytes:
    data = b""
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            return data
        data += chunk


def _pipe(a: socket.socket, b: socket.socket) -> None:
    """测试用单线程双向转发（TLS 套接字不跨线程读写），任一端 EOF 即结束。"""
    peers = {a: b, b: a}
    selector = selectors.DefaultSelector()
    try:
        for sock in (a, b):
            selector.register(sock, selectors.EVENT_READ)
        while True:
            ready = [s for s in (a, b) if isinstance(s, ssl.SSLSocket) and s.pending()]
            if not ready:
                ready = [key.fileobj for key, _ in selector.select(5)]
            if not ready:
                return
            for sock in ready:
                data = sock.recv(65536)
                if not data:
                    return
                peers[sock].sendall(data)
    except OSError:
        return
    finally:
        selector.close()
        for sock in (a, b):
            try:
                sock.close()
            except OSError:
                pass


def _parse_headers(lines: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in lines:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    return headers


class FakeTcpServer:
    def __init__(self, handler: Callable[[socket.socket], None], tls: ssl.SSLContext | None = None) -> None:
        self.handler = handler
        self.tls = tls
        self.errors: list[BaseException] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self._stop = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            threading.Thread(target=self._run, args=(conn,), daemon=True).start()

    def _run(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(5)
            if self.tls is not None:
                conn = self.tls.wrap_socket(conn, server_side=True)
            self.handler(conn)
        except Exception as exc:  # pragma: no cover - 仅用于排查
            self.errors.append(exc)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self) -> None:
        self._stop.set()
        self.listener.close()


def _echo(conn: socket.socket) -> None:
    while True:
        data = conn.recv(65536)
        if not data:
            return
        conn.sendall(data)


class FakeHttpProxy:
    """HTTP(S) 代理：校验 Proxy-Authorization；任何主机名都在“代理端”解析为 127.0.0.1。"""

    def __init__(self, username: str, password: str, tls: ssl.SSLContext | None = None) -> None:
        raw = f"{username}:{password}".encode()
        self.expected_auth = "Basic " + base64.b64encode(raw).decode()
        self.requests: list[tuple[str, dict[str, str]]] = []
        self.server = FakeTcpServer(self.handle, tls=tls)
        self.port = self.server.port

    def handle(self, conn: socket.socket) -> None:
        head, rest = _read_head(conn)
        lines = head.decode("latin1").split("\r\n")
        headers = _parse_headers(lines[1:])
        self.requests.append((lines[0], headers))
        method, target, _ = lines[0].split(" ")
        if headers.get("proxy-authorization") != self.expected_auth:
            conn.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            return
        if method == "CONNECT":
            _, port = target.rsplit(":", 1)
            upstream = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            if rest:
                upstream.sendall(rest)
            _pipe(conn, upstream)
            return
        body = f"proxied {lines[0]}".encode()
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)

    def close(self) -> None:
        self.server.close()


class FakeSocks5:
    """RFC1928/1929 服务端：只接受用户名密码认证；记录目标地址类型，并把任何目标都连到 127.0.0.1。"""

    def __init__(self, username: str, password: str) -> None:
        self.username, self.password = username, password
        self.greetings: list[bytes] = []
        self.auths: list[tuple[str, str]] = []
        self.requests: list[tuple[int, str, int]] = []
        self.server = FakeTcpServer(self.handle)
        self.port = self.server.port

    def handle(self, conn: socket.socket) -> None:
        version, count = _recv_exact(conn, 2)
        methods = _recv_exact(conn, count)
        self.greetings.append(methods)
        if version != 5 or 2 not in methods:
            conn.sendall(b"\x05\xff")
            return
        conn.sendall(b"\x05\x02")
        _recv_exact(conn, 1)
        user = _recv_exact(conn, _recv_exact(conn, 1)[0]).decode()
        password = _recv_exact(conn, _recv_exact(conn, 1)[0]).decode()
        self.auths.append((user, password))
        if (user, password) != (self.username, self.password):
            conn.sendall(b"\x01\x01")
            return
        conn.sendall(b"\x01\x00")
        _, _, _, atyp = _recv_exact(conn, 4)
        if atyp == 3:
            host = _recv_exact(conn, _recv_exact(conn, 1)[0]).decode()
        elif atyp == 1:
            host = socket.inet_ntoa(_recv_exact(conn, 4))
        else:
            host = socket.inet_ntop(socket.AF_INET6, _recv_exact(conn, 16))
        port = struct.unpack(">H", _recv_exact(conn, 2))[0]
        self.requests.append((atyp, host, port))
        upstream = socket.create_connection(("127.0.0.1", port), timeout=5)
        conn.sendall(b"\x05\x00\x00\x01" + socket.inet_aton("127.0.0.1") + struct.pack(">H", 4321))
        _pipe(conn, upstream)

    def close(self) -> None:
        self.server.close()


class FakeOrigin:
    """普通 HTTP 源站：记录请求行与头，回固定内容后关闭。"""

    def __init__(self) -> None:
        self.requests: list[list[str]] = []
        self.server = FakeTcpServer(self.handle)
        self.port = self.server.port

    def handle(self, conn: socket.socket) -> None:
        head, _ = _read_head(conn)
        self.requests.append(head.decode("latin1").split("\r\n"))
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\norigin-ok")

    def close(self) -> None:
        self.server.close()


def _open_tunnel(local_proxy: str, host: str, port: int) -> tuple[socket.socket, bytes]:
    parsed = urlsplit(local_proxy)
    sock = socket.create_connection((parsed.hostname, parsed.port), timeout=5)
    sock.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
    head, _ = _read_head(sock)
    return sock, head.split(b"\r\n", 1)[0]


# ---------------------------------------------------------------------------
# 代理地址映射 / 脱敏
# ---------------------------------------------------------------------------


class ProxyMappingTests(unittest.TestCase):
    def test_unauthenticated_proxies_map_directly_for_chrome(self) -> None:
        cases = {
            "": "",
            "http://1.2.3.4:8080": "http://1.2.3.4:8080",
            "HTTP://Proxy.Example.com:3128": "http://proxy.example.com:3128",
            "1.2.3.4:3128": "http://1.2.3.4:3128",
            "https://proxy.example:8443": "https://proxy.example:8443",
            "socks5://10.0.0.1:1080": "socks5://10.0.0.1:1080",
            "socks5h://10.0.0.1:1080": "socks5://10.0.0.1:1080",
            "socks5h://[::1]:1080": "socks5://[::1]:1080",
        }
        for proxy, expected in cases.items():
            with self.subTest(proxy=proxy):
                self.assertEqual(solver.make_page_proxy(proxy), (expected, None))

    def test_default_ports_follow_curl(self) -> None:
        self.assertEqual(solver.parse_proxy_url("http://h").port, 1080)
        self.assertEqual(solver.parse_proxy_url("https://h").port, 443)
        self.assertEqual(solver.parse_proxy_url("socks5h://h").port, 1080)

    def test_authenticated_proxy_of_any_scheme_goes_through_local_forwarder(self) -> None:
        for proxy in ("http://u:p@1.2.3.4:8080", "https://u:p@1.2.3.4:443", "socks5://u:p@1.2.3.4:1080",
                      "socks5h://u:p@1.2.3.4:1080", "http://onlyuser@1.2.3.4:8080"):
            with self.subTest(proxy=proxy):
                local, shutdown = solver.make_page_proxy(proxy)
                try:
                    self.assertRegex(local, r"^http://127\.0\.0\.1:\d+$")
                    self.assertTrue(callable(shutdown))
                    self.assertNotIn("u:p", local)
                finally:
                    if shutdown:
                        shutdown()

    def test_invalid_proxy_raises_without_leaking_credentials(self) -> None:
        for proxy in ("ftp://user:topsecret@h:21", "socks4://user:topsecret@h:1080", "http://user:topsecret@:80",
                      "http://user:topsecret@h:99999"):
            with self.subTest(proxy=proxy):
                with self.assertRaises(ValueError) as ctx:
                    solver.make_page_proxy(proxy)
                self.assertNotIn("topsecret", str(ctx.exception))

    def test_normalized_key_keeps_credentials_and_redaction_hides_them(self) -> None:
        spec = solver.parse_proxy_url("socks5://us%40er:p%3Ass@Example.com:1080/ignored")
        self.assertEqual((spec.username, spec.password, spec.host), ("us@er", "p:ss", "example.com"))
        self.assertEqual(spec.url(), "socks5h://us%40er:p%3Ass@example.com:1080")
        self.assertEqual(spec.redacted(), "socks5h://[REDACTED]@example.com:1080")
        self.assertEqual(solver.redact_proxy_url("http://u:secret@h:1"), "http://[REDACTED]@h:1")
        self.assertNotIn("secret", solver.redact_proxy_text("failed via http://u:secret@h:1 and socks5h://a:secret@b:2"))
        # 凭据不同就是不同出口（住宅代理常用同一 host:port、不同用户名区分出口）
        self.assertNotEqual(solver.parse_proxy_url("http://a:x@h:1").url(), solver.parse_proxy_url("http://b:x@h:1").url())


# ---------------------------------------------------------------------------
# 纯 socket 转发器（屏蔽 curl_cffi）
# ---------------------------------------------------------------------------


class ForwarderTests(unittest.TestCase):
    mod: Any = None

    @classmethod
    def setUpClass(cls) -> None:
        patcher = mock.patch.dict(sys.modules, {"curl_cffi": None, "curl_cffi.requests": None})
        patcher.start()
        cls.addClassCleanup(patcher.stop)
        cls.mod = load_solver("sentinel_solver_script_no_curl")   # 在屏蔽状态下重新加载
        cls.echo = FakeTcpServer(_echo)
        cls.addClassCleanup(cls.echo.close)

    def _forwarder(self, proxy: str, **kwargs: Any) -> str:
        local, shutdown = self.mod.make_page_proxy(proxy, **kwargs)
        self.assertIsNotNone(shutdown)
        self.addCleanup(shutdown)
        return local

    def test_curl_cffi_is_really_blocked(self) -> None:
        with self.assertRaises(ImportError):
            importlib.import_module("curl_cffi")

    def test_connect_through_http_upstream_with_basic_auth(self) -> None:
        upstream = FakeHttpProxy("user", "p@ss:word")
        self.addCleanup(upstream.close)
        local = self._forwarder(f"http://user:{quote('p@ss:word', safe='')}@127.0.0.1:{upstream.port}")

        sock, status = _open_tunnel(local, "echo.invalid", self.echo.port)
        with sock:
            self.assertIn(b" 200 ", status)
            sock.sendall(b"hello through http proxy")
            self.assertEqual(_recv_exact(sock, 24), b"hello through http proxy")

        line, headers = upstream.requests[0]
        self.assertEqual(line, f"CONNECT echo.invalid:{self.echo.port} HTTP/1.1")
        self.assertEqual(headers["proxy-authorization"], upstream.expected_auth)

    def test_upstream_rejection_becomes_502(self) -> None:
        upstream = FakeHttpProxy("user", "right")
        self.addCleanup(upstream.close)
        local = self._forwarder(f"http://user:wrong@127.0.0.1:{upstream.port}")
        sock, status = _open_tunnel(local, "echo.invalid", self.echo.port)
        sock.close()
        self.assertIn(b" 502 ", status)

    def test_plain_http_request_is_forwarded_with_credentials(self) -> None:
        upstream = FakeHttpProxy("user", "secret")
        self.addCleanup(upstream.close)
        local = self._forwarder(f"http://user:secret@127.0.0.1:{upstream.port}")
        parsed = urlsplit(local)
        with socket.create_connection((parsed.hostname, parsed.port), timeout=5) as sock:
            sock.sendall(b"GET http://plain.invalid:8080/x?y=1 HTTP/1.1\r\nHost: plain.invalid:8080\r\n"
                         b"Proxy-Connection: keep-alive\r\n\r\n")
            response = _recv_all(sock)
        self.assertIn(b"200 OK", response)
        self.assertTrue(response.endswith(b"proxied GET http://plain.invalid:8080/x?y=1 HTTP/1.1"))
        line, headers = upstream.requests[0]
        self.assertEqual(headers["proxy-authorization"], upstream.expected_auth)
        self.assertEqual(headers["connection"], "close")
        self.assertNotIn("proxy-connection", headers)

    def test_socks5_upstream_with_username_password_and_remote_dns(self) -> None:
        for scheme in ("socks5h", "socks5"):
            with self.subTest(scheme=scheme):
                upstream = FakeSocks5("alice", "s3cret")
                self.addCleanup(upstream.close)
                local = self._forwarder(f"{scheme}://alice:s3cret@127.0.0.1:{upstream.port}")

                sock, status = _open_tunnel(local, "echo.invalid", self.echo.port)
                with sock:
                    self.assertIn(b" 200 ", status)
                    sock.sendall(b"hello through socks5")
                    self.assertEqual(_recv_exact(sock, 20), b"hello through socks5")

                self.assertIn(2, upstream.greetings[0])                 # 提供了用户名密码认证
                self.assertEqual(upstream.auths, [("alice", "s3cret")])
                # ATYP=3（域名）：DNS 在代理端解析，本机从未解析 echo.invalid
                self.assertEqual(upstream.requests, [(3, "echo.invalid", self.echo.port)])

    def test_plain_http_over_socks5_uses_origin_form(self) -> None:
        upstream = FakeSocks5("alice", "s3cret")
        origin = FakeOrigin()
        self.addCleanup(upstream.close)
        self.addCleanup(origin.close)
        local = self._forwarder(f"socks5h://alice:s3cret@127.0.0.1:{upstream.port}")
        parsed = urlsplit(local)
        with socket.create_connection((parsed.hostname, parsed.port), timeout=5) as sock:
            sock.sendall(f"GET http://origin.invalid:{origin.port}/path?q=1 HTTP/1.1\r\n"
                         f"Host: origin.invalid:{origin.port}\r\nProxy-Connection: keep-alive\r\n\r\n".encode())
            response = _recv_all(sock)
        self.assertTrue(response.endswith(b"origin-ok"))
        lines = origin.requests[0]
        self.assertEqual(lines[0], "GET /path?q=1 HTTP/1.1")
        self.assertIn("Connection: close", lines)
        self.assertFalse(any(line.lower().startswith("proxy-") for line in lines))
        self.assertEqual(upstream.requests, [(3, "origin.invalid", origin.port)])

    @unittest.skipUnless(shutil.which("openssl"), "需要 openssl 生成自签证书")
    def test_https_upstream_speaks_tls_then_connect(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        cert, key = f"{tmp}/cert.pem", f"{tmp}/key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                        "-days", "1", "-subj", "/CN=localhost"], check=True, capture_output=True)
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(cert, key)
        upstream = FakeHttpProxy("tls-user", "tls-pass", tls=server_ctx)
        self.addCleanup(upstream.close)
        client_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_ctx.check_hostname = False
        client_ctx.verify_mode = ssl.CERT_NONE

        local = self._forwarder(f"https://tls-user:tls-pass@127.0.0.1:{upstream.port}", ssl_context=client_ctx)
        sock, status = _open_tunnel(local, "echo.invalid", self.echo.port)
        with sock:
            self.assertIn(b" 200 ", status)
            sock.sendall(b"hello through https proxy")
            self.assertEqual(_recv_exact(sock, 25), b"hello through https proxy")
        self.assertEqual(upstream.requests[0][1]["proxy-authorization"], upstream.expected_auth)

    def test_shutdown_stops_listening(self) -> None:
        upstream = FakeHttpProxy("u", "p")
        self.addCleanup(upstream.close)
        local, shutdown = self.mod.make_page_proxy(f"http://u:p@127.0.0.1:{upstream.port}")
        parsed = urlsplit(local)
        shutdown()
        shutdown()                                                    # 幂等
        with self.assertRaises(OSError):
            socket.create_connection((parsed.hostname, parsed.port), timeout=2).close()


# ---------------------------------------------------------------------------
# BrowserCdp / CdpPage
# ---------------------------------------------------------------------------


class FakeWs:
    """按脚本回放消息的假 websocket。"""

    def __init__(self, replies: Callable[[dict], list[dict]]) -> None:
        self.replies = replies
        self.sent: list[dict] = []
        self.queue: list[str] = []
        self.closed = False

    def send_text(self, text: str) -> None:
        message = json.loads(text)
        self.sent.append(message)
        self.queue.extend(json.dumps(item) for item in self.replies(message))

    def recv_text(self, timeout: float | None = None) -> str | None:
        return self.queue.pop(0) if self.queue else None

    def close(self) -> None:
        self.closed = True


class CdpClientTests(unittest.TestCase):
    def test_browser_cdp_skips_events_and_creates_context_with_proxy(self) -> None:
        def replies(message: dict) -> list[dict]:
            return [
                {"method": "Target.targetCreated", "params": {"targetInfo": {}}},   # 事件：跳过
                {"id": message["id"] + 1000, "result": {"browserContextId": "stale"}},  # 别人的 id：跳过
                {"id": message["id"], "result": {"browserContextId": "ctx-9", "targetId": "tgt-9"}},
            ]

        browser = object.__new__(solver.BrowserCdp)
        browser.sock = FakeWs(replies)
        browser._id = 0
        browser._send_lock = threading.Lock()

        self.assertEqual(browser.create_context("http://127.0.0.1:5555"), "ctx-9")
        self.assertEqual(browser.create_target("ctx-9"), "tgt-9")
        browser.dispose_context("ctx-9")
        methods = [(m["method"], m["params"]) for m in browser.sock.sent]
        self.assertEqual(methods, [
            ("Target.createBrowserContext", {"disposeOnDetach": False, "proxyServer": "http://127.0.0.1:5555"}),
            ("Target.createTarget", {"url": "about:blank", "browserContextId": "ctx-9"}),
            ("Target.disposeBrowserContext", {"browserContextId": "ctx-9"}),
        ])

    def test_send_fails_fast_when_socket_closed(self) -> None:
        browser = object.__new__(solver.BrowserCdp)
        browser.sock = FakeWs(lambda message: [])
        browser.sock.closed = True
        browser._id = 0
        browser._send_lock = threading.Lock()
        started = time.time()
        with self.assertRaises(solver.WebSocketError):
            browser.send("Browser.getVersion", timeout=30)
        self.assertLess(time.time() - started, 5)

    def test_cdp_page_attaches_to_given_target(self) -> None:
        urls: list[str] = []

        def fake_ws(url: str, timeout: float = 60.0) -> FakeWs:
            urls.append(url)
            return FakeWs(lambda message: [{"id": message["id"], "result": {}}])

        with mock.patch.object(solver, "SimpleWebSocket", fake_ws):
            page = solver.CdpPage(9333, None, target_id="ABC123")
        self.assertEqual(urls, ["ws://127.0.0.1:9333/devtools/page/ABC123"])
        self.assertEqual(page.target_id, "ABC123")
        self.assertEqual([m["method"] for m in page.sock.sent],
                         ["Page.enable", "Runtime.enable", "Emulation.setUserAgentOverride"])


# ---------------------------------------------------------------------------
# BrowserPool：死锁、lane、generation（全部 fake，不起浏览器）
# ---------------------------------------------------------------------------


class FakeProcess:
    def poll(self) -> None:
        return None


class FakePage:
    def __init__(self, env: "FakeEnv", target_id: str | None) -> None:
        self.env = env
        self.target_id = target_id
        self.browser_id = env.browser_id
        self.opened: list[str] = []
        self.scripts = 0
        self.closed = False

    def open(self, url: str) -> None:
        self.opened.append(url)

    def evaluate(self, expression: str, timeout: float = 0) -> Any:
        if self.closed or self.browser_id != self.env.browser_id or not self.env.alive:
            raise RuntimeError("page is dead")
        if expression == "1+1":
            return 2
        self.scripts += 1
        self.env.script_calls.append(self.target_id)
        result = self.env.script_result
        return result(self) if callable(result) else result

    def current_url(self) -> str:
        return "https://chatgpt.com/"

    def close(self) -> None:
        self.closed = True


class FakeBrowser:
    def __init__(self, env: "FakeEnv") -> None:
        self.env = env
        self.browser_id = env.browser_id
        self.ws_url = f"ws://127.0.0.1/devtools/browser/{env.browser_id}"

    def ping(self) -> None:
        if self.browser_id != self.env.browser_id or not self.env.alive:
            raise ConnectionError("browser gone")

    def create_context(self, proxy_server: str) -> str:
        if self.env.fail_create_context:
            raise RuntimeError(f"cannot create context for {self.env.leaky_proxy}")
        context_id = f"ctx-{len(self.env.contexts) + 1}"
        self.env.contexts.append((context_id, proxy_server))
        return context_id

    def create_target(self, context_id: str) -> str:
        return "tgt-" + context_id.split("-", 1)[1]

    def dispose_context(self, context_id: str) -> None:
        self.env.disposed.append(context_id)

    def close(self) -> None:
        pass


class FakeEnv:
    def __init__(self, alive: bool = True) -> None:
        self.alive = alive
        self.browser_id = 1
        self.launches = 0
        self.pages: list[FakePage] = []
        self.contexts: list[tuple[str, str]] = []
        self.disposed: list[str] = []
        self.browsers = 0
        self.forwarders: list[dict[str, Any]] = []
        self.script_calls: list[str | None] = []
        self.script_result: Any = "tok"
        self.fail_create_context = False
        self.leaky_proxy = ""

    def page_factory(self, cdp_port: int, user_agent: str | None, target_id: str | None = None) -> FakePage:
        page = FakePage(self, target_id)
        self.pages.append(page)
        return page

    def browser_factory(self, cdp_port: int) -> FakeBrowser:
        if not self.alive:
            raise ConnectionRefusedError("cdp down")
        self.browsers += 1
        return FakeBrowser(self)

    def proxy_factory(self, proxy: str) -> tuple[str, Callable[[], None]]:
        record = {"proxy": proxy, "shutdowns": 0}
        self.forwarders.append(record)

        def shutdown() -> None:
            record["shutdowns"] += 1

        return f"http://127.0.0.1:{20000 + len(self.forwarders)}", shutdown

    def launcher(self) -> FakeProcess:
        self.launches += 1
        self.browser_id += 1
        self.alive = True
        return FakeProcess()

    def default_pages(self) -> list[FakePage]:
        return [page for page in self.pages if page.target_id is None]

    def lane_pages(self) -> list[FakePage]:
        return [page for page in self.pages if page.target_id is not None]


def make_pool(env: FakeEnv, **kwargs: Any) -> Any:
    pool = solver.BrowserPool(9333, "https://chatgpt.com/", launcher=env.launcher,
                              page_factory=env.page_factory, browser_factory=env.browser_factory,
                              proxy_factory=env.proxy_factory, **kwargs)
    pool._cdp_alive = lambda: env.alive
    return pool


PROXY_A = "http://alice:secretA@10.0.0.1:8001"
PROXY_B = "socks5h://bob:secretB@10.0.0.2:8002"
PROXY_C = "http://10.0.0.3:8003"
PROXY_D = "https://dave:secretD@10.0.0.4:8004"


def _run_with_timeout(test: unittest.TestCase, fn: Callable[[], Any], timeout: float = 5) -> Any:
    result: list[Any] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            result.append(fn())
        except BaseException as exc:  # pragma: no cover - 失败时才走到
            errors.append(exc)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)
    test.assertFalse(thread.is_alive(), "调用卡住（疑似死锁）")
    if errors:
        raise errors[0]
    return result[0]


class DeadlockRegressionTests(unittest.TestCase):
    def test_default_solve_relaunches_browser_without_deadlock(self) -> None:
        env = FakeEnv(alive=False)
        pool = make_pool(env)
        self.assertEqual(_run_with_timeout(self, lambda: pool.solve(REQS, "p")), (True, "tok"))
        self.assertEqual(env.launches, 1)

    def test_proxy_solve_relaunches_browser_without_deadlock(self) -> None:
        env = FakeEnv(alive=False)
        pool = make_pool(env)
        self.assertEqual(_run_with_timeout(self, lambda: pool.solve(REQS, "p", proxy=PROXY_A)), (True, "tok"))
        self.assertEqual(env.launches, 1)

    def test_default_and_proxy_lanes_run_in_parallel(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        gate = threading.Event()
        entered = threading.Event()

        def script(page: FakePage) -> str:
            if page.target_id is None:
                entered.set()
                gate.wait(5)                   # 默认 lane 卡住期间，代理 lane 仍应能完成
            return "tok"

        env.script_result = script
        default = threading.Thread(target=pool.solve, args=(REQS, "p"), daemon=True)
        default.start()
        self.assertTrue(entered.wait(5))
        try:
            self.assertEqual(_run_with_timeout(self, lambda: pool.solve(REQS, "p", proxy=PROXY_A)), (True, "tok"))
        finally:
            gate.set()
            default.join(5)


class LaneWaitTests(unittest.TestCase):
    def test_new_proxy_waits_for_a_lane_to_free_up(self) -> None:
        env = FakeEnv()
        pool = make_pool(env, max_lanes=1, lane_wait_secs=5)
        gate, entered = threading.Event(), threading.Event()

        def script(page: FakePage) -> str:
            if page.target_id == "tgt-1":
                entered.set()
                gate.wait(5)
            return "tok"

        env.script_result = script
        worker = threading.Thread(target=pool.solve, args=(REQS, "p"), kwargs={"proxy": PROXY_A}, daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5))
        threading.Timer(0.2, gate.set).start()
        try:
            self.assertEqual(_run_with_timeout(self, lambda: pool.solve(REQS, "p", proxy=PROXY_B)), (True, "tok"))
            self.assertEqual(env.disposed, ["ctx-1"])        # A 用完后被 LRU 回收，B 拿到位置
        finally:
            gate.set()
            worker.join(5)


class LaneTests(unittest.TestCase):
    def test_proxy_lane_uses_own_context_tab_and_warm_up(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)

        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (True, "tok"))
        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (True, "tok"))

        self.assertEqual(env.forwarders[0]["proxy"], PROXY_A)          # 规范化后的完整 URL 交给转发器
        self.assertEqual(env.contexts, [("ctx-1", "http://127.0.0.1:20001")])
        self.assertEqual([page.target_id for page in env.pages], ["tgt-1"])
        self.assertEqual(env.pages[0].opened, ["https://chatgpt.com/"])  # 首次求解前先预热
        self.assertEqual(env.default_pages(), [])
        self.assertEqual(pool.lanes_snapshot(), [
            {"proxy": "http://[REDACTED]@10.0.0.1:8001", "idle_secs": 0, "solves": 2, "errors": 0},
        ])

    def test_vm_timeout_retries_stay_on_the_lane(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        results = iter(["ERR:turnstile VM timed out after 12 steps", "tok-2"])
        env.script_result = lambda page: next(results)

        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (True, "tok-2"))
        self.assertEqual(env.script_calls, ["tgt-1", "tgt-1"])

    def test_lru_eviction_disposes_context_and_stops_forwarder(self) -> None:
        env = FakeEnv()
        pool = make_pool(env, max_lanes=2)
        for proxy in (PROXY_A, PROXY_B, PROXY_A, PROXY_C):          # A 最近用过 → 淘汰 B
            self.assertEqual(pool.solve(REQS, "p", proxy=proxy), (True, "tok"))

        self.assertEqual(env.disposed, ["ctx-2"])
        self.assertEqual([f["shutdowns"] for f in env.forwarders], [0, 1, 0])
        self.assertTrue(env.pages[1].closed)
        self.assertEqual([lane["proxy"] for lane in pool.lanes_snapshot()],
                         ["http://[REDACTED]@10.0.0.1:8001", "http://10.0.0.3:8003"])

    def test_idle_lanes_are_reaped(self) -> None:
        env = FakeEnv()
        pool = make_pool(env, lane_idle_secs=60)
        pool.solve(REQS, "p", proxy=PROXY_A)
        pool.solve(REQS, "p", proxy=PROXY_B)
        self.assertEqual(pool.reap(), 0)

        self.assertEqual(pool.reap(now=time.time() + 120), 2)
        self.assertEqual(sorted(env.disposed), ["ctx-1", "ctx-2"])
        self.assertEqual([f["shutdowns"] for f in env.forwarders], [1, 1])
        self.assertEqual(pool.lanes_snapshot(), [])

    def test_busy_lane_is_never_evicted(self) -> None:
        env = FakeEnv()
        pool = make_pool(env, max_lanes=1, lane_idle_secs=1, lane_wait_secs=0.2)
        gate, entered = threading.Event(), threading.Event()

        def script(page: FakePage) -> str:
            entered.set()
            gate.wait(5)
            return "tok"

        env.script_result = script
        worker = threading.Thread(target=pool.solve, args=(REQS, "p"), kwargs={"proxy": PROXY_A}, daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            ok, error = pool.solve(REQS, "p", proxy=PROXY_B)
            self.assertFalse(ok)
            self.assertIn("busy", error)
            self.assertEqual(pool.reap(now=time.time() + 10_000), 0)
            self.assertEqual(env.disposed, [])
        finally:
            gate.set()
            worker.join(5)
        env.script_result = "tok"
        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_B), (True, "tok"))
        self.assertEqual(env.disposed, ["ctx-1"])

    def test_lane_failure_never_falls_back_to_default_context(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        env.script_result = "ERR:boom"
        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (False, "boom"))

        env.fail_create_context = True
        with self.assertRaises(RuntimeError):
            pool.solve(REQS, "p", proxy=PROXY_B)

        self.assertEqual(env.default_pages(), [])
        self.assertIsNone(pool._page)
        self.assertNotIn(None, env.script_calls)
        self.assertEqual([lane["errors"] for lane in pool.lanes_snapshot()], [1, 1])

    def test_browser_relaunch_invalidates_lanes_by_generation(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        pool.solve(REQS, "p", proxy=PROXY_A)
        self.assertEqual(pool._generation, 0)

        env.alive = False                    # 浏览器挂了，被重新拉起
        self.assertTrue(pool.ensure_browser())
        self.assertEqual(pool._generation, 1)

        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (True, "tok"))
        self.assertEqual([c for c, _ in env.contexts], ["ctx-1", "ctx-2"])
        self.assertEqual(env.disposed, [])                 # 旧上下文随旧进程消失，不去新浏览器上销毁
        self.assertTrue(env.pages[0].closed)
        self.assertEqual(len(env.forwarders), 1)           # 转发器与浏览器无关，复用
        self.assertEqual(env.browsers, 2)                  # browser 级连接重连到新浏览器

    def test_external_browser_restart_is_detected_via_ws_url(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        pool._launcher = None                # --no-launch：浏览器由外部管理
        pool.solve(REQS, "p", proxy=PROXY_A)

        env.browser_id += 1                  # 外部重启：新 ws 地址，旧页面/连接失效
        self.assertEqual(pool.solve(REQS, "p", proxy=PROXY_A), (True, "tok"))
        self.assertEqual(pool._generation, 1)
        self.assertEqual([c for c, _ in env.contexts], ["ctx-1", "ctx-2"])
        self.assertEqual(env.disposed, [])

    def test_close_tears_down_all_lanes(self) -> None:
        env = FakeEnv()
        pool = make_pool(env)
        pool.solve(REQS, "p", proxy=PROXY_A)
        pool.solve(REQS, "p", proxy=PROXY_D)
        pool.close()
        self.assertEqual(sorted(env.disposed), ["ctx-1", "ctx-2"])
        self.assertEqual([f["shutdowns"] for f in env.forwarders], [1, 1])
        self.assertEqual(pool.lanes_snapshot(), [])


class LaunchChromeTests(unittest.TestCase):
    def test_webrtc_is_forced_through_proxy(self) -> None:
        captured: list[list[str]] = []

        class ExitedProcess:
            def __init__(self, args: list[str], **kwargs: Any) -> None:
                captured.append(args)

            def poll(self) -> int:
                return 1

        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        with mock.patch.object(solver.subprocess, "Popen", ExitedProcess):
            with self.assertRaises(RuntimeError):
                solver.launch_chrome(9, "/nonexistent/chrome", f"{tmp}/profile", "http://127.0.0.1:1")
        self.assertIn("--force-webrtc-ip-handling-policy=disable_non_proxied_udp", captured[0])
        self.assertIn("--proxy-server=http://127.0.0.1:1", captured[0])


# ---------------------------------------------------------------------------
# HTTP handler 路由
# ---------------------------------------------------------------------------


class HandlerRoutingTests(unittest.TestCase):
    KEY = "test-key"

    def setUp(self) -> None:
        self.env = FakeEnv()
        self.pool = make_pool(self.env)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), solver.make_handler(self.pool, self.KEY))
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                         daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _request(self, method: str, path: str, body: Any = None, key: str | None = KEY) -> tuple[int, str]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if key:
            headers["X-Solver-Key"] = key
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode()

    def _post(self, body: Any, key: str | None = KEY) -> tuple[int, dict]:
        status, text = self._request("POST", "/turnstile", body, key)
        self.assertNotIn("secret", text)                           # 凭据绝不出现在响应里
        return status, json.loads(text)

    def test_proxy_routes_to_lane(self) -> None:
        status, data = self._post({"requirements": REQS, "p": "seed", "proxy": PROXY_A})
        self.assertEqual((status, data), (200, {"ok": True, "turnstile": "tok", "lane": "proxy"}))
        self.assertEqual(self.env.script_calls, ["tgt-1"])
        self.assertEqual(self.env.default_pages(), [])

    def test_missing_or_empty_proxy_routes_to_default(self) -> None:
        for body in ({"requirements": REQS, "p": "seed"}, {"requirements": REQS, "p": "seed", "proxy": "  "},
                     {"requirements": REQS, "p": "seed", "proxy": None}):
            with self.subTest(body=body):
                status, data = self._post(body)
                self.assertEqual((status, data), (200, {"ok": True, "turnstile": "tok", "lane": "default"}))
        self.assertEqual(self.env.script_calls, [None, None, None])
        self.assertEqual(self.env.contexts, [])

    def test_lane_failure_returns_ok_false_without_default_fallback(self) -> None:
        self.env.script_result = f"ERR:boom via {PROXY_A}"
        status, data = self._post({"requirements": REQS, "p": "seed", "proxy": PROXY_A})
        self.assertEqual(status, 200)
        self.assertEqual((data["ok"], data["lane"]), (False, "proxy"))
        self.assertIn("boom", data["error"])
        self.assertEqual(self.env.default_pages(), [])
        self.assertNotIn(None, self.env.script_calls)

    def test_lane_exception_returns_500_with_lane(self) -> None:
        self.env.fail_create_context = True
        self.env.leaky_proxy = PROXY_A
        status, data = self._post({"requirements": REQS, "p": "seed", "proxy": PROXY_A})
        self.assertEqual(status, 500)
        self.assertEqual((data["ok"], data["lane"]), (False, "proxy"))
        self.assertIn("[REDACTED]", data["error"])
        self.assertEqual(self.env.default_pages(), [])

    def test_bad_input(self) -> None:
        cases = [
            ({"requirements": REQS, "p": "seed", "proxy": "ftp://user:secret@h:21"}, "proxy"),
            ({"requirements": REQS, "p": "seed", "proxy": 123}, "proxy"),
            ({"p": "seed", "proxy": PROXY_A}, "proxy"),
            ({"requirements": REQS}, "default"),
        ]
        for body, lane in cases:
            with self.subTest(body=body):
                status, data = self._post(body)
                self.assertEqual(status, 400)
                self.assertEqual((data["ok"], data["lane"]), (False, lane))
        status, data = self._post([1, 2])
        self.assertEqual((status, data["ok"]), (400, False))
        self.assertEqual(self.env.pages, [])

    def test_bad_key(self) -> None:
        status, data = self._post({"requirements": REQS, "p": "seed", "proxy": PROXY_A}, key="nope")
        self.assertEqual((status, data), (401, {"ok": False, "error": "bad key"}))

    def test_health_reports_redacted_lanes(self) -> None:
        self._post({"requirements": REQS, "p": "seed", "proxy": PROXY_A})
        status, text = self._request("GET", "/health", key=None)
        self.assertEqual(status, 200)
        self.assertNotIn("secret", text)
        data = json.loads(text)
        self.assertEqual((data["ok"], data["browser"], data["lane_count"], data["max_lanes"]),
                         (True, "browser ready", 1, 8))
        self.assertEqual(data["lanes"][0]["proxy"], "http://[REDACTED]@10.0.0.1:8001")
        self.assertEqual(set(data["lanes"][0]), {"proxy", "idle_secs", "solves", "errors"})
        self.assertEqual(data["lanes"][0]["solves"], 1)

    def test_health_when_browser_down(self) -> None:
        self.env.alive = False
        status, text = self._request("GET", "/health", key=None)
        data = json.loads(text)
        self.assertEqual((status, data["ok"], data["lanes"], data["lane_count"]), (503, False, [], 0))


if __name__ == "__main__":
    unittest.main()
