"""代理订阅：解析 Clash / V2Ray、导入节点、刷新对账、可选 mihomo 内核配置。"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

import yaml

from services.proxy_core_service import ProxyCoreService, build_core_config
from services.proxy_pool_service import ProxyPoolService
from services.proxy_subscription_parser import (
    SubscriptionParseError,
    parse_subscription,
    parse_userinfo,
    split_share_links,
)
from services.proxy_subscription_service import MANUAL_SUBSCRIPTION_ID, ProxySubscriptionService

CLASH_YAML = """
mixed-port: 7890
proxies:
  - {name: "HK HTTP", type: http, server: hk.example, port: 8080, username: u, password: "p@ss"}
  - {name: "US SOCKS", type: socks5, server: us.example, port: 1080}
  - {name: "JP SS", type: ss, server: jp.example, port: 8388, cipher: aes-128-gcm, password: pw}
  - {name: "SG VMess", type: vmess, server: sg.example, port: 443, uuid: 11111111-1111-1111-1111-111111111111, alterId: 0, cipher: auto, tls: true}
  - {name: "Dup", type: socks5, server: a.example, port: 1}
  - {name: "Dup", type: socks5, server: b.example, port: 2}
  - {name: "Weird", type: madeup, server: w.example, port: 1}
  - {name: "DIRECT-ish", type: direct}
proxy-groups:
  - {name: auto, type: select, proxies: ["HK HTTP"]}
