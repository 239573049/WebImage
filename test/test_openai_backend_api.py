from __future__ import annotations

import copy
import io
import json
import os
import threading
import unittest
import urllib.error
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from curl_cffi import requests as curl_requests
from curl_cffi.requests import Headers

from services.config import DEFAULT_PROXY_RUNTIME
from services.protocol.conversation import build_image_prompt, classify_image_text_error
from services.openai_backend_api import (
    CODEX_URLLIB_USER_AGENT,
    OpenAIBackendAPI,
    _is_content_policy_error,
)
from services.proxy_service import ProxySettingsStore
from utils.helper import UpstreamHTTPError, ensure_ok


class ImageTextErrorTests(unittest.TestCase):

    def test_image_prompt_includes_requested_size_and_quality(self) -> None:
        prompt = build_image_prompt("生成一张城市夜景", "2160x3840", "high")
        self.assertIn("2160x3840", prompt)
        self.assertIn("输出图片质量要求：高清晰度（高质量、细节丰富）", prompt)

    def test_classify_image_text_error_for_content_policy(self) -> None:
        error_type, code = classify_image_text_error("Image rejected due to content policy moderation")
        self.assertEqual(error_type, "invalid_request_error")
        self.assertEqual(code, "content_policy_violation")

    def test_classify_image_text_error_for_non_policy_text(self) -> None:
        sample = (
            "---\nname: \"imagegen\"\n"
            "description: \"Generate or edit raster images\""
        )
        error_type, code = classify_image_text_error(sample)
        self.assertEqual(error_type, "invalid_request_error")
        self.assertEqual(code, "no_image_generated")

    def test_imagegen_skill_frontmatter_is_not_content_policy_error(self) -> None:
        sample = (
            "---\nname: \"imagegen\"\n"
            "description: \"Generate or edit raster images when the task benefits from "
            "AI-created bitmap visuals... Do not use when the task is better handled by "
            "editing existing SVG/vector/code-native"
        )
        self.assertFalse(_is_content_policy_error(sample))

    def test_real_policy_message_still_detected(self) -> None:
        self.assertTrue(_is_content_policy_error("这张图片违反了我们的内容政策，无法生成。"))


CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
CODEX_SSE = b'data: {"type": "response.completed"}\n\n'


class _ProxyConfig:
    def __init__(self, legacy_proxy: str = "", runtime: dict[str, object] | None = None) -> None:
        self.legacy_proxy = legacy_proxy
        self.runtime = runtime if runtime is not None else copy.deepcopy(DEFAULT_PROXY_RUNTIME)

    def get_proxy_settings(self) -> str:
        return self.legacy_proxy

    def get_proxy_runtime_settings(self) -> dict[str, object]:
        return copy.deepcopy(self.runtime)


class _FakeCurlResponse:
    def __init__(self, status_code: int = 200, headers: Headers | None = None, content: bytes = CODEX_SSE) -> None:
        self.status_code = status_code
        self.headers = headers if headers is not None else Headers({"content-type": "text/event-stream"})
        self.content = content


class _FakeCurlSession:
    created: list["_FakeCurlSession"] = []
    response = _FakeCurlResponse()

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.headers: dict[str, str] = {}
        self.posts: list[tuple[str, dict[str, object]]] = []
        self.closed = False
        type(self).created.append(self)

    def post(self, url: str, **kwargs: object) -> _FakeCurlResponse:
        self.posts.append((url, kwargs))
        return type(self).response

    def close(self) -> None:
        self.closed = True


