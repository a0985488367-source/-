/**
 * moonshot-entry-gates — Guardian v10 早期快噴掃描的篩選與進場閘門
 *
 * 對應交接規格第四節。與主幣訊號是兩套完全獨立的功能，
 * 門檻刻意各自定義，不共用常數。
 *
 * 產品硬性限制（交接規格三.3）：
 *   快噴幣區只供研究與觀察，autoTradeEligible 永遠是 false。
 *   本模組以字面型別 `false` 鎖死該欄位，型別層就無法被改成 true。
 *
 * 資料來源必須是 Bybit（交接規格三.1、十）：
 *   /v5/market/instruments-info、/v5/market/tickers、
 *   /v5/market/kline、/v5/market/open-interest。
 *   不得使用 DEX 資料再改名為 Bybit，連結也必須指向 Bybit 合約頁。
 */

import {
  absAtMost,
  atMost,
  evaluateGates,
  fmt,
  inRange,
  type GateEvaluation,
  type GateResult,
  type GateSpec,
} from './gate-kit.ts';

export const MOONSHOT_PROVIDER = 'Bybit Pre-Breakout' as const;

export type MoonshotStage = 'NEAR_BREAKOUT' | 'BUILDING' | 'WATCH' | 'EXCLUDED';

/** 第一階段宇宙篩選門檻（交接規格四） */
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

/** 直接排除「已經噴出」的門檻（交接規格四） */
export const BLOWN_OFF = Object.freeze({
  maxChange24hPct: 10,
  maxChange1hPct: 4,
  maxChange6hPct: 10,
  /** 已突破前高超過此百分比即排除 */
  maxBreakoutOvershootPct: 0.8,
  maxVolumeMultiple: 5,
  /** 距突破點仍超過此百分比即排除（太遠，還不是機會） */
  maxBreakoutDistancePct: 4,
  maxCompressionRatio: 1.2,
  maxAbsFundingRatePct: 0.15,
});

/** 條件式 Entry 門檻（交接規格四，十項條件） */
export const ENTRY = Object.freeze({
  minScore: 80,
  requiredStage: 'NEAR_BREAKOUT' as MoonshotStage,
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
  /** 交接規格的硬門檻 */
  maxDataAgeMinutes: 45,
  /**
   * 建議的較嚴門檻。Guardian cron 是五分鐘一次、Discord watchdog 十分鐘告警，
   * 資料一旦超過這個年齡，watchdog 其實已經在叫了，卡片不該再看起來像即時的。
   * 超過此值只發出 warning，不擋進場，維持與既有規格一致的行為。
   */
  staleWarningMinutes: 15,
});

export const MAX_DISPLAYED_CANDIDATES = 8;

export interface MoonshotMetrics {
  symbol: string;
  /** 合約類型，必須是 Bybit USDT 線性永續 */
  contractType: string;
  quoteCoin: string;
  category: string;
  turnover24hUsd: number;
  openInterestUsd: number;
  listedHours: number;
  spreadPct: number;
  change24hPct: number;
  change1hPct: number;
  change6hPct: number;
  rangePosition24h: number;
  /**
   * 距突破點百分比。
   * 正值 = 價格仍在突破點下方多少 %；負值 = 已經突破多少 %。
   */
  breakoutDistancePct: number;
  /** 15m 波動壓縮比，越小代表壓得越緊 */
  compressionRatio: number;
  /** 近期量能相對基準的放大倍率 */
  volumeMultiple: number;
  /** 未平倉量變化百分比 */
  oiChangePct: number;
  /** 資金費率，百分比 */
  fundingRatePct: number;
  /** 買賣盤比例 */
  bidAskRatio?: number;
  score: number;
  stage: MoonshotStage;
  riskFlags?: readonly string[];
  dataAgeMinutes: number;
  /** 建議 Entry 與 SL；由掃描器計算 */
  suggestedEntry: number;
  suggestedStop: number;
}

export interface MoonshotCandidate {
  symbol: string;
  provider: typeof MOONSHOT_PROVIDER;
  stage: MoonshotStage;
  score: number;
  /** 型別層鎖死：快噴候選永遠不進自動交易 */
  autoTradeEligible: false;
  /** 全部十道閘門通過才顯示條件式 Entry */
  entryReady: boolean;
  entryZone: { low: number; high: number } | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskPerUnit: number | null;
  breakoutDistancePct: number;
  compressionRatio: number;
  volumeMultiple: number;
  oiChangePct: number;
  fundingRatePct: number;
  dataAgeMinutes: number;
  bybitUrl: string;
  gates: GateResult[];
  blockingReasons: string[];
  warnings: string[];
  readiness: { passed: number; total: number };
}

