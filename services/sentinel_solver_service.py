"""常驻浏览器哨兵求解服务（sentinel solver）客户端。

网页端 Sentinel 的 turnstile 挑战已经换成随机化 opcode 的 VM，纯 Python 复刻走不通，
需要真实 Chromium 环境执行。这里对接一个独立部署的求解服务：

- 只发送挑战参数（prepare 响应 + 令牌种子 p），不发送账号 token、Cookie 或用户 prompt；
- 服务端自带密钥鉴权，默认只监听本机端口；
- 未配置时返回 None，调用方回退到内置的纯 Python 求解器。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from services.config import config
from utils.log import logger


class SentinelSolverError(RuntimeError):
    pass


class SentinelSolverService:
    """调用外部 sentinel solver 取 turnstile token。"""

    def settings(self) -> dict[str, Any]:
        value = config.get_sentinel_solver_settings()
        return value if isinstance(value, dict) else {}

    def enabled(self) -> bool:
        settings = self.settings()
        return bool(settings.get("enabled")) and bool(str(settings.get("url") or "").strip())

    def health(self) -> dict[str, Any]:
        settings = self.settings()
        url = str(settings.get("url") or "").strip().rstrip("/")
        if not url:
            return {"ok": False, "error": "sentinel solver 未配置 url"}
        try:
            request = urllib.request.Request(
                url + "/health",
                headers=self._headers(settings, with_key=False),
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=float(settings.get("timeout_seconds") or 30)) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:200]}

    @staticmethod
    def _headers(settings: dict[str, Any], with_key: bool = True) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        key = str(settings.get("key") or "").strip()
        if with_key and key:
            headers["X-Solver-Key"] = key
        return headers

    def solve_turnstile(self, requirements: dict[str, Any], p_token: str, timeout: float | None = None) -> str | None:
        """返回 turnstile token；未配置或失败时返回 None（由调用方回退）。"""
        settings = self.settings()
        if not self.enabled():
            return None
        url = str(settings["url"]).strip().rstrip("/") + "/turnstile"
        payload = json.dumps({"requirements": requirements, "p": p_token}).encode("utf-8")
        wait = float(timeout if timeout is not None else (settings.get("timeout_seconds") or 180))
        try:
            request = urllib.request.Request(url, data=payload, headers=self._headers(settings), method="POST")
            with urllib.request.urlopen(request, timeout=wait) as response:
                data = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            logger.warning({"event": "sentinel_solver_http_error", "status": exc.code, "detail": detail})
            return None
        except Exception as exc:
            logger.warning({"event": "sentinel_solver_failed", "error": str(exc)[:200]})
            return None
        if not isinstance(data, dict) or not data.get("ok"):
            logger.warning({
                "event": "sentinel_solver_rejected",
                "error": str((data or {}).get("error") or "")[:200],
            })
            return None
        token = str(data.get("turnstile") or "").strip()
        return token or None


sentinel_solver_service = SentinelSolverService()