class _FakeUrlopenResponse:
    status = 200

    def __init__(self, body: bytes) -> None:
        self.headers = Message()
        self.headers["Content-Type"] = "text/event-stream"
        self._body = body

    def __enter__(self) -> "_FakeUrlopenResponse":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class CodexResponsesTransportTests(unittest.TestCase):
    """codex responses 链路：配置了代理就必须经代理发出，没有代理时保持 urllib 直连。"""

    def setUp(self) -> None:
        _FakeCurlSession.created = []
        _FakeCurlSession.response = _FakeCurlResponse()
        self.account: dict[str, object] = {"access_token": "tok", "source_type": "codex", "proxy": ""}
        self.accounts = SimpleNamespace(
            get_account=lambda token: copy.deepcopy(self.account),
            _decode_jwt_payload=lambda token: {},
        )

    def make_api(self, legacy_proxy: str = "", runtime: dict[str, object] | None = None) -> OpenAIBackendAPI:
        store = ProxySettingsStore(_ProxyConfig(legacy_proxy, runtime))
        for target, value in (
            ("services.openai_backend_api.proxy_settings", store),
            ("services.openai_backend_api.account_service", self.accounts),
            ("services.openai_backend_api.requests.Session", _FakeCurlSession),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        return OpenAIBackendAPI("tok")

    def test_global_proxy_routes_codex_request_through_curl_cffi(self) -> None:
        api = self.make_api(legacy_proxy="socks5://global.example:1080")

        with patch("services.openai_backend_api.urllib.request.urlopen") as urlopen:
            events = list(api.iter_codex_image_response_events("draw a cat"))

        self.assertEqual(events, [{"type": "response.completed"}])
        urlopen.assert_not_called()
        self.assertEqual(len(_FakeCurlSession.created), 2)  # 主会话 + codex 专用会话
        codex_session = _FakeCurlSession.created[-1]
        self.assertEqual(codex_session.kwargs["proxy"], "socks5h://global.example:1080")
        self.assertIs(codex_session.kwargs["verify"], True)
        self.assertNotIn("impersonate", codex_session.kwargs)
        [(url, call)] = codex_session.posts
        self.assertEqual(url, CODEX_URL)
        self.assertEqual(call["headers"]["Authorization"], "Bearer tok")
        self.assertEqual(call["headers"]["User-Agent"], CODEX_URLLIB_USER_AGENT)
        self.assertEqual(call["timeout"], 1200)
        self.assertEqual(json.loads(call["data"])["tools"][0]["type"], "image_generation")
        self.assertTrue(codex_session.closed)

    def test_runtime_proxy_covers_codex_request_and_account_proxy_still_wins(self) -> None:
        runtime = copy.deepcopy(DEFAULT_PROXY_RUNTIME)
        runtime.update(enabled=True, egress_mode="single_proxy", proxy_url="http://runtime.example:8080")
        api = self.make_api(legacy_proxy="http://global.example:8080", runtime=runtime)

        list(api.iter_codex_image_response_events("draw"))

        self.assertEqual(_FakeCurlSession.created[0].kwargs["proxy"], "http://runtime.example:8080")
        self.assertEqual(_FakeCurlSession.created[-1].kwargs["proxy"], "http://runtime.example:8080")

    def test_account_proxy_wins_for_codex_request(self) -> None:
        self.account["proxy"] = "socks5://account.example:1080"
        api = self.make_api(legacy_proxy="http://global.example:8080")

        list(api.iter_codex_image_response_events("draw"))

        self.assertEqual(_FakeCurlSession.created[-1].kwargs["proxy"], "socks5h://account.example:1080")

    def test_codex_request_keeps_urllib_transport_without_proxy(self) -> None:
        api = self.make_api()

        with patch(
            "services.openai_backend_api.urllib.request.urlopen",
            return_value=_FakeUrlopenResponse(CODEX_SSE),
        ) as urlopen:
            events = list(api.iter_codex_image_response_events("draw"))

        self.assertEqual(events, [{"type": "response.completed"}])
        self.assertEqual(len(_FakeCurlSession.created), 1)  # 只有主会话，没有 codex 专用会话
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, CODEX_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer tok")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 1200)

    def test_http_error_through_proxy_raises_upstream_error_with_retry_after(self) -> None:
        _FakeCurlSession.response = _FakeCurlResponse(
            429,
            Headers({"Retry-After": "7", "content-type": "application/json"}),
            b'{"error": {"message": "slow down"}}',
        )
        api = self.make_api(legacy_proxy="http://global.example:8080")

        with self.assertRaises(UpstreamHTTPError) as caught:
            list(api.iter_codex_image_response_events("draw"))

        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.retry_after, 7)
        self.assertEqual(caught.exception.body, {"error": {"message": "slow down"}})
        self.assertTrue(_FakeCurlSession.created[-1].closed)

    def test_http_error_without_proxy_still_raises_upstream_error_with_retry_after(self) -> None:
        headers = Message()
        headers["Retry-After"] = "9"
        error = urllib.error.HTTPError(
            CODEX_URL, 429, "Too Many Requests", headers, io.BytesIO(b'{"error": "slow"}')
        )
        api = self.make_api()

        with patch("services.openai_backend_api.urllib.request.urlopen", side_effect=error):
            with self.assertRaises(UpstreamHTTPError) as caught:
                list(api.iter_codex_image_response_events("draw"))

        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.retry_after, 9)
        self.assertEqual(caught.exception.body, {"error": "slow"})


