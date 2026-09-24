/**
 * 部位管理引擎（Trade Management）
 *
 * 這是「訊號發出之後會發生什麼事」的唯一真相來源：
 * 模擬盤追蹤（scripts/lib/tracker.mjs）與回測（src/smc/backtest.js）
 * 都呼叫同一組函式，所以回測上看到的改善，上線後就是同一套規則在跑。
 *
 * 管理規則（全部可關閉，預設值由 scripts/research/ab-test.mjs 實測決定）：
 *   1. 保本鏢（scalp）      先在很近的 R 倍數分批出場一部分
 *   2. 移動到成本價（BE）   達到指定 R 之後把停損拉到進場價
 *   3. 認賠出場（scratch）  逆行到指定 R 就主動離場，不等結構停損
 *   4. 追蹤停損（trail）    獲利超過門檻後，停損跟著最高獲利走
 *   5. 時間停損（stall）    成交後一段時間都沒走出有利幅度，收盤出場
 *   6. 進場區失守（zone）   收盤價跌破（空單：站上）進場區，收盤出場，不等停損緩衝被打到
 *
 * R 的定義：以「進場價到原始停損」的距離為 1R。
 * 部位以比例計算，t.r 是整筆部位的淨 R（含所有分批），而不是最後一段的 R。
 */

/** 保證是有限數字：任何算式意外產生 undefined/NaN/Infinity 時，安全退回 fallback */
export const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 預設值不是猜的，是 scripts/research/ab-test.mjs 在三組互不重疊的幣種上
 * 實測出來的（合計 4,592 個訊號）。三組的結論一致：
 *
 *   規則        勝率        總R          獲利因子   最大回撤
 *   目前線上    33–36%     +90 ~ +111   1.06–1.15  39–66R
 *   本組預設    74–76%     +134 ~ +158  1.37–1.50  9–10R
 *
 * 關鍵在於：訊號數量完全沒變（同一份訊號餵給每一組規則），
 * 改善全部來自「進場之後怎麼管」。
 */
export const DEFAULT_MANAGEMENT = {
  scalpR: 0.5,           // 保本鏢距離（R）。0 = 不使用
  scalpFraction: 0.34,   // 保本鏢出場比例（0–0.9）
  breakevenAtR: 0.5,     // 獲利達此 R 後把停損移到成本價。0 = 不使用
  breakevenOffsetR: 0.05, // 成本價再往獲利方向推移的 R（覆蓋手續費）
  scratchR: 0,           // 逆行達此 R 就認賠出場。實測顯示會惡化回撤，預設關閉
  trailFromR: 1.5,       // 獲利達此 R 之後啟用追蹤停損。0 = 不使用
  trailGapR: 0.8,        // 追蹤停損與最高獲利的距離（R）
  entryWindowBars: 24,   // 限價單等待成交的最長根數
  maxHoldBars: 200,      // 成交後最長持有根數
  stallBars: 0,          // 成交後這麼多根都沒碰到 stallMinR 就收盤出場。0 = 不使用
  stallMinR: 0.3,
  zoneCloseExit: false,  // 收盤價穿過進場區另一側就出場（需要 t.zone = { top, bottom }）
};

/**
 * 把原本的目標清單組成「有出場比例」的階梯。
 * 保本鏢排在最前面，剩下的比例平均分給原有目標，最後一段出清全部剩餘。
 */
export function buildLadder(entry, stop, targets, cfg = {}) {
  const { scalpR = 0, scalpFraction = 0 } = { ...DEFAULT_MANAGEMENT, ...cfg };
  const risk = Math.abs(entry - stop);
  const list = [];
  if (!(risk > 0)) return (targets ?? []).map((t) => ({ ...t }));

  const long = stop < entry;
  const useScalp = scalpR > 0 && scalpFraction > 0;
  // 保本鏢比原有 TP1 還遠就沒有意義了（代表 TP1 本來就夠近）
  const firstRR = targets?.[0]?.rr;
  if (useScalp && !(Number.isFinite(firstRR) && firstRR <= scalpR * 1.2)) {
    list.push({
      name: 'TP0',
      price: long ? entry + risk * scalpR : entry - risk * scalpR,
      rr: scalpR,
      label: '保本鏢',
      labelEn: 'Scalp runner',
      fraction: scalpFraction,
      scalp: true,
    });
  }

  const rest = (targets ?? []).map((t) => ({ ...t }));
  const remaining = 1 - list.reduce((s, t) => s + t.fraction, 0);
  rest.forEach((t, i) => {
    t.fraction = i === rest.length - 1 ? 0 : remaining / rest.length; // 最後一段出清剩餘
  });
  return [...list, ...rest].map((t, i) => ({ ...t, name: t.name ?? `TP${i + 1}` }));
}

