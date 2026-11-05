from __future__ import annotations

import re

from curl_cffi import requests
from fastapi import HTTPException

from services.config import config
from services.log_service import LOG_TYPE_REVIEW, log_service
from services.proxy_service import proxy_settings
from utils.log import logger

DEFAULT_REVIEW_PROMPT = "判断用户请求是否允许。只回答 ALLOW 或 REJECT。"

# TypeSafe Jev (https://docs.typesafe.ai): structured-judgment API, not
# OpenAI-compatible. We ask a single Noul (yes/no probability) question
# "should this request be rejected?" and compare the probability to a threshold.
PROVIDER_OPENAI = "openai"
PROVIDER_TYPESAFE = "typesafe"
REVIEW_PROVIDERS = (PROVIDER_OPENAI, PROVIDER_TYPESAFE)
TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai"
TYPESAFE_DEFAULT_MODEL = "jev-latest"
TYPESAFE_DEFAULT_THRESHOLD = 0.5
TYPESAFE_DEFAULT_PROMPT = (
    "这是一条提交给 AI 生图服务的用户请求。判断它是否违反内容安全政策，应当被拒绝："
    "包括色情或性暗示内容、涉及未成年人的不当内容、血腥暴力、违法犯罪、仇恨歧视、"
    "侵犯真实人物肖像或政治敏感内容。"
)
TYPESAFE_REJECT_CRITERIA = {
    "true": "请求违反内容安全政策，应当拒绝",
    "false": "请求安全合规，可以放行",
}

# Strip base64 image data URIs before review: a text-only review model can't
# analyze image bytes, and a single inlined image easily blows past the token
# budget of the upstream review service.
_BASE64_DATA_URI = re.compile(r"data:[\w/.+;-]+;base64,[A-Za-z0-9+/=]+")

# Cap aligned to the upstream review service's max context. If text still
# exceeds the cap after base64 stripping, keep equal head/tail halves so both
# the system prompt and the most recent user message survive.
_MAX_REVIEW_TEXT_LEN = 100_000
_TRUNCATION_MARKER = "\n…[truncated]…\n"


