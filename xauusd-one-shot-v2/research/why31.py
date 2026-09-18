"""3 個月為什麼只有 31 筆？把漏斗攤開。"""
import contextlib, io, importlib.util
import numpy as np, pandas as pd
from numba import njit

spec = importlib.util.spec_from_file_location("ws", "./winrate_sweep.py")
ws = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ws)
q = ws.ev.q
m = (q.index >= pd.Timestamp("2024-01-01", tz="UTC")) & (q.index < pd.Timestamp("2026-09-17", tz="UTC"))
qq = q[m]
DAYS = 932.0

print("="*72)
print("進場漏斗：從 M15 K 棒一路篩到實際成交")
print("="*72)
tot = len(qq)
hour = (qq.index + pd.Timedelta(minutes=15)).hour
steps = [
    ("全部 M15 K 棒（2024-01-01 ~ 2026-09-16）", np.ones(tot, bool)),
    ("+ 時段 UTC 12:00~21:59", (hour >= 12) & (hour <= 21)),
    ("+ H4 趨勢強度 |EMA50-EMA200|/ATR > 1.0", qq.h4_macro.abs() > 1.0),
    ("+ H1 趨勢 |EMA20-EMA50|/ATR > 0.25", qq.h1_trend.abs() > 0.25),
    ("+ 波動帶 ATR/前50根均值 0.8~1.8", qq.atrrel.between(0.8, 1.8)),
    ("+ 位置 pos32 >0.70 或 <0.30", (qq.pos32 > 0.70) | (qq.pos32 < 0.30)),
    ("+ 實體 |body| > 0.30", qq.body.abs() > 0.30),
]
cum = np.ones(tot, bool)
prev = tot
for name, cond in steps:
    cum = cum & np.asarray(cond)
    c = int(cum.sum())
    print(f"  {name:<44}{c:>8} 根  ({c/tot*100:>5.2f}%)"
          f"{'' if prev==tot else f'  砍掉 {(1-c/prev)*100:>4.1f}%'}")
    prev = c

# 方向一致（多空條件要同號）才是真訊號
sig = np.asarray(ws.sig_i)
qi = q.index
raw = int(((sig != 0) & np.asarray((qi >= pd.Timestamp("2024-01-01", tz="UTC")) &
                                   (qi < pd.Timestamp("2026-09-17", tz="UTC")))).sum())
print(f"  {'+ 多空條件方向一致':<44}{raw:>8} 根  ({raw/tot*100:>5.2f}%)")

traded = len(ws.run(*ws.FULL))
print(f"\n  → 原始訊號 {raw} 根，但實際只成交 {traded} 筆")
print(f"  → 最後這一刀砍掉 {(1-traded/raw)*100:.1f}%，就是「單倉不重疊」")

print("\n" + "="*72)
print("真正的瓶頸：單倉不重疊")
print("="*72)

@njit(cache=True)
def bt_slots(sig, qpos, atr, o, hi, lo, cl, sp, ts, start, end, slots, out_r, out_hold):
    """允許同時持有 slots 個部位。回傳筆數與每筆持有秒數。"""
    slip, fee, carry = .05, .07, .30
    n = 0; nbar = len(o)
    busy_until = np.zeros(slots, np.int64) - 1          # 每個槽位佔用到哪一根
    for z in range(len(sig)):
        side = sig[z]
        if side == 0: continue
        i = qpos[z]
        if i < 0 or i >= nbar: continue
        if ts[i] < start or ts[i] >= end or not np.isfinite(atr[z]): continue
        slot = -1
        for s in range(slots):
            if i > busy_until[s]: slot = s; break
        if slot < 0: continue
        dist = 2.0 * atr[z]
        if dist <= 0.0: continue
        entry = (o[i] + sp[i] if side == 1 else o[i]) + side * slip
        stop = entry - side * dist; target = entry + side * 5.0 * dist
        deadline = ts[i] + 48 * 3600
        pending = False; peak = 0.0; fill = np.nan; j = i
        for jj in range(i, nbar):
            if ts[jj] >= end:
                j = i if jj - 1 < i else jj - 1
                break
            j = jj
            if pending:
                if side == 1:
                    if entry > stop: stop = entry
                else:
                    if entry < stop: stop = entry
                pending = False
            if jj > i and ts[jj] >= deadline:
                fill = (o[jj] + (sp[jj] if side == -1 else 0.0)) - side * slip; break
            adj = sp[jj] if side == -1 else 0.0
            oo = o[jj] + adj; hh = hi[jj] + adj; ll = lo[jj] + adj
            if side == 1:
                if oo <= stop:   fill = oo - slip; break
                if oo >= target: fill = target;    break
                if ll <= stop:   fill = stop - slip; break
                if hh >= target: fill = target;    break
            else:
                if oo >= stop:   fill = oo + slip; break
                if oo <= target: fill = target;    break
                if hh >= stop:   fill = stop + slip; break
                if ll <= target: fill = target;    break
            exc = side * ((cl[jj] + adj) - entry) / dist
            if exc > peak: peak = exc
            if peak >= 1.5: pending = True
        if not np.isfinite(fill):
            fill = (cl[j] + (sp[j] if side == -1 else 0.0)) - side * slip
        days = ts[j] // 86400 - ts[i] // 86400
        if days < 0: days = 0
        out_r[n] = (side * (fill - entry) - fee - carry * days) / dist
        out_hold[n] = ts[j] - ts[i]
        busy_until[slot] = j
        n += 1
    return n

B = len(ws.sig_i) + 10
_r = np.empty(B); _h = np.empty(B, np.int64)
a, b = ws.sec("2024-01-01"), ws.sec("2026-09-17")
print(f"  {'同時持倉上限':>12}{'總筆數':>9}{'每91天':>9}{'平均R':>10}{'PF':>8}"
      f"{'在場時間佔比':>13}{'每91天對數成長':>15}")
for slots in [1, 2, 3, 5, 8]:
    n = bt_slots(ws.sig_i, ws.qpos_i, ws.atr_f, ws.o, ws.hi, ws.lo, ws.cl, ws.sp,
                 ws.ts, a, b, slots, _r, _h)
    rr = _r[:n]; hh = _h[:n]
    pf = rr[rr > 0].sum() / max(1e-9, -rr[rr < 0].sum())
    occ = hh.sum() / (DAYS * 86400) / slots
    fs = np.arange(0.01, 0.385, 0.01)
    g = np.array([np.mean(np.log(np.maximum(1e-12, 1 + f * rr))) for f in fs])
    # 多槽位時每槽的名目風險要除以槽數，總曝險才不變
    g91 = g.max() * n / DAYS * 91.0 / slots
    print(f"  {slots:>12}{n:>9}{n/DAYS*91:>9.0f}{rr.mean():>+10.4f}{pf:>8.3f}"
          f"{occ*100:>12.1f}%{g91:>15.4f}")

n = bt_slots(ws.sig_i, ws.qpos_i, ws.atr_f, ws.o, ws.hi, ws.lo, ws.cl, ws.sp,
             ws.ts, a, b, 1, _r, _h)
hh = _h[:n] / 3600.0
print(f"\n  單倉時每筆平均持有 {hh.mean():.1f} 小時，中位 {np.median(hh):.1f} 小時，"
      f"最長 {hh.max():.1f} 小時")
print(f"  帳戶有 {hh.sum()/(DAYS*24)*100:.1f}% 的時間卡在持倉中，期間所有新訊號一律放棄")
