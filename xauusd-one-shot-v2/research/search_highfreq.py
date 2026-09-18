"""認真嘗試：有沒有辦法在 91 天把 60U 變成 10000U。

數學上唯一的路是「大幅提高每 91 天的對數成長」。倉位已在 Kelly 最佳點，
所以只剩兩條：提高交易筆數、或提高每筆邊際。這支去暴力搜尋兩者。

紀律：2024-2025 訓練、2026 完全不看地當作 holdout。選完才看 test。
"""
import json, time, contextlib, io, importlib.util
import numpy as np
from numba import njit

t0 = time.time()
spec = importlib.util.spec_from_file_location("ws", "./winrate_sweep.py")
ws = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ws)
sig_for = ws.ev.ns["sig_for"]
q = ws.ev.q


@njit(cache=True)
def bt(sig, qpos, atr, o, hi, lo, cl, sp, ts, start, end,
       stop_k, tp_r, be_trig, hold_h, out_r):
    slip, fee, carry = .05, .07, .30
    n = 0; last = -1; nbar = len(o)
    for z in range(len(sig)):
        side = sig[z]
        if side == 0: continue
        i = qpos[z]
        if i < 0 or i <= last or i >= nbar: continue
        if ts[i] < start or ts[i] >= end or not np.isfinite(atr[z]): continue
        dist = stop_k * atr[z]
        if dist <= 0.0: continue
        entry = (o[i] + sp[i] if side == 1 else o[i]) + side * slip
        stop = entry - side * dist; target = entry + side * tp_r * dist
        deadline = ts[i] + hold_h * 3600
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
            if be_trig > 0.0 and peak >= be_trig: pending = True
        if not np.isfinite(fill):
            fill = (cl[j] + (sp[j] if side == -1 else 0.0)) - side * slip
        days = ts[j] // 86400 - ts[i] // 86400
        if days < 0: days = 0
        out_r[n] = (side * (fill - entry) - fee - carry * days) / dist
        n += 1; last = j
    return n


BUF = len(q) + 10; _r = np.empty(BUF)
TR = (ws.sec("2024-01-01"), ws.sec("2026-01-01"))     # 訓練
TE = (ws.sec("2026-01-01"), ws.sec("2026-09-17"))     # holdout
TR_DAYS, TE_DAYS = 731.0, 259.0

def go(sig, a, b, **kw):
    n = bt(sig, ws.qpos_i, ws.atr_f, ws.o, ws.hi, ws.lo, ws.cl, ws.sp, ws.ts, a, b,
           kw["stop_k"], kw["tp_r"], kw["be_trig"], kw["hold_h"], _r)
    return _r[:n].copy()

def growth91(rr, days):
    """在 Kelly 最佳 f（上限 38%）下，每 91 天的對數成長。"""
    if len(rr) < 30: return -9.9, 0.0, 0
    fs = np.arange(0.01, 0.385, 0.01)
    g = np.array([np.mean(np.log(np.maximum(1e-12, 1 + f * rr))) for f in fs])
    i = int(np.argmax(g))
    per91 = g[i] * len(rr) / days * 91.0
    return float(per91), float(fs[i]), len(rr)

SIGSETS = []
for h4 in [0.0, 0.5, 1.0]:
    for h1 in [0.0, 0.25]:
        for pos in [0.55, 0.65, 0.70]:
            for body in [0.10, 0.30]:
                SIGSETS.append((h4, h1, pos, body))
EXITS = [dict(stop_k=sk, tp_r=tp, be_trig=be, hold_h=hh)
         for sk in [0.5, 1.0, 1.5, 2.0] for tp in [1.0, 2.0, 3.0, 5.0]
         for be in [0.0, 1.5] for hh in [4, 12, 24, 48]]
print(f"[{time.time()-t0:4.1f}s] 搜尋空間：{len(SIGSETS)} 組進場 x {len(EXITS)} 組出場 "
      f"= {len(SIGSETS)*len(EXITS)} 組")

