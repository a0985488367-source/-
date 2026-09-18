"""翻身模式：小資金高風險衝刺 + 里程碑鎖底，達標後停止高風險模式。

回答兩個問題：
  1. 保本墊高 0.10R 會不會砍掉大贏單？（直接量右尾）
  2. 各風險水位下，翻身的命中率 vs 歸零率長什麼樣？
"""
import json, time, contextlib, io, importlib.util
import numpy as np, pandas as pd
from numba import njit

t0 = time.time()
spec = importlib.util.spec_from_file_location("ws", "./winrate_sweep.py")
ws = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ws)
run, stx, FULL = ws.run, ws.st, ws.FULL

FROZEN = dict(tp_r=5.0, be_trig=1.5, be_off=0.00)
OFFSET = dict(tp_r=5.0, be_trig=1.5, be_off=0.10)
r0 = run(*FULL, **FROZEN)
r1 = run(*FULL, **OFFSET)

print("="*74)
print("問題 1：保本墊高 0.10R 會不會砍掉大贏單？")
print("="*74)
print(f"  {'':<14}{'筆數':>6}{'平均R':>9}{'累計R':>9}{'最大單筆':>10}"
      f"{'>3R筆數':>9}{'>4R筆數':>9}{'右尾累計R':>11}")
for lab, r in [("凍結版", r0), ("墊高0.10R", r1)]:
    tail = r[r > 3]
    print(f"  {lab:<14}{len(r):>6}{r.mean():>+9.4f}{r.sum():>+9.1f}{r.max():>+10.2f}"
          f"{int((r>3).sum()):>9}{int((r>4).sum()):>9}{tail.sum():>+11.1f}")
print(f"\n  → 大贏單（>3R）數量 {int((r0>3).sum())} vs {int((r1>3).sum())}，"
      f"右尾貢獻 {r0[r0>3].sum():+.1f}R vs {r1[r1>3].sum():+.1f}R")

# ---------------------------------------------------------------- 里程碑鎖底
MILESTONES = [(100.0, 60.0), (300.0, 150.0), (1000.0, 500.0), (3000.0, 1500.0)]
TARGET, FLOOR0, BUF = 10000.0, 20.0, 1.15

def ratchet_path(seq, start=60.0, risk=0.06):
    """1R = min(權益*risk, (權益-底線)/1.15)；達 10000U 停止高風險模式。"""
    bal = peak = start; floor = FLOOR0; mdd = 0.0
    hit = False; trades_to_target = -1
    for k, x in enumerate(seq):
        if bal >= TARGET:
            hit = True; trades_to_target = k; break
        one_r = min(bal * risk, max(0.0, (bal - floor) / BUF))
        if one_r <= 0.0: break
        bal += one_r * x
        if bal < 0.0: bal = 0.0
        for m, f in MILESTONES:
            if bal >= m and floor < f: floor = f
        if bal > peak: peak = bal
        d = (peak - bal) / peak if peak > 0 else 1.0
        if d > mdd: mdd = d
    if bal >= TARGET: hit = True
    return bal, mdd, hit, trades_to_target

def bootstrap(pool, risk, n_paths=2000, block=8, seed=20260918):
    rng = np.random.default_rng(seed); L = len(pool)
    fin = np.empty(n_paths); dd = np.empty(n_paths)
    hit = np.zeros(n_paths, bool); tt = []
    for m in range(n_paths):
        seq = []
        while len(seq) < L:
            s0 = rng.integers(0, max(1, L - block + 1)); seq.extend(pool[s0:s0 + block].tolist())
        b, d, h, k = ratchet_path(seq[:L], risk=risk)
        fin[m] = b; dd[m] = d; hit[m] = h
        if h and k > 0: tt.append(k)
    return fin, dd, hit, np.array(tt)

print("\n" + "="*74)
print("問題 2：翻身模式各風險水位（60U 起始，里程碑鎖底，2000 條路徑，322 筆/條）")
print("="*74)
print(f"  {'風險':>5}{'達1萬U':>9}{'達3000U':>10}{'達1000U':>10}{'期末中位':>11}"
      f"{'剩<20U':>9}{'回撤中位':>10}{'達標中位筆數':>13}")
out = {}
for risk in [.04, .05, .06, .08, .10, .15, .20]:
    fin, dd, hit, tt = bootstrap(r0, risk)
    p3000 = float((np.maximum(fin, np.where(hit, TARGET, 0)) >= 3000).mean())
    p1000 = float((np.maximum(fin, np.where(hit, TARGET, 0)) >= 1000).mean())
    out[f"{risk:.2f}"] = dict(hit10000=float(hit.mean()), p3000=p3000, p1000=p1000,
                              median=float(np.median(fin)), ruin=float((fin < 20).mean()),
                              dd_med=float(np.median(dd)),
                              trades_to_target=float(np.median(tt)) if len(tt) else None)
    tts = f"{np.median(tt):.0f}" if len(tt) else "—"
    print(f"  {risk*100:>4.0f}%{hit.mean()*100:>8.1f}%{p3000*100:>9.1f}%{p1000*100:>9.1f}%"
          f"{np.median(fin):>11.2f}{(fin<20).mean()*100:>8.1f}%{np.median(dd)*100:>9.1f}%{tts:>13}")

