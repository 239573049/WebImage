from __future__ import annotations

import base64
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "chatgpt2api")

from PIL import Image

from services.image_storage_service import ImageStorageService, _is_image_rel
from services.means_storage_service import MeansStorageService
from utils.helper import build_chat_image_markdown_content
from utils.image_format import (
    detect_base64_image_mime,
    detect_image_extension,
    detect_image_mime,
    image_mime_for_path,
)


def _image_bytes(fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def _animated_gif() -> bytes:
    frames = [Image.new("RGB", (4, 4), color) for color in ((255, 0, 0), (0, 255, 0))]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    return buf.getvalue()


class ImageFormatDetectionTests(unittest.TestCase):
    def test_detects_common_formats(self) -> None:
        self.assertEqual(detect_image_mime(_image_bytes("PNG")), "image/png")
        self.assertEqual(detect_image_mime(_animated_gif()), "image/gif")
        self.assertEqual(detect_image_mime(_image_bytes("JPEG")), "image/jpeg")
        self.assertEqual(detect_image_mime(_image_bytes("WEBP")), "image/webp")
        self.assertEqual(detect_image_mime(b"garbage"), "image/png")

    def test_detects_extension_and_base64(self) -> None:
        gif = _animated_gif()
        self.assertEqual(detect_image_extension(gif), ".gif")
        self.assertEqual(detect_image_extension(_image_bytes("JPEG")), ".jpg")
        self.assertEqual(detect_base64_image_mime(base64.b64encode(gif).decode()), "image/gif")
        self.assertEqual(image_mime_for_path("2026/11/05/a.gif"), "image/gif")

    def test_chat_markdown_uses_real_mime(self) -> None:
        b64 = base64.b64encode(_animated_gif()).decode()
        content = build_chat_image_markdown_content({"data": [{"b64_json": b64}]})
        self.assertIn("data:image/gif;base64,", content)


class GifStorageTests(unittest.TestCase):
    def test_gif_is_stored_with_gif_extension(self) -> None:
        gif = _animated_gif()
        service = ImageStorageService.__new__(ImageStorageService)
        rel = service.make_relative_path(gif)
        self.assertTrue(rel.endswith(".gif"))
        self.assertTrue(_is_image_rel(rel))
        self.assertTrue(service.make_relative_path(_image_bytes("PNG")).endswith(".png"))

    def test_means_object_key_uses_gif_extension(self) -> None:
        self.assertTrue(MeansStorageService.make_object_key(_animated_gif()).endswith(".gif"))


if __name__ == "__main__":
    unittest.main()