class _UpstreamStub(BaseHTTPRequestHandler):
    """本地假上游：按路径返回固定的状态码、响应头和 body。"""

    routes: dict[str, tuple[int, dict[str, str], bytes]] = {}

    def do_POST(self) -> None:
        status, headers, body = self.routes[self.path]
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return None


class EnsureOkTests(unittest.TestCase):
    """stream=True 的响应在被读取前 .text 为空；错误状态码必须把上游真实的报错读出来。"""

    def setUp(self) -> None:
        _UpstreamStub.routes = {
            "/model-missing": (404, {"Content-Type": "application/json"}, b'{"detail": "Model not found"}'),
            "/rate-limited": (429, {"Content-Type": "application/json", "Retry-After": "7"}, b'{"error": "slow"}'),
            "/gateway": (502, {"Content-Type": "text/html"}, b"<h1>Bad Gateway</h1>"),
            "/empty": (404, {}, b""),
            "/fine": (200, {"Content-Type": "application/json"}, b"{}"),
        }
        server = ThreadingHTTPServer(("127.0.0.1", 0), _UpstreamStub)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_address[1]}"
        self.session = curl_requests.Session(trust_env=False)
        self.addCleanup(self.session.close)

    def post(self, path: str, *, stream: bool) -> object:
        return self.session.post(self.base + path, json={}, stream=stream, timeout=10)

    def raised(self, path: str, *, stream: bool) -> UpstreamHTTPError:
        response = self.post(path, stream=stream)
        with self.assertRaises(UpstreamHTTPError) as caught:
            ensure_ok(response, "/backend-api/f/conversation")
        return caught.exception

    def test_streamed_error_keeps_the_upstream_json_body(self) -> None:
        error = self.raised("/model-missing", stream=True)

        self.assertEqual(error.status_code, 404)
        self.assertEqual(error.body, {"detail": "Model not found"})
        self.assertIn("Model not found", str(error))

    def test_streamed_error_keeps_retry_after_and_non_json_body(self) -> None:
        limited = self.raised("/rate-limited", stream=True)
        gateway = self.raised("/gateway", stream=True)

        self.assertEqual((limited.status_code, limited.retry_after, limited.body), (429, 7, {"error": "slow"}))
        self.assertEqual((gateway.status_code, gateway.body), (502, "<h1>Bad Gateway</h1>"))

    def test_non_streamed_error_behaves_as_before(self) -> None:
        error = self.raised("/model-missing", stream=False)

        self.assertEqual((error.status_code, error.body), (404, {"detail": "Model not found"}))

    def test_empty_error_body_stays_empty_for_both_modes(self) -> None:
        for stream in (True, False):
            with self.subTest(stream=stream):
                error = self.raised("/empty", stream=stream)
                self.assertEqual((error.status_code, error.body), (404, ""))

    def test_success_status_passes_through_and_leaves_the_stream_readable(self) -> None:
        response = self.post("/fine", stream=True)

        ensure_ok(response, "/backend-api/f/conversation")

        self.assertEqual(b"".join(response.iter_content()), b"{}")


CHALLENGE_HTML = b'<html>\n  <head>\n    <meta name="viewport" content="width=device-width, initial-scale=1" />'


def _challenge_response(with_header: bool = True) -> _FakeCurlResponse:
    headers = {"content-type": "text/html; charset=UTF-8"}
    if with_header:
        headers["cf-mitigated"] = "challenge"
    return _FakeCurlResponse(403, Headers(headers), CHALLENGE_HTML)


