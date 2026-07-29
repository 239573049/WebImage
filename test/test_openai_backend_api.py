from __future__ import annotations

import os
import unittest

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.protocol.conversation import build_image_prompt, classify_image_text_error
from services.openai_backend_api import (
    CODEX_IMAGE_MODEL,
    CODEX_RESPONSES_MODEL,
    FOUR_K_IMAGE_MODEL,
    FOUR_K_THINKING_EFFORT,
    OpenAIBackendAPI,
    _is_content_policy_error,
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

    def test_conversation_origin_only_applies_to_4k_sizes(self) -> None:
        self.assertEqual(self.backend._image_conversation_origin("3840x2160"), "tpp")
        self.assertEqual(self.backend._image_conversation_origin("4k"), "tpp")
        self.assertIsNone(self.backend._image_conversation_origin("1024x1024"))

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
        # 4k 生成过程中模型会先输出 imagegen 技能说明（YAML frontmatter），不能判成违规
        sample = (
            "---\nname: \"imagegen\"\n"
            "description: \"Generate or edit raster images when the task benefits from "
            "AI-created bitmap visuals... Do not use when the task is better handled by "
            "editing existing SVG/vector/code-native"
        )
        self.assertFalse(_is_content_policy_error(sample))

    def test_real_policy_message_still_detected(self) -> None:
        self.assertTrue(_is_content_policy_error("这张图片违反了我们的内容政策，无法生成。"))

    def test_4k_size_uses_extended_poll_timeout(self) -> None:
        from services.config import config
        from services.protocol.conversation import effective_image_poll_timeout

        self.assertEqual(effective_image_poll_timeout("3840x2160"), config.image_poll_timeout_4k_secs)
        self.assertEqual(effective_image_poll_timeout("1024x1024"), config.image_poll_timeout_secs)
        self.assertGreaterEqual(config.image_poll_timeout_4k_secs, 600)

    def test_sandbox_image_refs_extracted_from_conversation(self) -> None:
        conversation = {
            "mapping": {
                "msg-1": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {
                            "content_type": "text",
                            "parts": ["图片在 sandbox:/workspace/scratch/37a209038549/generated_images/portrait-4k.png"],
                        },
                        "metadata": {},
                    }
                },
                "msg-2": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"content_type": "text", "parts": ["/workspace/foo.png"]},
                        "metadata": {},
                    }
                },
            }
        }
        refs = OpenAIBackendAPI._extract_sandbox_image_refs(conversation)
        self.assertEqual(refs, ["sandbox:msg-1:/workspace/scratch/37a209038549/generated_images/portrait-4k.png"])
        # 编码可无损拆回 message_id 与 sandbox_path
        _, message_id, sandbox_path = refs[0].split(":", 2)
        self.assertEqual(message_id, "msg-1")
        self.assertEqual(sandbox_path, "/workspace/scratch/37a209038549/generated_images/portrait-4k.png")
