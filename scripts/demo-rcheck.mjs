#!/usr/bin/env node
/**
 * Demo 實際成交換算成 R，跟回測比（2026-10-23 使用者要「回測預期 vs Demo 實際」對照）。
 *
 * 每筆自動策略單從 signal_id 拿週期跟訊號那根 K 棒，重抓 K 棒算當時的 ATR(14)，
 * 停損距離＝策略的 ATR 倍數（跟線上一樣），1R＝停損距離 × 最大持倉數量，R＝淨損益（已扣手續費）÷ 1R。
 * 也標出「手動平倉」的單（市價出場、沒有停損／止盈單、沒有編號），另外算它們如果被手動平掉吃掉多少。
 *
 *   EXECUTOR_URL=… EXECUTOR_HMAC_SECRET=… DAYS=30 node scripts/demo-rcheck.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { rebuildTrades, STRATEGY_NAMES } from './lib/demo-trades.mjs';
import { klines } from './research/lib.mjs';
import { atr } from '../src/core/indicators.js';

const EXEC = String(process.env.EXECUTOR_URL || '').replace(/\/$/, '');
const SECRET = process.env.EXECUTOR_HMAC_SECRET || '';
const DAYS = Math.min(90, Number(process.env.DAYS || 30));
const STOP_ATR = { breakout: 2, ema: 2, macd: 2, vol: 2, st: 2, gc: 3, rsi: 2, hma: 2 };
const MS = { '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5, '1d': 864e5 };
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const day = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
const r2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

async function executorGet(path) {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  const res = await fetch(EXEC + path, { headers: { 'x-executor-timestamp': ts, 'x-executor-signature': sig } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** signal_id → { interval, barOpen }，例：st:KSM:s:4h:ao5c */
export function parseSignalId(id) {
  const p = String(id || '').split(':');
  if (p.length < 5 || !MS[p[3]]) return null;
  const h = parseInt(p[4], 36);
  return Number.isFinite(h) ? { interval: p[3], barOpen: h * 3_600_000 } : null;
}

/** 出場是不是手動市價平的：沒有停損／止盈／追蹤單類型，也沒有平倉單編號 */
export function isManualExit(exitBy) {
  const s = String(exitBy || '');
  if (/StopLoss|TakeProfit|TrailingStop|PartialStopLoss|PartialTakeProfit|BustTrade|AdlTrade/.test(s)) return false;
  return s.split('/').filter((x) => !/^\d\d:\d\d:\d\d$/.test(x) && x !== 'Market' && x !== 'Limit').length === 0;
}

const main = async () => {
  if (!EXEC || !SECRET) throw new Error('缺少 EXECUTOR_URL 或 EXECUTOR_HMAC_SECRET');
  const hist = await executorGet(`/history?days=${DAYS}`);
  const { trades } = rebuildTrades(hist.executions);
  const auto = trades.filter((t) => STOP_ATR[t.strategy] && parseSignalId(t.orderLinkId));
  const cache = new Map();
  const now = Date.now();
  const rows = [];
  for (const t of auto) {
    const { interval, barOpen } = parseSignalId(t.orderLinkId);
    const key = `${t.symbol}|${interval}`;
    if (!cache.has(key)) {
      const need = Math.ceil((now - (now - DAYS * 864e5 - 10 * 864e5)) / MS[interval]) + 350;
      cache.set(key, await klines(t.symbol, interval, need).catch((e) => ({ error: e.message })));
    }
    const c = cache.get(key);
    if (!Array.isArray(c)) { rows.push({ t, err: `抓不到 K 棒（${c.error}）` }); continue; }
    const i = c.findIndex((k) => k.time === barOpen);
    if (i < 30) { rows.push({ t, err: '找不到訊號那根 K 棒' }); continue; }
    const a = atr(c.slice(Math.max(0, i - 299), i + 1), 14).at(-1);
    const risk = STOP_ATR[t.strategy] * a * t.maxSize;
    if (!(risk > 0)) { rows.push({ t, err: 'ATR 算不出來' }); continue; }
    rows.push({ t, r: t.pnl / risk, manual: isManualExit(t.exitBy) });
  }

  log(`## Demo 實際成交換算 R（最近 ${DAYS} 天，已扣手續費；1R＝線上停損距離 × 數量）`);
  const order = ['breakout', 'ema', 'macd', 'vol', 'st', 'gc', 'rsi', 'hma'];
  const sum = (xs) => xs.reduce((s, x) => s + x.r, 0);
  for (const g of order) {
    const xs = rows.filter((x) => x.t.strategy === g && x.r != null);
    if (!xs.length) continue;
    const man = xs.filter((x) => x.manual), sys = xs.filter((x) => !x.manual);
    log(`${STRATEGY_NAMES[g]}｜${xs.length} 筆 勝率 ${Math.round(xs.filter((x) => x.r > 0).length / xs.length * 100)}% 每筆 ${r2(sum(xs) / xs.length)}R 合計 ${r2(sum(xs))}R`
      + `｜系統出場 ${sys.length} 筆 ${sys.length ? r2(sum(sys) / sys.length) : '-'}R／筆｜手動平 ${man.length} 筆 合計 ${r2(sum(man))}R`);
  }
  const ok = rows.filter((x) => x.r != null);
  log(`全部自動單｜${ok.length} 筆 每筆 ${ok.length ? r2(sum(ok) / ok.length) : '-'}R 合計 ${r2(sum(ok))}R｜手動平 ${ok.filter((x) => x.manual).length} 筆`);
  const bad = rows.filter((x) => x.err);
  if (bad.length) log(`算不出 R 的 ${bad.length} 筆：${bad.slice(0, 8).map((x) => `${x.t.symbol} ${x.err}`).join('；')}`);
  const detail = rows.filter((x) => x.r != null).sort((a, b) => b.t.closeTime - a.t.closeTime)
    .map((x) => `${day(x.t.closeTime)} ${STRATEGY_NAMES[x.t.strategy]} ${x.t.symbol.replace(/USDT$/, '')} ${x.t.dir === 'long' ? '多' : '空'} ${r2(x.r)}R ${x.t.pnl.toFixed(1)}U${x.manual ? ' 手動平' : ''}`);

  if (process.env.GITHUB_ACTIONS) {
    const enc = (x) => x.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::notice title=R 統計::${enc(lines.join('\n'))}`);
    for (let i = 0; i < detail.length && i < 360; i += 40) console.log(`::notice title=R 明細 ${i / 40 + 1}::${enc(detail.slice(i, i + 40).join('\n'))}`);
  } else detail.forEach((l) => console.log(l));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
};
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
