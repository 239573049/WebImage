from __future__ import annotations

import os
from pathlib import Path

from services.storage.base import StorageBackend
from services.storage.database_storage import DatabaseStorageBackend
from services.storage.git_storage import GitStorageBackend
from services.storage.json_storage import JSONStorageBackend


def create_storage_backend(data_dir: Path) -> StorageBackend:
    """
    根据环境变量创建存储后端
    
    环境变量：
    - STORAGE_BACKEND: json|sqlite|postgres|git (默认 sqlite)
    - DATABASE_URL: 数据库连接字符串 (用于 sqlite/postgres)
    - GIT_REPO_URL: Git 仓库地址 (用于 git)
    - GIT_TOKEN: Git 访问令牌 (用于 git)
    - GIT_BRANCH: Git 分支 (默认 main)
    - GIT_FILE_PATH: Git 仓库中的文件路径 (默认 accounts.json)
    """
    backend_type = os.getenv("STORAGE_BACKEND", "sqlite").lower().strip()
    
    print(f"[storage] Initializing storage backend: {backend_type}")
    
    if backend_type == "json":
        # 本地 JSON 文件存储
        file_path = data_dir / "accounts.json"
        auth_keys_path = data_dir / "auth_keys.json"
        print(f"[storage] Using JSON storage: {file_path}")
        return JSONStorageBackend(file_path, auth_keys_path)
    
    elif backend_type in ("sqlite", "postgres", "postgresql", "mysql", "database"):
        # 数据库存储
        database_url = os.getenv("DATABASE_URL", "").strip()
        default_sqlite_url = f"sqlite:///{data_dir / 'accounts.db'}"
        
        if not database_url:
            # 如果没有指定 DATABASE_URL，使用本地 SQLite
            database_url = default_sqlite_url
            print(f"[storage] No DATABASE_URL provided, using local SQLite: {database_url}")
        elif not _is_valid_database_url(database_url):
            if backend_type == "sqlite":
                # DATABASE_URL 无法解析（常见拼写错误，如 sqlite=/// 或缺少 ://），回退到本地 SQLite
                print(
                    f"[storage] WARNING: Invalid DATABASE_URL '{_mask_password(database_url)}', "
                    f"falling back to local SQLite: {default_sqlite_url}"
                )
                database_url = default_sqlite_url
            else:
                raise ValueError(
                    f"Invalid DATABASE_URL '{_mask_password(database_url)}'. "
                    "Expected a SQLAlchemy URL like "
                    "'postgresql://user:password@host:5432/dbname' or "
                    "'sqlite:////app/data/accounts.db'."
                )
        else:
            print(f"[storage] Using database storage: {_mask_password(database_url)}")
        
        backend = DatabaseStorageBackend(database_url)
        _migrate_legacy_json_files(backend, data_dir)
        return backend
    
    elif backend_type == "git":
        # Git 仓库存储
        repo_url = os.getenv("GIT_REPO_URL", "").strip()
        token = os.getenv("GIT_TOKEN", "").strip()
        branch = os.getenv("GIT_BRANCH", "main").strip()
        file_path = os.getenv("GIT_FILE_PATH", "accounts.json").strip()
        auth_keys_file_path = os.getenv("GIT_AUTH_KEYS_FILE_PATH", "auth_keys.json").strip()
        
        if not repo_url:
            raise ValueError(
                "GIT_REPO_URL is required when using git storage backend. "
                "Please set GIT_REPO_URL environment variable."
            )
        
        print(f"[storage] Using Git storage: {_mask_token(repo_url)}, branch: {branch}, file: {file_path}")
        
        cache_dir = data_dir / "git_cache"
        return GitStorageBackend(
            repo_url=repo_url,
            token=token,
            branch=branch,
            file_path=file_path,
            auth_keys_file_path=auth_keys_file_path,
            local_cache_dir=cache_dir,
        )
    
    else:
        raise ValueError(
            f"Unknown storage backend: {backend_type}. "
            f"Supported backends: json, sqlite, postgres, git"
        )


def _is_valid_database_url(url: str) -> bool:
    """检查 DATABASE_URL 是否能被 SQLAlchemy 解析"""
    try:
        from sqlalchemy.engine.url import make_url

        make_url(url)
        return True
    except Exception:
        return False


def _migrate_legacy_json_files(backend: DatabaseStorageBackend, data_dir: Path) -> None:
    """一次性把遗留的本地 JSON 数据迁移到数据库后端

    仅当数据库中对应数据为空且本地存在旧 JSON 文件时执行；
    迁移成功后将旧文件重命名为 *.migrated 作为备份，避免重复导入。
    """
    accounts_path = data_dir / "accounts.json"
    auth_keys_path = data_dir / "auth_keys.json"
    if not accounts_path.exists() and not auth_keys_path.exists():
        return

    json_backend = JSONStorageBackend(accounts_path, auth_keys_path)

    try:
        if accounts_path.exists() and not backend.load_accounts():
            accounts = json_backend.load_accounts()
            if accounts:
                backend.save_accounts(accounts)
                print(f"[storage] Migrated {len(accounts)} accounts from {accounts_path}")
            accounts_path.rename(accounts_path.with_suffix(".json.migrated"))
            print(f"[storage] Renamed legacy file to {accounts_path.name}.migrated")

        if auth_keys_path.exists() and not backend.load_auth_keys():
            auth_keys = json_backend.load_auth_keys()
            if auth_keys:
                backend.save_auth_keys(auth_keys)
                print(f"[storage] Migrated {len(auth_keys)} auth keys from {auth_keys_path}")
            auth_keys_path.rename(auth_keys_path.with_suffix(".json.migrated"))
            print(f"[storage] Renamed legacy file to {auth_keys_path.name}.migrated")
    except Exception as e:
        print(f"[storage] Legacy JSON migration failed: {e}")
        raise


def _mask_password(url: str) -> str:
    """隐藏数据库连接字符串中的密码"""
    if "://" not in url:
        return url
    try:
        protocol, rest = url.split("://", 1)
        if "@" in rest:
            credentials, host = rest.split("@", 1)
            if ":" in credentials:
                username, _ = credentials.split(":", 1)
                return f"{protocol}://{username}:****@{host}"
        return url
    except Exception:
        return url


def _mask_token(url: str) -> str:
    """隐藏 URL 中的 token"""
    if "@" in url and "://" in url:
        protocol, rest = url.split("://", 1)
        if "@" in rest:
            _, host = rest.split("@", 1)
            return f"{protocol}://****@{host}"
    return url
