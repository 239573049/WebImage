"""常驻浏览器哨兵求解服务（sentinel solver）。

网页端 Sentinel 的 turnstile 挑战已经换成随机化 opcode 的 VM，纯 Python 复刻跟不上版本，
需要真实 Chromium 环境执行。本服务常驻一个无头浏览器，只接收挑战参数、返回 turnstile token：

- 只处理 `requirements`（prepare 响应）+ `p`（令牌种子），不接收账号 token、Cookie 或用户 prompt；
- 用 `X-Solver-Key` 鉴权，默认只监听 127.0.0.1。

依赖：
- 一个可通过 CDP 连接的 Chromium（`--remote-debugging-port`）；
- 无第三方 Python 依赖（内置 CDP / WebSocket 客户端）。

用法：
    python scripts/sentinel_solver.py --port 8788 --cdp-port 9333 --key <secret>
    curl -s http://127.0.0.1:8788/health
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

LOG = logging.getLogger("sentinel-solver")

# ---------------------------------------------------------------------------
# 最小 CDP 客户端（RFC6455 手写实现，避免额外依赖）
# ---------------------------------------------------------------------------


class WebSocketError(RuntimeError):
    pass


class SimpleWebSocket:
    def __init__(self, url: str, timeout: float = 60.0) -> None:
        parsed = urlparse(url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self._sock = socket.create_connection((host, port), timeout=timeout)
        if parsed.scheme == "wss":
            self._sock = ssl.create_default_context().wrap_socket(self._sock, server_hostname=host)
        self._sock.settimeout(timeout)
        self._buffer = b""
        self._closed = False
        key = __import__("base64").b64encode(os.urandom(16)).decode()
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        request = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self._sock.sendall(request.encode())
        header = self._read_until(b"\r\n\r\n")
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise WebSocketError("websocket upgrade failed")
        self._write_lock = threading.Lock()

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buffer:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WebSocketError("closed during handshake")
            self._buffer += chunk
        head, _, rest = self._buffer.partition(marker)
        self._buffer = rest
        return head + marker

    def _recv_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WebSocketError("connection closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def _send_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._write_lock:
            self._sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(text.encode("utf-8"), 0x1)

    def recv_text(self, timeout: float | None = None) -> str | None:
        if timeout is not None:
            self._sock.settimeout(timeout)
        frags = bytearray()
        while True:
            try:
                head = self._recv_exact(2)
            except Exception:
                self._closed = True
                return None
            fin, opcode = head[0] & 0x80, head[0] & 0x0F
            masked, length = head[1] & 0x80, head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                self._closed = True
                return None
            if opcode == 0x9:
                try:
                    self._send_frame(payload, 0xA)
                except Exception:
                    return None
                continue
            if opcode == 0xA:
                continue
            frags += payload
            if fin:
                return frags.decode("utf-8", "replace")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(b"", 0x8)
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass


class CdpPage:
    """够用的 CDP 页面驱动：导航 + 执行 JS。"""

    UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0")

    def __init__(self, cdp_port: int, user_agent: str | None = None) -> None:
        request = urllib.request.Request(f"http://127.0.0.1:{cdp_port}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(request, timeout=15) as response:
            target = json.load(response)["webSocketDebuggerUrl"]
        self.sock = SimpleWebSocket(target, timeout=120)
        self._id = 0
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Emulation.setUserAgentOverride", {
            "userAgent": user_agent or self.UA,
            "acceptLanguage": "zh-CN,zh;q=0.9,en;q=0.8",
            "platform": "macOS",
        })

    def send(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        self._id += 1
        mid = self._id
        self.sock.send_text(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.sock.recv_text(max(0.5, deadline - time.time()))
            if raw is None:
                continue
            try:
                message = json.loads(raw)
            except Exception:
                continue
            if message.get("id") == mid:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
        raise TimeoutError(method)

    def evaluate(self, expression: str, timeout: float = 120) -> Any:
        result = self.send("Runtime.evaluate",
                           {"expression": expression, "awaitPromise": True, "returnByValue": True,
                            "userGesture": True}, timeout=timeout)
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            raise RuntimeError(f"JS: {detail.get('text')} "
                               f"{(detail.get('exception') or {}).get('description', '')}"[:300])
        return (result.get("result") or {}).get("value")

    def open(self, url: str) -> None:
        self.send("Page.navigate", {"url": url})
        deadline = time.time() + 45
        while time.time() < deadline:
            try:
                if self.evaluate("document.readyState === 'complete'", timeout=10):
                    return
            except Exception:
                pass
            time.sleep(0.4)
        raise TimeoutError("page did not load")

    def close(self) -> None:
        self.sock.close()


# ---------------------------------------------------------------------------
# 求解逻辑
# ---------------------------------------------------------------------------

DEFAULT_CHROME_CANDIDATES = [
    os.path.expanduser("~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/"
                       "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
]


class BrowserPool:
    """常驻一个页面，串行处理求解请求。"""

    def __init__(self, cdp_port: int, page_url: str, user_agent: str | None = None) -> None:
        self.cdp_port = cdp_port
        self.page_url = page_url
        self.user_agent = user_agent
        self._lock = threading.Lock()
        self._page: CdpPage | None = None

    def page(self) -> CdpPage:
        if self._page is not None:
            try:
                self._page.evaluate("1+1", timeout=8)
                return self._page
            except Exception:
                try:
                    self._page.close()
                except Exception:
                    pass
                self._page = None
        page = CdpPage(self.cdp_port, self.user_agent)
        page.open(self.page_url)
        self._page = page
        return page

    def solve(self, requirements: dict, p_token: str) -> tuple[bool, str]:
        script = """
        (async () => {
          const reqs = %s, key = %s;
          try {
            const { turnstile } = await import('/unauth-mweb/assets/turnstile-DykPLDEM.js');
            const original = WeakMap.prototype.get;
            WeakMap.prototype.get = function (target) {
              return target === reqs ? key : original.call(this, target);
            };
            try { return String(await turnstile.getEnforcementToken(reqs)); }
            finally { WeakMap.prototype.get = original; }
          } catch (error) { return 'ERR:' + String(error).slice(0, 300); }
        })()
        """ % (json.dumps(requirements), json.dumps(p_token))
        with self._lock:
            page = self.page()
            token = str(page.evaluate(script, timeout=180) or "")
        if token.startswith("ERR:"):
            return False, token[4:]
        return bool(token), token


def launch_chrome(cdp_port: int, chrome_bin: str | None, profile_dir: str, proxy: str = "") -> subprocess.Popen:
    binary = chrome_bin
    if not binary:
        for candidate in DEFAULT_CHROME_CANDIDATES:
            if os.path.exists(candidate):
                binary = candidate
                break
    if not binary:
        raise RuntimeError("未找到 Chromium/Chrome 可执行文件，请用 --chrome 指定")
    args = [binary, "--headless=new", "--no-first-run", "--disable-gpu", "--no-default-browser-check",
            "--disable-dev-shm-usage", f"--remote-debugging-port={cdp_port}", f"--user-data-dir={profile_dir}",
            "about:blank"]
    if proxy:
        args.insert(1, f"--proxy-server={proxy}")
    LOG.info("启动浏览器: %s (cdp %s)", binary, cdp_port)
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=3) as response:
                json.load(response)
                return process
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("浏览器 CDP 端口未就绪")


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


def make_handler(pool: BrowserPool, key: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:  # 静默访问日志
            return

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            return bool(key) and self.headers.get("X-Solver-Key") == key

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                return self._send(200, {"ok": True})
            if not self._authorized():
                return self._send(401, {"ok": False, "error": "bad key"})
            return self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                return self._send(401, {"ok": False, "error": "bad key"})
            if self.path != "/turnstile":
                return self._send(404, {"ok": False, "error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception as exc:
                return self._send(400, {"ok": False, "error": f"bad json: {exc}"})
            requirements = payload.get("requirements")
            p_token = payload.get("p")
            if not isinstance(requirements, dict) or not p_token:
                return self._send(400, {"ok": False, "error": "requirements/p required"})
            started = time.time()
            try:
                ok, token = pool.solve(requirements, str(p_token))
            except Exception as exc:
                LOG.warning("求解失败: %s", str(exc)[:200])
                return self._send(500, {"ok": False, "error": str(exc)[:200]})
            LOG.info("求解%s，耗时 %.1fs，token 长度 %d", "成功" if ok else "失败", time.time() - started, len(token))
            if not ok:
                return self._send(200, {"ok": False, "error": token[:300]})
            return self._send(200, {"ok": True, "turnstile": token})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="常驻浏览器的 sentinel turnstile 求解服务")
    # 所有参数都可用环境变量给默认值，容器里无需写长命令行
    parser.add_argument("--host", default=os.environ.get("SENTINEL_SOLVER_HOST", "127.0.0.1"),
                        help="监听地址；容器内需要 0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SENTINEL_SOLVER_PORT", "8788")))
    parser.add_argument("--key", default=os.environ.get("SENTINEL_SOLVER_KEY", ""),
                        help="必须设置；请求需带 X-Solver-Key")
    parser.add_argument("--cdp-port", type=int, default=int(os.environ.get("SENTINEL_SOLVER_CDP_PORT", "9333")))
    parser.add_argument("--chrome", default=os.environ.get("SENTINEL_SOLVER_CHROME", ""))
    parser.add_argument("--profile-dir", default=os.environ.get("SENTINEL_SOLVER_PROFILE_DIR", "/tmp/chatgpt2api-solver-profile"))
    parser.add_argument("--proxy", default=os.environ.get("SENTINEL_SOLVER_PROXY", ""))
    parser.add_argument("--page-url", default=os.environ.get("SENTINEL_SOLVER_PAGE_URL", "https://chatgpt.com/"))
    parser.add_argument("--user-agent", default="")
    parser.add_argument("--no-launch", action="store_true", help="复用已存在的浏览器，不自行启动")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if not args.key:
        LOG.error("必须提供 --key（或用环境变量 SENTINEL_SOLVER_KEY），否则任何人都能调用")
        return 2

    process = None
    if not args.no_launch:
        Path(args.profile_dir).mkdir(parents=True, exist_ok=True)
        process = launch_chrome(args.cdp_port, args.chrome or None, args.profile_dir, args.proxy)

    pool = BrowserPool(args.cdp_port, args.page_url, args.user_agent or None)
    try:
        pool.page()                       # 预热
        LOG.info("浏览器就绪，页面已加载")
    except Exception as exc:
        LOG.warning("预热失败（首个请求会重试）: %s", str(exc)[:160])

    server = ThreadingHTTPServer((args.host, args.port), make_handler(pool, args.key))
    LOG.info("solver 监听 http://%s:%d（仅本机，需 X-Solver-Key）", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if process is not None:
            process.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
