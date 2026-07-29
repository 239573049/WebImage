from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from curl_cffi import requests

from services.config import config


UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"


class MeansStorageError(RuntimeError):
    pass


def _object_url(base_url: str, bucket: str | None, key: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise MeansStorageError("Means endpoint 必须是有效的 http(s) URL")
    parts = [parsed.path.rstrip("/")]
    if bucket:
        parts.append(quote(bucket, safe="-_.~"))
    parts.append(quote(key, safe="/-_.~"))
    path = "/".join(part.strip("/") for part in parts if part.strip("/"))
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{path}", "", ""))


def _signing_key(secret_key: str, date: str, region: str, service: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret_key}".encode(), date.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, service.encode(), hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def _signed_put_headers(
    url: str,
    *,
    access_key: str,
    secret_key: str,
    region: str,
    service: str,
    content_type: str,
    now: datetime | None = None,
) -> dict[str, str]:
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
    short_date = timestamp.strftime("%Y%m%d")
    parsed = urlsplit(url)
    host = parsed.netloc.lower()
    canonical_uri = quote(parsed.path or "/", safe="/-_.~")
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_headers = (
        f"host:{host}\n"
        f"x-amz-content-sha256:{UNSIGNED_PAYLOAD}\n"
        f"x-amz-date:{amz_date}\n"
    )
    canonical_request = "\n".join([
        "PUT",
        canonical_uri,
        "",
        canonical_headers,
        signed_headers,
        UNSIGNED_PAYLOAD,
    ])
    scope = f"{short_date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])
    signature = hmac.new(
        _signing_key(secret_key, short_date, region, service),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
        "Content-Type": content_type,
        "x-amz-content-sha256": UNSIGNED_PAYLOAD,
        "x-amz-date": amz_date,
    }


class MeansStorageService:
    def settings(self) -> dict[str, Any]:
        return dict(config.get_means_settings())

    def enabled(self) -> bool:
        return bool(self.settings().get("enabled"))

    @staticmethod
    def make_object_key(image_data: bytes, prefix: str = "") -> str:
        digest = hashlib.sha256(image_data).hexdigest()
        date_path = datetime.now(timezone.utc).strftime("%Y/%m/%d")
        filename = f"{digest}.png"
        return str(PurePosixPath(prefix, date_path, filename)) if prefix else str(PurePosixPath(date_path, filename))

    def upload(self, image_data: bytes, content_type: str = "image/png") -> str:
        settings = self.settings()
        if not settings.get("enabled"):
            raise MeansStorageError("Means 图片存储未启用")

        required = ("endpoint", "access_key", "secret_key", "bucket")
        missing = [key for key in required if not str(settings.get(key) or "").strip()]
        if missing:
            raise MeansStorageError(f"Means 配置缺少字段：{', '.join(missing)}")

        endpoint = str(settings["endpoint"])
        bucket = str(settings["bucket"])
        key = self.make_object_key(image_data, str(settings.get("prefix") or ""))
        upload_url = _object_url(endpoint, bucket, key)
        headers = _signed_put_headers(
            upload_url,
            access_key=str(settings["access_key"]),
            secret_key=str(settings["secret_key"]),
            region=str(settings.get("region") or "us-east-1"),
            service=str(settings.get("service") or "s3"),
            content_type=content_type,
        )
        try:
            response = requests.put(
                upload_url,
                data=image_data,
                headers=headers,
                timeout=int(settings.get("timeout_seconds") or 60),
                verify=bool(settings.get("verify_ssl", True)),
            )
        except Exception as exc:
            raise MeansStorageError(f"Means 图片上传失败：{exc}") from exc
        if response.status_code < 200 or response.status_code >= 300:
            detail = str(getattr(response, "text", "") or "").strip().replace("\n", " ")[:300]
            suffix = f"：{detail}" if detail else ""
            raise MeansStorageError(f"Means 图片上传失败，HTTP {response.status_code}{suffix}")

        public_base_url = str(settings.get("public_base_url") or "").strip()
        public_url = (
            _object_url(public_base_url, None, key)
            if public_base_url
            else upload_url
        )
        parsed = urlsplit(public_url)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


means_storage_service = MeansStorageService()
