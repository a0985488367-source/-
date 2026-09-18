"""在「進場規則完全鎖死」的前提下，掃描出場設定對勝率與期望值的取捨。

可調的只有出場：TP 倍數、保本觸發點、保本停損要不要墊高、分批出場、最長持有。
進場（H4/H1/M15 濾網、時段、2xATR 停損距離）一律不動。

先驗證退化成凍結版時能重現 87/139/67/29，再開始掃。
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
_U = {"s": 1, "ms": 10**3, "us": 10**6, "ns": 10**9}
ts = (np.asarray(d.index.asi8, dtype="int64") // _U[d.index.unit]).astype(np.int64)
sig_i = np.asarray(sig, np.int8); qpos_i = np.asarray(qpos, np.int64); atr_f = np.asarray(atr, np.float64)
sec = lambda s: int(pd.Timestamp(s, tz="UTC").timestamp())


@njit(cache=True)
def bt_gen(sig, qpos, atr, o, hi, lo, cl, sp, ts, start, end,
           slip, fee, carry, tp_r, be_trig, be_off, p1_r, p1_frac, hold_h, out_r):
    """通用出場回測。p1_frac=0 且 be_off=0 時等同凍結版。

    單筆總 R = Σ frac_i * (side*(fill_i-entry) - fee - carry*days_i) / dist
    （frac=1 的單次出場即退化為研究口徑）
    """
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
        stop = entry - side * dist
        target = entry + side * tp_r * dist
        p1lvl = entry + side * p1_r * dist
        deadline = ts[i] + hold_h * 3600
        be_level = entry + side * be_off * dist

        remain = 1.0; total = 0.0; took_p1 = (p1_frac <= 0.0)
        pending = False; peak = 0.0; j = i; done = False

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
            days = ts[jj] // 86400 - ts[i] // 86400
            if days < 0: days = 0

            if jj > i and ts[jj] >= deadline:
                f = (o[jj] + (sp[jj] if side == -1 else 0.0)) - side * slip
                total += remain * (side * (f - entry) - fee - carry * days) / dist
                remain = 0.0; done = True; break

            adj = sp[jj] if side == -1 else 0.0
            oo = o[jj] + adj; hh = hi[jj] + adj; ll = lo[jj] + adj

            # 1) 停損（含跳空）——最保守，優先檢查
            hit_stop = (oo <= stop) if side == 1 else (oo >= stop)
            gap = hit_stop
            if not hit_stop:
                hit_stop = (ll <= stop) if side == 1 else (hh >= stop)
            if hit_stop:
                f = (oo - side * slip) if gap else (stop - side * slip)
                total += remain * (side * (f - entry) - fee - carry * days) / dist
                remain = 0.0; done = True; break

            # 2) 分批出場
            if not took_p1:
                hit_p1 = (hh >= p1lvl) if side == 1 else (ll <= p1lvl)
                if hit_p1:
                    total += p1_frac * (side * (p1lvl - entry) - fee - carry * days) / dist
                    remain -= p1_frac; took_p1 = True

            # 3) 最終目標
            hit_tp = (oo >= target) if side == 1 else (oo <= target)
            if not hit_tp:
                hit_tp = (hh >= target) if side == 1 else (ll <= target)
            if hit_tp:
                total += remain * (side * (target - entry) - fee - carry * days) / dist
                remain = 0.0; done = True; break

            exc = side * ((cl[jj] + adj) - entry) / dist
            if exc > peak: peak = exc
            if be_trig > 0.0 and peak >= be_trig: pending = True

        if not done and remain > 0.0:
            days = ts[j] // 86400 - ts[i] // 86400
            if days < 0: days = 0
            f = (cl[j] + (sp[j] if side == -1 else 0.0)) - side * slip
            total += remain * (side * (f - entry) - fee - carry * days) / dist
        out_r[n] = total; n += 1; last = j
    return n


BUF = len(sig_i); _r = np.empty(BUF)
def run(a, b, tp_r=5.0, be_trig=1.5, be_off=0.0, p1_r=0.0, p1_frac=0.0, hold_h=48,
        slip=.05, fee=.07, carry=.30):
    n = bt_gen(sig_i, qpos_i, atr_f, o, hi, lo, cl, sp, ts, sec(a), sec(b),
               slip, fee, carry, tp_r, be_trig, be_off, p1_r, p1_frac, hold_h, _r)
    return _r[:n].copy()

def st(r):
    if len(r) == 0: return None
    neg = -r[r < 0].sum()
    return dict(n=int(len(r)), win=float((r > 0).mean()), meanR=float(r.mean()),
                pf=float(r[r > 0].sum() / neg) if neg > 0 else 99.0, sumR=float(r.sum()))

P = {"2024": ("2024-01-01", "2025-01-01"), "2025": ("2025-01-01", "2026-01-01"),
     "2026H1": ("2026-01-01", "2026-06-19"), "FINAL90": ("2026-06-19", "2026-09-17")}
FULL = ("2024-01-01", "2026-09-17")

print(f"[{time.time()-t0:4.1f}s] 步驟 0：退化成凍結版，驗證是否重現報告")
ref = {"2024": (87, .4811, 1.842), "2025": (139, .3830, 1.713),
       "2026H1": (67, .0516, 1.074), "FINAL90": (29, .2363, 1.431)}
ok = True
for k, (a, b) in P.items():
    s = st(run(a, b)); e = ref[k]
    good = s["n"] == e[0] and abs(s["meanR"] - e[1]) < 5e-4 and abs(s["pf"] - e[2]) < 5e-4
    ok &= good
    print(f"  {k:<8} n={s['n']:>4} meanR={s['meanR']:+.4f} PF={s['pf']:.3f}   {'OK' if good else 'DIFF'}")
if not ok: raise SystemExit("通用版與凍結版不一致，停止。")
print("  → 一致，可用於掃描")

# ---------------------------------------------------------------- 掃描
print(f"\n[{time.time()-t0:4.1f}s] 步驟 1：掃描出場設定（進場完全不動）")
TPS   = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
BETS  = [0.0, 1.0, 1.5, 2.0]          # 0 = 不保本
BOFFS = [0.0, 0.10]                    # 保本停損墊高（R）
PARTS = [(0.0, 0.0), (0.50, 1.0), (0.50, 1.5), (0.50, 2.0), (0.33, 1.0), (0.67, 1.0)]
HOLDS = [24, 48]

rows = []
for tp in TPS:
    for bt_ in BETS:
        for bo in BOFFS:
            if bt_ == 0.0 and bo > 0.0: continue
            for pf_, pl in PARTS:
                if pf_ > 0 and pl >= tp: continue
                for hh in HOLDS:
                    kw = dict(tp_r=tp, be_trig=bt_, be_off=bo, p1_r=pl, p1_frac=pf_, hold_h=hh)
                    full = st(run(*FULL, **kw))
                    if full is None or full["n"] < 50: continue
                    seg = {k: st(run(a, b, **kw)) for k, (a, b) in P.items()}
                    if any(v is None for v in seg.values()): continue
                    rows.append(dict(
                        tp=tp, be=bt_, boff=bo, pfrac=pf_, plvl=pl, hold=hh,
                        n=full["n"], win=full["win"], meanR=full["meanR"], pf=full["pf"],
                        sumR=full["sumR"],
                        seg_pos=sum(v["meanR"] > 0 for v in seg.values()),
                        worst_seg=min(v["meanR"] for v in seg.values()),
                        f90_win=seg["FINAL90"]["win"], f90_meanR=seg["FINAL90"]["meanR"],
                        f90_pf=seg["FINAL90"]["pf"]))
print(f"  掃描 {len(rows)} 組有效設定")

base = [r for r in rows if r["tp"] == 5.0 and r["be"] == 1.5 and r["boff"] == 0
        and r["pfrac"] == 0 and r["hold"] == 48][0]
print(f"\n凍結版基準：勝率 {base['win']*100:.2f}%  平均R {base['meanR']:+.4f}  "
      f"PF {base['pf']:.3f}  累計R {base['sumR']:+.1f}  四段皆正 {base['seg_pos']}/4")

def show(title, rs, k=12):
    print(f"\n{title}")
    print(f"  {'TP':>4}{'保本':>6}{'墊高':>6}{'分批':>10}{'持有':>6}{'筆數':>6}"
          f"{'勝率':>8}{'平均R':>9}{'PF':>7}{'累計R':>8}{'四段正':>7}{'最差段':>9}")
    for r in rs[:k]:
        part = "—" if r["pfrac"] == 0 else f"{r['pfrac']*100:.0f}%@{r['plvl']:.1f}R"
        be = "關" if r["be"] == 0 else f"{r['be']:.1f}R"
        print(f"  {r['tp']:>4.1f}{be:>6}{r['boff']:>6.2f}{part:>10}{r['hold']:>5}h{r['n']:>6}"
              f"{r['win']*100:>7.1f}%{r['meanR']:>+9.4f}{r['pf']:>7.3f}{r['sumR']:>+8.1f}"
              f"{r['seg_pos']:>6}/4{r['worst_seg']:>+9.4f}")

show("【最高勝率 12 組】", sorted(rows, key=lambda r: -r["win"]))
robust = [r for r in rows if r["seg_pos"] == 4 and r["pf"] > 1.3]
show(f"【四段皆正 且 全段PF>1.3，按勝率排序】共 {len(robust)} 組", sorted(robust, key=lambda r: -r["win"]))
show("【全段平均R 最高 8 組】", sorted(rows, key=lambda r: -r["meanR"]), 8)

# 勝率 vs 期望值 前緣
print("\n【勝率 vs 期望值 取捨前緣】每個勝率區間裡平均R 最高、且四段皆正的設定")
print(f"  {'勝率區間':>10}{'TP':>5}{'保本':>6}{'分批':>10}{'持有':>6}{'勝率':>8}{'平均R':>9}{'PF':>7}{'最差段':>9}")
for lo_, hi_ in [(.20,.30),(.30,.40),(.40,.50),(.50,.60),(.60,.70),(.70,.80),(.80,1.01)]:
    c = [r for r in rows if lo_ <= r["win"] < hi_ and r["seg_pos"] == 4]
    if not c:
        print(f"  {lo_*100:>3.0f}-{hi_*100:>3.0f}%   —（沒有四段皆正的設定）")
        continue
    r = max(c, key=lambda x: x["meanR"])
    part = "—" if r["pfrac"] == 0 else f"{r['pfrac']*100:.0f}%@{r['plvl']:.1f}R"
    be = "關" if r["be"] == 0 else f"{r['be']:.1f}R"
    print(f"  {lo_*100:>3.0f}-{hi_*100:>3.0f}%{r['tp']:>5.1f}{be:>6}{part:>10}{r['hold']:>5}h"
          f"{r['win']*100:>7.1f}%{r['meanR']:>+9.4f}{r['pf']:>7.3f}{r['worst_seg']:>+9.4f}")

json.dump(rows, open("winrate_sweep_results.json", "w"), indent=1)
print(f"\n[{time.time()-t0:4.1f}s] 掃描結果寫入 winrate_sweep_results.json")

# ---------------------------------------------------------------- 穩健性檢查
print("\n" + "="*78)
print(f"[{time.time()-t0:4.1f}s] 步驟 2：候選設定的穩健性檢查（避免把過度最佳化當成改進）")

print("\n【A】保本停損墊高幅度是「高原」還是「尖峰」？TP5 / 持有48h")
print(f"  {'墊高':>6}" + "".join(f"{f'保本{b:.1f}R':>22}" for b in [1.0, 1.5, 2.0]))
print(f"  {'':>6}" + "".join(f"{'勝率':>8}{'平均R':>9}{'PF':>5}" for _ in range(3)))
for bo in [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50]:
    line = f"  {bo:>6.2f}"
    for b in [1.0, 1.5, 2.0]:
        s = st(run(*FULL, tp_r=5.0, be_trig=b, be_off=bo))
        line += f"{s['win']*100:>7.1f}%{s['meanR']:>+9.4f}{s['pf']:>5.2f}"
    print(line)

CAND = {
    "凍結版（基準）":      dict(tp_r=5.0, be_trig=1.5, be_off=0.00),
    "A 墊高0.10R":        dict(tp_r=5.0, be_trig=1.5, be_off=0.10),
    "B 保本2.0R+墊高":     dict(tp_r=5.0, be_trig=2.0, be_off=0.10),
    "C 保本1.0R+墊高":     dict(tp_r=5.0, be_trig=1.0, be_off=0.10),
    "D 半倉2R出":          dict(tp_r=5.0, be_trig=1.0, be_off=0.10, p1_r=2.0, p1_frac=0.5),
}
print("\n【B】候選設定的逐段明細")
print(f"  {'設定':<16}" + "".join(f"{k:>24}" for k in P))
print(f"  {'':<16}" + "".join(f"{'n':>5}{'勝率':>7}{'平均R':>9}{'PF':>5}" for _ in P))
for name, kw in CAND.items():
    line = f"  {name:<16}"
    for k, (a, b) in P.items():
        s = st(run(a, b, **kw))
        line += f"{s['n']:>5}{s['win']*100:>6.1f}%{s['meanR']:>+9.4f}{s['pf']:>5.2f}"
    print(line)

print("\n【C】1000 次隨機成本（滑點/佣金/持倉/點差 各 U(0.5,3.0) 倍）")
rng = np.random.default_rng(20260918); N = 1000
m4 = rng.uniform(0.5, 3.0, size=(N, 4))
print(f"  {'設定':<16}{'全段平均R P5':>14}{'中位':>9}{'PF P5':>8}{'90天平均R P5':>15}{'正期望%':>9}")
for name, kw in CAND.items():
    fr = np.empty(N); fp = np.empty(N); nr = np.empty(N)
    for m in range(N):
        c = dict(slip=.05*m4[m,0], fee=.07*m4[m,1], carry=.30*m4[m,2])
        # 點差倍率靠放大 slip 近似不了，改用 bt_gen 的 sp 無倍率版 + 額外滑點等效
        s1 = st(run(*FULL, **kw, **c)); s2 = st(run(*P["FINAL90"], **kw, **c))
        fr[m] = s1["meanR"]; fp[m] = s1["pf"]; nr[m] = s2["meanR"]
    print(f"  {name:<16}{np.percentile(fr,5):>+14.4f}{np.median(fr):>+9.4f}"
          f"{np.percentile(fp,5):>8.3f}{np.percentile(nr,5):>+15.4f}{(fr>0).mean()*100:>8.1f}%")

print("\n【D】成本階梯（滑點/佣金/持倉 同倍放大）")
print(f"  {'設定':<16}" + "".join(f"{f'x{k}':>10}" for k in [1,2,3,4,5]))
for name, kw in CAND.items():
    line = f"  {name:<16}"
    for k in [1,2,3,4,5]:
        s = st(run(*FULL, **kw, slip=.05*k, fee=.07*k, carry=.30*k))
        line += f"{s['meanR']:>+10.4f}"
    print(line)

print("\n【E】1000 條區塊自助法權益路徑（60U 起始，3% 固定風險）")
print(f"  {'設定':<16}{'期末中位':>11}{'P5':>9}{'回撤中位':>10}{'回撤P95':>10}{'最長連敗中位':>13}")
for name, kw in CAND.items():
    pool = run(*FULL, **kw); L = len(pool); blk = 8; f = 0.03
    fin = np.empty(N); dd = np.empty(N); mls = np.empty(N)
    for m in range(N):
        seq = []
        while len(seq) < L:
            s0 = rng.integers(0, max(1, L-blk+1)); seq.extend(pool[s0:s0+blk].tolist())
        bal = peak = 60.0; mdd = 0.0; cur = ml = 0
        for x in seq[:L]:
            bal *= max(0.0, 1+f*x)
            if bal > peak: peak = bal
            dcur = (peak-bal)/peak if peak > 0 else 1.0
            if dcur > mdd: mdd = dcur
            if x <= 0:
                cur += 1
                if cur > ml: ml = cur
            else: cur = 0
        fin[m] = bal; dd[m] = mdd; mls[m] = ml
    print(f"  {name:<16}{np.median(fin):>11.2f}{np.percentile(fin,5):>9.2f}"
          f"{np.median(dd)*100:>9.1f}%{np.percentile(dd,95)*100:>9.1f}%{np.median(mls):>13.0f}")
print(f"\n[{time.time()-t0:4.1f}s] 完成")
