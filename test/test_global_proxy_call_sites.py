"""全局代理接线：各出站调用点都要按「账号 > 稳定代理 > 显式 > 全局」解析代理，并遵守回环地址直连规则。"""

from __future__ import annotations

import copy
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services import cpa_service, sub2api_service
from services.account_service import AccountService
from services.backup_service import CloudflareR2Client
from services.config import DEFAULT_PROXY_RUNTIME
from services.content_filter import check_request
from services.image_storage_service import WebDAVClient
from services.means_storage_service import MeansStorageService
from services.oauth_login_service import OAuthLoginService
from services.proxy_service import ProxySettingsStore
from services.storage.git_storage import GitStorageBackend

GLOBAL_PROXY = "http://global.example:8080"
RUNTIME_PROXY = "http://runtime.example:8080"
ACCOUNT_PROXY = "socks5://account.example:1080"
ACCOUNT_PROXY_NORMALIZED = "socks5h://account.example:1080"
LOOPBACK_URL = "http://127.0.0.1:5178/s3/"


class FakeConfig:
    def __init__(self, legacy_proxy: str, runtime: dict[str, object]) -> None:
        self.legacy_proxy = legacy_proxy
        self.runtime = runtime

    def get_proxy_settings(self) -> str:
        return self.legacy_proxy

    def get_proxy_runtime_settings(self) -> dict[str, object]:
        return copy.deepcopy(self.runtime)


def make_store(
    legacy_proxy: str = GLOBAL_PROXY,
    runtime_proxy: str = "",
    skip_ssl_verify: bool = False,
) -> ProxySettingsStore:
    runtime = copy.deepcopy(DEFAULT_PROXY_RUNTIME)
    if runtime_proxy:
        runtime.update(
            enabled=True,
            egress_mode="single_proxy",
            proxy_url=runtime_proxy,
            skip_ssl_verify=skip_ssl_verify,
        )
    return ProxySettingsStore(FakeConfig(legacy_proxy, runtime))


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])

    def load_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


class MeansProxyTests(unittest.TestCase):
    @staticmethod
    def put_kwargs(store: ProxySettingsStore, endpoint: str = "https://means.example.test/s3/", **overrides: object) -> dict[str, Any]:
        settings = {
            "enabled": True,
            "endpoint": endpoint,
            "access_key": "access",
            "secret_key": "secret",
            "bucket": "images",
            "timeout_seconds": 60,
            "verify_ssl": True,
            **overrides,
        }
        service = MeansStorageService()
        with (
            patch.object(service, "settings", return_value=settings),
            patch("services.means_storage_service.proxy_settings", store),
            patch(
                "services.means_storage_service.requests.put",
                return_value=SimpleNamespace(status_code=200, text=""),
            ) as put,
        ):
            service.upload(b"png-data")
        return put.call_args.kwargs

    def test_remote_endpoint_uses_global_proxy_not_runtime_proxy(self) -> None:
        kwargs = self.put_kwargs(make_store(runtime_proxy=RUNTIME_PROXY))

        self.assertEqual(kwargs["proxy"], GLOBAL_PROXY)
        self.assertIs(kwargs["verify"], True)

    def test_loopback_endpoint_stays_direct(self) -> None:
        self.assertNotIn("proxy", self.put_kwargs(make_store(), endpoint=LOOPBACK_URL))

    def test_no_proxy_is_sent_when_none_is_configured(self) -> None:
        self.assertNotIn("proxy", self.put_kwargs(make_store(legacy_proxy="")))

    def test_verify_ssl_setting_is_not_overridden_by_runtime_skip_ssl_verify(self) -> None:
        store = make_store(runtime_proxy=RUNTIME_PROXY, skip_ssl_verify=True)

        self.assertIs(self.put_kwargs(store)["verify"], True)
        self.assertIs(self.put_kwargs(store, verify_ssl=False)["verify"], False)


class StorageClientProxyTests(unittest.TestCase):
    def test_webdav_session_uses_global_proxy_except_for_loopback(self) -> None:
        for url, expected in (
            ("https://dav.example.test/remote.php/dav/", GLOBAL_PROXY),
            ("http://127.0.0.1:5005/dav", None),
            ("http://localhost:5005/dav", None),
        ):
            with self.subTest(url=url):
                with (
                    patch("services.image_storage_service.proxy_settings", make_store()),
                    patch("services.image_storage_service.requests.Session") as session_cls,
                ):
                    WebDAVClient({"webdav_url": url})
                self.assertEqual(session_cls.call_args.kwargs.get("proxy"), expected)

    def test_r2_session_uses_global_proxy_and_keeps_tls_verification(self) -> None:
        store = make_store(runtime_proxy=RUNTIME_PROXY, skip_ssl_verify=True)

        with (
            patch("services.backup_service.proxy_settings", store),
            patch("services.backup_service.requests.Session") as session_cls,
        ):
            CloudflareR2Client({"account_id": "acc", "bucket": "bk"})

        kwargs = session_cls.call_args.kwargs
        self.assertEqual(kwargs["proxy"], GLOBAL_PROXY)
        self.assertEqual(kwargs["impersonate"], "chrome")
        self.assertIs(kwargs["verify"], True)


