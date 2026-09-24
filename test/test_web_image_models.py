from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# 与其它接口测试保持一致，避免先加载时把共享的 auth-key 覆盖成别的值
os.environ.setdefault("CHATGPT2API_AUTH_KEY", "chatgpt2api")

from api.image_inputs import _payload_from_fields
from services.config import DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_MODELS, ConfigStore, config
from services.openai_backend_api import OpenAIBackendAPI
from services.protocol import (
    openai_v1_chat_complete,
    openai_v1_image_edit,
    openai_v1_image_generations,
    openai_v1_models,
)
from utils.helper import is_supported_image_model, split_image_model, supported_image_models


SUNBURST = "gpt-image-2.5-sunburst"
FLARE = "gpt-image-2.5-flare"


def make_store(initial: dict | None = None) -> tuple[ConfigStore, tempfile.TemporaryDirectory]:
    tmp_dir = tempfile.TemporaryDirectory()
    path = Path(tmp_dir.name) / "config.json"
    path.write_text(json.dumps(initial or {"auth-key": "test-auth"}), encoding="utf-8")
    return ConfigStore(path), tmp_dir


class WebImageModelRegistryTests(unittest.TestCase):
    def test_builtin_image_models_include_the_2_5_models(self) -> None:
        self.assertIn(SUNBURST, DEFAULT_IMAGE_MODELS)
        self.assertIn(FLARE, DEFAULT_IMAGE_MODELS)
        self.assertEqual(config.image_models, list(DEFAULT_IMAGE_MODELS))

    def test_default_image_model_falls_back_to_the_builtin_default(self) -> None:
        self.assertEqual(config.default_image_model, DEFAULT_IMAGE_MODEL)
        self.assertEqual(config.custom_image_models, [])

    def test_split_image_model_accepts_web_2_5_models(self) -> None:
        self.assertEqual(split_image_model(SUNBURST), (None, SUNBURST))
        self.assertEqual(split_image_model(FLARE), (None, FLARE))
        # 大小写与空白不影响识别
        self.assertEqual(split_image_model(f"  {SUNBURST.upper()}  "), (None, SUNBURST))
        self.assertTrue(is_supported_image_model(SUNBURST))

    def test_web_2_5_models_do_not_accept_plan_type_prefixes(self) -> None:
        # 套餐前缀只对 codex 模型生效，Web 模型带前缀应视为未知型号
        self.assertEqual(split_image_model(f"plus-{SUNBURST}"), (None, None))
        self.assertEqual(split_image_model(f"team-{FLARE}"), (None, None))
        self.assertFalse(is_supported_image_model(f"pro-{SUNBURST}"))

    def test_supported_image_models_include_web_2_5_models(self) -> None:
        models = supported_image_models()
        self.assertIn(SUNBURST, models)
        self.assertIn(FLARE, models)
        self.assertIn("codex-gpt-image-2", models)
        self.assertIn("plus-codex-gpt-image-2", models)


class UpstreamModelMappingTests(unittest.TestCase):
    @staticmethod
    def _settings(model: str) -> tuple[str, str]:
        # 只验证纯映射逻辑，跳过会建立会话的 __init__
        return OpenAIBackendAPI._image_model_settings(OpenAIBackendAPI.__new__(OpenAIBackendAPI), model)

    def test_web_2_5_model_is_passed_through_unchanged(self) -> None:
        upstream_model, _ = self._settings(SUNBURST)
        self.assertEqual(upstream_model, SUNBURST)

    def test_gpt_image_2_still_maps_to_configured_upstream_model(self) -> None:
        upstream_model, _ = self._settings("gpt-image-2")
        self.assertEqual(upstream_model, config.default_upstream_model_name)

    def test_codex_model_keeps_its_own_slug(self) -> None:
        upstream_model, _ = self._settings("plus-codex-gpt-image-2")
        self.assertEqual(upstream_model, "codex-gpt-image-2")

    def test_unknown_model_falls_back_to_auto(self) -> None:
        self.assertEqual(self._settings("unknown-image-model"), ("auto", ""))


