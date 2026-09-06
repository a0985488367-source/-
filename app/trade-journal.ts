/**
 * trade-journal — 成交日誌與 Bybit 回查對帳
 *
 * 為什麼存在：
 *   交接規格第五節記載「無法只靠目前雲端紀錄確定那筆 PEPE 虧損的
 *   確切成交價格與滑價」，並明訂不可自行猜測虧損原因。
 *   本模組把每一筆自動交易的決策依據與實際成交結果完整留存，
 *   讓事後追查有據可查，也讓 performance-learning 的每十筆檢討
 *   建立在真實 PnL 上，而不是估計值。
 *
 * 對帳資料一律來自 Bybit：
 *   /v5/position/closed-pnl 與 /v5/execution/list。
 *   任何欄位取不到就標記為 null 並記入 dataGaps，不得填入推測值。
 *
 * 安全性：日誌只保存交易事實。任何 API Key、Secret、Token、Webhook
 *   都不得寫入；assertNoSecrets 會在寫入前擋下含有敏感欄位的紀錄。
 */

export type TradeSide = 'Buy' | 'Sell';
export type TradeMode = 'demo' | 'live';
export type SignalSource = 'main-signal' | 'moonshot';

export type ExitReason = 'tp1' | 'tp2' | 'stop' | 'manual' | 'emergency' | 'liquidation' | 'unknown';

/** 下單當下的完整決策快照 */
export interface SignalSnapshot {
  capturedAt: string;
  source: SignalSource;
  symbol: string;
  side: TradeSide;
  grade: string;
  directionScore: number;
  displayScore: number;
  /** 每一道閘門的實際值，事後可重建當時為什麼放行 */
  gateSummary: Array<{ id: string; passed: boolean; actual: unknown }>;
  intendedEntry: number;
  intendedStop: number;
  intendedTp1: number | null;
  intendedTp2: number | null;
  riskPercent: number;
  sizingReason: string;
  isMeme: boolean;
  tradeMode: TradeMode;
  workerVersion: string;
}

export interface JournalOpenRecord {
  id: string;
  status: 'open';
  openedAt: string;
  orderId: string;
  requestedQty: number;
  snapshot: SignalSnapshot;
}

export interface JournalClosedRecord extends Omit<JournalOpenRecord, 'status'> {
  status: 'closed';
  closedAt: string;
  /** 實際成交均價（進場側 VWAP） */
  actualEntryPrice: number | null;
  actualExitPrice: number | null;
  filledQty: number | null;
  /** 進場滑價百分比。正值代表比預期不利 */
  entrySlippagePct: number | null;
  realizedPnl: number | null;
  totalFees: number | null;
  fundingPaid: number | null;
  /** 實際損益相對於計畫風險的 R 倍數 */
  rMultiple: number | null;
  exitReason: ExitReason;
  /** 部分成交：實際成交量小於請求量 */
  partiallyFilled: boolean;
  /** 取不到的欄位，明確列出而非猜測 */
  dataGaps: string[];
}

export type JournalRecord = JournalOpenRecord | JournalClosedRecord;

/* ------------------------------------------------------------------ */
/* Bybit 回查資料的正規化輸入                                            */
/* ------------------------------------------------------------------ */

export interface ExecutionFill {
  execTime: string;
  price: number;
  qty: number;
  fee: number;
  side: TradeSide;
  /** Bybit execType，例如 Trade、Funding、AdlTrade */
  execType?: string;
}

export interface ClosedPnlEntry {
  symbol: string;
  side: TradeSide;
  avgEntryPrice: number;
  avgExitPrice: number;
  closedSize: number;
  closedPnl: number;
  createdTime: string;
}

export interface ReconcileInput {
  executions: readonly ExecutionFill[];
  closedPnl: ClosedPnlEntry | null;
  /** 平倉時已知的保護單觸發資訊 */
  protectionTriggered?: { tp1?: boolean; tp2?: boolean; stop?: boolean };
  emergencyLockEngaged?: boolean;
  closedAt: string;
}

/* ------------------------------------------------------------------ */
/* 建構與對帳                                                           */
/* ------------------------------------------------------------------ */

export function journalId(symbol: string, openedAt: string, orderId: string): string {
  return `${symbol}:${openedAt}:${orderId}`;
}

export function openRecord(params: {
  snapshot: SignalSnapshot;
  orderId: string;
  requestedQty: number;
  openedAt: string;
}): JournalOpenRecord {
  if (params.snapshot.source === 'moonshot') {
    // 交接規格三.3：快噴候選永遠不自動下單，不應該有自動成交日誌
    throw new Error('快噴候選不得產生自動交易紀錄');
  }
  return {
    id: journalId(params.snapshot.symbol, params.openedAt, params.orderId),
    status: 'open',
    openedAt: params.openedAt,
    orderId: params.orderId,
    requestedQty: params.requestedQty,
    snapshot: params.snapshot,
  };
}

