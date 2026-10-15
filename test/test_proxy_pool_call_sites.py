"""代理池接线：同一个 backend 实例的主会话 / Codex / solver 同一出口；OAuth 预分配；刷新走绑定代理。"""

from __future__ import annotations

import copy
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.account_service import AccountService
from services.config import DEFAULT_PROXY_RUNTIME
from services.oauth_login_service import OAuthLoginService
from services.openai_backend_api import OpenAIBackendAPI
from services.proxy_pool_service import ProxyPoolService
from services.proxy_service import ProxySettingsStore
from services.sentinel_solver_service import SentinelSolverService

GLOBAL_PROXY = "http://global.example:8080"


class FakeConfig:
    def get_proxy_settings(self) -> str:
        return GLOBAL_PROXY

    def get_proxy_runtime_settings(self) -> dict:
        return copy.deepcopy(DEFAULT_PROXY_RUNTIME)


class FakeSession:
    created: list["FakeSession"] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.headers: dict[str, str] = {}
        self.posts: list[tuple[str, dict]] = []
        type(self).created.append(self)

    def request(self, method: str, url: str, **kwargs: object):
        return SimpleNamespace(status_code=200, headers={}, content=b"", text="")

    def post(self, url: str, **kwargs: object):
        self.posts.append((url, kwargs))
        return self.request("POST", url, **kwargs)

    def close(self) -> None:
        pass


def make_pool(*urls: str) -> ProxyPoolService:
    pool = ProxyPoolService(None, probe_func=lambda url, timeout: {"ok": True})
    pool.add_entries(list(urls))
    pool.update_settings({"enabled": True})
    return pool


class BackendEgressTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeSession.created = []
        self.pool = make_pool("http://a.example:1", "http://b.example:1", "http://c.example:1")
        self.store = ProxySettingsStore(FakeConfig(), pool_provider=lambda: self.pool)
        self.account: dict[str, object] = {}
        accounts = SimpleNamespace(
            get_account=lambda token: copy.deepcopy(self.account) if token else None,
            _decode_jwt_payload=lambda token: {},
        )
        for target, value in (
            ("services.openai_backend_api.proxy_settings", self.store),
            ("services.openai_backend_api.account_service", accounts),
            ("services.openai_backend_api.requests.Session", FakeSession),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def solver_proxy(self, api: OpenAIBackendAPI) -> str:
        captured: dict[str, str] = {}

        def fake_solve(requirements, p_token, timeout=None, proxy=""):
            captured["proxy"] = proxy
            return "TOKEN"

        with patch("services.openai_backend_api.sentinel_solver_service.solve_turnstile", fake_solve):
            self.assertEqual(api._solve_turnstile({"turnstile": {"required": True, "dx": "d"}}, "p"), "TOKEN")
        return captured["proxy"]

    def test_anonymous_instance_keeps_one_round_robin_egress(self) -> None:
        seen = set()
        for _ in range(3):
            api = OpenAIBackendAPI("")
            egress = api.proxy_profile.proxy_url
            seen.add(egress)
            self.assertEqual(api.proxy_profile.pool_route, "round_robin")
            self.assertEqual(FakeSession.created[-1].kwargs["proxy"], egress)
            self.assertIs(api._egress_profile(), api.proxy_profile)
            self.assertEqual(self.solver_proxy(api), egress)
        self.assertEqual(len(seen), 3)

    def test_bound_account_main_codex_and_solver_share_the_bound_proxy(self) -> None:
        b = self.pool.list_entries()[1]["id"]
        self.account = {"access_token": "tok", "source_type": "codex", "proxy_id": b}
        api = OpenAIBackendAPI("tok")
        self.assertEqual(api.proxy_profile.proxy_url, "http://b.example:1")
        self.assertEqual(self.solver_proxy(api), "http://b.example:1")
        try:
            list(api.iter_codex_image_response_events("draw"))
        except Exception:
            pass  # 假响应体不是合法 SSE；这里只关心 Codex 会话的出口
        self.assertEqual(len(FakeSession.created), 2)  # 主会话 + Codex 会话
        self.assertTrue(all(session.kwargs["proxy"] == "http://b.example:1" for session in FakeSession.created))

    def test_non_pool_egress_does_not_send_proxy_to_solver(self) -> None:
        self.pool.update_settings({"enabled": False})
        api = OpenAIBackendAPI("")
        self.assertEqual(api.proxy_profile.proxy_url, GLOBAL_PROXY)
        self.assertEqual(self.solver_proxy(api), "")


class AccountSessionTests(unittest.TestCase):
    def test_token_refresh_uses_bound_proxy(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1")
        b = pool.list_entries()[1]["id"]
        store = ProxySettingsStore(FakeConfig(), pool_provider=lambda: pool)
        response = MagicMock(status_code=200, text='{"access_token":"new"}')
        response.json.return_value = {"access_token": "new"}
        session = MagicMock()
        session.post.return_value = response
        storage = SimpleNamespace(load_accounts=lambda: [], save_accounts=lambda accounts: None)
        with (
            patch("curl_cffi.requests.Session", return_value=session) as session_cls,
            patch("services.proxy_service.proxy_settings", store),
        ):
            AccountService(storage)._request_access_token_refresh("rt", {"access_token": "t", "proxy_id": b})
        self.assertEqual(session_cls.call_args.kwargs["proxy"], "http://b.example:1")


class OAuthPreallocationTests(unittest.TestCase):
    def test_start_reserves_and_finish_exchanges_through_it(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1")
        a, b = [entry["id"] for entry in pool.list_entries()]
        accounts = SimpleNamespace(proxy_binding_counts=lambda: {a: 5})
        store = ProxySettingsStore(FakeConfig(), pool_provider=lambda: pool)
        service = OAuthLoginService()
        response = SimpleNamespace(
            status_code=200,
            text="{}",
            json=lambda: {"access_token": "access", "refresh_token": "refresh", "id_token": "id"},
        )
        with (
            patch("services.proxy_pool_service.proxy_pool", pool),
            patch("services.account_service.account_service", accounts),
            patch("services.oauth_login_service.proxy_settings", store),
            patch("services.oauth_login_service.requests.Session") as session_cls,
        ):
            session_cls.return_value.post.return_value = response
            started = service.start()
            self.assertEqual(service._sessions[started["session_id"]]["proxy_id"], b)
            self.assertEqual(pool.pick_least_loaded({}), a)  # 预占计入负载
            state = service._sessions[started["session_id"]]["state"]
            tokens = service.finish(started["session_id"], f"http://localhost/cb?code=c&state={state}")

        self.assertEqual(tokens["proxy_id"], b)
        self.assertEqual(session_cls.call_args.kwargs["proxy"], "http://b.example:1")
        self.assertEqual(pool.pick_least_loaded({a: 1}), b)  # 换完 token 释放预占

    def test_start_without_pool_has_no_proxy(self) -> None:
        pool = ProxyPoolService(None)
        with patch("services.proxy_pool_service.proxy_pool", pool):
            service = OAuthLoginService()
            started = service.start()
        self.assertEqual(service._sessions[started["session_id"]]["proxy_id"], "")


class SolverClientTests(unittest.TestCase):
    def make_service(self) -> SentinelSolverService:
        service = SentinelSolverService()
        service.settings = lambda: {"enabled": True, "url": "http://solver:8788", "key": "k"}
        return service

    def call(self, proxy: str, reply: dict) -> dict:
        captured: dict = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return json.dumps(reply).encode()

        def fake_urlopen(request, timeout=None):
            captured["body"] = json.loads(request.data.decode())
            return FakeResponse()

        with (
            patch("services.sentinel_solver_service.urllib.request.urlopen", fake_urlopen),
            patch("services.sentinel_solver_service.logger") as logger,
        ):
            captured["token"] = self.make_service().solve_turnstile({"turnstile": {}}, "p", proxy=proxy)
            captured["warnings"] = [call.args[0].get("event") for call in logger.warning.call_args_list]
        return captured

    def test_proxy_is_sent_only_when_set(self) -> None:
        with_proxy = self.call("http://u:p@a.example:1", {"ok": True, "turnstile": "T", "lane": "proxy"})
        self.assertEqual(with_proxy["body"]["proxy"], "http://u:p@a.example:1")
        self.assertEqual((with_proxy["token"], with_proxy["warnings"]), ("T", []))
        without = self.call("", {"ok": True, "turnstile": "T"})
        self.assertNotIn("proxy", without["body"])

    def test_old_solver_ignoring_proxy_is_logged(self) -> None:
        result = self.call("http://a.example:1", {"ok": True, "turnstile": "T"})
        self.assertEqual(result["token"], "T")
        self.assertIn("sentinel_solver_lane_mismatch", result["warnings"])


if __name__ == "__main__":
    unittest.main()
