/**
 * 全市場掃描（2026-10-09 使用者要的：問 AI「現在哪幾個幣最值得做？」時，先掃成交量前 50 檔）。
 * 在瀏覽器裡跑：每個幣抓 1h／4h／6h／1d／1w 的 K 棒、用幣種雷達同一套 buildCoinReport 算，
 * 再依「順勢策略（回測唯一有優勢的）＋多週期同向＋SMC 位置」排出機會分數，壓成給 AI 的精簡 JSON。
 * 抓資料的函式從外面傳進來（網頁用 Bybit、測試用假資料）。
 */

import { buildCoinReport } from './coin-report.js';

export const SCAN_TFS = ['1h', '4h', '6h', '1d', '1w'];
export const SCAN_TOP_N = 50;
export const SCAN_FRESH_MS = 10 * 60_000;
const TREND_TFS = ['4h', '6h'];
const STABLE = /^(USDC|USDE|FDUSD|DAI|TUSD|USDD|PYUSD|BUSD|USD1|RLUSD|EUR|XAUT|PAXG)$/;

const sig = (v, n = 5) => (Number.isFinite(v) ? +Number(v).toPrecision(n) : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** 成交額前 n 名（去掉穩定幣、黃金幣、成交額 0 的） */
export function pickScanUniverse(tickers, n = SCAN_TOP_N) {
  return tickers
    .filter((t) => /USDT$/.test(t.symbol) && !STABLE.test(t.symbol.replace(/USDT$/, '')) && t.turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, n);
}

/**
 * 一個幣的掃描結果：方向、機會分數、理由
 * @param {object} t   ticker { symbol, price, change, turnover, funding }
 * @param {object} rep buildCoinReport() 的結果
 */
export function scanRow(t, rep) {
  if (!rep || rep.empty) return null;
  const tf = Object.fromEntries(rep.tfs.map((x) => [x.interval, x]));
  const lean = rep.agg.score + (rep.htf?.score ?? 0) * 0.5;
  const dir = lean >= 15 ? 'long' : lean <= -15 ? 'short' : null;
  const sgn = dir === 'long' ? 1 : dir === 'short' ? -1 : 0;

  // 4h／6h 順勢指標有幾個跟方向一致（超級趨勢、EMA20>50、MACD>0、站上 EMA200）
  let agree = 0, votes = 0;
  const fresh = [];
  for (const k of TREND_TFS) {
    const tr = tf[k]?.trend;
    if (!tr) continue;
    const st = [tr.supertrend === 1 ? 1 : tr.supertrend === -1 ? -1 : 0, tr.emaFastAbove == null ? 0 : tr.emaFastAbove ? 1 : -1, tr.macdAboveZero == null ? 0 : tr.macdAboveZero ? 1 : -1, tr.aboveEma200 == null ? 0 : tr.aboveEma200 ? 1 : -1];
    for (const v of st) { votes++; if (sgn && v === sgn) agree++; }
    for (const [name, s] of Object.entries(tr.last)) {
      if (s && s.barsAgo <= 3) fresh.push({ tf: k, name, dir: s.dir, barsAgo: s.barsAgo });
    }
  }
  const freshWith = fresh.filter((f) => sgn && f.dir === dir);
  const best = rep.best;
  const bestOk = best && dir && best.dir === dir && Math.abs(best.distPct) <= 3;

  let score = Math.abs(lean) * 0.4 + (rep.agg.alignment ?? 0) * 0.15 + (votes ? (agree / votes) * 30 : 0) + Math.min(2, freshWith.length) * 10 + (bestOk ? 8 : 0);
  if (!dir) score *= 0.4;
  if (rep.conflicts?.length) score -= 5;
  if (best?.againstHtf && best?.dir === dir) score -= 8;

  const NAME = { breakout: '唐奇安突破', ema: 'EMA 交叉', macd: 'MACD 穿零', vol: '放量突破', st: '超級趨勢', gc: '黃金交叉' };
  const reasons = [];
  if (dir) reasons.push(`整體${rep.agg.labelZh}（${rep.agg.score}）、日週線${rep.htf?.labelZh ?? '—'}`);
  if (votes) reasons.push(`4h／6h 順勢指標 ${agree}/${votes} 同向`);
  for (const f of freshWith.slice(0, 2)) reasons.push(`${f.tf} ${NAME[f.name]}剛出${f.dir === 'long' ? '多' : '空'}訊號（${f.barsAgo} 根前）`);
  if (bestOk) reasons.push(`${best.tf} 計畫離現價 ${best.distPct}%`);

  return {
    symbol: t.symbol,
    price: t.price ?? rep.price,
    change: t.change,
    turnover: t.turnover,
    funding: t.funding,
    dir,
    score: Math.round(score),
    agg: { score: rep.agg.score, label: rep.agg.labelZh, alignment: rep.agg.alignment },
    htf: rep.htf ? { score: rep.htf.score, label: rep.htf.labelZh } : null,
    trendAgree: votes ? `${agree}/${votes}` : null,
    fresh,
    best: best ? { tf: best.tf, dir: best.dir, entry: best.entry, stop: best.stop, distPct: best.distPct, grade: best.grade, score: best.score, againstHtf: best.againstHtf, rr: best.targets?.at(-1)?.rr ?? null } : null,
    conflicts: rep.conflicts?.length ?? 0,
    liqAbove: rep.liqAbove[0] ? r1(((rep.liqAbove[0].price - rep.price) / rep.price) * 100) : null,
    liqBelow: rep.liqBelow[0] ? r1(((rep.liqBelow[0].price - rep.price) / rep.price) * 100) : null,
    reasons,
  };
}

/**
 * 掃全市場
 * @param {object} p
 * @param {() => Promise<Array>} p.fetchTickers      [{ symbol, price, change, turnover, funding }]
 * @param {(symbol, tf) => Promise<Array>} p.fetchKlines
 * @param {(done, total, symbol) => void} [p.onProgress]
 * @param {number} [p.n=50]
 * @param {number} [p.concurrency=4]
 */
export async function runMarketScan({ fetchTickers, fetchKlines, onProgress, n = SCAN_TOP_N, concurrency = 4, now = Date.now() }) {
  const universe = pickScanUniverse(await fetchTickers(), n);
  const rows = [];
  const failed = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < universe.length) {
      const t = universe[next++];
      try {
        const lists = await Promise.all(SCAN_TFS.map((tf) => fetchKlines(t.symbol, tf)));
        const tfCandles = Object.fromEntries(SCAN_TFS.map((tf, i) => [tf, lists[i]]));
        // 讓出執行緒，手機上畫面才不會卡住
        await new Promise((r) => setTimeout(r, 0));
        const row = scanRow(t, buildCoinReport(tfCandles, { price: t.price }));
        if (row) rows.push(row); else failed.push(t.symbol);
      } catch {
        failed.push(t.symbol);
      }
      onProgress?.(++done, universe.length, t.symbol);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, universe.length) }, worker));
  rows.sort((a, b) => b.score - a.score);
  return { time: now, universe: universe.length, rows, failed };
}

