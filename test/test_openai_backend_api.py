from __future__ import annotations

import copy
import io
import json
import os
import unittest
import urllib.error
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from curl_cffi.requests import Headers

from services.config import DEFAULT_PROXY_RUNTIME
from services.protocol.conversation import build_image_prompt, classify_image_text_error
from services.openai_backend_api import (
    CODEX_URLLIB_USER_AGENT,
    OpenAIBackendAPI,
    _is_content_policy_error,
)
from services.proxy_service import ProxySettingsStore
from utils.helper import UpstreamHTTPError


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