/** 對照表：把交易當下的持倉狀態整理成好讀的數字 */
function ensureLegs(t) {
  if (!Array.isArray(t.targets)) t.targets = [];
  const n = t.targets.length;
  t.targets = t.targets.map((tp, i) => ({
    ...tp,
    // 舊資料沒有 fraction：平均分配，最後一段出清
    fraction: Number.isFinite(tp.fraction) ? tp.fraction : i === n - 1 ? 0 : 1 / n,
  }));
  if (!Number.isFinite(t.remaining)) t.remaining = 1;
  if (!Number.isFinite(t.realizedR)) t.realizedR = 0;
  return t;
}

/** 在指定價格把 `fraction` 比例的部位平倉，累加已實現 R */
function realize(t, price, fraction, risk) {
  const long = t.dir === 'long';
  const r = (long ? price - t.entry : t.entry - price) / risk;
  const take = Math.min(fraction, t.remaining);
  t.realizedR = finite(t.realizedR) + finite(r) * take;
  t.remaining = Math.max(0, t.remaining - take);
  return finite(r);
}

/** 整筆部位結算：把剩餘部位在 price 平倉，寫入最終 r 與狀態 */
function close(t, price, risk, status, reason, time) {
  if (t.remaining > 0) realize(t, price, t.remaining, risk);
  t.status = status;
  t.exitReason = reason;
  t.closedTime = time;
  t.exitPrice = price;
  t.r = finite(t.realizedR);
  return t;
}

/**
 * 推進一根 K 棒。回傳 true 表示這筆交易已結束。
 * 同一根同時觸及停損與目標時一律算停損（保守假設）。
 */
