/**
 * 全市場掃描的核心邏輯（純函式，不碰檔案系統、不寫 log）。
 *
 * 原本這套邏輯寫死在 scripts/market-scan.mjs 裡，只能在 GitHub Actions
 * 的 Node 環境跑。抽成這個共用模組後，Cloudflare Worker 也能 import
 * 同一份邏輯（Worker 部署會用 esbuild 打包成一個檔案，見 deploy-worker.yml）——
 * 在 Workers Paid 方案的額度內，用縮小過的範圍（更少幣種）跑一次真正的
 * 分析，把「新機會多久出現一次」從 GitHub 排程實際上的 2～4 小時一次
 * 拉到 2 分鐘一次。GitHub Actions 那份（120 檔、含資金費率）繼續當作
 * App 網站與 Discord 推播用的主要資料源，兩邊互不取代。
 *
 * 這裡只做「行情分析」本身；資金費率／未平倉量、寫檔、Markdown 報表都
 * 留在 scripts/market-scan.mjs（CLI 端才需要），保持這個模組單純可攜。
 */
import { PROVIDERS } from '../data/providers.js';
import { analyze } from '../smc/engine.js';
import { aggregateBias, tfSuite } from '../smc/mtf.js';

/** 排除穩定幣對與槓桿代幣：這些的 SMC 結構沒有參考價值 */
export const EXCLUDE_SYMBOL = /(USDC|FDUSD|TUSD|BUSD|DAI|USDP|USDE|USD1|USDF|PYUSD|AEUR|EURI|XUSD|BFUSD|EUR|GBP|TRY|BRL|ARS|JPY|UP|DOWN|BULL|BEAR)USDT$/;
/** 近期波動度低於此值（相對價格）就視為穩定幣或殭屍幣，直接跳過 */
export const MIN_ATR_PCT = 0.15;

async function withFallback(providerIds, fn) {
  let err;
  for (const id of providerIds) {
    const p = PROVIDERS[id];
    if (!p) continue;
    try { return { result: await fn(p), provider: id }; } catch (e) { err = e; }
  }
  throw err || new Error('沒有可用的資料源');
}

/** 簡單的並行池：控制同時進行的請求數，避免打爆交易所的速率限制 */
async function pool(items, size, worker) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx], idx); } catch (e) { out[idx] = { error: e?.message || String(e) }; }
      }
    }),
  );
  return out;
}

const r8 = (v) => (v == null || !isFinite(v) ? null : Number(Number(v).toPrecision(8)));
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

function toRow(symbol, a, provider, quoteVolume, interval) {
  const s = a.setup;
  if (!s || s.none) return null;
  const distancePct = ((s.entry - a.price) / a.price) * 100;
  // 近 24 根的價格變化：判讀「價格與未平倉量同向還是背離」時要用到
  const recent = a.candles.slice(-24);
  const changePct = recent.length > 1
    ? ((recent.at(-1).close - recent[0].close) / recent[0].close) * 100
    : 0;
  return {
    symbol,
    price: r8(a.price),
    changePct: r2(changePct),
    quoteVolume: Math.round(quoteVolume ?? 0),
    provider,
    interval,
    bias: a.bias.score,
    biasLabel: a.bias.label,
    pd: a.pd ? { zone: a.pd.zone, pct: r2(a.pd.pct) } : null,
    dir: s.dir,
    grade: s.grade,
    score: s.score,
    rr: r2(s.rrFinal),
    rr1: r2(s.rr1),
    entry: r8(s.entry),
    stop: r8(s.stop),
    riskPct: r2(s.riskPct),
    targets: s.targets.map((t) => ({ name: t.name, price: r8(t.price), rr: r2(t.rr), label: t.label })),
    poiType: s.poi?.type,
    poiState: s.poi?.state,
    entryType: s.entryType,
    status: s.entryType === 'market' ? 'ready' : 'waiting',
    distancePct: r2(distancePct),
    valid: s.valid,
    conflict: !!s.conflict,
    checksPassed: s.checklist.filter((c) => c.ok).length,
    checksTotal: s.checklist.length,
    structure: a.structure.swing.trendLabel,
    lastEvent: a.structure.internal.lastEvent
      ? { type: a.structure.internal.lastEvent.type, dir: a.structure.internal.lastEvent.dir }
      : null,
    updatedAt: a.candles.at(-1).time,
  };
}

