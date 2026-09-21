/**
 * 模擬盤帳本 → Markdown 報表（純函式，無副作用）
 */

import { price, fmtR } from './outcome-embed.mjs';
import { computeStats } from './tracker.mjs';

export function renderJournalMarkdown(j) {
  const s = j.stats ?? computeStats(j.closed);
  const rows = [...j.closed].reverse().slice(0, 60).map((t) => {
    const icon = t.status === 'target' ? '✅' : t.status === 'stop' ? '❌' : '⌛';
    return `| ${new Date(t.openTime).toISOString().slice(0, 16).replace('T', ' ')} | ${t.symbol} | ${t.interval} | ${t.dir === 'long' ? '多' : '空'} | ${t.grade ?? '—'} | ${price(t.entry)} | ${price(t.stop)} | ${icon} ${t.status} | ${fmtR(t.r, { sign: false })} |`;
  });
  const openRows = j.open.map((t) =>
    `| ${t.symbol} | ${t.interval} | ${t.dir === 'long' ? '多' : '空'} | ${t.status === 'pending' ? '等待進場' : '持有中'} | ${price(t.entry)} | ${price(t.stop)} | ${t.hitTargets.join('、') || '—'} |`);

  return `# 模擬盤紀錄

> 由 \`scripts/discord-notify.mjs\` 自動維護，請勿手動編輯。
> 每則推播到 Discord 的交易計畫都會在這裡被追蹤到打到目標或停損為止。

更新時間：${j.updatedAt ?? '—'}

## 總覽

| 指標 | 數值 |
|---|---|
| 已結束交易 | ${s.count} 筆（另有 ${s.expired} 筆未進場作廢） |
| 勝率 | ${s.count ? s.winRate.toFixed(1) + '%' : '—'} |
| 期望值 | ${s.count ? s.expectancy.toFixed(2) + 'R' : '—'} |
| 總報酬 | ${s.count ? s.totalR.toFixed(1) + 'R' : '—'} |
| 獲利因子 | ${s.count ? (isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞') : '—'} |
| 最大回撤 | ${s.count ? s.maxDrawdownR.toFixed(1) + 'R' : '—'} |
| 最長連敗 | ${s.count ? s.maxLossStreak : '—'} |

${s.count ? `## 分級表現

| 評級 | 筆數 | 勝率 | 平均 R |
|---|---|---|---|
${s.byGrade.map((g) => `| ${g.key} | ${g.count} | ${g.winRate.toFixed(0)}% | ${g.avgR.toFixed(2)}R |`).join('\n')}

## 各幣種表現

| 幣種 | 筆數 | 勝率 | 總 R |
|---|---|---|---|
${s.bySymbol.map((g) => `| ${g.key} | ${g.count} | ${g.winRate.toFixed(0)}% | ${g.totalR.toFixed(1)}R |`).join('\n')}
` : ''}
## 進行中（${j.open.length}）

| 幣種 | 週期 | 方向 | 狀態 | 進場 | 停損 | 已達目標 |
|---|---|---|---|---|---|---|
${openRows.join('\n') || '| — | | | | | | |'}

## 最近結束的交易

| 開倉時間 (UTC) | 幣種 | 週期 | 方向 | 評級 | 進場 | 停損 | 結果 | R |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| — | | | | | | | | |'}
`;
}
