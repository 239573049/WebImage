"""ChatGPT 网页 sentinel（PoW / 指纹）实现。

对齐 2026-02 版 SDK（chatgpt.com/sentinel/<build>/sdk.js）：
- 指纹是 25 项数组，取值方式、顺序与 SDK 的 getConfig() 一致。
- 序列化方式与 SDK 的 N() 一致：JSON.stringify 后按 UTF-8 字节取 latin-1 再 btoa。
- 校验方式与 _runCheck() 一致：FNV-1a-32(seed + answer) 的 16 进制前 N 位与 difficulty 做字符串比较，
  命中时答案带 "~S" 后缀；否则服务端会当作未通过（失败答案带 errorPrefix 前缀）。
"""

from __future__ import annotations

import base64
import json
import random
import re
import time
import uuid
from datetime import datetime
from html.parser import HTMLParser
from typing import Any, Sequence

DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js"

# 未通过的答案统一带这个前缀（SDK 的 errorPrefix）
FAILURE_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"
# 命中答案的后缀（SDK 的 _runCheck 命中时返回 answer + "~S"）
PROOF_SUFFIX = "~S"

# 指纹里与「客户端硬件/环境」相关的取值。真机由浏览器读取；这里给默认值，可用参数覆盖。
DEFAULT_SCREEN_SIZE = 3000            # screen.width + screen.height
DEFAULT_JS_HEAP_LIMIT = 4395630592    # performance.memory.jsHeapSizeLimit
DEFAULT_HARDWARE_CONCURRENCY = 10     # navigator.hardwareConcurrency
DEFAULT_LANGUAGES = ["zh-CN", "en", "en-GB", "en-US"]   # navigator.languages
DEFAULT_LANGUAGE = "zh-CN"            # navigator.language

# document / window / navigator 三类「探测项」的候选值（SDK 各随机取一个）
DOCUMENT_KEYS = ["__reactContainer$fzelfjyxej8", "_reactListening5dehydibo78", "location"]
WINDOW_KEYS = [
    "0", "window", "self", "document", "name", "location", "customElements", "history",
    "navigation", "innerWidth", "innerHeight", "scrollX", "scrollY", "visualViewport",
    "screenX", "screenY", "outerWidth", "outerHeight", "devicePixelRatio", "screen",
    "chrome", "navigator", "onresize", "performance", "crypto", "indexedDB",
    "sessionStorage", "localStorage", "scheduler", "alert", "atob", "btoa", "fetch",
    "matchMedia", "postMessage", "queueMicrotask", "requestAnimationFrame", "setInterval",
    "setTimeout", "caches", "__NEXT_DATA__", "__BUILD_MANIFEST", "__NEXT_PRELOADREADY",
]
NAVIGATOR_PROBES = [
    "registerProtocolHandler−function registerProtocolHandler() { [native code] }",
    "storage−[object StorageManager]",
    "locks−[object LockManager]",
    "appCodeName−Mozilla",
    "permissions−[object Permissions]",
    "share−function share() { [native code] }",
    "webdriver−false",
    "managed−[object NavigatorManagedData]",
    "canShare−function canShare() { [native code] }",
    "vendor−Google Inc.",
    "mediaDevices−[object MediaDevices]",
    "vibrate−function vibrate() { [native code] }",
    "storageBuckets−[object StorageBucketManager]",
    "mediaCapabilities−[object MediaCapabilities]",
    "cookieEnabled−true",
    "virtualKeyboard−[object VirtualKeyboard]",
    "product−Gecko",
    "presentation−[object Presentation]",
    "onLine−true",
    "mimeTypes−[object MimeTypeArray]",
    "credentials−[object CredentialsContainer]",
    "serviceWorker−[object ServiceWorkerContainer]",
    "keyboard−[object Keyboard]",
    "gpu−[object GPU]",
    "doNotTrack",
    "serial−[object Serial]",
    "pdfViewerEnabled−true",
    "language−zh-CN",
    "geolocation−[object Geolocation]",
    "userAgentData−[object NavigatorUAData]",
    "getUserMedia−function getUserMedia() { [native code] }",
    "sendBeacon−function sendBeacon() { [native code] }",
    "hardwareConcurrency−32",
    "windowControlsOverlay−[object WindowControlsOverlay]",
]


class ScriptSrcParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.script_sources: list[str] = []
        self.data_build = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "script":
            return
        attrs_dict = dict(attrs)
        src = attrs_dict.get("src")
        if not src:
            return
        self.script_sources.append(src)
        match = re.search(r"c/[^/]*/_", src)
        if match:
            self.data_build = match.group(0)


def parse_pow_resources(html_content: str) -> tuple[list[str], str]:
    parser = ScriptSrcParser()
    parser.feed(html_content)
    script_sources = parser.script_sources or [DEFAULT_POW_SCRIPT]
    data_build = parser.data_build
    if not data_build:
        match = re.search(r'<html[^>]*data-build="([^"]*)"', html_content)
        if match:
            data_build = match.group(1)
    return script_sources, data_build


def _to_json(value: Any) -> str:
    """与 JS 的 JSON.stringify 一致：紧凑、不转义非 ASCII。"""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _btoa(text: str) -> str:
    """与浏览器 btoa(String.fromCharCode(...new TextEncoder().encode(text))) 一致。"""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _serialize(value: Any) -> str:
    """SDK 的 N()：JSON.stringify 后按 UTF-8 字节 btoa。"""
    return _btoa(_to_json(value))


