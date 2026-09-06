/**
 * scan-engine — Crypto Radar Guardian 獨立版掃描引擎
 *
 * 純邏輯，不碰 DOM，可在瀏覽器與 node 測試中共用。
 * 由 scripts/build-standalone-app.mjs 內嵌進 public/crypto-radar-guardian.html。
 * 修改本檔後必須重新執行產生器，不要手改產生後的 HTML。
 *
 * 資料來源一律是 Bybit 公開行情端點，不需要 API Key：
 *   /v5/market/instruments-info
 *   /v5/market/tickers
 *   /v5/market/kline
 *   /v5/market/open-interest
 *   /v5/market/orderbook
 *
 * 本引擎只做研究與觀察，不下單、不連接帳戶、不處理任何金鑰。
 */

import { BYBIT_BASE } from './bybit-base.js';

export { BYBIT_BASE };
export const PROVIDER = 'Bybit Pre-Breakout';
export const ENGINE_VERSION = '10.0-standalone';

/* ------------------------------------------------------------------ */
/* 門檻常數                                                             */
/* ------------------------------------------------------------------ */

export const UNIVERSE = Object.freeze({
  minTurnover24hUsd: 500_000,
  minOpenInterestUsd: 100_000,
  minListedHours: 24,
  maxListedHours: 24 * 365 * 3,
  maxSpreadPct: 0.6,
  minChange24hPct: -12,
  maxChange24hPct: 10,
  minRangePosition: 0.35,
  maxRangePosition: 0.96,
  maxDetailedAnalysis: 12,
});

export const BLOWN_OFF = Object.freeze({
  maxChange24hPct: 10,
  maxChange1hPct: 4,
  maxChange6hPct: 10,
  maxBreakoutOvershootPct: 0.8,
  maxVolumeMultiple: 5,
  maxBreakoutDistancePct: 4,
  maxCompressionRatio: 1.2,
  maxAbsFundingRatePct: 0.15,
});

export const ENTRY = Object.freeze({
  minScore: 80,
  minBreakoutDistancePct: -0.25,
  maxBreakoutDistancePct: 2,
  maxCompressionRatio: 0.95,
  minVolumeMultiple: 1.1,
  maxVolumeMultiple: 3,
  minOiChangePct: 0.25,
  maxOiChangePct: 5,
  minChange1hPct: -1,
  maxChange1hPct: 2.5,
  minChange6hPct: -3,
  maxChange6hPct: 6,
  maxDataAgeMinutes: 45,
  staleWarningMinutes: 15,
});

export const MAX_DISPLAYED = 8;

export const EXPLICIT_MEME_BASES = Object.freeze([
  'PEPE', 'DOGE', 'SHIB', 'WIF', 'BONK', 'FLOKI', 'TRUMP',
]);

export const MAJOR_BASES = Object.freeze([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT',
  'ATOM', 'ARB', 'OP', 'MATIC', 'TON', 'TRX', 'NEAR', 'APT', 'SUI', 'INJ',
  'FIL', 'ETC', 'BCH', 'UNI', 'AAVE', 'XLM', 'ICP', 'HBAR', 'VET', 'ALGO',
]);

export const MEME_FIXED_RISK_PERCENT = 0.15;

/**
 * 主幣固定觀察清單。
 *
 * 這幾檔不論有沒有擠進第一階段排名都會被分析，
 * 因為使用者要的是「隨時看得到主幣狀態」，而不是等它剛好符合快噴型態。
 */
export const MAIN_WATCHLIST = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

/**
 * 分組：主幣 或 迷因幣／高風險。
 *
 * 主幣 = 在觀察清單內，或被判定為主流標的。
 * 其餘一律歸到迷因幣／高風險（含判斷不出來而 fail-safe 的標的）。
 */
export function coinGroup(symbol, isMeme, watchlist) {
  const list = watchlist ?? MAIN_WATCHLIST;
  if (list.includes(String(symbol).toUpperCase())) return 'main';
  return isMeme ? 'meme' : 'main';
}

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'PYUSD', 'BUSD', 'USDD']);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);

export function normalizeBase(symbol) {
  return String(symbol).toUpperCase().replace(/USDT$/, '').replace(/^(1000000|10000|1000)/, '');
}

export function bybitContractUrl(symbol) {
  return `${'https://www.bybit.com/trade/usdt/'}${encodeURIComponent(String(symbol).toUpperCase())}`;
}

