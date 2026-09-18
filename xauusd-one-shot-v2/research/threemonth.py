"""3 個月 60U -> 10000U（167 倍）到底可不可能？

不用感覺回答，用三件事量化：
  1. 對數成長上限（Kelly）——任何倉位管理都無法超越的天花板
  2. 各風險水位在 91 天內碰到 10000U 的實際機率
  3. 反推：要達標需要什麼樣的邊際（交易筆數 / 每筆期望值）
"""
import json, time, contextlib, io, importlib.util
import numpy as np
from numba import njit

t0 = time.time()
spec = importlib.util.spec_from_file_location("sm", "./sixmonth.py")
# sixmonth 會跑模擬，改成直接重用 winrate_sweep + 自己算交易序列
spec = importlib.util.spec_from_file_location("ws", "./winrate_sweep.py")
ws = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ws)

r = ws.run(*ws.FULL)                      # 已驗證的凍結版交易序列
print(f"[{time.time()-t0:4.1f}s] 交易序列：{len(r)} 筆，平均 {r.mean():+.4f}R，"
      f"勝率 {(r>0).mean()*100:.2f}%，最糟單筆 {r.min():.2f}R")

START, TARGET = 60.0, 10000.0
NEED = TARGET / START
DAYS = 91
RATE = len(r) / 932.0                       # 每日成交筆數（歷史區間 932 天）
N90 = RATE * DAYS
print(f"  3 個月約 {N90:.0f} 筆交易（歷史 {RATE*182:.0f} 筆/182天）")
print(f"  目標 {NEED:.0f} 倍 → 每筆必須平均成長 {NEED**(1/N90)-1:+.2%}（連續 {N90:.0f} 筆）")

# ---------------------------------------------------------- 1. 對數成長上限
print("\n" + "="*78)
print("1. 對數成長上限（Kelly）——任何倉位管理都跨不過的天花板")
print("="*78)
fs = np.arange(0.005, 0.385, 0.005)
g = np.array([np.mean(np.log(np.maximum(1e-12, 1 + f * r))) for f in fs])
i_star = int(np.argmax(g)); f_star, g_star = fs[i_star], g[i_star]
print(f"  最佳單筆風險 f* = {f_star*100:.1f}%，每筆對數成長 g* = {g_star:.5f}"
      f"（= 每筆中位成長 {np.exp(g_star)-1:+.2%}）")
print(f"  用 f* 跑 {N90:.0f} 筆，中位倍數 = exp({g_star:.5f} x {N90:.0f}) = "
      f"{np.exp(g_star*N90):.2f} 倍 → {START*np.exp(g_star*N90):.0f}U")
n_need = np.log(NEED) / g_star
print(f"  要達到 {NEED:.0f} 倍，在 f* 下需要 {n_need:.0f} 筆交易 "
      f"= {n_need/RATE/365:.1f} 年")
print(f"\n  {'風險':>6}{'每筆對數成長':>14}{'91天中位倍數':>14}{'91天中位權益':>14}")
for f in [.05, .10, .15, f_star, .20, .25, .30, .35]:
    gg = float(np.mean(np.log(np.maximum(1e-12, 1 + f * r))))
    tag = "  <- f*" if abs(f - f_star) < 1e-9 else ""
    print(f"  {f*100:>5.1f}%{gg:>14.5f}{np.exp(gg*N90):>14.2f}{START*np.exp(gg*N90):>14.0f}{tag}")

# ---------------------------------------------------------- 2. 實際機率
print("\n" + "="*78)
print("2. 91 天內碰到 10000U 的實際機率（50000 條路徑，含跳空打穿本金）")
print("="*78)

@njit(cache=True)
def sim(pool, counts, risk, target, start, n_paths, block, seed):
    np.random.seed(seed)
    L = len(pool); C = len(counts)
    hit = 0; blown = 0; ruin = 0
    fins = np.empty(n_paths)
    for m in range(n_paths):
        N = counts[np.random.randint(0, C)]
        bal = start; h = False
        k = 0
        while k < N:
            s0 = np.random.randint(0, L - block + 1)
            for b in range(block):
                if k >= N: break
                x = pool[s0 + b]
                mult = 1.0 + risk * x
                if mult <= 0.0:
                    bal = 0.0; blown += 1; k = N; break
                bal *= mult
                if bal >= target: h = True; k = N; break
                k += 1
        if h: hit += 1
        if bal < 20.0: ruin += 1
        fins[m] = bal
    return hit / n_paths, blown / n_paths, ruin / n_paths, fins

