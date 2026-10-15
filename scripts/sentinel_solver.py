"""常驻浏览器哨兵求解服务（sentinel solver）。

网页端 Sentinel 的 turnstile 挑战已经换成随机化 opcode 的 VM，纯 Python 复刻跟不上版本，
需要真实 Chromium 环境执行。本服务常驻一个无头浏览器，接收挑战参数、返回 turnstile token：

- 处理 `requirements`（prepare 响应）+ `p`（令牌种子）；
- 可选 `proxy`：账号所用的代理完整地址（可能带用户名密码），让求解与账号自身请求走同一出口 IP。
  代理凭据只留在本进程（带认证时由本地转发器持有，浏览器只拿到 127.0.0.1 的无认证地址），
  日志与 /health 里一律脱敏；
- 仍然不接收账号 token、Cookie 或用户 prompt；
- 用 `X-Solver-Key` 鉴权，默认只监听 127.0.0.1。

出口（lane）：
- 不带 `proxy`：默认浏览器上下文 + `SENTINEL_SOLVER_PROXY`，与旧版一致；
- 带 `proxy`：每个代理一个独立浏览器上下文（Cookie 隔离，cf_clearance 这类与 IP 绑定的 Cookie
  正好按出口分开）+ 一个 tab；不同代理并行、同一代理串行；按 LRU（`SENTINEL_SOLVER_MAX_LANES`）
  和空闲时间（`SENTINEL_SOLVER_LANE_IDLE_SECS`）回收。lane 求解失败直接返回 ok:false，
  不会回落到默认上下文（否则出口不一致），由主程序回退到内置求解器。

依赖：
- 一个可通过 CDP 连接的 Chromium（`--remote-debugging-port`）；
- 无第三方 Python 依赖（内置 CDP / WebSocket 客户端、纯 socket 代理转发器）。

用法：
    python scripts/sentinel_solver.py --port 8788 --cdp-port 9333 --key <secret>
    curl -s http://127.0.0.1:8788/health
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import logging
import os
import re
import selectors
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, NamedTuple
from urllib.parse import quote, unquote, urlparse, urlsplit

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
        key = base64.b64encode(os.urandom(16)).decode()
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

    @property
    def closed(self) -> bool:
        return self._closed

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
            except TimeoutError:
                return None                     # 只是等待超时，连接仍可用
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
            try:
                self._sock.close()
            except Exception:
                pass
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


class _CdpSession:
    """CDP 请求/响应：按 id 等结果，期间收到的事件消息直接跳过；send 串行。"""

    def __init__(self, ws_url: str, timeout: float = 120) -> None:
        self.sock = SimpleWebSocket(ws_url, timeout=timeout)
        self._id = 0
        self._send_lock = threading.Lock()

    def send(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        with self._send_lock:
            self._id += 1
            mid = self._id
            self.sock.send_text(json.dumps({"id": mid, "method": method, "params": params or {}}))
            deadline = time.time() + timeout
            while time.time() < deadline:
                raw = self.sock.recv_text(max(0.5, deadline - time.time()))
                if raw is None:
                    if self.sock.closed:
                        raise WebSocketError(f"{method}: CDP 连接已断开")
                    continue
                try:
                    message = json.loads(raw)
                except Exception:
                    continue
                if message.get("id") != mid:        # 事件（只有 method）或过期响应
                    continue
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            raise TimeoutError(method)

    def close(self) -> None:
        self.sock.close()


class CdpPage(_CdpSession):
    """够用的 CDP 页面驱动：导航 + 执行 JS。

    不带 target_id 时经 /json/new 在默认上下文开新 tab；带 target_id 时直接连接
    /devtools/page/{id}（代理 lane 在自己的浏览器上下文里用 Target.createTarget 建的 tab）。
    """

    UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0")

    def __init__(self, cdp_port: int, user_agent: str | None = None, target_id: str | None = None) -> None:
        if target_id:
            ws_url = f"ws://127.0.0.1:{cdp_port}/devtools/page/{target_id}"
        else:
            request = urllib.request.Request(f"http://127.0.0.1:{cdp_port}/json/new?about:blank", method="PUT")
            with urllib.request.urlopen(request, timeout=15) as response:
                info = json.load(response)
            ws_url = info["webSocketDebuggerUrl"]
            target_id = str(info.get("id") or "")
        self.target_id = target_id
        super().__init__(ws_url, timeout=120)
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Emulation.setUserAgentOverride", {
            "userAgent": user_agent or self.UA,
            "acceptLanguage": "zh-CN,zh;q=0.9,en;q=0.8",
            "platform": "macOS",
        })

    def evaluate(self, expression: str, timeout: float = 120) -> Any:
        result = self.send("Runtime.evaluate",
                           {"expression": expression, "awaitPromise": True, "returnByValue": True,
                            "userGesture": True}, timeout=timeout)
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            raise RuntimeError(f"JS: {detail.get('text')} "
                               f"{(detail.get('exception') or {}).get('description', '')}"[:300])
        return (result.get("result") or {}).get("value")

    def current_url(self) -> str:
        try:
            return str(self.evaluate("location.href", timeout=10) or "")
        except Exception:
            return ""

    def open(self, url: str, attempts: int = 3) -> None:
        """打开页面；Chrome 加载失败会停在 chrome-error:// 页，这里检测并重试。"""
        last = ""
        for attempt in range(1, attempts + 1):
            self.send("Page.navigate", {"url": url})
            deadline = time.time() + 45
            while time.time() < deadline:
                try:
                    if self.evaluate("document.readyState === 'complete'", timeout=10):
                        break
                except Exception:
                    pass
                time.sleep(0.4)
            last = self.current_url()
            if last.startswith("chrome-error://"):
                LOG.warning("页面加载失败（第 %d/%d 次）: %s", attempt, attempts, last)
                time.sleep(2)
                continue
            return
        raise RuntimeError(f"页面无法加载: {url}（最后停在 {last or 'unknown'}）")


