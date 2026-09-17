/**
 * 乾淨的合成 K 線：用於策略的「空值檢定」。
 *
 * 與 src/data/providers.js 的 generateDemoCandles 不同——那個為了展示效果
 * 內建了 impulse / pullback / 趨勢反轉的結構（見該檔 247–264 行），
 * 等於預先埋好 SMC 策略正在尋找的東西，因此不能用來檢定策略是否有優勢。
 *
 * 本模組產生的是零漂移隨機漫步：依照建構方式，其中不存在任何可利用的優勢。
 * 任何策略跑在上面，期望值（以 R 計）都必須在統計誤差內等於 0。
 */

import { makeRng, makeGaussian } from './microlot.js';

/**
 * 產生隨機漫步 K 線。
 *
 * 每根 K 棒由 subSteps 個子步驟組成，high/low 取自子步驟路徑而非事後捏造，
 * 這點很重要：回測用 high/low 判斷是否觸及停損／停利，若影線不是真實路徑，
 * 觸價機率就會失真。
 *
 * @param {object} opts
 * @param {number} opts.seed
 * @param {number} opts.count      K 棒數量
 * @param {number} opts.price      起始價
 * @param {number} opts.sigma      每根 K 棒的對數報酬標準差（0.004 ≈ BTC 15 分鐘）
 * @param {number} opts.drift      每根 K 棒的對數漂移（預設 0＝無優勢）
 * @param {number} opts.subSteps   每根 K 棒的子步驟數
 * @param {number} opts.stepMs     K 棒間隔（毫秒）
 */
export function randomWalkCandles({
  seed = 1, count = 1200, price = 64000, sigma = 0.004,
  drift = 0, subSteps = 12, stepMs = 900000, startTime = Date.UTC(2024, 0, 1),
} = {}) {
  const rng = makeRng(seed);
  const gaussian = makeGaussian(rng);
  const subSigma = sigma / Math.sqrt(subSteps);
  const subDrift = drift / subSteps;

  const candles = [];
  let p = price;
  for (let i = 0; i < count; i++) {
    const open = p;
    let high = p, low = p;
    for (let s = 0; s < subSteps; s++) {
      p *= Math.exp(subDrift + subSigma * gaussian());
      if (p > high) high = p;
      if (p < low) low = p;
    }
    candles.push({
      time: startTime + i * stepMs,
      open, high, low, close: p,
      volume: 100 + Math.abs(gaussian()) * 40,
    });
  }
  return candles;
}

/** 從 CSV 載入真實 K 線（欄位：time,open,high,low,close[,volume]，允許表頭） */
export function parseCandleCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  const out = [];
  for (const line of rows) {
    const parts = line.split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 5) continue;
    const nums = parts.map(Number);
    if (nums.slice(0, 5).some((n) => !Number.isFinite(n))) continue;  // 跳過表頭
    let [time, open, high, low, close, volume] = nums;
    if (time < 1e12) time *= 1000;                                    // 秒 → 毫秒
    out.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 100 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
