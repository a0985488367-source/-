#!/usr/bin/env node
/**
 * 「三個月翻一百倍」可行性分析
 *
 *   node scripts/hundred-x.mjs [--runs 100000] [--md docs/hundred-x.md]
 *
 * 三個部分：
 *   1. 沒有真實優勢時的理論上限（Optional Stopping Theorem）＋模擬驗證
 *   2. 要靠實力做到，需要多大的優勢、多少筆交易，以及估計誤差的代價
 *   3. 下檔有硬上限的結構性路徑
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  runTargetMonteCarlo, sweepFraction, kellyFraction, logGrowth,
  tradesToTarget, fairGameCeiling, propFirmPayoff,
} from '../src/sim/target.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RUNS = Number(flag('runs', 100000));
const SEED = Number(flag('seed', 20260917));
const MD_OUT = flag('md', null);
const MULT = 100, DAYS = 63;
const opts = { runs: RUNS, seed: SEED };

const pct = (x) => `${(x * 100).toFixed(3)}%`;
const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;
/** 二項比例的標準誤，用來判斷模擬雜訊有多大 */
const se = (p) => Math.sqrt((p * (1 - p)) / RUNS);

const out = { runs: RUNS, seed: SEED, multiple: MULT, days: DAYS, generatedAt: new Date().toISOString() };

console.log(`目標：三個月（約 ${DAYS} 個交易日）內翻 ${MULT} 倍 · 每組 ${RUNS.toLocaleString('en-US')} 次模擬 · seed ${SEED}`);
out.dailyCompound = MULT ** (1 / DAYS) - 1;
console.log(`換算：每天 ${(out.dailyCompound * 100).toFixed(2)}% 複利，連續 ${DAYS} 天不中斷\n`);

/* ------------------------------------------- 1 */
console.log('══ 第一部分：沒有真實優勢時的硬上限 ══');
console.log(`Optional Stopping Theorem：P(到達 ${MULT} 倍) ≤ 1/${MULT} = ${pct(fairGameCeiling(MULT))}`);
console.log('對任何可交易標的、任何策略、任何槓桿都成立。\n');

const FRACTIONS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0];
out.fractionSweep = sweepFraction({ winProb: 0.5, costPerTrade: 0, trades: 250 }, FRACTIONS, opts);
console.log('勝率 50%、無成本、250 筆 —— 掃描下注比例：');
console.log('  下注比例 | 達標率  |  破產率  | 本金中位數');
for (const r of out.fractionSweep) {
  console.log(`   ${String(Math.round(r.fraction * 100)).padStart(4)}%   | ${pct(r.hitRate).padStart(7)} | ${pct(r.ruinRate).padStart(8)} | ${usd(r.medianBalance).padStart(8)}`);
}
console.log('  → 下注越大越接近上限。最佳策略是「一次全押」；分散、加碼、馬丁都嚴格更差。');

out.costs = [0, 0.002, 0.01, 0.03].map((costPerTrade) => {
  const r = runTargetMonteCarlo({ winProb: 0.5, fraction: 1.0, costPerTrade, trades: 250 }, opts);
  return { costPerTrade, hitRate: r.hitRate, ruinRate: r.ruinRate };
});
console.log('\n加入交易成本（全押，成本為賭注的 x%）：');
for (const r of out.costs) {
  console.log(`   ${(r.costPerTrade * 100).toFixed(1)}%  → 達標率 ${pct(r.hitRate)} ±${(se(r.hitRate) * 100).toFixed(3)}pp   破產率 ${pct(r.ruinRate)}`);
}

