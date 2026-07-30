from __future__ import annotations

import threading
import time
import unittest
from unittest import mock

from services.account_service import AccountService


class _FakeStorage:
    def __init__(self, accounts):
        self._accounts = accounts

    def load_accounts(self):
        return list(self._accounts)

    def save_accounts(self, accounts):
        self._accounts = list(accounts)

    def load_auth_keys(self):
        return []

    def save_auth_keys(self, auth_keys):
        pass


class _FakeHealthRepo:
    """健康态全部返回 healthy，便于隔离出槽位分配行为。"""

    def __init__(self, states=None):
        self.states = states or {}

    def get_health(self, access_token):
        return {
            "health_score": 100,
            "health_state": self.states.get(access_token, "healthy"),
        }

    def get_health_many(self, access_tokens):
        return {token: self.get_health(token) for token in access_tokens}

    def record_assignment(self, access_token):
        return self.get_health(access_token)


def _make_service(count: int, quota: int = 100, states=None) -> AccountService:
    accounts = [
        {"access_token": f"tok{i}", "status": "正常", "quota": quota, "type": "plus"}
        for i in range(count)
    ]
    service = AccountService(_FakeStorage(accounts))
    service._health = _FakeHealthRepo(states)
    return service


class SlotAllocationTests(unittest.TestCase):
    """取号轮转、不限并发与配额约束。"""

    def _acquire(self, service, n):
        repo = service._health
        with mock.patch("services.account_service.image_runtime_repository", repo):
            return [service._acquire_next_candidate_token() for _ in range(n)]

    def test_consecutive_requests_rotate_across_accounts(self):
        """连续请求应依次落到不同账号，转完一轮再回到第一个。"""
        service = _make_service(5)
        with mock.patch.object(type(service), "_account_max_concurrency", staticmethod(lambda s: 1 << 30)):
            chosen = self._acquire(service, 5)
        self.assertEqual(len(set(chosen)), 5, f"5 个请求应落到 5 个不同账号，实际 {chosen}")

    def test_second_round_reuses_accounts_evenly(self):
        """第二轮继续均摊，每个账号各 2 次。"""
        service = _make_service(4)
        with mock.patch.object(type(service), "_account_max_concurrency", staticmethod(lambda s: 1 << 30)):
            chosen = self._acquire(service, 8)
        for token in {f"tok{i}" for i in range(4)}:
            self.assertEqual(chosen.count(token), 2, f"{token} 分配不均：{chosen}")

    def test_unlimited_concurrency_never_blocks(self):
        """concurrency=0 时并发数远超账号数也不阻塞。"""
        service = _make_service(2)
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            cfg.image_slot_wait_timeout_secs = 5.0
            started = time.time()
            chosen = self._acquire(service, 20)
        self.assertEqual(len(chosen), 20)
        self.assertLess(time.time() - started, 2.0, "不限并发不应触发等待")

    def test_quota_caps_inflight_even_when_unlimited(self):
        """剩余次数耗尽的账号不再被分配，即使不限并发。"""
        service = _make_service(1, quota=3)
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            cfg.image_slot_wait_timeout_secs = 0.0
            repo = service._health
            with mock.patch("services.account_service.image_runtime_repository", repo):
                for _ in range(3):
                    service._acquire_next_candidate_token()
                # 第 4 次：quota=3 已被 3 个在途占满，必须拒绝而不是超发
                with self.assertRaises(RuntimeError):
                    service._acquire_next_candidate_token()

    def test_exhausted_account_is_not_selected(self):
        """quota=0 的账号完全不参与分配。"""
        service = _make_service(2)
        service._accounts["tok0"]["quota"] = 0
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            cfg.image_slot_wait_timeout_secs = 5.0
            chosen = self._acquire(service, 6)
        self.assertNotIn("tok0", chosen)
        self.assertEqual(set(chosen), {"tok1"})

    def test_limited_concurrency_spills_after_timeout(self):
        """有限并发下等待超时后放行，不无限期阻塞。"""
        service = _make_service(1)
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 1
            cfg.image_slot_wait_timeout_secs = 0.3
            repo = service._health
            with mock.patch("services.account_service.image_runtime_repository", repo):
                service._acquire_next_candidate_token()
                started = time.time()
                token = service._acquire_next_candidate_token()
        self.assertEqual(token, "tok0")
        self.assertGreaterEqual(time.time() - started, 0.25, "应先等待再溢出放行")

    def test_probation_account_stays_at_one(self):
        """观察态账号即使不限并发也只给 1 个槽位。"""
        service = _make_service(2, states={"tok0": "probation"})
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            cfg.image_slot_wait_timeout_secs = 5.0
            chosen = self._acquire(service, 6)
        self.assertLessEqual(chosen.count("tok0"), 1, f"观察态账号应限 1 个在途：{chosen}")

    def test_concurrent_acquire_is_thread_safe(self):
        """多线程并发取号不丢计数。"""
        service = _make_service(4)
        results = []
        lock = threading.Lock()

        def worker():
            repo = service._health
            with mock.patch("services.account_service.image_runtime_repository", repo):
                token = service._acquire_next_candidate_token()
            with lock:
                results.append(token)

        with mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            cfg.image_slot_wait_timeout_secs = 5.0
            threads = [threading.Thread(target=worker) for _ in range(16)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)

        self.assertEqual(len(results), 16)
        self.assertEqual(sum(service._image_inflight.values()), 16, "在途计数应与取号次数一致")


class DynamicCapacityTests(unittest.TestCase):
    """调度器动态容量。"""

    def test_capacity_is_bounded_by_quota(self):
        service = _make_service(3, quota=2)
        with mock.patch("services.account_service.image_runtime_repository", service._health), \
             mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            # 不限并发时容量由剩余次数封顶：3 账号 × 2 次 = 6
            self.assertEqual(service.image_dynamic_capacity(), 6)

    def test_capacity_uses_configured_concurrency(self):
        service = _make_service(3, quota=100)
        with mock.patch("services.account_service.image_runtime_repository", service._health), \
             mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 3
            self.assertEqual(service.image_dynamic_capacity(), 9)

    def test_exhausted_accounts_contribute_zero(self):
        service = _make_service(2, quota=0)
        with mock.patch("services.account_service.image_runtime_repository", service._health), \
             mock.patch("services.account_service.config") as cfg:
            cfg.image_account_concurrency = 0
            self.assertEqual(service.image_dynamic_capacity(), 0)


if __name__ == "__main__":
    unittest.main()
