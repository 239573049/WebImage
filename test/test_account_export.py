import base64
import json
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

from api.accounts import _account_payload_token
from services.account_service import AccountService


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])

    def load_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


def make_jwt(payload: dict[str, Any]) -> str:
    def encode(value: dict[str, Any]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f'{encode({"alg": "none", "typ": "JWT"})}.{encode(payload)}.sig'


class AccountExportTests(unittest.TestCase):
    def test_api_extracts_token_from_sub2api_credentials(self) -> None:
        token = _account_payload_token(
            {
                "type": "oauth",
                "credentials": {"access_token": "nested_access_token"},
            }
        )

        self.assertEqual(token, "nested_access_token")

    def test_build_export_items_uses_codex_shape_and_jwt_claims(self) -> None:
        access_token = make_jwt(
            {
                "exp": 0,
                "iat": 3600,
                "https://api.openai.com/auth": {"chatgpt_account_id": "acct_123"},
                "https://api.openai.com/profile": {"email": "test@example.com"},
            }
        )
        id_token = make_jwt({"email": "fallback@example.com"})
        service = AccountService(
            MemoryStorage(
                [
                    {
                        "access_token": access_token,
                        "id_token": id_token,
                        "refresh_token": "rt_test",
                    }
                ]
            )
        )

        [item] = service.build_export_items([access_token])

        self.assertEqual(item["type"], "codex")
        self.assertEqual(item["email"], "test@example.com")
        self.assertEqual(item["expired"], "1970-01-01T08:00:00+08:00")
        self.assertEqual(item["account_id"], "acct_123")
        self.assertEqual(item["access_token"], access_token)
        self.assertEqual(item["last_refresh"], "1970-01-01T09:00:00+08:00")
        self.assertEqual(item["id_token"], id_token)
        self.assertEqual(item["refresh_token"], "rt_test")

    def test_build_export_items_skips_accounts_missing_complete_tokens(self) -> None:
        complete_access_token = make_jwt({"exp": 0})
        complete_id_token = make_jwt({"email": "complete@example.com"})
        service = AccountService(
            MemoryStorage(
                [
                    {"access_token": "only_access"},
                    {"access_token": "missing_id", "refresh_token": "rt_missing_id"},
                    {"access_token": complete_access_token, "id_token": complete_id_token, "refresh_token": "rt_complete"},
                ]
            )
        )

        items = service.build_export_items()

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["access_token"], complete_access_token)
        self.assertEqual(items[0]["id_token"], complete_id_token)
        self.assertEqual(items[0]["refresh_token"], "rt_complete")

    def test_add_account_items_preserves_export_fields_without_overwriting_plan_type(self) -> None:
        service = AccountService(MemoryStorage())

        result = service.add_account_items(
            [
                {
                    "type": "codex",
                    "access_token": "access_token_test",
                    "refresh_token": "rt_test",
                    "account_id": "acct_123",
                }
            ]
        )

        account = service.get_account("access_token_test")
        self.assertEqual(result["added"], 1)
        self.assertIsNotNone(account)
        self.assertEqual(account["type"], "free")
        self.assertEqual(account["export_type"], "codex")
        self.assertEqual(account["refresh_token"], "rt_test")
        self.assertEqual(account["account_id"], "acct_123")

    def test_add_account_items_supports_sub2api_export_shape(self) -> None:
        service = AccountService(MemoryStorage())

        result = service.add_account_items(
            [
                {
                    "name": "ExampleAccount",
                    "platform": "openai",
                    "type": "oauth",
                    "concurrency": 10,
                    "priority": 1,
                    "credentials": {
                        "access_token": "sub2api_access_token",
                        "refresh_token": "sub2api_refresh_token",
                        "id_token": "sub2api_id_token",
                        "account_id": "acct_sub2api",
                        "email": "sub2api@example.com",
                        "plan_type": "plus",
                    },
                    "extra": {
                        "last_refresh": "2026-07-29T09:52:05+08:00",
                    },
                }
            ]
        )

        account = service.get_account("sub2api_access_token")
        self.assertEqual(result["added"], 1)
        self.assertIsNotNone(account)
        self.assertEqual(account["type"], "plus")
        self.assertEqual(account["source_type"], "codex")
        self.assertEqual(account["export_type"], "codex")
        self.assertEqual(account["refresh_token"], "sub2api_refresh_token")
        self.assertEqual(account["id_token"], "sub2api_id_token")
        self.assertEqual(account["account_id"], "acct_sub2api")
        self.assertEqual(account["email"], "sub2api@example.com")
        self.assertEqual(account["last_refresh"], "2026-07-29T09:52:05+08:00")
        self.assertEqual(account["sub2api_platform"], "openai")
        self.assertEqual(account["sub2api_auth_type"], "oauth")

    def test_refresh_uses_imported_sub2api_client_id(self) -> None:
        service = AccountService(MemoryStorage())
        response = MagicMock()
        response.status_code = 200
        response.text = '{"access_token":"new_access_token"}'
        response.json.return_value = {"access_token": "new_access_token"}
        session = MagicMock()
        session.post.return_value = response

        with (
            patch("curl_cffi.requests.Session", return_value=session),
            patch("services.proxy_service.proxy_settings.build_session_kwargs", return_value={}),
        ):
            result = service._request_access_token_refresh(
                "sub2api_refresh_token",
                {"client_id": "sub2api_client_id"},
            )

        self.assertEqual(result["access_token"], "new_access_token")
        self.assertEqual(session.post.call_args.kwargs["data"]["client_id"], "sub2api_client_id")


if __name__ == "__main__":
    unittest.main()
