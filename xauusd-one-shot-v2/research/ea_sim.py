"""以 EA 的事件迴圈重跑策略，與研究回測逐筆對帳。

port_check.py 驗證的是「訊號」等價；這支驗證的是「交易管理」等價：
保本時序、真 48 曆時小時逾時、單倉不重疊、出場當根不重進。

模擬的是 OneShotV2_EA.mq5 的 OnTick 結構：
  每根新的 M5 K 開盤時 →  ManagePosition()  再  TryEntry()

用法： python3 ea_sim.py [--strict-entry-bar]
"""
import sys, importlib.util, contextlib, io
import numpy as np, pandas as pd

STRICT = "--strict-entry-bar" in sys.argv

spec = importlib.util.spec_from_file_location("ev", "./exit_variants.py")
ev = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ev)

d, q, qpos = ev.d, ev.q, ev.qpos
o, hi, lo, cl, sp = ev.o, ev.hi, ev.lo, ev.cl, ev.sp
atr, times, sig = ev.atr, ev.times, ev.sig

SLIP, FEE, CARRY = 0.05, 0.07, 0.30
STOP_K, TP_R, BE_R, HOLD_H = 2.0, 5.0, 1.5, 48

# 統一換算成 epoch 秒：pandas 3.0 的索引解析度是 us，asi8 不是奈秒，
# 而 Timestamp.value 永遠是奈秒，直接混用會對不起來。
_UNIT = {"s": 1, "ms": 10**3, "us": 10**6, "ns": 10**9}

def epoch_sec(idx):
    return np.asarray(idx.asi8, dtype="int64") // _UNIT[idx.unit]

M15 = 900
m5_sec  = epoch_sec(d.index)
q_sec   = epoch_sec(q.index)
# M15 開盤時間 -> 該根在 q 中的索引，讓 EA 能「查出剛收盤的那根 M15」
m15_index = {int(t): z for z, t in enumerate(q_sec)}


def research_trades(start, end):
    """calendar_hold_fix.run() 的交易明細（已證實可重現報告數字）。"""
    start, end = pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC")
    last, out = -1, []
    for z in np.flatnonzero(sig):
        i = qpos[z]
        if i < 0 or i <= last or times[i] < start or times[i] >= end or not np.isfinite(atr[z]):
            continue
        side = int(sig[z]); dist = STOP_K * atr[z]
        entry = (o[i] + sp[i] if side == 1 else o[i]) + side * SLIP
        stop = entry - side * dist; target = entry + side * TP_R * dist
        pending, peak, fill, j = None, 0.0, None, i
        deadline = times[i] + pd.Timedelta(hours=HOLD_H)
        for j in range(i, len(d)):
            if times[j] >= end: j = max(i, j - 1); break
            if pending is not None:
                stop = max(stop, pending) if side == 1 else min(stop, pending); pending = None
            if j > i and times[j] >= deadline:
                fill = (o[j] + (sp[j] if side == -1 else 0)) - side * SLIP; break
            oo = o[j] + (sp[j] if side == -1 else 0)
            hh = hi[j] + (sp[j] if side == -1 else 0)
            ll = lo[j] + (sp[j] if side == -1 else 0)
            if side == 1:
                if oo <= stop: fill = oo - SLIP; break
                if oo >= target: fill = target; break
                if ll <= stop: fill = stop - SLIP; break
                if hh >= target: fill = target; break
            else:
                if oo >= stop: fill = oo + SLIP; break
                if oo <= target: fill = target; break
                if hh >= stop: fill = stop + SLIP; break
                if ll <= target: fill = target; break
            exc = side * ((cl[j] + (sp[j] if side == -1 else 0)) - entry) / dist
            peak = max(peak, exc)
            if peak >= BE_R: pending = entry
        if fill is None:
            fill = (cl[j] + (sp[j] if side == -1 else 0)) - side * SLIP
        days = max(0, (times[j].normalize() - times[i].normalize()).days)
        out.append((i, j, side, (side * (fill - entry) - FEE - CARRY * days) / dist))
        last = j
    return out


def _intrabar_exit(pos, j):
    """券商在盤中執行 SL / TP。送單時 SL 就已掛上，因此進場那一根也適用。"""
    side, target, stop = pos["side"], pos["target"], pos["stop"]
    oo = o[j]  + (sp[j] if side == -1 else 0)
    hh = hi[j] + (sp[j] if side == -1 else 0)
    ll = lo[j] + (sp[j] if side == -1 else 0)
    if side == 1:
        if oo <= stop:   return oo - SLIP
        if oo >= target: return target
        if ll <= stop:   return stop - SLIP
        if hh >= target: return target
    else:
        if oo >= stop:   return oo + SLIP
        if oo <= target: return target
        if hh >= stop:   return stop + SLIP
        if ll <= target: return target
    return None


