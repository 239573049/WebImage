import json

import pytest

from services.storage.database_storage import (
    AccountModel,
    AuthKeyModel,
    DatabaseStorageBackend,
)


def _account_rows(backend: DatabaseStorageBackend) -> dict[str, AccountModel]:
    session = backend.Session()
    try:
        return {
            row.access_token: row
            for row in session.query(AccountModel).order_by(AccountModel.id).all()
        }
    finally:
        session.close()


def test_save_accounts_preserves_existing_rows_and_updates_only_changed_data(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'accounts.db'}")
    backend.save_accounts(
        [
            {"access_token": "token-a", "name": "A"},
            {"access_token": "token-b", "name": "B"},
        ]
    )

    before = _account_rows(backend)
    before_ids = {token: row.id for token, row in before.items()}
    before_b_data = before["token-b"].data

    backend.save_accounts(
        [
            {"access_token": "token-b", "name": "B"},
            {"access_token": "token-a", "name": "A updated"},
            {"access_token": "token-c", "name": "C"},
        ]
    )

    after = _account_rows(backend)
    assert set(after) == {"token-a", "token-b", "token-c"}
    assert after["token-a"].id == before_ids["token-a"]
    assert after["token-b"].id == before_ids["token-b"]
    assert after["token-b"].data == before_b_data
    assert json.loads(after["token-a"].data)["name"] == "A updated"


def test_save_accounts_deletes_only_rows_missing_from_new_snapshot(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'accounts.db'}")
    backend.save_accounts(
        [
            {"access_token": "token-a", "name": "A"},
            {"access_token": "token-b", "name": "B"},
        ]
    )
    before = _account_rows(backend)
    token_b_id = before["token-b"].id

    backend.save_accounts([{"access_token": "token-b", "name": "B"}])

    after = _account_rows(backend)
    assert set(after) == {"token-b"}
    assert after["token-b"].id == token_b_id


def test_save_accounts_rejects_duplicate_tokens_and_rolls_back(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'accounts.db'}")
    original = {"access_token": "token-a", "name": "A"}
    backend.save_accounts([original])

    with pytest.raises(ValueError, match="Duplicate access_token") as exc_info:
        backend.save_accounts(
            [
                {"access_token": "token-a", "name": "first update"},
                {"access_token": "token-a", "name": "second update"},
            ]
        )

    assert "token-a" not in str(exc_info.value)
    assert backend.load_accounts() == [original]


def test_save_accounts_rejects_duplicate_new_tokens_and_rolls_back(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'accounts.db'}")
    original = {"access_token": "token-a", "name": "A"}
    backend.save_accounts([original])

    with pytest.raises(ValueError, match="Duplicate access_token") as exc_info:
        backend.save_accounts(
            [
                original,
                {"access_token": "token-b", "name": "first new"},
                {"access_token": "token-b", "name": "second new"},
            ]
        )

    assert "token-b" not in str(exc_info.value)
    assert backend.load_accounts() == [original]


def test_save_auth_keys_preserves_ids_with_target_key_mapping(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'auth-keys.db'}")
    backend.save_auth_keys(
        [
            {"id": "key-a", "name": "A"},
            {"id": "key-b", "name": "B"},
        ]
    )

    session = backend.Session()
    try:
        before_ids = {
            row.key_id: row.id
            for row in session.query(AuthKeyModel).order_by(AuthKeyModel.id).all()
        }
    finally:
        session.close()

    backend.save_auth_keys(
        [
            {"id": "key-b", "name": "B"},
            {"id": "key-a", "name": "A updated"},
            {"id": "key-c", "name": "C"},
        ]
    )

    session = backend.Session()
    try:
        after = {
            row.key_id: row
            for row in session.query(AuthKeyModel).order_by(AuthKeyModel.id).all()
        }
        assert set(after) == {"key-a", "key-b", "key-c"}
        assert after["key-a"].id == before_ids["key-a"]
        assert after["key-b"].id == before_ids["key-b"]
        assert json.loads(after["key-a"].data)["name"] == "A updated"
    finally:
        session.close()


def test_save_auth_keys_rejects_duplicate_ids_and_rolls_back(tmp_path):
    backend = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'auth-keys.db'}")
    original = {"id": "key-a", "name": "A"}
    backend.save_auth_keys([original])

    with pytest.raises(ValueError, match="Duplicate id") as exc_info:
        backend.save_auth_keys(
            [
                {"id": "key-a", "name": "first update"},
                {"id": "key-a", "name": "second update"},
            ]
        )

    assert "key-a" not in str(exc_info.value)
    assert backend.load_auth_keys() == [original]


def test_factory_defaults_to_sqlite_and_migrates_legacy_json(tmp_path, monkeypatch):
    from services.storage.factory import create_storage_backend

    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    accounts_path = tmp_path / "accounts.json"
    auth_keys_path = tmp_path / "auth_keys.json"
    accounts_path.write_text(
        json.dumps([{"access_token": "token-a", "name": "A"}]),
        encoding="utf-8",
    )
    auth_keys_path.write_text(
        json.dumps({"items": [{"id": "key-a", "name": "K"}]}),
        encoding="utf-8",
    )

    backend = create_storage_backend(tmp_path)

    assert isinstance(backend, DatabaseStorageBackend)
    assert (tmp_path / "accounts.db").exists()
    assert backend.load_accounts() == [{"access_token": "token-a", "name": "A"}]
    assert backend.load_auth_keys() == [{"id": "key-a", "name": "K"}]
    # 旧文件被重命名为备份，不会重复导入
    assert not accounts_path.exists()
    assert not auth_keys_path.exists()
    assert (tmp_path / "accounts.json.migrated").exists()
    assert (tmp_path / "auth_keys.json.migrated").exists()


def test_factory_migration_skips_when_database_already_has_data(tmp_path, monkeypatch):
    from services.storage.factory import create_storage_backend

    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    existing = DatabaseStorageBackend(f"sqlite:///{tmp_path / 'accounts.db'}")
    existing.save_accounts([{"access_token": "token-db", "name": "DB"}])

    accounts_path = tmp_path / "accounts.json"
    accounts_path.write_text(
        json.dumps([{"access_token": "token-json", "name": "JSON"}]),
        encoding="utf-8",
    )

    backend = create_storage_backend(tmp_path)

    assert backend.load_accounts() == [{"access_token": "token-db", "name": "DB"}]
    # 数据库已有数据时不迁移也不重命名旧文件
    assert accounts_path.exists()
