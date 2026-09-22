/**
 * 「近 N 天交易回顧」→ Discord embed 的純函式版本。
 *
 * 目的：把獲利與虧損的模擬單分開，各自列出常見的等級／方向／週期／型態，
 * 讓人一眼看出「這幾天賺錢的大多長什麼樣子、賠錢的大多長什麼樣子」。
 *
 * 刻意不做的事：不自動調整評分邏輯、不自動停用任何一類訊號。3 天的樣本
 * 通常只有個位數到十幾筆，單一次回顧看到的「共同點」很可能只是雜訊——
 * 要同樣的型態在好幾次回顧裡重複出現，才值得認真考慮調整規則本身。
 */

import { COLORS } from './outcome-embed.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 跟 computeStats() 用同一個判斷：從未成交的限價單不算一筆交易 */
const isUnfilled = (t) => t.status === 'expired' && t.exitReason !== 'maxHold' && !t.filledTime;

function tally(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t) ?? '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const DIMENSIONS = [
  { label: '等級', fn: (t) => t.grade },
  { label: '方向', fn: (t) => (t.dir === 'long' ? '多' : '空') },
  { label: '週期', fn: (t) => t.interval },
  { label: '型態', fn: (t) => t.poiType },
  { label: '來源', fn: (t) => (t.source ?? 'fixed') === 'market' ? '全市場掃描' : '固定監控' },
];

function summaryLines(list) {
  if (!list.length) return null;
  return DIMENSIONS.map(({ label, fn }) => {
    const counted = tally(list, fn);
    return `${label}：${counted.map(([k, n]) => `${k}×${n}`).join('、')}`;
  }).join('\n');
}

/**
 * @param {object} journal 帳本（含 closed 陣列，每筆需要 closedTime/r/status/grade/dir/interval/poiType）
 * @param {number} days 回顧的天數（預設 3）
 * @param {number} now 目前時間（毫秒），測試用來固定「現在」
 */
export function buildReviewEmbed(journal, days = 3, now = Date.now()) {
  const cutoff = now - days * DAY_MS;
  const recent = (journal.closed ?? []).filter((t) => (t.closedTime ?? 0) >= cutoff);
  const traded = recent.filter((t) => !isUnfilled(t));
  const wins = traded.filter((t) => t.r > 0);
  const losses = traded.filter((t) => t.r <= 0);
  const totalR = traded.reduce((s, t) => s + t.r, 0);

  const winLines = summaryLines(wins);
  const lossLines = summaryLines(losses);

  return {
    title: `📒 近 ${days} 天交易回顧`,
    color: COLORS.info,
    description: traded.length
      ? `共結算 ${traded.length} 筆（✅ ${wins.length} 賺 · ❌ ${losses.length} 賠 · 合計 ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R）`
      : `過去 ${days} 天沒有結算的交易，這次回顧略過。`,
    fields: [
      ...(winLines ? [{ name: '✅ 獲利的共同點（值得繼續）', value: winLines }] : []),
      ...(lossLines ? [{ name: '❌ 虧損的共同點（考慮調整）', value: lossLines }] : []),
      ...(traded.length ? [{
        name: '提醒',
        value: '樣本還小，這次看到的「共同點」不代表趨勢——同樣的型態要在好幾次回顧裡重複出現，才值得認真調整規則本身，不要看一次就改。',
      }] : []),
    ],
    footer: { text: '僅供研究，非投資建議' },
    timestamp: new Date(now).toISOString(),
  };
}