class BrowserCdp(_CdpSession):
    """browser 级 CDP 连接：为每个代理创建/销毁独立浏览器上下文及其中的 tab。"""

    def __init__(self, cdp_port: int, timeout: float = 60) -> None:
        with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=10) as response:
            self.ws_url = str(json.load(response)["webSocketDebuggerUrl"])
        super().__init__(self.ws_url, timeout=timeout)

    def ping(self) -> None:
        self.send("Browser.getVersion", timeout=5)

    def create_context(self, proxy_server: str) -> str:
        # disposeOnDetach=false：本连接断开重连后上下文仍在，仍可按 id 销毁
        params: dict[str, Any] = {"disposeOnDetach": False}
        if proxy_server:
            params["proxyServer"] = proxy_server
        return str(self.send("Target.createBrowserContext", params, timeout=30)["browserContextId"])

    def create_target(self, context_id: str) -> str:
        result = self.send("Target.createTarget", {"url": "about:blank", "browserContextId": context_id},
                           timeout=30)
        return str(result["targetId"])

    def dispose_context(self, context_id: str) -> None:
        self.send("Target.disposeBrowserContext", {"browserContextId": context_id}, timeout=15)


# ---------------------------------------------------------------------------
# 代理地址解析、脱敏与 Chrome 映射
# ---------------------------------------------------------------------------

# 缺省端口与 curl 保持一致（主程序用 curl_cffi 出网），避免同一个 URL 两边连到不同端口
PROXY_DEFAULT_PORTS = {"http": 1080, "https": 443, "socks5h": 1080}
# socks5 也一律走远程 DNS（转发器用 ATYP=domain，Chrome 的 socks5 本来就远程解析），与 socks5h 等价
_PROXY_SCHEMES = {"http": "http", "https": "https", "socks5": "socks5h", "socks5h": "socks5h",
                  "socks": "socks5h"}
_CREDENTIALS_RE = re.compile(r"((?:https?|socks5h?|socks)://)[^\s/@]+@", re.IGNORECASE)


def _format_host_port(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


class ProxySpec(NamedTuple):
    scheme: str              # http / https / socks5h
    host: str
    port: int
    username: str = ""
    password: str = ""

    @property
    def authenticated(self) -> bool:
        return bool(self.username or self.password)

    @property
    def host_port(self) -> str:
        return _format_host_port(self.host, self.port)

    def url(self) -> str:
        """规范化 URL（含凭据）；lane 以它为键，凭据不同即视为不同出口。"""
        if not self.authenticated:
            return f"{self.scheme}://{self.host_port}"
        return (f"{self.scheme}://{quote(self.username, safe='')}:{quote(self.password, safe='')}"
                f"@{self.host_port}")

    def redacted(self) -> str:
        return f"{self.scheme}://{'[REDACTED]@' if self.authenticated else ''}{self.host_port}"

    def basic_auth(self) -> str:
        raw = f"{self.username}:{self.password}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")


def parse_proxy_url(proxy: str) -> ProxySpec:
    """解析代理地址；错误信息不含凭据。无 scheme 时按 http 处理。"""
    raw = str(proxy or "").strip()
    if not raw:
        raise ValueError("empty proxy url")
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError:
        raise ValueError("invalid proxy url (bad host/port)") from None
    scheme = _PROXY_SCHEMES.get((parsed.scheme or "").lower())
    if scheme is None:
        raise ValueError(f"unsupported proxy scheme {parsed.scheme[:16]!r}（支持 http/https/socks5/socks5h）")
    host = (parsed.hostname or "").strip()
    if not host:
        raise ValueError("proxy url missing host")
    if port is None:
        port = PROXY_DEFAULT_PORTS[scheme]
    if not 0 < port < 65536:
        raise ValueError("proxy port out of range")
    return ProxySpec(scheme, host, port, unquote(parsed.username or ""), unquote(parsed.password or ""))


def redact_proxy_text(text: str) -> str:
    """把文本里形如 scheme://user:pass@ 的凭据替换掉（日志、错误信息用）。"""
    return _CREDENTIALS_RE.sub(r"\1[REDACTED]@", str(text or ""))


def redact_proxy_url(proxy: str) -> str:
    try:
        return parse_proxy_url(proxy).redacted()
    except ValueError:
        return redact_proxy_text(proxy)


def chrome_proxy_server(spec: ProxySpec) -> str:
    """无认证代理 → Chrome 能直接用的地址。

    Chrome 不认 socks5h（socks5 本身就是远程解析），也不接受 user:pass@，带认证的必须走本地转发器。
    """
    if spec.authenticated:
        raise ValueError("带认证的代理需经本地转发器，不能直接交给浏览器")
    scheme = "socks5" if spec.scheme == "socks5h" else spec.scheme
    return f"{scheme}://{spec.host_port}"


# ---------------------------------------------------------------------------
# 本地代理转发器（纯 socket，不依赖 curl_cffi）
# ---------------------------------------------------------------------------


class UpstreamProxyError(RuntimeError):
    """上游代理拒绝或握手失败（信息不含凭据）。"""


_SOCKS5_REPLIES = {
    1: "general failure", 2: "connection not allowed", 3: "network unreachable", 4: "host unreachable",
    5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported",
}
# 逐跳头：转发普通 http 请求时去掉，再统一补 Connection: close
_HOP_HEADERS = {"proxy-authorization", "proxy-connection", "connection", "keep-alive"}


def _recv_exact_sock(sock: socket.socket, count: int) -> bytes:
    data = bytearray()
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise UpstreamProxyError("upstream proxy closed during handshake")
        data += chunk
    return bytes(data)


def _read_http_head(sock: socket.socket, limit: int = 65536) -> tuple[bytes, bytes]:
    """读到空行为止；返回 (头部, 多读到的后续字节)。"""
    buf = b""
    while b"\r\n\r\n" not in buf:
        if len(buf) > limit:
            raise ValueError("http head too large")
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("connection closed before http head completed")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head, rest


def _split_host_port(authority: str, default_port: int) -> tuple[str, int]:
    authority = authority.strip()
    if authority.startswith("["):
        end = authority.index("]")
        host, rest = authority[1:end], authority[end + 1:]
        return host, int(rest[1:]) if rest.startswith(":") else default_port
    if authority.count(":") == 1:
        host, port = authority.split(":")
        return host, int(port)
    return authority, default_port


