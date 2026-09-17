"""比對『研究程式口徑』與『EA 視窗式口徑』是否產生相同訊號。

研究路徑 : 一次對整段序列計算（final_validation.py / external_validation_runner.py）
EA   路徑 : 每根 M15 收盤時，只用「當下可取得的最後 N 根已收盤 K 棒」重算
            （OneShotV2_EA.mq5 的 LoadClosedRates + SeriesATR/SeriesEMA + TrendValue）

純標準函式庫，不依賴 pandas/numpy。
"""
import gzip, csv, random, statistics
from datetime import datetime, timezone

CSV = "./data/XAUUSD_M5.csv.gz"

# ---- 凍結參數 -------------------------------------------------------------
H4_MIN, H1_MIN = 1.00, 0.25
POS_L, POS_S   = 0.70, 0.30
BODY_MIN       = 0.30
ATRLO, ATRHI   = 0.80, 1.80
HOUR_FROM, HOUR_TO = 12, 21
# ---- EA 視窗長度 ----------------------------------------------------------
M15_BARS, H1_BARS, H1_FOR_H4 = 1500, 2000, 8000

def load_m5():
    rows = []
    with gzip.open(CSV, "rt") as fh:
        for r in csv.DictReader(fh):
            ts = int(datetime.strptime(r["time"][:19], "%Y-%m-%d %H:%M:%S")
                     .replace(tzinfo=timezone.utc).timestamp())
            rows.append((ts, float(r["open"]), float(r["high"]),
                         float(r["low"]), float(r["close"])))
    rows.sort()
    return rows

