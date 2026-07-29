from __future__ import annotations

import json

import pytest

from services.log_service import LogService


def write_lines(path, lines: list[str], trailing_newline: bool = True) -> None:
    content = "\n".join(lines)
    if trailing_newline and content:
        content += "\n"
    path.write_text(content, encoding="utf-8")


def make_entry(index: int, *, type: str = "call", day: str = "2026-07-29") -> str:
    return json.dumps(
        {
            "id": f"id-{index}",
            "time": f"{day} 10:00:{index:02d}",
            "type": type,
            "summary": f"entry-{index}",
            "detail": {"seq": index},
        },
        ensure_ascii=False,
    )


@pytest.fixture
def service(tmp_path):
    return LogService(tmp_path / "logs.jsonl")


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("", []),
        ("a\n", ["a"]),
        ("a", ["a"]),
        ("\na\n", ["a", ""]),
        ("\n", [""]),
        ("a\nb\nc\n", ["c", "b", "a"]),
        ("a\nb\nc", ["c", "b", "a"]),
        ("a\n\nb\n", ["b", "", "a"]),
    ],
)
def test_iter_lines_reverse_matches_splitlines(service, raw, expected):
    service.path.write_text(raw, encoding="utf-8")
    assert list(service._iter_lines_reverse()) == expected


def test_iter_lines_reverse_across_chunk_boundaries(service):
    lines = [f"line-{index}" for index in range(500)]
    write_lines(service.path, lines)
    assert list(service._iter_lines_reverse(chunk_size=16)) == list(reversed(lines))


def test_count_lines_matches_splitlines(service):
    for raw in ["", "a\n", "a", "a\nb\n", "a\nb", "\n\n"]:
        service.path.write_text(raw, encoding="utf-8")
        assert service._count_lines() == len(raw.splitlines()), raw


def test_list_page_returns_newest_first(service):
    write_lines(service.path, [make_entry(index) for index in range(10)])
    result = service.list_page(page=1, page_size=3)
    assert [item["detail"]["seq"] for item in result["items"]] == [9, 8, 7]
    assert result["page"] == 1
    assert result["page_size"] == 3
    assert result["has_more"] is True


def test_list_page_walks_pages_without_overlap(service):
    write_lines(service.path, [make_entry(index) for index in range(10)])
    seen: list[int] = []
    for page in range(1, 5):
        result = service.list_page(page=page, page_size=3)
        seen.extend(item["detail"]["seq"] for item in result["items"])
    assert seen == list(range(9, -1, -1))


def test_list_page_last_page_has_no_more(service):
    write_lines(service.path, [make_entry(index) for index in range(10)])
    result = service.list_page(page=4, page_size=3)
    assert [item["detail"]["seq"] for item in result["items"]] == [0]
    assert result["has_more"] is False


def test_list_page_exact_multiple_reports_no_more(service):
    write_lines(service.path, [make_entry(index) for index in range(6)])
    assert service.list_page(page=2, page_size=3)["has_more"] is False


def test_list_page_beyond_last_page_is_empty(service):
    write_lines(service.path, [make_entry(index) for index in range(5)])
    result = service.list_page(page=99, page_size=10)
    assert result["items"] == []
    assert result["has_more"] is False


def test_list_page_on_missing_file(service):
    result = service.list_page(page=1, page_size=10)
    assert result == {"items": [], "page": 1, "page_size": 10, "has_more": False}


def test_list_page_normalizes_invalid_paging(service):
    write_lines(service.path, [make_entry(index) for index in range(3)])
    result = service.list_page(page=0, page_size=0)
    assert result["page"] == 1
    assert result["page_size"] == 1
    assert len(result["items"]) == 1


def test_list_page_filters_by_type_and_date(service):
    entries = [
        make_entry(0, type="call", day="2026-07-27"),
        make_entry(1, type="account", day="2026-07-28"),
        make_entry(2, type="call", day="2026-07-28"),
        make_entry(3, type="call", day="2026-07-29"),
    ]
    write_lines(service.path, entries)
    result = service.list_page(type="call", start_date="2026-07-28", end_date="2026-07-28", page_size=10)
    assert [item["detail"]["seq"] for item in result["items"]] == [2]
    assert result["has_more"] is False


def test_list_page_skips_corrupt_lines(service):
    write_lines(service.path, [make_entry(0), "not-json", "[1,2,3]", make_entry(1)])
    result = service.list_page(page_size=10)
    assert [item["detail"]["seq"] for item in result["items"]] == [1, 0]


def test_legacy_entries_keep_line_based_id(service):
    legacy = json.dumps({"time": "2026-07-29 10:00:00", "type": "call", "summary": "old"}, ensure_ascii=False)
    write_lines(service.path, [legacy, make_entry(1)])
    items = service.list_page(page_size=10)["items"]
    assert items[1]["id"] == LogService._legacy_id(legacy, 0)


def test_delete_removes_entry_returned_by_list_page(service):
    legacy = json.dumps({"time": "2026-07-29 10:00:00", "type": "call", "summary": "old"}, ensure_ascii=False)
    write_lines(service.path, [legacy, make_entry(1)])
    target = service.list_page(page_size=10)["items"][1]
    assert service.delete([target["id"]]) == {"removed": 1}
    assert [item["summary"] for item in service.list_page(page_size=10)["items"]] == ["entry-1"]


def test_list_keeps_backward_compatible_signature(service):
    write_lines(service.path, [make_entry(index) for index in range(5)])
    items = service.list(limit=2)
    assert [item["detail"]["seq"] for item in items] == [4, 3]


def test_add_then_list_page_roundtrip(service):
    service.add("call", "hello", {"a": 1})
    service.add("account", "world", {"b": 2})
    result = service.list_page(page_size=10)
    assert [item["summary"] for item in result["items"]] == ["world", "hello"]
    assert result["has_more"] is False


def test_max_scan_lines_caps_deep_scan(service, monkeypatch):
    entries = [make_entry(0, type="account")] + [make_entry(index, type="call") for index in range(1, 50)]
    write_lines(service.path, entries)
    monkeypatch.setattr("services.log_service.MAX_SCAN_LINES", 10)
    result = service.list_page(type="account", page_size=10)
    assert result["items"] == []