export function classifyMeme(symbol, listedDays, turnoverUsd, oiUsd) {
  const base = normalizeBase(symbol);
  if (EXPLICIT_MEME_BASES.includes(base)) {
    return { isMeme: true, confidence: 'high', reasons: [`${base} 在明確迷因幣清單內`] };
  }
  if (MAJOR_BASES.includes(base)) {
    return { isMeme: false, confidence: 'high', reasons: [`${base} 在主流標的清單內`] };
  }
  const reasons = [];
  if (/^(1000000|10000|1000)[A-Z]/.test(String(symbol).toUpperCase())) {
    reasons.push('帶有面額前綴，屬極低單價標的');
  }
  if (Number.isFinite(listedDays) && listedDays < 180) {
    reasons.push(`上線僅 ${Math.round(listedDays)} 天`);
  }
  if (Number.isFinite(turnoverUsd) && Number.isFinite(oiUsd) && oiUsd > 0 && turnoverUsd / oiUsd > 8) {
    reasons.push(`成交額為未平倉值的 ${(turnoverUsd / oiUsd).toFixed(1)} 倍`);
  }
  if (reasons.length >= 2) return { isMeme: true, confidence: 'medium', reasons };
  if (reasons.length === 1) return { isMeme: true, confidence: 'low', reasons };
  return { isMeme: true, confidence: 'low', reasons: [`${base} 不在已知主流清單內，依保守原則套用相同風控`] };
}

/**
 * 風控標籤。
 *
 * 只有高信心才可以在畫面上斷言「這是迷因幣」。
 * 低信心是「不在已知主流清單內」的保守處理，把它寫成迷因幣是不實陳述。
 */
export function riskLabel(meme) {
  if (!meme.isMeme) return null;
  if (meme.confidence === 'high') return '迷因幣 · 固定 0.15% 防守倉';
  if (meme.confidence === 'medium') return '疑似迷因幣 · 保守 0.15% 倉位';
  return '未列入主流 · 保守 0.15% 倉位';
}

/* ------------------------------------------------------------------ */
/* 第一階段：宇宙篩選                                                    */
/* ------------------------------------------------------------------ */

/**
 * 合併 instruments-info 與 tickers，算出第一階段所需欄位。
 * 只保留 Bybit USDT 線性永續，排除穩定幣。
 */
export function buildUniverse(instruments, tickers, now = Date.now()) {
  const tickerBySymbol = new Map();
  for (const t of tickers ?? []) tickerBySymbol.set(t.symbol, t);

  const rows = [];
  for (const inst of instruments ?? []) {
    if (inst.status && inst.status !== 'Trading') continue;
    if (inst.quoteCoin !== 'USDT') continue;
    if (inst.contractType && !/LinearPerpetual/i.test(inst.contractType)) continue;
    if (STABLECOINS.has(normalizeBase(inst.symbol))) continue;

    const t = tickerBySymbol.get(inst.symbol);
    if (!t) continue;

    const last = num(t.lastPrice);
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    const high = num(t.highPrice24h);
    const low = num(t.lowPrice24h);
    const turnover = num(t.turnover24h);
    const oiValue = num(t.openInterestValue);
    const change24hPct = num(t.price24hPcnt) * 100;
    const fundingRatePct = num(t.fundingRate) * 100;
    const launchMs = num(inst.launchTime);

    if (!Number.isFinite(last) || last <= 0) continue;

    const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 100
      : NaN;
    const rangePosition24h = Number.isFinite(high) && Number.isFinite(low) && high > low
      ? (last - low) / (high - low)
      : NaN;
    const listedHours = Number.isFinite(launchMs) && launchMs > 0 ? (now - launchMs) / 3_600_000 : NaN;

    rows.push({
      symbol: inst.symbol,
      lastPrice: last,
      turnover24hUsd: turnover,
      openInterestUsd: oiValue,
      listedHours,
      listedDays: Number.isFinite(listedHours) ? listedHours / 24 : NaN,
      spreadPct,
      change24hPct,
      rangePosition24h,
      fundingRatePct,
      high24h: high,
      low24h: low,
    });
  }
  return rows;
}