function vwap(fills: readonly ExecutionFill[]): { price: number; qty: number } | null {
  const usable = fills.filter((f) => Number.isFinite(f.price) && Number.isFinite(f.qty) && f.qty > 0);
  if (usable.length === 0) return null;
  const qty = usable.reduce((s, f) => s + f.qty, 0);
  if (!(qty > 0)) return null;
  const notional = usable.reduce((s, f) => s + f.price * f.qty, 0);
  return { price: notional / qty, qty };
}

/** 進場滑價：正值代表比預期不利（買貴了／賣便宜了） */
export function entrySlippagePct(intended: number, actual: number, side: TradeSide): number | null {
  if (!Number.isFinite(intended) || !Number.isFinite(actual) || intended === 0) return null;
  const raw = ((actual - intended) / intended) * 100;
  return side === 'Buy' ? raw : -raw;
}

/**
 * 推斷出場原因。
 * 只在出場價落在保護價位的容差內才判定為 TP／SL，
 * 判不出來就回傳 unknown，不猜測。
 */
export function inferExitReason(
  exitPrice: number | null,
  snapshot: SignalSnapshot,
  input: ReconcileInput,
  tolerancePct = 0.15,
): ExitReason {
  if (input.emergencyLockEngaged) return 'emergency';
  const t = input.protectionTriggered;
  if (t?.stop) return 'stop';
  if (t?.tp2) return 'tp2';
  if (t?.tp1) return 'tp1';
  if (exitPrice === null || !Number.isFinite(exitPrice)) return 'unknown';

  const near = (level: number | null): boolean =>
    level !== null && Number.isFinite(level) && level !== 0 &&
    Math.abs((exitPrice - level) / level) * 100 <= tolerancePct;

  if (near(snapshot.intendedStop)) return 'stop';
  if (near(snapshot.intendedTp2)) return 'tp2';
  if (near(snapshot.intendedTp1)) return 'tp1';
  return 'unknown';
}

/**
 * 用 Bybit 回查結果對帳，產生封存紀錄。
 *
 * 缺資料時填 null 並記入 dataGaps；不會用估算值填補。
 */
export function reconcile(open: JournalOpenRecord, input: ReconcileInput): JournalClosedRecord {
  const gaps: string[] = [];
  const snapshot = open.snapshot;

  const tradeFills = input.executions.filter((f) => (f.execType ?? 'Trade') === 'Trade');
  const entryFills = tradeFills.filter((f) => f.side === snapshot.side);
  const exitSide: TradeSide = snapshot.side === 'Buy' ? 'Sell' : 'Buy';
  const exitFills = tradeFills.filter((f) => f.side === exitSide);

  const entryVwap = vwap(entryFills);
  const exitVwap = vwap(exitFills);

  const actualEntryPrice = entryVwap?.price ?? input.closedPnl?.avgEntryPrice ?? null;
  const actualExitPrice = exitVwap?.price ?? input.closedPnl?.avgExitPrice ?? null;
  const filledQty = entryVwap?.qty ?? input.closedPnl?.closedSize ?? null;

  if (actualEntryPrice === null) gaps.push('缺少進場成交價');
  if (actualExitPrice === null) gaps.push('缺少出場成交價');
  if (filledQty === null) gaps.push('缺少成交數量');
  if (input.closedPnl === null) gaps.push('缺少 Bybit 已平倉紀錄');

  const totalFees = tradeFills.length > 0
    ? tradeFills.reduce((s, f) => s + (Number.isFinite(f.fee) ? f.fee : 0), 0)
    : null;
  if (totalFees === null) gaps.push('缺少手續費明細');

  const fundingFills = input.executions.filter((f) => f.execType === 'Funding');
  const fundingPaid = fundingFills.length > 0
    ? fundingFills.reduce((s, f) => s + (Number.isFinite(f.fee) ? f.fee : 0), 0)
    : 0;

  const realizedPnl = input.closedPnl ? input.closedPnl.closedPnl : null;

  const slippage = actualEntryPrice !== null
    ? entrySlippagePct(snapshot.intendedEntry, actualEntryPrice, snapshot.side)
    : null;

  const plannedRiskPerUnit = Math.abs(snapshot.intendedEntry - snapshot.intendedStop);
  const rMultiple =
    realizedPnl !== null && filledQty !== null && plannedRiskPerUnit > 0 && filledQty > 0
      ? realizedPnl / (plannedRiskPerUnit * filledQty)
      : null;
  if (rMultiple === null) gaps.push('無法計算 R 倍數');

  const partiallyFilled =
    filledQty !== null && Number.isFinite(open.requestedQty) && open.requestedQty > 0
      ? filledQty < open.requestedQty * 0.995
      : false;

  return {
    ...open,
    status: 'closed',
    closedAt: input.closedAt,
    actualEntryPrice,
    actualExitPrice,
    filledQty,
    entrySlippagePct: slippage,
    realizedPnl,
    totalFees,
    fundingPaid,
    rMultiple,
    exitReason: inferExitReason(actualExitPrice, snapshot, input),
    partiallyFilled,
    dataGaps: gaps,
  };
}

