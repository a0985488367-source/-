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
import { ledgerByWindow, summarizeTxLog } from './lib/demo-ledger.mjs';
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

  // 大筆的手動／不明單、強平（BustTrade）明細，和已平倉損益資料最新到哪
  const cp = hist.closedPnl || [];
  if (cp.length) log(`Bybit 已平倉損益 ${cp.length} 筆，最新一筆 ${day(Math.max(...cp.map((p) => p.updatedTime || p.createdTime)))}`);
  const { attributeClosedPnl } = await import('./lib/demo-ledger.mjs');
  for (const p of attributeClosedPnl(hist.executions, cp).filter((p) => ['manual', 'unknown'].includes(p.strategy) && Math.abs(p.closedPnl) >= 50).sort((a, b) => a.time - b.time)) {
    log(`大筆 ${NAME[p.strategy]} ${day(p.time)} ${p.symbol} ${p.side === 'Buy' ? '平空' : '平多'} 數量${p.qty} 進${p.avgEntryPrice} 出${p.avgExitPrice} ${p.leverage}x ${u(p.closedPnl)}`);
  }
  for (const e of hist.executions.filter((e) => e.execType && e.execType !== 'Trade' && e.execType !== 'Funding')) {
    log(`特殊成交 ${e.execType} ${day(e.execTime)} ${e.symbol} ${e.side} 數量${e.execQty} 價${e.execPrice} 手續費${e.execFee}`);
  }

  // 整段加總（分策略）
  const total = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.byStrategy)) total[k] = (total[k] || 0) + v;
  log(`整段已平倉分策略：${Object.entries(total).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${NAME[k] || k} ${u(v)}`).join('、')}`);

  // 資金流水（Executor /ledger，舊版 Executor 沒有這個端點）：每種餘額變動加總、流水沒記到的餘額跳動、交易和資金費以外的流水
  const ledger = await executorGet(`/ledger?days=${DAYS}`).catch((e) => ({ error: e.message }));
  if (ledger.error) log(`（資金流水查不到：${ledger.error}）`);
  else {
    if (ledger.errors?.logs) log(`⚠️ 資金流水查詢失敗：${ledger.errors.logs}`);
    const s = summarizeTxLog(ledger.logs || [], snaps);
    log(`### 資金流水 ${ledger.logs.length} 筆（${s.first ? day(s.first.time) : '-'}～${s.last ? day(s.last.time) : '-'}）`);
    for (const w of s.windows) {
      const parts = Object.entries(w.byType).sort((a, b) => a[1].change - b[1].change).map(([k, v]) => `${k} ${v.n}筆 ${v.change >= 0 ? '+' : ''}${v.change.toFixed(2)}`);
      log(`${day(w.from)}→${day(w.to)}｜${parts.join('、') || '無'}`);
    }
    for (const g of s.gaps) log(`餘額跳動（流水沒記到）${g.currency} ${day(g.from)}～${day(g.to)}：${g.before.toFixed(2)}→${g.after.toFixed(2)}（${g.gap >= 0 ? '+' : ''}${g.gap.toFixed(2)}）`);
    const odd = (ledger.logs || []).filter((l) => !['TRADE', 'SETTLEMENT'].includes(l.type) && Math.abs(l.change) >= 1).sort((a, b) => a.time - b.time);
    for (const l of odd.slice(0, 60)) log(`特殊流水 ${day(l.time)} ${l.type} ${l.category || ''} ${l.symbol || ''} ${l.currency} ${l.change >= 0 ? '+' : ''}${l.change.toFixed(2)} 之後餘額 ${l.cashBalance.toFixed(2)}`);
    if (ledger.wallet) log(`錢包各幣：${ledger.wallet.coins.map((c) => `${c.coin} ${c.walletBalance}${c.borrowAmount ? `（借 ${c.borrowAmount}）` : ''}≈${c.usdValue.toFixed(1)}U`).join('、') || '無'}`);
  }

  // 現在持倉（含手動單）
  const tracked = new Map((status?.positions || []).map((p) => [`${p.symbol}:${p.dir === 'long' ? 'Buy' : 'Sell'}`, p]));
  // 唐奇安組合的持倉記在 Worker 的 dc:state（不在上面的追蹤清單裡）
  const dc = WORKER ? await fetch(`${WORKER}/dc/status`).then((r) => r.json()).catch(() => null) : null;
  for (const s of Object.keys(dc?.state?.pos || {})) if (!tracked.has(`${s}:Buy`)) tracked.set(`${s}:Buy`, { strategy: 'dc' });
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
