from __future__ import annotations

import os
import unittest

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.protocol.conversation import build_image_prompt
from services.openai_backend_api import (
    CODEX_IMAGE_MODEL,
    CODEX_RESPONSES_MODEL,
    FOUR_K_IMAGE_MODEL,
    FOUR_K_THINKING_EFFORT,
    OpenAIBackendAPI,
)


class OpenAIBackendApiImageSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = OpenAIBackendAPI(access_token="test-token")

    def tearDown(self) -> None:
        self.backend.close()

    def test_4k_size_uses_luna_model_for_web_image_requests(self) -> None:
        self.assertEqual(
            self.backend._image_request_settings("gpt-image-2", "4k"),
            (FOUR_K_IMAGE_MODEL, FOUR_K_THINKING_EFFORT),
        )
        self.assertEqual(
            self.backend._image_request_settings("gpt-image-2", "3840x2160"),
            (FOUR_K_IMAGE_MODEL, FOUR_K_THINKING_EFFORT),
        )

    def test_non_4k_size_keeps_existing_codex_response_model(self) -> None:
        self.assertEqual(
            self.backend._codex_response_settings("1024x1024"),
            (CODEX_RESPONSES_MODEL, ""),
        )

    def test_4k_size_uses_luna_model_for_codex_requests(self) -> None:
        self.assertEqual(
            self.backend._codex_response_settings("3840x2160"),
            (FOUR_K_IMAGE_MODEL, FOUR_K_THINKING_EFFORT),
        )

    def test_non_4k_codex_request_settings_are_unchanged(self) -> None:
        self.assertEqual(
            self.backend._image_request_settings(CODEX_IMAGE_MODEL, "1024x1024"),
            self.backend._image_model_settings(CODEX_IMAGE_MODEL),
        )

    def test_build_image_prompt_adds_4k_instruction_block(self) -> None:
        prompt = build_image_prompt("生成一张城市夜景", "3840x2160", "auto")
        self.assertIn("请生成真正的4K超高清图片", prompt)
        self.assertIn("4K UHD约为3840x2160像素", prompt)

    def test_build_image_prompt_uses_both_orientations_for_4k_alias(self) -> None:
        prompt = build_image_prompt("生成一张城市夜景", "4k", "auto")
        self.assertIn("4K UHD约为4k像素", prompt)

    def test_build_image_prompt_skips_4k_block_for_regular_sizes(self) -> None:
        prompt = build_image_prompt("生成一张城市夜景", "1024x1024", "auto")
        self.assertNotIn("请生成真正的4K超高清图片", prompt)
