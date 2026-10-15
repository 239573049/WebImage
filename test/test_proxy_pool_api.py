from __future__ import annotations

import os
import unittest
from typing import Any
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.proxy_pool as proxy_pool_api
from services.account_service import AccountService
from services.proxy_pool_service import ProxyPoolService
from services.proxy_subscription_service import ProxySubscriptionService


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = accounts

    def load_accounts(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.accounts]

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = [dict(item) for item in accounts]


class ProxyPoolApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.probes: list[str] = []

        def probe(url: str, timeout: float) -> dict:
            self.probes.append(url)
            return {"ok": True, "status": 200, "latency_ms": 7, "error": None, "exit_ip": "5.6.7.8"}

        self.pool = ProxyPoolService(None, probe_func=probe)
        self.storage = MemoryStorage([
            {"access_token": "t1", "user_id": "u1", "proxy": "http://legacy.example:1"},
            {"access_token": "t2", "user_id": "u2"},
            {"access_token": "t3", "user_id": "u3"},
        ])
        self.accounts = AccountService(self.storage)
        self.accounts._proxy_pool = self.pool
        self.subscriptions = ProxySubscriptionService(
            None, pool=self.pool, core=mock.MagicMock(last_apply={"ok": None}),
            fetcher=lambda url, ua: (
                "proxies:\n"
                "  - {name: A, type: socks5, server: a.example, port: 1080}\n"
                "  - {name: B, type: http, server: b.example, port: 8080}\n"
                "  - {name: C, type: trojan, server: c.example, port: 443, password: x}\n",
                "",
            ),
        )
        for patcher in (
            mock.patch.object(proxy_pool_api, "proxy_pool", self.pool),
            mock.patch.object(proxy_pool_api, "proxy_subscriptions", self.subscriptions),
            mock.patch.object(proxy_pool_api, "account_service", self.accounts),
            mock.patch.object(proxy_pool_api, "require_admin", lambda _authorization: {"role": "admin"}),
            mock.patch("services.account_service.log_service"),
            mock.patch.object(AccountService, "_save_cumulative_total"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(proxy_pool_api.create_router())
        self.client = TestClient(app)

    def post(self, path: str, body: dict) -> dict:
        response = self.client.post(path, headers=AUTH_HEADERS, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def bindings(self) -> dict[str, str]:
        return {item["access_token"]: item.get("proxy_id", "") for item in self.storage.accounts}

    def test_full_lifecycle(self) -> None:
        added = self.post("/api/proxy/pool", {"urls": ["http://u:secret@a.example:1\nhttp://b.example:1", "bad"]})
        self.assertEqual((added["added"], added["skipped"], len(added["errors"])), (2, 0, 1))
        self.assertEqual(added["assigned"], 0)  # 池还没开启
        self.assertNotIn("secret", added["items"][0]["masked_url"])
        self.assertEqual(added["summary"]["unbound_accounts"], 3)

        enabled = self.post("/api/proxy/pool/settings", {"enabled": True})
        self.assertEqual(enabled["migration"], {"migrated": 1, "created": 1})
        self.assertEqual(enabled["summary"]["total"], 3)
        self.assertEqual(enabled["summary"]["unbound_accounts"], 0)
        self.assertEqual(sum(item["bound_count"] for item in enabled["items"]), 3)
        self.assertEqual(self.storage.accounts[0]["proxy"], "")

        before = self.bindings()
        self.post("/api/proxy/pool", {"urls": ["http://c.example:1"]})
        self.assertEqual(self.bindings(), before)  # 新增代理不动已有绑定

        legacy_id = self.storage.accounts[0]["proxy_id"]
        updated = self.post(f"/api/proxy/pool/{legacy_id}", {"enabled": False, "name": "旧"})
        self.assertEqual(updated["item"]["name"], "旧")
        legacy_item = next(item for item in updated["items"] if item["id"] == legacy_id)
        self.assertEqual(legacy_item["borrowed_out_count"], 1)
        self.assertEqual(sum(item["borrowing_count"] for item in updated["items"]), 1)
        self.assertEqual(self.bindings(), before)  # 禁用只借用，不改绑

        tested = self.post(f"/api/proxy/pool/{legacy_id}/test", {})
        self.assertEqual(tested["result"]["exit_ip"], "5.6.7.8")

        response = self.client.delete(f"/api/proxy/pool/{legacy_id}", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["reassigned"], 1)
        self.assertNotEqual(self.bindings()["t1"], legacy_id)
        self.assertTrue(self.pool.has_entry(self.bindings()["t1"]))

    def test_errors(self) -> None:
        self.assertEqual(self.client.post("/api/proxy/pool", headers=AUTH_HEADERS, json={"urls": [" "]}).status_code, 400)
        self.assertEqual(self.client.delete("/api/proxy/pool/px_missing", headers=AUTH_HEADERS).status_code, 404)
        self.assertEqual(self.client.post("/api/proxy/pool/px_missing/test", headers=AUTH_HEADERS).status_code, 404)
        self.assertEqual(
            self.client.post("/api/proxy/pool/px_missing", headers=AUTH_HEADERS, json={"name": "x"}).status_code, 404,
        )
        self.post("/api/proxy/pool", {"urls": ["http://a.example:1", "http://b.example:1"]})
        a = self.pool.list_entries()[0]["id"]
        response = self.client.post(f"/api/proxy/pool/{a}", headers=AUTH_HEADERS, json={"url": "http://b.example:1"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("已存在", response.json()["detail"]["error"])

    def test_subscription_flow(self) -> None:
        self.accounts.update_account("t1", {"proxy": ""})   # 池里只有订阅节点
        self.post("/api/proxy/pool/settings", {"enabled": True})
        created = self.post("/api/proxy/subscriptions", {"name": "机场", "url": "https://sub.example/x?token=t"})
        self.assertTrue(created["result"]["ok"])
        sub_id = created["item"]["id"]
        self.assertEqual((created["item"]["direct_count"], created["item"]["core_count"]), (2, 1))
        trojan = next(node for node in created["item"]["nodes"] if node["key"] == "C")
        self.assertEqual((trojan["available"], trojan["reason"]), (False, "需要启用 mihomo 内核"))

        imported = self.post(f"/api/proxy/subscriptions/{sub_id}/import", {"node_keys": ["A", "B", "C"]})
        self.assertEqual(imported["added"], 2)
        self.assertEqual(imported["assigned"], 3)
        self.assertEqual(imported["skipped"], [{"key": "C", "reason": "需要启用 mihomo 内核"}])

        pool = self.client.get("/api/proxy/pool", headers=AUTH_HEADERS).json()
        item = pool["items"][0]
        self.assertEqual((item["source"], item["subscription_name"]), ("subscription", "机场"))
        response = self.client.post(f"/api/proxy/pool/{item['id']}", headers=AUTH_HEADERS,
                                    json={"url": "http://elsewhere.example:1"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post(f"/api/proxy/pool/{item['id']}", headers=AUTH_HEADERS,
                                          json={"name": "改名"}).status_code, 200)

        response = self.client.delete(f"/api/proxy/subscriptions/{sub_id}", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["removed_proxies"], response.json()["reassigned"]), (2, 3))
        self.assertTrue(all(binding == "" for binding in self.bindings().values()))
        self.assertEqual(self.client.get(f"/api/proxy/subscriptions/{sub_id}", headers=AUTH_HEADERS).status_code, 404)

    def test_batch_add_accepts_share_links(self) -> None:
        import base64
        import json as jsonlib
        vmess = "vmess://" + base64.b64encode(jsonlib.dumps({
            "v": "2", "ps": "cn2", "add": "198.51.100.7", "port": "36102",
            "id": "00000000-0000-4000-8000-000000000001", "aid": "0", "net": "tcp", "tls": "",
        }).encode()).decode()
        result = self.post("/api/proxy/pool", {"urls": [f"http://plain.example:1\n{vmess}"]})
        self.assertEqual((result["added"], result["errors"]), (1, [{"url": "cn2", "error": "需要启用 mihomo 内核"}]))
        self.assertIsNone(result["core_apply"])

        self.subscriptions.update_core_settings({"enabled": True})
        result = self.post("/api/proxy/pool", {"urls": [vmess]})
        self.assertEqual((result["added"], result["errors"]), (1, []))
        core_item = next(item for item in result["items"] if item.get("node_key") == "cn2")
        self.assertEqual((core_item["via_core"], core_item["subscription_name"]), (True, "手动添加的节点"))
        self.assertEqual(core_item["url"], "http://proxy-core:20000")
        bad = self.post("/api/proxy/pool", {"urls": ["vmess://not-base64!!"]})
        self.assertEqual(bad["added"], 0)
        self.assertEqual(len(bad["errors"]), 1)

    def test_subscription_errors(self) -> None:
        response = self.client.post("/api/proxy/subscriptions", headers=AUTH_HEADERS, json={"url": "ftp://x"})
        self.assertEqual(response.status_code, 400)
        for method, path in (("post", "/api/proxy/subscriptions/sub_x/refresh"),
                             ("delete", "/api/proxy/subscriptions/sub_x")):
            self.assertEqual(getattr(self.client, method)(path, headers=AUTH_HEADERS).status_code, 404)

    def test_settings_are_clamped(self) -> None:
        payload = self.post("/api/proxy/pool/settings", {"probe_interval_secs": 1, "failure_threshold": 99})
        self.assertEqual(payload["settings"]["probe_interval_secs"], 10)
        self.assertEqual(payload["settings"]["failure_threshold"], 20)
        self.assertNotIn("legacy_migrated", payload["settings"])


if __name__ == "__main__":
    unittest.main()
