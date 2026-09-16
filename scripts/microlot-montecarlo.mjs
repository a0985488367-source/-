#!/usr/bin/env node
/**
 * 微手數／高槓桿帳戶回測（蒙地卡羅）
 *
 *   node scripts/microlot-montecarlo.mjs                 # 全部情境，各 10000 次
 *   node scripts/microlot-montecarlo.mjs --runs 10000 --scenario video
 *   node scripts/microlot-montecarlo.mjs --json docs/microlot-backtest.json
 *
 * 情境定義見下方 SCENARIOS；基準參數（本金、張數、點差、出場）取自
 * 影片中 MT5 / XAUUSDm 帳戶的實際畫面，見 src/sim/microlot.js 註解。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, runMonteCarlo, minimumViableAccount, lotsFor } from '../src/sim/microlot.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RUNS = Number(flag('runs', 10000));
const SEED = Number(flag('seed', 20260915));
const ONLY = flag('scenario', null);
const JSON_OUT = flag('json', null);
const MD_OUT = flag('md', null);

/** 各情境都只改動與該問題相關的參數，其餘沿用影片基準 */
const SCENARIOS = [
  {
    key: 'video',
    title: '影片原樣（無方向優勢）',
    note: '$7.20 本金、張數隨本金加碼、無停損、+1.35/oz 出場',
    cfg: {},
  },
  {
    key: 'skilled',
    title: '同樣操作，但方向勝率 55%',
    note: '假設他真的看得懂盤，略優於擲硬幣',
    cfg: { edgeWinRate: 0.55 },
  },
  {
    key: 'pro',
    title: '同樣操作，但方向勝率 60%',
    note: '職業級的方向判斷',
    cfg: { edgeWinRate: 0.60 },
  },
  {
    key: 'elite',
    title: '同樣操作，但方向勝率 70%',
    note: '現實中極罕見的準確度',
    cfg: { edgeWinRate: 0.70 },
  },
  {
    key: 'fixed5',
    title: '固定 5 張不加碼（勝率 55%）',
    note: '賺錢不加碼，本金變厚 → 爆倉距離變遠',
    cfg: { edgeWinRate: 0.55, sizing: 'fixed', fixedLots: 5 },
  },
  {
    key: 'stoploss',
    title: '同樣倉位但設停損 0.40/oz（勝率 55%）',
    note: '唯一改動：加上停損',
    cfg: { edgeWinRate: 0.55, stopLossMove: 0.40 },
  },
  {
    key: 'sane',
    title: '對照組：$500 本金、1 張、停損 4.0/oz（勝率 55%）',
    note: '每筆風險 0.8%，其餘條件相同',
    cfg: {
      balance: 500, sizing: 'fixed', fixedLots: 1,
      stopLossMove: 4.0, takeProfitMove: 8.0, edgeWinRate: 0.55,
      maxHoldMinutes: 1440, ruinBalance: 50,
    },
  },
];

/** 波動率敏感度（只對影片原樣情境做） */
const VOL_GRID = [
  { key: 'vol-quiet', title: '影片原樣 · 安靜盤（日波動 0.5%）', cfg: { volDaily: 0.005 } },
  { key: 'vol-normal', title: '影片原樣 · 常態（日波動 1.0%）', cfg: {} },
  { key: 'vol-active', title: '影片原樣 · 活躍盤（日波動 1.8%）', cfg: { volDaily: 0.018 } },
];

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : '—');
const num = (x) => (Number.isFinite(x) ? String(x) : '—');