export function stepTrade(t, c, cfg = {}) {
  const o = { ...DEFAULT_MANAGEMENT, ...cfg };
  if (t.status === 'target' || t.status === 'stop' || t.status === 'expired') return true;

  ensureLegs(t);
  const long = t.dir === 'long';
  // 風險單位一律用「原始停損」計算：停損移動之後 R 的刻度不能跟著變
  if (!Number.isFinite(t.initialStop)) t.initialStop = t.stop;
  const risk = Math.abs(t.entry - t.initialStop) || 1;
  t.lastCheckedTime = c.time;
  t.barsSinceOpen = (t.barsSinceOpen ?? 0) + 1;

  if (t.status === 'pending') {
    const filled = long ? c.low <= t.entry : c.high >= t.entry;
    if (filled) {
      t.status = 'active';
      t.filledTime = c.time;
      t.barsSinceFill = 0;
      t.events.push({ type: 'filled', time: c.time, price: t.entry });
    } else {
      // 等太久都沒被碰到 → 作廢。
      // （不需要另外判斷「跌破停損」：停損必在進場價的另一側，
      //   價格要到停損一定先經過進場價，也就一定會先成交。）
      if (t.barsSinceOpen > o.entryWindowBars) {
        t.status = 'expired';
        t.exitReason = 'timeout';
        t.closedTime = c.time;
        t.exitPrice = c.close;
        t.r = 0;
        t.events.push({ type: 'expired', time: c.time, reason: 'timeout' });
        return true;
      }
      return false;
    }
  }

  t.barsSinceFill = (t.barsSinceFill ?? 0) + 1;

  // 記錄最大有利／不利幅度（用來評估「有沒有先到過某個 R 再被打掉」）
  const favorable = (long ? c.high - t.entry : t.entry - c.low) / risk;
  const adverse = (long ? c.low - t.entry : t.entry - c.high) / risk;
  t.maxFavorableR = Math.max(finite(t.maxFavorableR), finite(favorable));
  t.maxAdverseR = Math.min(finite(t.maxAdverseR), finite(adverse));

  // 1) 停損永遠最優先
  if (long ? c.low <= t.stop : c.high >= t.stop) {
    // 停損已經被推到進場價（含手續費緩衝）之後，出場就不算「虧損出場」了
    const eps = risk * 1e-6;
    const atBE = long ? t.stop >= t.entry - eps : t.stop <= t.entry + eps;
    close(t, t.stop, risk, 'stop', t.trailing ? 'trail' : atBE ? 'breakeven' : 'stop', c.time);
    t.events.push({ type: 'stop', time: c.time, price: t.stop, reason: t.exitReason });
    return true;
  }

  // 2) 認賠出場：逆行到門檻就走，不等結構停損被打穿
  if (o.scratchR > 0 && !t.hitTargets.length) {
    const px = long ? t.entry - risk * o.scratchR : t.entry + risk * o.scratchR;
    if (long ? c.low <= px : c.high >= px) {
      close(t, px, risk, 'stop', 'scratch', c.time);
      t.events.push({ type: 'stop', time: c.time, price: px, reason: 'scratch' });
      return true;
    }
  }

  // 3) 分批出場
  for (const tp of t.targets) {
    if (t.hitTargets.includes(tp.name)) continue;
    if (!(long ? c.high >= tp.price : c.low <= tp.price)) continue;
    t.hitTargets.push(tp.name);
    const isLast = tp === t.targets[t.targets.length - 1];
    if (isLast || tp.fraction <= 0) {
      close(t, tp.price, risk, 'target', 'target', c.time);
      t.events.push({ type: 'target', name: tp.name, time: c.time, price: tp.price, rr: finite(tp.rr) });
      return true;
    }
    realize(t, tp.price, tp.fraction, risk);
    t.events.push({ type: 'target', name: tp.name, time: c.time, price: tp.price, rr: finite(tp.rr), partial: tp.fraction });
  }

  // 4) 收盤才判斷的提早出場：這根已經收完，用收盤價出場
  if (!t.beMoved && !t.hitTargets.length) {
    const stalled = o.stallBars > 0 && t.barsSinceFill >= o.stallBars && t.maxFavorableR < o.stallMinR;
    const zoneBroken = o.zoneCloseExit && t.zone && (long ? c.close < t.zone.bottom : c.close > t.zone.top);
    if (stalled || zoneBroken) {
      const reason = zoneBroken ? 'zoneBreak' : 'stall';
      close(t, c.close, risk, 'stop', reason, c.time);
      t.events.push({ type: 'stop', time: c.time, price: c.close, reason });
      return true;
    }
  }

  // 5) 移動停損到成本價
  if (o.breakevenAtR > 0 && !t.beMoved && t.maxFavorableR >= o.breakevenAtR) {
    const be = long ? t.entry + risk * o.breakevenOffsetR : t.entry - risk * o.breakevenOffsetR;
    if (long ? be > t.stop : be < t.stop) {
      t.stop = be;
      t.beMoved = true;
      t.events.push({ type: 'breakeven', time: c.time, price: be });
    }
  }

  // 6) 追蹤停損
  if (o.trailFromR > 0 && o.trailGapR > 0 && t.maxFavorableR >= o.trailFromR) {
    const lockR = t.maxFavorableR - o.trailGapR;
    const px = long ? t.entry + risk * lockR : t.entry - risk * lockR;
    if (long ? px > t.stop : px < t.stop) {
      t.stop = px;
      t.trailing = true;
    }
  }

  // 7) 抱太久
  if (t.barsSinceFill > o.maxHoldBars) {
    close(t, c.close, risk, 'expired', 'maxHold', c.time);
    t.events.push({ type: 'expired', time: c.time, reason: 'maxHold' });
    return true;
  }
  return false;
}
