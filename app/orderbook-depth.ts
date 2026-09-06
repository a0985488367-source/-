/**
 * orderbook-depth — Bybit 盤口深度評估
 *
 * 為什麼需要：
 *   第一階段宇宙篩選只要求未平倉值 ≥ 10 萬美元、買賣價差 ≤ 0.6%。
 *   價差窄不代表吃得動量：10 萬 OI 的合約盤口極薄，
 *   0.15% 風險的倉位可能根本掛不進去，SL 觸發時也會嚴重滑價。
 *
 * 資料來源：Bybit /v5/market/orderbook。
 */

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface NormalizedOrderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

/** Bybit v5 orderbook 回傳的 b／a 是 [價格, 數量] 的字串陣列 */
export interface BybitOrderbookResult {
  b?: Array<[string, string]>;
  a?: Array<[string, string]>;
}

export function parseBybitOrderbook(result: BybitOrderbookResult | null | undefined): NormalizedOrderbook {
  const toLevels = (rows: Array<[string, string]> | undefined): OrderbookLevel[] =>
    (rows ?? [])
      .map(([p, s]) => ({ price: Number(p), size: Number(s) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0);

  return {
    bids: toLevels(result?.b).sort((a, b) => b.price - a.price),
    asks: toLevels(result?.a).sort((a, b) => a.price - b.price),
  };
}

export interface DepthAssessment {
  mid: number | null;
  spreadPct: number | null;
  /** 中價下方 bandPct 內的買盤總額（USDT） */
  bidUsd: number;
  /** 中價上方 bandPct 內的賣盤總額（USDT） */
  askUsd: number;
  /** 兩側較薄的一側；平倉時吃的是這一側 */
  thinnerSideUsd: number;
  bandPct: number;
}

/**
 * 評估中價 ±bandPct 內的可成交金額。
 * 盤口缺一側時該側金額為 0，mid 為 null。
 */
export function assessDepth(book: NormalizedOrderbook, bandPct = 0.3): DepthAssessment {
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadPct = mid !== null && bestBid !== null && bestAsk !== null && mid > 0
    ? ((bestAsk - bestBid) / mid) * 100
    : null;

  if (mid === null) {
    return { mid: null, spreadPct: null, bidUsd: 0, askUsd: 0, thinnerSideUsd: 0, bandPct };
  }

  // 帶緣比較要留浮點容差：mid * (1 + 0.3/100) 在二進位下可能落在 100.29999...，
  // 沒有容差的話，價格剛好等於帶緣的檔位會被誤判為帶外而漏算深度。
  const EPS = 1e-9;
  const lower = mid * (1 - bandPct / 100) * (1 - EPS);
  const upper = mid * (1 + bandPct / 100) * (1 + EPS);

  const bidUsd = book.bids
    .filter((l) => l.price >= lower)
    .reduce((s, l) => s + l.price * l.size, 0);
  const askUsd = book.asks
    .filter((l) => l.price <= upper)
    .reduce((s, l) => s + l.price * l.size, 0);

  return {
    mid,
    spreadPct,
    bidUsd: Math.round(bidUsd * 100) / 100,
    askUsd: Math.round(askUsd * 100) / 100,
    thinnerSideUsd: Math.round(Math.min(bidUsd, askUsd) * 100) / 100,
    bandPct,
  };
}

/**
 * 可承受倉位：只吃走較薄一側的 participationPct%。
 * 預設 10%，代表進出各自不超過帶內深度的十分之一。
 */
export function maxTolerablePositionUsd(thinnerSideUsd: number, participationPct = 10): number {
  if (!Number.isFinite(thinnerSideUsd) || thinnerSideUsd <= 0) return 0;
  return Math.round(thinnerSideUsd * (participationPct / 100) * 100) / 100;
}

export type DepthVerdict = 'ok' | 'tight' | 'too-thin';

export interface DepthCheck {
  verdict: DepthVerdict;
  maxPositionUsd: number;
  message: string;
}

/**
 * 把計畫倉位與盤口深度對照。
 * 深度不明（0）時一律回傳 too-thin，不放行。
 */
export function checkPositionAgainstDepth(
  plannedPositionUsd: number,
  depth: DepthAssessment,
  participationPct = 10,
): DepthCheck {
  const maxPositionUsd = maxTolerablePositionUsd(depth.thinnerSideUsd, participationPct);

  if (maxPositionUsd <= 0) {
    return { verdict: 'too-thin', maxPositionUsd: 0, message: '盤口深度不明或過薄，不建議進場' };
  }
  if (!Number.isFinite(plannedPositionUsd) || plannedPositionUsd <= 0) {
    return { verdict: 'ok', maxPositionUsd, message: `帶內可承受約 ${maxPositionUsd} USDT` };
  }
  if (plannedPositionUsd > maxPositionUsd) {
    return {
      verdict: 'too-thin',
      maxPositionUsd,
      message: `計畫倉位 ${Math.round(plannedPositionUsd)} USDT 超過帶內可承受的 ${maxPositionUsd} USDT`,
    };
  }
  if (plannedPositionUsd > maxPositionUsd * 0.6) {
    return {
      verdict: 'tight',
      maxPositionUsd,
      message: `計畫倉位已佔帶內深度的 ${Math.round((plannedPositionUsd / maxPositionUsd) * 100)}%，滑價風險偏高`,
    };
  }
  return { verdict: 'ok', maxPositionUsd, message: `帶內可承受約 ${maxPositionUsd} USDT` };
}
