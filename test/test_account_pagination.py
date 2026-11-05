import unittest
from typing import Any

from services.account_service import AccountService
from test.test_account_export import MemoryStorage


def make_service(count: int = 25) -> AccountService:
    accounts: list[dict[str, Any]] = []
    for i in range(count):
        accounts.append(
            {
                "access_token": f"tok_{i:03d}",
                "email": f"user{i}@example.com",
                "type": "Plus" if i % 5 == 0 else "Free",
                "status": "正常" if i % 2 == 0 else "限流",
                "quota": 10,
            }
        )
    return AccountService(MemoryStorage(accounts))


class AccountPaginationTests(unittest.TestCase):
    def test_first_page_slices_and_reports_total(self) -> None:
        result = make_service().list_accounts_page(page=1, page_size=10)
        self.assertEqual(len(result["items"]), 10)
        self.assertEqual(result["total"], 25)
        self.assertEqual(result["page_count"], 3)
        self.assertEqual(result["page"], 1)

    def test_last_page_is_partial_and_out_of_range_page_is_clamped(self) -> None:
        service = make_service()
        self.assertEqual(len(service.list_accounts_page(page=3, page_size=10)["items"]), 5)
        clamped = service.list_accounts_page(page=99, page_size=10)
        self.assertEqual(clamped["page"], 3)
        self.assertEqual(len(clamped["items"]), 5)

    def test_filters_apply_before_paging_but_summary_covers_all_accounts(self) -> None:
        result = make_service().list_accounts_page(page=1, page_size=50, status="限流", account_type="Free")
        self.assertTrue(all(i["status"] == "限流" and i["type"] == "Free" for i in result["items"]))
        self.assertEqual(result["total"], len(result["items"]))
        self.assertEqual(result["summary"]["total"], 25)
        self.assertEqual(result["summary"]["active"], 13)
        self.assertEqual(result["summary"]["limited"], 12)
        self.assertEqual(result["summary"]["quota"], 130)
        self.assertEqual(result["types"], ["Free", "Plus"])

    def test_query_matches_email_case_insensitively(self) -> None:
        result = make_service().list_accounts_page(query="  USER1@", page_size=50)
        self.assertEqual(
            {i["email"] for i in result["items"]},
            {"user1@example.com"},
        )

    def test_status_counts_follow_query_and_type_but_not_status(self) -> None:
        result = make_service().list_accounts_page(account_type="Plus", status="正常", page_size=50)
        self.assertEqual(result["status_counts"]["all"], 5)
        self.assertEqual(result["status_counts"]["正常"] + result["status_counts"]["限流"], 5)

    def test_list_account_briefs_is_lightweight_and_filterable(self) -> None:
        service = make_service()
        briefs = service.list_account_briefs(status="限流")
        self.assertEqual(len(briefs), 12)
        self.assertEqual(set(briefs[0]), {"access_token", "status", "quota"})
        self.assertEqual(len(service.list_account_briefs()), 25)

    def test_page_size_is_capped(self) -> None:
        self.assertEqual(make_service().list_accounts_page(page_size=10_000)["page_size"], 200)


if __name__ == "__main__":
    unittest.main()
