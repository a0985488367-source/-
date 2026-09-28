#!/usr/bin/env node
/**
 * Demo 帳戶實際成交的績效報告：跟 Executor 拿最近幾天的成交明細（GET /history），
 * 還原成一筆一筆的交易，依策略（SMC／突破／EMA 交叉／MACD 零軸／假突破反手）分開統計。
 *
 * 用法（GitHub Actions demo-report.yml 會帶這些環境變數）：
 *   EXECUTOR_URL=… EXECUTOR_HMAC_SECRET=… DAYS=30 node scripts/demo-report.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { rebuildTrades, summarize, STRATEGY_NAMES } from './lib/demo-trades.mjs';

const URL_BASE = String(process.env.EXECUTOR_URL || '').replace(/\/$/, '');
const SECRET = process.env.EXECUTOR_HMAC_SECRET || '';
const DAYS = Number(process.env.DAYS || 30);
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

async function executorGet(path) {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  const res = await fetch(URL_BASE + path, { headers: { 'x-executor-timestamp': ts, 'x-executor-signature': sig } });
  const text = await res.text();
  if (res.status === 404) throw new Error('Executor 還沒有 /history 這個功能——要在電腦上的 executor 資料夾跑一次 fly deploy 更新');
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const u = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}U`;
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const day = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');

(async () => {
  if (!URL_BASE || !SECRET) throw new Error('缺少 EXECUTOR_URL 或 EXECUTOR_HMAC_SECRET');
  const [hist, bal, health] = await Promise.all([
    executorGet(`/history?days=${DAYS}`),
    executorGet('/balance').catch(() => null),
    fetch(URL_BASE + '/health').then((r) => r.json()).catch(() => null),
  ]);
  const acct = health?.liveTrading === true ? '💰真錢帳戶' : health?.liveTrading === false ? 'Demo 帳戶' : '帳戶';
  if (hist.errors?.executions) throw new Error(`查成交明細失敗：${hist.errors.executions}`);
  const { trades, stillOpen } = rebuildTrades(hist.executions);

  log(`## ${acct}實際成交（最近 ${hist.days} 天，已扣手續費）`);
  if (bal) log(`目前帳戶總額：${bal.totalWalletBalance.toFixed(2)}U`);
  log(`成交明細 ${hist.executions.length} 筆 → 還原成 ${trades.length} 筆已平倉交易（還開著 ${stillOpen.length} 筆不算）`);
  log('');
  log('| 策略 | 筆數 | 勝率 | 淨損益 | 平均賺 | 平均賠 | 賺賠比（總賺÷總賠） | 最長連虧 | 最大一筆虧損 | 手續費 |');
  log('|---|---|---|---|---|---|---|---|---|---|');
  const groups = ['smc', 'breakout', 'ema', 'macd', 'fakeout', 'vol', 'st', 'gc', 'manual'];
  for (const g of [...groups, 'all']) {
    const xs = g === 'all' ? trades : trades.filter((t) => t.strategy === g);
    if (!xs.length) continue;
    const s = summarize(xs);
    log(`| ${g === 'all' ? '**全部**' : STRATEGY_NAMES[g]} | ${s.n} | ${pct(s.winRate)} | ${u(s.net)} | ${u(s.avgWin)} | ${u(s.avgLoss)} | ${s.profitFactor == null ? '-' : s.profitFactor.toFixed(2)} | ${s.worstStreak} | ${u(s.worstTrade)} | ${s.fees.toFixed(2)}U |`);
  }
  if (hist.closedPnl?.length) {
    const total = hist.closedPnl.reduce((a, p) => a + p.closedPnl, 0);
    log('');
    log(`對照：Bybit「已平倉損益」同期間合計 ${u(total)}（${hist.closedPnl.length} 筆，Bybit 自己算的，含手續費）`);
  } else if (hist.errors?.closedPnl) {
    log('');
    log(`（Bybit「已平倉損益」查詢失敗：${hist.errors.closedPnl}，只用成交明細計算）`);
  }
  log('');
  log('### 每筆明細（新到舊，台灣時間）');
  log('| 平倉時間 | 策略 | 幣種 | 方向 | 進場均價 | 出場價 | 淨損益 |');
  log('|---|---|---|---|---|---|---|');
  for (const t of [...trades].sort((a, b) => b.closeTime - a.closeTime)) {
    log(`| ${day(t.closeTime)} | ${STRATEGY_NAMES[t.strategy]} | ${t.symbol.replace(/USDT$/, '')} | ${t.dir === 'long' ? '多' : '空'} | ${+t.avg.toPrecision(6)} | ${t.exitPrice} | ${u(t.pnl)} |`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  if (process.env.REPORT_JSON) fs.writeFileSync(process.env.REPORT_JSON, JSON.stringify({ trades, stillOpen: stillOpen.length }, null, 2));
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `❌ ${e.message}\n`);
  process.exit(1);
});