rows = []
for (h4, h1, pos, body) in SIGSETS:
    s = np.asarray(sig_for(h4, h1, pos, body), np.int8)
    if int((s != 0).sum()) < 50: continue
    for ex in EXITS:
        rr = go(s, *TR, **ex)
        g91, f_opt, n = growth91(rr, TR_DAYS)
        if n < 60: continue
        rows.append(dict(h4=h4, h1=h1, pos=pos, body=body, **ex,
                         train_g91=g91, f=f_opt, train_n=n,
                         train_meanR=float(rr.mean()), train_pf=float(
                             rr[rr>0].sum() / max(1e-9, -rr[rr<0].sum()))))
print(f"[{time.time()-t0:4.1f}s] 有效組合 {len(rows)} 組")

NEED = np.log(10000.0 / 60.0)
rows.sort(key=lambda x: -x["train_g91"])
print(f"\n  目標：每 91 天對數成長要達到 ln(167) = {NEED:.3f}")
print(f"\n【訓練集最強的 10 組】")
print(f"  {'H4':>5}{'H1':>6}{'pos':>6}{'body':>6}{'停損':>6}{'TP':>5}{'保本':>6}{'持有':>6}"
      f"{'筆數':>7}{'平均R':>9}{'PF':>7}{'f*':>6}{'每91天成長':>11}{'倍數':>9}")
for x in rows[:10]:
    print(f"  {x['h4']:>5.2f}{x['h1']:>6.2f}{x['pos']:>6.2f}{x['body']:>6.2f}"
          f"{x['stop_k']:>6.1f}{x['tp_r']:>5.1f}{x['be_trig']:>6.1f}{x['hold_h']:>5}h"
          f"{x['train_n']:>7}{x['train_meanR']:>+9.4f}{x['train_pf']:>7.3f}"
          f"{x['f']*100:>5.0f}%{x['train_g91']:>11.4f}{np.exp(x['train_g91']):>9.2f}x")

print(f"\n【把訓練集最強的 10 組拿去 2026 holdout】")
print(f"  {'#':>3}{'訓練成長':>11}{'訓練倍數':>10}{'  |':>4}{'holdout筆數':>12}"
      f"{'holdout平均R':>14}{'holdout PF':>12}{'holdout成長':>13}{'holdout倍數':>12}")
keep = []
for i, x in enumerate(rows[:10]):
    s = np.asarray(sig_for(x["h4"], x["h1"], x["pos"], x["body"]), np.int8)
    rr = go(s, *TE, stop_k=x["stop_k"], tp_r=x["tp_r"], be_trig=x["be_trig"], hold_h=x["hold_h"])
    if len(rr) < 10:
        print(f"  {i+1:>3}{x['train_g91']:>11.4f}{np.exp(x['train_g91']):>9.2f}x   |"
              f"{len(rr):>12}{'  交易太少':>26}")
        continue
    g91, _, n = growth91(rr, TE_DAYS)
    pf = rr[rr>0].sum() / max(1e-9, -rr[rr<0].sum())
    keep.append((x, g91, float(rr.mean()), float(pf), n))
    print(f"  {i+1:>3}{x['train_g91']:>11.4f}{np.exp(x['train_g91']):>9.2f}x   |"
          f"{n:>12}{rr.mean():>+14.4f}{pf:>12.3f}{g91:>13.4f}{np.exp(g91):>11.2f}x")

alive = [k for k in keep if k[1] > 0]
print(f"\n  訓練集前 10 名中，在 2026 holdout 仍為正成長的：{len(alive)}/10")
if alive:
    b = max(alive, key=lambda k: k[1])
    print(f"  其中最好的：holdout 每 91 天 {np.exp(b[1]):.2f} 倍 "
          f"→ 60U 三個月中位 {60*np.exp(b[1]):.0f}U")
    print(f"  距離 10000U 還差 {10000/(60*np.exp(b[1])):.0f} 倍")
json.dump(rows[:50], open("search_highfreq_top50.json", "w"), indent=1)
print(f"\n[{time.time()-t0:4.1f}s] 完成")