export function passesUniverseFilter(r) {
  return (
    Number.isFinite(r.turnover24hUsd) && r.turnover24hUsd >= UNIVERSE.minTurnover24hUsd &&
    Number.isFinite(r.openInterestUsd) && r.openInterestUsd >= UNIVERSE.minOpenInterestUsd &&
    Number.isFinite(r.listedHours) &&
    r.listedHours >= UNIVERSE.minListedHours && r.listedHours <= UNIVERSE.maxListedHours &&
    Number.isFinite(r.spreadPct) && r.spreadPct <= UNIVERSE.maxSpreadPct &&
    Number.isFinite(r.change24hPct) &&
    r.change24hPct >= UNIVERSE.minChange24hPct && r.change24hPct <= UNIVERSE.maxChange24hPct &&
    Number.isFinite(r.rangePosition24h) &&
    r.rangePosition24h >= UNIVERSE.minRangePosition && r.rangePosition24h <= UNIVERSE.maxRangePosition
  );
}

/**
 * 第一階段排序：越接近「壓縮後貼近前高」越優先。
 * 這裡還沒有 K 線，只能用 24H 區間位置與成交額做初排。
 */
export function rankUniverse(rows) {
  return [...rows].sort((a, b) => {
    const score = (r) => r.rangePosition24h * 0.7 + Math.min(1, Math.log10(Math.max(r.turnover24hUsd, 1)) / 9) * 0.3;
    return score(b) - score(a);
  }).slice(0, UNIVERSE.maxDetailedAnalysis);
}

/**
 * 決定要詳細分析哪些標的。
 *
 * 主幣觀察清單一律納入（即使沒通過第一階段門檻，使用者仍要看到它的狀態）。
 * 其餘標的走正常的第一階段篩選與排名，最多取 UNIVERSE.maxDetailedAnalysis 檔。
 */
export function selectTargets(rows, watchlist) {
  const list = (watchlist ?? MAIN_WATCHLIST).map((s) => s.toUpperCase());
  const bySymbol = new Map();
  for (const r of rows ?? []) bySymbol.set(String(r.symbol).toUpperCase(), r);

  const main = [];
  for (const symbol of list) {
    const row = bySymbol.get(symbol);
    if (row) main.push(row);
  }

  const rest = (rows ?? []).filter((r) => !list.includes(String(r.symbol).toUpperCase()));
  const scan = rankUniverse(rest.filter(passesUniverseFilter));

  return { main, scan, all: [...main, ...scan] };
}

/* ------------------------------------------------------------------ */
/* 第二階段：K 線與未平倉量指標                                          */
/* ------------------------------------------------------------------ */

/**
 * Bybit kline 回傳為新到舊的陣列：
 * [startTime, open, high, low, close, volume, turnover]
 * 這裡轉成舊到新，方便計算。
 */
export function parseKlines(list) {
  return (list ?? [])
    .map((k) => ({
      t: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]),
      close: num(k[4]), volume: num(k[5]),
    }))
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.high) && Number.isFinite(k.low))
    .sort((a, b) => a.t - b.t);
}

/** Bybit open-interest 回傳新到舊，轉成舊到新 */
export function parseOpenInterest(list) {
  return (list ?? [])
    .map((o) => ({ t: num(o.timestamp), oi: num(o.openInterest) }))
    .filter((o) => Number.isFinite(o.oi))
    .sort((a, b) => a.t - b.t);
}

/**
 * 由 15m K 線計算詳細指標。
 * 資料不足時對應欄位為 NaN，後續閘門會因此判定未通過（fail-safe）。
 */