class Sub2APIProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        response = MagicMock()
        response.ok = True
        response.status_code = 200
        response.text = "{}"
        response.json.return_value = {
            "code": 0,
            "data": {"items": [], "accounts": [], "access_token": "token", "expires_in": 3600},
        }
        self.session = MagicMock()
        self.session.get.return_value = response
        self.session.post.return_value = response

    def session_kwargs(self, base_url: str) -> dict[str, dict[str, Any]]:
        server = {"base_url": base_url, "api_key": "key"}
        calls = {
            "login": lambda: sub2api_service._login(base_url, "admin@example.test", "secret"),
            "accounts": lambda: sub2api_service.list_remote_accounts(server),
            "groups": lambda: sub2api_service.list_remote_groups(server),
            "export": lambda: sub2api_service._fetch_access_tokens_for_accounts(server, ["1"]),
        }
        result: dict[str, dict[str, Any]] = {}
        for name, call in calls.items():
            with (
                patch("services.sub2api_service.proxy_settings", make_store()),
                patch("services.sub2api_service.Session", return_value=self.session) as session_cls,
            ):
                call()
            result[name] = session_cls.call_args.kwargs
        return result

    def test_every_sub2api_request_uses_global_proxy(self) -> None:
        for name, kwargs in self.session_kwargs("https://sub2api.example.test").items():
            with self.subTest(call=name):
                self.assertEqual(kwargs["proxy"], GLOBAL_PROXY)
                self.assertIs(kwargs["verify"], True)

    def test_loopback_sub2api_server_stays_direct(self) -> None:
        for name, kwargs in self.session_kwargs("http://127.0.0.1:8080").items():
            with self.subTest(call=name):
                self.assertNotIn("proxy", kwargs)


class AccountProxyTests(unittest.TestCase):
    @staticmethod
    def refresh_kwargs(store: ProxySettingsStore, account: dict[str, Any]) -> dict[str, Any]:
        response = MagicMock(status_code=200, text='{"access_token":"new"}')
        response.json.return_value = {"access_token": "new"}
        session = MagicMock()
        session.post.return_value = response
        with (
            patch("curl_cffi.requests.Session", return_value=session) as session_cls,
            patch("services.proxy_service.proxy_settings", store),
        ):
            AccountService(MemoryStorage())._request_access_token_refresh("refresh-token", account)
        return session_cls.call_args.kwargs

    def test_token_refresh_follows_account_then_runtime_then_global_proxy(self) -> None:
        both = make_store(runtime_proxy=RUNTIME_PROXY)

        self.assertEqual(self.refresh_kwargs(both, {"proxy": ACCOUNT_PROXY})["proxy"], ACCOUNT_PROXY_NORMALIZED)
        self.assertEqual(self.refresh_kwargs(both, {})["proxy"], RUNTIME_PROXY)
        self.assertEqual(self.refresh_kwargs(make_store(), {})["proxy"], GLOBAL_PROXY)

    def test_password_login_uses_account_proxy_and_global_fallback(self) -> None:
        service = AccountService(MemoryStorage())
        for label, account, expected in (
            ("account", {"proxy": ACCOUNT_PROXY}, ACCOUNT_PROXY_NORMALIZED),
            ("global", None, GLOBAL_PROXY),
        ):
            with self.subTest(label):
                session = MagicMock()
                session.get.return_value = SimpleNamespace(status_code=500, url="https://auth.openai.com/x", text="boom")
                with (
                    patch("curl_cffi.requests.Session", return_value=session) as session_cls,
                    patch("services.proxy_service.proxy_settings", make_store()),
                ):
                    result = service._login_with_password("user@example.test", "password", account)

                self.assertEqual(result["error"], "authorize_failed_500")
                kwargs = session_cls.call_args.kwargs
                self.assertEqual(kwargs["proxy"], expected)
                self.assertEqual(kwargs["impersonate"], "chrome110")
                self.assertIs(kwargs["verify"], False)

    def test_password_relogin_thread_hands_the_stored_account_to_the_login(self) -> None:
        service = AccountService(MemoryStorage([{"access_token": "stored-token", "proxy": ACCOUNT_PROXY}]))

        with (
            patch.object(service, "_login_with_password", side_effect=RuntimeError("stop")) as login,
            patch.object(service, "remove_invalid_token"),
            patch("services.account_service.log_service"),
        ):
            service._password_re_login_thread("stored-token", "user@example.test", "password", "test")

        login.assert_called_once()
        self.assertEqual(login.call_args.args[2]["proxy"], ACCOUNT_PROXY)


class OAuthProxyTests(unittest.TestCase):
    def test_code_exchange_follows_runtime_then_global_proxy(self) -> None:
        response = SimpleNamespace(
            status_code=200,
            text="{}",
            json=lambda: {"access_token": "access", "refresh_token": "refresh", "id_token": "id"},
        )
        for label, store, expected in (
            ("runtime", make_store(runtime_proxy=RUNTIME_PROXY), RUNTIME_PROXY),
            ("global", make_store(), GLOBAL_PROXY),
        ):
            with self.subTest(label):
                with (
                    patch("services.oauth_login_service.proxy_settings", store),
                    patch("services.oauth_login_service.requests.Session") as session_cls,
                ):
                    session_cls.return_value.post.return_value = response
                    OAuthLoginService._exchange_code("code", "verifier", "http://localhost/callback")

                self.assertEqual(session_cls.call_args.kwargs["proxy"], expected)


