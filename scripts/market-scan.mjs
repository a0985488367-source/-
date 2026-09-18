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
import { PROVIDERS } from '../src/data/providers.js';
import { analyze } from '../src/smc/engine.js';
import { aggregateBias, tfSuite } from '../src/smc/mtf.js';

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

/** 排除穩定幣對與槓桿代幣：這些的 SMC 結構沒有參考價值 */
const EXCLUDE = /(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|TRY|BRL|ARS|UP|DOWN|BULL|BEAR)USDT$/;

const log = (...a) => console.log(...a);
const digitsFor = (p) => (Math.abs(p) >= 10000 ? 1 : Math.abs(p) >= 100 ? 2 : Math.abs(p) >= 1 ? 4 : Math.abs(p) >= 0.01 ? 5 : 7);
const price = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: digitsFor(v), maximumFractionDigits: digitsFor(v) }));

async function withFallback(fn) {
  let err;
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    if (!p) continue;
    try { return { result: await fn(p), provider: id }; } catch (e) { err = e; }
  }
  throw err || new Error('沒有可用的資料源');
}

/** 簡單的並行池：控制同時進行的請求數，避免打爆交易所的速率限制 */
async function pool(items, size, worker) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx], idx); } catch (e) { out[idx] = { error: e?.message || String(e) }; }
      }
    }),
  );
  return out;
}

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

const r8 = (v) => (v == null || !isFinite(v) ? null : Number(Number(v).toPrecision(8)));
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

function toRow(symbol, a, provider, quoteVolume) {
  const s = a.setup;
  if (!s || s.none) return null;
  const distancePct = ((s.entry - a.price) / a.price) * 100;
  return {
    symbol,
    price: r8(a.price),
    quoteVolume: Math.round(quoteVolume ?? 0),
    provider,
    interval: INTERVAL,
    bias: a.bias.score,
    biasLabel: a.bias.label,
    pd: a.pd ? { zone: a.pd.zone, pct: r2(a.pd.pct) } : null,
    dir: s.dir,
    grade: s.grade,
    score: s.score,
    rr: r2(s.rrFinal),
    rr1: r2(s.rr1),
    entry: r8(s.entry),
    stop: r8(s.stop),
    riskPct: r2(s.riskPct),
    targets: s.targets.map((t) => ({ name: t.name, price: r8(t.price), rr: r2(t.rr), label: t.label })),
    poiType: s.poi?.type,
    poiState: s.poi?.state,
    entryType: s.entryType,
    status: s.entryType === 'market' ? 'ready' : 'waiting',
    distancePct: r2(distancePct),
    valid: s.valid,
    conflict: !!s.conflict,
    checksPassed: s.checklist.filter((c) => c.ok).length,
    checksTotal: s.checklist.length,
    structure: a.structure.swing.trendLabel,
    lastEvent: a.structure.internal.lastEvent
      ? { type: a.structure.internal.lastEvent.type, dir: a.structure.internal.lastEvent.dir }
      : null,
    updatedAt: a.candles.at(-1).time,
  };
}

async function main() {
  if (await isFresh()) return;
  const t0 = Date.now();

  log(`取得交易對清單…`);
  const { result: tickers, provider } = await withFallback((p) => p.fetchSymbols());
  const universe = tickers
    .filter((t) => !EXCLUDE.test(t.symbol))
    .slice(0, TOP);
  log(`資料源 ${provider}｜候選 ${universe.length} 個交易對（依 24h 成交額排序）\n`);

  // ── 第一階段：單週期粗篩 ──
  let done = 0;
  const stage1 = await pool(universe, CONCURRENCY, async (t) => {
    const p = PROVIDERS[provider];
    const candles = await p.fetchKlines(t.symbol, INTERVAL, { limit: 320 });
    const a = analyze(candles.slice(0, -1));
    done++;
    if (done % 20 === 0) log(`  已掃描 ${done}/${universe.length}`);
    if (a.empty) return null;
    return toRow(t.symbol, a, provider, t.quoteVolume);
  });

  const candidates = stage1
    .filter((r) => r && !r.error && r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  log(`\n粗篩完成：${candidates.length} 個達到 ${MIN_SCORE} 分`);

  // ── 第二階段：對前段補抓高週期偏向，重新精算 ──
  const htfInterval = tfSuite(INTERVAL).htf;
  const detail = candidates.slice(0, DETAIL_TOP);
  log(`精算前 ${detail.length} 名（補上 ${htfInterval} 高週期偏向）…`);
  const refined = await pool(detail, CONCURRENCY, async (row) => {
    const p = PROVIDERS[provider];
    let htf = null;
    try {
      const h = await p.fetchKlines(row.symbol, htfInterval, { limit: 260 });
      const ha = analyze(h.slice(0, -1));
      if (!ha.empty) htf = aggregateBias([{ interval: htfInterval, bias: ha.bias }]);
    } catch {}
    const candles = await p.fetchKlines(row.symbol, INTERVAL, { limit: 320 });
    const a = analyze(candles.slice(0, -1), { htfBias: htf });
    if (a.empty) return row;
    const fresh = toRow(row.symbol, a, provider, row.quoteVolume);
    return fresh ? { ...fresh, htfBias: htf?.score ?? null } : row;
  });

  const rows = [
    ...refined.filter((r) => r && !r.error),
    ...candidates.slice(DETAIL_TOP),
  ].sort((a, b) => b.score - a.score);

  const ready = rows.filter((r) => r.status === 'ready' && r.valid);
  const waiting = rows.filter((r) => r.status === 'waiting' && r.valid);

  const out = {
    generatedAt: new Date().toISOString(),
    provider,
    interval: INTERVAL,
    htfInterval,
    universe: universe.length,
    scanned: stage1.filter(Boolean).length,
    minScore: MIN_SCORE,
    counts: { ready: ready.length, waiting: waiting.length, total: rows.length },
    rows,
  };

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
  const row = (r) =>
    `| ${r.symbol.replace('USDT', '')} | ${r.grade}/${r.score} | ${r.dir === 'long' ? '做多' : '做空'} | ${price(r.entry)} | ${price(r.stop)} | ${r.rr.toFixed(2)}R | ${r.poiType ?? '—'} | ${r.distancePct >= 0 ? '+' : ''}${r.distancePct.toFixed(2)}% |`;
  const head = '| 幣種 | 評級 | 方向 | 進場 | 停損 | 風報比 | POI | 距現價 |\n|---|---|---|---|---|---|---|---|';
  return `# 全市場掃描

由 \`scripts/market-scan.mjs\` 自動產生，請勿手動編輯。

- 掃描時間：${out.generatedAt}
- 資料源：${out.provider}｜週期：${out.interval}（高週期 ${out.htfInterval}）
- 掃描範圍：成交量前 ${out.universe} 個 USDT 交易對

## 🟢 現在可進場（${ready.length}）

價格已經在 POI 區間內，可以直接執行。

${head}
${ready.map(row).join('\n') || '| — | | | | | | | |'}

## ⏳ 等待回測（${waiting.length}）

計畫成立但價格還沒回到進場區，掛限價單或設價格提醒。

${head}
${waiting.slice(0, 40).map(row).join('\n') || '| — | | | | | | | |'}
`;
}

main().catch((e) => {
  console.error('掃描失敗：', e);
  process.exit(1);
});
