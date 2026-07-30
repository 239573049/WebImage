"""生产诊断：算出真实生图容量，定位卡点。在项目根目录运行。"""
import sys, json, sqlite3, hashlib, time
sys.path.insert(0, ".")

DB_ACCT = "data/accounts.db"
DB_RT   = "data/image_runtime.db"
CONC    = json.load(open("config.json")).get("image_account_concurrency", 3)

def key(tok): return hashlib.sha256(tok.encode()).hexdigest()

accts = [json.loads(r[0]) for r in sqlite3.connect(DB_ACCT).execute("select data from accounts")]
rt = sqlite3.connect(DB_RT); rt.row_factory = sqlite3.Row
health = {r["account_key"]: dict(r) for r in rt.execute("select * from image_account_health")}

print(f"账号总数: {len(accts)}   image_account_concurrency={CONC}\n")
buckets, capacity, now = {}, 0, time.time()
for a in accts:
    tok = a.get("access_token") or ""
    st, q = a.get("status"), int(a.get("quota") or 0)
    h  = health.get(key(tok), {})
    hs = h.get("state") or "healthy"
    cd = h.get("cooldown_until")
    if hs == "open" and cd and cd <= now: hs = "half_open"

    if st in {"禁用","限流","异常"}: r, c = f"状态={st}", 0
    elif q <= 0:                      r, c = "quota=0", 0
    elif hs == "open":                r, c = f"熔断(剩{int((cd or now)-now)}s)", 0
    elif hs in {"probation","half_open"}: r, c = f"健康={hs}", 1
    else:                             r, c = f"可用({hs})", CONC
    buckets[r] = buckets.get(r, 0) + 1
    capacity += c

for r, n in sorted(buckets.items(), key=lambda x: -x[1]):
    print(f"  {n:>4} 个  {r}")

print(f"\n{'='*46}\n实际并发容量 = {capacity} 槽\n{'='*46}")
print(f"→ 并发 ≤ {capacity} 不排队 (约 40-75s)")
print(f"→ 并发 > {capacity} 每多一波 +40-75s")
if capacity: print(f"→ 并发 15 时: {-(-15//capacity)} 波 ≈ {-(-15//capacity)*55}s")
