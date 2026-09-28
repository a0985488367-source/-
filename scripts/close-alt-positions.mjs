#!/usr/bin/env node
/**
 * 把突破／EMA 交叉／MACD 零軸／假突破反手開的單全部市價平倉（SMC 的單不動）。
 *
 * 做法：跟 Worker 拿追蹤中的部位（/auto-trade/status?detail=1），挑出 strategy 是
 * breakout／ema／macd 的，再對照 Executor 的實際持倉，有持倉的才叫 Executor POST /close。
 * Worker 下一輪會發現部位不見了，自己清掉追蹤紀錄、推結算通知。
 *
 * 用法（GitHub Actions close-alt-positions.yml 會帶這些環境變數）：
 *   WORKER_URL=… EXECUTOR_URL=… EXECUTOR_HMAC_SECRET=… DRY=1 node scripts/close-alt-positions.mjs
 * DRY=1 只列出會平哪些，不真的下單。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const WORKER = String(process.env.WORKER_URL || '').replace(/\/$/, '');
const EXEC = String(process.env.EXECUTOR_URL || '').replace(/\/$/, '');
const SECRET = process.env.EXECUTOR_HMAC_SECRET || '';
const DRY = process.env.DRY === '1' || process.env.DRY === 'true';
const ALT = new Set(['breakout', 'ema', 'macd', 'fakeout']);
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

async function executor(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts + raw).digest('hex');
  const res = await fetch(EXEC + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-executor-timestamp': ts, 'x-executor-signature': sig },
    body: method === 'GET' ? undefined : raw,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Executor HTTP ${res.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  if (!WORKER || !EXEC || !SECRET) throw new Error('缺少 WORKER_URL、EXECUTOR_URL 或 EXECUTOR_HMAC_SECRET');
  const status = await fetch(`${WORKER}/auto-trade/status?detail=1`).then((r) => r.json());
  const tracked = (status.positions || []).filter((p) => p && ALT.has(p.strategy));
  const real = await executor('GET', '/position');
  if (real.error) throw new Error(`查持倉失敗：${real.error}`);
  const side = (dir) => (dir === 'long' ? 'Buy' : 'Sell');

  log(`## 平掉突破／EMA／MACD 的單${DRY ? '（試跑，不下單）' : ''}`);
  log(`Worker 追蹤中 ${status.positions?.length ?? 0} 筆，其中突破／EMA／MACD ${tracked.length} 筆`);
  let failed = 0;
  for (const p of tracked) {
    const pos = real.positions.find((r) => r.symbol === p.symbol && r.side === side(p.dir) && r.size > 0);
    const label = `${p.symbol} ${p.dir === 'long' ? '多' : '空'}（${p.strategy}）`;
    if (!pos) { log(`- ${label}：Bybit 上已經沒有持倉，略過`); continue; }
    if (DRY) { log(`- ${label}：會平倉，數量 ${pos.size}，目前未實現 ${pos.unrealisedPnl.toFixed(2)}U`); continue; }
    const r = await executor('POST', '/close', { symbol: p.symbol }).catch((e) => ({ error: e.message }));
    if (r.error) { failed++; log(`- ${label}：❌ 平倉失敗：${r.error}`); } else log(`- ${label}：✅ 已平倉（平倉前未實現 ${pos.unrealisedPnl.toFixed(2)}U）`);
  }
  const others = real.positions.filter((r) => r.size > 0 && !tracked.some((p) => p.symbol === r.symbol));
  if (others.length) log(`\n沒動的持倉（SMC 或不在追蹤裡）：${others.map((r) => `${r.symbol} ${r.side === 'Buy' ? '多' : '空'}`).join('、')}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `❌ ${e.message}\n`);
  process.exit(1);
});
