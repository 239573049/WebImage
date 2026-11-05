from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from services.image_runtime_repository import ImageRuntimeRepository
from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}


def wait_for_task(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None) -> ImageTaskService:
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]}),
            retention_days_getter=lambda: 30,
        )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            task = wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            self.assertEqual(calls, 1)

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="private-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_success_task_persists_to_new_service_instance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            service.submit_generation(
                OWNER,
                client_task_id="persisted-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "persisted-task", "success")

            reloaded = self.make_service(path)
            result = reloaded.list_tasks(OWNER, ["persisted-task"])

            self.assertEqual(result["missing_ids"], [])
            self.assertEqual(result["items"][0]["status"], "success")
            self.assertEqual(result["items"][0]["data"][0]["url"], "http://example.test/image.png")

    def test_startup_marks_unfinished_tasks_as_error(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            repository = ImageRuntimeRepository(path.with_suffix(".db"))
            now = time.time()
            repository.insert_task(
                {
                    "id": "running-task",
                    "owner_id": "owner-1",
                    "status": "running",
                    "mode": "generate",
                    "model": "gpt-image-2",
                    "created_at": "2099-01-01 00:00:00",
                    "updated_at": "2099-01-01 00:00:00",
                    "created_ts": now,
                    "updated_ts": now,
                },
                {"prompt": "cat", "model": "gpt-image-2"},
                dict(OWNER),
            )
            repository.insert_task(
                {
                    "id": "resumable-task",
                    "owner_id": "owner-1",
                    "status": "running",
                    "mode": "generate",
                    "model": "gpt-image-2",
                    "conversation_id": "conv-1",
                    "account_key": "deadbeef" * 8,
                    "created_at": "2099-01-01 00:00:00",
                    "updated_at": "2099-01-01 00:00:00",
                    "created_ts": now,
                    "updated_ts": now,
                },
                {"prompt": "dog", "model": "gpt-image-2"},
                dict(OWNER),
            )
            repository.insert_task(
                {
                    "id": "queued-task",
                    "owner_id": "owner-1",
                    "status": "queued",
                    "mode": "generate",
                    "model": "gpt-image-2",
                    "created_at": "2099-01-01 00:00:00",
                    "updated_at": "2099-01-01 00:00:00",
                    "created_ts": now,
                    "updated_ts": now,
                },
                {"prompt": "cat", "model": "gpt-image-2"},
                dict(OWNER),
            )

            service = self.make_service(path)

            # running 且无可恢复上游标识的任务标记为中断错误
            result = service.list_tasks(OWNER, ["running-task"])
            self.assertEqual(result["items"][0]["status"], "error")
            self.assertIn("已中断", result["items"][0]["error"])

            # queued 任务从数据库恢复执行
            task = wait_for_task(service, OWNER, "queued-task", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")

            # running 且已有 conversation_id/account_key 的任务只恢复轮询，不标记中断；
            # 测试环境无对应账号，恢复轮询会快速失败为“无法找回账号”
            resumable = wait_for_task(service, OWNER, "resumable-task", "error", timeout=5.0)
            self.assertNotIn("已中断", str(resumable.get("error") or ""))
            self.assertIn("无法找回", str(resumable.get("error") or ""))

    def test_list_without_ids_is_paginated_but_ids_lookup_is_not(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            for i in range(5):
                service.submit_generation(
                    OWNER,
                    client_task_id=f"page-task-{i}",
                    prompt="cat",
                    model="gpt-image-2",
                    size=None,
                    base_url="http://local.test",
                )
            for i in range(5):
                wait_for_task(service, OWNER, f"page-task-{i}", "success")

            first = service.list_tasks(OWNER, [], page=1, page_size=2)
            self.assertEqual((len(first["items"]), first["total"], first["page_count"]), (2, 5, 3))
            last = service.list_tasks(OWNER, [], page=99, page_size=2)
            self.assertEqual((last["page"], len(last["items"])), (3, 1))
            # 带 ids 的精确查询不受分页影响，也不带分页字段
            ids = [f"page-task-{i}" for i in range(5)]
            by_ids = service.list_tasks(OWNER, ids, page=1, page_size=2)
            self.assertEqual(len(by_ids["items"]), 5)
            self.assertNotIn("total", by_ids)

if __name__ == "__main__":
    unittest.main()
