"""半年（182 天）不出金、持續複利的結果分布。

交易筆數不是硬塞固定值，而是從歷史「每 182 天實際成交幾筆」的分布抽樣，
保留真實的疏密不均。
"""
import json, time, contextlib, io, importlib.util
import numpy as np
from numba import njit

t0 = time.time()
spec = importlib.util.spec_from_file_location("ws", "./winrate_sweep.py")
ws = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ws)


@njit(cache=True)
def bt_times(sig, qpos, atr, o, hi, lo, cl, sp, ts, start, end,
             slip, fee, carry, tp_r, be_trig, be_off, out_r, out_t):
    """與 winrate_sweep.bt_gen 同邏輯，額外輸出進場時間戳。"""
    n = 0; last = -1; nbar = len(o)
    for z in range(len(sig)):
        side = sig[z]
        if side == 0: continue
        i = qpos[z]
        if i < 0 or i <= last or i >= nbar: continue
        if ts[i] < start or ts[i] >= end or not np.isfinite(atr[z]): continue
        dist = 2.0 * atr[z]
        if dist <= 0.0: continue
        entry = (o[i] + sp[i] if side == 1 else o[i]) + side * slip
        stop = entry - side * dist; target = entry + side * tp_r * dist
        be_level = entry + side * be_off * dist
        deadline = ts[i] + 48 * 3600
        pending = False; peak = 0.0; fill = np.nan; j = i
        for jj in range(i, nbar):
            if ts[jj] >= end:
                j = i if jj - 1 < i else jj - 1
                break
            j = jj
            if pending:
                if side == 1:
                    if be_level > stop: stop = be_level
                else:
                    if be_level < stop: stop = be_level
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
        out_t[n] = ts[i]; n += 1; last = j
    return n


B = len(ws.sig_i); R = np.empty(B); T = np.empty(B, np.int64)
n = bt_times(ws.sig_i, ws.qpos_i, ws.atr_f, ws.o, ws.hi, ws.lo, ws.cl, ws.sp, ws.ts,
             ws.sec("2024-01-01"), ws.sec("2026-09-17"), .05, .07, .30, 5.0, 1.5, 0.0, R, T)
r = R[:n].copy(); tt = T[:n].copy()

ref = ws.run(*ws.FULL)
assert len(ref) == n and np.max(np.abs(ref - r)) < 1e-12, "與已驗證版本不一致"
print(f"[{time.time()-t0:4.1f}s] 交易序列驗證通過：{n} 筆，平均 {r.mean():+.4f}R")

DAY = 86400; WIN = 182 * DAY
span_days = (tt[-1] - tt[0]) / DAY
print(f"  歷史區間 {span_days:.0f} 天，整體 {n/span_days*182:.1f} 筆/182天")

# 每 182 天視窗的實際成交筆數（逐日滑動）
counts = []
for s0 in range(int(tt[0]), int(tt[-1]) - WIN, DAY):
    counts.append(int(((tt >= s0) & (tt < s0 + WIN)).sum()))
counts = np.array(counts)
print(f"  182 天視窗成交筆數：中位 {np.median(counts):.0f}，"
      f"P5 {np.percentile(counts,5):.0f}，P95 {np.percentile(counts,95):.0f}，"
      f"最少 {counts.min()}，最多 {counts.max()}")

TARGET = 10000.0
def half_year(pool, cnt_pool, risk, n_paths=20000, block=8, start=60.0,
              target=0.0, post_risk=0.0, seed=20260918):
    rng = np.random.default_rng(seed); L = len(pool)
    fin = np.empty(n_paths); hit = np.zeros(n_paths, bool); dd = np.empty(n_paths)
    for m in range(n_paths):
        N = int(cnt_pool[rng.integers(0, len(cnt_pool))])
        seq = []
        while len(seq) < N:
            s0 = rng.integers(0, max(1, L - block + 1)); seq.extend(pool[s0:s0 + block].tolist())
        bal = peak = start; mdd = 0.0; f = risk
        for x in seq[:N]:
            mult = 1 + f * x
            bal = 0.0 if mult <= 0.0 else bal * mult
            if bal <= 0.0: break
            if target > 0 and bal >= target and f != post_risk:
                hit[m] = True; f = post_risk
                if f <= 0.0: break
            if bal > peak: peak = bal
            d = (peak - bal) / peak if peak > 0 else 1.0
            if d > mdd: mdd = d
        fin[m] = bal; dd[m] = mdd
    return fin, hit, dd

print("\n" + "="*80)
print("半年不出金、一路複利（60U 起始，20000 條路徑，達 10000U 後降到 2%）")
print("="*80)
print(f"  {'風險':>5}{'P5':>9}{'P25':>10}{'中位':>10}{'P75':>11}{'P95':>12}"
      f"{'>60U':>8}{'<20U':>8}{'達1萬U':>8}")
out = {}
for risk in [.03, .05, .08, .10, .15, .20]:
    fin, hit, dd = half_year(r, counts, risk, target=TARGET, post_risk=.02)
    out[f"{risk:.2f}"] = dict(
        p5=float(np.percentile(fin,5)), p25=float(np.percentile(fin,25)),
        median=float(np.median(fin)), p75=float(np.percentile(fin,75)),
        p95=float(np.percentile(fin,95)), mean=float(fin.mean()),
        above_start=float((fin>60).mean()), below20=float((fin<20).mean()),
        hit=float(hit.mean()), dd_med=float(np.median(dd)))
    v = out[f"{risk:.2f}"]
    print(f"  {risk*100:>4.0f}%{v['p5']:>9.1f}{v['p25']:>10.1f}{v['median']:>10.1f}"
          f"{v['p75']:>11.1f}{v['p95']:>12.1f}{v['above_start']*100:>7.1f}%"
          f"{v['below20']*100:>7.1f}%{v['hit']*100:>7.2f}%")

print("\n  平均值 vs 中位數（差距越大代表結果越被少數暴衝路徑拉高）：")
for risk in [.05, .10, .20]:
    v = out[f"{risk:.2f}"]
    print(f"    風險{risk*100:>3.0f}%：平均 {v['mean']:>10.1f}U　中位 {v['median']:>8.1f}U　"
          f"→ 平均是中位的 {v['mean']/max(v['median'],1e-9):>5.1f} 倍")

print("\n  回撤中位數：" + "　".join(
    f"{risk*100:.0f}%={out[f'{risk:.2f}']['dd_med']*100:.0f}%" for risk in [.03,.05,.08,.10,.15,.20]))

print("\n" + "="*80)
print("接著再跑半年（共一年）——用同樣設定把第二個半年接上去")
print("="*80)
print(f"  {'風險':>5}{'P5':>9}{'P25':>10}{'中位':>10}{'P75':>11}{'P95':>12}{'<20U':>8}{'達1萬U':>8}")
for risk in [.05, .10]:
    fin, hit, dd = half_year(r, counts * 2, risk, target=TARGET, post_risk=.02)
    print(f"  {risk*100:>4.0f}%{np.percentile(fin,5):>9.1f}{np.percentile(fin,25):>10.1f}"
          f"{np.median(fin):>10.1f}{np.percentile(fin,75):>11.1f}{np.percentile(fin,95):>12.1f}"
          f"{(fin<20).mean()*100:>7.1f}%{hit.mean()*100:>7.2f}%")

json.dump(out, open("sixmonth_results.json", "w"), indent=2)
print(f"\n[{time.time()-t0:4.1f}s] 完成")
