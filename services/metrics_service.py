from __future__ import annotations

import threading
import time
from typing import Any

WINDOW_SECONDS = 60
TREND_MINUTES = 30
MAX_TREND_MINUTES = 180
MAX_WINDOW_SECONDS = 3600


class _Bucket:
    __slots__ = ("second", "total", "success", "failed", "duration_sum", "by_endpoint")

    def __init__(self) -> None:
        self.second = -1
        self.total = 0
        self.success = 0
        self.failed = 0
        self.duration_sum = 0.0
        self.by_endpoint: dict[str, list[float]] = {}

    def reset(self, second: int) -> None:
        self.second = second
        self.total = 0
        self.success = 0
        self.failed = 0
        self.duration_sum = 0.0
        self.by_endpoint = {}


class AiMetricsService:
    """按秒分桶的进程内滑动窗口统计，仅覆盖 AI 调用接口；重启后清零。"""

    def __init__(self, capacity_seconds: int = MAX_TREND_MINUTES * 60) -> None:
        self.capacity = capacity_seconds
        self._buckets = [_Bucket() for _ in range(capacity_seconds)]
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._total_requests = 0

    def _bucket_for(self, second: int) -> _Bucket:
        bucket = self._buckets[second % self.capacity]
        if bucket.second != second:
            bucket.reset(second)
        return bucket

    def record(self, endpoint: str, ok: bool, duration_ms: float) -> None:
        second = int(time.time())
        with self._lock:
            bucket = self._bucket_for(second)
            bucket.total += 1
            bucket.duration_sum += duration_ms
            if ok:
                bucket.success += 1
            else:
                bucket.failed += 1
            stats = bucket.by_endpoint.get(endpoint)
            if stats is None:
                stats = [0.0, 0.0, 0.0, 0.0]
                bucket.by_endpoint[endpoint] = stats
            stats[0] += 1
            stats[1] += 1 if ok else 0
            stats[2] += 0 if ok else 1
            stats[3] += duration_ms
            self._total_requests += 1

    def snapshot(self, window_seconds: int = WINDOW_SECONDS, trend_minutes: int = TREND_MINUTES) -> dict[str, Any]:
        window_seconds = min(MAX_WINDOW_SECONDS, max(1, window_seconds))
        trend_minutes = min(MAX_TREND_MINUTES, max(1, trend_minutes))
        now = int(time.time())
        oldest_window = now - window_seconds + 1
        current_minute = now - now % 60
        first_minute = current_minute - (trend_minutes - 1) * 60

        total = success = failed = 0
        duration_sum = 0.0
        endpoints: dict[str, list[float]] = {}
        trend_counts: dict[int, int] = {}

        with self._lock:
            for bucket in self._buckets:
                if bucket.second < first_minute or bucket.second > now or bucket.total == 0:
                    continue
                minute = bucket.second - bucket.second % 60
                trend_counts[minute] = trend_counts.get(minute, 0) + bucket.total
                if bucket.second < oldest_window:
                    continue
                total += bucket.total
                success += bucket.success
                failed += bucket.failed
                duration_sum += bucket.duration_sum
                for endpoint, stats in bucket.by_endpoint.items():
                    merged = endpoints.get(endpoint)
                    if merged is None:
                        merged = [0.0, 0.0, 0.0, 0.0]
                        endpoints[endpoint] = merged
                    for index in range(4):
                        merged[index] += stats[index]
            total_requests = self._total_requests
            started_at = self._started_at

        by_endpoint = [
            {
                "endpoint": endpoint,
                "count": int(stats[0]),
                "success": int(stats[1]),
                "failed": int(stats[2]),
                "avg_duration_ms": round(stats[3] / stats[0], 2) if stats[0] else 0.0,
            }
            for endpoint, stats in endpoints.items()
        ]
        by_endpoint.sort(key=lambda item: item["count"], reverse=True)

        trend = [
            {
                "minute": time.strftime("%H:%M", time.localtime(minute)),
                "timestamp": minute,
                "count": trend_counts.get(minute, 0),
            }
            for minute in range(first_minute, current_minute + 60, 60)
        ]

        return {
            "window_seconds": window_seconds,
            "rpm": round(total * 60 / window_seconds, 2),
            "requests": total,
            "success": success,
            "failed": failed,
            "avg_duration_ms": round(duration_sum / total, 2) if total else 0.0,
            "by_endpoint": by_endpoint,
            "trend": trend,
            "total_requests": total_requests,
            "uptime_seconds": round(time.time() - started_at, 2),
            "server_time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
        }


ai_metrics = AiMetricsService()
