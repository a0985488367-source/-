/**
 * meme-classifier — 迷因幣判定與倉位風控
 *
 * 對應交接規格第六節。
 *
 * 舊行為的問題：迷因幣清單是硬編碼的七個代號。新的迷因幣每個月都在上架，
 * 一旦漏掉，高分就可能替它放大倉位 —— 這正是交接規格第十節
 * 「不得因 90 分就替 PEPE 等迷因幣加碼」要防的事。
 *
 * 本模組在既有白名單外加一層啟發式，並且刻意讓失效方向偏保守：
 *   判斷不出來 → 當作迷因幣 → 降倉。絕不反過來。
 */

/** 交接規格明列的迷因幣，不論分數多高一律固定防守倉 */
export const EXPLICIT_MEME_BASES: readonly string[] = Object.freeze([
  'PEPE', 'DOGE', 'SHIB', 'WIF', 'BONK', 'FLOKI', 'TRUMP',
]);

/** 確定不是迷因幣的主流標的 */
export const MAJOR_BASES: readonly string[] = Object.freeze([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT',
  'ATOM', 'ARB', 'OP', 'MATIC', 'TON', 'TRX', 'NEAR', 'APT', 'SUI', 'INJ',
  'FIL', 'ETC', 'BCH', 'UNI', 'AAVE', 'XLM', 'ICP', 'HBAR', 'VET', 'ALGO',
]);

/** 預設自動下單白名單（交接規格六） */
export const DEFAULT_AUTO_TRADE_WHITELIST: readonly string[] = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT',
]);

export const MEME_FIXED_RISK_PERCENT = 0.15;

/** 上線未滿此天數，在沒有其他證據時視為高風險新標的 */
export const NEW_LISTING_DAYS = 180;

/** 成交額對未平倉值的比值超過此倍數，屬於典型的短線投機結構 */
export const SPECULATIVE_TURNOVER_OI_RATIO = 8;

export type MemeConfidence = 'high' | 'medium' | 'low';

export interface MemeClassification {
  isMeme: boolean;
  confidence: MemeConfidence;
  reasons: string[];
}

export interface MemeClassifyInput {
  symbol: string;
  listedDays?: number;
  turnover24hUsd?: number;
  openInterestUsd?: number;
}

/** 去掉 USDT 後綴與 1000／10000／1000000 面額前綴 */
export function normalizeBase(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/USDT$/,'')
    .replace(/^(1000000|10000|1000)/, '');
}

export function hasMultiplierPrefix(symbol: string): boolean {
  return /^(1000000|10000|1000)[A-Z]/.test(symbol.toUpperCase());
}

/**
 * 迷因幣判定。
 * 順序重要：明確清單與主流清單優先，其餘走啟發式，
 * 全部落空時回傳 isMeme=true（fail-safe 偏保守）。
 */
export function classifyMeme(input: MemeClassifyInput): MemeClassification {
  const base = normalizeBase(input.symbol);
  const reasons: string[] = [];

  if (EXPLICIT_MEME_BASES.includes(base)) {
    return { isMeme: true, confidence: 'high', reasons: [`${base} 在明確迷因幣清單內`] };
  }
  if (MAJOR_BASES.includes(base)) {
    return { isMeme: false, confidence: 'high', reasons: [`${base} 在主流標的清單內`] };
  }

  if (hasMultiplierPrefix(input.symbol)) {
    reasons.push('合約帶有 1000／10000 面額前綴，屬於極低單價標的');
  }
  if (typeof input.listedDays === 'number' && Number.isFinite(input.listedDays) && input.listedDays < NEW_LISTING_DAYS) {
    reasons.push(`上線僅 ${Math.round(input.listedDays)} 天，未滿 ${NEW_LISTING_DAYS} 天`);
  }
  if (
    typeof input.turnover24hUsd === 'number' && typeof input.openInterestUsd === 'number' &&
    Number.isFinite(input.turnover24hUsd) && Number.isFinite(input.openInterestUsd) &&
    input.openInterestUsd > 0 &&
    input.turnover24hUsd / input.openInterestUsd > SPECULATIVE_TURNOVER_OI_RATIO
  ) {
    const ratio = input.turnover24hUsd / input.openInterestUsd;
    reasons.push(`成交額為未平倉值的 ${ratio.toFixed(1)} 倍，短線投機結構明顯`);
  }

  if (reasons.length >= 2) return { isMeme: true, confidence: 'medium', reasons };
  if (reasons.length === 1) return { isMeme: true, confidence: 'low', reasons };

  return {
    isMeme: true,
    confidence: 'low',
    reasons: [`${base} 不在已知主流清單內，依保守原則以迷因幣風控處理`],
  };
}

/* ------------------------------------------------------------------ */
/* 本機推薦倉位（交接規格六）                                            */
/* ------------------------------------------------------------------ */

export interface LocalSizingInput {
  symbol: string;
  grade: string;
  score: number;
  isMeme: boolean;
  consecutiveLosses?: number;
  /** performance-learning 每十筆檢討判定偏弱 */
  learningWeak?: boolean;
}

export interface LocalSizingResult {
  riskPercent: number;
  tier: '觀察倉' | '輕倉' | '標準倉' | '加強倉' | '防守倉';
  reason: string;
  /** 因連虧或學習檢討而套用的降倉係數 */
  reductionFactor: number;
}

