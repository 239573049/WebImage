from __future__ import annotations

import threading
import unittest
from collections import Counter
from unittest import mock

from services.account_service import AccountService, ImageQuotaBusyError


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
    """健康态可控的假仓库，便于隔离出槽位分配行为。"""

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


def _make_service(plans, quota: int = 1000, states=None) -> AccountService:
    accounts = [
        {"access_token": f"tok{i}", "status": "正常", "quota": quota, "type": plan}
        for i, plan in enumerate(plans)
    ]
    service = AccountService(_FakeStorage(accounts))
    service._health = _FakeHealthRepo(states)
    return service


def _drain(service, limit: int = 200):
    """一直取号直到 429，返回已分配的 token 列表。"""
    got = []
    with mock.patch("services.account_service.image_runtime_repository", service._health):
        for _ in range(limit):
            try:
                got.append(service._acquire_next_candidate_token())
            except ImageQuotaBusyError:
                return got, True
    return got, False


class PlanConcurrencyTests(unittest.TestCase):
    """按套餐类型的单账号并发上限。"""

    def test_free_account_allows_one(self):
        service = _make_service(["free"])
        got, busy = _drain(service)
        self.assertEqual(len(got), 1, "free 账号应只允许 1 个并发")
        self.assertTrue(busy)

    def test_plus_team_k12_allow_two(self):
        for plan in ("plus", "team", "k12"):
            with self.subTest(plan=plan):
                service = _make_service([plan])
                got, busy = _drain(service)
                self.assertEqual(len(got), 2, f"{plan} 账号应允许 2 个并发")
                self.assertTrue(busy)

    def test_pro_account_allows_five(self):
        service = _make_service(["pro"])
        got, busy = _drain(service)
        self.assertEqual(len(got), 5, "pro 账号应允许 5 个并发")
        self.assertTrue(busy)

    def test_mixed_pool_respects_each_plan(self):
        service = _make_service(["free", "plus", "team", "k12", "pro"])
        got, busy = _drain(service)
        counts = Counter(got)
        self.assertTrue(busy)
        self.assertEqual(counts["tok0"], 1, "free")
        self.assertEqual(counts["tok1"], 2, "plus")
        self.assertEqual(counts["tok2"], 2, "team")
        self.assertEqual(counts["tok3"], 2, "k12")
        self.assertEqual(counts["tok4"], 5, "pro")
        self.assertEqual(len(got), 12, "总容量应为 1+2+2+2+5")

    def test_plan_limit_is_configurable(self):
        service = _make_service(["pro"])
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_plan_concurrency = {"Pro": 3}
            cfg.image_account_concurrency = 1
            got, busy = _drain(service)
        self.assertEqual(len(got), 3, "应使用配置里的 Pro=3 而非默认 5")
        self.assertTrue(busy)

    def test_unknown_plan_falls_back(self):
        service = _make_service(["mystery-plan"])
        with mock.patch("services.account_service.config") as cfg:
            cfg.image_plan_concurrency = {"Pro": 5}
            cfg.image_account_concurrency = 2
            got, busy = _drain(service)
        self.assertEqual(len(got), 2, "未知套餐应回退到 image_account_concurrency")
        self.assertTrue(busy)

    def test_probation_account_stays_at_one(self):
        service = _make_service(["pro"], states={"tok0": "probation"})
        got, busy = _drain(service)
        self.assertEqual(len(got), 1, "观察态账号无论套餐都只给 1 个槽位")
        self.assertTrue(busy)


