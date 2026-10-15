"""账号与代理池的粘性绑定：分配、并发、迁移、删除改绑、导入转换。"""

from __future__ import annotations

import os
import threading
import unittest
from typing import Any
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.account_service import AccountService
from services.proxy_pool_service import ProxyPoolService


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])
        self.saves = 0

    def load_accounts(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.accounts]

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.saves += 1
        self.accounts = [dict(item) for item in accounts]


def make_pool(*urls: str, enabled: bool = True) -> ProxyPoolService:
    pool = ProxyPoolService(None, probe_func=lambda url, timeout: {"ok": True})
    pool.add_entries(list(urls))
    if enabled:
        pool.update_settings({"enabled": True})
    return pool


def make_service(pool: ProxyPoolService, accounts: list[dict[str, Any]] | None = None) -> tuple[AccountService, MemoryStorage]:
    storage = MemoryStorage(accounts)
    service = AccountService(storage)
    service._proxy_pool = pool
    return service, storage


def stored(storage: MemoryStorage, token: str) -> dict[str, Any]:
    return next(item for item in storage.accounts if item["access_token"] == token)


class _HermeticCase(unittest.TestCase):
    def setUp(self) -> None:
        for target in ("services.account_service.log_service",):
            patcher = patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(AccountService, "_save_cumulative_total")
        patcher.start()
        self.addCleanup(patcher.stop)