/* ------------------------------------------------------------------ */
/* 部分成交時的保護單數量                                                */
/* ------------------------------------------------------------------ */

/**
 * TP／SL 的數量必須跟隨 Bybit 回查到的實際持倉，而不是原始請求量。
 * 否則不是留下裸倉，就是 reduce-only 超額。
 * 回查不到持倉時回傳 null，呼叫端應視為保護失敗並走安全平倉流程。
 */
export function protectionQty(confirmedPositionQty: number | null | undefined): number | null {
  if (typeof confirmedPositionQty !== 'number') return null;
  if (!Number.isFinite(confirmedPositionQty) || confirmedPositionQty <= 0) return null;
  return confirmedPositionQty;
}

/* ------------------------------------------------------------------ */
/* 儲存層（相容 Cloudflare KV 介面）                                     */
/* ------------------------------------------------------------------ */

export interface JournalStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export const JOURNAL_PREFIX = 'journal:v1:';

export function journalKey(record: JournalRecord): string {
  return `${JOURNAL_PREFIX}${record.status}:${record.id}`;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|passphrase|webhook|authorization|bearer|cookie)/i;

/**
 * 寫入前的敏感欄位掃描。
 * 交接規格三.6、十：金鑰與 Token 不得寫進任何持久化資料。
 */
export function assertNoSecrets(record: unknown, path = 'record'): void {
  if (record === null || typeof record !== 'object') return;
  if (Array.isArray(record)) {
    record.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`成交日誌不得包含敏感欄位：${path}.${key}`);
    }
    assertNoSecrets(value, `${path}.${key}`);
  }
}

export async function saveRecord(store: JournalStore, record: JournalRecord): Promise<void> {
  assertNoSecrets(record);
  await store.put(journalKey(record), JSON.stringify(record));
}

export async function loadRecords(
  store: JournalStore,
  status: 'open' | 'closed',
): Promise<JournalRecord[]> {
  const listed = await store.list({ prefix: `${JOURNAL_PREFIX}${status}:` });
  const out: JournalRecord[] = [];
  for (const { name } of listed.keys) {
    const raw = await store.get(name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as JournalRecord);
    } catch {
      // 壞掉的紀錄跳過，不讓單筆解析失敗擋掉整份日誌
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 統計 —— 餵給 performance-learning 的真實數據                          */
/* ------------------------------------------------------------------ */

export interface JournalStats {
  count: number;
  /** 平均進場滑價百分比，正值代表平均比預期不利 */
  avgEntrySlippagePct: number | null;
  totalRealizedPnl: number | null;
  avgRMultiple: number | null;
  exitReasonCounts: Record<ExitReason, number>;
  partialFillCount: number;
  /** 有資料缺口的紀錄數；偏高代表回查流程需要檢查 */
  recordsWithGaps: number;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export function summarize(records: readonly JournalClosedRecord[]): JournalStats {
  const counts: Record<ExitReason, number> = {
    tp1: 0, tp2: 0, stop: 0, manual: 0, emergency: 0, liquidation: 0, unknown: 0,
  };
  for (const r of records) counts[r.exitReason] += 1;

  const slips = records.map((r) => r.entrySlippagePct).filter((v): v is number => v !== null);
  const rs = records.map((r) => r.rMultiple).filter((v): v is number => v !== null);
  const pnls = records.map((r) => r.realizedPnl).filter((v): v is number => v !== null);

  return {
    count: records.length,
    avgEntrySlippagePct: mean(slips),
    totalRealizedPnl: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) : null,
    avgRMultiple: mean(rs),
    exitReasonCounts: counts,
    partialFillCount: records.filter((r) => r.partiallyFilled).length,
    recordsWithGaps: records.filter((r) => r.dataGaps.length > 0).length,
  };
}

/** 每個 symbol 的實際滑價，可回饋給倉位計算與深度過濾 */
export function slippageBySymbol(records: readonly JournalClosedRecord[]): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const r of records) {
    if (r.entrySlippagePct === null) continue;
    const list = buckets.get(r.snapshot.symbol) ?? [];
    list.push(r.entrySlippagePct);
    buckets.set(r.snapshot.symbol, list);
  }
  const out = new Map<string, number>();
  for (const [symbol, values] of buckets) {
    const avg = mean(values);
    if (avg !== null) out.set(symbol, avg);
  }
  return out;
}