def resample(m5, period):
    """label=left, closed=left；無資料的區間直接略過（等同 pandas dropna）。"""
    out, cur = [], None
    for ts, o, h, l, c in m5:
        blk = (ts // period) * period
        if cur is None or blk != cur:
            out.append([blk, o, h, l, c]); cur = blk
        else:
            b = out[-1]
            if h > b[2]: b[2] = h
            if l < b[3]: b[3] = l
            b[4] = c
    return out

def wilder_atr(bars, lo, hi, period=14):
    """pandas ewm(alpha=1/14, adjust=False)；種子 tr[0]=high-low。"""
    a = 1.0 / period
    v = bars[lo][2] - bars[lo][3]
    out = [v]
    for i in range(lo + 1, hi):
        pc = bars[i - 1][4]
        tr = max(bars[i][2] - bars[i][3], abs(bars[i][2] - pc), abs(bars[i][3] - pc))
        v += a * (tr - v)
        out.append(v)
    return out

def ema(bars, lo, hi, span):
    """pandas ewm(span=N, adjust=False)；種子 close[0]。"""
    a = 2.0 / (span + 1.0)
    e = bars[lo][4]
    out = [e]
    for i in range(lo + 1, hi):
        e += a * (bars[i][4] - e)
        out.append(e)
    return out

def trend_at(bars, period, decision_ts, fast, slow, lo=0):
    """只使用收盤時間 <= decision_ts 的 K 棒；回傳 (fast-slow)/ATR。"""
    last = -1
    for i in range(len(bars) - 1, lo - 1, -1):
        if bars[i][0] + period <= decision_ts:
            last = i; break
    if last < lo: return None
    n = last + 1
    atr = wilder_atr(bars, lo, n)
    f   = ema(bars, lo, n, fast)
    s   = ema(bars, lo, n, slow)
    j = last - lo
    if atr[j] <= 0: return None
    return (f[j] - s[j]) / atr[j]

def side_from(h4m, h1t, pos, body, atrrel, hour):
    if None in (h4m, h1t): return 0
    sess = HOUR_FROM <= hour <= HOUR_TO
    vol  = ATRLO <= atrrel <= ATRHI
    if h4m >  H4_MIN and h1t >  H1_MIN and pos > POS_L and body >  BODY_MIN and vol and sess: return 1
    if h4m < -H4_MIN and h1t < -H1_MIN and pos < POS_S and body < -BODY_MIN and vol and sess: return -1
    return 0

print("載入 M5 …")
m5 = load_m5()
q  = resample(m5,   900)
h1 = resample(m5,  3600)
h4 = resample(m5, 14400)
print(f"M5={len(m5)}  M15={len(q)}  H1={len(h1)}  H4={len(h4)}")

# --- 先驗證 H1 聚合成 H4 是否等於直接由 M5 聚合成 H4（EA 用 H1 重組 H4 的前提）
def h1_to_h4(bars):
    out, cur = [], None
    for ts, o, h, l, c in bars:
        blk = (ts // 14400) * 14400
        if cur is None or blk != cur:
            out.append([blk, o, h, l, c]); cur = blk
        else:
            b = out[-1]
            if h > b[2]: b[2] = h
            if l < b[3]: b[3] = l
            b[4] = c
    return out
h4b = h1_to_h4(h1)
same = (len(h4b) == len(h4)) and all(
    a[0] == b[0] and max(abs(a[i]-b[i]) for i in range(1,5)) < 1e-9
    for a, b in zip(h4b, h4))
print(f"H1→H4 聚合 == M5→H4 聚合 : {'一致' if same else '不一致'}  ({len(h4b)} vs {len(h4)} 根)")

# --- 研究路徑：整段序列只算一次（這才是研究程式的真實做法）
import bisect

def trend_series(bars, fast, slow):
    n = len(bars)
    atr = wilder_atr(bars, 0, n)
    f   = ema(bars, 0, n, fast)
    sl  = ema(bars, 0, n, slow)
    return [ (f[i] - sl[i]) / atr[i] if atr[i] > 0 else None for i in range(n) ]

H1_TREND = trend_series(h1, 20, 50)
H4_MACRO = trend_series(h4, 50, 200)
H1_CLOSE = [b[0] + 3600  for b in h1]
H4_CLOSE = [b[0] + 14400 for b in h4]

def pick(closes, series, dec):
    i = bisect.bisect_right(closes, dec) - 1
    return series[i] if i >= 0 else None

ATR = wilder_atr(q, 0, len(q))
research = {}
for z in range(51, len(q)):
    if ATR[z] <= 0: continue
    lo32 = min(b[3] for b in q[z-32:z]); hi32 = max(b[2] for b in q[z-32:z])
    if hi32 <= lo32: continue
    denom = sum(ATR[z-50:z]) / 50.0
    if denom <= 0: continue
    dec  = q[z][0] + 900
    pos  = (q[z][4] - lo32) / (hi32 - lo32)
    body = (q[z][4] - q[z][1]) / ATR[z]
    rel  = ATR[z] / denom
    hour = (dec // 3600) % 24
    h1t = pick(H1_CLOSE, H1_TREND, dec)
    h4m = pick(H4_CLOSE, H4_MACRO, dec)
    research[z] = (side_from(h4m, h1t, pos, body, rel, hour), h4m, h1t, pos, body, rel, int(hour))

sig_idx = [z for z, v in research.items() if v[0] != 0]
longs  = sum(1 for z in sig_idx if research[z][0] ==  1)
shorts = sum(1 for z in sig_idx if research[z][0] == -1)
print(f"研究路徑訊號數 = {len(sig_idx)}  (多 {longs} / 空 {shorts})")

# --- EA 路徑：只用「當下可取得的視窗」重算
random.seed(20260917)
others = [z for z, v in research.items() if v[0] == 0 and z > 3000]
sample = sorted(set(sig_idx) | set(random.sample(others, 3000)))
print(f"比對根數 = {len(sample)}")

mismatch, worst, checked = 0, [0.0] * 5, 0
for z in sample:
    lo = max(0, z - M15_BARS + 1)
    A  = wilder_atr(q, lo, z + 1)
    j  = z - lo
    if A[j] <= 0 or j < 51: continue
    lo32 = min(b[3] for b in q[z-32:z]); hi32 = max(b[2] for b in q[z-32:z])
    denom = sum(A[j-50:j]) / 50.0
    dec  = q[z][0] + 900
    pos  = (q[z][4] - lo32) / (hi32 - lo32)
    body = (q[z][4] - q[z][1]) / A[j]
    rel  = A[j] / denom
    hour = (dec // 3600) % 24

    hp = bisect.bisect_right(H1_CLOSE, dec) - 1
    if hp < 0: continue
    h1t = trend_at(h1, 3600, dec, 20, 50, lo=max(0, hp - H1_BARS + 1))
    win = h1[max(0, hp - H1_FOR_H4 + 1): hp + 1]
    h4m = trend_at(h1_to_h4(win), 14400, dec, 50, 200)

    side = side_from(h4m, h1t, pos, body, rel, int(hour))
    r = research[z]
    checked += 1
    if side != r[0]:
        mismatch += 1
        if mismatch <= 5:
            print(f"  MISMATCH z={z} {datetime.utcfromtimestamp(q[z][0])} research={r[0]} ea={side}")
    for i, (a, b) in enumerate(((h4m, r[1]), (h1t, r[2]), (pos, r[3]), (body, r[4]), (rel, r[5]))):
        if a is not None and b is not None:
            worst[i] = max(worst[i], abs(a - b))

print(f"\n實際比對 = {checked} 根")
print(f"訊號不一致 = {mismatch}")
print("特徵最大絕對誤差： h4_macro=%.3e  h1_trend=%.3e  pos32=%.3e  body=%.3e  atrrel=%.3e" % tuple(worst))
print("\n" + ("EA 視窗式算法與研究程式等價 ✓" if mismatch == 0 else "*** 有落差，需檢查 ***"))
