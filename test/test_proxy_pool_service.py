"""代理池：条目存储、健康滞回、分配/借用/轮询，以及出口解析的优先级。"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from curl_cffi.requests.exceptions import ConnectionError as CurlConnectionError
from curl_cffi.requests.exceptions import ProxyError, RequestException, Timeout

from services.config import DEFAULT_PROXY_RUNTIME
from services.proxy_pool_service import (
    ProxyPoolService,
    account_route_key,
    canonical_proxy_url,
    classify_transport_error,
    mask_proxy_url,
)
from services.proxy_service import ProxySettingsStore

GLOBAL_PROXY = "http://global.example:8080"


def ok_probe(url: str, timeout: float) -> dict:
    return {"ok": True, "status": 200, "latency_ms": 5, "error": None, "exit_ip": "1.2.3.4"}


def make_pool(tmp: str | None = None, *, enabled: bool = True, urls: list[str] | None = None) -> ProxyPoolService:
    store = Path(tmp) / "proxy_pool.json" if tmp else None
    pool = ProxyPoolService(store, probe_func=ok_probe)
    if urls:
        pool.add_entries(urls)
    if enabled:
        pool.update_settings({"enabled": True})
    return pool


def ids(pool: ProxyPoolService) -> list[str]:
    return [entry["id"] for entry in pool.list_entries()]


def mark_unhealthy(pool: ProxyPoolService, proxy_id: str) -> None:
    for _ in range(pool.settings()["failure_threshold"]):
        pool.record_failure(proxy_id, "connect refused")


class CanonicalUrlTests(unittest.TestCase):
    def test_scheme_host_lowercased_and_default_port_filled(self) -> None:
        self.assertEqual(canonical_proxy_url("HTTP://Proxy.Example"), "http://proxy.example:80")
        self.assertEqual(canonical_proxy_url("socks5://h.example"), "socks5h://h.example:1080")
        self.assertEqual(canonical_proxy_url("h.example:3128"), "http://h.example:3128")

    def test_colon_format_with_credentials(self) -> None:
        self.assertEqual(canonical_proxy_url("h.example:8000:user:pa ss"), "http://user:pa%20ss@h.example:8000")

    def test_invalid_urls_return_empty(self) -> None:
        for raw in ("", "ftp://h.example:21", "not a proxy", "http://"):
            with self.subTest(raw=raw):
                self.assertEqual(canonical_proxy_url(raw), "")

    def test_mask_hides_password(self) -> None:
        masked = mask_proxy_url("http://customer-abc:secret@h.example:8000")
        self.assertNotIn("secret", masked)
        self.assertIn("h.example:8000", masked)


class StoreTests(unittest.TestCase):
    def test_add_dedupes_but_keeps_different_credentials_apart(self) -> None:
        pool = make_pool(enabled=False)
        result = pool.add_entries([
            "http://u1:p@h.example:8000",
            "http://u2:p@h.example:8000",
            "HTTP://u1:p@H.EXAMPLE:8000",
            "garbage",
            "# comment",
        ])
        self.assertEqual(len(result["added"]), 2)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(len(result["errors"]), 1)

    def test_persistence_and_stable_id_on_url_edit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pool = make_pool(tmp, urls=["http://a.example:1"])
            proxy_id = ids(pool)[0]
            pool.update_entry(proxy_id, {"url": "http://user:new@a.example:1", "name": "主力"})

            reloaded = ProxyPoolService(Path(tmp) / "proxy_pool.json")
            entry = reloaded.get_entry(proxy_id)
            self.assertEqual(entry["url"], "http://user:new@a.example:1")
            self.assertEqual(entry["name"], "主力")
            self.assertTrue(reloaded.is_enabled())
            raw = json.loads((Path(tmp) / "proxy_pool.json").read_text(encoding="utf-8"))
            self.assertEqual(raw["proxies"][0]["id"], proxy_id)

    def test_edit_rejects_duplicate_or_invalid_url(self) -> None:
        pool = make_pool(urls=["http://a.example:1", "http://b.example:1"])
        a, _b = ids(pool)
        with self.assertRaises(ValueError):
            pool.update_entry(a, {"url": "http://b.example:1"})
        with self.assertRaises(ValueError):
            pool.update_entry(a, {"url": "nope"})
        with self.assertRaises(KeyError):
            pool.update_entry("px_missing", {"name": "x"})

    def test_ensure_entry_reuses_existing(self) -> None:
        pool = make_pool(urls=["socks5://h.example:1080"])
        self.assertEqual(pool.ensure_entry("socks5h://H.example:1080"), ids(pool)[0])
        self.assertEqual(len(pool.list_entries()), 1)
        self.assertEqual(pool.ensure_entry("bad url"), "")


class HealthTests(unittest.TestCase):
    def test_hysteresis(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        proxy_id = ids(pool)[0]
        pool.record_failure(proxy_id, "e1")
        pool.record_failure(proxy_id, "e2")
        self.assertNotEqual(pool.health(proxy_id)["state"], "unhealthy")
        pool.record_failure(proxy_id, "e3")
        self.assertEqual(pool.health(proxy_id)["state"], "unhealthy")
        pool.record_success(proxy_id)
        self.assertEqual(pool.health(proxy_id)["state"], "unhealthy")
        pool.record_success(proxy_id)
        self.assertEqual(pool.health(proxy_id)["state"], "healthy")

    def test_success_resets_failure_streak(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        proxy_id = ids(pool)[0]
        pool.record_failure(proxy_id, "e1")
        pool.record_failure(proxy_id, "e2")
        pool.record_success(proxy_id)
        pool.record_failure(proxy_id, "e3")
        self.assertEqual(pool.health(proxy_id)["state"], "healthy")

    def test_url_edit_resets_health(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        proxy_id = ids(pool)[0]
        mark_unhealthy(pool, proxy_id)
        pool.update_entry(proxy_id, {"url": "http://a.example:2"})
        self.assertEqual(pool.health(proxy_id)["state"], "unknown")

    def test_probe_records_exit_ip_and_failure(self) -> None:
        results = iter([
            {"ok": False, "status": 0, "latency_ms": 1, "error": "refused http://u:secret@a.example:1", "exit_ip": None},
            {"ok": True, "status": 200, "latency_ms": 9, "error": None, "exit_ip": "9.9.9.9"},
        ])
        pool = ProxyPoolService(None, probe_func=lambda url, timeout: next(results))
        pool.add_entries(["http://a.example:1"])
        proxy_id = ids(pool)[0]
        pool.probe(proxy_id)
        self.assertNotIn("secret", pool.health(proxy_id)["last_error"])
        pool.probe(proxy_id)
        health = pool.health(proxy_id)
        self.assertEqual(health["exit_ip"], "9.9.9.9")
        self.assertEqual(health["latency_ms"], 9)
        self.assertIsNotNone(health["last_probe_at"])

    def test_probe_due_skips_disabled_and_recent(self) -> None:
        calls: list[str] = []
        pool = ProxyPoolService(None, probe_func=lambda url, timeout: calls.append(url) or ok_probe(url, timeout))
        pool.add_entries(["http://a.example:1", "http://b.example:1"])
        pool.update_entry(ids(pool)[1], {"enabled": False})
        self.assertEqual(pool.probe_due(), 1)
        self.assertEqual(pool.probe_due(), 0)
        self.assertEqual(calls, ["http://a.example:1"])


class ClassifyTests(unittest.TestCase):
    def test_proxy_level_errors(self) -> None:
        self.assertEqual(classify_transport_error(ProxyError("Could not resolve proxy", 5)), "proxy")
        self.assertEqual(classify_transport_error(ProxyError("SOCKS handshake failed", 97)), "proxy")
        self.assertEqual(classify_transport_error(CurlConnectionError("Failed to connect to p port 1", 7)), "proxy")
        self.assertEqual(classify_transport_error(ProxyError("CONNECT tunnel failed, response 407", 56)), "proxy")
        # stream 路径抛的是裸 RequestException，也要靠 code 识别
        self.assertEqual(classify_transport_error(RequestException("Failed to connect", 7)), "proxy")
        self.assertEqual(classify_transport_error(Timeout("Connection timed out after 10001 ms", 28)), "proxy")

    def test_soft_and_neutral(self) -> None:
        self.assertEqual(classify_transport_error(RequestException("Recv failure", 56)), "soft")
        self.assertEqual(classify_transport_error(RequestException("Empty reply", 52)), "soft")
        body_timeout = Timeout("Operation timed out after 30000 ms with 120 bytes received", 28,
                               SimpleNamespace(status_code=0, primary_ip="10.0.0.1"))
        self.assertEqual(classify_transport_error(body_timeout), "neutral")
        self.assertEqual(classify_transport_error(RequestException("HTTP 403", 0)), "neutral")
        self.assertEqual(classify_transport_error(ValueError("boom")), "neutral")
        with_headers = RequestException("Recv failure", 56, SimpleNamespace(status_code=200, primary_ip="1.1.1.1"))
        self.assertEqual(classify_transport_error(with_headers), "neutral")


class TrackSessionTests(unittest.TestCase):
    class FakeSession:
        def __init__(self, error: Exception | None = None) -> None:
            self.error = error

        def request(self, method: str, url: str, **kwargs):
            if self.error:
                raise self.error
            return SimpleNamespace(status_code=200)

        def get(self, url: str, **kwargs):
            return self.request("GET", url, **kwargs)

        def post(self, url: str, **kwargs):
            return self.request("POST", url, **kwargs)

    def test_failures_and_successes_are_recorded_through_get_and_post(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        proxy_id = ids(pool)[0]
        profile = SimpleNamespace(proxy_id=proxy_id)
        failing = pool.track_session(self.FakeSession(ProxyError("refused", 7)), profile)
        for call in (failing.get, failing.post, failing.get):
            with self.assertRaises(ProxyError):
                call("https://chatgpt.com/")
        self.assertEqual(pool.health(proxy_id)["state"], "unhealthy")

        working = pool.track_session(self.FakeSession(), profile)
        working.get("https://chatgpt.com/")
        working.post("https://chatgpt.com/")
        self.assertEqual(pool.health(proxy_id)["state"], "healthy")

    def test_upstream_http_errors_do_not_count(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        proxy_id = ids(pool)[0]
        session = pool.track_session(self.FakeSession(RequestException("HTTP 403", 0)), SimpleNamespace(proxy_id=proxy_id))
        for _ in range(5):
            with self.assertRaises(RequestException):
                session.get("https://chatgpt.com/")
        self.assertEqual(pool.health(proxy_id)["consecutive_failures"], 0)

    def test_non_pool_profiles_are_left_alone(self) -> None:
        pool = make_pool(urls=["http://a.example:1"])
        session = self.FakeSession()
        original = session.request
        pool.track_session(session, SimpleNamespace(proxy_id=""))
        self.assertEqual(session.request, original)


class RoutingTests(unittest.TestCase):
    def test_least_loaded_skips_disabled_and_unhealthy(self) -> None:
        pool = make_pool(urls=["http://a.example:1", "http://b.example:1", "http://c.example:1"])
        a, b, c = ids(pool)
        self.assertEqual(pool.pick_least_loaded({a: 3, b: 1, c: 2}), b)
        pool.update_entry(b, {"enabled": False})
        self.assertEqual(pool.pick_least_loaded({a: 3, b: 1, c: 2}), c)
        mark_unhealthy(pool, c)
        self.assertEqual(pool.pick_least_loaded({a: 3, b: 1, c: 2}), a)
        # 全部异常时仍在已启用的里面挑，不返回空
        mark_unhealthy(pool, a)
        self.assertIn(pool.pick_least_loaded({}), {a, c})

    def test_reservations_count_as_load(self) -> None:
        pool = make_pool(urls=["http://a.example:1", "http://b.example:1"])
        a, b = ids(pool)
        pool.reserve(a)
        self.assertEqual(pool.pick_least_loaded({}), b)
        pool.release(a)
        pool.reserve(b)
        self.assertEqual(pool.pick_least_loaded({}), a)

    def test_bound_route_borrows_stably_and_only_for_failed_primary(self) -> None:
        pool = make_pool(urls=[f"http://p{i}.example:1" for i in range(5)])
        all_ids = ids(pool)
        primary = all_ids[0]
        entry, route = pool.route_bound(primary, "user_id:u1")
        self.assertEqual((entry["id"], route), (primary, "bound"))

        mark_unhealthy(pool, primary)
        first, route = pool.route_bound(primary, "user_id:u1")
        self.assertEqual(route, "borrowed")
        self.assertNotEqual(first["id"], primary)
        for _ in range(5):
            self.assertEqual(pool.route_bound(primary, "user_id:u1")[0]["id"], first["id"])
        # 其他账号的主代理不受影响
        self.assertEqual(pool.route_bound(all_ids[1], "user_id:u2")[1], "bound")

        pool.record_success(primary)
        pool.record_success(primary)
        self.assertEqual(pool.route_bound(primary, "user_id:u1")[0]["id"], primary)

    def test_disabled_primary_borrows_and_nothing_left_keeps_primary(self) -> None:
        pool = make_pool(urls=["http://a.example:1", "http://b.example:1"])
        a, b = ids(pool)
        pool.update_entry(a, {"enabled": False})
        self.assertEqual(pool.route_bound(a, "k")[0]["id"], b)
        # 唯一可借的也异常：已启用的主代理照用，绝不直连
        pool.update_entry(a, {"enabled": True})
        mark_unhealthy(pool, a)
        mark_unhealthy(pool, b)
        self.assertEqual(pool.route_bound(a, "k"), (pool.get_entry(a), "bound"))
        # 全部禁用：交给旧链路
        pool.update_entry(a, {"enabled": False})
        pool.update_entry(b, {"enabled": False})
        self.assertEqual(pool.route_bound(a, "k"), (None, ""))

    def test_anonymous_round_robin_over_usable(self) -> None:
        pool = make_pool(urls=["http://a.example:1", "http://b.example:1", "http://c.example:1"])
        a, b, c = ids(pool)
        mark_unhealthy(pool, b)
        picked = [pool.route_anonymous()[0]["id"] for _ in range(4)]
        self.assertEqual(set(picked), {a, c})
        self.assertNotEqual(picked[0], picked[1])

    def test_account_route_key_prefers_stable_fields(self) -> None:
        self.assertEqual(account_route_key({"user_id": "U", "email": "e@x", "access_token": "t"}), "user_id:u")
        self.assertEqual(account_route_key({"email": "E@x"}), "email:e@x")
        self.assertTrue(account_route_key({"access_token": "a.b.c"}).startswith("token:"))
        self.assertEqual(account_route_key({}), "")


class FakeConfig:
    def __init__(self, legacy_proxy: str = GLOBAL_PROXY) -> None:
        self.legacy_proxy = legacy_proxy

    def get_proxy_settings(self) -> str:
        return self.legacy_proxy

    def get_proxy_runtime_settings(self) -> dict:
        return copy.deepcopy(DEFAULT_PROXY_RUNTIME)


class ResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pool = make_pool(urls=["http://a.example:1", "http://b.example:1"])
        self.a, self.b = ids(self.pool)
        self.store = ProxySettingsStore(FakeConfig(), pool_provider=lambda: self.pool)

    def test_bound_account_uses_its_proxy_for_upstream_only(self) -> None:
        account = {"access_token": "t", "proxy_id": self.b, "proxy": "http://legacy.example:1"}
        profile = self.store.get_profile(account=account, upstream=True)
        self.assertEqual((profile.proxy_url, profile.proxy_source, profile.proxy_id, profile.pool_route),
                         ("http://b.example:1", "pool", self.b, "bound"))
        # 非上游流量不走池
        self.assertEqual(self.store.get_profile(account={}, upstream=False).proxy_url, GLOBAL_PROXY)
        kwargs = self.store.build_session_kwargs(account=account, upstream=True, impersonate="chrome")
        self.assertEqual(kwargs["proxy"], "http://b.example:1")

    def test_pool_disabled_keeps_legacy_behaviour(self) -> None:
        self.pool.update_settings({"enabled": False})
        account = {"access_token": "t", "proxy_id": self.b, "proxy": "http://legacy.example:1"}
        self.assertEqual(self.store.get_profile(account=account, upstream=True).proxy_url, "http://legacy.example:1")
        self.assertEqual(self.store.get_profile(upstream=True).proxy_url, GLOBAL_PROXY)
        no_pool = ProxySettingsStore(FakeConfig())
        self.assertEqual(no_pool.get_profile(account=account, upstream=True).proxy_url, "http://legacy.example:1")

    def test_anonymous_round_robin_and_use_pool_false(self) -> None:
        urls = {self.store.get_profile(upstream=True).proxy_url for _ in range(4)}
        self.assertEqual(urls, {"http://a.example:1", "http://b.example:1"})
        self.assertEqual(self.store.get_profile(upstream=True, use_pool=False).proxy_url, GLOBAL_PROXY)

    def test_explicit_proxy_id_wins_for_oauth(self) -> None:
        profile = self.store.get_profile(upstream=True, proxy_id=self.a)
        self.assertEqual((profile.proxy_id, profile.pool_route), (self.a, "bound"))

    def test_unbound_account_is_bound_through_the_binder(self) -> None:
        calls: list[str] = []

        def binder(account: dict) -> str:
            calls.append(account["access_token"])
            return self.b

        self.store.set_account_binder(binder)
        profile = self.store.get_profile(account={"access_token": "new", "proxy_id": "px_gone"}, upstream=True)
        self.assertEqual(calls, ["new"])
        self.assertEqual(profile.proxy_id, self.b)

    def test_no_enabled_proxy_falls_back_to_legacy_chain(self) -> None:
        self.pool.update_entry(self.a, {"enabled": False})
        self.pool.update_entry(self.b, {"enabled": False})
        profile = self.store.get_profile(account={"access_token": "t", "proxy_id": self.a}, upstream=True)
        self.assertEqual((profile.proxy_url, profile.proxy_source), (GLOBAL_PROXY, "global"))
        self.assertEqual(self.store.get_profile(upstream=True).proxy_source, "global")

    def test_track_session_only_for_pool_profiles(self) -> None:
        profile = self.store.get_profile(account={"access_token": "t", "proxy_id": self.a}, upstream=True)
        session = TrackSessionTests.FakeSession(ProxyError("refused", 7))
        self.store.track_session(session, profile)
        with self.assertRaises(ProxyError):
            session.get("https://chatgpt.com/")
        self.assertEqual(self.pool.health(self.a)["consecutive_failures"], 1)


if __name__ == "__main__":
    unittest.main()
