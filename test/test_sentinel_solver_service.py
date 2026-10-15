from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from services.config import DEFAULT_SENTINEL_SOLVER, _normalize_sentinel_solver_settings
from services.sentinel_solver_service import SentinelSolverService
from utils.pow import _js_date_string


class FakeConfig:
    def __init__(self, settings: dict | None) -> None:
        self.settings = settings

    def get_sentinel_solver_settings(self) -> dict | None:
        return self.settings


def make_service(**overrides: object) -> SentinelSolverService:
    settings = dict(DEFAULT_SENTINEL_SOLVER)
    settings.update(overrides)
    service = SentinelSolverService()
    service.settings = lambda: dict(settings)      # type: ignore[method-assign]
    return service


class SentinelSolverSettingsTests(unittest.TestCase):
    def test_defaults_are_disabled_and_empty(self) -> None:
        self.assertEqual(
            _normalize_sentinel_solver_settings(None),
            {"enabled": False, "url": "", "key": "", "timeout_seconds": 180},
        )

    def test_url_is_trimmed_and_timeout_has_a_floor(self) -> None:
        normalized = _normalize_sentinel_solver_settings(
            {"enabled": 1, "url": "  http://127.0.0.1:8788/  ", "key": " s3cret ", "timeout_seconds": 0}
        )

        self.assertTrue(normalized["enabled"])
        self.assertEqual(normalized["url"], "http://127.0.0.1:8788")
        self.assertEqual(normalized["key"], "s3cret")
        self.assertEqual(normalized["timeout_seconds"], 1)


class SentinelSolverServiceTests(unittest.TestCase):
    def test_disabled_without_url_even_when_enabled(self) -> None:
        self.assertFalse(make_service(enabled=True, url="").enabled())
        self.assertFalse(make_service(enabled=False, url="http://127.0.0.1:8788").enabled())
        self.assertTrue(make_service(enabled=True, url="http://127.0.0.1:8788").enabled())

    def test_solve_returns_none_when_disabled(self) -> None:
        service = make_service(enabled=False, url="http://127.0.0.1:8788")

        self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "x"}}, "p"))

    def test_solve_posts_requirements_and_key_then_returns_token(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="test-key")
        captured: dict = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return json.dumps({"ok": True, "turnstile": "TOKEN"}).encode()

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.headers)
            captured["body"] = json.loads(request.data.decode())
            captured["timeout"] = timeout
            return FakeResponse()

        with patch("services.sentinel_solver_service.urllib.request.urlopen", fake_urlopen):
            token = service.solve_turnstile({"turnstile": {"dx": "d"}, "persona": "chatgpt-paid"}, "p-token")

        self.assertEqual(token, "TOKEN")
        self.assertEqual(captured["url"], "http://127.0.0.1:8788/turnstile")
        self.assertEqual(captured["headers"].get("X-solver-key"), "test-key")
        self.assertEqual(captured["body"], {"requirements": {"turnstile": {"dx": "d"}, "persona": "chatgpt-paid"},
                                            "p": "p-token"})
        self.assertEqual(captured["timeout"], 180)

    def test_solve_returns_none_when_solver_reports_failure(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="k")

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def read(self) -> bytes:
                return json.dumps({"ok": False, "error": "vm timeout"}).encode()

        with patch("services.sentinel_solver_service.urllib.request.urlopen", lambda *a, **k: FakeResponse()):
            self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "d"}}, "p"))

    def test_solve_returns_none_on_network_error(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="k")

        with patch("services.sentinel_solver_service.urllib.request.urlopen", side_effect=OSError("boom")):
            self.assertIsNone(service.solve_turnstile({"turnstile": {"dx": "d"}}, "p"))

    def test_no_key_configured_means_no_key_header(self) -> None:
        service = make_service(enabled=True, url="http://127.0.0.1:8788", key="")

        self.assertNotIn("X-Solver-Key", service._headers(service.settings()))


class SentinelDateStringTests(unittest.TestCase):
    """指纹里的 `"" + new Date`：UTC 或非 ASCII 时区名都会被上游判为不可信（404 Model not found）。"""

    def test_converts_to_utc_plus_8_with_browser_style_name(self) -> None:
        moment = datetime(2026, 10, 15, 6, 7, 8, tzinfo=timezone.utc)

        self.assertEqual(_js_date_string(moment), "Thu Oct 15 2026 14:07:08 GMT+0800 (China Standard Time)")

    def test_ignores_process_timezone(self) -> None:
        # 容器默认 TZ=UTC，结果仍必须是东八区且为 ASCII
        value = _js_date_string()

        self.assertTrue(value.endswith(" GMT+0800 (China Standard Time)"), value)
        self.assertTrue(value.isascii(), value)


if __name__ == "__main__":
    unittest.main()
