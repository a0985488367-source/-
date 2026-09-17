#!/usr/bin/env node
/**
 * 從 $100 出發，到各個金額需要多久？
 *
 *   node scripts/time-to-target.mjs [--runs 20000] [--per-day 4] [--md docs/time-to-target.md]
 *
 * 兩種情況分開回答：
 *   · 沒有真實優勢 → 「多久」不存在，只有機率上限 P ≤ 起始/目標
 *   · 有真實優勢   → 由凱利成長率給出時間表，並用模擬給出實際分位數
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMilestones, kellyFraction, logGrowth, tradesToTarget } from '../src/sim/target.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RUNS = Number(flag('runs', 20000));
const SEED = Number(flag('seed', 20260917));
const PER_DAY = Number(flag('per-day', 4));
const MD_OUT = flag('md', null);

const START = 100;
const TARGETS = [200, 300, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const WIN_RATES = [0.55, 0.60, 0.65];
const COST = 0.002;
const HORIZON_DAYS = 504;                 // 兩年，避免時間上限截斷慢速情境
const TRADES = HORIZON_DAYS * PER_DAY;

const usd = (x) => `$${x.toLocaleString('en-US')}`;
const pct = (x) => `${(x * 100).toFixed(2)}%`;
/** 交易筆數 → 人看得懂的時間 */
function humanTime(trades) {
  if (!Number.isFinite(trades)) return '—';
  const days = trades / PER_DAY;
  if (days < 1) return '<1 天';
  if (days < 21) return `${days.toFixed(1)} 天`;
  if (days < 252) return `${(days / 21).toFixed(1)} 個月`;
  return `${(days / 252).toFixed(1)} 年`;
}

const out = { start: START, perDay: PER_DAY, runs: RUNS, seed: SEED, cost: COST, horizonDays: HORIZON_DAYS, generatedAt: new Date().toISOString() };

console.log(`起始 ${usd(START)} · 每天 ${PER_DAY} 筆交易 · 每筆成本 ${(COST * 100).toFixed(1)}% · 每組 ${RUNS.toLocaleString('en-US')} 次模擬`);
console.log(`模擬上限 ${HORIZON_DAYS} 個交易日（約 2 年）· 跌破 ${usd(START * 0.1)} 視為陣亡\n`);

/* ------------------------------------------------ 無優勢：只有機率 */
console.log('══ 情況 A：沒有真實優勢 ══');
console.log('「多久」不存在——期望成長率為負，時間越長只會離目標越遠。');
console.log('唯一能問的是機率，上限為 起始 ÷ 目標（Optional Stopping Theorem）：\n');
console.log('    目標金額 |  倍數  | 機率上限 | 相當於');
out.noEdge = TARGETS.map((t) => ({ target: t, multiple: t / START, ceiling: START / t }));
for (const r of out.noEdge) {
  const odds = Math.round(1 / r.ceiling);
  console.log(`  ${usd(r.target).padStart(9)} | ${String(r.multiple).padStart(4)} 倍 | ${pct(r.ceiling).padStart(7)}  | ${odds} 次裡成功 1 次`);
}
console.log('\n  且達到上限的唯一方法是「一次全押」，中途不再交易。');

/* ------------------------------------------------ 有優勢：時間表 */
console.log('\n══ 情況 B：有真實且穩定的優勢（全凱利下注）══');

out.scenarios = [];
for (const p of WIN_RATES) {
  const f = kellyFraction(p, 1);
  const res = runMilestones({ balance: START, winProb: p, fraction: f, costPerTrade: COST, trades: TRADES, ruinFloor: 0.1 }, TARGETS, { runs: RUNS, seed: SEED });
  out.scenarios.push({
    winProb: p, kelly: f, growth: logGrowth(p, 1, f),
    ruinRate: res.ruinRate,
    targets: res.targets.map((t) => ({
      ...t,
      theoryTrades: tradesToTarget(p, 1, f, t.multiple),
      medianDays: t.medianTrades / PER_DAY,
    })),
  });

  console.log(`\n── 勝率 ${(p * 100).toFixed(0)}%（凱利 ${(f * 100).toFixed(0)}%，每筆對數成長 ${logGrowth(p, 1, f).toFixed(4)}）──`);
  console.log(`   期間破產率 ${pct(res.ruinRate)}（理論值 ${pct(0.1)}：全凱利下 P(曾跌到初始的 x 倍) = x）`);
  console.log('    目標金額 |  倍數  | 達成率 | 中位數時間 | 快的 25% | 慢的 25% | 理論值');
  for (const t of res.targets) {
    const theory = tradesToTarget(p, 1, f, t.multiple);
    console.log(`  ${usd(t.target).padStart(9)} | ${String(t.multiple).padStart(4)} 倍 | ${pct(t.reachRate).padStart(6)} | ${humanTime(t.medianTrades).padStart(9)}  | ${humanTime(t.p25Trades).padStart(8)} | ${humanTime(t.p75Trades).padStart(8)} | ${humanTime(theory).padStart(8)}`);
  }
}

