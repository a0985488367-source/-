import { PROVIDERS } from '../../src/data/providers.js';
import { buildLadder, stepTrade } from '../../src/smc/manage.js';

export const opt = (args, n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);

export async function klines(symbol, interval, limit) {
  let err;
  for (const id of ['binance', 'okx', 'bybit']) {
    try { return await PROVIDERS[id].fetchKlines(symbol, interval, { limit }); }
    catch (e) { err = e; }
  }
  throw err;
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
