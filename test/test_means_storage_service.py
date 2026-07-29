from __future__ import annotations

from datetime import datetime, timezone
import unittest
from unittest import mock

from services.means_storage_service import (
    MeansStorageError,
    MeansStorageService,
    _object_url,
    _signed_put_headers,
)


class FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


class MeansStorageServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = {
            "enabled": True,
            "endpoint": "http://means.test:5178/s3/",
            "access_key": "access",
            "secret_key": "secret",
            "bucket": "generated-images",
            "prefix": "chatgpt2api/images",
            "public_base_url": "",
            "region": "us-east-1",
            "service": "s3",
            "timeout_seconds": 60,
            "verify_ssl": True,
        }
        self.service = MeansStorageService()

    def test_object_url_preserves_endpoint_path_and_encodes_key(self) -> None:
        url = _object_url(
            "https://means.test/s3/?ignored=yes",
            "generated-images",
            "images/猫 图.png",
        )
        self.assertEqual(
            url,
            "https://means.test/s3/generated-images/images/%E7%8C%AB%20%E5%9B%BE.png",
        )
        self.assertNotIn("?", url)

    def test_sigv4_headers_match_means_contract(self) -> None:
        headers = _signed_put_headers(
            "https://means.test/s3/generated-images/example.png",
            access_key="access",
            secret_key="secret",
            region="us-east-1",
            service="s3",
            content_type="image/png",
            now=datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(headers["x-amz-date"], "20260729T120000Z")
        self.assertEqual(headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD")
        self.assertIn("Credential=access/20260729/us-east-1/s3/aws4_request", headers["Authorization"])
        self.assertIn("SignedHeaders=host;x-amz-content-sha256;x-amz-date", headers["Authorization"])

    def test_upload_returns_plain_object_url_without_query(self) -> None:
        with (
            mock.patch.object(self.service, "settings", return_value=dict(self.settings)),
            mock.patch("services.means_storage_service.requests.put", return_value=FakeResponse()) as put,
        ):
            result = self.service.upload(b"png-data")

        self.assertTrue(result.startswith("http://means.test:5178/s3/generated-images/chatgpt2api/images/"))
        self.assertTrue(result.endswith(".png"))
        self.assertNotIn("?", result)
        self.assertEqual(put.call_args.kwargs["data"], b"png-data")
        self.assertIn("Authorization", put.call_args.kwargs["headers"])

    def test_public_base_url_is_used_for_response_only(self) -> None:
        self.settings["public_base_url"] = "https://cdn.example.test/generated?token=ignored"
        with (
            mock.patch.object(self.service, "settings", return_value=dict(self.settings)),
            mock.patch("services.means_storage_service.requests.put", return_value=FakeResponse()) as put,
        ):
            result = self.service.upload(b"png-data")

        self.assertTrue(put.call_args.args[0].startswith("http://means.test:5178/s3/generated-images/"))
        self.assertTrue(result.startswith("https://cdn.example.test/generated/chatgpt2api/images/"))
        self.assertNotIn("?", result)

    def test_upload_error_contains_http_status(self) -> None:
        with (
            mock.patch.object(self.service, "settings", return_value=dict(self.settings)),
            mock.patch(
                "services.means_storage_service.requests.put",
                return_value=FakeResponse(403, "<Error>AccessDenied</Error>"),
            ),
        ):
            with self.assertRaisesRegex(MeansStorageError, "HTTP 403"):
                self.service.upload(b"png-data")


if __name__ == "__main__":
    unittest.main()