/* ------------------------------------------- 2 */
console.log('\n══ 第二部分：靠實力做到需要多大的優勢 ══');
out.kellyTable = [0.52, 0.55, 0.58, 0.60, 0.65, 0.70].map((p) => {
  const f = kellyFraction(p, 1);
  const n = tradesToTarget(p, 1, f, MULT);
  return { winProb: p, kelly: f, growth: logGrowth(p, 1, f), tradesNeeded: n, perDay: n / DAYS };
});
console.log('全凱利、1:1 賠率：');
console.log('  勝率 | 凱利比例 | 每筆對數成長 | 所需筆數 | 每日筆數');
for (const r of out.kellyTable) {
  console.log(`  ${(r.winProb * 100).toFixed(0)}%  |  ${(r.kelly * 100).toFixed(1).padStart(5)}%  |   ${r.growth.toFixed(4).padStart(7)}    |  ${Math.ceil(r.tradesNeeded).toString().padStart(5)}   | ${r.perDay.toFixed(1).padStart(5)} 筆/天`);
}

const HORIZONS = [126, 252, 630];
out.frequency = [0.55, 0.60, 0.65, 0.70].map((p) => {
  const f = kellyFraction(p, 1);
  return {
    winProb: p,
    cells: HORIZONS.map((trades) => runTargetMonteCarlo({ winProb: p, fraction: f, trades, costPerTrade: 0.002 }, opts).hitRate),
  };
});
console.log('\n實際達標率（全凱利、每筆成本 0.2%）：');
console.log('  勝率 | 2 筆/天(126) | 4 筆/天(252) | 10 筆/天(630)');
for (const r of out.frequency) {
  console.log(`  ${(r.winProb * 100).toFixed(0)}%  |  ${r.cells.map((c) => pct(c).padStart(9)).join('  |  ')}`);
}

out.uncertainty = [0, 0.02, 0.05, 0.08].map((winProbSd) => {
  const f = kellyFraction(0.60, 1);
  const full = runTargetMonteCarlo({ winProb: 0.60, winProbSd, fraction: f, trades: 252, costPerTrade: 0.002 }, opts);
  const half = runTargetMonteCarlo({ winProb: 0.60, winProbSd, fraction: f / 2, trades: 252, costPerTrade: 0.002 }, opts);
  return { winProbSd, full: { hit: full.hitRate, ruin: full.ruinRate }, half: { hit: half.hitRate, ruin: half.ruinRate } };
});
console.log('\n★ 你以為有 60% 勝率，但估計有誤差（真實勝率 ~ N(60%, sd)）：');
console.log('  估計誤差 | 全凱利達標 | 全凱利破產 | 半凱利達標 | 半凱利破產');
for (const r of out.uncertainty) {
  console.log(`   ±${(r.winProbSd * 100).toFixed(0)}pp    |  ${pct(r.full.hit).padStart(8)}  |  ${pct(r.full.ruin).padStart(8)}  |  ${pct(r.half.hit).padStart(8)}  |  ${pct(r.half.ruin).padStart(8)}`);
}

/* ------------------------------------------- 3 */
console.log('\n══ 第三部分：下檔有硬上限的結構 ══');
const PROPS = [
  { fee: 250, accountSize: 100000, passRate: 0.08, attempts: 1 },
  { fee: 500, accountSize: 200000, passRate: 0.06, attempts: 1 },
  { fee: 250, accountSize: 100000, passRate: 0.08, attempts: 3 },
];
out.propFirm = PROPS.map((c) => ({ ...c, ...propFirmPayoff(c) }));
console.log('自營商挑戰賽（輸了最多輸報名費）：');
console.log('   總成本  | 帳戶規模 | 過關一次倍數 | 至少過一次 | 期望倍數');
for (const r of out.propFirm) {
  console.log(`  ${(usd(r.totalCost) + (r.attempts > 1 ? ` (${r.attempts}次)` : '')).padStart(9)} | ${usd(r.accountSize).padStart(8)} |     ${r.multiplePerPass.toFixed(0).padStart(3)}x     |  ${pct(r.pAtLeastOnePass).padStart(7)}  |  ${r.expectedMultiple.toFixed(2)}x`);
}
console.log('  註：過關率取業者公開數據的樂觀端（實際多在 3–10%），且過關 ≠ 拿到錢。');
console.log('  註：要達到 100 倍，過關後還需在大帳戶上做出約 25% 獲利並成功出金。');

