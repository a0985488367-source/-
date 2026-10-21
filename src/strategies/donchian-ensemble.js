/**
 * 唐奇安通道組合（Zarattini／Pagani／Barbon 2025〈Catching Crypto Trends〉；2026-10-21 使用者選上 Demo 試跑）。
 * 回測（scripts/research/wild-zoo.mjs 的 A）跟線上 Worker（worker/donchian.js）都用這一份，規則只有一份。
 *
 * 每個幣、每個週期 L（5～360 天）各自一個子部位，日線收盤判斷：
 *   - 沒部位：收盤 > 前 L 天最高收盤 → 進場，停損＝最近 L 天（含今天）收盤最高最低的中點
 *   - 有部位：收盤 < 停損 → 出場；否則停損＝max(原停損, 最近 L 天中點)（只往上追）
 * 訊號＝有部位的週期數 ÷ 週期數（0～1）。
 * 權重＝訊號 × min(年化波動目標 ÷ 90 天年化波動, 上限倍數) ÷ 有一年以上資料的幣數。只做多。
 */

export const DC_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360];

export function createDonchianState(lbs = DC_LOOKBACKS) {
  return { lbs, subs: lbs.map(() => ({ on: false, stop: 0 })), hist: 0 };
}

/** 推進到第 t 天收盤（c＝這個幣對齊好的日收盤陣列，沒資料是 NaN） */
export function stepDonchian(st, c, t) {
  if (!Number.isFinite(c[t])) {
    for (const x of st.subs) x.on = false;
    st.hist = 0;
    return;
  }
  st.hist++;
  st.lbs.forEach((L, j) => {
    const x = st.subs[j];
    if (t < L) return;
    // (t-L+1 .. t-1) 共用，前 L 天＝再加 c[t-L]，最近 L 天（含今天）＝再加 c[t]
    let mHi = -Infinity, mLo = Infinity;
    for (let k = t - L + 1; k < t; k++) {
      const v = c[k];
      if (Number.isFinite(v)) { if (v > mHi) mHi = v; if (v < mLo) mLo = v; }
    }
    const a = c[t - L];
    const hi = Number.isFinite(a) ? Math.max(mHi, a) : mHi;
    const hi2 = Math.max(mHi, c[t]), lo2 = Math.min(mLo, c[t]);
    const mid = (hi2 + lo2) / 2;
    if (x.on) {
      if (c[t] < x.stop) x.on = false;
      else x.stop = Math.max(x.stop, mid);
    } else if (Number.isFinite(hi) && c[t] > hi) {
      x.on = true;
      x.stop = mid;
    }
  });
}

export const donchianSignal = (st) => st.subs.filter((x) => x.on).length / st.lbs.length;

/** 還開著的週期裡最低的停損（全部週期都出場的價位）；沒有部位回 null */
export function lowestActiveStop(st) {
  const xs = st.subs.filter((x) => x.on).map((x) => x.stop);
  return xs.length ? Math.min(...xs) : null;
}

/** 第 t 天往前 n 天的年化波動（日對數報酬標準差 × √365）；有效天數不到 60 回 null */
export function annualVol(c, t, n = 90) {
  const lr = [];
  for (let k = t - n + 1; k <= t; k++) {
    const g = Math.log(c[k] / c[k - 1]);
    if (Number.isFinite(g)) lr.push(g);
  }
  if (lr.length < 60) return null;
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / lr.length) * Math.sqrt(365);
}

/**
 * 第 t 天收盤後的目標權重（占資金的比例，1 倍曝險）。states 要先推進到第 t 天。
 * 回傳 { weights: {sym: w}, detail: {sym: {signal, vol, stop}}, eligible: [...] }
 */
export function donchianWeights(states, closes, t, { volTarget = 0.25, cap = 2, minHistory = 365 } = {}) {
  const eligible = Object.keys(states).filter((s) => Number.isFinite(closes[s][t]) && states[s].hist >= minHistory);
  const weights = {}, detail = {};
  for (const s of eligible) {
    const sig = donchianSignal(states[s]);
    const vol = sig ? annualVol(closes[s], t) : null;
    detail[s] = { signal: sig, vol, stop: lowestActiveStop(states[s]) };
    if (!sig || !vol) continue;
    weights[s] = (sig * Math.min(volTarget / vol, cap)) / eligible.length;
  }
  return { weights, detail, eligible };
}

/** 少換倉：新舊都不是 0、差不到 band（相對大的那個）就維持原本的權重 */
export function applyBand(target, prev, band) {
  if (band && prev && target && Math.abs(target - prev) < band * Math.max(Math.abs(target), Math.abs(prev))) return prev;
  return target;
}

/**
 * 一次算到最後一天（線上用）：closesBySym＝{sym: 日收盤陣列}，全部對齊同一條日期軸，最後一格是剛收盤那天。
 */
export function donchianLatest(closesBySym, opts = {}) {
  const syms = Object.keys(closesBySym);
  const n = Math.max(...syms.map((s) => closesBySym[s].length));
  const states = Object.fromEntries(syms.map((s) => [s, createDonchianState(opts.lbs)]));
  for (let t = 0; t < n; t++) for (const s of syms) stepDonchian(states[s], closesBySym[s], t);
  return { ...donchianWeights(states, closesBySym, n - 1, opts), states };
}

/** 日 K 棒（{time, close}，time＝UTC 當天 0 點）對齊成同一條日期軸；只留 now 之前已經收盤的 */
export function alignDailyCloses(candlesBySym, now = Date.now()) {
  const DAY = 86_400_000;
  let t0 = Infinity, t1 = -Infinity;
  const closed = {};
  for (const [s, cs] of Object.entries(candlesBySym)) {
    const xs = cs.filter((k) => k.time + DAY <= now);
    if (!xs.length) continue;
    closed[s] = xs;
    t0 = Math.min(t0, xs[0].time); t1 = Math.max(t1, xs[xs.length - 1].time);
  }
  const days = [];
  for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) days.push(t);
  const idx = new Map(days.map((t, i) => [t, i]));
  const closes = {};
  for (const [s, xs] of Object.entries(closed)) {
    const a = new Array(days.length).fill(NaN);
    for (const k of xs) { const i = idx.get(Math.floor(k.time / DAY) * DAY); if (i != null) a[i] = k.close; }
    closes[s] = a;
  }
  return { days, closes };
}
