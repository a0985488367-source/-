#!/usr/bin/env node
/**
 * Demo 帳戶對帳：每週餘額掉了多少、各策略已平倉賺賠多少、資金費多少、還有多少對不上；
 * 再列出現在所有持倉（含手動單）的未實現損益。結果用 ::notice 印出來（Actions 的 log 下載不到）。
 *
 * 用法（demo-report.yml mode=ledger 會帶這些環境變數）：
 *   EXECUTOR_URL=… EXECUTOR_HMAC_SECRET=… WORKER_URL=… DAYS=30 node scripts/demo-ledger.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ledgerByWindow } from './lib/demo-ledger.mjs';
import { STRATEGY_NAMES } from './lib/demo-trades.mjs';

const EXEC = String(process.env.EXECUTOR_URL || '').replace(/\/$/, '');
const SECRET = process.env.EXECUTOR_HMAC_SECRET || '';
const WORKER = String(process.env.WORKER_URL || '').replace(/\/$/, '');
const DAYS = Math.min(90, Number(process.env.DAYS || 30));
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const u = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}U`;
const day = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
const NAME = { ...STRATEGY_NAMES, unknown: '不明（查詢區間前就開著）' };

async function executorGet(path) {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  const res = await fetch(EXEC + path, { headers: { 'x-executor-timestamp': ts, 'x-executor-signature': sig } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  if (!EXEC || !SECRET) throw new Error('缺少 EXECUTOR_URL 或 EXECUTOR_HMAC_SECRET');
  const [hist, bal, pos, status] = await Promise.all([
    executorGet(`/history?days=${DAYS}`),
    executorGet('/balance'),
    executorGet('/position'),
    WORKER ? fetch(`${WORKER}/auto-trade/status?detail=1`).then((r) => r.json()).catch(() => null) : null,
  ]);
  if (hist.errors?.closedPnl) log(`⚠️ 已平倉損益查詢失敗：${hist.errors.closedPnl}`);
  if (hist.errors?.executions) log(`⚠️ 成交明細查詢失敗：${hist.errors.executions}`);

  const now = Date.now();
  const from = now - DAYS * 86_400_000;
  const history = JSON.parse(fs.readFileSync('data/account-history.json', 'utf8'));
  const snaps = [...history.filter((s) => s.time >= from), { time: now, balance: bal.totalWalletBalance }];
  // 區間開頭沒有快照的話，用區間開始當起點（餘額不知道就不算差額）
  const rows = ledgerByWindow({ executions: hist.executions, closedPnl: hist.closedPnl, snapshots: snaps });

  log(`## Demo 帳戶對帳（最近 ${DAYS} 天，台灣時間）`);
  log(`現在錢包餘額 ${bal.totalWalletBalance.toFixed(2)}U，可用 ${bal.totalAvailableBalance.toFixed(2)}U`);
  for (const r of rows) {
    const parts = Object.entries(r.byStrategy).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${NAME[k] || k} ${u(v)}`).join('、');
    const sp = Object.entries(r.special).map(([k, v]) => `${k}×${v}`).join('、');
    log(`${day(r.from)}→${day(r.to)}｜餘額 ${r.start.toFixed(0)}→${r.end.toFixed(0)}（${u(r.change)}）｜已平倉 ${u(r.closed)}｜資金費 ${u(r.funding)}（${r.fundingN} 次）｜對不上 ${u(r.unexplained)}${sp ? `｜特殊成交 ${sp}` : ''}`);
    log(`  分策略：${parts || '無'}`);
  }

  // 整段加總（分策略）
  const total = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.byStrategy)) total[k] = (total[k] || 0) + v;
  log(`整段已平倉分策略：${Object.entries(total).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${NAME[k] || k} ${u(v)}`).join('、')}`);

  // 現在持倉（含手動單）
  const tracked = new Map((status?.positions || []).map((p) => [`${p.symbol}:${p.dir === 'long' ? 'Buy' : 'Sell'}`, p]));
  let upl = 0;
  const posLines = (pos.positions || []).map((p) => {
    upl += p.unrealisedPnl;
    const t = tracked.get(`${p.symbol}:${p.side}`);
    const who = t ? (NAME[t.strategy] || t.strategy || 'SMC') : '手動（系統沒在追蹤）';
    return `持倉 ${p.symbol} ${p.side === 'Buy' ? '多' : '空'} ${who} 數量${p.size} 均價${p.avgPrice} 名目${(p.size * p.avgPrice).toFixed(0)}U 未實現${u(p.unrealisedPnl)}`;
  });
  log(`現在持倉 ${posLines.length} 張，未實現合計 ${u(upl)}，權益約 ${(bal.totalWalletBalance + upl).toFixed(1)}U`);
  for (const l of posLines) log(l);

  if (process.env.GITHUB_ACTIONS) {
    const enc = (x) => x.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (let i = 0; i < lines.length; i += 30) console.log(`::notice title=對帳 ${i / 30 + 1}::${enc(lines.slice(i, i + 30).join('\n'))}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=對帳失敗::${e.message}`);
  process.exit(1);
});
