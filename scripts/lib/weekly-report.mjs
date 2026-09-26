/**
 * 每週績效報告 → Discord embed（純函式，IO 在 scripts/weekly-report.mjs）。
 *
 * 三塊內容：
 *  1. Demo 帳戶實際淨值、跟上週比、目前持倉佔用多少風險
 *  2. 模擬盤紀錄裡「符合目前自動下單規則」的訊號，這週跟新規則上線以來的績效（扣手續費）
 *  3. 上真錢的四個門檻達成進度（README「什麼時候可以放真錢」）
 */

import { COLORS } from './outcome-embed.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 目前自動下單規則上線的時間；之前的紀錄是舊評分／舊過濾，不能拿來判斷新規則 */
export const RULES_SINCE = Date.parse('2026-09-25T03:00:00Z');

export const GO_LIVE = {
  minTrades: 200,
  minNetExpectancy: 0.05,
  maxDrawdownR: 15,
  minWeeks: 4,
};

/** 保守估計：進出都算吃單費 0.055% */
const ROUND_TRIP_FEE = 0.0011;

export function matchesLiveRules(t, { minScore = 65, minTp1R = 1.5 } = {}) {
  const tp1R = (t.targets ?? []).find((x) => !x.scalp)?.rr;
  return t.score >= minScore && tp1R >= minTp1R;
}

export const netR = (t) => {
  const stop = t.initialStop ?? t.stop;
  return t.r - ROUND_TRIP_FEE / (Math.abs(t.entry - stop) / t.entry);
};

export function summarizeNet(trades) {
  const filled = trades.filter((t) => t.filledTime);
  if (!filled.length) return { n: 0, winRate: 0, totalR: 0, expectancy: 0, maxDdR: 0 };
  const sorted = [...filled].sort((a, b) => a.closedTime - b.closedTime);
  let eq = 0, peak = 0, dd = 0, total = 0, wins = 0;
  for (const t of sorted) {
    const r = netR(t);
    total += r;
    if (r > 0) wins++;
    eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
  }
  return { n: filled.length, winRate: (wins / filled.length) * 100, totalR: total, expectancy: total / filled.length, maxDdR: dd };
}

const r2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
const pctStr = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

/**
 * @param {object} p
 * @param {object|null} p.status  Worker /auto-trade/status 的回應（取不到就 null）
 * @param {object[]} p.closed     data/signals.json 的 closed
 * @param {{time:number,balance:number}[]} p.history 過去每週的淨值快照
 * @returns {{ embed: object, snapshot: {time:number,balance:number}|null }}
 */
export function buildWeeklyReport({ status, closed, history = [], now = Date.now() }) {
  const fields = [];
  const balance = Number(status?.wallet?.totalWalletBalance);
  const snapshot = balance > 0 ? { time: now, balance } : null;

  if (snapshot) {
    const prev = history[history.length - 1];
    const first = history[0];
    const lines = [`**${balance.toFixed(2)} USDT**`];
    if (prev) lines.push(`比上週：${pctStr(((balance - prev.balance) / prev.balance) * 100)}`);
    if (first && first !== prev) lines.push(`從 ${new Date(first.time).toISOString().slice(0, 10)} 起：${pctStr(((balance - first.balance) / first.balance) * 100)}`);
    fields.push({ name: 'Demo 帳戶淨值', value: lines.join('\n'), inline: true });
    fields.push({
      name: '目前持倉',
      value: `${status.trackedOpenPositions ?? 0} 筆\n風險佔用 ${status.openRiskPct ?? '—'}%（上限 ${status.maxOpenRiskPct ?? '—'}%）`,
      inline: true,
    });
  } else {
    fields.push({ name: 'Demo 帳戶淨值', value: '⚠️ 這次讀不到 Worker 狀態，淨值沒有記錄', inline: false });
  }

  const live = closed.filter((t) => t.closedTime >= RULES_SINCE && matchesLiveRules(t));
  const week = summarizeNet(live.filter((t) => t.closedTime >= now - 7 * DAY_MS));
  const all = summarizeNet(live);
  const fmt = (s) => (s.n ? `${s.n} 筆｜勝率 ${s.winRate.toFixed(0)}%｜總 ${r2(s.totalR)}R｜每筆 ${r2(s.expectancy)}R` : '還沒有結束的交易');
  fields.push({ name: '本週（符合下單規則、扣手續費）', value: fmt(week), inline: false });
  fields.push({ name: '新規則上線以來', value: `${fmt(all)}${all.n ? `｜最大回撤 ${all.maxDdR.toFixed(1)}R` : ''}`, inline: false });

  const weeks = history.length + (snapshot ? 1 : 0);
  const equityOk = snapshot && history.length ? balance >= history[0].balance : false;
  const checks = [
    [all.n >= GO_LIVE.minTrades, `交易筆數 ${all.n} / ${GO_LIVE.minTrades}`],
    [all.n >= GO_LIVE.minTrades && all.expectancy >= GO_LIVE.minNetExpectancy, `扣手續費後每筆 ≥ +${GO_LIVE.minNetExpectancy}R（目前 ${r2(all.expectancy)}R）`],
    [all.n > 0 && all.maxDdR <= GO_LIVE.maxDrawdownR, `最大回撤 ≤ ${GO_LIVE.maxDrawdownR}R（目前 ${all.maxDdR.toFixed(1)}R）`],
    [weeks >= GO_LIVE.minWeeks && equityOk, `Demo 淨值連續 ${GO_LIVE.minWeeks} 週以上、沒有低於起始（目前第 ${weeks} 週）`],
  ];
  const passed = checks.filter(([ok]) => ok).length;
  fields.push({
    name: `上真錢門檻（${passed}/${checks.length}）`,
    value: checks.map(([ok, text]) => `${ok ? '✅' : '⬜'} ${text}`).join('\n'),
    inline: false,
  });

  return {
    snapshot,
    embed: {
      title: '📊 每週績效報告',
      color: passed === checks.length ? COLORS.bull : COLORS.info,
      description: passed === checks.length
        ? '四個門檻都達到了，可以考慮小額上真錢（每單風險先用 0.5～1%）。'
        : '還在累積資料階段，維持 Demo。',
      fields,
      timestamp: new Date(now).toISOString(),
    },
  };
}