export function computeMetrics(klines, oiSeries) {
  const n = klines.length;
  const last = klines[n - 1];
  const closeAt = (back) => (n - 1 - back >= 0 ? klines[n - 1 - back].close : NaN);

  const pctChange = (from, to) => (Number.isFinite(from) && from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : NaN);

  // 15m K 線：1H = 4 根，6H = 24 根
  const change1hPct = pctChange(closeAt(4), last?.close);
  const change6hPct = pctChange(closeAt(24), last?.close);

  // 壓縮比：最近 8 根的平均實體區間 ÷ 更早 24 根的平均實體區間
  const ranges = klines.map((k) => (k.high - k.low) / (k.close || 1));
  const recentRange = mean(ranges.slice(-8));
  const baseRange = mean(ranges.slice(-32, -8));
  const compressionRatio = Number.isFinite(recentRange) && Number.isFinite(baseRange) && baseRange > 0
    ? recentRange / baseRange
    : NaN;

  // 量能倍率：最近 3 根均量 ÷ 更早 20 根均量
  const vols = klines.map((k) => k.volume).filter(Number.isFinite);
  const recentVol = mean(vols.slice(-3));
  const baseVol = mean(vols.slice(-23, -3));
  const volumeMultiple = Number.isFinite(recentVol) && Number.isFinite(baseVol) && baseVol > 0
    ? recentVol / baseVol
    : NaN;

  // 距突破點：前高取「不含最後 2 根」的最高價
  const priorHighs = klines.slice(0, Math.max(0, n - 2)).map((k) => k.high).filter(Number.isFinite);
  const priorHigh = priorHighs.length ? Math.max(...priorHighs) : NaN;
  const breakoutDistancePct = Number.isFinite(priorHigh) && Number.isFinite(last?.close) && last.close > 0
    ? ((priorHigh - last.close) / last.close) * 100
    : NaN;

  // 未平倉量變化
  const oiFirst = oiSeries[0]?.oi;
  const oiLast = oiSeries[oiSeries.length - 1]?.oi;
  const oiChangePct = Number.isFinite(oiFirst) && oiFirst > 0 && Number.isFinite(oiLast)
    ? ((oiLast - oiFirst) / oiFirst) * 100
    : NaN;

  // 資料年齡要算「最後一根 K 線收盤後過了多久」，不是它的開盤時間。
  // 用開盤時間會讓正在形成中的 K 線一律顯示成 0～15 分鐘舊，
  // 在 15 分鐘門檻上反覆誤報。餵得上資料時這個值應該接近 0。
  const intervalMs = n >= 2 && Number.isFinite(klines[n - 1].t) && Number.isFinite(klines[n - 2].t)
    ? klines[n - 1].t - klines[n - 2].t
    : NaN;
  const dataAgeMinutes = Number.isFinite(last?.t) && Number.isFinite(intervalMs)
    ? Math.max(0, (Date.now() - (last.t + intervalMs)) / 60_000)
    : NaN;

  return {
    change1hPct, change6hPct, compressionRatio, volumeMultiple,
    breakoutDistancePct, oiChangePct, priorHigh,
    lastClose: last?.close ?? NaN,
    dataAgeMinutes,
    intervalMs,
    candleCount: n,
  };
}

/* ------------------------------------------------------------------ */
/* 評分                                                                */
/* ------------------------------------------------------------------ */

/**
 * 完成度分數：衡量「壓縮 + 溫和放量 + OI 增加 + 貼近突破點」的成熟度。
 *
 * 這個分數不是勝率，也不是報酬預期。畫面上必須同時顯示就緒度與阻擋原因。
 */
export function computeScore(m) {
  const parts = [];
  const add = (weight, value) => { if (Number.isFinite(value)) parts.push({ weight, value: Math.max(0, Math.min(1, value)) }); };

  // 壓縮越緊越高分：0.5 以下滿分，1.2 以上零分
  add(30, (1.2 - m.compressionRatio) / 0.7);
  // 量能溫和放大最理想落在 1.1~3；過低或暴衝都扣分
  if (Number.isFinite(m.volumeMultiple)) {
    const v = m.volumeMultiple;
    const volScore = v < 1 ? v * 0.5 : v <= 2 ? 1 : v <= 3 ? 1 - (v - 2) * 0.3 : Math.max(0, 0.7 - (v - 3) * 0.35);
    add(25, volScore);
  }
  // 距突破點 0~2% 最理想
  if (Number.isFinite(m.breakoutDistancePct)) {
    const d = m.breakoutDistancePct;
    const distScore = d < -0.8 ? 0 : d <= 2 ? 1 - Math.abs(d - 0.6) / 2.6 : Math.max(0, 1 - (d - 2) / 3);
    add(25, distScore);
  }
  // OI 增加 0.25%~5% 最理想
  if (Number.isFinite(m.oiChangePct)) {
    const o = m.oiChangePct;
    const oiScore = o < 0 ? 0 : o <= 5 ? Math.min(1, o / 2) : Math.max(0, 1 - (o - 5) / 5);
    add(20, oiScore);
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return 0;
  const raw = parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight;
  return Math.round(raw * 100);
}

export function deriveStage(score, m) {
  if (!Number.isFinite(m.breakoutDistancePct)) return 'WATCH';
  if (m.breakoutDistancePct < -BLOWN_OFF.maxBreakoutOvershootPct) return 'EXCLUDED';
  if (score >= ENTRY.minScore && m.breakoutDistancePct <= ENTRY.maxBreakoutDistancePct) return 'NEAR_BREAKOUT';
  if (score >= 60) return 'BUILDING';
  return 'WATCH';
}

export const STAGE_LABEL = Object.freeze({
  NEAR_BREAKOUT: '接近突破',
  BUILDING: '醞釀中',
  WATCH: '觀察',
  EXCLUDED: '已排除',
});

/* ------------------------------------------------------------------ */
/* 閘門                                                                */
/* ------------------------------------------------------------------ */

const pctFmt = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '無資料');
const mulFmt = (v) => (Number.isFinite(v) ? `${v.toFixed(3)} 倍` : '無資料');
const numFmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : '無資料');

