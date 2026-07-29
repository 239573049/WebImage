#!/usr/bin/env python3
"""只读导出 image_runtime.db 为旧版 JSON 结构（image_tasks.json / image_index.json）。

用法：
    python scripts/export_image_runtime.py [--db data/image_runtime.db] [--out data/export]

仅读取数据库，不做任何写入；用于人工检查或回滚到旧版本时的数据迁移参考。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _loads(value: object) -> object:
    try:
        return json.loads(str(value or ""))
    except Exception:
        return None


def export(db_path: Path, out_dir: Path) -> None:
    if not db_path.is_file():
        raise SystemExit(f"数据库不存在: {db_path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    # 只读打开，避免影响运行中的服务
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tasks = [
            record
            for row in conn.execute("SELECT record_json FROM image_tasks ORDER BY created_ts")
            if isinstance((record := _loads(row["record_json"])), dict)
        ]
        images = [
            record
            for row in conn.execute("SELECT record_json FROM stored_images ORDER BY created_ts")
            if isinstance((record := _loads(row["record_json"])), dict)
        ]
        health = [dict(row) for row in conn.execute("SELECT * FROM image_account_health")]
    finally:
        conn.close()

    tasks_file = out_dir / "image_tasks.json"
    index_file = out_dir / "image_index.json"
    health_file = out_dir / "image_account_health.json"
    tasks_file.write_text(json.dumps({"tasks": tasks}, ensure_ascii=False, indent=2), encoding="utf-8")
    index_file.write_text(json.dumps({"items": images}, ensure_ascii=False, indent=2), encoding="utf-8")
    health_file.write_text(json.dumps(health, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已导出 {len(tasks)} 个任务 -> {tasks_file}")
    print(f"已导出 {len(images)} 条图片索引 -> {index_file}")
    print(f"已导出 {len(health)} 条账号健康记录 -> {health_file}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(BASE_DIR / "data" / "image_runtime.db"), help="image_runtime.db 路径")
    parser.add_argument("--out", default=str(BASE_DIR / "data" / "export"), help="导出目录")
    args = parser.parse_args()
    export(Path(args.db).expanduser(), Path(args.out).expanduser())


if __name__ == "__main__":
    sys.exit(main())