/* ------------------------------------------------------------------ */
/* 第一階段：宇宙篩選                                                   */
/* ------------------------------------------------------------------ */

const STABLECOIN_BASES = new Set([
  'USDC', 'USDT', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'PYUSD', 'BUSD', 'USDD', 'EURT', 'EURS',
]);

const NON_CRYPTO_CATEGORIES = new Set([
  'commodities', 'commodity', 'stocks', 'stock', 'equity', 'equities', 'forex', 'fx', 'index',
]);

export function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/i, '').replace(/^(1000000|10000|1000)/, '');
}

/** 只接受 Bybit USDT 線性永續合約，排除商品／股票／外匯／穩定幣 */
export function passesUniverseFilter(m: MoonshotMetrics): boolean {
  if (!/^linear$/i.test(m.contractType)) return false;
  if (!/^USDT$/i.test(m.quoteCoin)) return false;
  if (NON_CRYPTO_CATEGORIES.has((m.category ?? '').toLowerCase())) return false;
  if (STABLECOIN_BASES.has(baseOf(m.symbol).toUpperCase())) return false;

  return (
    Number.isFinite(m.turnover24hUsd) && m.turnover24hUsd >= UNIVERSE.minTurnover24hUsd &&
    Number.isFinite(m.openInterestUsd) && m.openInterestUsd >= UNIVERSE.minOpenInterestUsd &&
    Number.isFinite(m.listedHours) &&
    m.listedHours >= UNIVERSE.minListedHours && m.listedHours <= UNIVERSE.maxListedHours &&
    Number.isFinite(m.spreadPct) && m.spreadPct <= UNIVERSE.maxSpreadPct &&
    Number.isFinite(m.change24hPct) &&
    m.change24hPct >= UNIVERSE.minChange24hPct && m.change24hPct <= UNIVERSE.maxChange24hPct &&
    Number.isFinite(m.rangePosition24h) &&
    m.rangePosition24h >= UNIVERSE.minRangePosition && m.rangePosition24h <= UNIVERSE.maxRangePosition
  );
}

/**
 * 已經噴出的直接排除。回傳排除原因；空陣列代表沒有被排除。
 */