def _js_date_string() -> str:
    """等价于 JS `"" + new Date`，例如 `Thu Oct 15 2026 14:07:06 GMT+0800 (中国标准时间)`。"""
    now = datetime.now().astimezone()
    return f"{now.strftime('%a %b %d %Y %H:%M:%S')} GMT{now.strftime('%z')} ({now.tzname() or 'UTC'})"


def _fnv1a_32_hex(text: str) -> str:
    """SDK 的校验哈希：FNV-1a-32 再做一轮混合，输出 8 位十六进制。"""
    value = 2166136261
    for char in text:
        value = (value ^ ord(char)) & 0xFFFFFFFF
        value = (value * 16777619) & 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 2246822507) & 0xFFFFFFFF
    value ^= value >> 13
    value = (value * 3266489909) & 0xFFFFFFFF
    value ^= value >> 16
    return format(value & 0xFFFFFFFF, "x").zfill(8)


def _answer_accepted(seed: str, difficulty: str, answer: str) -> bool:
    """SDK 的 _runCheck 判定：哈希前 len(difficulty) 位十六进制串 <= difficulty。"""
    return _fnv1a_32_hex(f"{seed}{answer}")[: len(difficulty)] <= difficulty


def build_pow_config(
    user_agent: str,
    script_sources: Sequence[str] | None = None,
    data_build: str = "",
    *,
    screen_size: int = DEFAULT_SCREEN_SIZE,
    js_heap_limit: int = DEFAULT_JS_HEAP_LIMIT,
    hardware_concurrency: int = DEFAULT_HARDWARE_CONCURRENCY,
    languages: Sequence[str] | None = None,
    language: str = DEFAULT_LANGUAGE,
    sid: str = "",
) -> list[Any]:
    """构造 SDK getConfig() 的 25 项指纹数组。"""
    script_source = random.choice(list(script_sources)) if script_sources else DEFAULT_POW_SCRIPT
    language_list = list(languages) if languages else list(DEFAULT_LANGUAGES)
    return [
        screen_size,                                   # 0  screen.width + screen.height
        _js_date_string(),                             # 1  "" + new Date
        js_heap_limit,                                 # 2  performance.memory.jsHeapSizeLimit
        1,                                             # 3  尝试次数（种子 token 固定为 1）
        user_agent,                                    # 4  navigator.userAgent
        script_source,                                 # 5  随机取一个 <script src>
        data_build,                                    # 6  页面 build（取自 /c/<build>/_ 或 data-build）
        language,                                      # 7  navigator.language
        ",".join(language_list),                       # 8  navigator.languages.join(",")
        random.random(),                               # 9  耗时（种子 token 是小数，证明 token 里是整毫秒）
        random.choice(NAVIGATOR_PROBES),               # 10 navigator[d] + "−" + navigator[d].toString()
        random.choice(DOCUMENT_KEYS),                  # 11 document 上随机取一个属性
        random.choice(WINDOW_KEYS),                    # 12 window 上随机取一个属性
        time.perf_counter() * 1000,                    # 13 performance.now()
        sid or str(uuid.uuid4()),                      # 14 sid
        "",                                            # 15 location.search 解析出来的参数（本实现没有）
        hardware_concurrency,                          # 16 navigator.hardwareConcurrency
        time.time() * 1000 - time.perf_counter() * 1000,   # 17 performance.timeOrigin
        0,  # 18 "ai" in window
        0,  # 19 "createPRNG" in window
        0,  # 20 "cache" in window
        0,  # 21 "data" in window
        0,  # 22 "solana" in window
        0,  # 23 "dump" in window
        0,  # 24 "InstallTrigger" in window
    ]


def _pow_generate(seed: str, difficulty: str, config: list[Any], limit: int = 500000) -> tuple[str, bool]:
    """按 SDK 的方式求解：逐次尝试，命中返回 (answer, True)。"""
    started = time.perf_counter()
    for attempt in range(limit):
        config[3] = attempt
        config[9] = round((time.perf_counter() - started) * 1000)
        answer = _serialize(config)
        if _answer_accepted(seed, difficulty, answer):
            return answer, True
    return FAILURE_PREFIX + _serialize(difficulty), False


def build_legacy_requirements_token(
    user_agent: str,
    script_sources: Sequence[str] | None = None,
    data_build: str = "",
    **fingerprint: Any,
) -> str:
    """种子 token（prepare 请求里的 p）。"""
    config = build_pow_config(user_agent, script_sources=script_sources, data_build=data_build, **fingerprint)
    config[3] = 1
    config[9] = round(random.random(), 6)
    return "gAAAAAC" + _serialize(config)


def build_proof_token(
    seed: str,
    difficulty: str,
    user_agent: str,
    script_sources: Sequence[str] | None = None,
    data_build: str = "",
    **fingerprint: Any,
) -> str:
    """证明 token：命中后带 "~S" 后缀，服务端据此判定客户端环境是否可信。"""
    config = build_pow_config(user_agent, script_sources=script_sources, data_build=data_build, **fingerprint)
    answer, solved = _pow_generate(seed, difficulty, config)
    if not solved:
        raise RuntimeError(f"failed to solve proof token: difficulty={difficulty}")
    return "gAAAAAB" + answer + PROOF_SUFFIX
