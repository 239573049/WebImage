"""30 RPM 压测:/v1/images/generations

用法:
    .venv/bin/python scripts/loadtest_image_30rpm.py [时长秒] [RPM]

默认 300 秒、30 RPM(每 2 秒 1 个请求),response_format=url。
输出逐请求进度行,结束后打印统计(成功率、延迟分位、吞吐、并发峰值)。
"""
from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time
from collections import Counter

import httpx

BASE_URL = "http://130.94.18.82:3000"
API_KEY = "dd666666"
MODEL = "gpt-image-2"
TIMEOUT = 300.0

DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 300.0
RPM = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
INTERVAL = 60.0 / RPM

PROMPTS = [
    "a tiny red apple on white background",
    "a blue paper crane on a wooden desk",
    "an orange tabby cat sitting in a cardboard box",
    "a green ceramic teacup with steam, minimalist",
    "a yellow rubber duck floating on calm water",
    "a purple crayon drawing of a small house",
    "a white ceramic vase with one sunflower",
    "a black and white photo of a bicycle leaning on a wall",
]

results: list[dict] = []
in_flight = 0
peak_in_flight = 0
lock = asyncio.Lock()


async def one_request(client: httpx.AsyncClient, idx: int) -> None:
    global in_flight, peak_in_flight
    async with lock:
        in_flight += 1
        peak_in_flight = max(peak_in_flight, in_flight)
    started = time.monotonic()
    rec: dict = {"idx": idx, "ok": False, "latency": 0.0, "status": 0, "error": ""}
    try:
        resp = await client.post(
            f"{BASE_URL}/v1/images/generations",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={
                "model": MODEL,
                "prompt": PROMPTS[idx % len(PROMPTS)],
                "n": 1,
                "size": "1024x1024",
                "response_format": "url",
            },
        )
        rec["latency"] = time.monotonic() - started
        rec["status"] = resp.status_code
        if resp.status_code == 200:
            body = resp.json()
            items = body.get("data") or []
            if items and items[0].get("url"):
                rec["ok"] = True
            else:
                rec["error"] = f"no image url in response: {json.dumps(body)[:200]}"
        else:
            rec["error"] = resp.text[:200]
    except Exception as exc:  # noqa: BLE001
        rec["latency"] = time.monotonic() - started
        rec["error"] = f"{type(exc).__name__}: {exc}"[:200]
    finally:
        async with lock:
            in_flight -= 1
    results.append(rec)
    mark = "OK " if rec["ok"] else "ERR"
    print(
        f"[{rec['idx']:3d}] {mark} {rec['status'] or '-':>3} "
        f"{rec['latency']:6.1f}s inflight={in_flight} {rec['error']}",
        flush=True,
    )


def pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = min(len(sorted_vals) - 1, max(0, round(p / 100 * (len(sorted_vals) - 1))))
    return sorted_vals[k]


async def main() -> None:
    t0 = time.monotonic()
    print(f"目标: {BASE_URL}  模型: {MODEL}  压力: {RPM:.0f} RPM x {DURATION:.0f}s", flush=True)
    timeout = httpx.Timeout(TIMEOUT, connect=15.0)
    # trust_env=False:忽略 HTTP_PROXY 等环境变量,直连目标,避免本机代理干扰压测
    async with httpx.AsyncClient(timeout=timeout, trust_env=False, limits=httpx.Limits(max_connections=100)) as client:
        tasks: list[asyncio.Task] = []
        idx = 0
        while True:
            elapsed = time.monotonic() - t0
            if elapsed >= DURATION:
                break
            tasks.append(asyncio.create_task(one_request(client, idx)))
            idx += 1
            await asyncio.sleep(INTERVAL)
        await asyncio.gather(*tasks)

    total_wall = time.monotonic() - t0
    ok = [r for r in results if r["ok"]]
    fail = [r for r in results if not r["ok"]]
    lat = sorted(r["latency"] for r in ok)
    summary = {
        "计划压力": f"{RPM:.0f} RPM ({INTERVAL:.2f}s 间隔)",
        "发起请求数": len(results),
        "成功": len(ok),
        "失败": len(fail),
        "成功率%": round(100 * len(ok) / len(results), 2) if results else 0,
        "实际吞吐RPM": round(len(ok) / total_wall * 60, 2),
        "总耗时s": round(total_wall, 1),
        "延迟_成功_avg_s": round(statistics.mean(lat), 1) if lat else None,
        "延迟_成功_p50_s": round(pct(lat, 50), 1) if lat else None,
        "延迟_成功_p90_s": round(pct(lat, 90), 1) if lat else None,
        "延迟_成功_p99_s": round(pct(lat, 99), 1) if lat else None,
        "延迟_成功_max_s": round(max(lat), 1) if lat else None,
        "并发峰值": peak_in_flight,
        "失败分类": dict(Counter(r["error"][:80] or f"HTTP {r['status']}" for r in fail)),
    }
    print("\n===== 压测结果 =====")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    with open("/tmp/loadtest_30rpm_results.json", "w") as fh:
        json.dump({"summary": summary, "requests": results}, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    asyncio.run(main())