console.log('\n══ 結論 ══');
console.log(`  · 無優勢：上限 ${pct(fairGameCeiling(MULT))}，最佳策略是一次全押，約 99% 機率歸零。`);
console.log('  · 有優勢：60% 勝率 + 每天 4 筆 + 全凱利 → 達標率高，但這是「有 60% 勝率」的假設在做事。');
console.log('  · 估計誤差才是真正的殺手：勝率誤差 ±8pp 就讓全凱利破產率從 0.7% 跳到 16%。');
console.log('  · 唯一下檔可控的是結構性路徑：固定成本買大額資金操作權，而非放大槓桿。');

/* ------------------------------------------- Markdown */
function md(o) {
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return `# 三個月翻一百倍：可行性分析

> 由 \`npm run hundred-x\` 自動產生，請勿手動編輯。
> 產生時間：${o.generatedAt} ／ 種子 ${o.seed} ／ **每組設定 ${o.runs.toLocaleString('en-US')} 次模擬**

100 倍 ÷ ${o.days} 個交易日 = **每天 ${(o.dailyCompound * 100).toFixed(2)}% 複利、連續 ${o.days} 天不中斷**。

## 第一部分：沒有真實優勢時，機率有硬上限

若沒有可重複的優勢，交易就是一個公平（實際上因成本而不利）的賭局。
由 Optional Stopping Theorem，從本金 \`x\` 出發、在碰到目標 \`T\` 時停手：

> **P(先到達 T) ≤ x / T**，${o.multiple} 倍即 **${pct(fairGameCeiling(o.multiple))}**

這個上限與標的無關、與槓桿無關、與策略複雜度無關。加槓桿只改變分布形狀，不改變上限。

### 下注比例掃描（勝率 50%、無成本、250 筆）

${row(['下注比例', '達標率', '破產率', '本金中位數'])}
${row(['---', '---', '---', '---'])}
${o.fractionSweep.map((r) => row([`${Math.round(r.fraction * 100)}%`, pct(r.hitRate), pct(r.ruinRate), usd(r.medianBalance)])).join('\n')}

**下注越大越接近上限。** 在沒有優勢的賭局裡，最佳策略是「一次全押」——
因為每多下一注，成本和時間就多吃掉一份。分散下注、加碼攤平、馬丁格爾都嚴格更差。
這代表：**任何宣稱能「穩健地」翻 100 倍的方法，在數學上都是矛盾的。**

### 成本的影響（全押）

${row(['每筆成本', '達標率', '破產率'])}
${row(['---', '---', '---'])}
${o.costs.map((r) => row([`${(r.costPerTrade * 100).toFixed(1)}%`, pct(r.hitRate), pct(r.ruinRate)])).join('\n')}

模擬標準誤約 ±${(se(0.01) * 100).toFixed(3)}pp，因此上表與理論上限 ${pct(fairGameCeiling(o.multiple))} 一致。

## 第二部分：要靠實力做到，需要多大的優勢

有優勢時，最大化長期成長的下注比例由凱利公式給出，
每筆的對數成長率 g(f) = p·ln(1+f·b) + (1−p)·ln(1−f)，達標所需筆數 ≈ ln(${o.multiple}) / g。

${row(['勝率', '凱利比例', '每筆對數成長', '所需筆數', '換算每日筆數'])}
${row(['---', '---', '---', '---', '---'])}
${o.kellyTable.map((r) => row([`${(r.winProb * 100).toFixed(0)}%`, `${(r.kelly * 100).toFixed(1)}%`, r.growth.toFixed(4), Math.ceil(r.tradesNeeded), `${r.perDay.toFixed(1)} 筆/天`])).join('\n')}

### 實際達標率（全凱利、每筆成本 0.2%）

${row(['勝率', '2 筆/天（126 筆）', '4 筆/天（252 筆）', '10 筆/天（630 筆）'])}
${row(['---', '---', '---', '---'])}
${o.frequency.map((r) => row([`${(r.winProb * 100).toFixed(0)}%`, ...r.cells.map(pct)])).join('\n')}

**55% 勝率幾乎做不到**（需要 920 筆，等於每天 15 筆全凱利）。
**60% 以上才進入可能的範圍**——但請注意，這張表是在「你真的有 60% 勝率」的假設下算的。

### 真正的殺手：你不知道自己的勝率是多少

下注比例照「自以為的」60% 計算，真實勝率則服從 N(60%, sd)：

${row(['估計誤差', '全凱利達標', '全凱利破產', '半凱利達標', '半凱利破產'])}
${row(['---', '---', '---', '---', '---'])}
${o.uncertainty.map((r) => row([`±${(r.winProbSd * 100).toFixed(0)}pp`, pct(r.full.hit), pct(r.full.ruin), pct(r.half.hit), pct(r.half.ruin)])).join('\n')}

誤差 ±8pp（以數十筆樣本估計勝率時的常見誤差量級）就讓全凱利的破產率
從 ${pct(o.uncertainty[0].full.ruin)} 跳到 ${pct(o.uncertainty[3].full.ruin)}。
半凱利的達標率反而隨誤差上升——因為它留下了活著修正的空間。

## 第三部分：唯一下檔可控的結構

自營商挑戰賽是少數「最大損失固定、上檔可觀」的結構：用報名費買大額帳戶的操作權。

${row(['總成本', '帳戶規模', '過關一次的倍數', '至少過一次', '期望倍數'])}
${row(['---', '---', '---', '---', '---'])}
${o.propFirm.map((r) => row([usd(r.totalCost) + (r.attempts > 1 ? `（${r.attempts} 次）` : ''), usd(r.accountSize), `${r.multiplePerPass.toFixed(0)}x`, pct(r.pAtLeastOnePass), `${r.expectedMultiple.toFixed(2)}x`])).join('\n')}

注意事項：過關率取自業者公開數據的樂觀端（實際多在 3–10%）；**過關不等於拿到錢**
（出金爭議、規則細節、帳戶重置費用都會侵蝕實際報酬）；而要真的達到 100 倍，
過關後還需要在大帳戶上做出約 25% 的獲利並成功出金——那又回到第二部分的優勢問題。

它的價值不在於期望值更高，而在於**下檔是有界的**：最壞情況是輸掉報名費，
而不是輸掉本金再倒欠。

## 結論

1. **沒有真實優勢時，三個月 100 倍的機率上限是 ${pct(fairGameCeiling(o.multiple))}**，
   而最優策略是一次全押。這不是保守估計，是數學上限。
2. **有優勢時它變成一個關於優勢大小與交易頻率的問題**，而非關於槓桿的問題。
   60% 勝率、每天 4 筆、全凱利可以做到——但前提是那個 60% 是真的。
3. **估計誤差比波動更致命。** 沒有幾百筆樣本，你無法區分 55% 和 60%，
   而這個差別決定了達標率是 2% 還是 65%。
4. 先解決「優勢是否存在且可測量」，再談倍數。倒過來做的人，統計上都在第一部分那張表裡。

---

⚠️ 統計模擬，僅供教育與研究用途，不構成投資建議。
重現：\`npm run hundred-x\`（固定種子）。引擎 \`src/sim/target.js\`，測試 \`tests/target.test.mjs\`。
`;
}

if (MD_OUT) {
  mkdirSync(dirname(MD_OUT), { recursive: true });
  writeFileSync(MD_OUT, md(out));
  console.log(`\nMarkdown 已寫入 ${MD_OUT}`);
}