class _ChallengeSession(_FakeCurlSession):
    """按顺序返回预设响应；挑战响应像 Cloudflare 一样重新下发 __cf_bm。"""

    queue: list[_FakeCurlResponse] = []

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.cookies = curl_requests.Cookies()
        self.cookie_names_per_call: list[set[str]] = []

    def get(self, url: str, **kwargs: object) -> _FakeCurlResponse:
        self.cookie_names_per_call.append({cookie.name for cookie in self.cookies.jar})
        response = type(self).queue.pop(0)
        if response.status_code == 403:
            self.cookies.set("__cf_bm", "flagged", domain=".chatgpt.com")
        return response


class _IdentityTestBase(unittest.TestCase):
    def make_api(self, account: dict[str, object] | None = None, session_cls: type = _FakeCurlSession) -> OpenAIBackendAPI:
        _FakeCurlSession.created = []
        accounts = SimpleNamespace(get_account=lambda token: copy.deepcopy(account or {}))
        for target, value in (
            ("services.openai_backend_api.proxy_settings", ProxySettingsStore(_ProxyConfig())),
            ("services.openai_backend_api.account_service", accounts),
            ("services.openai_backend_api.requests.Session", session_cls),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        return OpenAIBackendAPI("tok")


class BrowserIdentityTests(_IdentityTestBase):
    """请求头声明的浏览器必须就是 TLS 指纹模拟的那个浏览器，否则 Cloudflare 会间歇回挑战页。"""

    def test_user_agent_and_client_hints_describe_the_tls_profile(self) -> None:
        api = self.make_api()
        headers = _FakeCurlSession.created[-1].headers

        major = api.fp["impersonate"].removeprefix("chrome")
        self.assertEqual(api.fp["impersonate"], "chrome146")
        self.assertIn(f"Chrome/{major}.0.0.0 Safari/537.36", headers["User-Agent"])
        # 与 curl_cffi chrome146 默认头逐字一致（含 GREASE 品牌及顺序）
        self.assertEqual(headers["Sec-Ch-Ua"], f'"Chromium";v="{major}", "Not-A.Brand";v="24", "Google Chrome";v="{major}"')
        self.assertTrue(headers["Sec-Ch-Ua-Full-Version"].startswith(f'"{major}.'))
        self.assertIn(f'"Google Chrome";v="{major}.', headers["Sec-Ch-Ua-Full-Version-List"])
        self.assertEqual(headers["Sec-Ch-Ua-Platform"], '"Windows"')
        self.assertIn("Windows NT 10.0", headers["User-Agent"])

    def test_identity_does_not_mix_in_edge(self) -> None:
        self.make_api()
        headers = _FakeCurlSession.created[-1].headers

        for name in ("User-Agent", "Sec-Ch-Ua", "Sec-Ch-Ua-Full-Version-List"):
            self.assertNotIn("Edg", headers[name], name)

    def test_legacy_impersonate_profile_is_upgraded(self) -> None:
        for legacy in ("chrome110", "edge101"):
            with self.subTest(legacy=legacy):
                api = self.make_api({"fp": {"impersonate": legacy}})
                self.assertEqual(api.fp["impersonate"], "chrome146")
                self.assertEqual(_FakeCurlSession.created[-1].kwargs["impersonate"], "chrome146")


class CloudflareChallengeTests(_IdentityTestBase):
    def test_challenge_detection(self) -> None:
        json_403 = _FakeCurlResponse(403, Headers({"content-type": "application/json"}), b'{"detail":"Unusual activity"}')
        html_404 = _FakeCurlResponse(404, Headers({"content-type": "text/html"}), b"<html></html>")

        self.assertTrue(OpenAIBackendAPI._is_cloudflare_challenge(_challenge_response(with_header=True)))
        self.assertTrue(OpenAIBackendAPI._is_cloudflare_challenge(_challenge_response(with_header=False)))
        self.assertFalse(OpenAIBackendAPI._is_cloudflare_challenge(json_403))
        self.assertFalse(OpenAIBackendAPI._is_cloudflare_challenge(html_404))
        self.assertFalse(OpenAIBackendAPI._is_cloudflare_challenge(_FakeCurlResponse(200)))

    def test_fetch_drops_cloudflare_cookies_and_backs_off_between_retries(self) -> None:
        ok = _FakeCurlResponse(200, Headers({"content-type": "application/json"}), b"{}")
        _ChallengeSession.queue = [_challenge_response(), _challenge_response(with_header=False), ok]
        api = self.make_api(session_cls=_ChallengeSession)
        session = _ChallengeSession.created[-1]
        session.cookies.set("_cfuvid", "rate", domain=".chatgpt.com")
        session.cookies.set("oai-did", "device", domain=".chatgpt.com")

        with patch("services.openai_backend_api.time.sleep") as sleep:
            response = api._fetch("get", "https://chatgpt.com/backend-api/me")

        self.assertIs(response, ok)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1.5, 3.0])
        first, second, third = session.cookie_names_per_call
        self.assertEqual(first, {"_cfuvid", "oai-did"})
        self.assertEqual(second, {"oai-did"})      # 挑战下发的 __cf_bm 和原有 _cfuvid 都已清掉
        self.assertEqual(third, {"oai-did"})

    def test_fetch_gives_up_after_the_retry_budget(self) -> None:
        _ChallengeSession.queue = [_challenge_response() for _ in range(4)]
        api = self.make_api(session_cls=_ChallengeSession)

        with patch("services.openai_backend_api.time.sleep") as sleep:
            response = api._fetch("get", "https://chatgpt.com/backend-api/me")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(_ChallengeSession.queue, [])


