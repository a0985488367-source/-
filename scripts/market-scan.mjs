/**
 * 全市場掃描：把交易所上所有 USDT 交易對跑過一遍，
 * 產出「現在可進場」與「等待回測」兩份清單。
 *
 *   node scripts/market-scan.mjs                完整掃描
 *   node scripts/market-scan.mjs --if-stale=45  若上次掃描未滿 45 分鐘就跳過
 *   node scripts/market-scan.mjs --top=60       只掃成交量前 60 名
 *
 * 設計考量：
 *  - 依 24 小時成交額排序取前 N 名，過濾穩定幣與槓桿代幣（流動性太差的訊號沒有意義）
 *  - 兩階段掃描：先用單一週期粗篩，再對入選者補抓高週期偏向做精算，
 *    這樣 API 用量與時間都能壓在 GitHub Actions 的合理範圍內
 *  - 結果寫成 data/market.json 供網站直接讀取，瀏覽器不必自己打上百次 API
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scanMarket } from '../src/market/scan.js';
import { DERIV_PROVIDERS, fetchAllOpenInterest, snapshotChange } from '../src/data/derivatives.js';
import { derivativesVerdict, oiChangePct } from '../src/smc/derivatives.js';

const ARGS = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const DATA_DIR = process.env.SMC_DATA_DIR || 'data';
const OUT_JSON = `${DATA_DIR}/market.json`;
const OUT_MD = `${DATA_DIR}/market.md`;

const TOP = Number(opt('top', 120));
const INTERVAL = opt('interval', '1h');
const CONCURRENCY = Number(opt('concurrency', 8));
const STALE_MIN = Number(opt('if-stale', 0));
const PROVIDER_IDS = opt('providers', 'binance,okx,bybit').split(',');
const MIN_SCORE = Number(opt('min-score', 50));
const DETAIL_TOP = Number(opt('detail', 30));
/** 要補抓資金費率／未平倉量的檔數（只針對進榜的） */
const DERIV_TOP = Number(opt('deriv', 80));

const log = (...a) => console.log(...a);
const digitsFor = (p) => (Math.abs(p) >= 10000 ? 1 : Math.abs(p) >= 100 ? 2 : Math.abs(p) >= 1 ? 4 : Math.abs(p) >= 0.01 ? 5 : 7);
const price = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: digitsFor(v), maximumFractionDigits: digitsFor(v) }));

async function isFresh() {
  if (!STALE_MIN) return false;
  try {
    const prev = JSON.parse(await readFile(OUT_JSON, 'utf8'));
    const age = (Date.now() - new Date(prev.generatedAt).getTime()) / 60000;
    if (age < STALE_MIN) {
      log(`上次掃描是 ${age.toFixed(0)} 分鐘前（未滿 ${STALE_MIN} 分鐘），這次跳過。`);
      return true;
    }
  } catch {}
  return false;
}

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

/**
 * 補上資金費率與未平倉量。
 *
 * 未平倉量不走交易所的「歷史」端點 —— 實測 OKX 的 rubik 只涵蓋主流幣，
 * 13 檔進榜幣種裡只有 2 檔拿得到序列，等於這半邊形同虛設。
 * 改成：一次抓回全市場的「目前未平倉量」，再跟上一次掃描存下來的數值相比。
 * 涵蓋率從 2/13 變成所有 OKX 永續都有。
 *
 * 這是加分資訊，任何一步失敗都只是少了這段資料，
 * 絕不能讓整個市場掃描跟著失敗。
 */