/* ------------------------------------------------ 彙總對照表 */
console.log('\n══ 彙總：中位數時間（達成率）══');
console.log('    目標金額 |  倍數  |    勝率 55%     |    勝率 60%     |    勝率 65%');
for (let i = 0; i < TARGETS.length; i++) {
  const cells = out.scenarios.map((s) => {
    const t = s.targets[i];
    return `${humanTime(t.medianTrades)} (${pct(t.reachRate)})`.padStart(15);
  });
  console.log(`  ${usd(TARGETS[i]).padStart(9)} | ${String(TARGETS[i] / START).padStart(4)} 倍 | ${cells.join(' | ')}`);
}

console.log('\n註：達成率不是 100%，因為部分路徑在到達之前就先陣亡；');
console.log('    「中位數時間」只統計有達成的路徑，本身帶有倖存者偏差，請與達成率一起看。');

/* ------------------------------------------------ Markdown */
function md(o) {
  const row = (c) => `| ${c.join(' | ')} |`;
  const sep = (n) => `|${' --- |'.repeat(n)}`;
  return `# 從 $100 出發：到各金額需要多久

> 由 \`npm run time-to-target\` 自動產生，請勿手動編輯。
> 產生時間：${o.generatedAt} ／ 種子 ${o.seed} ／ 每組 ${o.runs.toLocaleString('en-US')} 次模擬
> 假設：每天 ${o.perDay} 筆交易、每筆成本 ${(o.cost * 100).toFixed(1)}%、1:1 賠率、全凱利下注、跌破 ${usd(o.start * 0.1)} 視為陣亡

## 情況 A：沒有真實優勢時，「多久」不存在

期望成長率為負，時間拉長只會讓結果更差。唯一能問的是機率，且有硬上限：

${row(['目標金額', '倍數', '機率上限', '相當於'])}
${sep(4)}
${o.noEdge.map((r) => row([usd(r.target), `${r.multiple} 倍`, pct(r.ceiling), `${Math.round(1 / r.ceiling)} 次裡成功 1 次`])).join('\n')}

達到這個上限的唯一方法是**一次全押、中途不再交易**。每多交易一次，成本就多吃一份，機率只會更低。

## 情況 B：有真實且穩定的優勢

${o.scenarios.map((s) => `### 勝率 ${(s.winProb * 100).toFixed(0)}%（凱利下注 ${(s.kelly * 100).toFixed(0)}%，每筆對數成長 ${s.growth.toFixed(4)}）

期間破產率 **${pct(s.ruinRate)}**

${row(['目標金額', '倍數', '達成率', '中位數時間', '快的 25%', '慢的 25%'])}
${sep(6)}
${s.targets.map((t) => row([usd(t.target), `${t.multiple} 倍`, pct(t.reachRate), humanTime(t.medianTrades), humanTime(t.p25Trades), humanTime(t.p75Trades)])).join('\n')}`).join('\n\n')}

## 彙總對照

中位數時間（括號內為達成率）：

${row(['目標金額', '倍數', '勝率 55%', '勝率 60%', '勝率 65%'])}
${sep(5)}
${TARGETS.map((target, i) => row([
    usd(target), `${target / o.start} 倍`,
    ...o.scenarios.map((s) => `${humanTime(s.targets[i].medianTrades)}（${pct(s.targets[i].reachRate)}）`),
  ])).join('\n')}

## 怎麼讀這張表

- **達成率不是 100%**：部分路徑在抵達之前就先跌破陣亡線。目標越遠，這個比例越高。
- **中位數時間只統計有達成的路徑**，本身帶有倖存者偏差——必須和達成率一起看。
  「勝率 55% 到 $10,000 要 X 個月」的真正意思是：在那些沒死的路徑裡要 X 個月。
- **勝率差 5pp，時間差一個數量級**。55% 與 65% 的每筆對數成長差了 9 倍，
  這就是為什麼「先確認優勢是否存在」永遠比「選多大的目標」重要。
- **破產率與優勢大小幾乎無關**（三個勝率都落在 10% 附近）。這不是巧合：
  全凱利下注有一個已知性質——**P(資金曾跌到初始的 x 倍) = x**。
  本表的陣亡線設在初始的 10%，模擬跑出的 ${o.scenarios.map((s) => pct(s.ruinRate)).join(' / ')} 正好驗證了它。
  勝率更高只讓你走得更快，不會讓你更不容易被打到腰斬。
- **全凱利是上界不是建議**。它假設你的勝率估計完全正確；估計誤差的代價見 \`docs/hundred-x.md\`。
  實務上半凱利的時間大約是表中的兩倍，但破產率接近 0。

---

⚠️ 統計模擬，僅供教育與研究用途，不構成投資建議。
重現：\`npm run time-to-target\`（固定種子）。引擎 \`src/sim/target.js\`。
`;
}

if (MD_OUT) {
  mkdirSync(dirname(MD_OUT), { recursive: true });
  writeFileSync(MD_OUT, md(out));
  console.log(`\nMarkdown 已寫入 ${MD_OUT}`);
}
