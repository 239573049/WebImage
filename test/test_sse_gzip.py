from __future__ import annotations

import gzip
import json
import os
import unittest
import zlib
from types import SimpleNamespace

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "chatgpt2api")

from utils.helper import iter_sse_payloads


def _events(*payloads: object) -> bytes:
    return b"".join(f"data: {json.dumps(p)}\n\n".encode() for p in payloads) + b"data: [DONE]\n\n"


def _response(body_chunks: list[bytes]):
    return SimpleNamespace(iter_content=lambda: iter(body_chunks))


def _split(data: bytes, size: int) -> list[bytes]:
    return [data[i:i + size] for i in range(0, len(data), size)]


EXPECTED = ['{"a": 1}', '{"b": "\\u4e2d\\u6587"}', "[DONE]"]


class SseGzipTests(unittest.TestCase):
    def test_plain_sse_is_unchanged(self) -> None:
        body = _events({"a": 1}, {"b": "中文"})
        self.assertEqual(list(iter_sse_payloads(_response(_split(body, 3)))), EXPECTED)

    def test_crlf_split_across_chunks(self) -> None:
        body = _events({"a": 1}, {"b": "中文"}).replace(b"\n", b"\r\n")
        self.assertEqual(list(iter_sse_payloads(_response(_split(body, 1)))), EXPECTED)

    def test_single_gzip_stream_split_into_small_chunks(self) -> None:
        body = gzip.compress(_events({"a": 1}, {"b": "中文"}))
        self.assertEqual(list(iter_sse_payloads(_response(_split(body, 1)))), EXPECTED)

    def test_concatenated_gzip_members_per_event(self) -> None:
        events = [b'data: {"a": 1}\n\n', 'data: {"b": "中文"}\n\n'.encode(), b"data: [DONE]\n\n"]
        body = b"".join(gzip.compress(e) for e in events)
        payloads = list(iter_sse_payloads(_response(_split(body, 7))))
        self.assertEqual(payloads, ['{"a": 1}', '{"b": "中文"}', "[DONE]"])

    def test_sync_flushed_gzip_yields_events_before_stream_ends(self) -> None:
        compressor = zlib.compressobj(wbits=16 + zlib.MAX_WBITS)
        first = compressor.compress(b'data: {"a": 1}\n\n') + compressor.flush(zlib.Z_SYNC_FLUSH)
        rest = compressor.compress(b"data: [DONE]\n\n") + compressor.flush()

        def chunks():
            yield first
            self.assertEqual(seen, ['{"a": 1}'])  # 第一个事件在剩余数据到达前就已产出
            yield rest

        seen: list[str] = []
        for payload in iter_sse_payloads(SimpleNamespace(iter_content=chunks)):
            seen.append(payload)
        self.assertEqual(seen, ['{"a": 1}', "[DONE]"])

    def test_falls_back_to_iter_lines(self) -> None:
        response = SimpleNamespace(iter_lines=lambda: iter([b'data: {"a": 1}', b"", "data: [DONE]"]))
        self.assertEqual(list(iter_sse_payloads(response)), ['{"a": 1}', "[DONE]"])


if __name__ == "__main__":
    unittest.main()