export function blownOffReasons(m: MoonshotMetrics): string[] {
  const out: string[] = [];
  if (m.change24hPct > BLOWN_OFF.maxChange24hPct) out.push(`24H 漲幅 ${m.change24hPct.toFixed(2)}% 已超過 ${BLOWN_OFF.maxChange24hPct}%`);
  if (m.change1hPct > BLOWN_OFF.maxChange1hPct) out.push(`1H 漲幅 ${m.change1hPct.toFixed(2)}% 已超過 ${BLOWN_OFF.maxChange1hPct}%`);
  if (m.change6hPct > BLOWN_OFF.maxChange6hPct) out.push(`6H 漲幅 ${m.change6hPct.toFixed(2)}% 已超過 ${BLOWN_OFF.maxChange6hPct}%`);
  if (m.breakoutDistancePct < -BLOWN_OFF.maxBreakoutOvershootPct) {
    out.push(`已突破前高 ${Math.abs(m.breakoutDistancePct).toFixed(2)}%，超過 ${BLOWN_OFF.maxBreakoutOvershootPct}%`);
  }
  if (m.volumeMultiple > BLOWN_OFF.maxVolumeMultiple) out.push(`量能 ${m.volumeMultiple.toFixed(2)} 倍已暴衝，超過 ${BLOWN_OFF.maxVolumeMultiple} 倍`);
  if (m.breakoutDistancePct > BLOWN_OFF.maxBreakoutDistancePct) {
    out.push(`距突破點仍有 ${m.breakoutDistancePct.toFixed(2)}%，超過 ${BLOWN_OFF.maxBreakoutDistancePct}%`);
  }
  if (m.compressionRatio > BLOWN_OFF.maxCompressionRatio) out.push(`壓縮比 ${m.compressionRatio.toFixed(2)} 超過 ${BLOWN_OFF.maxCompressionRatio}`);
  if (Math.abs(m.fundingRatePct) > BLOWN_OFF.maxAbsFundingRatePct) {
    out.push(`資金費率 ${m.fundingRatePct.toFixed(4)}% 過度極端`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 條件式 Entry 的十道閘門                                              */
/* ------------------------------------------------------------------ */

const MOONSHOT_GATES: readonly GateSpec<MoonshotMetrics>[] = [
  {
    id: 'score',
    label: '分數',
    requirement: `≥ ${ENTRY.minScore} 分`,
    read: (m) => m.score,
    test: (v) => typeof v === 'number' && Number.isFinite(v) && v >= ENTRY.minScore,
    format: fmt.score,
  },
  {
    id: 'stage',
    label: '等級',
    requirement: '接近突破',
    read: (m) => m.stage,
    test: (v) => v === ENTRY.requiredStage,
    format: (v) => (v === 'NEAR_BREAKOUT' ? '接近突破' : v === 'BUILDING' ? '醞釀中' : v === 'WATCH' ? '觀察' : '已排除'),
  },
  {
    id: 'breakout-distance',
    label: '距突破點',
    requirement: `${ENTRY.minBreakoutDistancePct}% ～ ${ENTRY.maxBreakoutDistancePct}%`,
    read: (m) => m.breakoutDistancePct,
    test: inRange(ENTRY.minBreakoutDistancePct, ENTRY.maxBreakoutDistancePct),
    format: fmt.pct,
  },
  {
    id: 'compression',
    label: '15m 壓縮比',
    requirement: `≤ ${ENTRY.maxCompressionRatio}`,
    read: (m) => m.compressionRatio,
    test: atMost(ENTRY.maxCompressionRatio),
    format: (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '無資料'),
  },
  {
    id: 'volume',
    label: '量能',
    requirement: `${ENTRY.minVolumeMultiple} ～ ${ENTRY.maxVolumeMultiple} 倍`,
    read: (m) => m.volumeMultiple,
    test: inRange(ENTRY.minVolumeMultiple, ENTRY.maxVolumeMultiple),
    format: fmt.multiple,
  },
  {
    id: 'oi-change',
    label: 'OI 變化',
    requirement: `${ENTRY.minOiChangePct}% ～ ${ENTRY.maxOiChangePct}%`,
    read: (m) => m.oiChangePct,
    test: inRange(ENTRY.minOiChangePct, ENTRY.maxOiChangePct),
    format: fmt.pct,
  },
  {
    id: 'change-1h',
    label: '1H 漲跌',
    requirement: `${ENTRY.minChange1hPct}% ～ ${ENTRY.maxChange1hPct}%`,
    read: (m) => m.change1hPct,
    test: inRange(ENTRY.minChange1hPct, ENTRY.maxChange1hPct),
    format: fmt.pct,
  },
  {
    id: 'change-6h',
    label: '6H 漲跌',
    requirement: `${ENTRY.minChange6hPct}% ～ ${ENTRY.maxChange6hPct}%`,
    read: (m) => m.change6hPct,
    test: inRange(ENTRY.minChange6hPct, ENTRY.maxChange6hPct),
    format: fmt.pct,
  },
  {
    id: 'no-risk-flags',
    label: '風險標記',
    requirement: '無風險標記',
    read: (m) => (m.riskFlags ?? []).length,
    test: (v) => v === 0,
    format: (v) => (v === 0 ? '無' : `${String(v)} 項`),
  },
  {
    id: 'data-fresh',
    label: '資料年齡',
    requirement: `≤ ${ENTRY.maxDataAgeMinutes} 分鐘`,
    read: (m) => m.dataAgeMinutes,
    test: atMost(ENTRY.maxDataAgeMinutes),
    format: fmt.minutes,
  },
  {
    id: 'data-recent-advisory',
    label: '資料新鮮度',
    severity: 'warning',
    requirement: `≤ ${ENTRY.staleWarningMinutes} 分鐘`,
    read: (m) => m.dataAgeMinutes,
    test: atMost(ENTRY.staleWarningMinutes),
    format: fmt.minutes,
  },
];

/* ------------------------------------------------------------------ */
/* TP／SL 計算                                                          */
/* ------------------------------------------------------------------ */

export interface Targets {
  riskPerUnit: number;
  takeProfit1: number;
  takeProfit2: number;
}

/**
 * TP1 = 1.5R、TP2 = 2.5R（交接規格四）。
 * 風險為零或方向不合理時回傳 null，不硬算。
 */
export function buildTargets(entry: number, stop: number, side: 'long' | 'short' = 'long'): Targets | null {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const risk = side === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const dir = side === 'long' ? 1 : -1;
  return {
    riskPerUnit: risk,
    takeProfit1: entry + dir * risk * 1.5,
    takeProfit2: entry + dir * risk * 2.5,
  };
}

/** Bybit 合約頁連結。絕對不可指向 DEX Screener 或任何非 Bybit 來源。 */
export function bybitContractUrl(symbol: string): string {
  return `https://www.bybit.com/trade/usdt/${encodeURIComponent(symbol.toUpperCase())}`;
}

/* ------------------------------------------------------------------ */
/* 候選建構                                                             */
/* ------------------------------------------------------------------ */

/**
 * 由指標建出一個快噴候選。
 *
 * 只有在十道 blocking 閘門全過、且沒有被「已噴出」規則排除時，
 * 才會帶上 Entry 區／SL／TP。否則 entryReady=false 且 Entry 欄位為 null，
 * 畫面只顯示觀察資訊與阻擋原因。
 */
export function buildMoonshotCandidate(m: MoonshotMetrics): MoonshotCandidate {
  const blown = blownOffReasons(m);
  const evaluation: GateEvaluation = evaluateGates(MOONSHOT_GATES, m);
  const entryReady = evaluation.ready && blown.length === 0;

  const targets = entryReady ? buildTargets(m.suggestedEntry, m.suggestedStop, 'long') : null;
  const entryZone =
    entryReady && targets
      ? { low: Math.min(m.suggestedEntry, m.suggestedStop + targets.riskPerUnit * 0.85), high: m.suggestedEntry }
      : null;

  return {
    symbol: m.symbol,
    provider: MOONSHOT_PROVIDER,
    stage: blown.length > 0 ? 'EXCLUDED' : m.stage,
    score: Math.round(m.score),
    autoTradeEligible: false,
    entryReady,
    entryZone,
    stopLoss: entryReady ? m.suggestedStop : null,
    takeProfit1: targets?.takeProfit1 ?? null,
    takeProfit2: targets?.takeProfit2 ?? null,
    riskPerUnit: targets?.riskPerUnit ?? null,
    breakoutDistancePct: m.breakoutDistancePct,
    compressionRatio: m.compressionRatio,
    volumeMultiple: m.volumeMultiple,
    oiChangePct: m.oiChangePct,
    fundingRatePct: m.fundingRatePct,
    dataAgeMinutes: m.dataAgeMinutes,
    bybitUrl: bybitContractUrl(m.symbol),
    gates: evaluation.gates,
    blockingReasons: [...blown, ...evaluation.reasons],
    warnings: evaluation.warnings.map((w) => w.reason as string),
    readiness: evaluation.readiness,
  };
}

/**
 * 完整掃描流程：宇宙篩選 → 取前 12 詳細分析 → 建候選 → 最多顯示 8 個。
 * 排序讓可進場的排前面，其餘依分數。
 */
export function scanMoonshots(metrics: readonly MoonshotMetrics[]): MoonshotCandidate[] {
  const universe = metrics.filter(passesUniverseFilter);
  const detailed = [...universe]
    .sort((a, b) => b.score - a.score)
    .slice(0, UNIVERSE.maxDetailedAnalysis);

  return detailed
    .map(buildMoonshotCandidate)
    .sort((a, b) => {
      if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, MAX_DISPLAYED_CANDIDATES);
}

/** 不變量自檢，供測試與執行期斷言使用 */
export function checkMoonshotInvariants(c: MoonshotCandidate): string[] {
  const v: string[] = [];
  if ((c as { autoTradeEligible: boolean }).autoTradeEligible !== false) {
    v.push('快噴候選的 autoTradeEligible 必須永遠是 false');
  }
  if (c.entryReady && c.blockingReasons.length > 0) v.push('entryReady 為 true 但仍有阻擋原因');
  if (c.entryReady && (c.stopLoss === null || c.takeProfit1 === null || c.takeProfit2 === null)) {
    v.push('entryReady 為 true 但缺少 SL 或 TP');
  }
  if (!c.entryReady && (c.entryZone !== null || c.stopLoss !== null)) {
    v.push('未就緒卻帶出 Entry 或 SL');
  }
  if (c.stage === 'EXCLUDED' && c.entryReady) v.push('已排除卻標記為可進場');
  if (!/^https:\/\/www\.bybit\.com\//.test(c.bybitUrl)) v.push('合約連結未指向 Bybit');
  return v;
}
