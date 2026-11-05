import unittest
from unittest.mock import patch

from services import image_service


def make_items(count: int) -> list[dict]:
    return [
        {
            "path": f"2026/01/01/img_{i:03d}.png",
            "rel": f"2026/01/01/img_{i:03d}.png",
            "name": f"img_{i:03d}.png",
            "date": "2026-01-01",
            "size": 1,
            "created_at": f"2026-01-01 00:00:{i % 60:02d}",
        }
        for i in range(count)
    ]


class ImagePaginationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.items = make_items(30)
        self.tags = {self.items[1]["path"]: ["cat"], self.items[2]["path"]: ["cat", "dog"]}
        self.calls: list[bool] = []

        def fake_list_items(base_url, start_date="", end_date="", rescan=True):
            self.calls.append(rescan)
            return list(self.items)

        patches = [
            patch.object(image_service.image_storage_service, "list_items", side_effect=fake_list_items),
            patch.object(image_service, "load_tags", side_effect=lambda: dict(self.tags)),
            patch.object(image_service.config, "cleanup_old_images", return_value=0),
            patch.object(image_service, "cleanup_image_thumbnails", return_value=0),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        image_service._last_rescan_at = 0.0

    def test_legacy_call_returns_everything_with_groups(self) -> None:
        result = image_service.list_images("http://x")
        self.assertEqual(len(result["items"]), 30)
        self.assertIn("groups", result)
        self.assertNotIn("total", result)

    def test_paged_call_slices_and_reports_totals(self) -> None:
        result = image_service.list_images("http://x", page=3, page_size=12)
        self.assertEqual(len(result["items"]), 6)
        self.assertEqual((result["total"], result["page"], result["page_count"]), (30, 3, 3))
        self.assertNotIn("groups", result)

    def test_out_of_range_page_is_clamped(self) -> None:
        self.assertEqual(image_service.list_images("http://x", page=99, page_size=12)["page"], 3)

    def test_tag_filter_requires_all_tags_and_applies_before_paging(self) -> None:
        both = image_service.list_images("http://x", page=1, page_size=12, tags=["cat", "dog"])
        self.assertEqual(both["total"], 1)
        one = image_service.list_images("http://x", page=1, page_size=12, tags=["cat"])
        self.assertEqual(one["total"], 2)
        self.assertEqual(one["items"][0]["tags"] in (["cat"], ["cat", "dog"]), True)

    def test_rescan_is_throttled_unless_refresh_is_forced(self) -> None:
        image_service.list_images("http://x", page=1)
        image_service.list_images("http://x", page=2)
        image_service.list_images("http://x", page=1, refresh=True)
        self.assertEqual(self.calls, [True, False, True])

    def test_list_image_paths_uses_index_only_and_honours_tags(self) -> None:
        paths = image_service.list_image_paths(tags=["dog"])
        self.assertEqual(paths, [self.items[2]["path"]])
        self.assertEqual(self.calls, [False])


if __name__ == "__main__":
    unittest.main()