class CustomImageModelConfigTests(unittest.TestCase):
    def test_custom_models_extend_the_builtin_list(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth", "custom_image_models": ["gpt-image-9-alpha"]})
        self.addCleanup(tmp_dir.cleanup)

        self.assertEqual(store.custom_image_models, ["gpt-image-9-alpha"])
        self.assertEqual(store.image_models, list(DEFAULT_IMAGE_MODELS) + ["gpt-image-9-alpha"])

    def test_custom_models_accept_comma_and_newline_input_and_dedupe(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth"})
        self.addCleanup(tmp_dir.cleanup)

        store.update({"custom_image_models": "gpt-image-9-alpha, gpt-image-9-beta\ngpt-image-9-alpha"})

        self.assertEqual(store.custom_image_models, ["gpt-image-9-alpha", "gpt-image-9-beta"])

    def test_builtin_models_are_never_stored_as_custom(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth", "custom_image_models": [SUNBURST, "gpt-image-9-alpha"]})
        self.addCleanup(tmp_dir.cleanup)

        self.assertEqual(store.custom_image_models, ["gpt-image-9-alpha"])
        self.assertEqual(store.image_models, list(DEFAULT_IMAGE_MODELS) + ["gpt-image-9-alpha"])

    def test_default_image_model_accepts_a_configured_custom_model(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth"})
        self.addCleanup(tmp_dir.cleanup)

        store.update({"custom_image_models": ["gpt-image-9-alpha"], "default_image_model": SUNBURST})
        self.assertEqual(store.default_image_model, SUNBURST)

        store.update({"default_image_model": "gpt-image-9-alpha"})
        self.assertEqual(store.default_image_model, "gpt-image-9-alpha")

    def test_default_image_model_falls_back_when_the_model_disappears(self) -> None:
        store, tmp_dir = make_store(
            {"auth-key": "test-auth", "custom_image_models": ["gpt-image-9-alpha"], "default_image_model": "gpt-image-9-alpha"}
        )
        self.addCleanup(tmp_dir.cleanup)
        self.assertEqual(store.default_image_model, "gpt-image-9-alpha")

        store.update({"custom_image_models": []})

        self.assertEqual(store.default_image_model, DEFAULT_IMAGE_MODEL)

    def test_unknown_default_image_model_is_rejected(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth", "default_image_model": "not-an-image-model"})
        self.addCleanup(tmp_dir.cleanup)

        self.assertEqual(store.default_image_model, DEFAULT_IMAGE_MODEL)

    def test_settings_payload_exposes_models_and_default(self) -> None:
        store, tmp_dir = make_store({"auth-key": "test-auth", "custom_image_models": ["gpt-image-9-alpha"]})
        self.addCleanup(tmp_dir.cleanup)

        data = store.get()

        self.assertEqual(data["image_models"], list(DEFAULT_IMAGE_MODELS) + ["gpt-image-9-alpha"])
        self.assertEqual(data["custom_image_models"], ["gpt-image-9-alpha"])
        self.assertEqual(data["default_image_model"], DEFAULT_IMAGE_MODEL)


class ImageModelListingTests(unittest.TestCase):
    def _list_models(self) -> dict:
        with (
            mock.patch.object(
                openai_v1_models.model_catalog_service,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[{"access_token": "token-web-plus", "type": "Plus", "source_type": "web"}],
            ),
        ):
            return openai_v1_models.list_models()

    def test_list_models_exposes_web_2_5_models_and_default(self) -> None:
        result = self._list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn(SUNBURST, ids)
        self.assertIn(FLARE, ids)
        self.assertIn("gpt-image-2", ids)
        self.assertEqual(result["default_image_model"], config.default_image_model)

    def test_list_models_uses_configured_custom_models(self) -> None:
        stub = SimpleNamespace(
            image_models=list(DEFAULT_IMAGE_MODELS) + ["gpt-image-9-alpha"],
            default_image_model=DEFAULT_IMAGE_MODEL,
        )
        with mock.patch.object(openai_v1_models, "config", stub):
            result = self._list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-9-alpha", ids)


class DefaultImageModelEntryPointTests(unittest.TestCase):
    """未显式传 model 时，各生图入口都应使用配置里的默认生图模型。"""

    CONFIGURED_DEFAULT = SUNBURST

    def setUp(self) -> None:
        self.stub_config = SimpleNamespace(default_image_model=self.CONFIGURED_DEFAULT)

    def _capture_request(self, module, call) -> object:
        captured: dict[str, object] = {}

        def fake_pool(request):
            captured["request"] = request
            return iter(())

        with (
            mock.patch.object(module, "config", self.stub_config),
            mock.patch.object(module, "stream_image_outputs_with_pool", fake_pool),
            mock.patch.object(module, "collect_image_outputs", lambda outputs: {"data": []}),
        ):
            call()
        return captured["request"]

    def test_generation_handler_uses_the_configured_default(self) -> None:
        request = self._capture_request(
            openai_v1_image_generations,
            lambda: openai_v1_image_generations.handle({"prompt": "a cat"}),
        )
        self.assertEqual(request.model, self.CONFIGURED_DEFAULT)

    def test_edit_handler_uses_the_configured_default(self) -> None:
        request = self._capture_request(
            openai_v1_image_edit,
            lambda: openai_v1_image_edit.handle({"prompt": "edit", "images": [(b"png", "a.png", "image/png")]}),
        )
        self.assertEqual(request.model, self.CONFIGURED_DEFAULT)

    def test_chat_completion_image_args_use_the_configured_default(self) -> None:
        with mock.patch.object(openai_v1_chat_complete, "config", self.stub_config):
            model, *_ = openai_v1_chat_complete.chat_image_args({"prompt": "a cat"})
        self.assertEqual(model, self.CONFIGURED_DEFAULT)

    def test_request_payload_uses_the_configured_default(self) -> None:
        with mock.patch("api.image_inputs.config", self.stub_config):
            payload = _payload_from_fields({"prompt": "a cat"})
        self.assertEqual(payload["model"], self.CONFIGURED_DEFAULT)

    def test_explicit_model_still_wins(self) -> None:
        request = self._capture_request(
            openai_v1_image_generations,
            lambda: openai_v1_image_generations.handle({"prompt": "a cat", "model": FLARE}),
        )
        self.assertEqual(request.model, FLARE)


if __name__ == "__main__":
    unittest.main()