/**
 * 本機推薦倉位。
 *
 * 迷因幣在任何分數下都固定 0.15% 防守倉，不會走到加強倉分支。
 */
export function localRiskPercent(input: LocalSizingInput): LocalSizingResult {
  let base: number;
  let tier: LocalSizingResult['tier'];
  let reason: string;

  if (input.isMeme) {
    base = MEME_FIXED_RISK_PERCENT;
    tier = '防守倉';
    reason = '迷因幣固定防守倉，不因分數提高倉位';
  } else if (input.grade !== 'A') {
    base = 0.10;
    tier = '觀察倉';
    reason = '非 A 級訊號';
  } else if (input.score < 85) {
    base = 0.15;
    tier = '輕倉';
    reason = 'A 級但未達 85 分';
  } else if (input.score <= 89) {
    base = 0.25;
    tier = '標準倉';
    reason = 'A 級 85～89 分';
  } else {
    base = 0.30;
    tier = '加強倉';
    reason = '非迷因幣 A 級 90 分以上';
  }

  // 連虧與學習檢討偏弱時繼續降倉
  const losses = Math.max(0, Math.floor(input.consecutiveLosses ?? 0));
  let reductionFactor = 1;
  if (losses >= 2) reductionFactor *= Math.max(0.4, 1 - 0.2 * (losses - 1));
  if (input.learningWeak) reductionFactor *= 0.75;

  const riskPercent = Math.round(base * reductionFactor * 10000) / 10000;
  const notes: string[] = [reason];
  if (losses >= 2) notes.push(`連續 ${losses} 筆虧損，降倉`);
  if (input.learningWeak) notes.push('學習檢討偏弱，降倉');

  return { riskPercent, tier, reason: notes.join('；'), reductionFactor };
}

/* ------------------------------------------------------------------ */
/* 雲端品質倍率（交接規格六）                                            */
/* ------------------------------------------------------------------ */

export const CLOUD_MULTIPLIER = Object.freeze({
  memeRiskMultiplier: 0.6,
  maxNonMemeStrongMultiplier: 1.2,
  floor: 0.5,
  ceiling: 1.4,
});

export interface CloudQualityInput {
  isMeme: boolean;
  /** 掃描器認定的強訊號 */
  strongSignal: boolean;
  /** 是否被評為 A+ 加碼 */
  aPlus: boolean;
  baseMultiplier?: number;
}

export interface CloudQualityResult {
  multiplier: number;
  aPlusAllowed: boolean;
  notes: string[];
}

/**
 * 雲端品質倍率。
 * 迷因幣不得取得 A+ 加碼，倍率降為標準額度的 60%。
 * 最終倍率一律夾在 0.5～1.4。
 */
export function cloudQualityMultiplier(input: CloudQualityInput): CloudQualityResult {
  const notes: string[] = [];
  let multiplier = Number.isFinite(input.baseMultiplier ?? NaN) ? (input.baseMultiplier as number) : 1;

  const aPlusAllowed = input.aPlus && !input.isMeme;
  if (input.aPlus && input.isMeme) notes.push('迷因幣不得取得 A+ 加碼');

  if (input.isMeme) {
    multiplier *= CLOUD_MULTIPLIER.memeRiskMultiplier;
    notes.push('迷因幣風險倍率降為標準額度的 60%');
  } else if (input.strongSignal) {
    multiplier = Math.min(multiplier * 1.2, CLOUD_MULTIPLIER.maxNonMemeStrongMultiplier);
    notes.push('非迷因幣強訊號，倍率上限 1.2');
  }

  const clamped = Math.min(CLOUD_MULTIPLIER.ceiling, Math.max(CLOUD_MULTIPLIER.floor, multiplier));
  if (clamped !== multiplier) notes.push(`倍率夾至 ${CLOUD_MULTIPLIER.floor}～${CLOUD_MULTIPLIER.ceiling}`);

  return { multiplier: Math.round(clamped * 10000) / 10000, aPlusAllowed, notes };
}

/* ------------------------------------------------------------------ */
/* 相關性上限                                                           */
/* ------------------------------------------------------------------ */

export type CorrelationBucket = 'major' | 'alt-l1' | 'meme' | 'other';

export function correlationBucket(symbol: string, isMeme: boolean): CorrelationBucket {
  const base = normalizeBase(symbol);
  if (isMeme) return 'meme';
  if (['BTC', 'ETH'].includes(base)) return 'major';
  if (MAJOR_BASES.includes(base)) return 'alt-l1';
  return 'other';
}

/**
 * 每個相關性分組最多一個部位。
 * 讓「調高 maxPositions」這件事在結構上就不會變成同一筆多倍槓桿的賭注。
 */
export function allowsNewPosition(
  openPositions: ReadonlyArray<{ symbol: string; isMeme: boolean }>,
  candidate: { symbol: string; isMeme: boolean },
  maxPositions: number,
): { allowed: boolean; reason: string } {
  if (openPositions.length >= maxPositions) {
    return { allowed: false, reason: `已達部位上限 ${maxPositions}` };
  }
  const bucket = correlationBucket(candidate.symbol, candidate.isMeme);
  const clash = openPositions.find((p) => correlationBucket(p.symbol, p.isMeme) === bucket);
  if (clash) {
    return { allowed: false, reason: `相關性分組 ${bucket} 已有部位 ${clash.symbol}` };
  }
  return { allowed: true, reason: '通過部位上限與相關性檢查' };
}