function report(entry, res) {
  const s = res.survival.map((p) => `${p.trades}筆:${(p.alive * 100).toFixed(1)}%`).join('  ');
  console.log(`\n── ${entry.title} ──────────────────────────────`);
  if (entry.note) console.log(`   ${entry.note}`);
  console.log(`   破產率            ${pct(res.ruinRate)}   （其中券商強平 ${pct(res.stopOutRate)}）`);
  console.log(`   最終仍獲利        ${pct(res.profitable)}`);
  console.log(`   期末本金 中位數   ${usd(res.endBalance.median)}   平均 ${usd(res.endBalance.mean)}`);
  console.log(`             p05/p95 ${usd(res.endBalance.p05)} / ${usd(res.endBalance.p95)}   最佳 ${usd(res.endBalance.max)}`);
  console.log(`   曾經帳面翻倍      ${pct(res.everDoubled)}  → 其中最後仍歸零 ${pct(res.doubledThenRuined)}`);
  if (res.hitLotCapRate > 0) console.log(`   碰到券商手數上限  ${pct(res.hitLotCapRate)}   （等於被迫停止加碼，才脫離這個規則）`);
  if (res.ruinRate > 0) {
    console.log(`   破產前撐過交易數  中位數 ${num(res.tradesToRuin.median)}  (p25 ${num(res.tradesToRuin.p25)} / p75 ${num(res.tradesToRuin.p75)})`);
    console.log(`   破產前撐過時間    中位數 ${num(res.minutesToRuin.median)} 分鐘`);
  } else {
    console.log('   破產前撐過交易數  —（無任何帳戶破產）');
  }
  console.log(`   首筆交易          獲利 ${pct(res.firstTradeWinRate)} / 直接爆倉 ${pct(res.firstTradeRuinRate)}`);
  console.log(`   存活曲線          ${s}`);
}

const out = { runs: RUNS, seed: SEED, generatedAt: new Date().toISOString(), base: DEFAULT_CONFIG, scenarios: {} };

console.log(`微手數帳戶蒙地卡羅回測  ·  每情境 ${RUNS.toLocaleString('en-US')} 次獨立帳戶  ·  seed ${SEED}`);
console.log(`基準：XAUUSD @ ${DEFAULT_CONFIG.price}，本金 ${usd(DEFAULT_CONFIG.balance)}，`
  + `開倉 ${lotsFor(DEFAULT_CONFIG.balance, DEFAULT_CONFIG)} 張 × 0.01 手，點差 ${DEFAULT_CONFIG.spread}/oz，`
  + `上限 ${DEFAULT_CONFIG.maxTrades} 筆交易`);

const t0 = Date.now();
for (const entry of [...SCENARIOS, ...VOL_GRID]) {
  if (ONLY && entry.key !== ONLY) continue;
  const res = runMonteCarlo(entry.cfg, { runs: RUNS, seed: SEED });
  out.scenarios[entry.key] = { title: entry.title, note: entry.note ?? '', ...res };
  report(entry, res);
}

/* 風險可控所需的最低本金（受最小 0.01 手 = 1 盎司限制） */
console.log('\n── 最小交易單位反推：黃金要「風險可控」至少需要多少本金 ──');
for (const stop of [1, 2, 4, 8]) {
  console.log(`   停損 ${usd(stop)}/oz（1 張） → 每筆風險 1% 需本金 ${usd(minimumViableAccount(stop, 1))}`
    + `，2% 需 ${usd(minimumViableAccount(stop, 2))}`);
}
out.minimumViableAccount = Object.fromEntries(
  [1, 2, 4, 8].map((s) => [`stop_${s}`, { risk1pct: minimumViableAccount(s, 1), risk2pct: minimumViableAccount(s, 2) }]),
);

