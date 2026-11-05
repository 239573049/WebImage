from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from services.content_filter import check_request


def _response(payload: object, status_code: int = 200) -> MagicMock:
    response = MagicMock(status_code=status_code)
    response.json.return_value = payload
    return response


def _noul(probability: float) -> dict:
    return {"model": "jev-1.14.0", "answers": {"reject": {"type": "noul", "noul": probability}}, "usage": {"input_tokens": 10, "output_tokens": 1}}


class _NoProxy:
    def build_session_kwargs(self, **_: object) -> dict:
        return {}


class _ReviewTestCase(unittest.TestCase):
    def setUp(self) -> None:
        log_patch = patch("services.content_filter.log_service")
        self.log_service = log_patch.start()
        self.addCleanup(log_patch.stop)

    def run_check(self, review: dict, response: MagicMock, text: str = "draw a cat", sensitive_words: list[str] | None = None):
        with (
            patch("services.content_filter.config", SimpleNamespace(sensitive_words=sensitive_words or [], ai_review=review)),
            patch("services.content_filter.proxy_settings", _NoProxy()),
            patch("services.content_filter.requests.post", return_value=response) as post,
        ):
            check_request(text)
        return post

    def logged(self) -> list[dict]:
        return [call.args[2] for call in self.log_service.add.call_args_list]


class TypeSafeReviewTests(_ReviewTestCase):

    def test_disabled_by_default_makes_no_request(self) -> None:
        post = self.run_check({"provider": "typesafe", "api_key": "k"}, _response(_noul(0.99)))
        post.assert_not_called()

    def test_defaults_and_request_shape(self) -> None:
        post = self.run_check({"enabled": True, "provider": "typesafe", "api_key": "ts-key"}, _response(_noul(0.1)))
        self.assertEqual(post.call_args.args[0], "https://api.typesafe.ai/v1/systemone")
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer ts-key")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["model"], "jev-latest")
        self.assertEqual(body["state"], "draw a cat")
        self.assertEqual(body["questions"]["reject"]["type"], "noul")
        self.assertTrue(body["questions"]["reject"]["instructions"])

    def test_custom_base_url_model_and_prompt(self) -> None:
        review = {"enabled": True, "provider": "typesafe", "api_key": "k", "base_url": "https://ts.example/", "model": "jev-1.13.0", "prompt": "custom policy"}
        post = self.run_check(review, _response(_noul(0.1)))
        self.assertEqual(post.call_args.args[0], "https://ts.example/v1/systemone")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["model"], "jev-1.13.0")
        self.assertEqual(body["questions"]["reject"]["instructions"], "custom policy")

    def test_rejects_at_or_above_threshold(self) -> None:
        review = {"enabled": True, "provider": "typesafe", "api_key": "k", "threshold": 0.8}
        with self.assertRaises(HTTPException) as ctx:
            self.run_check(review, _response(_noul(0.8)))
        self.assertEqual(ctx.exception.status_code, 400)
        self.run_check(review, _response(_noul(0.79)))  # below threshold → allowed

    def test_invalid_threshold_falls_back_to_default(self) -> None:
        review = {"enabled": True, "provider": "typesafe", "api_key": "k", "threshold": "abc"}
        with self.assertRaises(HTTPException):
            self.run_check(review, _response(_noul(0.6)))

    def test_error_response_follows_fail_open_policy(self) -> None:
        error = _response({"detail": "invalid api key"}, status_code=401)
        self.run_check({"enabled": True, "provider": "typesafe", "api_key": "k"}, error)  # fail-open default
        with self.assertRaises(HTTPException) as ctx:
            self.run_check({"enabled": True, "provider": "typesafe", "api_key": "k", "fail_open": False}, error)
        self.assertEqual(ctx.exception.status_code, 503)

    def test_missing_api_key_is_incomplete(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self.run_check({"enabled": True, "provider": "typesafe"}, _response(_noul(0.1)))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unknown_provider_uses_openai_path(self) -> None:
        review = {"enabled": True, "provider": "bogus", "api_key": "k", "base_url": "https://r.example", "model": "m"}
        post = self.run_check(review, _response({"choices": [{"message": {"content": "ALLOW"}}]}))
        self.assertEqual(post.call_args.args[0], "https://r.example/v1/chat/completions")


    def test_block_is_recorded_in_review_log(self) -> None:
        with self.assertRaises(HTTPException):
            self.run_check({"enabled": True, "provider": "typesafe", "api_key": "k"}, _response(_noul(0.9)))
        self.assertEqual(self.log_service.add.call_args.args[0], "review")
        entry = self.logged()[0]
        self.assertEqual(entry["action"], "blocked")
        self.assertEqual(entry["reject_probability"], 0.9)
        self.assertEqual(entry["request_excerpt"], "draw a cat")

    def test_allow_is_not_logged(self) -> None:
        self.run_check({"enabled": True, "provider": "typesafe", "api_key": "k"}, _response(_noul(0.1)))
        self.log_service.add.assert_not_called()


class ObserveModeTests(_ReviewTestCase):
    """Observe mode records would-be interceptions but never blocks."""

    def test_typesafe_reject_is_observed_not_blocked(self) -> None:
        self.run_check({"enabled": True, "observe_only": True, "provider": "typesafe", "api_key": "k"}, _response(_noul(0.95)))
        entry = self.logged()[0]
        self.assertEqual(entry["action"], "observed")
        self.assertTrue(entry["observe_only"])

    def test_openai_reject_is_observed_not_blocked(self) -> None:
        review = {"enabled": True, "observe_only": True, "api_key": "k", "base_url": "https://r.example", "model": "m"}
        self.run_check(review, _response({"choices": [{"message": {"content": "REJECT"}}]}))
        self.assertEqual(self.logged()[0]["action"], "observed")

    def test_upstream_failure_ignores_fail_closed(self) -> None:
        review = {"enabled": True, "observe_only": True, "fail_open": False, "provider": "typesafe", "api_key": "k"}
        self.run_check(review, _response({"detail": "overloaded"}, status_code=529))

    def test_incomplete_config_does_not_block(self) -> None:
        self.run_check({"enabled": True, "observe_only": "true", "provider": "openai"}, _response({}))

    def test_sensitive_words_still_block(self) -> None:
        review = {"enabled": True, "observe_only": True, "provider": "typesafe", "api_key": "k"}
        with self.assertRaises(HTTPException):
            self.run_check(review, _response(_noul(0.0)), text="draw a forbidden cat", sensitive_words=["forbidden"])
        self.assertEqual(self.logged()[0]["source"], "sensitive_words")


if __name__ == "__main__":
    unittest.main()