class AdminEndpointProxyTests(unittest.TestCase):
    """CPA、AI 审核这类管理员配置的服务端点：全局代理 + 回环直连。"""

    def test_cpa_requests_use_global_proxy_except_for_loopback(self) -> None:
        response = MagicMock()
        response.ok = True
        response.json.return_value = {"files": []}
        calls = {
            "list": lambda pool: cpa_service.list_remote_files(pool),
            "download": lambda pool: cpa_service.fetch_remote_access_token(pool, "a.json"),
        }
        for base_url, expected in (("https://cpa.example.test", GLOBAL_PROXY), ("http://127.0.0.1:8317", None)):
            for name, call in calls.items():
                with self.subTest(base_url=base_url, call=name):
                    session = MagicMock()
                    session.get.return_value = response
                    with (
                        patch("services.cpa_service.proxy_settings", make_store()),
                        patch("services.cpa_service.Session", return_value=session) as session_cls,
                    ):
                        call({"base_url": base_url, "secret_key": "secret"})

                    self.assertEqual(session_cls.call_args.kwargs.get("proxy"), expected)

    def test_ai_review_request_uses_global_proxy_except_for_loopback(self) -> None:
        response = MagicMock(status_code=200)
        response.json.return_value = {"choices": [{"message": {"content": "ALLOW"}}]}
        for base_url, expected in (("https://review.example.test", GLOBAL_PROXY), ("http://127.0.0.1:9000", None)):
            with self.subTest(base_url=base_url):
                review = {"enabled": True, "base_url": base_url, "api_key": "key", "model": "judge"}
                with (
                    patch("services.content_filter.config", SimpleNamespace(sensitive_words=[], ai_review=review)),
                    patch("services.content_filter.proxy_settings", make_store()),
                    patch("services.content_filter.requests.post", return_value=response) as post,
                ):
                    check_request("draw a cat")

                self.assertEqual(post.call_args.kwargs.get("proxy"), expected)


class GitStorageProxyTests(unittest.TestCase):
    ENV_KEYS = ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")

    def make_backend(self, repo_url: str = "https://git.example.test/team/repo.git") -> GitStorageBackend:
        cache = tempfile.TemporaryDirectory()
        self.addCleanup(cache.cleanup)
        return GitStorageBackend(repo_url, "token", local_cache_dir=Path(cache.name))

    def test_proxy_env_follows_global_proxy(self) -> None:
        backend = self.make_backend()

        with patch("services.proxy_service.proxy_settings", make_store()):
            env = backend._proxy_env()

        self.assertEqual(env, {key: GLOBAL_PROXY for key in self.ENV_KEYS})

    def test_proxy_env_is_empty_without_proxy_or_for_loopback_repo(self) -> None:
        with patch("services.proxy_service.proxy_settings", make_store(legacy_proxy="")):
            self.assertEqual(self.make_backend()._proxy_env(), {})
        with patch("services.proxy_service.proxy_settings", make_store()):
            self.assertEqual(self.make_backend("http://127.0.0.1:3000/team/repo.git")._proxy_env(), {})

    def test_clone_receives_proxy_environment(self) -> None:
        backend = self.make_backend()

        with (
            patch("services.proxy_service.proxy_settings", make_store()),
            patch("services.storage.git_storage.Repo") as repo_cls,
        ):
            backend._clone_or_pull()

        self.assertEqual(repo_cls.clone_from.call_args.kwargs["env"], {key: GLOBAL_PROXY for key in self.ENV_KEYS})

    def test_pull_runs_inside_proxy_environment(self) -> None:
        backend = self.make_backend()
        (backend.local_cache_dir / "repo" / ".git").mkdir(parents=True)
        repo = MagicMock()

        with (
            patch("services.proxy_service.proxy_settings", make_store()),
            patch("services.storage.git_storage.Repo", return_value=repo),
        ):
            backend._clone_or_pull()

        repo.git.custom_environment.assert_called_once_with(**{key: GLOBAL_PROXY for key in self.ENV_KEYS})
        repo.remote.return_value.pull.assert_called_once_with("main")

    def test_push_runs_inside_proxy_environment(self) -> None:
        backend = self.make_backend()
        repo = MagicMock()
        repo.working_dir = str(backend.local_cache_dir)
        repo.is_dirty.return_value = True

        with (
            patch("services.proxy_service.proxy_settings", make_store()),
            patch.object(backend, "_clone_or_pull", return_value=repo),
        ):
            backend.save_accounts([])

        repo.git.custom_environment.assert_called_once_with(**{key: GLOBAL_PROXY for key in self.ENV_KEYS})
        repo.remote.return_value.push.assert_called_once_with("main")


if __name__ == "__main__":
    unittest.main()