class _ImageAccounts:
    def __init__(self) -> None:
        self.marks: list[tuple[bool, str]] = []

    def get_available_access_token(self, **kwargs: object) -> str:
        return "tok"

    def get_account(self, token: str) -> dict[str, str]:
        return {"email": "user@example.com"}

    def mark_image_result(self, token: str, success: bool, **kwargs: object) -> None:
        self.marks.append((success, str(kwargs.get("failure_kind"))))


class _NoopBackend:
    def __init__(self, access_token: str = "") -> None:
        self.progress_callback = None

    def close(self) -> None:
        return None


class ImageCloudflareRetryTests(unittest.TestCase):
    """生图任务遇到 Cloudflare 挑战页：不计入账号健康，换新会话退避重试，最终报错说清原因。"""

    def run_task(self, failures: int) -> tuple[object, _ImageAccounts, list[float]]:
        from services.protocol import conversation
        from services.protocol.conversation import ConversationRequest, ImageOutput

        accounts = _ImageAccounts()
        attempts = {"count": 0}

        def fake_stream(backend: object, request: object, index: int, total: int):
            attempts["count"] += 1
            if attempts["count"] <= failures:
                raise UpstreamHTTPError("chat_requirements_prepare", 403, CHALLENGE_HTML.decode())
            yield ImageOutput(kind="result", model="gpt-image-2", index=index, total=total, data=[{"b64_json": "x"}])

        for target, value in (
            ("account_service", accounts),
            ("OpenAIBackendAPI", _NoopBackend),
            ("stream_image_outputs", fake_stream),
            ("_remove_image_conversation_later", lambda *args, **kwargs: None),
        ):
            patcher = patch.object(conversation, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        with patch.object(conversation.time, "sleep") as sleep:
            try:
                result: object = conversation._generate_single_image(
                    ConversationRequest(model="gpt-image-2", prompt="cat"), 1, 1,
                )
            except conversation.ImageGenerationError as exc:
                result = exc
        return result, accounts, [call.args[0] for call in sleep.call_args_list]

    def test_transient_challenge_is_retried_without_penalizing_the_account(self) -> None:
        result, accounts, waits = self.run_task(failures=1)

        self.assertIsInstance(result, list)
        self.assertEqual(accounts.marks, [(False, "neutral"), (True, "transient")])
        self.assertEqual(waits, [5.0])

    def test_persistent_challenge_fails_with_a_clear_message(self) -> None:
        result, accounts, waits = self.run_task(failures=10)

        self.assertIn("Cloudflare challenge", str(result))
        self.assertEqual(accounts.marks, [(False, "neutral")] * 3)
        self.assertEqual(waits, [5.0, 10.0])