const tw = (ms) => {
  const d = new Date(ms + 8 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** 給 AI 的精簡版：前 topN 名附細節，其他每檔一行 */
export function marketSnapshot(scan, { topN = 12 } = {}) {
  const dirZh = (d) => (d === 'long' ? '多' : d === 'short' ? '空' : '中性');
  const NAME = { breakout: '突破', ema: 'EMA', macd: 'MACD', vol: '放量', st: '超級趨勢', gc: '黃金交叉' };
  return {
    time: tw(scan.time),
    scanned: `成交額前 ${scan.universe} 檔（Bybit 永續），週期 ${SCAN_TFS.join('/')}${scan.failed.length ? `，${scan.failed.length} 檔抓不到：${scan.failed.join(',')}` : ''}`,
    scoreNote: '機會分數＝4h/6h 順勢指標同向程度＋剛出的順勢訊號＋多週期偏向＋SMC 計畫離現價近不近；只是排序用，不是勝率',
    top: scan.rows.slice(0, topN).map((r) => ({
      symbol: r.symbol.replace(/USDT$/, ''),
      score: r.score,
      dir: dirZh(r.dir),
      price: sig(r.price, 6),
      chg24hPct: r1(r.change),
      turnoverM: Math.round(r.turnover / 1e6),
      fundingPct: Number.isFinite(r.funding) ? +(r.funding * 100).toFixed(4) : null,
      bias: `${r.agg.label}（${r.agg.score}，${r.agg.alignment}% 同向）`,
      htf: r.htf ? `${r.htf.label}（${r.htf.score}）` : null,
      trend4h6h: r.trendAgree,
      freshSignals: r.fresh.map((f) => `${f.tf}${NAME[f.name]}${dirZh(f.dir)}（${f.barsAgo}根前）`),
      plan: r.best ? `${r.best.tf} ${dirZh(r.best.dir)} 進${sig(r.best.entry)}（${r.best.distPct}%）損${sig(r.best.stop)} ${r.best.grade}級${r.best.againstHtf ? ' 逆大週期' : ''}` : null,
      conflicts: r.conflicts || undefined,
      nearestLiqPct: { above: r.liqAbove, below: r.liqBelow },
    })),
    rest: scan.rows.slice(topN).map((r) => `${r.symbol.replace(/USDT$/, '')} ${r.score}分 ${dirZh(r.dir)} 偏向${r.agg.score} 日週${r.htf?.score ?? '—'} 順勢${r.trendAgree ?? '—'} 24h${r1(r.change)}%`),
  };
}

/** 全市場問題的使用者訊息：掃描結果放在 <market_scan> 標籤裡 */
export function marketUserMessage(snapshot, question) {
  const body = snapshot ? `<market_scan>\n${JSON.stringify(snapshot)}\n</market_scan>` : '<market_scan>沿用前面的掃描結果（10 分鐘內）</market_scan>';
  return `${body}\n\n${String(question).trim()}`;
}