class BusyRejectionTests(unittest.TestCase):
    """满载即 429，不排队。"""

    def test_raises_busy_instead_of_blocking(self):
        service = _make_service(["free"])
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            service._acquire_next_candidate_token()
            with self.assertRaises(ImageQuotaBusyError):
                service._acquire_next_candidate_token()

    def test_busy_error_is_distinct_from_no_account(self):
        """账号忙 (429) 与无可用账号 (502) 必须区分开。"""
        service = _make_service(["free"], quota=0)
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            with self.assertRaises(RuntimeError) as ctx:
                service._acquire_next_candidate_token()
        self.assertNotIsInstance(ctx.exception, ImageQuotaBusyError)

    def test_slot_released_on_settlement_allows_next(self):
        """槽位要到请求结算后才释放。"""
        service = _make_service(["free"])
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            token = service._acquire_next_candidate_token()
            with self.assertRaises(ImageQuotaBusyError):
                service._acquire_next_candidate_token()
            service.release_image_slot(token)
            self.assertEqual(service._acquire_next_candidate_token(), token)

    def test_exhausted_quota_account_never_selected(self):
        service = _make_service(["pro", "pro"])
        service._accounts["tok0"]["quota"] = 0
        got, _ = _drain(service)
        self.assertNotIn("tok0", got)

    def test_quota_caps_inflight_below_plan_limit(self):
        """剩余次数少于套餐并发上限时，以剩余次数为准。"""
        service = _make_service(["pro"], quota=2)
        got, busy = _drain(service)
        self.assertEqual(len(got), 2, "quota=2 应盖过 Pro=5")
        self.assertTrue(busy)


class RotationTests(unittest.TestCase):
    """账号轮转分配。"""

    def test_consecutive_requests_rotate(self):
        service = _make_service(["pro"] * 5)
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            got = [service._acquire_next_candidate_token() for _ in range(5)]
        self.assertEqual(len(set(got)), 5, f"5 个请求应落到 5 个不同账号：{got}")

    def test_load_spreads_evenly(self):
        service = _make_service(["pro"] * 4)
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            got = [service._acquire_next_candidate_token() for _ in range(12)]
        counts = Counter(got)
        self.assertEqual(set(counts.values()), {3}, f"应均摊到每账号 3 个：{counts}")

    def test_concurrent_acquire_is_thread_safe(self):
        service = _make_service(["pro"] * 4)
        results = []
        lock = threading.Lock()

        def worker():
            try:
                with mock.patch("services.account_service.image_runtime_repository", service._health):
                    token = service._acquire_next_candidate_token()
            except ImageQuotaBusyError:
                return
            with lock:
                results.append(token)

        threads = [threading.Thread(target=worker) for _ in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(len(results), 20, "4 个 Pro 账号共 20 槽，20 个请求应全部放行")
        self.assertEqual(sum(service._image_inflight.values()), 20, "在途计数应与放行数一致")


class DynamicCapacityTests(unittest.TestCase):
    """调度器动态容量。"""

    def test_capacity_sums_plan_limits(self):
        service = _make_service(["free", "plus", "pro"])
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            self.assertEqual(service.image_dynamic_capacity(), 8, "1 + 2 + 5")

    def test_capacity_bounded_by_quota(self):
        service = _make_service(["pro", "pro"], quota=1)
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            self.assertEqual(service.image_dynamic_capacity(), 2, "每账号剩余 1 次")

    def test_exhausted_accounts_contribute_zero(self):
        service = _make_service(["pro"], quota=0)
        with mock.patch("services.account_service.image_runtime_repository", service._health):
            self.assertEqual(service.image_dynamic_capacity(), 0)


class BusyErrorMappingTests(unittest.TestCase):
    """忙碌错误映射为 HTTP 429。"""

    def test_maps_to_429_response(self):
        from services.protocol.conversation import (
            ConversationRequest,
            ImageGenerationError,
            _generate_single_image,
        )

        request = ConversationRequest(prompt="a cat", model="gpt-image-2")
        with mock.patch("services.protocol.conversation.account_service") as account:
            account.get_available_access_token.side_effect = ImageQuotaBusyError("all busy")
            with self.assertRaises(ImageGenerationError) as ctx:
                list(_generate_single_image(request, 1, 1))

        error = ctx.exception
        self.assertEqual(error.status_code, 429)
        self.assertEqual(error.error_type, "rate_limit_error")
        self.assertEqual(error.code, "rate_limit_exceeded")

    def test_no_account_still_maps_to_502(self):
        from services.protocol.conversation import (
            ConversationRequest,
            ImageGenerationError,
            _generate_single_image,
        )

        request = ConversationRequest(prompt="a cat", model="gpt-image-2")
        with mock.patch("services.protocol.conversation.account_service") as account:
            account.get_available_access_token.side_effect = RuntimeError("no available image quota")
            with self.assertRaises(ImageGenerationError) as ctx:
                list(_generate_single_image(request, 1, 1))

        self.assertEqual(ctx.exception.status_code, 502, "无可用账号不应报 429")


if __name__ == "__main__":
    unittest.main()
