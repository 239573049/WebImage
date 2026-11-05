"""根据文件头识别图片格式，避免把 GIF / JPEG / WebP 一律当成 PNG 存储和返回。

本模块不依赖其它业务模块，可在存储层、协议层安全引用。
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path

DEFAULT_IMAGE_MIME = "image/png"

# 扩展名 -> MIME
IMAGE_MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

_EXTENSION_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def detect_image_mime(data: bytes | bytearray | None, default: str = DEFAULT_IMAGE_MIME) -> str:
    """按魔数识别图片 MIME，无法识别时返回 default。"""
    head = bytes(data or b"")[:16]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return default


def detect_base64_image_mime(b64: str | None, default: str = DEFAULT_IMAGE_MIME) -> str:
    """只解码 base64 开头一小段来识别 MIME。"""
    text = str(b64 or "").strip()
    if not text:
        return default
    if text.startswith("data:") and "," in text:
        text = text.split(",", 1)[1]
    try:
        head = base64.b64decode(text[:24] + "=" * (-len(text[:24]) % 4))
    except (binascii.Error, ValueError):
        return default
    return detect_image_mime(head, default)


def image_extension_for_mime(mime: str | None, default: str = ".png") -> str:
    normalized = str(mime or "").split(";", 1)[0].strip().lower()
    return _EXTENSION_BY_MIME.get(normalized, default)


def detect_image_extension(data: bytes | bytearray | None, default: str = ".png") -> str:
    return image_extension_for_mime(detect_image_mime(data, ""), default)


def image_mime_for_path(path: str | Path, default: str = DEFAULT_IMAGE_MIME) -> str:
    return IMAGE_MIME_BY_EXTENSION.get(Path(str(path)).suffix.lower(), default)
