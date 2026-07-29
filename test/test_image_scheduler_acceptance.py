from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from services.account_service import account_service
from services.image_runtime_repository import ImageRuntimeRepository


class _FakeHealthRepo:
    """只提供 get_health 的假仓库，用于调度均衡测试。"""

    def __init__(self, scores: dict[str, int]):
        self.scores = scores

    def get_health(self, access_token: str) -> dict[str, object]:
        return {"health_score": self.scores.get(access_token, 100), "health_state": "healthy"}


class SchedulerBalanceTests(unittest.TestCase):
    """健康优先平滑加权轮询的均衡性验收。"""

    def _run_selection(self, scores: dict[str, int], rounds: int) -> dict[str, int]:
        tokens = list(scores)
        counts = {token: 0 for token in tokens}
        saved = dict(account_service._image_scheduler_current)
        account_service._image_scheduler_current.clear()
        try:
            with mock.patch("services.account_service.image_runtime_repository", _FakeHealthRepo(scores)):
                for _ in range(rounds):
                    chosen = account_service._select_image_candidate(tokens)
                    counts[chosen] += 1
        finally:
            account_service._image_scheduler_current.clear()
            account_service._image_scheduler_current.update(saved)
        return counts

    def test_equal_health_accounts_get_even_assignments(self):
        scores = {f"token-{index}": 100 for index in range(10)}
        counts = self._run_selection(scores, 1000)
        self.assertEqual(sum(counts.values()), 1000)
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)

    def test_health_100_vs_50_ratio_is_about_4_to_1(self):
        counts = self._run_selection({"token-hi": 100, "token-lo": 50}, 1000)
        # weight = (score/100)^2 → 1 : 0.25，期望 800:200，允许 ±5%
        self.assertAlmostEqual(counts["token-hi"] / 1000, 0.8, delta=0.05)
        self.assertAlmostEqual(counts["token-lo"] / 1000, 0.2, delta=0.05)


class HealthClassificationTests(unittest.TestCase):
    """健康结果分类与熔断/半开语义验收。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = ImageRuntimeRepository(Path(self._tmp.name) / "runtime.db")

    def test_rate_limit_opens_circuit_with_cooldown(self):
        health = self.repo.record_health_result("acct", False, failure_kind="rate_limit")
        self.assertEqual(health["health_state"], "open")
        self.assertGreater(float(health["health_cooldown_until"] or 0), time.time())

    def test_rate_limit_honors_restore_at(self):
        restore_at = time.time() + 120
        health = self.repo.record_health_result(
            "acct", False, failure_kind="rate_limit", cooldown_until=restore_at,
        )
        self.assertAlmostEqual(float(health["health_cooldown_until"] or 0), restore_at, delta=1.0)

    def test_open_transitions_to_half_open_after_cooldown(self):
        self.repo.record_health_result("acct", False, failure_kind="rate_limit", cooldown_until=time.time() + 0.05)
        time.sleep(0.1)
        self.assertEqual(self.repo.get_health("acct")["health_state"], "half_open")

    def test_auth_refreshed_enters_half_open(self):
        health = self.repo.record_health_result("acct", False, failure_kind="auth_refreshed")
        self.assertEqual(health["health_state"], "half_open")

    def test_half_open_success_recovers_account(self):
        self.repo.record_health_result("acct", False, failure_kind="auth_refreshed")
        health = self.repo.record_health_result("acct", True, latency_ms=1000)
        self.assertEqual(health["health_consecutive_failures"], 0)
        self.assertGreaterEqual(int(health["health_score"]), 60)
        self.assertNotIn(health["health_state"], ("open", "half_open"))

    def test_three_transient_failures_open_circuit(self):
        for _ in range(3):
            health = self.repo.record_health_result("acct", False, failure_kind="transient")
        self.assertEqual(health["health_state"], "open")
        self.assertGreater(float(health["health_cooldown_until"] or 0), time.time())

    def test_neutral_failure_does_not_affect_health(self):
        before = self.repo.get_health("acct")
        after = self.repo.record_health_result("acct", False, failure_kind="neutral", error="policy")
        self.assertEqual(before["health_score"], after["health_score"])
        self.assertEqual(after["health_state"], "healthy")
        self.assertEqual(after["health_consecutive_failures"], 0)

    def test_reopen_doubles_cooldown_window(self):
        # 第一次熔断：窗口 300s
        for _ in range(3):
            self.repo.record_health_result("acct", False, failure_kind="transient")
        first = self.repo.get_health("acct")
        first_window = float(first["health_cooldown_until"] or 0) - time.time()
        self.assertAlmostEqual(first_window, 300.0, delta=5.0)
        # 冷却结束进入 half_open 后再次失败：窗口翻倍到 600s
        with self.repo._connect() as conn:
            conn.execute("UPDATE image_account_health SET cooldown_until=?", (time.time() - 1,))
        self.assertEqual(self.repo.get_health("acct")["health_state"], "half_open")
        second = self.repo.record_health_result("acct", False, failure_kind="transient")
        second_window = float(second["health_cooldown_until"] or 0) - time.time()
        self.assertAlmostEqual(second_window, 600.0, delta=5.0)


class ConcurrentSqliteTests(unittest.TestCase):
    """50 并发任务入库不出现 database is locked。"""

    def test_50_concurrent_inserts_and_updates(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo = ImageRuntimeRepository(Path(tmp_dir) / "runtime.db")
            errors: list[Exception] = []

            def worker(index: int) -> None:
                try:
                    now = time.time()
                    task = {
                        "id": f"task-{index}",
                        "owner_id": "owner",
                        "status": "queued",
                        "created_ts": now,
                        "updated_ts": now,
                    }
                    repo.insert_task(task, {"prompt": f"p{index}"}, {"id": "owner"})
                    repo.update_task("owner", f"task-{index}", status="running")
                    repo.update_task("owner", f"task-{index}", status="success", data=[{"url": "u"}])
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading.Thread(target=worker, args=(index,)) for index in range(50)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)

            self.assertEqual(errors, [], f"并发写入出错: {errors[:3]}")
            tasks = repo.list_tasks("owner")
            self.assertEqual(len(tasks), 50)
            self.assertTrue(all(task["status"] == "success" for task in tasks))

    def test_insert_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo = ImageRuntimeRepository(Path(tmp_dir) / "runtime.db")
            now = time.time()
            task = {"id": "dup", "owner_id": "owner", "status": "queued", "created_ts": now, "updated_ts": now}
            self.assertTrue(repo.insert_task(task, {}, {}))
            self.assertFalse(repo.insert_task(task, {}, {}))


if __name__ == "__main__":
    unittest.main()