print("\n  同樣條件下改用『墊高 0.10R』的出場：")
print(f"  {'風險':>5}{'達1萬U':>9}{'期末中位':>11}{'剩<20U':>9}{'回撤中位':>10}")
out_off = {}
for risk in [.05, .06, .08, .10]:
    fin, dd, hit, tt = bootstrap(r1, risk)
    out_off[f"{risk:.2f}"] = dict(hit10000=float(hit.mean()), median=float(np.median(fin)),
                                  ruin=float((fin < 20).mean()), dd_med=float(np.median(dd)))
    print(f"  {risk*100:>4.0f}%{hit.mean()*100:>8.1f}%{np.median(fin):>11.2f}"
          f"{(fin<20).mean()*100:>8.1f}%{np.median(dd)*100:>9.1f}%")

print("\n" + "="*74)
print("固定比例（無鎖底）對照 —— 看鎖底到底有沒有用")
print("="*74)
def plain(pool, risk, n_paths=2000, block=8, seed=20260918):
    rng = np.random.default_rng(seed); L = len(pool)
    fin = np.empty(n_paths); hit = np.zeros(n_paths, bool)
    for m in range(n_paths):
        seq = []
        while len(seq) < L:
            s0 = rng.integers(0, max(1, L-block+1)); seq.extend(pool[s0:s0+block].tolist())
        bal = 60.0
        for x in seq[:L]:
            bal *= max(0.0, 1 + risk * x)
            if bal >= TARGET: hit[m] = True
        fin[m] = bal
    return fin, hit
print(f"  {'風險':>5}{'鎖底 達標':>11}{'鎖底 期末中位':>15}{'固定 達標':>11}{'固定 期末中位':>15}")
for risk in [.05, .06, .08, .10]:
    f2, h2 = plain(r0, risk)
    o = out[f"{risk:.2f}"]
    print(f"  {risk*100:>4.0f}%{o['hit10000']*100:>10.1f}%{o['median']:>15.2f}"
          f"{h2.mean()*100:>10.1f}%{np.median(f2):>15.2f}")

json.dump(dict(ratchet=out, ratchet_offset=out_off), open("turnaround_results.json", "w"), indent=2)
print(f"\n[{time.time()-t0:4.1f}s] 完成，結果寫入 turnaround_results.json")

# ---------------------------------------------------------------- 你描述的打法
print("\n" + "="*78)
print("你描述的打法：高風險固定比例衝到目標，一碰到就停手轉保守")
print("="*78)

def sprint(pool, risk, target, n_paths=4000, block=8, seed=20260918, start=60.0, dead=20.0):
    """達標立刻停止高風險模式；跌破 dead 視為打完了。"""
    rng = np.random.default_rng(seed); L = len(pool)
    fin = np.empty(n_paths); hit = np.zeros(n_paths, bool)
    ruin = np.zeros(n_paths, bool); blown = np.zeros(n_paths, bool); tt = []
    for m in range(n_paths):
        seq = []
        while len(seq) < L:
            s0 = rng.integers(0, max(1, L - block + 1)); seq.extend(pool[s0:s0 + block].tolist())
        bal = start
        for k, x in enumerate(seq[:L]):
            mult = 1 + risk * x
            if mult <= 0.0:
                bal = 0.0; blown[m] = True; break      # 單筆跳空直接打穿本金
            bal *= mult
            if bal >= target:
                hit[m] = True; tt.append(k + 1); break
            if bal < dead:
                ruin[m] = True; break
        fin[m] = bal
    return fin, hit, ruin, blown, np.array(tt)

worst = float(r0.min())
cap_f = -1.0 / worst
print(f"\n  歷史最糟單筆 {worst:.2f}R（跳空穿過停損）。單筆風險超過 "
      f"{cap_f*100:.1f}% 時，這一筆就會直接打穿本金。")

print(f"\n  {'風險':>5}{'目標':>8}{'達標率':>9}{'打穿本金':>10}{'掉到<20U':>10}"
      f"{'期末中位':>11}{'達標中位筆數':>13}")
sprint_out = {}
for target in [1000.0, 3000.0, 10000.0]:
    for risk in [.05, .10, .15, .20, .25, .30]:
        fin, hit, ruin, blown, tt = sprint(r0, risk, target)
        key = f"t{int(target)}_r{int(risk*100)}"
        sprint_out[key] = dict(hit=float(hit.mean()), blown=float(blown.mean()),
                               ruin=float(ruin.mean()), median=float(np.median(fin)),
                               trades=float(np.median(tt)) if len(tt) else None)
        tts = f"{np.median(tt):.0f}" if len(tt) else "—"
        print(f"  {risk*100:>4.0f}%{target:>8.0f}{hit.mean()*100:>8.1f}%{blown.mean()*100:>9.1f}%"
              f"{ruin.mean()*100:>9.1f}%{np.median(fin):>11.2f}{tts:>13}")
    print()

print("  同上但用『墊高 0.10R』的出場（目標 10000U）：")
print(f"  {'風險':>5}{'達標率':>9}{'打穿本金':>10}{'掉到<20U':>10}{'期末中位':>11}")
for risk in [.10, .15, .20]:
    fin, hit, ruin, blown, tt = sprint(r1, risk, 10000.0)
    print(f"  {risk*100:>4.0f}%{hit.mean()*100:>8.1f}%{blown.mean()*100:>9.1f}%"
          f"{ruin.mean()*100:>9.1f}%{np.median(fin):>11.2f}")

json.dump(dict(ratchet=out, ratchet_offset=out_off, sprint=sprint_out),
          open("turnaround_results.json", "w"), indent=2)
print(f"\n[{time.time()-t0:4.1f}s] 完成")