# 91 天視窗的實際成交筆數分布
counts = np.array([28, 30, 31, 33, 35], dtype=np.int64)   # 佔位，下面用真實分布覆蓋
import pandas as pd
ts_all = ws.ts
# 重新取得進場時間：用 sixmonth 的做法太重，這裡以平均速率 + 歷史波動近似
counts = np.array(sorted(set([max(10, int(RATE*DAYS*s)) for s in
                              [0.70, 0.80, 0.90, 1.00, 1.10, 1.25, 1.45]])), dtype=np.int64)
print(f"  每條路徑的交易筆數從 {counts.tolist()} 抽樣（對應歷史疏密範圍）")
print(f"\n  {'風險':>6}{'達10000U':>11}{'跳空打穿':>11}{'掉到<20U':>11}"
      f"{'期末中位':>11}{'期末P95':>12}")
out = {}
for f in [.05, .10, .15, .20, .25, .30, .35, .38]:
    h, b, ru, fins = sim(r, counts, f, TARGET, START, 50000, 8, 20260918)
    out[f"{f:.2f}"] = dict(hit=h, blown=b, ruin=ru, median=float(np.median(fins)),
                           p95=float(np.percentile(fins, 95)))
    print(f"  {f*100:>5.1f}%{h*100:>10.3f}%{b*100:>10.2f}%{ru*100:>10.1f}%"
          f"{np.median(fins):>11.1f}{np.percentile(fins,95):>12.1f}")
best = max(out.items(), key=lambda kv: kv[1]["hit"])
print(f"\n  最好的情況：風險 {float(best[0])*100:.0f}% → 達標率 {best[1]['hit']*100:.3f}%"
      f"，同時有 {best[1]['ruin']*100:.1f}% 掉到 20U 以下")

# ---------------------------------------------------------- 3. 反推需要什麼
print("\n" + "="*78)
print("3. 反推：要在 91 天達標，需要什麼樣的策略")
print("="*78)
print(f"  目前每筆 {r.mean():+.4f}R，{N90:.0f} 筆/91天，f*={f_star*100:.0f}% → g*={g_star:.5f}")
print(f"  需要 g_total = ln({NEED:.0f}) = {np.log(NEED):.3f}\n")
print(f"  {'路線':<22}{'需要達到':>34}{'相對現在':>12}")
print(f"  {'加大倉位':<22}{'已在 f* 最佳點，再加只會更差':>30}{'不可行':>14}")
print(f"  {'提高交易筆數':<20}{f'{n_need:.0f} 筆/91天（現在 {N90:.0f} 筆）':>34}"
      f"{f'{n_need/N90:.0f} 倍':>12}")
mult_needed = np.log(NEED) / N90 / g_star
print(f"  {'提高每筆期望值':<19}{f'每筆對數成長 {np.log(NEED)/N90:.4f}（現在 {g_star:.5f}）':>36}"
      f"{f'{mult_needed:.0f} 倍':>12}")

# 成本牆：高頻路線的致命問題
print(f"\n  「提高交易筆數」這條路的成本牆：")
med_dist = 2 * np.nanmedian(ws.atr_f)
cost_now = (0.05*2 + 0.07 + 0.5)          # 雙邊滑點 + 佣金 + 典型點差（美元/盎司）
print(f"    現在停損距離中位 {med_dist:.2f} 美元/盎司，來回成本約 {cost_now:.2f} → "
      f"吃掉 {cost_now/med_dist*100:.1f}% 的 1R")
for d in [8.0, 4.0, 2.0, 1.0, 0.5]:
    print(f"    停損縮到 {d:>4.1f} 美元/盎司 → 成本佔 1R 的 {cost_now/d*100:>5.1f}%"
          f"　{'（邊際已被吃光）' if cost_now/d > 0.35 else ''}")

json.dump(dict(f_star=float(f_star), g_star=float(g_star), n_need=float(n_need),
               n90=float(N90), prob=out), open("threemonth_results.json", "w"), indent=2)
print(f"\n[{time.time()-t0:4.1f}s] 完成")
