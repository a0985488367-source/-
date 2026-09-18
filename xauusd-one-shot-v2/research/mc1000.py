"""凍結規則（BE+1.5R 保本 / TP 5R / 真 48 曆時小時）的 1000 次回測套組。

先用 numba 重寫 calendar_hold_fix.run() 的邏輯並驗證逐筆相同，
再跑三組各 1000 次：
  A. 成本隨機化      —— 1000 次完整歷史回測，滑點/佣金/持倉成本各自隨機
  B. 區塊自助法      —— 1000 條 60U 權益路徑，多個風險水位
  C. 隨機子區間      —— 1000 個隨機 90 天視窗

用法：python3 mc1000.py
"""
import json, time, contextlib, io, importlib.util
import numpy as np, pandas as pd
from numba import njit

t0 = time.time()
spec = importlib.util.spec_from_file_location("ev", "./exit_variants.py")
ev = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ev)

d, qpos, atr, sig = ev.d, ev.qpos, ev.atr, ev.sig
o, hi, lo, cl, sp = ev.o, ev.hi, ev.lo, ev.cl, ev.sp

_UNIT = {"s": 1, "ms": 10**3, "us": 10**6, "ns": 10**9}
ts = (np.asarray(d.index.asi8, dtype="int64") // _UNIT[d.index.unit]).astype(np.int64)  # epoch 秒
sig_i = np.asarray(sig, dtype=np.int8)
qpos_i = np.asarray(qpos, dtype=np.int64)
atr_f = np.asarray(atr, dtype=np.float64)
sec = lambda s: int(pd.Timestamp(s, tz="UTC").timestamp())
print(f"[{time.time()-t0:5.1f}s] 資料載入完成：M5={len(d)} 根，原始訊號={int((sig_i!=0).sum())} 根", flush=True)


@njit(cache=True)
def bt_frozen(sig, qpos, atr, o, hi, lo, cl, sp, ts, start, end, slip, fee, carry, spm, out_r, out_i, out_j):
    """BE+1.5R 保本 / TP 5R / 真 48 曆時小時。與 calendar_hold_fix.run() 同口徑。"""
    n = 0
    last = -1
    nbar = len(o)
    for z in range(len(sig)):
        side = sig[z]
        if side == 0:
            continue
        i = qpos[z]
        if i < 0 or i <= last or i >= nbar:
            continue
        if ts[i] < start or ts[i] >= end or not np.isfinite(atr[z]):
            continue
        dist = 2.0 * atr[z]
        if dist <= 0.0:
            continue
        entry = (o[i] + sp[i] * spm if side == 1 else o[i]) + side * slip
        stop = entry - side * dist
        target = entry + side * 5.0 * dist
        deadline = ts[i] + 48 * 3600
        pending = 0.0
        has_pending = False
        peak = 0.0
        fill = np.nan
        j = i
        for jj in range(i, nbar):
            if ts[jj] >= end:
                j = i if jj - 1 < i else jj - 1
                break
            j = jj
            if has_pending:
                if side == 1:
                    if pending > stop: stop = pending
                else:
                    if pending < stop: stop = pending
                has_pending = False
            if jj > i and ts[jj] >= deadline:
                fill = (o[jj] + (sp[jj] * spm if side == -1 else 0.0)) - side * slip
                break
            adj = sp[jj] * spm if side == -1 else 0.0
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
            if peak >= 1.5:
                pending = entry; has_pending = True
        if not np.isfinite(fill):
            fill = (cl[j] + (sp[j] * spm if side == -1 else 0.0)) - side * slip
        days = ts[j] // 86400 - ts[i] // 86400
        if days < 0: days = 0
        out_r[n] = (side * (fill - entry) - fee - carry * days) / dist
        out_i[n] = i; out_j[n] = j
        n += 1
        last = j
    return n


BUF = len(sig_i)
_r = np.empty(BUF); _i = np.empty(BUF, np.int64); _j = np.empty(BUF, np.int64)

def run(start, end, slip=.05, fee=.07, carry=.30, spm=1.0):
    n = bt_frozen(sig_i, qpos_i, atr_f, o, hi, lo, cl, sp, ts,
                  sec(start), sec(end), slip, fee, carry, spm, _r, _i, _j)
    return _r[:n].copy()

def stats(r):
    if len(r) == 0:
        return dict(n=0, meanR=None, pf=None, win=None, sumR=0.0, maxL=0)
    neg = -r[r < 0].sum()
    ml = cur = 0
    for x in r:
        if x <= 0:
            cur += 1
            if cur > ml: ml = cur
        else:
            cur = 0
    return dict(n=int(len(r)), meanR=float(r.mean()),
                pf=float(r[r > 0].sum() / neg) if neg > 0 else 99.0,
                win=float((r > 0).mean()), sumR=float(r.sum()), maxL=int(ml))

# ---------------------------------------------------------------- 驗證
periods = {"2024": ("2024-01-01", "2025-01-01"), "2025": ("2025-01-01", "2026-01-01"),
           "2026H1": ("2026-01-01", "2026-06-19"), "FINAL90": ("2026-06-19", "2026-09-17")}
ref = {"2024": (87, .4811, 1.842), "2025": (139, .3830, 1.713),
       "2026H1": (67, .0516, 1.074), "FINAL90": (29, .2363, 1.431)}
print(f"\n[{time.time()-t0:5.1f}s] 步驟 0：驗證 numba 版與 calendar_hold_fix.py 同口徑")
ok_all = True
for k, (a, b) in periods.items():
    s = stats(run(a, b)); e = ref[k]
    ok = s["n"] == e[0] and abs(s["meanR"] - e[1]) < 5e-4 and abs(s["pf"] - e[2]) < 5e-4
    ok_all &= ok
    print(f"  {k:<8} n={s['n']:>4}  meanR={s['meanR']:+.4f}  PF={s['pf']:.3f}"
          f"   報告 n={e[0]} {e[1]:+.4f} {e[2]}   {'OK' if ok else 'DIFF'}")
if not ok_all:
    raise SystemExit("numba 版與報告不符，停止。")
print("  → 口徑一致，可用於 1000 次回測")

FULL = ("2024-01-01", "2026-09-17")
base = run(*FULL)
bs = stats(base)
print(f"\n全段基準（2024-01-01 ~ 2026-09-16）：n={bs['n']}  勝率={bs['win']*100:.2f}%  "
      f"平均R={bs['meanR']:+.4f}  PF={bs['pf']:.3f}  累計R={bs['sumR']:+.2f}  最長連敗={bs['maxL']}")

out = {"baseline_full": bs, "baseline_periods": {k: stats(run(*v)) for k, v in periods.items()}}
rng = np.random.default_rng(20260918)
N = 1000

# ---------------------------------------------------------------- A 成本隨機化
print(f"\n[{time.time()-t0:5.1f}s] A. 成本隨機化 1000 次（滑點/佣金/持倉成本各自 U(0.5,3.0) 倍）")
res = {"full": [], "final90": []}
mult = rng.uniform(0.5, 3.0, size=(N, 3))
for m in range(N):
    a, b, c = .05 * mult[m, 0], .07 * mult[m, 1], .30 * mult[m, 2]
    res["full"].append(stats(run(*FULL, a, b, c)))
    res["final90"].append(stats(run(*periods["FINAL90"], a, b, c)))
def dist(rows, key):
    v = np.array([x[key] for x in rows if x[key] is not None])
    return dict(mean=float(v.mean()), p5=float(np.percentile(v, 5)), p50=float(np.median(v)),
                p95=float(np.percentile(v, 95)), min=float(v.min()), max=float(v.max()),
                frac_pos=float((v > 0).mean()) if key == "meanR" else float((v > 1).mean()))
out["A_cost_randomised"] = {seg: {k: dist(res[seg], k) for k in ("meanR", "pf", "sumR")}
                            for seg in res}
for seg in ("full", "final90"):
    mr, pf = out["A_cost_randomised"][seg]["meanR"], out["A_cost_randomised"][seg]["pf"]
    lab = "全段" if seg == "full" else "最後90天"
    print(f"  {lab:<6} 平均R 中位={mr['p50']:+.4f}  P5={mr['p5']:+.4f}  P95={mr['p95']:+.4f}"
          f"   正期望比例={mr['frac_pos']*100:.1f}%")
    print(f"  {'':<6} PF    中位={pf['p50']:.3f}   P5={pf['p5']:.3f}   P95={pf['p95']:.3f}"
          f"   PF>1 比例={pf['frac_pos']*100:.1f}%")

# ------------------------------------------------- A2 成本隨機化（含點差）
print(f"\n[{time.time()-t0:5.1f}s] A2. 同上但「點差也一起放大」1000 次")
print("     研究原本的 cost_mult 不放大點差，而點差是最大的成本項，因此這組才是真正的成本壓力")
res2 = {"full": [], "final90": []}
mult2 = rng.uniform(0.5, 3.0, size=(N, 4))
for m in range(N):
    a, b, c, e = .05 * mult2[m, 0], .07 * mult2[m, 1], .30 * mult2[m, 2], mult2[m, 3]
    res2["full"].append(stats(run(*FULL, a, b, c, e)))
    res2["final90"].append(stats(run(*periods["FINAL90"], a, b, c, e)))
out["A2_cost_with_spread"] = {seg: {k: dist(res2[seg], k) for k in ("meanR", "pf", "sumR")}
                              for seg in res2}
for seg in ("full", "final90"):
    mr, pf = out["A2_cost_with_spread"][seg]["meanR"], out["A2_cost_with_spread"][seg]["pf"]
    lab = "全段" if seg == "full" else "最後90天"
    print(f"  {lab:<6} 平均R 中位={mr['p50']:+.4f}  P5={mr['p5']:+.4f}  P95={mr['p95']:+.4f}"
          f"   正期望比例={mr['frac_pos']*100:.1f}%")
    print(f"  {'':<6} PF    中位={pf['p50']:.3f}   P5={pf['p5']:.3f}   P95={pf['p95']:.3f}"
          f"   PF>1 比例={pf['frac_pos']*100:.1f}%")

print(f"\n[{time.time()-t0:5.1f}s] A3. 成本階梯（確定性，全部成本含點差同倍放大）")
ladder = {}
print(f"  {'倍率':>5}{'全段筆數':>9}{'全段平均R':>11}{'全段PF':>9}{'90天平均R':>11}{'90天PF':>9}")
for k in [1.0, 1.5, 2.0, 3.0, 4.0, 5.0]:
    f1 = stats(run(*FULL, .05*k, .07*k, .30*k, k))
    f2 = stats(run(*periods["FINAL90"], .05*k, .07*k, .30*k, k))
    ladder[f"x{k}"] = {"full": f1, "final90": f2}
    print(f"  {k:>4.1f}x{f1['n']:>9}{f1['meanR']:>+11.4f}{f1['pf']:>9.3f}{f2['meanR']:>+11.4f}{f2['pf']:>9.3f}")
out["A3_cost_ladder_with_spread"] = ladder

# ---------------------------------------------------------------- B 區塊自助法權益路徑
print(f"\n[{time.time()-t0:5.1f}s] B. 區塊自助法 1000 條權益路徑（60U 起始，8 筆區塊）")
pool = base; block = 8; L = len(pool)
risks = [.02, .03, .05, .06, .10]
B = {}
for f in risks:
    fin = np.empty(N); dd = np.empty(N); hit = np.zeros(N, bool); ruin = np.zeros(N, bool)
    for m in range(N):
        seq = []
        while len(seq) < L:
            st = rng.integers(0, max(1, L - block + 1))
            seq.extend(pool[st:st + block].tolist())
        bal = peak = 60.0; mdd = 0.0
        for x in seq[:L]:
            bal *= max(0.0, 1 + f * x)
            if bal > peak: peak = bal
            dcur = (peak - bal) / peak if peak > 0 else 1.0
            if dcur > mdd: mdd = dcur
            if bal >= 10000: hit[m] = True
            if bal <= 6.0: ruin[m] = True
        fin[m] = bal; dd[m] = mdd
    B[f"{f:.2f}"] = dict(median=float(np.median(fin)), p5=float(np.percentile(fin, 5)),
                         p25=float(np.percentile(fin, 25)), p75=float(np.percentile(fin, 75)),
                         p95=float(np.percentile(fin, 95)), dd_med=float(np.median(dd)),
                         dd_p95=float(np.percentile(dd, 95)),
                         hit10000=float(hit.mean()), ruin_le6U=float(ruin.mean()),
                         frac_gt_start=float((fin > 60).mean()))
out["B_bootstrap_equity"] = B
print(f"  {'風險':>5}{'期末中位':>11}{'P5':>9}{'P95':>12}{'回撤中位':>10}{'>60U':>8}{'≤6U':>8}{'達1萬U':>9}")
for f in risks:
    v = B[f"{f:.2f}"]
    print(f"  {f*100:>4.0f}%{v['median']:>11.2f}{v['p5']:>9.2f}{v['p95']:>12.2f}"
          f"{v['dd_med']*100:>9.1f}%{v['frac_gt_start']*100:>7.1f}%{v['ruin_le6U']*100:>7.1f}%"
          f"{v['hit10000']*100:>8.2f}%")

# ---------------------------------------------------------------- C 隨機子區間
print(f"\n[{time.time()-t0:5.1f}s] C. 隨機 90 天視窗 1000 次")
lo_s, hi_s = sec("2024-01-01"), sec("2026-09-17") - 90 * 86400
starts = rng.integers(lo_s, hi_s, size=N)
rows = []
for m in range(N):
    a = pd.Timestamp(int(starts[m]), unit="s", tz="UTC")
    rows.append(stats(run(a.isoformat(), (a + pd.Timedelta(days=90)).isoformat())))
valid = [x for x in rows if x["n"] >= 5]
mr = np.array([x["meanR"] for x in valid]); pf = np.array([x["pf"] for x in valid])
sr = np.array([x["sumR"] for x in valid]); nn = np.array([x["n"] for x in valid])
out["C_random_90d_windows"] = dict(
    windows=N, usable=len(valid), trades_median=float(np.median(nn)),
    meanR=dict(p5=float(np.percentile(mr, 5)), p50=float(np.median(mr)),
               p95=float(np.percentile(mr, 95)), frac_pos=float((mr > 0).mean())),
    pf=dict(p5=float(np.percentile(pf, 5)), p50=float(np.median(pf)),
            p95=float(np.percentile(pf, 95)), frac_gt1=float((pf > 1).mean())),
    sumR=dict(p5=float(np.percentile(sr, 5)), p50=float(np.median(sr)),
              p95=float(np.percentile(sr, 95))))
c = out["C_random_90d_windows"]
print(f"  可用視窗 {c['usable']}/{N}（至少 5 筆交易），每窗交易數中位數 {c['trades_median']:.0f}")
print(f"  平均R  P5={c['meanR']['p5']:+.4f}  中位={c['meanR']['p50']:+.4f}  P95={c['meanR']['p95']:+.4f}"
      f"   正期望視窗佔 {c['meanR']['frac_pos']*100:.1f}%")
print(f"  PF     P5={c['pf']['p5']:.3f}   中位={c['pf']['p50']:.3f}   P95={c['pf']['p95']:.3f}"
      f"   PF>1 視窗佔 {c['pf']['frac_gt1']*100:.1f}%")
print(f"  累計R  P5={c['sumR']['p5']:+.2f}   中位={c['sumR']['p50']:+.2f}   P95={c['sumR']['p95']:+.2f}")

# ---------------------------------------------------------------- D 交易結果組成與連敗分布
print(f"\n[{time.time()-t0:5.1f}s] D. 基準 322 筆的結果組成")
buckets = [("滿額虧損 R<=-0.9", (base <= -0.9).sum()),
           ("部分虧損 -0.9<R<=-0.3", ((base > -0.9) & (base <= -0.3)).sum()),
           ("接近保本 -0.3<R<=+0.3", ((base > -0.3) & (base <= 0.3)).sum()),
           ("小賺 +0.3<R<=+2", ((base > 0.3) & (base <= 2)).sum()),
           ("大賺 R>+2", (base > 2).sum())]
for lab, c in buckets:
    print(f"  {lab:<24}{c:>4} 筆 ({c/len(base)*100:>5.1f}%)")
print(f"  最大單筆 {base.max():+.2f}R   最小單筆 {base.min():+.2f}R")
top5 = np.sort(base)[-5:][::-1]
print(f"  前 5 大獲利：{', '.join(f'{x:+.2f}R' for x in top5)}"
      f"   佔總累計R 的 {top5.sum()/base.sum()*100:.1f}%")
out["D_outcome_mix"] = {lab: int(c) for lab, c in buckets}
out["D_outcome_mix"]["max_R"] = float(base.max()); out["D_outcome_mix"]["min_R"] = float(base.min())
out["D_outcome_mix"]["top5_share_of_sumR"] = float(top5.sum() / base.sum())

print(f"\n[{time.time()-t0:5.1f}s] E. 1000 條自助法路徑的連敗與 R 回撤分布")
def streak_and_dd(seq):
    ml = cur = 0; eq = 0.0; peak = 0.0; dd = 0.0
    for x in seq:
        if x <= 0:
            cur += 1
            if cur > ml: ml = cur
        else:
            cur = 0
        eq += x
        if eq > peak: peak = eq
        if peak - eq > dd: dd = peak - eq
    return ml, dd
mls = np.empty(N); dds = np.empty(N)
for m in range(N):
    seq = []
    while len(seq) < L:
        st = rng.integers(0, max(1, L - block + 1))
        seq.extend(pool[st:st + block].tolist())
    mls[m], dds[m] = streak_and_dd(seq[:L])
bml, bdd = streak_and_dd(base)
print(f"  歷史實際：最長連敗 {bml} 筆，最大 R 回撤 {bdd:.2f}R")
print(f"  1000 條路徑 最長連敗  中位={np.median(mls):.0f}  P95={np.percentile(mls,95):.0f}  最差={mls.max():.0f}")
print(f"  1000 條路徑 最大R回撤 中位={np.median(dds):.2f}R  P95={np.percentile(dds,95):.2f}R  最差={dds.max():.2f}R")
out["E_streak_drawdown"] = dict(
    historical_max_losing_streak=int(bml), historical_max_R_drawdown=float(bdd),
    streak=dict(p50=float(np.median(mls)), p95=float(np.percentile(mls, 95)), max=float(mls.max())),
    R_drawdown=dict(p50=float(np.median(dds)), p95=float(np.percentile(dds, 95)), max=float(dds.max())))

json.dump(out, open("mc1000_results.json", "w"), indent=2)
print(f"\n[{time.time()-t0:5.1f}s] 完成，結果寫入 mc1000_results.json")
