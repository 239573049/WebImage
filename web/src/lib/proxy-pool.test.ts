import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProxySubscriptionNode } from "./api.ts";
import {
  describeRefreshResult,
  duplicateExitIps,
  filterSubscriptionNodes,
  formatBytes,
  formatRefreshInterval,
  isNodeSelectable,
  isShareLinkLine,
  parseRefreshHours,
  subscriptionExpire,
  subscriptionLabel,
  subscriptionTraffic,
} from "./proxy-pool.ts";

function poolItem(enabled: boolean, exitIp: string | null) {
  return {
    enabled,
    health: {
      state: "healthy" as const,
      consecutive_failures: 0,
      last_error: null,
      last_error_at: null,
      last_ok_at: null,
      last_probe_at: null,
      latency_ms: null,
      exit_ip: exitIp,
    },
  };
}

test("duplicateExitIps only flags exit IPs shared by two or more enabled proxies", () => {
  const result = duplicateExitIps([
    poolItem(true, "1.1.1.1"),
    poolItem(true, "1.1.1.1"),
    poolItem(true, "2.2.2.2"),
    // 禁用的代理不参与分配，不算重复
    poolItem(false, "2.2.2.2"),
    poolItem(true, null),
    poolItem(true, null),
  ]);
  assert.deepEqual([...result.entries()], [["1.1.1.1", 2]]);
});

test("formatRefreshInterval treats 0 as manual", () => {
  assert.equal(formatRefreshInterval(0), "手动");
  assert.equal(formatRefreshInterval(6), "每 6 小时");
});

test("parseRefreshHours accepts integers from 0 to 168 only", () => {
  assert.equal(parseRefreshHours("0"), 0);
  assert.equal(parseRefreshHours(" 24 "), 24);
  assert.equal(parseRefreshHours("168"), 168);
  assert.equal(parseRefreshHours("169"), null);
  assert.equal(parseRefreshHours("-1"), null);
  assert.equal(parseRefreshHours("1.5"), null);
  assert.equal(parseRefreshHours(""), null);
});

test("formatBytes uses binary units with sensible precision", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(12.34 * 1024 ** 3), "12.3 GB");
  assert.equal(formatBytes(200 * 1024 ** 3), "200 GB");
});

test("subscriptionTraffic adds upload and download against the total", () => {
  assert.equal(subscriptionTraffic({}), null);
  assert.deepEqual(subscriptionTraffic({ upload: 1024 ** 3, download: 4 * 1024 ** 3, total: 100 * 1024 ** 3 }), {
    used: 5 * 1024 ** 3,
    total: 100 * 1024 ** 3,
    percent: 5,
    text: "5 GB / 100 GB",
  });
  assert.equal(subscriptionTraffic({ download: 2048 })?.text, "已用 2 KB");
});

test("subscriptionExpire formats the local date and days left", () => {
  const expireAt = new Date(2026, 11, 1, 12, 0, 0);
  const expire = Math.floor(expireAt.getTime() / 1000);
  const now = new Date(2026, 10, 29, 12, 0, 0).getTime();
  assert.deepEqual(subscriptionExpire({ expire }, now), { date: "2026-12-01", expired: false, daysLeft: 2 });
  assert.equal(subscriptionExpire({ expire }, expireAt.getTime() + 1000)?.expired, true);
  assert.equal(subscriptionExpire({}), null);
});

test("describeRefreshResult summarises changes or the error", () => {
  assert.equal(describeRefreshResult({ ok: false, error: "HTTP 403" }), "拉取失败：HTTP 403");
  assert.equal(
    describeRefreshResult({ ok: true, error: null, nodes: 12, updated: 1, missing: 2, restored: 0 }),
    "12 个节点，更新 1 个代理地址，2 个节点不可用，已自动禁用",
  );
});

function node(overrides: Partial<ProxySubscriptionNode>): ProxySubscriptionNode {
  return {
    key: "n",
    name: "n",
    type: "ss",
    server: "example.com",
    port: 443,
    mode: "core",
    available: true,
    reason: "",
    masked_url: "",
    imported: false,
    proxy_id: null,
    ...overrides,
  };
}

test("filterSubscriptionNodes matches name, type and server:port within a mode", () => {
  const nodes = [
    node({ key: "a", name: "香港 01", type: "ss", server: "hk.example.com", mode: "core" }),
    node({ key: "b", name: "US socks", type: "socks5", server: "1.2.3.4", port: 1080, mode: "direct" }),
    node({ key: "c", name: "JP", type: "wireguard", mode: "unsupported", available: false }),
  ];
  assert.deepEqual(filterSubscriptionNodes(nodes, "", "all").map((item) => item.key), ["a", "b", "c"]);
  assert.deepEqual(filterSubscriptionNodes(nodes, "香港", "all").map((item) => item.key), ["a"]);
  assert.deepEqual(filterSubscriptionNodes(nodes, "1.2.3.4:1080", "all").map((item) => item.key), ["b"]);
  assert.deepEqual(filterSubscriptionNodes(nodes, "SOCKS", "direct").map((item) => item.key), ["b"]);
  assert.deepEqual(filterSubscriptionNodes(nodes, "", "core").map((item) => item.key), ["a"]);
});

test("isNodeSelectable requires an available node that is not imported yet", () => {
  assert.equal(isNodeSelectable({ available: true, imported: false }), true);
  assert.equal(isNodeSelectable({ available: true, imported: true }), false);
  assert.equal(isNodeSelectable({ available: false, imported: false }), false);
});

test("isShareLinkLine recognises share links and base64 blobs but not plain proxies", () => {
  assert.equal(isShareLinkLine("vmess://eyJhZGQiOiIxLjIuMy40In0="), true);
  assert.equal(isShareLinkLine("ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#HK"), true);
  assert.equal(isShareLinkLine("HY2://pass@host:443"), true);
  assert.equal(isShareLinkLine("socks://dXNlcjpwYXNz@1.2.3.4:1080"), true);
  assert.equal(isShareLinkLine("dm1lc3M6Ly9leUpoWkdRaU9pSXhMakl1TXk0MEluMD0K+/=="), true);
  assert.equal(isShareLinkLine("socks5://user:pass@1.2.3.4:1080"), false);
  assert.equal(isShareLinkLine("http://1.2.3.4:8080"), false);
  assert.equal(isShareLinkLine("1.2.3.4:8080:user:pass"), false);
  assert.equal(isShareLinkLine("proxy.example.com"), false);
});

test("subscriptionLabel falls back to the built-in name for the manual subscription", () => {
  assert.equal(subscriptionLabel({ name: "", masked_url: "", kind: "manual" }), "手动添加的节点");
  assert.equal(subscriptionLabel({ name: " ", masked_url: "https://x/***", kind: "url" }), "https://x/***");
  assert.equal(subscriptionLabel({ name: "机场 A", masked_url: "https://x/***" }), "机场 A");
});
