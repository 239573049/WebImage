from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from services.config import DATA_DIR


DEFAULT_RUNTIME_DB = DATA_DIR / "image_runtime.db"
DEFAULT_HEALTH = {
    "health_score": 100,
    "health_state": "healthy",
    "health_success_rate": 1.0,
    "health_latency_ms": 0.0,
    "health_consecutive_failures": 0,
    "health_cooldown_until": None,
    "image_assigned": 0,
    "health_last_error": None,
}


def account_health_key(access_token: str) -> str:
    return hashlib.sha256(str(access_token or "").encode("utf-8")).hexdigest()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(value: object, fallback: Any) -> Any:
    try:
        result = json.loads(str(value or ""))
    except Exception:
        return fallback
    return result


class ImageRuntimeRepository:
    """Small connection-per-operation SQLite repository for image runtime state."""

    def __init__(self, path: Path | str | None = None):
        configured = os.getenv("IMAGE_RUNTIME_DATABASE_URL", "").strip()
        if path is None and configured:
            if not configured.startswith("sqlite:///"):
                raise ValueError("IMAGE_RUNTIME_DATABASE_URL currently supports sqlite:/// URLs only")
            path = configured.removeprefix("sqlite:///")
        self.path = Path(path or DEFAULT_RUNTIME_DB).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._schema_lock = threading.Lock()
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=5.0, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._schema_lock, self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS image_tasks (
                    owner_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    record_json TEXT NOT NULL,
                    payload_json TEXT,
                    identity_json TEXT,
                    created_ts REAL NOT NULL,
                    updated_ts REAL NOT NULL,
                    PRIMARY KEY(owner_id, task_id)
                );
                CREATE INDEX IF NOT EXISTS idx_image_tasks_status_created
                    ON image_tasks(status, created_ts);
                CREATE INDEX IF NOT EXISTS idx_image_tasks_owner_updated
                    ON image_tasks(owner_id, updated_ts DESC);

                CREATE TABLE IF NOT EXISTS stored_images (
                    rel TEXT PRIMARY KEY,
                    record_json TEXT NOT NULL,
                    created_ts REAL NOT NULL,
                    updated_ts REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_stored_images_created
                    ON stored_images(created_ts DESC);

                CREATE TABLE IF NOT EXISTS image_account_health (
                    account_key TEXT PRIMARY KEY,
                    score INTEGER NOT NULL DEFAULT 100,
                    state TEXT NOT NULL DEFAULT 'healthy',
                    success_ewma REAL NOT NULL DEFAULT 1.0,
                    latency_ewma_ms REAL NOT NULL DEFAULT 0,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    cooldown_until REAL,
                    cooldown_window REAL NOT NULL DEFAULT 0,
                    assigned INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    updated_ts REAL NOT NULL
                );
                """
            )
            try:
                conn.execute("ALTER TABLE image_account_health ADD COLUMN cooldown_window REAL NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass

    def insert_task(
        self,
        task: dict[str, Any],
        payload: dict[str, Any],
        identity: dict[str, object],
    ) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO image_tasks
                    (owner_id, task_id, status, record_json, payload_json, identity_json, created_ts, updated_ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task["owner_id"],
                    task["id"],
                    task["status"],
                    _json(task),
                    _json(payload),
                    _json(identity),
                    float(task.get("created_ts") or time.time()),
                    float(task.get("updated_ts") or task.get("created_ts") or time.time()),
                ),
            )
            return cursor.rowcount > 0

    def get_task(self, owner_id: str, task_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT record_json FROM image_tasks WHERE owner_id=? AND task_id=?",
                (owner_id, task_id),
            ).fetchone()
        item = _loads(row["record_json"], None) if row else None
        return item if isinstance(item, dict) else None

    def get_task_bundle(self, owner_id: str, task_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, object]] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT record_json, payload_json, identity_json FROM image_tasks WHERE owner_id=? AND task_id=?",
                (owner_id, task_id),
            ).fetchone()
        if not row:
            return None
        task = _loads(row["record_json"], {})
        payload = _loads(row["payload_json"], {})
        identity = _loads(row["identity_json"], {})
        if not all(isinstance(item, dict) for item in (task, payload, identity)):
            return None
        return task, payload, identity

    def list_tasks(self, owner_id: str, task_ids: list[str] | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if task_ids:
                placeholders = ",".join("?" for _ in task_ids)
                rows = conn.execute(
                    f"SELECT record_json FROM image_tasks WHERE owner_id=? AND task_id IN ({placeholders})",
                    [owner_id, *task_ids],
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT record_json FROM image_tasks WHERE owner_id=? ORDER BY updated_ts DESC",
                    (owner_id,),
                ).fetchall()
        return [item for row in rows if isinstance((item := _loads(row["record_json"], None)), dict)]

    def list_all_tasks(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT record_json FROM image_tasks ORDER BY updated_ts DESC").fetchall()
        return [item for row in rows if isinstance((item := _loads(row["record_json"], None)), dict)]

    def update_task(self, owner_id: str, task_id: str, **updates: Any) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT record_json FROM image_tasks WHERE owner_id=? AND task_id=?",
                (owner_id, task_id),
            ).fetchone()
            if not row:
                conn.execute("ROLLBACK")
                return None
            task = _loads(row["record_json"], {})
            task.update(updates)
            now = time.time()
            task["updated_ts"] = now
            conn.execute(
                """
                UPDATE image_tasks SET status=?, record_json=?, updated_ts=?
                WHERE owner_id=? AND task_id=?
                """,
                (str(task.get("status") or ""), _json(task), now, owner_id, task_id),
            )
            conn.execute("COMMIT")
            return task

    def queued_task_keys(self, limit: int = 100) -> list[tuple[str, str]]:
        """分页读取 queued 任务，避免排队增长导致内存增长。"""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT owner_id, task_id FROM image_tasks WHERE status='queued' ORDER BY created_ts LIMIT ?",
                (max(1, int(limit)),),
            ).fetchall()
        return [(str(row["owner_id"]), str(row["task_id"])) for row in rows]

    def oldest_queued_age_secs(self) -> float:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MIN(created_ts) AS oldest FROM image_tasks WHERE status='queued'"
            ).fetchone()
        oldest = row["oldest"] if row else None
        return max(0.0, time.time() - float(oldest)) if oldest else 0.0

    def unfinished_input_paths(self) -> set[str]:
        """收集所有未终态任务引用的参考图暂存文件路径，用于无引用清理。"""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload_json FROM image_tasks WHERE status IN ('queued','running')"
            ).fetchall()
        referenced: set[str] = set()
        for row in rows:
            payload = _loads(row["payload_json"], {})
            if not isinstance(payload, dict):
                continue
            for field in ("images", "mask"):
                values = payload.get(field)
                if not isinstance(values, list):
                    continue
                for item in values:
                    if isinstance(item, dict) and item.get("_input_path"):
                        referenced.add(str(item["_input_path"]))
        return referenced

    def recover_running_tasks(self, error: str) -> int:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT owner_id, task_id, record_json FROM image_tasks WHERE status='running'"
            ).fetchall()
            count = 0
            for row in rows:
                task = _loads(row["record_json"], {})
                task.update({"status": "error", "error": error, "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
                now = time.time()
                task["updated_ts"] = now
                conn.execute(
                    "UPDATE image_tasks SET status='error', record_json=?, updated_ts=? WHERE owner_id=? AND task_id=?",
                    (_json(task), now, row["owner_id"], row["task_id"]),
                )
                count += 1
            return count

    def delete_old_tasks(self, cutoff_ts: float) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM image_tasks WHERE status IN ('success','error') AND updated_ts < ?",
                (float(cutoff_ts),),
            )
            return max(0, int(cursor.rowcount))

    def task_stats(self) -> dict[str, int]:
        stats = {"queued": 0, "running": 0, "success": 0, "error": 0}
        with self._connect() as conn:
            rows = conn.execute("SELECT status, COUNT(*) AS count FROM image_tasks GROUP BY status").fetchall()
        for row in rows:
            stats[str(row["status"])] = int(row["count"])
        return stats

    def upsert_image(self, rel: str, item: dict[str, object]) -> None:
        now = time.time()
        created_ts = now
        created_at = str(item.get("created_at") or "")
        try:
            created_ts = time.mktime(time.strptime(created_at, "%Y-%m-%d %H:%M:%S"))
        except (TypeError, ValueError):
            pass
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO stored_images(rel, record_json, created_ts, updated_ts)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(rel) DO UPDATE SET record_json=excluded.record_json, updated_ts=excluded.updated_ts
                """,
                (rel, _json(item), created_ts, now),
            )

    def list_images(self) -> dict[str, dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT rel, record_json FROM stored_images ORDER BY created_ts DESC").fetchall()
        return {
            str(row["rel"]): item
            for row in rows
            if isinstance((item := _loads(row["record_json"], None)), dict)
        }

    def get_image(self, rel: str) -> dict[str, object] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT record_json FROM stored_images WHERE rel=?", (rel,)).fetchone()
        item = _loads(row["record_json"], None) if row else None
        return item if isinstance(item, dict) else None

    def delete_image(self, rel: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM stored_images WHERE rel=?", (rel,))

    def replace_images(self, items: dict[str, dict[str, object]]) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = {
                str(row["rel"])
                for row in conn.execute("SELECT rel FROM stored_images").fetchall()
            }
            for rel, item in items.items():
                conn.execute(
                    """
                    INSERT INTO stored_images(rel, record_json, created_ts, updated_ts)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(rel) DO UPDATE SET record_json=excluded.record_json, updated_ts=excluded.updated_ts
                    """,
                    (rel, _json(item), now, now),
                )
            stale = existing.difference(items)
            if stale:
                placeholders = ",".join("?" for _ in stale)
                conn.execute(f"DELETE FROM stored_images WHERE rel IN ({placeholders})", list(stale))
            conn.execute("COMMIT")

    def get_health(self, access_token: str) -> dict[str, object]:
        key = account_health_key(access_token)
        now = time.time()
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM image_account_health WHERE account_key=?", (key,)).fetchone()
            if not row:
                conn.execute(
                    "INSERT INTO image_account_health(account_key, updated_ts) VALUES (?, ?)",
                    (key, now),
                )
                return dict(DEFAULT_HEALTH)
            state = str(row["state"])
            cooldown = float(row["cooldown_until"]) if row["cooldown_until"] is not None else None
            if state == "open" and cooldown is not None and cooldown <= now:
                state = "half_open"
                conn.execute(
                    "UPDATE image_account_health SET state='half_open', updated_ts=? WHERE account_key=?",
                    (now, key),
                )
        return {
            "health_score": int(row["score"]),
            "health_state": state,
            "health_success_rate": round(float(row["success_ewma"]), 4),
            "health_latency_ms": round(float(row["latency_ewma_ms"]), 1),
            "health_consecutive_failures": int(row["consecutive_failures"]),
            "health_cooldown_until": cooldown,
            "image_assigned": int(row["assigned"]),
            "health_last_error": row["last_error"],
        }

    def record_assignment(self, access_token: str) -> dict[str, object]:
        self.get_health(access_token)
        key = account_health_key(access_token)
        with self._connect() as conn:
            conn.execute(
                "UPDATE image_account_health SET assigned=assigned+1, updated_ts=? WHERE account_key=?",
                (time.time(), key),
            )
        return self.get_health(access_token)

    def record_health_result(
        self,
        access_token: str,
        success: bool,
        *,
        latency_ms: float | None = None,
        failure_kind: str = "transient",
        cooldown_until: float | None = None,
        error: str = "",
    ) -> dict[str, object]:
        """按固定公式更新账号健康。

        failure_kind:
        - transient: TLS/网络/5xx/轮询超时/只返回文本，计入账号失败
        - rate_limit: 429/额度限制，冷却至 restore_at（cooldown_until）或 15 分钟
        - auth_refreshed: 401/403 且 token 刷新成功，进入 half_open 探测
        - neutral: 内容策略/参数错误/客户端取消/存储错误，不影响健康
        """
        if not success and failure_kind == "neutral":
            return self.get_health(access_token)
        self.get_health(access_token)  # 确保行存在
        key = account_health_key(access_token)
        alpha = 0.2
        now = time.time()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM image_account_health WHERE account_key=?", (key,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO image_account_health(account_key, updated_ts) VALUES (?, ?)",
                    (key, now),
                )
                row_map: dict[str, Any] = {}
            else:
                row_map = dict(row)
            prev_state = str(row_map.get("state") or "healthy")
            prev_success = float(row_map.get("success_ewma") or 1.0)
            prev_latency = float(row_map.get("latency_ewma_ms") or 0.0)
            prev_failures = int(row_map.get("consecutive_failures") or 0)
            window = float(row_map.get("cooldown_window") or 0.0)

            success_ewma = alpha * (1.0 if success else 0.0) + (1.0 - alpha) * prev_success
            latency = max(0.0, float(latency_ms or 0.0))
            if latency > 0:
                latency_ewma = latency if prev_latency <= 0 else alpha * latency + (1.0 - alpha) * prev_latency
            else:
                latency_ewma = prev_latency
            failures = 0 if success else prev_failures + 1

            # latency_factor = clamp(账号池延迟中位数 / 账号延迟EWMA, 0.5, 1.0)；样本不足时为 1.0
            latency_factor = 1.0
            if latency_ewma > 0:
                samples = [
                    float(item[0])
                    for item in conn.execute(
                        "SELECT latency_ewma_ms FROM image_account_health WHERE latency_ewma_ms > 0"
                    ).fetchall()
                ]
                if samples:
                    samples.sort()
                    mid = len(samples) // 2
                    median = samples[mid] if len(samples) % 2 else (samples[mid - 1] + samples[mid]) / 2
                    if median > 0:
                        latency_factor = max(0.5, min(1.0, median / latency_ewma))

            score = max(0, min(100, round(85 * success_ewma + 15 * latency_factor - min(5 * failures, 20))))
            cooldown: float | None = None

            if success:
                if prev_state == "half_open":
                    # 半开成功：清零连续失败，健康分至少恢复到 60，重置熔断窗口
                    score = max(60, score)
                    window = 0.0
                failures = 0
                state = "healthy" if score >= 80 else ("degraded" if score >= 60 else "probation")
            elif failure_kind == "auth_refreshed":
                # 401/403 刷新成功：进入半开，只允许 1 个探测任务
                state = "half_open"
            elif failure_kind == "rate_limit":
                # 429/额度：冷却至 restore_at，无恢复时间时冷却 15 分钟
                cooldown = cooldown_until if cooldown_until and cooldown_until > now else now + 900.0
                state = "open"
            elif prev_state in {"half_open", "open"} or failures >= 3 or score < 30:
                # 熔断：5 分钟起步，每次重新熔断翻倍，最大 30 分钟
                window = 300.0 if window <= 0 else min(1800.0, window * 2)
                cooldown = now + window
                state = "open"
            else:
                state = "healthy" if score >= 80 else ("degraded" if score >= 60 else "probation")

            conn.execute(
                """
                UPDATE image_account_health
                SET score=?, state=?, success_ewma=?, latency_ewma_ms=?,
                    consecutive_failures=?, cooldown_until=?, cooldown_window=?, last_error=?, updated_ts=?
                WHERE account_key=?
                """,
                (score, state, success_ewma, latency_ewma, failures, cooldown, window, error or None, now, key),
            )
            conn.execute("COMMIT")
        return self.get_health(access_token)

    def reset_health(self, access_tokens: list[str]) -> int:
        keys = [account_health_key(token) for token in access_tokens if token]
        if not keys:
            return 0
        with self._connect() as conn:
            placeholders = ",".join("?" for _ in keys)
            cursor = conn.execute(f"DELETE FROM image_account_health WHERE account_key IN ({placeholders})", keys)
            return max(0, int(cursor.rowcount))

    def migrate_account_key(self, old_access_token: str, new_access_token: str) -> None:
        """token rotation 时迁移健康记录和未完成任务的账号引用。"""
        old_key = account_health_key(old_access_token)
        new_key = account_health_key(new_access_token)
        if old_key == new_key:
            return
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT 1 FROM image_account_health WHERE account_key=?", (new_key,)
            ).fetchone()
            if row:
                conn.execute("DELETE FROM image_account_health WHERE account_key=?", (old_key,))
            else:
                conn.execute(
                    "UPDATE image_account_health SET account_key=? WHERE account_key=?",
                    (new_key, old_key),
                )
            conn.execute(
                """
                UPDATE image_tasks
                SET record_json=json_set(record_json, '$.account_key', ?)
                WHERE status IN ('queued','running')
                  AND json_extract(record_json, '$.account_key') = ?
                """,
                (new_key, old_key),
            )
            conn.execute("COMMIT")

    def health_stats(self) -> dict[str, int]:
        result = {"healthy": 0, "degraded": 0, "probation": 0, "open": 0, "half_open": 0}
        with self._connect() as conn:
            rows = conn.execute("SELECT state, COUNT(*) AS count FROM image_account_health GROUP BY state").fetchall()
        for row in rows:
            result[str(row["state"])] = int(row["count"])
        return result

    def backup_to(self, dest: Path | str) -> None:
        """用 SQLite online backup API 生成一致性快照，不阻塞并发读写。"""
        dest_path = Path(dest)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            target = sqlite3.connect(dest_path)
            try:
                conn.backup(target)
            finally:
                target.close()

    def database_health(self) -> dict[str, object]:
        started = time.time()
        with self._connect() as conn:
            journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0])
            conn.execute("SELECT 1").fetchone()
        return {
            "ok": True,
            "path": str(self.path),
            "journal_mode": journal_mode,
            "latency_ms": round((time.time() - started) * 1000, 2),
        }


image_runtime_repository = ImageRuntimeRepository()