def _text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_text(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(_text(value.get(key)) for key in ("text", "input_text", "content", "input", "instructions", "system", "prompt"))
    return ""


def request_text(*values: object) -> str:
    return "\n".join(part for value in values if (part := _text(value).strip()))


def request_shape(*values: object) -> dict[str, int]:
    """Return a safe structural summary without logging prompts or image bytes."""
    stats = {
        "response_message_items": 0,
        "input_image_parts": 0,
        "image_url_parts": 0,
        "image_parts": 0,
        "data_url_images": 0,
        "remote_image_urls": 0,
        "literal_image_placeholders": 0,
    }

    def walk(value: object, key: str = "") -> None:
        if isinstance(value, str):
            text = value.strip()
            lower = text.lower()
            if "<image>" in lower:
                stats["literal_image_placeholders"] += 1
            if lower.startswith("data:image/"):
                stats["data_url_images"] += 1
            elif key in {"image_url", "url"} and lower.startswith(("http://", "https://")):
                stats["remote_image_urls"] += 1
            return
        if isinstance(value, list):
            for item in value:
                walk(item, key)
            return
        if not isinstance(value, dict):
            return
        item_type = str(value.get("type") or "").strip()
        if item_type == "message":
            stats["response_message_items"] += 1
        elif item_type == "input_image":
            stats["input_image_parts"] += 1
        elif item_type == "image_url":
            stats["image_url_parts"] += 1
        elif item_type == "image":
            stats["image_parts"] += 1
        for child_key, child in value.items():
            walk(child, str(child_key))

    for value in values:
        walk(value)
    return {key: value for key, value in stats.items() if value}


def _sanitize_for_review(text: str) -> tuple[str, dict[str, int]]:
    """Strip base64 data URIs and truncate to the review-service context limit.

    Returns (sanitized_text, stats) where stats carries base64_blocks_stripped
    and truncated_chars so callers can emit structured logs.
    """
    sanitized, base64_blocks_stripped = _BASE64_DATA_URI.subn("[image]", text)
    truncated_chars = 0
    if len(sanitized) > _MAX_REVIEW_TEXT_LEN:
        # Reserve marker space so the result stays within the cap.
        half = (_MAX_REVIEW_TEXT_LEN - len(_TRUNCATION_MARKER)) // 2
        truncated_chars = len(sanitized) - 2 * half
        sanitized = sanitized[:half] + _TRUNCATION_MARKER + sanitized[-half:]
    stats = {
        "base64_blocks_stripped": base64_blocks_stripped,
        "truncated_chars": truncated_chars,
    }
    return sanitized, stats


def _extract_review_decision(data: object) -> str | None:
    """Defensively pull the decision text out of the review service response.

    Returns None when the response shape doesn't match the OpenAI chat-completion
    contract (e.g. {"error": ...} with no choices). The caller treats None as
    "undecided" and applies the configured fail-open policy.
    """
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if content is None:
        return None
    return str(content).strip().lower()


def _is_allow_decision(decision: str) -> bool:
    return decision.startswith(("allow", "pass", "true", "yes", "通过", "允许", "安全"))


def _is_reject_decision(decision: str) -> bool:
    return decision.startswith(("reject", "deny", "block", "false", "no", "拒绝", "不允许", "违规", "禁止"))


def _resolve_bool(value: object, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _resolve_fail_open(review: dict) -> bool:
    """Resolve fail_open from review config. Defaults to True."""
    return _resolve_bool(review.get("fail_open"), True)


def resolve_observe_only(review: dict) -> bool:
    """Observe mode: record would-be interceptions but never block. Defaults to False."""
    return _resolve_bool(review.get("observe_only"), False)


_REVIEW_EXCERPT_LIMIT = 500
_REVIEW_REJECT_MESSAGE = "AI 审核未通过，拒绝本次任务"


def _record_interception(source: str, text: str, *, observe_only: bool, reason: str, **detail: object) -> None:
    """Append an interception to the system log (type=review). Never raises."""
    action = "observed" if observe_only else "blocked"
    excerpt = _BASE64_DATA_URI.sub("[image]", text).strip()
    if len(excerpt) > _REVIEW_EXCERPT_LIMIT:
        excerpt = excerpt[:_REVIEW_EXCERPT_LIMIT] + "…"
    label = "观察模式命中（已放行）" if observe_only else "已拦截"
    try:
        log_service.add(
            LOG_TYPE_REVIEW,
            f"{reason} · {label}",
            {
                "source": source,
                "action": action,
                "observe_only": observe_only,
                "reason": reason,
                "request_excerpt": excerpt,
                "request_len": len(text),
                **detail,
            },
        )
    except Exception as exc:  # logging must never break the request path
        logger.warning({"event": "content_review_log_failed", "error": str(exc)})


def resolve_provider(review: dict) -> str:
    value = str(review.get("provider") or "").strip().lower()
    return value if value in REVIEW_PROVIDERS else PROVIDER_OPENAI


def _resolve_threshold(review: dict) -> float:
    try:
        value = float(review.get("threshold"))
    except (TypeError, ValueError):
        return TYPESAFE_DEFAULT_THRESHOLD
    if value != value or value <= 0 or value > 1:  # NaN / out of range
        return TYPESAFE_DEFAULT_THRESHOLD
    return value


def _extract_typesafe_reject_probability(data: object) -> float | None:
    """Pull answers.reject.noul (probability of "yes, reject") from a Jev response."""
    if not isinstance(data, dict):
        return None
    answers = data.get("answers")
    if not isinstance(answers, dict):
        return None
    answer = answers.get("reject")
    if not isinstance(answer, dict):
        return None
    value = answer.get("noul")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if value != value or value < 0 or value > 1:
        return None
    return value


def check_request(text: str) -> None:
    text = str(text or "")
    if not text.strip():
        return
    # Local sensitive-word match runs on the raw text (cheap, no network).
    for word in config.sensitive_words:
        if word in text:
            _record_interception("sensitive_words", text, observe_only=False, reason="命中敏感词", word=word)
            raise HTTPException(status_code=400, detail={"error": "检测到敏感词，拒绝本次任务"})
    review = config.ai_review
    if not review.get("enabled"):
        return
    observe_only = resolve_observe_only(review)
    provider = resolve_provider(review)
    base_url = str(review.get("base_url") or "").strip().rstrip("/")
    api_key = str(review.get("api_key") or "").strip()
    model = str(review.get("model") or "").strip()
    if provider == PROVIDER_TYPESAFE:
        base_url = base_url or TYPESAFE_DEFAULT_BASE_URL
        model = model or TYPESAFE_DEFAULT_MODEL
    if not base_url or not api_key or not model:
        if observe_only:
            logger.warning({"event": "ai_review_config_incomplete", "provider": provider, "observe_only": True})
            return
        raise HTTPException(status_code=400, detail={"error": "ai review config is incomplete"})

    # Observe mode never blocks, so upstream failures are always let through.
    fail_open = observe_only or _resolve_fail_open(review)

    def _reject(reason: str, **detail: object) -> None:
        _record_interception("ai_review", text, observe_only=observe_only, reason=reason, provider=provider, model=model, **detail)
        if not observe_only:
            raise HTTPException(status_code=400, detail={"error": _REVIEW_REJECT_MESSAGE})

    review_text, sanitize_stats = _sanitize_for_review(text)
    if sanitize_stats["base64_blocks_stripped"] or sanitize_stats["truncated_chars"]:
        logger.info({
            "event": "ai_review_text_sanitized",
            "original_text_len": len(text),
            "review_text_len": len(review_text),
            **sanitize_stats,
        })

    # fail_open=True (default): on upstream failure or ambiguous reply, let the
    # request through. The review is a soft safety net; one missed review is
    # preferable to a 5xx storm when the review service is flaky. Set
    # config.ai_review.fail_open=false for strict-compliance deployments.
    def _on_failure(event_payload: dict) -> None:
        logger.warning(event_payload)
        if not fail_open:
            raise HTTPException(
                status_code=503,
                detail={"error": "AI 审核服务暂时不可用，请稍后重试"},
            )

    custom_prompt = str(review.get("prompt") or "").strip()
    if provider == PROVIDER_TYPESAFE:
        url = f"{base_url}/v1/systemone"
        payload: dict = {
            "model": model,
            "state": review_text,
            "questions": {
                "reject": {
                    "type": "noul",
                    "instructions": custom_prompt or TYPESAFE_DEFAULT_PROMPT,
                    "criteria": TYPESAFE_REJECT_CRITERIA,
                },
            },
        }
    else:
        prompt = custom_prompt or DEFAULT_REVIEW_PROMPT
        content = f"{prompt}\n\n用户请求:\n{review_text}\n\n只回答 ALLOW 或 REJECT。"
        url = f"{base_url}/v1/chat/completions"
        payload = {"model": model, "messages": [{"role": "user", "content": content}], "temperature": 0}

    try:
        response = requests.post(
            url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=60,
            **proxy_settings.build_session_kwargs(target_url=base_url),
        )
    except Exception as exc:
        _on_failure({
            "event": "ai_review_request_failed",
            "provider": provider,
            "error": str(exc),
            "error_type": exc.__class__.__name__,
            "review_text_len": len(review_text),
            "original_text_len": len(text),
        })
        return

    try:
        data = response.json()
    except Exception as exc:
        _on_failure({
            "event": "ai_review_response_not_json",
            "provider": provider,
            "status_code": response.status_code,
            "body_preview": str(response.text or "")[:200],
            "error": str(exc),
        })
        return

    if provider == PROVIDER_TYPESAFE:
        probability = _extract_typesafe_reject_probability(data)
        if probability is None:
            _on_failure({
                "event": "ai_review_malformed_response",
                "provider": provider,
                "status_code": response.status_code,
                "body_preview": str(data)[:300],
                "review_text_len": len(review_text),
                "original_text_len": len(text),
            })
            return
        threshold = _resolve_threshold(review)
        if probability >= threshold:
            logger.info({
                "event": "ai_review_rejected",
                "provider": provider,
                "observe_only": observe_only,
                "reject_probability": probability,
                "threshold": threshold,
            })
            _reject("AI 审核未通过", reject_probability=probability, threshold=threshold)
        return

    decision = _extract_review_decision(data)
    if decision is None:
        _on_failure({
            "event": "ai_review_malformed_response",
            "status_code": response.status_code,
            "body_preview": str(data)[:300],
            "review_text_len": len(review_text),
            "original_text_len": len(text),
        })
        return

    if _is_allow_decision(decision):
        return
    if _is_reject_decision(decision):
        _reject("AI 审核未通过", decision=decision[:100])
        return
    # Ambiguous decisions (e.g. "MAYBE", empty content) fall back to fail-open policy.
    _on_failure({
        "event": "ai_review_ambiguous_decision",
        "decision": decision[:100],
        "review_text_len": len(review_text),
    })
    return
