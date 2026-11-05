import unittest
from unittest.mock import patch

from api import proxy_pool as proxy_pool_api


def make_entry(i: int, ip: str = "", enabled: bool = True) -> dict:
    return {"id": f"p{i}", "name": f"node-{i:02d}", "url": f"http://h{i}:1", "enabled": enabled, "subscription_id": ""}


class ProxyPoolPaginationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.entries = [make_entry(i) for i in range(25)]
        self.exit_ips = {"p0": "1.1.1.1", "p1": "1.1.1.1", "p2": "2.2.2.2"}

        def public_entry(entry):
            return {
                **entry,
                "masked_url": f"http://***@h{entry['id']}",
                "health": {"state": "healthy", "exit_ip": self.exit_ips.get(entry["id"], "")},
            }

        patches = [
            patch.object(proxy_pool_api.proxy_pool, "list_entries", return_value=self.entries),
            patch.object(proxy_pool_api.proxy_pool, "is_enabled", return_value=False),
            patch.object(proxy_pool_api.proxy_pool, "public_entry", side_effect=public_entry),
            patch.object(proxy_pool_api.proxy_pool, "settings", return_value={"enabled": False}),
            patch.object(proxy_pool_api.proxy_subscriptions, "subscription_names", return_value={}),
            patch.object(proxy_pool_api.account_service, "proxy_binding_snapshot", return_value=[]),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_legacy_call_returns_all_entries_without_page_fields(self) -> None:
        result = proxy_pool_api.build_pool_payload()
        self.assertEqual(len(result["items"]), 25)
        self.assertNotIn("total", result)

    def test_paged_call_slices_but_summary_covers_all_entries(self) -> None:
        result = proxy_pool_api.build_pool_payload(page=3, page_size=10)
        self.assertEqual(len(result["items"]), 5)
        self.assertEqual((result["total"], result["page"], result["page_count"]), (25, 3, 3))
        self.assertEqual(result["summary"]["total"], 25)

    def test_duplicate_exit_ips_cover_all_pages(self) -> None:
        # p0 / p1 共用出口，即使当前页只含其中一个也要标出重复
        result = proxy_pool_api.build_pool_payload(page=1, page_size=1)
        self.assertEqual(result["duplicate_exit_ips"], {"1.1.1.1": 2})

    def test_disabled_entries_do_not_count_as_duplicates(self) -> None:
        self.entries[1]["enabled"] = False
        result = proxy_pool_api.build_pool_payload(page=1, page_size=5)
        self.assertEqual(result["duplicate_exit_ips"], {})

    def test_query_filters_before_paging_and_out_of_range_page_is_clamped(self) -> None:
        result = proxy_pool_api.build_pool_payload(page=9, page_size=10, query="NODE-1")
        self.assertEqual(result["total"], 10)
        self.assertEqual(result["page"], 1)
        self.assertTrue(all("node-1" in item["name"] for item in result["items"]))


if __name__ == "__main__":
    unittest.main()