console.log(`\n完成，耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`JSON 已寫入 ${JSON_OUT}`);
}

/* ------------------------------------------------------------ Markdown */

function renderMarkdown(o) {
  const S = o.scenarios;
  const row = (k) => {
    const v = S[k];
    if (!v) return '';
    const ttr = Number.isFinite(v.tradesToRuin.median) ? v.tradesToRuin.median : '—';
    const mtr = Number.isFinite(v.minutesToRuin.median) ? `${v.minutesToRuin.median} 分` : '—';
    return `| ${v.title} | **${pct(v.ruinRate)}** | ${pct(v.profitable)} | ${usd(v.endBalance.median)} | ${ttr} | ${mtr} |`;
  };
  const survRow = (k) => {
    const v = S[k];
    if (!v) return '';
    return `| ${v.title} | ${v.survival.map((p) => pct(p.alive)).join(' | ')} |`;
  };
  const marks = (S.video?.survival ?? []).map((p) => `${p.trades} 筆`);
  const keys = Object.keys(S);
  const main = keys.filter((k) => !k.startsWith('vol-'));
  const vols = keys.filter((k) => k.startsWith('vol-'));

  return `# 微手數／高槓桿帳戶回測報告

> 由 \`npm run backtest\` 自動產生，請勿手動編輯。
> 產生時間：${o.generatedAt} ／ 亂數種子：${o.seed} ／ **每個情境 ${o.runs.toLocaleString('en-US')} 次獨立帳戶模擬**

## 這份報告在回答什麼

社群媒體上常見這類影片：幾美元本金、黃金微手數疊單、幾分鐘翻倍。
本報告不評論任何個人，而是把該**倉位與風險模型**抽出來，問一個可量化的問題：

> 同一套規則跑一萬次，結果的分布長什麼樣？

## 基準參數（取自影片實際畫面）

| 項目 | 值 | 依據 |
|---|---|---|
| 商品 | XAUUSD @ ${o.base.price} | 畫面為 XAUUSDm M15 |
| 起始本金 | ${usd(o.base.balance)} | Balance: 7.20 |
| 倉位規則 | 張數 = round(本金 / ${o.base.lotDivisor}) | 本金 4.52 → 3 張、7.20 → 5 張，兩點吻合 |
| 每張 | 0.01 手 = 1 盎司，金價每動 \$1 = 損益 \$1 | 畫面 4385.435 → 4386.784 顯示 +1.34 |
| 出場 | 順向 +${o.base.takeProfitMove}/oz | 5 張合計 +5.78 USD |
| 停損 | 無 | 畫面未見停損 |
| 點差 | ${o.base.spread}/oz，開倉付清 | 一般黃金點差區間 |
| 強平 | 淨值 ≤ 0（0% 強平） | Free Margin = Equity，屬無限槓桿類帳戶 |
| 模擬上限 | ${o.base.maxTrades} 筆交易 | 約數個交易日的操作量 |

**槓桿實況**：5 盎司 × ${o.base.price} = 名目 \$${(5 * o.base.price).toLocaleString('en-US')}，
對 ${usd(o.base.balance)} 本金＝有效槓桿約 **${Math.round((5 * o.base.price) / o.base.balance).toLocaleString('en-US')} 倍**。
爆倉距離 = (本金 − 點差成本) ÷ 張數 ≈ **\$${(((o.base.balance - 5 * o.base.spread) / 5)).toFixed(2)}/oz**，
約為金價的 **${((((o.base.balance - 5 * o.base.spread) / 5) / o.base.price) * 100).toFixed(3)}%**。

## 主要結果

| 情境 | 破產率 | 最終獲利 | 期末本金中位數 | 破產前交易數中位數 | 存活時間中位數 |
|---|---|---|---|---|---|
${main.map(row).join('\n')}

### 存活曲線（撐過 N 筆交易仍未破產的比例）

| 情境 | ${marks.join(' | ')} |
|---|${marks.map(() => '---').join('|')}|
${main.map(survRow).join('\n')}

### 波動率敏感度（影片原樣情境）

| 情境 | 破產率 | 最終獲利 | 存活時間中位數 |
|---|---|---|---|
${vols.map((k) => {
    const v = S[k];
    const mtr = Number.isFinite(v.minutesToRuin.median) ? `${v.minutesToRuin.median} 分` : '—';
    return `| ${v.title} | **${pct(v.ruinRate)}** | ${pct(v.profitable)} | ${mtr} |`;
  }).join('\n')}

波動率高低不改變結論，只改變**死得多快**。

## 三個關鍵發現

**1. 影片畫面是真的，結論是假的。**
影片原樣情境中有 **${pct(S.video?.everDoubled ?? 0)}** 的帳戶「曾經」帳面翻倍——這就是這類影片的素材來源。
但這些曾經翻倍的帳戶，最後有 **${pct(S.video?.doubledThenRuined ?? 0)}** 仍然歸零。
你看到的兩分鐘，是一萬條路徑裡被挑出來的那一段。

**2. 有沒有「看盤功力」幾乎救不了這個倉位。**
把方向勝率從 50% 一路調到 70%（現實中極罕見的準確度），破產率只從
${pct(S.video?.ruinRate ?? 0)} 降到 ${pct(S.elite?.ruinRate ?? 0)}。
原因是數學而非運氣：**每筆下注都押上接近 100% 的本金**，賺錢又立刻按比例加碼，
長期對數成長率為負無窮。這是固定比例下注的已知結果，與看不看得準無關。

**3. 加停損不夠，因為錯的是倉位大小。**
「同樣倉位 + 停損 ${o.base.balance ? '0.40/oz' : ''}」情境的破產率仍是 ${pct(S.stoploss?.ruinRate ?? 0)}。
5 張 × 0.40 + 點差 = 每次認賠約 \$3.00，佔 ${usd(o.base.balance)} 本金的 42%。
停損只是把「一次死」換成「三次死」。
唯一明顯改善的是**不加碼**（${pct(S.fixed5?.ruinRate ?? 0)}），以及把本金放大到能正常控制風險的對照組（${pct(S.sane?.ruinRate ?? 0)}）。

## 最小交易單位的硬限制

黃金最小 0.01 手 = 1 盎司，這是「本金多小算太小」的客觀下限：

| 停損（USD/oz） | 每筆風險 1% 所需本金 | 每筆風險 2% 所需本金 |
|---|---|---|
${[1, 2, 4, 8].map((s) => `| ${usd(s)} | ${usd(o.minimumViableAccount[`stop_${s}`].risk1pct)} | ${usd(o.minimumViableAccount[`stop_${s}`].risk2pct)} |`).join('\n')}

黃金 M15 的合理停損通常在 \$4–8/oz，因此**要以 1–2% 風險交易黃金，本金至少數百美元起跳**。
低於這個門檻，不是「技術問題」，是連最小一張都放不下。

## 方法與限制

- **這是蒙地卡羅，不是歷史回測。** 價格以分鐘級算術布朗運動模擬（σ 依當前價位換算為 USD/oz，
  單筆交易內固定），含厚尾（常態尺度混合）與
  波動聚集（每筆交易的波動率對數常態擾動），波動率以黃金真實區間校準（日 σ 0.5% / 1.0% / 1.8%）。
  產生本報告的環境無法連外取得歷史行情，且單一段歷史只有一條路徑，本來就回答不了「一萬次會怎樣」。
- **方向優勢的定義**：勝率指在對稱 ±${o.base.takeProfitMove}/oz 障壁下猜對方向的機率，
  透過 μ = ln(p/(1−p))·σ²/(2a) 轉為價格漂移。此校準有單元測試驗證。
- **未建模的成本**（都對結論不利）：隔夜利息、重大數據時的點差擴大、強平滑價（實際可能穿透到負值）、
  券商保證金分層（會比模擬的手數上限更早限制加碼）。
- **微結構**：真實分鐘級價格有輕微均值回歸，會略微降低障壁首次通過機率；
  但爆倉距離僅約 1 分鐘標準差，此效應不足以改變結論。
- 重現：\`npm run backtest\`（固定種子，結果可重現）。模擬引擎：\`src/sim/microlot.js\`，單元測試 \`tests/microlot.test.mjs\`。

---

⚠️ 本報告為統計模擬，僅供教育與研究用途，不構成投資建議。
`;
}

if (MD_OUT) {
  mkdirSync(dirname(MD_OUT), { recursive: true });
  writeFileSync(MD_OUT, renderMarkdown(out));
  console.log(`Markdown 已寫入 ${MD_OUT}`);
}
