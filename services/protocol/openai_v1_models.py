from __future__ import annotations

from typing import Any

from services.account_service import account_service
from services.config import config
from services.model_service import model_catalog_service
from utils.helper import CODEX_IMAGE_MODEL


def _upsert_dynamic_model(data: list[Any], seen: set[str], model: str) -> None:
    """确保型号出现在列表里；上游目录已提供的型号保持原样。"""
    if model in seen:
        return
    seen.add(model)
    data.append({
        "id": model,
        "object": "model",
        "created": 0,
        "owned_by": "chatgpt2api",
        "permission": [],
        "root": model,
        "parent": None,
    })


def list_models() -> dict[str, Any]:
    result = model_catalog_service.list_models()
    result["default_image_model"] = config.default_image_model
    data = result.get("data")
    if not isinstance(data, list):
        return result
    seen = {str(item.get("id") or "").strip() for item in data if isinstance(item, dict)}
    dynamic_models: set[str] = set()
    accounts = account_service.list_accounts()
    web_image_accounts = [
        account
        for account in accounts
        if isinstance(account, dict)
    ]
    codex_types = {
        normalized
        for account in accounts
        if isinstance(account, dict)
           and account_service._normalize_source_type(account.get("source_type")) == "codex"
           and (normalized := account_service._normalize_account_type(account.get("type")))
    }

    if web_image_accounts:
        dynamic_models.update(config.image_models)
    if codex_types & {"Plus", "Team", "Pro"}:
        dynamic_models.add(CODEX_IMAGE_MODEL)
    if "Plus" in codex_types:
        dynamic_models.add(f"plus-{CODEX_IMAGE_MODEL}")
    if "Team" in codex_types:
        dynamic_models.add(f"team-{CODEX_IMAGE_MODEL}")
    if "Pro" in codex_types:
        dynamic_models.add(f"pro-{CODEX_IMAGE_MODEL}")

    for model in sorted(dynamic_models):
        _upsert_dynamic_model(data, seen, model)
    return result
