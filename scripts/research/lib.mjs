import { PROVIDERS } from '../../src/data/providers.js';
import { buildLadder, stepTrade } from '../../src/smc/manage.js';

export const opt = (args, n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);

/** 抓最近 limit 根 K 線；交易所單次最多給 1000 根，超過就用 endTime 往前一段一段補 */
export async function klines(symbol, interval, limit) {
  let err;
  for (const id of ['binance', 'okx', 'bybit']) {
    try { return await pagedKlines(PROVIDERS[id], symbol, interval, limit); }
    catch (e) { err = e; }
  }
  throw err;
}

export async function pagedKlines(provider, symbol, interval, limit) {
  let out = [];
  let endTime;
  while (out.length < limit) {
    const page = await provider.fetchKlines(symbol, interval, { limit: Math.min(1000, limit - out.length), endTime });
    const older = page.filter((c) => !out.length || c.time < out[0].time);
    if (!older.length) break; // 已經到上市第一根
    out = [...older, ...out];
    endTime = out[0].time - 1;
  }
  return out.slice(-limit);
}

/** 讓每個訊號照管理規則往後逐根跑到結束；還沒結束的不計入 */
export function runSignals(signals, candlesBy, cfg) {
  const closed = [];
  for (const sig of signals) {
    const candles = candlesBy.get(`${sig.symbol}|${sig.interval}`);
    const t = {
      ...sig,
      targets: buildLadder(sig.entry, sig.stop, sig.targets, cfg),
      status: sig.entryType === 'market' ? 'active' : 'pending',
      hitTargets: [], events: [], remaining: 1, realizedR: 0,
      barsSinceOpen: 0, barsSinceFill: 0, maxFavorableR: 0, maxAdverseR: 0,
    };
    for (let j = sig.index + 1; j < candles.length; j++) {
      if (stepTrade(t, candles[j], cfg)) break;
    }
    if (t.status === 'pending' || t.status === 'active') continue;
    closed.push(t);
  }
  return closed;
}

export function summarize(closed) {
  const traded = closed.filter((t) => t.status !== 'expired' || t.exitReason === 'maxHold');
  const unfilled = closed.length - traded.length;
  if (!traded.length) return { n: 0, unfilled };
  const wins = traded.filter((t) => t.r > 0);
  const totalR = traded.reduce((s, t) => s + t.r, 0);
  const gw = wins.reduce((s, t) => s + t.r, 0);
  const gl = Math.abs(traded.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const t of traded) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n: traded.length, unfilled,
    winRate: (wins.length / traded.length) * 100,
    totalR, expectancy: totalR / traded.length,
    avgWin: wins.length ? gw / wins.length : 0,
    avgLoss: traded.length - wins.length ? -gl / (traded.length - wins.length) : 0,
    profitFactor: gl ? gw / gl : Infinity,
    maxDdR: dd,
  };
}

export const pct = (v) => `${v.toFixed(1)}%`;
export const r2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

export function printTable(log, head, body) {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(w[i])).join('  ');
  log(line(head));
  log(w.map((n) => '─'.repeat(n)).join('  '));
  for (const b of body) log(line(b));
}

/**
 * 帳戶層級模擬：照時間開倉／平倉，每筆冒「開倉當下帳戶」的 riskPct%，平倉時 r 直接滾進帳戶（複利）。
 * trades 需要 filledTime、closedTime、r（已扣手續費）、symbol、beTime（停損移到成本價的時間，沒有就 null）。
 *   oneBySymbol  同一個幣已經有持倉就不再開
 *   maxAtRisk    還沒保本（停損還在成本價另一側）的持倉最多幾筆
 * 回撤用平倉後的帳戶計算（持倉中的浮動虧損不算），所以實際會再大一點。
 */
export function simulatePortfolio(trades, { riskPct = 5, maxAtRisk = Infinity, oneBySymbol = false } = {}) {
  const ev = [];
  trades.forEach((t, i) => {
    ev.push({ time: t.filledTime, kind: 1, i });
    ev.push({ time: Math.max(t.closedTime, t.filledTime + 1), kind: 0, i });
  });
  ev.sort((a, b) => a.time - b.time || a.kind - b.kind);
  let equity = 1, peak = 1, maxDd = 0, taken = 0;
  const open = new Map();
  for (const e of ev) {
    const t = trades[e.i];
    if (e.kind === 0) {
      const p = open.get(e.i);
      if (!p) continue;
      open.delete(e.i);
      equity += p.risk * t.r;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, 1 - equity / peak);
      continue;
    }
    const positions = [...open.values()];
    if (oneBySymbol && positions.some((p) => p.symbol === t.symbol)) continue;
    if (positions.filter((p) => !(p.beTime != null && p.beTime <= e.time)).length >= maxAtRisk) continue;
    open.set(e.i, { risk: (equity * riskPct) / 100, symbol: t.symbol, beTime: t.beTime });
    taken++;
  }
  return { taken, multiple: equity, maxDdPct: maxDd * 100 };
}