class BindingTests(_HermeticCase):
    def test_concurrent_first_requests_produce_one_binding(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1", "http://c.example:1")
        service, storage = make_service(pool, [{"access_token": "t1"}])
        results: list[str] = []
        barrier = threading.Barrier(8)

        def worker() -> None:
            barrier.wait()
            results.append(service.ensure_proxy_binding("t1"))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(stored(storage, "t1")["proxy_id"], results[0])

    def test_bind_unbound_spreads_evenly_and_keeps_existing(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1", "http://c.example:1")
        a, b, c = [entry["id"] for entry in pool.list_entries()]
        accounts = [{"access_token": f"t{i}"} for i in range(9)] + [{"access_token": "fixed", "proxy_id": a}]
        service, storage = make_service(pool, accounts)
        self.assertEqual(service.bind_unbound_accounts(), 9)
        counts = service.proxy_binding_counts()
        self.assertEqual(sorted(counts.values()), [3, 3, 4])
        self.assertEqual(stored(storage, "fixed")["proxy_id"], a)
        # 再跑一次不改任何绑定
        before = {item["access_token"]: item["proxy_id"] for item in storage.accounts}
        self.assertEqual(service.bind_unbound_accounts(), 0)
        self.assertEqual(before, {item["access_token"]: item["proxy_id"] for item in storage.accounts})

    def test_new_proxy_does_not_move_existing_bindings(self) -> None:
        pool = make_pool("http://a.example:1")
        a = pool.list_entries()[0]["id"]
        service, storage = make_service(pool, [{"access_token": f"t{i}"} for i in range(4)])
        service.bind_unbound_accounts()
        pool.add_entries(["http://b.example:1"])
        self.assertEqual(service.bind_unbound_accounts(), 0)
        self.assertTrue(all(item["proxy_id"] == a for item in storage.accounts))
        service.add_accounts(["new-1", "new-2"])
        b = pool.list_entries()[1]["id"]
        self.assertEqual(stored(storage, "new-1")["proxy_id"], b)
        self.assertEqual(stored(storage, "new-2")["proxy_id"], b)

    def test_delete_reassigns_to_least_loaded_and_clears_when_empty(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1", "http://c.example:1")
        a, b, c = [entry["id"] for entry in pool.list_entries()]
        accounts = (
            [{"access_token": f"a{i}", "proxy_id": a} for i in range(4)]
            + [{"access_token": f"b{i}", "proxy_id": b} for i in range(3)]
            + [{"access_token": "c0", "proxy_id": c}]
        )
        service, storage = make_service(pool, accounts)
        pool.delete_entry(a)
        self.assertEqual(service.reassign_proxy_bindings(a), 4)
        counts = service.proxy_binding_counts()
        self.assertNotIn(a, counts)
        self.assertEqual(counts, {b: 4, c: 4})

        pool.delete_entry(b)
        pool.delete_entry(c)
        service.reassign_proxy_bindings(b)
        service.reassign_proxy_bindings(c)
        self.assertTrue(all(item["proxy_id"] == "" for item in storage.accounts))

    def test_dangling_binding_is_rebound(self) -> None:
        pool = make_pool("http://a.example:1")
        a = pool.list_entries()[0]["id"]
        service, storage = make_service(pool, [{"access_token": "t", "proxy_id": "px_gone"}])
        self.assertEqual(service.ensure_proxy_binding("t"), a)
        self.assertEqual(stored(storage, "t")["proxy_id"], a)

    def test_pool_disabled_never_binds(self) -> None:
        pool = make_pool("http://a.example:1", enabled=False)
        service, storage = make_service(pool, [{"access_token": "t"}])
        self.assertEqual(service.ensure_proxy_binding("t"), "")
        self.assertEqual(service.bind_unbound_accounts(), 0)
        service.add_accounts(["new"])
        self.assertEqual(stored(storage, "new")["proxy_id"], "")

    def test_token_rotation_keeps_binding(self) -> None:
        pool = make_pool("http://a.example:1")
        a = pool.list_entries()[0]["id"]
        service, storage = make_service(pool, [{"access_token": "old", "proxy_id": a}])
        with patch("services.account_service.image_runtime_repository"):
            new_token = service._apply_refreshed_tokens("old", {"access_token": "new"}, "test")
        self.assertEqual(new_token, "new")
        self.assertEqual(stored(storage, "new")["proxy_id"], a)


class MigrationTests(_HermeticCase):
    def test_legacy_proxies_are_migrated_deduped_and_cleared(self) -> None:
        pool = make_pool("http://a.example:1")
        accounts = [
            {"access_token": "t1", "proxy": "socks5://u:p@l.example:1080"},
            {"access_token": "t2", "proxy": "socks5h://u:p@L.example:1080"},
            {"access_token": "t3", "proxy": "http://other.example:3128"},
            {"access_token": "t4", "proxy": "garbage"},
            {"access_token": "t5"},
        ]
        service, storage = make_service(pool, accounts)
        result = service.activate_proxy_pool()
        self.assertEqual(result["migration"], {"migrated": 3, "created": 2})
        self.assertEqual(stored(storage, "t1")["proxy_id"], stored(storage, "t2")["proxy_id"])
        self.assertEqual(stored(storage, "t1")["proxy"], "")
        legacy = {entry["source"] for entry in pool.list_entries()[1:]}
        self.assertEqual(legacy, {"legacy_account"})
        # 无效旧地址保留原值，但账号仍会分到池代理
        self.assertEqual(stored(storage, "t4")["proxy"], "garbage")
        self.assertTrue(stored(storage, "t4")["proxy_id"])
        self.assertTrue(stored(storage, "t5")["proxy_id"])
        self.assertTrue(pool.settings()["legacy_migrated"])
        # 幂等
        self.assertEqual(service.activate_proxy_pool()["migration"], {"migrated": 0, "created": 0})

    def test_activate_is_noop_when_disabled(self) -> None:
        pool = make_pool("http://a.example:1", enabled=False)
        service, storage = make_service(pool, [{"access_token": "t1", "proxy": "http://l.example:1"}])
        self.assertEqual(service.activate_proxy_pool()["assigned"], 0)
        self.assertEqual(stored(storage, "t1")["proxy"], "http://l.example:1")


class ImportTests(_HermeticCase):
    def test_import_converts_proxy_and_drops_foreign_id(self) -> None:
        pool = make_pool("http://a.example:1")
        service, storage = make_service(pool)
        service.add_account_items([
            {"access_token": "t1", "proxy": "http://imp.example:8000"},
            {"access_token": "t2", "proxy_id": "px_foreign"},
        ])
        imported = stored(storage, "t1")
        entry = pool.get_entry(imported["proxy_id"])
        self.assertEqual((entry["url"], entry["source"]), ("http://imp.example:8000", "import"))
        self.assertEqual(imported["proxy"], "")
        self.assertTrue(pool.has_entry(stored(storage, "t2")["proxy_id"]))

    def test_reimport_keeps_existing_binding(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1")
        a, b = [entry["id"] for entry in pool.list_entries()]
        service, storage = make_service(pool, [{"access_token": "t1", "proxy_id": a}])
        service.add_account_items([{"access_token": "t1", "proxy_id": b, "proxy": "http://x.example:1"}])
        self.assertEqual(stored(storage, "t1")["proxy_id"], a)

    def test_oauth_preallocated_proxy_is_kept(self) -> None:
        pool = make_pool("http://a.example:1", "http://b.example:1")
        a, b = [entry["id"] for entry in pool.list_entries()]
        service, storage = make_service(pool, [{"access_token": "x", "proxy_id": b}])
        service.add_account_items([{"access_token": "oauth", "proxy_id": b}])
        self.assertEqual(stored(storage, "oauth")["proxy_id"], b)

    def test_proxy_updates_validation(self) -> None:
        pool = make_pool("http://a.example:1")
        a = pool.list_entries()[0]["id"]
        service, _storage = make_service(pool)
        self.assertEqual(service.normalize_proxy_updates({"proxy_id": a, "proxy": ""}), {"proxy_id": a})
        self.assertEqual(service.normalize_proxy_updates({"status": "正常", "proxy": ""}), {"status": "正常"})
        with self.assertRaises(ValueError):
            service.normalize_proxy_updates({"proxy_id": "px_missing"})
        converted = service.normalize_proxy_updates({"proxy": "http://manual.example:1"})
        self.assertTrue(pool.has_entry(converted["proxy_id"]))
        self.assertEqual(converted["proxy"], "")
        pool.update_settings({"enabled": False})
        self.assertEqual(service.normalize_proxy_updates({"proxy": ""}), {"proxy": ""})


if __name__ == "__main__":
    unittest.main()
