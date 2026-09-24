from __future__ import annotations

import base64
import hashlib
import os
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.log_service import LOG_TYPE_CALL, log_service
from services.image_runtime_repository import ImageRuntimeRepository, image_runtime_repository
from services.protocol import openai_v1_image_edit, openai_v1_image_generations

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "quality": task.get("quality"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("conversation_id"):
        item["conversation_id"] = task.get("conversation_id")
    if task.get("data") is not None:
        item["data"] = task.get("data")
    if task.get("usage") is not None:
        item["usage"] = task.get("usage")
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("progress"):
        item["progress"] = task.get("progress")
    if task.get("duration_ms") is not None:
        item["duration_ms"] = task.get("duration_ms")
    if isinstance(task.get("stage_timings_ms"), dict):
        item["stage_timings_ms"] = task.get("stage_timings_ms")
    if task.get("status") in (TASK_STATUS_RUNNING, TASK_STATUS_QUEUED):
        if task.get("status") == TASK_STATUS_RUNNING:
            # RUNNING 状态仅在 started_ts 被设置后（image_stream_resolve_start）才计时
            base_ts = task.get("started_ts")
        else:
            # QUEUED 状态从 created_ts 开始计时（排队等待中）
            base_ts = task.get("created_ts") or task.get("updated_ts")
        if base_ts:
            item["elapsed_secs"] = round(time.time() - base_ts, 1)
    return item


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
        repository: ImageRuntimeRepository | None = None,
        max_workers: int | None = None,
    ):
        self.path = path
        runtime_path = path if path.suffix == ".db" else path.with_suffix(".db")
        self.repository = repository or ImageRuntimeRepository(runtime_path)
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers or config.image_scheduler_max_workers,
            thread_name_prefix="image-task",
        )
        self._active = 0
        self._submitted: set[str] = set()
        self._wake = threading.Event()
        self._sweep_lock = threading.Lock()
        self._inputs_dir = self.repository.path.parent / "image_task_inputs"
        self._inputs_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            resumable = self._recover_unfinished_locked()
            self._cleanup_locked()
        self._sweep_orphan_inputs()
        self._dispatcher = threading.Thread(
            target=self._dispatch_loop, name="image-task-dispatcher", daemon=True,
        )
        self._dispatcher.start()
        self._wake.set()
        # running 且已有 conversation_id/account_key 的任务只恢复轮询，避免重复生成
        for key, task in resumable:
            bundle = self.repository.get_task_bundle(str(task["owner_id"]), str(task["id"]))
            identity = bundle[2] if bundle else {"id": task.get("owner_id")}
            self._executor.submit(
                self._run_resume_poll,
                key,
                _clean(task.get("conversation_id")),
                float(config.image_poll_timeout_secs),
                identity,
                str(task.get("mode") or "generate"),
                _clean(task.get("model"), config.default_image_model),
            )

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
        images: list[tuple[bytes, str, str]] | None = None,
        masks: list[tuple[bytes, str, str]] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "images": images or [],
            "mask": masks or [],
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            if self._cleanup_locked():
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(_public_task(task))
            if not requested_ids:
                items = [
                    _public_task(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def runtime_stats(self) -> dict[str, object]:
        stats = self.repository.task_stats()
        with self._lock:
            active = self._active
            submitted = len(self._submitted)
        return {
            **stats,
            "workers_active": active,
            "workers_submitted": submitted,
            "workers_max": config.image_scheduler_max_workers,
            "workers_dynamic_limit": self._dynamic_worker_limit(),
            "oldest_queued_secs": round(self.repository.oldest_queued_age_secs(), 1),
        }

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        should_start = False
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return _public_task(task)
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "model": _clean(payload.get("model"), config.default_image_model),
                "size": _clean(payload.get("size")),
                "quality": _clean(payload.get("quality"), "auto"),
                "created_at": now,
                "updated_at": now,
                "created_ts": time.time(),
                "updated_ts": time.time(),
            }
            persisted_payload = self._persist_payload(owner, task_id, payload)
            should_start = self.repository.insert_task(task, persisted_payload, dict(identity))
            if should_start:
                self._tasks[key] = task

        if should_start:
            # 入库后由调度器按动态并发上限分页拉起
            self._wake.set()
        return _public_task(task)

    def _dynamic_worker_limit(self) -> int:
        """动态执行上限：所有可用账号容量之和与硬上限的较小值。"""
        hard_limit = config.image_scheduler_max_workers
        try:
            from services.account_service import account_service
            capacity = account_service.image_dynamic_capacity()
        except Exception:
            capacity = 0
        # 容量为 0（无账号或全部熔断）时保留 1 个 worker 快速失败，避免任务永久滞留
        return max(1, min(hard_limit, capacity)) if capacity > 0 else 1

    def _dispatch_loop(self) -> None:
        while True:
            self._wake.wait(timeout=2.0)
            self._wake.clear()
            try:
                self._dispatch_once()
            except Exception:
                pass

    def _dispatch_once(self) -> None:
        # 内存中没有 queued 任务时直接返回，避免空闲时反复打开数据库连接
        with self._lock:
            has_queued = any(
                task.get("status") == TASK_STATUS_QUEUED for task in self._tasks.values()
            )
        if not has_queued:
            return
        # 每次只分页读取最多 100 个 queued 任务，避免排队增长导致内存增长
        candidates = self.repository.queued_task_keys(limit=100)
        if not candidates:
            return
        limit = self._dynamic_worker_limit()
        with self._lock:
            budget = limit - len(self._submitted)
        if budget <= 0:
            return
        for owner_id, task_id in candidates:
            if budget <= 0:
                break
            key = _task_key(owner_id, task_id)
            with self._lock:
                if key in self._submitted:
                    continue
                memory_task = self._tasks.get(key)
            if memory_task is not None and memory_task.get("status") != TASK_STATUS_QUEUED:
                continue
            bundle = self.repository.get_task_bundle(owner_id, task_id)
            if not bundle:
                continue
            task, payload, identity = bundle
            if str(task.get("status") or "") != TASK_STATUS_QUEUED:
                continue
            if memory_task is None:
                with self._lock:
                    self._tasks.setdefault(key, {k: v for k, v in task.items()})
            self._start(key, str(task.get("mode") or "generate"), self._restore_payload(payload), identity)
            budget -= 1

    def _start(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
    ) -> None:
        with self._lock:
            if key in self._submitted:
                return
            self._submitted.add(key)
        model = _clean(payload.get("model"), config.default_image_model)

        def runner() -> None:
            with self._lock:
                self._active += 1
            try:
                self._run_task(key, mode, payload, identity, model)
            finally:
                with self._lock:
                    self._active = max(0, self._active - 1)
                    self._submitted.discard(key)
                self._wake.set()
                # 任务终态后释放不再被引用的参考图暂存文件
                self._sweep_orphan_inputs()

        self._executor.submit(runner)

    def _persist_payload(self, owner: str, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        persisted = dict(payload)
        for field in ("images", "mask"):
            values = payload.get(field)
            if not isinstance(values, list):
                continue
            entries: list[dict[str, str]] = []
            for item in values:
                if not isinstance(item, tuple) or len(item) != 3:
                    continue
                content, filename, content_type = item
                raw = bytes(content)
                # 按 SHA-256 内容寻址：多个任务引用同一份参考图时共享同一文件
                digest = hashlib.sha256(raw).hexdigest()
                input_path = self._inputs_dir / f"{digest}.bin"
                if input_path.is_file():
                    # 复用旧文件时刷新 mtime，避免被无引用清理误删（清理只处理超过宽限期的文件）
                    try:
                        os.utime(input_path, None)
                    except OSError:
                        pass
                else:
                    tmp_path = input_path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
                    tmp_path.write_bytes(raw)
                    os.replace(tmp_path, input_path)
                entries.append(
                    {
                        "_input_path": str(input_path),
                        "filename": str(filename),
                        "content_type": str(content_type),
                    }
                )
            persisted[field] = entries
        return persisted

    def _sweep_orphan_inputs(self, grace_secs: float = 60.0) -> None:
        """删除不再被任何未终态任务引用的参考图暂存文件。

        仅清理 mtime 超过宽限期的文件，避免与"文件已写入但任务尚未入库"的窗口竞争。
        """
        if not self._sweep_lock.acquire(blocking=False):
            return
        try:
            if not self._inputs_dir.is_dir():
                return
            now = time.time()
            candidates: list[Path] = []
            for file in self._inputs_dir.glob("*.bin"):
                try:
                    if now - file.stat().st_mtime >= grace_secs:
                        candidates.append(file)
                except OSError:
                    continue
            if not candidates:
                return
            referenced = self.repository.unfinished_input_paths()
            for file in candidates:
                if str(file) in referenced:
                    continue
                try:
                    file.unlink()
                except OSError:
                    continue
        except Exception:
            pass
        finally:
            self._sweep_lock.release()

    @staticmethod
    def _restore_payload(payload: dict[str, Any]) -> dict[str, Any]:
        restored = dict(payload)
        for field in ("images", "mask"):
            values = payload.get(field)
            if not isinstance(values, list):
                continue
            entries: list[tuple[bytes, str, str]] = []
            for item in values:
                if not isinstance(item, dict) or not item.get("_input_path"):
                    continue
                path = Path(str(item["_input_path"]))
                if path.is_file():
                    entries.append(
                        (
                            path.read_bytes(),
                            str(item.get("filename") or path.name),
                            str(item.get("content_type") or "application/octet-stream"),
                        )
                    )
            restored[field] = entries
        return restored

    def _run_task(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
    ) -> None:
        started = time.time()
        self._update_task(key, status=TASK_STATUS_RUNNING, error="")
        with self._lock:
            task_created_ts = float((self._tasks.get(key) or {}).get("created_ts") or started)
        # 阶段耗时埋点：记录每个进度步骤的到达时间，终态时汇总各阶段耗时
        stage_marks: list[tuple[str, float]] = []
        # 创建进度回调，每个步骤完成后更新任务状态
        def progress_callback(step: str) -> None:
            stage_marks.append((step, time.time()))
            if step == "image_stream_resolve_start":
                self._update_task(key, started_ts=time.time())
            self._update_task(key, progress=step)

        def stage_timings(finished: float) -> dict[str, int]:
            timings: dict[str, int] = {"queue": max(0, int((started - task_created_ts) * 1000))}
            for position, (step, ts) in enumerate(stage_marks):
                next_ts = stage_marks[position + 1][1] if position + 1 < len(stage_marks) else finished
                timings[step] = timings.get(step, 0) + max(0, int((next_ts - ts) * 1000))
            timings["total"] = max(0, int((finished - task_created_ts) * 1000))
            return timings
        # 元信息回调：记录 account_key/conversation_id，供重启恢复轮询使用
        def meta_callback(meta: dict[str, Any]) -> None:
            updates = {
                field: _clean(meta.get(field))
                for field in ("account_key", "conversation_id")
                if _clean(meta.get(field))
            }
            if updates:
                self._update_task(key, **updates)
        # 将进度回调添加到 payload 中（handler 会提取并传递给 ConversationRequest）
        payload_with_progress = {**payload, "progress_callback": progress_callback, "meta_callback": meta_callback}
        try:
            handler = self.edit_handler if mode == "edit" else self.generation_handler
            result = handler(payload_with_progress)
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            data = result.get("data")
            account_email = _clean(result.get("_account_email") or result.get("account_email"))
            if not isinstance(data, list) or not data:
                upstream = _clean(result.get("message"))
                if upstream:
                    message = upstream
                else:
                    message = "号池中没有可用账号或所有账号均被限流，请检查号池状态（账号额度、是否被封禁、是否到达生图上限）"
                error = RuntimeError(message)
                if account_email:
                    setattr(error, "account_email", account_email)
                raise error
            usage = result.get("usage")
            finished = time.time()
            duration_ms = int((finished - started) * 1000)
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, usage=usage, error="", duration_ms=duration_ms,
                              stage_timings_ms=stage_timings(finished))
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=_collect_image_urls(data),
                account_email=account_email,
            )
        except Exception as exc:
            error_message = str(exc) or "image task failed"
            account_email = _clean(getattr(exc, "account_email", ""))
            conversation_id = _clean(getattr(exc, "conversation_id", ""))
            finished = time.time()
            duration_ms = int((finished - started) * 1000)
            self._update_task(key, status=TASK_STATUS_ERROR, error=error_message, data=[],
                              duration_ms=duration_ms,
                              stage_timings_ms=stage_timings(finished),
                              **({"conversation_id": conversation_id} if conversation_id else {}))
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_text(payload.get("prompt")),
                status="failed",
                error=error_message,
                account_email=account_email,
            )

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
        account_email: str = "",
    ) -> None:
        endpoint = "/v1/images/edits" if mode == "edit" else "/v1/images/generations"
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if account_email:
            detail["account_email"] = account_email
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            task["updated_ts"] = time.time()
            owner, task_id = key.split(":", 1)
            self.repository.update_task(owner, task_id, **updates, updated_at=task["updated_at"])

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        tasks: dict[str, dict[str, Any]] = {}
        for item in self.repository.list_all_tasks():
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                status = TASK_STATUS_ERROR
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "model": _clean(item.get("model"), config.default_image_model),
                "size": _clean(item.get("size")),
                "quality": _clean(item.get("quality"), "auto"),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
                "created_ts": item.get("created_ts"),
                "updated_ts": item.get("updated_ts"),
                "started_ts": item.get("started_ts"),
                "duration_ms": item.get("duration_ms"),
            }
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            usage = item.get("usage")
            if isinstance(usage, dict):
                task["usage"] = usage
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            for extra_field in ("conversation_id", "account_key", "progress"):
                value = _clean(item.get(extra_field))
                if value:
                    task[extra_field] = value
            timings = item.get("stage_timings_ms")
            if isinstance(timings, dict):
                task["stage_timings_ms"] = timings
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        for task in self._tasks.values():
            self.repository.update_task(
                str(task.get("owner_id") or ""),
                str(task.get("id") or ""),
                **{key: value for key, value in task.items() if key not in {"owner_id", "id"}},
            )

    def _recover_unfinished_locked(self) -> list[tuple[str, dict[str, Any]]]:
        """处理重启后的 running 任务：可恢复的返回待续轮询列表，否则标记中断。"""
        resumable: list[tuple[str, dict[str, Any]]] = []
        for key, task in self._tasks.items():
            if task.get("status") != TASK_STATUS_RUNNING:
                continue
            if _clean(task.get("conversation_id")) and _clean(task.get("account_key")):
                resumable.append((key, task))
                continue
            task["status"] = TASK_STATUS_ERROR
            task["error"] = "服务已重启，未完成的图片任务已中断"
            task["updated_at"] = _now_iso()
            self.repository.update_task(
                str(task.get("owner_id") or ""),
                str(task.get("id") or ""),
                status=TASK_STATUS_ERROR,
                error=task["error"],
                updated_at=task["updated_at"],
            )
        return resumable

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        if removed_keys:
            self.repository.delete_old_tasks(cutoff)
        return bool(removed_keys)

    def resume_poll(
        self,
        identity: dict[str, object],
        task_id: str,
        extra_timeout_secs: float = 30.0,
    ) -> dict[str, Any]:
        """恢复对已超时任务的轮询，额外等待 extra_timeout_secs 秒。"""
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("task is not in error state")
            error_msg = _clean(task.get("error"))
            if "超时" not in error_msg:
                raise ValueError("task error is not a timeout error")
            conversation_id = _clean(task.get("conversation_id"))
            if not conversation_id:
                raise ValueError("task has no conversation_id")
            mode = task.get("mode", "generate")
            model = task.get("model", config.default_image_model)
            # 将任务状态重置为 running
            self._update_task(key, status=TASK_STATUS_RUNNING, error="")

        self._executor.submit(
            self._run_resume_poll,
            key,
            conversation_id,
            extra_timeout_secs,
            dict(identity),
            mode,
            model,
        )
        return _public_task(task)

    def _run_resume_poll(
        self,
        key: str,
        conversation_id: str,
        extra_timeout_secs: float,
        identity: dict[str, object],
        mode: str,
        model: str,
    ) -> None:
        """后台线程：继续轮询已有 conversation_id 的图片结果。"""
        started = time.time()
        backend = None
        try:
            from services.account_service import account_service
            from services.openai_backend_api import OpenAIBackendAPI
            from services.protocol.conversation import format_image_result

            owner_id, task_id = key.split(":", 1)
            task_record = self.repository.get_task(owner_id=owner_id, task_id=task_id) or {}
            # 通过 task 的 account_key 找回原账号；token rotation 时引用已同步迁移
            access_token = account_service.find_token_by_account_key(_clean(task_record.get("account_key")))
            if not access_token:
                raise RuntimeError("无法找回任务对应的账号，无法继续轮询")
            backend = OpenAIBackendAPI(access_token=access_token)
            file_ids, sediment_ids = backend._poll_image_results(
                conversation_id,
                extra_timeout_secs,
            )
            if not file_ids and not sediment_ids:
                raise RuntimeError(
                    f"继续等待 {extra_timeout_secs} 秒后仍未找到图片结果。"
                )

            image_urls = backend.resolve_conversation_image_urls(
                conversation_id, file_ids, sediment_ids, poll=False,
            )
            if not image_urls:
                raise RuntimeError("图片 URL 解析失败")

            image_items = [
                {"_bytes": image_data}
                for image_data in backend.download_image_bytes(image_urls)
            ]
            # 获取 task 的原始 prompt（从 _public_task 的 mode 判断）
            with self._lock:
                task = self._tasks.get(key)
                quality = _clean(task.get("quality"), "auto") if task else "auto"
                size = _clean(task.get("size")) if task else None
            data = format_image_result(
                image_items,
                "",  # prompt 已不重要，结果已经拿到了
                "url",
                "",
                int(time.time()),
            )["data"]
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, error="", duration_ms=int((time.time() - started) * 1000))
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成（续轮询）",
                status="success",
                urls=_collect_image_urls(data),
            )
        except Exception as exc:
            error_message = str(exc) or "resume poll failed"
            duration_ms = int((time.time() - started) * 1000)
            self._update_task(key, status=TASK_STATUS_ERROR, error=error_message, data=[], duration_ms=duration_ms)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败（续轮询）",
                status="failed",
                error=error_message,
            )
        finally:
            if backend is not None:
                backend.close()


image_task_service = ImageTaskService(
    DATA_DIR / "image_runtime.db",
    repository=image_runtime_repository,
)