def _open_proxy_socket(spec: ProxySpec, timeout: float, ssl_context: ssl.SSLContext | None) -> socket.socket:
    sock = socket.create_connection((spec.host, spec.port), timeout=timeout)
    if spec.scheme != "https":
        return sock
    try:                                   # https 代理：先与代理本身建 TLS，再在里面说 CONNECT
        context = ssl_context or ssl.create_default_context()
        return context.wrap_socket(sock, server_hostname=spec.host)
    except Exception:
        sock.close()
        raise


def _http_connect_handshake(sock: socket.socket, spec: ProxySpec, host: str, port: int) -> bytes:
    authority = _format_host_port(host, port)
    lines = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}"]
    if spec.authenticated:
        lines.append(f"Proxy-Authorization: {spec.basic_auth()}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin1"))
    head, rest = _read_http_head(sock, limit=16384)
    status = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
    parts = status.split(" ", 2)
    code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    if not 200 <= code < 300:
        raise UpstreamProxyError(f"upstream CONNECT {authority} rejected: {status[:80]}")
    return rest


def _socks5_handshake(sock: socket.socket, spec: ProxySpec, host: str, port: int) -> None:
    """RFC1928 + RFC1929；目标用 ATYP=domain 发出，DNS 留在代理那端解析。"""
    methods = b"\x00\x02" if spec.authenticated else b"\x00"
    sock.sendall(b"\x05" + bytes([len(methods)]) + methods)
    version, method = _recv_exact_sock(sock, 2)
    if version != 5:
        raise UpstreamProxyError("upstream is not a socks5 proxy")
    if method == 0x02:
        if not spec.authenticated:
            raise UpstreamProxyError("socks5 proxy requires username/password")
        user, password = spec.username.encode("utf-8"), spec.password.encode("utf-8")
        if len(user) > 255 or len(password) > 255:
            raise UpstreamProxyError("socks5 username/password too long")
        sock.sendall(b"\x01" + bytes([len(user)]) + user + bytes([len(password)]) + password)
        _, status = _recv_exact_sock(sock, 2)
        if status != 0:
            raise UpstreamProxyError("socks5 authentication rejected")
    elif method != 0x00:
        raise UpstreamProxyError("socks5 proxy accepts none of our auth methods")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is None:
        name = host.encode("ascii") if host.isascii() else host.encode("idna")
        if not 0 < len(name) <= 255:
            raise UpstreamProxyError("socks5 target hostname too long")
        address = b"\x03" + bytes([len(name)]) + name
    else:
        address = (b"\x01" if ip.version == 4 else b"\x04") + ip.packed
    sock.sendall(b"\x05\x01\x00" + address + struct.pack(">H", port))
    version, reply, _, atyp = _recv_exact_sock(sock, 4)
    if version != 5 or reply != 0:
        raise UpstreamProxyError(f"socks5 connect failed: {_SOCKS5_REPLIES.get(reply, reply)}")
    if atyp == 0x01:
        _recv_exact_sock(sock, 4 + 2)
    elif atyp == 0x04:
        _recv_exact_sock(sock, 16 + 2)
    elif atyp == 0x03:
        _recv_exact_sock(sock, _recv_exact_sock(sock, 1)[0] + 2)
    else:
        raise UpstreamProxyError("socks5 reply has unknown address type")


def open_upstream_tunnel(spec: ProxySpec, host: str, port: int, *, timeout: float = 30.0,
                         ssl_context: ssl.SSLContext | None = None) -> tuple[socket.socket, bytes]:
    """经上游代理建立到 host:port 的隧道；返回 (socket, 握手后多读到的字节)。"""
    sock = _open_proxy_socket(spec, timeout, ssl_context)
    try:
        if spec.scheme == "socks5h":
            _socks5_handshake(sock, spec, host, port)
            return sock, b""
        return sock, _http_connect_handshake(sock, spec, host, port)
    except Exception:
        try:
            sock.close()
        except Exception:
            pass
        raise


def _relay_sockets(a: socket.socket, b: socket.socket, idle_timeout: float = 600.0) -> None:
    """单线程双向拷贝，直到两个方向都结束或空闲超时。

    用 selectors 而不是两个线程各读一边：TLS 套接字（https 上游）不能跨线程并发读写。
    """
    peers = {a: b, b: a}
    readers = [a, b]
    selector = selectors.DefaultSelector()
    try:
        for sock in readers:
            sock.settimeout(60)
            selector.register(sock, selectors.EVENT_READ)
        while readers:
            # TLS 层里已解密但未读走的数据 select 看不到，先处理
            ready = [s for s in readers if isinstance(s, ssl.SSLSocket) and s.pending()]
            if not ready:
                events = selector.select(idle_timeout)
                if not events:
                    return                       # 空闲超时
                ready = [key.fileobj for key, _ in events]  # type: ignore[misc]
            for sock in ready:
                data = sock.recv(65536)
                peer = peers[sock]
                if data:
                    peer.sendall(data)
                    continue
                # 读到 EOF：普通 socket 半关闭写方向，继续转完反方向；TLS 套接字不能半关闭，直接结束
                if isinstance(peer, ssl.SSLSocket):
                    return
                readers.remove(sock)
                selector.unregister(sock)
                try:
                    peer.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
    except Exception:
        pass
    finally:
        selector.close()
        for sock in (a, b):
            try:
                sock.close()
            except Exception:
                pass