const inR = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

/** 十道進場閘門。任一項讀不到值即判定未通過。 */
export function evaluateEntryGates(c) {
  const g = (id, label, passed, actualText, requirement) => ({
    id, label, passed, actualText, requirement,
    reason: passed ? null : `${label} ${actualText}（需 ${requirement}）`,
  });

  const gates = [
    g('score', '分數', Number.isFinite(c.score) && c.score >= ENTRY.minScore,
      Number.isFinite(c.score) ? `${c.score} 分` : '無資料', `≥ ${ENTRY.minScore} 分`),
    g('stage', '等級', c.stage === 'NEAR_BREAKOUT', STAGE_LABEL[c.stage] ?? '無資料', '接近突破'),
    g('breakout', '距突破點', inR(c.breakoutDistancePct, ENTRY.minBreakoutDistancePct, ENTRY.maxBreakoutDistancePct),
      pctFmt(c.breakoutDistancePct), `${ENTRY.minBreakoutDistancePct}% ～ ${ENTRY.maxBreakoutDistancePct}%`),
    g('compression', '15m 壓縮比', Number.isFinite(c.compressionRatio) && c.compressionRatio <= ENTRY.maxCompressionRatio,
      numFmt(c.compressionRatio), `≤ ${ENTRY.maxCompressionRatio}`),
    g('volume', '量能', inR(c.volumeMultiple, ENTRY.minVolumeMultiple, ENTRY.maxVolumeMultiple),
      mulFmt(c.volumeMultiple), `${ENTRY.minVolumeMultiple} ～ ${ENTRY.maxVolumeMultiple} 倍`),
    g('oi', 'OI 變化', inR(c.oiChangePct, ENTRY.minOiChangePct, ENTRY.maxOiChangePct),
      pctFmt(c.oiChangePct), `${ENTRY.minOiChangePct}% ～ ${ENTRY.maxOiChangePct}%`),
    g('change1h', '1H 漲跌', inR(c.change1hPct, ENTRY.minChange1hPct, ENTRY.maxChange1hPct),
      pctFmt(c.change1hPct), `${ENTRY.minChange1hPct}% ～ ${ENTRY.maxChange1hPct}%`),
    g('change6h', '6H 漲跌', inR(c.change6hPct, ENTRY.minChange6hPct, ENTRY.maxChange6hPct),
      pctFmt(c.change6hPct), `${ENTRY.minChange6hPct}% ～ ${ENTRY.maxChange6hPct}%`),
    g('risk', '風險標記', (c.riskFlags ?? []).length === 0,
      (c.riskFlags ?? []).length ? `${c.riskFlags.length} 項` : '無', '無風險標記'),
    g('fresh', '資料年齡', Number.isFinite(c.dataAgeMinutes) && c.dataAgeMinutes <= ENTRY.maxDataAgeMinutes,
      Number.isFinite(c.dataAgeMinutes) ? `${Math.round(c.dataAgeMinutes)} 分鐘` : '無資料',
      `≤ ${ENTRY.maxDataAgeMinutes} 分鐘`),
  ];

  const failed = gates.filter((x) => !x.passed);
  return {
    gates,
    ready: failed.length === 0,
    reasons: failed.map((x) => x.reason),
    readiness: { passed: gates.length - failed.length, total: gates.length },
  };
}