/**
 * @param {object} opts
 *   providerIds   依序嘗試的資料源（預設 binance,okx,bybit）
 *   top           候選池大小：依成交額排序取前 N 名（這是「總共想涵蓋幾檔」，
 *                 不是這一次呼叫要算幾檔——那個是 batchSize）
 *   offset        從候選池第幾個開始算這一批（batching 用；不設就是 0）
 *   batchSize     這一批要算幾檔，超過候選池會自動循環回頭（batching 用；
 *                 不設就等於 top，等同沒有分批、一次算完整個候選池）
 *   interval      進場週期
 *   concurrency   並行請求數
 *   minScore      粗篩門檻
 *   detailTop     精算（補抓高週期偏向）的檔數；0 表示跳過精算，只用粗篩結果
 * @returns 跟 data/market.json 相同的結構，可以直接餵給既有的下游邏輯；
 *   另外多帶 poolTotal（候選池總大小）與 universeSymbols（這一批實際算了
 *   哪些代號，含沒有通過門檻的），給呼叫端做 batching 的累積與清理用
 */
export async function scanMarket({
  providerIds = ['binance', 'okx', 'bybit'],
  top = 120,
  offset = 0,
  batchSize,
  interval = '1h',
  concurrency = 8,
  minScore = 50,
  detailTop = 30,
} = {}) {
  const { result: tickers, provider } = await withFallback(providerIds, (p) => p.fetchSymbols());
  const topPool = tickers.filter((t) => !EXCLUDE_SYMBOL.test(t.symbol)).slice(0, top);
  const size = Math.min(batchSize ?? topPool.length, topPool.length);
  // 用取模索引做循環：candidatePool 不變的話，offset 每次往前推 size，
  // 繞一圈剛好把整個候選池都算過一輪
  const universe = topPool.length
    ? Array.from({ length: size }, (_, i) => topPool[(offset + i) % topPool.length])
    : [];

  const stage1 = await pool(universe, concurrency, async (t) => {
    const p = PROVIDERS[provider];
    const candles = await p.fetchKlines(t.symbol, interval, { limit: 320 });
    const a = analyze(candles.slice(0, -1));
    if (a.empty) return null;
    // 第二道防線：波動度太低（穩定幣、殭屍幣）的訊號沒有意義
    const atrPct = (a.atrValue / a.price) * 100;
    if (atrPct < MIN_ATR_PCT) return { skipped: 'low-volatility', symbol: t.symbol };
    return toRow(t.symbol, a, provider, t.quoteVolume, interval);
  });

  const skipped = stage1.filter((r) => r?.skipped).length;
  // 記錄這一批裡有幾檔資料源直接失敗（逾時／被擋／格式錯誤）：跟
  // coveredSymbols 一起看，能分辨「候選池真的沒訊號」還是「資料源這批
  // 幾乎都要不到資料」——後者不會被 minScore 篩掉，是完全不同的問題。
  // 順便留一個範例錯誤訊息：逾時（abort）、被擋（403）、被限流（429）、
  // 交易所回傳格式錯誤，各自要的處理方式完全不同，光看數量分不出來。
  const errored = stage1.filter((r) => r?.error).length;
  const sampleError = stage1.find((r) => r?.error)?.error || null;
  const candidates = stage1
    .filter((r) => r && !r.error && !r.skipped && r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const htfInterval = tfSuite(interval).htf;
  let rows = candidates;
  if (detailTop > 0) {
    const detail = candidates.slice(0, detailTop);
    const refined = await pool(detail, concurrency, async (row) => {
      const p = PROVIDERS[provider];
      let htf = null;
      try {
        const h = await p.fetchKlines(row.symbol, htfInterval, { limit: 260 });
        const ha = analyze(h.slice(0, -1));
        if (!ha.empty) htf = aggregateBias([{ interval: htfInterval, bias: ha.bias }]);
      } catch { /* 高週期補抓失敗就沒有這段加分，不影響主流程 */ }
      const candles = await p.fetchKlines(row.symbol, interval, { limit: 320 });
      const a = analyze(candles.slice(0, -1), { htfBias: htf });
      if (a.empty) return row;
      const fresh = toRow(row.symbol, a, provider, row.quoteVolume, interval);
      return fresh ? { ...fresh, htfBias: htf?.score ?? null } : row;
    });
    rows = [...refined.filter((r) => r && !r.error), ...candidates.slice(detailTop)];
  }
  rows = rows.sort((a, b) => b.score - a.score);

  const ready = rows.filter((r) => r.status === 'ready' && r.valid);
  const waiting = rows.filter((r) => r.status === 'waiting' && r.valid);

  return {
    generatedAt: new Date().toISOString(),
    provider,
    interval,
    htfInterval,
    universe: universe.length,
    poolTotal: topPool.length,
    universeSymbols: universe.map((t) => t.symbol),
    scanned: stage1.filter((r) => r && !r.skipped).length,
    skippedLowVolatility: skipped,
    errorCount: errored,
    sampleError,
    minScore,
    counts: { ready: ready.length, waiting: waiting.length, total: rows.length },
    rows,
  };
}
