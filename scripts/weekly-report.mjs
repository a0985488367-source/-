/**
 * 每週績效報告：讀 Worker 狀態（Demo 帳戶淨值）＋ data/signals.json，推到 Discord，
 * 並把這週的淨值記進 data/account-history.json（下週拿來算週變化）。
 *
 *   WORKER_URL=https://smc-signals.xxx.workers.dev DISCORD_WEBHOOK_URL=... node scripts/weekly-report.mjs [--dry-run]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { buildWeeklyReport } from './lib/weekly-report.mjs';

const DRY = process.argv.includes('--dry-run');
const HISTORY = 'data/account-history.json';

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};

let status = null;
try {
  const res = await fetch(`${process.env.WORKER_URL.replace(/\/$/, '')}/auto-trade/status`);
  if (res.ok) status = await res.json();
  else console.log(`讀取 Worker 狀態失敗：HTTP ${res.status}`);
} catch (e) {
  console.log(`讀取 Worker 狀態失敗：${e.message}`);
}

const journal = await readJson('data/signals.json', { closed: [] });
const history = await readJson(HISTORY, []);
const { embed, snapshot } = buildWeeklyReport({ status, closed: journal.closed || [], history });

console.log(JSON.stringify(embed, null, 2));
if (DRY) process.exit(0);

const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ embeds: [embed] }),
});
if (!res.ok) throw new Error(`Discord 推播失敗：HTTP ${res.status} ${await res.text()}`);

if (snapshot) await writeFile(HISTORY, JSON.stringify([...history, snapshot], null, 2) + '\n');