/** 已經噴出的直接排除 */
export function blownOffReasons(c) {
  const out = [];
  if (c.change24hPct > BLOWN_OFF.maxChange24hPct) out.push(`24H 漲幅 ${pctFmt(c.change24hPct)} 已超過 ${BLOWN_OFF.maxChange24hPct}%`);
  if (c.change1hPct > BLOWN_OFF.maxChange1hPct) out.push(`1H 漲幅 ${pctFmt(c.change1hPct)} 已超過 ${BLOWN_OFF.maxChange1hPct}%`);
  if (c.change6hPct > BLOWN_OFF.maxChange6hPct) out.push(`6H 漲幅 ${pctFmt(c.change6hPct)} 已超過 ${BLOWN_OFF.maxChange6hPct}%`);
  if (c.breakoutDistancePct < -BLOWN_OFF.maxBreakoutOvershootPct) out.push(`已突破前高 ${Math.abs(c.breakoutDistancePct).toFixed(2)}%`);
  if (c.volumeMultiple > BLOWN_OFF.maxVolumeMultiple) out.push(`量能 ${mulFmt(c.volumeMultiple)} 已暴衝`);
  if (c.breakoutDistancePct > BLOWN_OFF.maxBreakoutDistancePct) out.push(`距突破點仍有 ${pctFmt(c.breakoutDistancePct)}`);
  if (c.compressionRatio > BLOWN_OFF.maxCompressionRatio) out.push(`壓縮比 ${numFmt(c.compressionRatio)} 過大`);
  if (Math.abs(c.fundingRatePct) > BLOWN_OFF.maxAbsFundingRatePct) out.push(`資金費率 ${c.fundingRatePct.toFixed(4)}% 過度極端`);
  return out;
}

/* ------------------------------------------------------------------ */
/* TP／SL 與盤口深度                                                    */
/* ------------------------------------------------------------------ */

/** SL 取「近期低點再退一點」與固定百分比之中較保守者 */
/**
 * 建議停損：以近期擺動低點再退 0.2% 為基準，
 * 並把風險寬度夾在現價的 0.5%～2.5% 之間。
 *
 * 太緊會被雜訊掃掉，太寬會讓 1.5R 的 TP1 距離失真。
 * 取不到 K 線時退回固定 1.5%。
 */
export function suggestStop(lastClose, klines) {
  if (!Number.isFinite(lastClose) || lastClose <= 0) return NaN;

  const MIN_RISK_PCT = 0.5;
  const MAX_RISK_PCT = 2.5;

  const lows = (klines ?? []).slice(-12).map((k) => k.low).filter(Number.isFinite);
  const swingLow = lows.length ? Math.min(...lows) : NaN;
  const structural = Number.isFinite(swingLow) ? swingLow * 0.998 : lastClose * 0.985;

  const riskPct = ((lastClose - structural) / lastClose) * 100;
  const clamped = Math.min(MAX_RISK_PCT, Math.max(MIN_RISK_PCT, riskPct));
  return lastClose * (1 - clamped / 100);
}

export function buildTargets(entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  return { riskPerUnit: risk, takeProfit1: entry + risk * 1.5, takeProfit2: entry + risk * 2.5 };
}

