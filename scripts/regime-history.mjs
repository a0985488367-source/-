#!/usr/bin/env node
/**
 * BTC 大方向（4h 超級趨勢，跟 worker/regime.js 同一套）最近幾天什麼時候翻多／翻空，用來對「翻轉平倉」平掉的單。
 *   DAYS=7 node scripts/regime-history.mjs（demo-report.yml mode=regime）
 */
import { klines } from './research/lib.mjs';
import { atr } from '../src/core/indicators.js';
import { supertrendDir } from '../src/strategies/trend-extra.js';

const DAYS = Math.min(90, Number(process.env.DAYS || 7));
const H4 = 4 * 3_600_000;
const tpe = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
const lines = [];
const log = (s) => { console.log(s); lines.push(s); };

const now = Date.now();
const c = (await klines('BTCUSDT', '4h', 300 + DAYS * 6)).filter((k) => k.time + H4 <= now);
const dir = supertrendDir(c, atr(c, 14), 3);
const from = now - DAYS * 86_400_000;
log(`BTC 4h 超級趨勢（最近 ${DAYS} 天，台灣時間；翻轉時間＝那根 4h 收盤）`);
for (let i = 1; i < c.length; i++) {
  if (c[i].time + H4 < from || dir[i] === dir[i - 1] || dir[i - 1] == null) continue;
  log(`${tpe(c[i].time + H4)} 翻${dir[i] === 1 ? '多' : '空'}（收盤 ${c[i].close}）`);
}
log(`現在：${dir.at(-1) === 1 ? '多' : '空'}（最後一根收在 ${tpe(c.at(-1).time + H4)}，價格 ${c.at(-1).close}）`);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=大方向::${lines.join('%0A')}`);