async function attachDerivatives(list, prevRows) {
  if (!list.length) return;

  // 上一次掃描的未平倉量快照，用來算變化率
  const prevOi = new Map();
  for (const r of prevRows ?? []) {
    if (r?.deriv?.oiValue > 0 && r.deriv.oiAt) prevOi.set(r.symbol, { value: r.deriv.oiValue, time: r.deriv.oiAt });
  }

  let oiNow = new Map();
  try {
    oiNow = await fetchAllOpenInterest();
    log(`  未平倉量快照：全市場 ${oiNow.size} 個永續合約`);
  } catch (e) {
    log(`  ⚠️ 未平倉量快照取得失敗（${e.message}），這次只會有資金費率`);
  }

  let done = 0;
  let ok = 0;
  let withOi = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      done++;
      try {
        // 只打 OKX：Binance 永續與 Bybit 都擋美國 IP，而這支跑在 GitHub 的機器上
        const raw = await DERIV_PROVIDERS.okx.fetch(r.symbol);
        const now = oiNow.get(r.symbol) ?? null;
        const change = snapshotChange(now, prevOi.get(r.symbol) ?? null);
        const oiPct = change?.pct ?? null;
        const v = derivativesVerdict({
          dir: r.dir,
          funding: raw.fundingRate,
          priceChangePct: r.changePct ?? 0,
          oiChangePct: oiPct,
        });
        r.deriv = {
          provider: raw.provider,
          fundingRate: raw.fundingRate,
          fundingLevel: v.funding.level,
          fundingSide: v.funding.side,
          fundingAnnualPct: r2(v.fundingAnnualPct),
          oiChangePct: r2(oiPct),
          oiHours: change ? r2(change.hours) : null,
          // 存下這次的絕對值，下一次掃描才算得出變化率
          oiValue: now?.value ?? null,
          oiAt: now?.time ?? null,
          regime: v.regime.key,
          regimeZh: v.regime.zh,
          score: v.score,
          note: v.notes[0] ?? null,
        };
        ok++;
        if (Number.isFinite(oiPct)) withOi++;
      } catch { /* 這一檔沒有永續合約或來源暫時掛掉，略過 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  log(`  衍生品資料：${ok}/${done} 檔有資金費率，其中 ${withOi} 檔算得出未平倉量變化`);
  if (ok && !withOi) log('  （第一次掃描沒有基準可比，下一次就會有未平倉量變化）');
}

/** 讀上一次掃描的結果，只為了拿未平倉量的基準值 */
async function previousRows() {
  try {
    return JSON.parse(await readFile(OUT_JSON, 'utf8')).rows ?? [];
  } catch { return []; }
}

async function main() {
  if (await isFresh()) return;
  const t0 = Date.now();

  log(`取得交易對清單…掃描前 ${TOP} 名（${PROVIDER_IDS.join('/')}）…`);
  const out = await scanMarket({
    providerIds: PROVIDER_IDS,
    top: TOP,
    interval: INTERVAL,
    concurrency: CONCURRENCY,
    minScore: MIN_SCORE,
    detailTop: DETAIL_TOP,
  });
  log(`資料源 ${out.provider}｜候選 ${out.universe} 個交易對（依 24h 成交額排序）`);
  log(`粗篩完成：掃了 ${out.scanned} 個（另有 ${out.skippedLowVolatility} 個因波動度過低被排除）`);

  const ready = out.rows.filter((r) => r.status === 'ready' && r.valid);
  const waiting = out.rows.filter((r) => r.status === 'waiting' && r.valid);

  // 只對真的會出現在清單上的幣抓資金費率與未平倉量。
  // 全部 120 檔都抓沒有意義（多數不會進榜），而且會拖慢整個掃描。
  await attachDerivatives([...ready, ...waiting].slice(0, DERIV_TOP), await previousRows());

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(out));
  await writeFile(OUT_MD, renderMarkdown(out, ready, waiting));

  log(`\n完成（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  log(`  🟢 可進場 ${ready.length} 個｜⏳ 等待回測 ${waiting.length} 個`);
  for (const r of ready.slice(0, 8)) {
    log(`    🟢 ${r.symbol.replace('USDT', '').padEnd(6)} ${r.grade}/${r.score} ${r.dir === 'long' ? '多' : '空'} ${r.rr.toFixed(1)}R  ${price(r.entry)}`);
  }
  for (const r of waiting.slice(0, 5)) {
    log(`    ⏳ ${r.symbol.replace('USDT', '').padEnd(6)} ${r.grade}/${r.score} ${r.dir === 'long' ? '多' : '空'} 距離 ${r.distancePct >= 0 ? '+' : ''}${r.distancePct.toFixed(2)}%`);
  }
}

function renderMarkdown(out, ready, waiting) {
  const fundingCell = (d) => {
    if (!d || !Number.isFinite(d.fundingRate)) return '—';
    const pct = (d.fundingRate * 100).toFixed(3) + '%';
    // 只有極端／偏高才標記，平常這欄就是背景資訊
    const mark = d.fundingLevel === 'extreme' ? '🔥' : d.fundingLevel === 'elevated' ? '⚠️' : '';
    const oi = Number.isFinite(d.oiChangePct) ? `${d.oiChangePct > 0 ? '+' : ''}${d.oiChangePct.toFixed(1)}%` : '—';
    return `${mark}${pct} / OI ${oi}`;
  };
  const row = (r) =>
    `| ${r.symbol.replace('USDT', '')} | ${r.grade}/${r.score} | ${r.dir === 'long' ? '做多' : '做空'} | ${price(r.entry)} | ${price(r.stop)} | ${r.rr.toFixed(2)}R | ${r.poiType ?? '—'} | ${r.distancePct >= 0 ? '+' : ''}${r.distancePct.toFixed(2)}% | ${fundingCell(r.deriv)} |`;
  const head = '| 幣種 | 評級 | 方向 | 進場 | 停損 | 風報比 | POI | 距現價 | 費率／未平倉量 |\n|---|---|---|---|---|---|---|---|---|';
  return `# 全市場掃描

由 \`scripts/market-scan.mjs\` 自動產生，請勿手動編輯。

- 掃描時間：${out.generatedAt}
- 資料源：${out.provider}｜週期：${out.interval}（高週期 ${out.htfInterval}）
- 掃描範圍：成交量前 ${out.universe} 個 USDT 交易對

## 🟢 現在可進場（${ready.length}）

價格已經在 POI 區間內，可以直接執行。

${head}
${ready.map(row).join('\n') || '| — | | | | | | | | |'}

## ⏳ 等待回測（${waiting.length}）

計畫成立但價格還沒回到進場區，掛限價單或設價格提醒。

${head}
${waiting.slice(0, 40).map(row).join('\n') || '| — | | | | | | | | |'}
`;
}

main().catch((e) => {
  console.error('掃描失敗：', e);
  process.exit(1);
});