export function parseOrderbook(result) {
  const toLevels = (rows) => (rows ?? [])
    .map(([p, s]) => ({ price: num(p), size: num(s) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0);
  return {
    bids: toLevels(result?.b).sort((a, b) => b.price - a.price),
    asks: toLevels(result?.a).sort((a, b) => a.price - b.price),
  };
}

export function assessDepth(book, bandPct = 0.3) {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    return { mid: NaN, bidUsd: 0, askUsd: 0, thinnerSideUsd: 0 };
  }
  const mid = (bestBid + bestAsk) / 2;
  const EPS = 1e-9;
  const lower = mid * (1 - bandPct / 100) * (1 - EPS);
  const upper = mid * (1 + bandPct / 100) * (1 + EPS);
  const bidUsd = book.bids.filter((l) => l.price >= lower).reduce((s, l) => s + l.price * l.size, 0);
  const askUsd = book.asks.filter((l) => l.price <= upper).reduce((s, l) => s + l.price * l.size, 0);
  return { mid, bidUsd, askUsd, thinnerSideUsd: Math.min(bidUsd, askUsd) };
}

export function maxTolerablePositionUsd(thinnerSideUsd, participationPct = 10) {
  if (!Number.isFinite(thinnerSideUsd) || thinnerSideUsd <= 0) return 0;
  return thinnerSideUsd * (participationPct / 100);
}

/* ------------------------------------------------------------------ */
/* 候選組裝                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把宇宙資料 + K 線 + OI + 盤口 組成一個候選。
 * autoTradeEligible 永遠是 false —— 本工具不下單。
 */
export function buildCandidate(row, klines, oiSeries, orderbook) {
  const m = computeMetrics(klines, oiSeries);
  const score = computeScore(m);
  const stage = deriveStage(score, m);
  const meme = classifyMeme(row.symbol, row.listedDays, row.turnover24hUsd, row.openInterestUsd);

  const c = {
    symbol: row.symbol,
    provider: PROVIDER,
    lastPrice: row.lastPrice,
    score,
    stage,
    change24hPct: row.change24hPct,
    fundingRatePct: row.fundingRatePct,
    turnover24hUsd: row.turnover24hUsd,
    openInterestUsd: row.openInterestUsd,
    listedDays: row.listedDays,
    spreadPct: row.spreadPct,
    ...m,
    riskFlags: [],
    isMeme: meme.isMeme,
    memeReasons: meme.reasons,
    memeConfidence: meme.confidence,
    autoTradeEligible: false,
  };

  const blown = blownOffReasons(c);
  const ev = evaluateEntryGates(c);
  const entryReady = ev.ready && blown.length === 0;

  const stop = entryReady ? suggestStop(m.lastClose, klines) : NaN;
  const targets = entryReady ? buildTargets(m.lastClose, stop) : null;

  const depth = orderbook ? assessDepth(orderbook) : null;
  const maxPositionUsd = depth ? maxTolerablePositionUsd(depth.thinnerSideUsd) : 0;

  return {
    ...c,
    stage: blown.length ? 'EXCLUDED' : stage,
    entryReady,
    entryLow: entryReady && targets ? m.lastClose - targets.riskPerUnit * 0.15 : null,
    entryHigh: entryReady ? m.lastClose : null,
    stopLoss: entryReady && targets ? stop : null,
    takeProfit1: targets?.takeProfit1 ?? null,
    takeProfit2: targets?.takeProfit2 ?? null,
    riskPerUnit: targets?.riskPerUnit ?? null,
    gates: ev.gates,
    readiness: ev.readiness,
    blockingReasons: [...blown, ...ev.reasons],
    staleWarning: Number.isFinite(m.dataAgeMinutes) && m.dataAgeMinutes > ENTRY.staleWarningMinutes,
    depthUsd: depth ? depth.thinnerSideUsd : null,
    maxPositionUsd,
    suggestedRiskPercent: meme.isMeme ? MEME_FIXED_RISK_PERCENT : null,
    riskLabel: riskLabel(meme),
    group: coinGroup(row.symbol, meme.isMeme),
    bybitUrl: bybitContractUrl(row.symbol),
  };
}

export function rankCandidates(candidates) {
  return [...candidates]
    .sort((a, b) => {
      if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, MAX_DISPLAYED);
}

/** 不變量：任何情況下都不得出現「可進場卻缺保護」或「可自動下單」 */
export function checkInvariants(c) {
  const v = [];
  if (c.autoTradeEligible !== false) v.push('autoTradeEligible 必須永遠是 false');
  if (c.entryReady && c.blockingReasons.length) v.push('entryReady 為 true 但仍有阻擋原因');
  if (c.entryReady && (c.stopLoss === null || c.takeProfit1 === null || c.takeProfit2 === null)) {
    v.push('entryReady 為 true 但缺少 SL 或 TP');
  }
  if (!c.entryReady && (c.stopLoss !== null || c.takeProfit1 !== null)) v.push('未就緒卻帶出 SL 或 TP');
  if (c.stage === 'EXCLUDED' && c.entryReady) v.push('已排除卻標記為可進場');
  if (!/^https:\/\/www\.bybit\.com\//.test(c.bybitUrl)) v.push('連結未指向 Bybit');
  return v;
}

/**
 * 依分組拆開候選，各組內部都是「可進場的排前面，其餘依分數」。
 * 主幣不套用 MAX_DISPLAYED 上限：觀察清單有幾檔就顯示幾檔。
 */
export function splitByGroup(candidates) {
  const sortFn = (a, b) => {
    if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
    return b.score - a.score;
  };
  const list = candidates ?? [];
  return {
    main: list.filter((c) => c.group === 'main').sort(sortFn),
    meme: list.filter((c) => c.group === 'meme').sort(sortFn).slice(0, MAX_DISPLAYED),
  };
}
