from __future__ import annotations

import threading

import pytest

from services.metrics_service import AiMetricsService


@pytest.fixture
def clock(monkeypatch):
    state = {"now": 1_700_000_000.0}

    def fake_time():
        return state["now"]

    monkeypatch.setattr("services.metrics_service.time.time", fake_time)
    return state


def test_empty_snapshot(clock):
    service = AiMetricsService()
    snapshot = service.snapshot()
    assert snapshot["rpm"] == 0
    assert snapshot["requests"] == 0
    assert snapshot["success"] == 0
    assert snapshot["failed"] == 0
    assert snapshot["avg_duration_ms"] == 0.0
    assert snapshot["by_endpoint"] == []


def test_records_within_window(clock):
    service = AiMetricsService()
    for _ in range(3):
        service.record("/v1/chat/completions", True, 100)
    service.record("/v1/chat/completions", False, 300)
    snapshot = service.snapshot()
    assert snapshot["requests"] == 4
    assert snapshot["rpm"] == 4
    assert snapshot["success"] == 3
    assert snapshot["failed"] == 1
    assert snapshot["avg_duration_ms"] == 150.0


def test_rpm_scales_to_per_minute_for_custom_window(clock):
    service = AiMetricsService()
    for offset in range(120):
        clock["now"] += 1
        service.record("/v1/chat/completions", True, 10)
    assert service.snapshot(window_seconds=120)["rpm"] == 60
    assert service.snapshot(window_seconds=60)["rpm"] == 60


def test_old_records_fall_out_of_window(clock):
    service = AiMetricsService()
    service.record("/v1/chat/completions", True, 10)
    clock["now"] += 61
    snapshot = service.snapshot()
    assert snapshot["requests"] == 0
    assert snapshot["total_requests"] == 1


def test_by_endpoint_aggregation_sorted_by_count(clock):
    service = AiMetricsService()
    service.record("/v1/images/generations", True, 5000)
    for _ in range(3):
        service.record("/v1/chat/completions", True, 100)
    service.record("/v1/chat/completions", False, 500)
    endpoints = service.snapshot()["by_endpoint"]
    assert [item["endpoint"] for item in endpoints] == ["/v1/chat/completions", "/v1/images/generations"]
    assert endpoints[0] == {
        "endpoint": "/v1/chat/completions",
        "count": 4,
        "success": 3,
        "failed": 1,
        "avg_duration_ms": 200.0,
    }
    assert endpoints[1]["avg_duration_ms"] == 5000.0


def test_endpoint_stats_merge_across_seconds(clock):
    service = AiMetricsService()
    service.record("/v1/chat/completions", True, 100)
    clock["now"] += 5
    service.record("/v1/chat/completions", False, 300)
    endpoints = service.snapshot()["by_endpoint"]
    assert endpoints == [
        {
            "endpoint": "/v1/chat/completions",
            "count": 2,
            "success": 1,
            "failed": 1,
            "avg_duration_ms": 200.0,
        }
    ]


def test_trend_length_and_alignment(clock):
    service = AiMetricsService()
    snapshot = service.snapshot(trend_minutes=5)
    assert len(snapshot["trend"]) == 5
    assert all(point["timestamp"] % 60 == 0 for point in snapshot["trend"])
    assert snapshot["trend"][-1]["timestamp"] == int(clock["now"]) - int(clock["now"]) % 60


def test_trend_buckets_requests_by_minute(clock):
    service = AiMetricsService()
    service.record("/v1/chat/completions", True, 10)
    clock["now"] += 120
    service.record("/v1/chat/completions", True, 10)
    service.record("/v1/chat/completions", True, 10)
    trend = service.snapshot(trend_minutes=5)["trend"]
    assert [point["count"] for point in trend[-3:]] == [1, 0, 2]


def test_snapshot_clamps_out_of_range_arguments(clock):
    service = AiMetricsService()
    assert service.snapshot(window_seconds=0)["window_seconds"] == 1
    assert service.snapshot(window_seconds=999_999)["window_seconds"] == 3600
    assert len(service.snapshot(trend_minutes=0)["trend"]) == 1
    assert len(service.snapshot(trend_minutes=999)["trend"]) == 180


def test_ring_buffer_does_not_leak_stale_seconds(clock):
    service = AiMetricsService(capacity_seconds=10)
    service.record("/v1/chat/completions", True, 10)
    clock["now"] += 10
    assert service.snapshot(window_seconds=5)["requests"] == 0


def test_total_requests_accumulates(clock):
    service = AiMetricsService()
    for _ in range(5):
        service.record("/v1/chat/completions", True, 10)
        clock["now"] += 100
    assert service.snapshot()["total_requests"] == 5


def test_concurrent_records_are_not_lost():
    service = AiMetricsService()

    def worker():
        for _ in range(200):
            service.record("/v1/chat/completions", True, 10)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert service.snapshot()["total_requests"] == 1600
