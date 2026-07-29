from __future__ import annotations

import os
import unittest

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.protocol.conversation import build_image_prompt, classify_image_text_error
from services.openai_backend_api import (
    _is_content_policy_error,
)


class ImageTextErrorTests(unittest.TestCase):

    def test_image_prompt_includes_requested_size_and_quality(self) -> None:
        prompt = build_image_prompt("生成一张城市夜景", "2160x3840", "high")
        self.assertIn("2160x3840", prompt)
        self.assertIn("输出图片质量要求：高清晰度（高质量、细节丰富）", prompt)

    def test_classify_image_text_error_for_content_policy(self) -> None:
        error_type, code = classify_image_text_error("Image rejected due to content policy moderation")
        self.assertEqual(error_type, "invalid_request_error")
        self.assertEqual(code, "content_policy_violation")

    def test_classify_image_text_error_for_non_policy_text(self) -> None:
        sample = (
            "---\nname: \"imagegen\"\n"
            "description: \"Generate or edit raster images\""
        )
        error_type, code = classify_image_text_error(sample)
        self.assertEqual(error_type, "invalid_request_error")
        self.assertEqual(code, "no_image_generated")

    def test_imagegen_skill_frontmatter_is_not_content_policy_error(self) -> None:
        sample = (
            "---\nname: \"imagegen\"\n"
            "description: \"Generate or edit raster images when the task benefits from "
            "AI-created bitmap visuals... Do not use when the task is better handled by "
            "editing existing SVG/vector/code-native"
        )
        self.assertFalse(_is_content_policy_error(sample))

    def test_real_policy_message_still_detected(self) -> None:
        self.assertTrue(_is_content_policy_error("这张图片违反了我们的内容政策，无法生成。"))