class ProxyForwarder:
    """本机 127.0.0.1 随机端口上的无认证 HTTP 代理，带凭据转发到上游代理。

    浏览器（--proxy-server / createBrowserContext 的 proxyServer）不接受 user:pass@，
    带认证的代理一律经它中转：浏览器只看到本地地址，凭据只留在本进程。
    支持 CONNECT 隧道和普通 http 的绝对 URI 请求；上游支持 http / https（先 TLS 再 CONNECT）/ socks5(h)。
    """

    def __init__(self, upstream: ProxySpec, *, ssl_context: ssl.SSLContext | None = None,
                 timeout: float = 30.0, idle_timeout: float = 600.0) -> None:
        self.upstream = upstream
        self._ssl_context = ssl_context
        self._timeout = timeout
        self._idle_timeout = idle_timeout
        self._stop = threading.Event()
        self._conns: set[socket.socket] = set()
        self._conns_lock = threading.Lock()
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self._server.bind(("127.0.0.1", 0))
            self._server.listen(128)
            self._server.settimeout(0.5)         # accept 轮询，便于 shutdown 及时退出
        except Exception:
            self._server.close()
            raise
        self.port = int(self._server.getsockname()[1])
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._serve, name=f"proxy-forwarder-{self.port}", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                client, _ = self._server.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _track(self, sock: socket.socket | None, add: bool) -> None:
        if sock is None:
            return
        with self._conns_lock:
            if add:
                self._conns.add(sock)
            else:
                self._conns.discard(sock)

    @staticmethod
    def _reply(client: socket.socket, code: int, reason: str) -> None:
        body = reason.encode("utf-8")
        head = (f"HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("latin1", "replace")
        try:
            client.sendall(head + body)
        except Exception:
            pass

    def _open_plain(self, method: str, target: str, version: str, header_lines: list[str],
                    rest: bytes) -> socket.socket | None:
        """普通 http 请求（绝对 URI）：http/https 上游原样转发并补 Proxy-Authorization，
        socks5 上游先建隧道再改写为 origin-form。请求体随后由 relay 原样透传（含 chunked）。"""
        parts = urlsplit(target)
        if parts.scheme.lower() != "http" or not parts.hostname:
            return None
        headers = [line for line in header_lines if line.split(":", 1)[0].strip().lower() not in _HOP_HEADERS]
        headers.append("Connection: close")       # 一个连接只转一个请求，凭据也只需补一次
        if self.upstream.scheme == "socks5h":
            sock, _ = open_upstream_tunnel(self.upstream, parts.hostname, parts.port or 80,
                                           timeout=self._timeout, ssl_context=self._ssl_context)
            path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            request_line = f"{method} {path} {version}"
        else:
            sock = _open_proxy_socket(self.upstream, self._timeout, self._ssl_context)
            request_line = f"{method} {target} {version}"
            if self.upstream.authenticated:
                headers.append(f"Proxy-Authorization: {self.upstream.basic_auth()}")
        try:
            sock.sendall(("\r\n".join([request_line, *headers]) + "\r\n\r\n").encode("latin1") + rest)
        except Exception:
            sock.close()
            raise
        return sock

    def _handle(self, client: socket.socket) -> None:
        upstream: socket.socket | None = None
        established = False
        self._track(client, True)
        try:
            client.settimeout(self._timeout)
            head, rest = _read_http_head(client)
            lines = head.decode("latin1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) != 3:
                return self._reply(client, 400, "Bad Request")
            method, target, version = parts
            if method.upper() == "CONNECT":
                host, port = _split_host_port(target, 443)
                upstream, early = open_upstream_tunnel(self.upstream, host, port, timeout=self._timeout,
                                                       ssl_context=self._ssl_context)
                self._track(upstream, True)
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                established = True
                if early:
                    client.sendall(early)
                if rest:
                    upstream.sendall(rest)
            else:
                upstream = self._open_plain(method, target, version, [x for x in lines[1:] if x], rest)
                if upstream is None:
                    return self._reply(client, 400, "Bad Request")
                self._track(upstream, True)
                established = True
            _relay_sockets(client, upstream, self._idle_timeout)
        except Exception as exc:
            LOG.debug("本地转发失败（上游 %s）: %s", self.upstream.redacted(), redact_proxy_text(str(exc))[:200])
            if not established:
                self._reply(client, 502, "Bad Gateway")
        finally:
            for sock in (client, upstream):
                self._track(sock, False)
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass

    def shutdown(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        try:
            self._server.close()
        except Exception:
            pass
        with self._conns_lock:
            conns, self._conns = list(self._conns), set()
        for sock in conns:
            try:
                sock.shutdown(socket.SHUT_RDWR)   # 先 shutdown 才能唤醒阻塞在 select/recv 上的转发线程
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        # accept 线程最多 0.5s 后自行退出；不 join，免得 LRU 回收时拖慢当前请求


def make_page_proxy(proxy: str, ssl_context: ssl.SSLContext | None = None) -> tuple[str, Callable[[], None] | None]:
    """返回 (交给浏览器的代理地址, 关闭函数或 None)。

    - 空：("", None)，直连；
    - 无认证 http/https：（规范化后）直接交给浏览器；无认证 socks5/socks5h：映射为 socks5://host:port；
    - 带认证（任意协议）：在本机起转发器，浏览器连 http://127.0.0.1:<port>，凭据只在本进程。
    地址非法时抛 ValueError（信息不含凭据）。
    """
    if not str(proxy or "").strip():
        return "", None
    spec = parse_proxy_url(proxy)
    if not spec.authenticated:
        return chrome_proxy_server(spec), None
    forwarder = ProxyForwarder(spec, ssl_context=ssl_context)
    LOG.info("代理带认证：已在本机 %s 起转发（上游 %s，浏览器不直接持有凭据）", forwarder.url, spec.redacted())
    return forwarder.url, forwarder.shutdown


# ---------------------------------------------------------------------------
# 求解逻辑
# ---------------------------------------------------------------------------

# turnstile 资源名带构建 hash，会随上游部署变化；优先运行时发现，这里只是最后的兜底
FALLBACK_TURNSTILE_URL = "/unauth-mweb/assets/turnstile-DykPLDEM.js"
# VM 超出自带的 500ms 预算时只返回执行步数；冷启动常见，重试即可
VM_TIMEOUT_MARK = "turnstile VM timed out"
VM_TIMEOUT_ATTEMPTS = 3

# 资源名带构建 hash（如 turnstile-DykPLDEM.js），随上游部署变化，不能写死。
# 浏览器里分层发现：已加载资源 -> 页面脚本 -> 抓 sentinel 模块源码解析 import 说明符。
_TURNSTILE_SCRIPT = """
        (async () => {
          const reqs = %s, key = %s, FALLBACK = %s, TIMEOUT_MARK = %s;
          const tried = [];
          const ASSET = (n) => '/unauth-mweb/assets/' + n;

          async function fromModules() {
            const names = new Set();
            try {
              const res = await fetch('/', { credentials: 'include' });
              const html = await res.text();
              for (const m of html.matchAll(/([A-Za-z0-9._-]+\\.js)/g)) names.add(m[1]);
            } catch (error) { /* ignore */ }
            for (const el of Array.from(document.scripts || [])) {
              if (el && el.src) {
                const last = el.src.split('/').pop();
                if (last && last.endsWith('.js')) names.add(last);
              }
            }
            let budget = 8;
            for (const name of Array.from(names)) {
              if (budget-- <= 0) break;
              try {
                const text = await (await fetch(ASSET(name), { credentials: 'include' })).text();
                const m = new RegExp('(turnstile-[A-Za-z0-9_-]+\\.js)').exec(text);
                if (m) return ASSET(m[1]);
              } catch (error) { /* ignore */ }
            }
            return null;
          }

          const candidates = [];
          if (window.__turnstileUrl) candidates.push(window.__turnstileUrl);
          try {
            for (const entry of performance.getEntriesByType('resource')) {
              const m = new RegExp('/assets/(turnstile-[A-Za-z0-9_-]+\\.js)').exec(entry.name);
              if (m) candidates.push(ASSET(m[1]));
            }
          } catch (error) { /* ignore */ }
          const discovered = await fromModules();
          if (discovered) candidates.push(discovered);
          candidates.push(FALLBACK);

          for (const url of Array.from(new Set(candidates))) {
            tried.push(url);
            try {
              const mod = await import(url);
              if (!mod || typeof mod.turnstile !== 'object') continue;
              window.__turnstileUrl = url;
              // getEnforcementToken 第一步先查自己的 tokenCache（也是 WeakMap）。钩子若不跳过它，
              // 会直接把 p 当成 token 返回，VM 根本不执行——上游拿到的就是一个无效 turnstile。
              const cache = mod.turnstile.tokenCache;
              const original = WeakMap.prototype.get;
              WeakMap.prototype.get = function (target) {
                if (this === cache) return original.call(this, target);
                return target === reqs ? key : original.call(this, target);
              };
              let token = '';
              try { token = String(await mod.turnstile.getEnforcementToken(reqs) || ''); }
              finally { WeakMap.prototype.get = original; }
              if (!token) return 'ERR:turnstile VM returned an empty token';
              if (token === key) return 'ERR:turnstile VM did not run (p echoed back)';
              // VM 自带 500ms 预算，超时只返回已执行步数（纯数字）
              if (/^\\d+$/.test(token)) return 'ERR:' + TIMEOUT_MARK + ' after ' + token + ' steps';
              // VM 内部异常走 btoa("<步数>: <错误>")，同样不是有效 token
              let decoded = '';
              try { decoded = atob(token); } catch (error) { /* 正常 token 不一定可解 */ }
              if (/^\\d+: /.test(decoded)) return 'ERR:turnstile VM error: ' + decoded.slice(0, 160);
              return token;
            } catch (error) { /* try next */ }
          }
          return 'ERR:cannot load turnstile module; tried=' + JSON.stringify(tried) +
                 '; page=' + location.href;
        })()
        """


def build_turnstile_script(requirements: dict, p_token: str) -> str:
    """默认 lane 与代理 lane 共用的求解脚本。"""
    return _TURNSTILE_SCRIPT % (json.dumps(requirements), json.dumps(p_token),
                                json.dumps(FALLBACK_TURNSTILE_URL), json.dumps(VM_TIMEOUT_MARK))


DEFAULT_CHROME_CANDIDATES = [
    os.path.expanduser("~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/"
                       "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
]


class LaneBusyError(RuntimeError):
    """lane 数已到上限且都在使用中，暂时无法为新代理建 lane。"""


class Lane:
    """一个代理出口：独立浏览器上下文 + 其中一个 tab + 本地转发器（带认证时）。"""

    def __init__(self, spec: ProxySpec) -> None:
        self.spec = spec
        self.key = spec.url()
        self.redacted = spec.redacted()
        self.lock = threading.Lock()              # 同一代理串行求解
        self.context_id: str | None = None
        self.page: Any = None
        self.generation = -1                      # 建上下文时的浏览器代数；与当前不一致即失效
        self.chrome_proxy: str | None = None      # 交给浏览器的代理地址；None 表示尚未准备
        self.forwarder_shutdown: Callable[[], None] | None = None
        self.last_used = time.time()
        self.inflight = 0                         # 持有或等待本 lane 的请求数；>0 时不回收
        self.solves = 0
        self.errors = 0
        self.closed = False


class BrowserPool:
    """一个浏览器：默认上下文常驻一个页面；带代理的请求按代理分 lane（各自独立的浏览器上下文）。

    锁顺序（只能按此方向嵌套，都不可重入，持有时不得再次获取）：
        lane 锁（默认 lane 即 self._lock）→ self._launch_lock → self._lanes_lock
    """

    def __init__(self, cdp_port: int, page_url: str, user_agent: str | None = None,
                 launcher: Any | None = None, *, max_lanes: int = 8, lane_idle_secs: float = 1800,
                 lane_wait_secs: float = 60,
                 page_factory: Callable[..., Any] | None = None,
                 browser_factory: Callable[[int], Any] | None = None,
                 proxy_factory: Callable[[str], tuple[str, Callable[[], None] | None]] | None = None) -> None:
        self.cdp_port = cdp_port
        self.page_url = page_url
        self.user_agent = user_agent
        self.max_lanes = max(0, int(max_lanes))
        self.lane_idle_secs = max(0.0, float(lane_idle_secs))
        # lane 全忙时新代理等多久空出一个（回落到主程序的内置求解器基本过不了 turnstile，宁可排队）
        self.lane_wait_secs = max(0.0, float(lane_wait_secs))
        self._launcher = launcher          # 无浏览器时用它重新拉起（容器里浏览器可能先挂掉）
        self._page_factory = page_factory or CdpPage
        self._browser_factory = browser_factory or BrowserCdp
        self._proxy_factory = proxy_factory or make_page_proxy
        self._lock = threading.Lock()          # 默认 lane：串行求解
        self._launch_lock = threading.Lock()   # (重新)拉起浏览器、browser 级 CDP 连接、generation
        self._lanes_lock = threading.Lock()    # self._lanes 及各 lane 的 inflight / 计数
        self._lanes_cond = threading.Condition(self._lanes_lock)   # lane 释放时唤醒等空位的请求
        self._page: Any = None
        self._process: Any = None
        self._last_launch = 0.0
        self._lanes: OrderedDict[str, Lane] = OrderedDict()
        self._generation = 0                   # 浏览器每次（重新）拉起 +1，旧 lane 随之失效
        self._browser: Any = None
        self._browser_generation = -1
        self._browser_ws: tuple[str, int] = ("", 0)   # (上次连上的 browser ws 地址, 当时的 generation)
        self._reaper_stop = threading.Event()
        self._reaper: threading.Thread | None = None

    # -- 浏览器 ----------------------------------------------------------------

    def _cdp_alive(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json/version", timeout=3) as response:
                json.load(response)
                return True
        except Exception:
            return False

    def probe(self) -> tuple[bool, str]:
        """(浏览器是否可用, 说明)；供 /health 使用，避免“服务在跑但浏览器挂了”被误判为健康。"""
        if self._cdp_alive():
            return True, "browser ready"
        if self._process is not None and getattr(self._process, "poll", lambda: None)() is not None:
            return False, f"browser exited (code={self._process.poll()})"
        return False, "browser not reachable via CDP"

    def ensure_browser(self) -> bool:
        """确保有一个可用的浏览器；必要时（重新）拉起。只取 _launch_lock，调用方可持有 lane 锁。"""
        if self._cdp_alive():
            return True
        if self._launcher is None:
            return False
        with self._launch_lock:
            if self._cdp_alive():
                return True
            if time.time() - self._last_launch < 5:
                return False
            self._last_launch = time.time()
            try:
                self._process = self._launcher()
            except Exception as exc:
                LOG.warning("拉起浏览器失败: %s", str(exc)[:300])
                return False
            self._generation += 1
            LOG.info("浏览器已拉起（generation=%d，代理 lane 将按需重建）", self._generation)
            return True

    def _browser_cdp(self) -> tuple[Any, int]:
        """browser 级 CDP 连接（断了就重连）及其对应的浏览器代数。不负责拉起浏览器。"""
        with self._launch_lock:
            browser = self._browser
            if browser is not None and self._browser_generation == self._generation:
                try:
                    browser.ping()
                    return browser, self._generation
                except Exception:
                    pass
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass
                self._browser = None
            browser = self._browser_factory(self.cdp_port)
            ws_url = str(getattr(browser, "ws_url", "") or "")
            last_ws, last_gen = self._browser_ws
            if last_ws and ws_url and ws_url != last_ws and last_gen == self._generation:
                # 浏览器在本服务之外被重启（如 --no-launch），同样让所有 lane 失效
                self._generation += 1
                LOG.info("检测到浏览器已更换（generation=%d），代理 lane 将按需重建", self._generation)
            self._browser_ws = (ws_url or last_ws, self._generation)
            self._browser, self._browser_generation = browser, self._generation
            return browser, self._generation

    # -- 默认 lane -------------------------------------------------------------

    def page(self) -> Any:
        """默认上下文的常驻页面；调用方须持有 self._lock。"""
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
        if not self.ensure_browser():
            raise RuntimeError("浏览器不可用（CDP 端口无响应且拉起失败）")
        page = self._page_factory(self.cdp_port, self.user_agent)
        try:
            page.open(self.page_url)
        except Exception:
            try:
                page.close()
            except Exception:
                pass
            raise
        self._page = page
        return page

    def warm_up(self) -> str:
        with self._lock:
            return self.page().current_url()

    # -- 代理 lane -------------------------------------------------------------

    def _acquire_lane(self, spec: ProxySpec) -> Lane:
        """取（或新建）lane 并占用；超出上限时按 LRU 回收空闲 lane，全忙时最多等 lane_wait_secs。"""
        key = spec.url()
        victims: list[Lane] = []
        deadline = time.time() + self.lane_wait_secs
        with self._lanes_cond:
            while True:
                lane = self._lanes.get(key)
                if lane is not None:
                    self._lanes.move_to_end(key)
                    break
                if self.max_lanes <= 0:
                    raise LaneBusyError("proxy lanes disabled (max_lanes=0)")
                idle = [k for k, item in self._lanes.items() if item.inflight == 0]   # 由旧到新
                overflow = len(self._lanes) + 1 - self.max_lanes
                if overflow <= len(idle):
                    for victim_key in idle[:max(0, overflow)]:
                        victims.append(self._lanes.pop(victim_key))
                    lane = Lane(spec)
                    self._lanes[key] = lane
                    break
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise LaneBusyError(f"all {len(self._lanes)} proxy lanes are busy (max_lanes={self.max_lanes})")
                self._lanes_cond.wait(remaining)
            lane.inflight += 1
            lane.last_used = time.time()
        for victim in victims:
            self._teardown_lane(victim, "lru")
        return lane

    def _release_lane(self, lane: Lane, ok: bool) -> None:
        with self._lanes_cond:
            lane.inflight -= 1
            lane.last_used = time.time()
            if ok:
                lane.solves += 1
            else:
                lane.errors += 1
            self._lanes_cond.notify_all()

    def _dispose_context(self, context_id: str, generation: int) -> None:
        """尽力销毁上下文；浏览器已换代时旧上下文已随旧进程消失，无需处理。"""
        if generation != self._generation:
            return
        try:
            browser, current = self._browser_cdp()
            if current == generation:
                browser.dispose_context(context_id)
        except Exception as exc:
            LOG.debug("销毁浏览器上下文失败（忽略）: %s", str(exc)[:200])

    def _drop_lane_page(self, lane: Lane, dispose: bool) -> None:
        page, context_id, generation = lane.page, lane.context_id, lane.generation
        lane.page, lane.context_id = None, None
        if page is not None:
            try:
                page.close()
            except Exception:
                pass
        if dispose and context_id:
            self._dispose_context(context_id, generation)

    def _teardown_lane(self, lane: Lane, reason: str) -> None:
        """回收 lane：关页面、销毁上下文、关转发器。调用方保证 lane 已移出字典且无人使用。"""
        lane.closed = True
        self._drop_lane_page(lane, dispose=True)
        shutdown, lane.forwarder_shutdown = lane.forwarder_shutdown, None
        if shutdown is not None:
            try:
                shutdown()
            except Exception:
                pass
        LOG.info("回收代理 lane %s（%s，成功 %d / 失败 %d）", lane.redacted, reason, lane.solves, lane.errors)

    def _lane_page(self, lane: Lane) -> Any:
        """lane 的页面，必要时（重）建上下文与 tab 并预热；调用方须持有 lane.lock。"""
        if lane.closed:
            raise RuntimeError("proxy lane already closed")
        if lane.page is not None:
            if lane.generation == self._generation:
                try:
                    lane.page.evaluate("1+1", timeout=8)
                    return lane.page
                except Exception:
                    self._drop_lane_page(lane, dispose=True)
            else:
                self._drop_lane_page(lane, dispose=False)     # 浏览器已重启，旧上下文已不存在
        if not self.ensure_browser():
            raise RuntimeError("浏览器不可用（CDP 端口无响应且拉起失败）")
        browser, generation = self._browser_cdp()
        if lane.chrome_proxy is None:
            # 转发器与浏览器无关，跨 generation 复用
            lane.chrome_proxy, lane.forwarder_shutdown = self._proxy_factory(lane.key)
        context_id = browser.create_context(lane.chrome_proxy)
        try:
            target_id = browser.create_target(context_id)
            page = self._page_factory(self.cdp_port, self.user_agent, target_id=target_id)
            try:
                page.open(self.page_url)       # 预热：与默认页面一样先打开 chatgpt.com
            except Exception:
                try:
                    page.close()
                except Exception:
                    pass
                raise
        except Exception:
            self._dispose_context(context_id, generation)
            raise
        lane.page, lane.context_id, lane.generation = page, context_id, generation
        LOG.info("代理 lane 就绪: %s（generation=%d）", lane.redacted, generation)
        return page

    def reap(self, now: float | None = None) -> int:
        """回收空闲超时的 lane（以及超出上限的空闲 lane）；正在使用的不动。返回回收数。"""
        now = time.time() if now is None else now
        victims: list[tuple[Lane, str]] = []
        with self._lanes_lock:
            for key, lane in list(self._lanes.items()):
                if lane.inflight == 0 and now - lane.last_used >= self.lane_idle_secs:
                    victims.append((self._lanes.pop(key), "idle"))
            for key, lane in list(self._lanes.items()):
                if len(self._lanes) <= self.max_lanes:
                    break
                if lane.inflight == 0:
                    victims.append((self._lanes.pop(key), "lru"))
        for lane, reason in victims:
            self._teardown_lane(lane, reason)
        return len(victims)

    def start_reaper(self, interval: float | None = None) -> None:
        if self._reaper is not None:
            return
        wait = interval if interval is not None else max(5.0, min(60.0, self.lane_idle_secs / 4))

        def loop() -> None:
            while not self._reaper_stop.wait(wait):
                try:
                    self.reap()
                except Exception as exc:
                    LOG.warning("回收 lane 出错: %s", str(exc)[:200])

        self._reaper = threading.Thread(target=loop, name="lane-reaper", daemon=True)
        self._reaper.start()

    def lanes_snapshot(self) -> list[dict[str, Any]]:
        now = time.time()
        with self._lanes_lock:
            return [{"proxy": lane.redacted,
                     "idle_secs": 0 if lane.inflight else int(max(0.0, now - lane.last_used)),
                     "solves": lane.solves,
                     "errors": lane.errors}
                    for lane in self._lanes.values()]

    def close(self) -> None:
        self._reaper_stop.set()
        with self._lanes_lock:
            lanes = list(self._lanes.values())
            self._lanes.clear()
        for lane in lanes:
            self._teardown_lane(lane, "shutdown")
        with self._launch_lock:
            browser, self._browser = self._browser, None
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass

    # -- 求解 ------------------------------------------------------------------

    @staticmethod
    def _solve_attempts(lock: threading.Lock, get_page: Callable[[], Any], script: str,
                        label: str) -> tuple[bool, str]:
        error = ""
        for attempt in range(1, VM_TIMEOUT_ATTEMPTS + 1):
            with lock:
                page = get_page()
                token = str(page.evaluate(script, timeout=180) or "")
            if not token.startswith("ERR:"):
                return bool(token), token
            error = token[4:]
            # 冷启动时模块/页面还没热，VM 常超出 500ms 预算；页面已加载好，重试即可
            if VM_TIMEOUT_MARK not in error:
                break
            LOG.info("turnstile VM 超时（%s，第 %d/%d 次）: %s", label, attempt, VM_TIMEOUT_ATTEMPTS, error)
        return False, error

    def solve(self, requirements: dict, p_token: str, proxy: str = "") -> tuple[bool, str]:
        """proxy 为空走默认 lane；否则走该代理的 lane，失败也不会回落到默认 lane。"""
        script = build_turnstile_script(requirements, p_token)
        if not str(proxy or "").strip():
            return self._solve_attempts(self._lock, self.page, script, "default")
        spec = parse_proxy_url(proxy)
        self.reap()                               # 顺手回收空闲 lane
        try:
            lane = self._acquire_lane(spec)
        except LaneBusyError as exc:
            LOG.warning("代理 lane 不可用（%s）: %s", spec.redacted(), exc)
            return False, str(exc)
        ok = False
        try:
            ok, text = self._solve_attempts(lane.lock, lambda: self._lane_page(lane), script, lane.redacted)
            return ok, text
        finally:
            self._release_lane(lane, ok)


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
            "--disable-dev-shm-usage",
            # WebRTC 不得绕过代理直接走 UDP，否则会暴露真实出口
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            f"--remote-debugging-port={cdp_port}", f"--user-data-dir={profile_dir}",
            "about:blank"]
    # 容器里通常以 root 运行，Chromium 必须关闭 sandbox，否则起不来
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
        args.insert(2, "--disable-setuid-sandbox")
    if proxy:
        args.insert(1, f"--proxy-server={proxy}")
    LOG.info("启动浏览器: %s (cdp %s, sandbox=%s)", binary, cdp_port,
             "off" if "--no-sandbox" in args else "on")
    # 保留浏览器输出，启动失败时能看到真实原因（缺库、sandbox 等）
    log_path = os.path.join(os.path.dirname(profile_dir) or "/tmp", "chromium.log")
    try:
        log_file = open(log_path, "ab", buffering=0)
    except Exception:
        log_file = subprocess.DEVNULL
    process = subprocess.Popen(args, stdout=log_file, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    while time.time() < deadline:
        if process.poll() is not None:
            break
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=3) as response:
                json.load(response)
                return process
        except Exception:
            time.sleep(0.5)
    tail = ""
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            tail = "".join(fh.readlines()[-15:]).strip()
    except Exception:
        pass
    raise RuntimeError(f"浏览器 CDP 端口未就绪（exit={process.poll()}）；chromium 输出尾部：{tail[:800]}")


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


def _scrub(text: str, proxy: str = "") -> str:
    """返回给调用方 / 写日志前去掉代理凭据。"""
    text = str(text or "")
    if proxy and proxy in text:
        text = text.replace(proxy, redact_proxy_url(proxy))
    return redact_proxy_text(text)


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
                ready, detail = pool.probe()
                lanes = pool.lanes_snapshot()
                return self._send(200 if ready else 503, {
                    "ok": ready, "browser": detail,
                    "lanes": lanes, "lane_count": len(lanes), "max_lanes": pool.max_lanes,
                })
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
            if not isinstance(payload, dict):
                return self._send(400, {"ok": False, "error": "bad json: object expected"})
            raw_proxy = payload.get("proxy")
            if raw_proxy is not None and not isinstance(raw_proxy, str):
                return self._send(400, {"ok": False, "error": "proxy must be a string", "lane": "proxy"})
            proxy = (raw_proxy or "").strip()
            lane = "proxy" if proxy else "default"
            label = "default"
            if proxy:
                try:
                    label = parse_proxy_url(proxy).redacted()
                except ValueError as exc:
                    return self._send(400, {"ok": False, "error": f"bad proxy: {exc}", "lane": lane})
            requirements = payload.get("requirements")
            p_token = payload.get("p")
            if not isinstance(requirements, dict) or not p_token:
                return self._send(400, {"ok": False, "error": "requirements/p required", "lane": lane})
            started = time.time()
            try:
                ok, token = pool.solve(requirements, str(p_token), proxy=proxy)
            except Exception as exc:
                message = _scrub(str(exc), proxy)
                LOG.warning("求解失败（lane=%s）: %s", label, message[:200])
                return self._send(500, {"ok": False, "error": message[:200], "lane": lane})
            LOG.info("求解%s（lane=%s），耗时 %.1fs，token 长度 %d", "成功" if ok else "失败", label,
                     time.time() - started, len(token))
            if not ok:
                message = _scrub(token, proxy)
                LOG.warning("求解失败原因（lane=%s）: %s", label, message[:400])
                return self._send(200, {"ok": False, "error": message[:300], "lane": lane})
            return self._send(200, {"ok": True, "turnstile": token, "lane": lane})

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
    parser.add_argument("--proxy", default=os.environ.get("SENTINEL_SOLVER_PROXY", ""),
                        help="默认 lane（请求不带 proxy 时）的浏览器出口；可带认证")
    parser.add_argument("--page-url", default=os.environ.get("SENTINEL_SOLVER_PAGE_URL", "https://chatgpt.com/"))
    parser.add_argument("--user-agent", default="")
    parser.add_argument("--max-lanes", type=int, default=int(os.environ.get("SENTINEL_SOLVER_MAX_LANES", "8")),
                        help="代理 lane 上限（每个约 150-250MB 内存），超出按 LRU 回收；0 表示不接受带 proxy 的请求")
    parser.add_argument("--lane-idle-secs", type=float,
                        default=float(os.environ.get("SENTINEL_SOLVER_LANE_IDLE_SECS", "1800")),
                        help="代理 lane 空闲多久后回收（秒）")
    parser.add_argument("--no-launch", action="store_true", help="复用已存在的浏览器，不自行启动")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if not args.key:
        LOG.error("必须提供 --key（或用环境变量 SENTINEL_SOLVER_KEY），否则任何人都能调用")
        return 2

    launcher = None
    process = None
    proxy_cleanup: Callable[[], None] | None = None
    if not args.no_launch:
        Path(args.profile_dir).mkdir(parents=True, exist_ok=True)

        try:
            page_proxy, proxy_cleanup = make_page_proxy(args.proxy)
        except Exception as exc:
            LOG.error("SENTINEL_SOLVER_PROXY 无法使用，默认 lane 将直连: %s", _scrub(str(exc), args.proxy)[:300])
            page_proxy = ""

        def launcher():                   # noqa: ANN202
            return launch_chrome(args.cdp_port, args.chrome or None, args.profile_dir, page_proxy)

        try:
            process = launcher()
        except Exception as exc:
            # 不退出：容器里浏览器可能因为沙箱/缺库失败，保留服务让后续请求重试并暴露原因
            LOG.error("首次启动浏览器失败（服务继续运行，请求时会重试）: %s", str(exc)[:400])

    pool = BrowserPool(args.cdp_port, args.page_url, args.user_agent or None, launcher=launcher,
                       max_lanes=args.max_lanes, lane_idle_secs=args.lane_idle_secs)
    pool._process = process
    try:
        LOG.info("浏览器就绪，页面已加载: %s", pool.warm_up() or "?")    # 预热默认 lane
    except Exception as exc:
        LOG.warning("预热失败（首个请求会重试）: %s", str(exc)[:400])
    pool.start_reaper()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(pool, args.key))
    LOG.info("solver 监听 http://%s:%d（需 X-Solver-Key；代理 lane 上限 %d，空闲 %ds 回收）",
             args.host, args.port, pool.max_lanes, int(pool.lane_idle_secs))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        pool.close()
        if proxy_cleanup is not None:
            proxy_cleanup()
        if process is not None:
            process.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