"""


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


VMESS = "vmess://" + b64(json.dumps({
    "v": "2", "ps": "VMess WS", "add": "v.example", "port": "443", "id": "uuid-1", "aid": "0",
    "net": "ws", "path": "/ray", "host": "cdn.example", "tls": "tls", "sni": "cdn.example",
}))
V2RAY_LINES = "\n".join([
    VMESS,
    "vless://uuid-2@vl.example:443?security=reality&sni=www.example.com&pbk=PUB&sid=ab&fp=chrome"
    "&type=grpc&serviceName=svc&flow=xtls-rprx-vision#VLESS%20Reality",
    "trojan://secret@tr.example:443?sni=tr.example&allowInsecure=1#Trojan",
    "ss://" + b64("chacha20-ietf-poly1305:pw") + "@ss.example:8388#SS%20New",
    "ss://" + b64("aes-256-gcm:pw2@old.example:8389") + "#SS%20Legacy",
    "hysteria2://pass@hy.example:443?sni=hy.example&obfs=salamander&obfs-password=ob#HY2",
    "tuic://uuid-3:pw3@tu.example:443?sni=tu.example&congestion_control=bbr&alpn=h3#TUIC",
    "socks://" + b64("user:pw") + "@sk.example:1080#SOCKS%20v2rayN",
    "http://hu:hp@ht.example:3128#HTTP",
    "ssr://whatever#SSR",
])


def vmess_link(name: str, **fields: str) -> str:
    # v2rayN 新版导出的完整字段（含 insecure / vcn / pcs）
    data = {"v": "2", "ps": name, "add": "198.51.100.7", "port": "36102", "id": "00000000-0000-4000-8000-000000000001",
            "aid": "0", "scy": "auto", "net": "tcp", "type": "none", "tls": "", "sni": "", "alpn": "", "fp": "",
            "insecure": "0", "vcn": "", "pcs": "", **fields}
    return "vmess://" + base64.b64encode(json.dumps(data, indent=2).encode()).decode()


def by_name(nodes: list[dict]) -> dict[str, dict]:
    return {node["name"]: node for node in nodes}


class ParserTests(unittest.TestCase):
    def test_clash_yaml(self) -> None:
        nodes = by_name(parse_subscription(CLASH_YAML))
        self.assertEqual(nodes["HK HTTP"]["mode"], "direct")
        self.assertEqual(nodes["HK HTTP"]["url"], "http://u:p%40ss@hk.example:8080")
        self.assertEqual(nodes["US SOCKS"]["url"], "socks5h://us.example:1080")
        self.assertEqual(nodes["JP SS"]["mode"], "core")
        self.assertEqual(nodes["JP SS"]["proxy"]["cipher"], "aes-128-gcm")
        self.assertEqual(nodes["SG VMess"]["mode"], "core")
        self.assertIn("Dup #2", nodes)
        self.assertEqual(nodes["Weird"]["mode"], "unsupported")
        self.assertNotIn("DIRECT-ish", nodes)

    def test_v2ray_base64_and_plain(self) -> None:
        for content in (b64(V2RAY_LINES), V2RAY_LINES):
            with self.subTest(base64=content != V2RAY_LINES):
                nodes = by_name(parse_subscription(content))
                vmess = nodes["VMess WS"]["proxy"]
                self.assertEqual((vmess["type"], vmess["server"], vmess["port"], vmess["network"]),
                                 ("vmess", "v.example", 443, "ws"))
                self.assertEqual(vmess["ws-opts"], {"path": "/ray", "headers": {"Host": "cdn.example"}})
                self.assertTrue(vmess["tls"])

                vless = nodes["VLESS Reality"]["proxy"]
                self.assertEqual(vless["reality-opts"], {"public-key": "PUB", "short-id": "ab"})
                self.assertEqual(vless["grpc-opts"], {"grpc-service-name": "svc"})
                self.assertEqual(vless["flow"], "xtls-rprx-vision")

                trojan = nodes["Trojan"]["proxy"]
                self.assertEqual((trojan["password"], trojan["sni"], trojan["skip-cert-verify"]),
                                 ("secret", "tr.example", True))
                self.assertEqual(nodes["SS New"]["proxy"]["cipher"], "chacha20-ietf-poly1305")
                self.assertEqual(nodes["SS Legacy"]["proxy"]["server"], "old.example")
                self.assertEqual(nodes["HY2"]["proxy"]["obfs-password"], "ob")
                self.assertEqual(nodes["TUIC"]["proxy"]["alpn"], ["h3"])
                for name in ("VMess WS", "VLESS Reality", "Trojan", "SS New", "HY2", "TUIC"):
                    self.assertEqual(nodes[name]["mode"], "core")

                self.assertEqual(nodes["SOCKS v2rayN"]["url"], "socks5h://user:pw@sk.example:1080")
                self.assertEqual(nodes["HTTP"]["url"], "http://hu:hp@ht.example:3128")
                self.assertEqual(nodes["SSR"]["mode"], "unsupported")

    def test_v2rayn_vmess_tcp_link(self) -> None:
        [node] = parse_subscription(vmess_link("cn2"))
        self.assertEqual(node["mode"], "core")
        self.assertEqual(node["proxy"], {
            "name": "cn2", "type": "vmess", "server": "198.51.100.7", "port": 36102,
            "uuid": "00000000-0000-4000-8000-000000000001", "alterId": 0, "cipher": "auto", "udp": True,
        })
        [tls_node] = parse_subscription(vmess_link("t", tls="tls", sni="a.example", insecure="1"))
        self.assertEqual((tls_node["proxy"]["servername"], tls_node["proxy"]["skip-cert-verify"]), ("a.example", True))
        [http_node] = parse_subscription(vmess_link("h", type="http", host="h.example", path="/x"))
        self.assertEqual(http_node["proxy"]["network"], "http")
        self.assertEqual(http_node["proxy"]["http-opts"], {"path": ["/x"], "headers": {"Host": ["h.example"]}})

    def test_split_share_links(self) -> None:
        blob = b64(vmess_link("a") + "\n" + "trojan://p@t.example:443#t")
        plain, shares = split_share_links([
            "http://u:p@h.example:1", "h.example:3128", "h.example:1:u:p", vmess_link("v"),
            "SOCKS://dXNlcjpwdw==@s.example:1080#s", blob, "  ", "# c", "proxy.example.com",
        ])
        self.assertEqual(plain, ["http://u:p@h.example:1", "h.example:3128", "h.example:1:u:p", "proxy.example.com"])
        self.assertEqual(len(shares), 4)
        self.assertTrue(shares[2].startswith("vmess://"))

    def test_garbage_is_rejected(self) -> None:
        for content in ("", "<html>login</html>", b64("hello world")):
            with self.subTest(content=content[:10]):
                with self.assertRaises(SubscriptionParseError):
                    parse_subscription(content)

    def test_userinfo(self) -> None:
        self.assertEqual(parse_userinfo("upload=1; download=2; total=3.0e10; expire=1700000000"),
                         {"upload": 1, "download": 2, "total": 30000000000, "expire": 1700000000})


class CoreConfigTests(unittest.TestCase):
    def test_each_node_gets_its_own_listener(self) -> None:
        settings = {"secret": "s3", "listen_host": "proxy-core"}
        config = build_core_config(settings, [(20001, {"name": "JP SS", "type": "ss", "server": "jp"}),
                                              (20000, {"name": "SG", "type": "vmess", "server": "sg"})])
        self.assertEqual([proxy["name"] for proxy in config["proxies"]], ["p20000", "p20001"])
        self.assertEqual(config["listeners"][0], {
            "name": "in-20000", "type": "mixed", "port": 20000, "listen": "0.0.0.0", "udp": False,
            "users": [], "proxy": "p20000",
        })
        self.assertEqual(config["rules"], ["MATCH,REJECT"])
        self.assertEqual(config["secret"], "s3")
        yaml.safe_load(yaml.safe_dump(config, allow_unicode=True))   # 可序列化

    def test_apply_writes_file_and_pushes_payload(self) -> None:
        calls: list[Any] = []

        class Response:
            status = 204

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return b""

        def opener(request, timeout=None):
            calls.append((request.get_method(), request.full_url, dict(request.headers), request.data))
            return Response()

        with tempfile.TemporaryDirectory() as tmp:
            core = ProxyCoreService(Path(tmp), opener=opener)
            settings = {"api_url": "http://core:9090", "secret": "s3", "listen_host": "core"}
            result = core.apply(settings, [(20000, {"name": "x", "type": "ss"})])
            self.assertTrue(result["ok"])
            written = yaml.safe_load((Path(tmp) / "config.yaml").read_text(encoding="utf-8"))
            self.assertEqual(written["listeners"][0]["port"], 20000)
        method, url, headers, body = calls[0]
        self.assertEqual((method, url), ("PUT", "http://core:9090/configs?force=true"))
        self.assertEqual(headers["Authorization"], "Bearer s3")
        self.assertIn("p20000", json.loads(body)["payload"])

    def test_apply_failure_is_reported(self) -> None:
        def opener(request, timeout=None):
            raise OSError("connection refused")

        core = ProxyCoreService(None, opener=opener)
        result = core.apply({"api_url": "http://core:9090", "secret": "", "listen_host": "core"}, [])
        self.assertFalse(result["ok"])
        self.assertIn("refused", result["error"])


class FakeCore:
    def __init__(self) -> None:
        self.applied: list[list[tuple[int, dict]]] = []
        self.last_apply: dict[str, Any] = {"ok": None, "error": None}

    def apply(self, settings, nodes):
        self.applied.append(sorted(nodes, key=lambda item: item[0]))
        self.last_apply = {"ok": True, "error": None, "nodes": len(nodes)}
        return dict(self.last_apply)

    def status(self, settings):
        return {"enabled": settings["enabled"], "ok": True}


class SubscriptionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.content = CLASH_YAML
        self.fail_fetch = False
        self.pool = ProxyPoolService(None, probe_func=lambda url, timeout: {"ok": True})
        self.pool.update_settings({"enabled": True})
        self.core = FakeCore()

        def fetcher(url: str, user_agent: str) -> tuple[str, str]:
            if self.fail_fetch:
                raise RuntimeError("timeout")
            return self.content, "upload=1; download=2; total=10"

        self.service = ProxySubscriptionService(None, pool=self.pool, core=self.core, fetcher=fetcher)
        self.sub = self.service.create(name="机场", url="https://sub.example/api?token=abc")
        self.assertTrue(self.service.refresh(self.sub["id"])["ok"])

    def entry(self, node_key: str) -> dict:
        return next(e for e in self.pool.entries_for_subscription(self.sub["id"]) if e["node_key"] == node_key)

    def test_import_direct_nodes_without_core(self) -> None:
        result = self.service.import_nodes(self.sub["id"], ["HK HTTP", "US SOCKS", "JP SS", "Weird", "nope"])
        self.assertEqual(sorted(entry["node_key"] for entry in result["added"]), ["HK HTTP", "US SOCKS"])
        reasons = {item["key"]: item["reason"] for item in result["skipped"]}
        self.assertEqual(reasons["JP SS"], "需要启用 mihomo 内核")
        self.assertIn("不支持", reasons["Weird"])
        self.assertIn("没有该节点", reasons["nope"])
        self.assertEqual(self.entry("HK HTTP")["url"], "http://u:p%40ss@hk.example:8080")
        self.assertEqual(self.core.applied, [])
        # 重复导入跳过
        again = self.service.import_nodes(self.sub["id"], ["HK HTTP"])
        self.assertEqual(again["skipped"], [{"key": "HK HTTP", "reason": "已导入"}])

        detail = self.service.public_detail(self.sub["id"])
        node = next(item for item in detail["nodes"] if item["key"] == "HK HTTP")
        self.assertTrue(node["imported"])
        self.assertNotIn("p@ss", json.dumps(detail, ensure_ascii=False))
        self.assertEqual(detail["userinfo"], {"upload": 1, "download": 2, "total": 10})

    def test_core_nodes_get_stable_ports(self) -> None:
        self.service.update_core_settings({"enabled": True, "listen_host": "proxy-core", "port_start": 20000})
        result = self.service.import_nodes(self.sub["id"], ["JP SS", "SG VMess"])
        self.assertEqual(len(result["added"]), 2)
        ports = sorted(int(self.entry(key)["url"].rsplit(":", 1)[1]) for key in ("JP SS", "SG VMess"))
        self.assertEqual(ports, [20000, 20001])
        self.assertTrue(self.entry("JP SS")["via_core"])
        applied = self.core.applied[-1]
        self.assertEqual([port for port, _ in applied], [20000, 20001])
        self.assertEqual({proxy["type"] for _, proxy in applied}, {"ss", "vmess"})

        # 节点参数变化：地址（端口）不变，只是内核配置更新
        jp_id, jp_url = self.entry("JP SS")["id"], self.entry("JP SS")["url"]
        self.content = CLASH_YAML.replace("password: pw}", "password: changed}")
        self.service.refresh(self.sub["id"])
        self.assertEqual((self.entry("JP SS")["id"], self.entry("JP SS")["url"]), (jp_id, jp_url))
        jp_proxy = next(proxy for port, proxy in self.core.applied[-1] if proxy["name"] == "JP SS")
        self.assertEqual(jp_proxy["password"], "changed")

        # 关掉内核：内核节点自动禁用；再开：恢复
        self.service.update_core_settings({"enabled": False})
        self.assertFalse(self.entry("JP SS")["enabled"])
        self.assertTrue(self.entry("JP SS")["missing"])
        self.service.update_core_settings({"enabled": True})
        self.assertTrue(self.entry("JP SS")["enabled"])
        self.assertFalse(self.entry("JP SS")["missing"])

    def test_refresh_updates_disables_and_restores(self) -> None:
        self.service.import_nodes(self.sub["id"], ["HK HTTP", "US SOCKS"])
        hk_id = self.entry("HK HTTP")["id"]

        self.content = CLASH_YAML.replace("port: 8080", "port: 9090").replace(
            '  - {name: "US SOCKS", type: socks5, server: us.example, port: 1080}\n', "")
        result = self.service.refresh(self.sub["id"])
        self.assertEqual((result["updated"], result["missing"]), (1, 1))
        self.assertEqual(self.entry("HK HTTP")["id"], hk_id)
        self.assertEqual(self.entry("HK HTTP")["url"], "http://u:p%40ss@hk.example:9090")
        us = self.entry("US SOCKS")
        self.assertEqual((us["enabled"], us["missing"], us["auto_disabled"]), (False, True, True))

        self.content = CLASH_YAML
        result = self.service.refresh(self.sub["id"])
        self.assertEqual(result["restored"], 1)
        us = self.entry("US SOCKS")
        self.assertEqual((us["enabled"], us["missing"], us["auto_disabled"]), (True, False, False))

    def test_manually_disabled_node_stays_disabled_when_it_returns(self) -> None:
        self.service.import_nodes(self.sub["id"], ["US SOCKS"])
        self.content = CLASH_YAML.replace(
            '  - {name: "US SOCKS", type: socks5, server: us.example, port: 1080}\n', "")
        self.service.refresh(self.sub["id"])
        # 管理员在此期间手动操作过启用状态：auto_disabled 被清掉
        self.pool.update_entry(self.entry("US SOCKS")["id"], {"enabled": False})
        self.content = CLASH_YAML
        self.service.refresh(self.sub["id"])
        self.assertFalse(self.entry("US SOCKS")["enabled"])
        self.assertFalse(self.entry("US SOCKS")["missing"])

    def test_failed_or_empty_fetch_changes_nothing(self) -> None:
        self.service.import_nodes(self.sub["id"], ["HK HTTP"])
        before = self.pool.list_entries()
        self.fail_fetch = True
        self.assertFalse(self.service.refresh(self.sub["id"])["ok"])
        self.fail_fetch = False
        self.content = "<html>expired</html>"
        result = self.service.refresh(self.sub["id"])
        self.assertFalse(result["ok"])
        self.assertEqual(self.pool.list_entries(), before)
        self.assertIn("无法识别", self.service.public_summary(self.service.list_subscriptions()[0])["last_error"])

    def test_delete_subscription_removes_its_proxies(self) -> None:
        self.service.update_core_settings({"enabled": True})
        self.service.import_nodes(self.sub["id"], ["HK HTTP", "JP SS"])
        removed = self.service.delete(self.sub["id"])
        self.assertEqual(len(removed), 2)
        self.assertEqual(self.pool.list_entries(), [])
        self.assertEqual(self.core.applied[-1], [])

    def test_deleting_a_core_entry_frees_its_port(self) -> None:
        self.service.update_core_settings({"enabled": True})
        self.service.import_nodes(self.sub["id"], ["JP SS"])
        entry = self.entry("JP SS")
        self.pool.delete_entry(entry["id"])
        self.service.on_proxy_deleted(entry)
        self.assertEqual(self.core.applied[-1], [])
        self.assertEqual(self.service.list_subscriptions()[0]["ports"], {})

    def test_due_subscriptions(self) -> None:
        sub = self.service.list_subscriptions()[0]
        last = sub["last_attempt_ts"]
        self.assertEqual(self.service.due_subscriptions(now=last + 60), [])
        self.assertEqual(self.service.due_subscriptions(now=last + 6 * 3600), [self.sub["id"]])
        self.fail_fetch = True
        self.service.refresh(self.sub["id"])
        last = self.service.list_subscriptions()[0]["last_attempt_ts"]
        self.assertEqual(self.service.due_subscriptions(now=last + 15 * 60), [self.sub["id"]])
        self.service.update(self.sub["id"], {"refresh_interval_hours": 0})
        self.assertEqual(self.service.due_subscriptions(now=last + 10 ** 6), [])

    def test_pasted_share_links_go_to_manual_subscription(self) -> None:
        links = [vmess_link("cn2"), "http://u:p@paste.example:3128#plain-http"]
        result = self.service.add_manual_nodes(links)
        # 内核未启用：http 节点直接导入，vmess 节点先保存
        self.assertEqual([entry["node_key"] for entry in result["added"]], ["plain-http"])
        self.assertEqual(result["skipped"], [{"key": "cn2", "reason": "需要启用 mihomo 内核"}])
        detail = self.service.public_detail(MANUAL_SUBSCRIPTION_ID)
        self.assertEqual((detail["kind"], detail["node_count"]), ("manual", 2))
        self.assertFalse(self.service.refresh(MANUAL_SUBSCRIPTION_ID)["ok"])
        self.assertEqual(self.service.due_subscriptions(now=10 ** 12), [self.sub["id"]])

        # 启用内核后再粘一次同一条：识别为同一节点，这次导入
        self.service.update_core_settings({"enabled": True})
        again = self.service.add_manual_nodes([vmess_link("cn2")])
        self.assertEqual([entry["node_key"] for entry in again["added"]], ["cn2"])
        self.assertTrue(again["core"]["ok"])
        self.assertEqual(self.service.public_detail(MANUAL_SUBSCRIPTION_ID)["node_count"], 2)
        # 同名但配置不同：改名保存，不覆盖
        third = self.service.add_manual_nodes([vmess_link("cn2", port="40000")])
        self.assertEqual([entry["node_key"] for entry in third["added"]], ["cn2 #2"])
        repeat = self.service.add_manual_nodes([vmess_link("cn2")])
        self.assertEqual(repeat["skipped"], [{"key": "cn2", "reason": "已导入"}])
        with self.assertRaises(ValueError):
            self.service.update(MANUAL_SUBSCRIPTION_ID, {"url": "https://x.example"})

    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "subs.json"
            service = ProxySubscriptionService(store, pool=self.pool, core=self.core,
                                               fetcher=lambda url, ua: (CLASH_YAML, ""))
            sub = service.create(name="x", url="https://s.example/sub")
            service.update_core_settings({"enabled": True, "secret": "k"})
            service.refresh(sub["id"])
            service.import_nodes(sub["id"], ["JP SS"])
            reloaded = ProxySubscriptionService(store, pool=self.pool, core=self.core)
            self.assertTrue(reloaded.core_settings()["enabled"])
            self.assertEqual(reloaded.list_subscriptions()[0]["ports"], {"JP SS": 20000})
            self.assertNotIn("secret", reloaded.public_core_settings())


if __name__ == "__main__":
    unittest.main()