def _close_trade(pos, j, fill, out):
    days = max(0, (times[j].normalize() - times[pos["i"]].normalize()).days)
    r = (pos["side"] * (fill - pos["entry"]) - FEE - CARRY * days) / pos["dist"]
    out.append((pos["i"], j, pos["side"], r))
    return j


def ea_trades(start, end):
    """OneShotV2_EA.mq5 的事件迴圈。"""
    start, end = pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC")
    out = []
    last_m15 = None
    last_exit_bar = -1
    pos = None            # EA 的 g_* 狀態

    for j in range(len(d)):
        if times[j] >= end:
            # 區間邊界：與研究回測一致，未平倉部位按市價結清（純屬分段記帳，
            # 真實 EA 會讓部位繼續持有到 SL/TP/逾時）
            if pos is not None:
                k = max(pos["i"], j - 1)
                fill = (cl[k] + (sp[k] if pos["side"] == -1 else 0)) - pos["side"] * SLIP
                _close_trade(pos, k, fill, out); pos = None
            break
        # --- 新的 M5 K：對應 OnTick 的 m5 != g_last_m5
        m15_open = (m5_sec[j] // M15) * M15
        m15_just_closed = (last_m15 is not None and m15_open != last_m15)
        last_m15 = m15_open

        # ---------------- ManagePosition ----------------
        if pos is not None:
            side, entry, dist = pos["side"], pos["entry"], pos["dist"]

            # 1&4 用「剛收盤」那根 M5 更新浮盈高點，達標即刻移到保本
            if j > pos["i"]:
                k = j - 1
                mark = cl[k] + (sp[k] if side == -1 else 0)
                pos["peak"] = max(pos["peak"], side * (mark - entry) / dist)
                if not pos["be"] and pos["peak"] >= BE_R:
                    pos["stop"] = entry; pos["be"] = True

            # 2 真 48 曆時小時逾時 → 本根開盤出場；否則 3 交給券商的 SL/TP
            if j > pos["i"] and times[j] >= pos["deadline"]:
                fill = (o[j] + (sp[j] if side == -1 else 0)) - side * SLIP
            else:
                fill = _intrabar_exit(pos, j)
            if fill is not None:
                last_exit_bar = _close_trade(pos, j, fill, out); pos = None

        # ---------------- TryEntry ----------------
        if pos is None and m15_just_closed and j > last_exit_bar and times[j] >= start:
            sig_open = int(m15_open - M15)                # 剛收盤的那根 M15
            z = m15_index.get(sig_open)
            if z is not None and sig[z] != 0 and np.isfinite(atr[z]):
                # EA 只在「M15 收盤時點的那根 M5」進場；缺口造成的過期訊號不追
                stale = (m5_sec[j] != sig_open + M15)
                if not (STRICT and stale):
                    side = int(sig[z]); dist = STOP_K * atr[z]
                    entry = (o[j] + sp[j] if side == 1 else o[j]) + side * SLIP
                    pos = dict(i=j, side=side, entry=entry, dist=dist,
                               stop=entry - side * dist, target=entry + side * TP_R * dist,
                               deadline=times[j] + pd.Timedelta(hours=HOLD_H),
                               peak=0.0, be=False)
                    # 送單時 SL/TP 已掛上 → 進場那一根就可能被打掉
                    fill = _intrabar_exit(pos, j)
                    if fill is not None:
                        last_exit_bar = _close_trade(pos, j, fill, out); pos = None
    return out


periods = {"2024": ("2024-01-01", "2025-01-01"), "2025": ("2025-01-01", "2026-01-01"),
           "2026H1": ("2026-01-01", "2026-06-19"), "FINAL90": ("2026-06-19", "2026-09-17")}

print(f"進場模式：{'嚴格（只在 M15 收盤時點的 M5 進場）' if STRICT else '寬鬆（新 M15 後的第一根 M5 就進）'}\n")
print(f"{'區段':<10}{'研究':>6}{'EA':>6}{'逐筆相同':>10}{'研究sumR':>11}{'EA sumR':>11}")
tot_r = tot_e = tot_same = 0
for k, (a, b) in periods.items():
    R, E = research_trades(a, b), ea_trades(a, b)
    same = sum(1 for x, y in zip(R, E)
               if x[0] == y[0] and x[1] == y[1] and x[2] == y[2] and abs(x[3] - y[3]) < 1e-9)
    tot_r += len(R); tot_e += len(E); tot_same += same
    print(f"{k:<10}{len(R):>6}{len(E):>6}{same:>10}"
          f"{sum(t[3] for t in R):>11.4f}{sum(t[3] for t in E):>11.4f}")
print(f"\n{'合計':<10}{tot_r:>6}{tot_e:>6}{tot_same:>10}")
print("\n" + ("EA 事件迴圈與研究回測逐筆一致 ✓" if tot_r == tot_e == tot_same
              else f"*** 有 {max(tot_r, tot_e) - tot_same} 筆落差 ***"))
