/**
 * Discord 訊號推播（在 GitHub Actions 上定時執行，不需要開著網頁）
 *
 *   node scripts/discord-notify.mjs            正式執行（需要 DISCORD_WEBHOOK_URL）
 *   node scripts/discord-notify.mjs --probe    只測試各交易所是否連得上
 *   node scripts/discord-notify.mjs --test     送一則測試訊息到 Discord
 *   node scripts/discord-notify.mjs --brief    送出每日晨報
 *   node scripts/discord-notify.mjs --dry-run  只在終端機印出訊號，不送出
 *
 * 另可用 --providers=demo、--min-score=40 覆寫設定，方便本機測試。
 *
 * 設計重點：
 *  - 直接重用瀏覽器版的同一套 SMC 引擎（src/smc/*），結論完全一致
 *  - 只分析「已收盤」的 K 棒，避免同一根 K 棒反覆觸發
 *  - 以穩定的訊號 ID 去重（存在 .signals-state.json，由 Actions 快取保存）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PROVIDERS } from '../src/data/providers.js';
import { analyze } from '../src/smc/engine.js';
import { aggregateBias, tfSuite } from '../src/smc/mtf.js';
import { advanceTrade, computeStats, tradeFromSetup, DEFAULT_MANAGEMENT } from './lib/tracker.mjs';
import { fetchDerivatives } from '../src/data/derivatives.js';
import { derivativesVerdict, oiChangePct } from '../src/smc/derivatives.js';
import { COLORS, price, fmtR, buildOutcomeEmbed } from './lib/outcome-embed.mjs';
import { renderJournalMarkdown } from './lib/journal-markdown.mjs';

const ARGS = new Set(process.argv.slice(2));
const opt = (name) => {
  const hit = [...ARGS].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const PROBE = ARGS.has('--probe');
const TEST = ARGS.has('--test');
const BRIEF = ARGS.has('--brief');
const DRY = ARGS.has('--dry-run');

// 資料目錄可用環境變數覆寫，方便本機測試時不動到正式帳本
const DATA_DIR = process.env.SMC_DATA_DIR || 'data';
const STATE_FILE = `${DATA_DIR}/.signals-state.json`;
const JOURNAL_FILE = `${DATA_DIR}/signals.json`;
const JOURNAL_MD = `${DATA_DIR}/journal.md`;
const MAX_CLOSED = 300;
const STATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

/* ------------------------------------------------------------------ 工具 */

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadConfig() {
  const raw = await readFile(new URL('../signals.config.json', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw);
  // 支援多週期掃描；舊設定只寫 interval 時自動沿用
  const intervals = cfg.intervals ?? [cfg.interval ?? '15m'];
  return {
    symbols: cfg.symbols ?? ['BTCUSDT'],
    intervals,
    interval: intervals[0],
    htfOverride: cfg.htfInterval ?? null,
    candles: cfg.candles ?? 400,
    minScore: cfg.minScore ?? 68,
    minRR: cfg.minRR ?? 2,
    notify: { plan: true, poiTouch: true, choch: false, sweep: false, outcomes: true, ...(cfg.notify ?? {}) },
    tracking: { enabled: true, ...DEFAULT_MANAGEMENT, ...(cfg.tracking ?? {}) },
    market: { notify: true, minScore: 72, maxPerRun: 3, maxAgeMin: 120, ...(cfg.market ?? {}) },
    timezone: cfg.timezone ?? 'Asia/Taipei',
    freshBars: cfg.freshBars ?? 2,
    providers: cfg.providers ?? ['binance', 'bybit', 'okx'],
    siteUrl: cfg.siteUrl ?? '',
    lang: cfg.lang ?? 'zh',
    // 測試用的覆寫
    ...(opt('providers') ? { providers: opt('providers').split(',') } : {}),
    ...(opt('min-score') ? { minScore: Number(opt('min-score')) } : {}),
    ...(opt('symbols') ? { symbols: opt('symbols').split(',') } : {}),
    ...(opt('intervals') ? { intervals: opt('intervals').split(','), interval: opt('intervals').split(',')[0] } : {}),
  };
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of Object.entries(state)) {
      if (now - new Date(v).getTime() > STATE_TTL_MS) delete state[k];
    }
    return state;
  } catch {
    return {};
  }
}

const saveState = async (state) => {
  await mkdir(DATA_DIR, { recursive: true });
  return writeFile(STATE_FILE, JSON.stringify(state, null, 2));
};

/** 模擬盤帳本：持續追蹤每則訊號的下場，是勝率統計的唯一真相來源 */
async function loadJournal() {
  try {
    return JSON.parse(await readFile(JOURNAL_FILE, 'utf8'));
  } catch {
    return { version: 1, open: [], closed: [], updatedAt: null };
  }
}

async function saveJournal(journal) {
  journal.updatedAt = new Date().toISOString();
  journal.closed = journal.closed.slice(-MAX_CLOSED);
  journal.stats = computeStats(journal.closed);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  await writeFile(JOURNAL_MD, renderJournalMarkdown(journal));
}



/* -------------------------------------------------------------- 行情抓取 */

async function fetchCandles(symbol, interval, limit, providerIds) {
  const errors = [];
  for (const id of providerIds) {
    const provider = PROVIDERS[id];
    if (!provider) continue;
    try {
      const candles = await provider.fetchKlines(symbol, interval, { limit });
      if (candles?.length) return { candles, provider: id };
      errors.push(`${id}: 回傳空資料`);
    } catch (e) {
      errors.push(`${id}: ${e?.message || e}`);
    }
  }
  throw new Error(`所有資料源都失敗 → ${errors.join(' | ')}`);
}

/** 檢查各交易所在這台機器上是否連得到（GitHub 的機器位於美國，部分交易所會擋） */
async function probe(cfg) {
  log('探測各交易所連線狀況…\n');
  for (const id of [...cfg.providers, 'demo']) {
    const provider = PROVIDERS[id];
    if (!provider) { log(`  ${id.padEnd(8)} ✗ 沒有這個資料源`); continue; }
    const t0 = Date.now();
    try {
      const c = await provider.fetchKlines('BTCUSDT', cfg.intervals[0], { limit: 5 });
      log(`  ${id.padEnd(8)} ✓ ${c.length} 根 K 棒，最新收盤 ${price(c.at(-1).close)}（${Date.now() - t0} ms）`);
    } catch (e) {
      log(`  ${id.padEnd(8)} ✗ ${String(e?.message || e).slice(0, 120)}`);
    }
  }
}

/* -------------------------------------------------------------- 訊號判定 */

/** 區塊的穩定識別碼：用時間或價格區間，不用會隨視窗滑動而改變的索引 */
function poiSignature(poi) {
  const t = poi?.meta?.time;
  if (t) return `t${t}`;
  return `p${poi.bottom.toPrecision(8)}-${poi.top.toPrecision(8)}`;
}

function collectSignals({ symbol, interval, analysis, cfg, providerId, htf, isPrimary }) {
  const out = [];
  const a = analysis;
  const s = a.setup;
  const bars = a.candles.length;

  // 1) 可執行的交易計畫
  if (cfg.notify.plan && s && !s.none && s.valid && s.score >= cfg.minScore && s.rrFinal >= cfg.minRR) {
    out.push({
      id: `plan:${symbol}:${interval}:${s.dir}:${poiSignature(s.poi)}`,
      kind: 'plan',
      symbol, interval, providerId, analysis: a, setup: s, htf,
    });
  }

  // 2) 價格進入高分 POI（只在主要週期、且與當前偏向一致，否則多週期會洗頻）
  if (cfg.notify.poiTouch && isPrimary) {
    const hit = a.pois.find(
      (p) =>
        a.price <= p.top &&
        a.price >= p.bottom &&
        p.score >= cfg.minScore &&
        p.state !== 'mitigated' &&
        p.aligned !== false,
    );
    if (hit) {
      out.push({
        id: `poi:${symbol}:${interval}:${poiSignature(hit)}`,
        kind: 'poi',
        symbol, interval, providerId, analysis: a, poi: hit, htf,
      });
    }
  }

  // 3) 剛發生的 CHoCH（趨勢可能反轉）
  if (cfg.notify.choch) {
    const ev = a.structure.internal.lastEvent;
    if (ev && ev.type === 'CHoCH' && bars - ev.breakIndex <= cfg.freshBars) {
      out.push({
        id: `choch:${symbol}:${interval}:${ev.breakTime}`,
        kind: 'choch',
        symbol, interval, providerId, analysis: a, event: ev, htf,
      });
    }
  }

  // 4) 剛發生的流動性掃除
  if (cfg.notify.sweep) {
    const sw = a.sweeps[a.sweeps.length - 1];
    if (sw && bars - sw.index <= cfg.freshBars) {
      out.push({
        id: `sweep:${symbol}:${interval}:${sw.time}`,
        kind: 'sweep',
        symbol, interval, providerId, analysis: a, sweep: sw, htf,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------ Discord 訊息 */

const zhZone = (z) => (z === 'premium' ? '溢價' : z === 'discount' ? '折價' : '均衡');

/**
 * 把資金費率與未平倉量整理成推播裡的一個欄位。
 * 拿不到資料就回空陣列 —— 這是加分項，絕對不能讓它擋住訊號推播。
 */
/** 抓這個幣的資金費率與未平倉量，換算成對這筆交易方向的解讀 */
async function attachDerivatives(sig) {
  const raw = await fetchDerivatives(sig.symbol);
  const candles = sig.analysis.candles.slice(-24);
  const priceChangePct = candles.length > 1
    ? ((candles.at(-1).close - candles[0].close) / candles[0].close) * 100
    : 0;
  const oiPct = oiChangePct(raw.oiSeries);
  return {
    ...derivativesVerdict({ dir: sig.setup.dir, funding: raw.fundingRate, priceChangePct, oiChangePct: oiPct }),
    oiChangePct: oiPct,
    raw,
  };
}

/**
 * 市場掃描那份資料裡的衍生品欄位。
 * 結構跟 derivField 不同：掃描時已經先算好存進 market.json，
 * 這裡只負責排版，不再重算。
 */
function scanDerivField(d) {
  if (!d || !Number.isFinite(d.fundingRate)) return [];
  const pct = (d.fundingRate * 100).toFixed(4) + '%';
  const oi = Number.isFinite(d.oiChangePct) ? (d.oiChangePct > 0 ? '+' : '') + d.oiChangePct.toFixed(1) + '%' : '—';
  return [{
    name: `資金費率 ${pct}　未平倉量 ${oi}`,
    value: `${d.regimeZh}${d.note ? `\n${d.note}` : ''}`,
  }];
}

function derivField(deriv) {
  if (!deriv || deriv.error) return [];
  const rate = deriv.raw?.fundingRate;
  const pct = Number.isFinite(rate) ? (rate * 100).toFixed(4) + '%' : '—';
  const oi = Number.isFinite(deriv.oiChangePct) ? (deriv.oiChangePct > 0 ? '+' : '') + deriv.oiChangePct.toFixed(1) + '%' : '—';
  const warn = deriv.notes.find((n) => n.startsWith('⚠'));
  const good = deriv.notes.find((n) => !n.startsWith('⚠'));
  const line = warn || good;
  return [{
    name: `資金費率 ${pct}　未平倉量 ${oi}`,
    value: `${deriv.regime.zh}${line ? `\n${line}` : ''}`,
  }];
}

function buildEmbed(sig, cfg) {
  const { symbol, interval, analysis: a } = sig;
  const base = symbol.replace(/USDT$/, '');
  const pdText = a.pd ? `${zhZone(a.pd.zone)} ${a.pd.pct.toFixed(0)}%` : '—';
  const common = [
    { name: '現價', value: price(a.price), inline: true },
    { name: '區間位置', value: pdText, inline: true },
    { name: '高週期偏向', value: sig.htf ? `${sig.htf.labelZh}（${sig.htf.score > 0 ? '+' : ''}${sig.htf.score}）` : '—', inline: true },
  ];
  const footer = { text: `${symbol} · ${interval} · 資料源 ${sig.providerId} · 僅供研究，非投資建議` };
  const timestamp = new Date(a.candles.at(-1).time).toISOString();
  const url = cfg.siteUrl || undefined;

  if (sig.kind === 'plan') {
    const s = sig.setup;
    const long = s.dir === 'long';
    const passed = s.checklist.filter((c) => c.ok);
    const tps = s.targets.map((t) => `**${t.name}** ${price(t.price)} · ${t.rr.toFixed(2)}R　*${t.label}*`).join('\n');
    return {
      title: `${long ? '🟢 做多' : '🔴 做空'} ${base}/USDT · ${interval} · ${s.grade} 級`,
      url,
      color: long ? COLORS.bull : COLORS.bear,
      description: `**${s.poi.type}** ${price(s.entryZone.bottom)} – ${price(s.entryZone.top)}　(${s.entryType === 'market' ? '價格已在區間內' : '等待回測'})`,
      fields: [
        { name: '進場', value: price(s.entry), inline: true },
        { name: '停損', value: `${price(s.stop)}　(${s.riskPct.toFixed(2)}%)`, inline: true },
        { name: '風報比', value: `${s.rrFinal.toFixed(2)}R`, inline: true },
        { name: '目標', value: tps || '—' },
        { name: `匯流 ${passed.length}/${s.checklist.length} · 評分 ${s.score}/100`, value: passed.map((c) => `✓ ${c.zh}`).join('\n') || '—' },
        ...common,
        ...derivField(sig.deriv),
        ...(s.conflict ? [{ name: '⚠️ 注意', value: '高週期與進場週期方向分歧，建議減碼或等待表態。' }] : []),
        { name: '失效條件', value: s.invalidation },
      ],
      footer,
      timestamp,
    };
  }

  if (sig.kind === 'poi') {
    const p = sig.poi;
    const long = p.dir === 'bull';
    return {
      title: `🎯 ${base}/USDT · ${interval} 進入 ${p.type}`,
      url,
      color: long ? COLORS.bull : COLORS.bear,
      description: `價格進入${long ? '看多' : '看空'}興趣區 **${price(p.bottom)} – ${price(p.top)}**（品質 ${Math.round(p.score)}/100）\n可以開始觀察低週期是否出現 CHoCH 確認。`,
      fields: common,
      footer,
      timestamp,
    };
  }

  if (sig.kind === 'choch') {
    const ev = sig.event;
    const bull = ev.dir === 'bull';
    return {
      title: `🔄 ${base}/USDT · ${interval} 出現 CHoCH（${bull ? '轉多' : '轉空'}）`,
      url,
      color: COLORS.warn,
      description: `突破價位 **${price(ev.price)}**。CHoCH 是趨勢可能反轉的第一個訊號，標準做法是等回測 OB / FVG 再進場，不要直接追。`,
      fields: common,
      footer,
      timestamp,
    };
  }

  const sw = sig.sweep;
  return {
    title: `💧 ${base}/USDT · ${interval} 掃${sw.side === 'buyside' ? '買方' : '賣方'}流動性`,
    url,
    color: COLORS.info,
    description: `於 **${price(sw.level)}** 掃過${sw.side === 'buyside' ? '前高（可能反轉向下）' : '前低（可能反轉向上）'}，深度 ${sw.depthAtr.toFixed(2)} ATR。`,
    fields: common,
    footer,
    timestamp,
  };
}

/** 檢查是不是 Discord webhook 網址（只看格式，永遠不印出內容） */
function assertWebhookLooksValid() {
  if (!WEBHOOK) throw new Error('缺少環境變數 DISCORD_WEBHOOK_URL');
  // SMC_ALLOW_ANY_WEBHOOK 僅供本機端到端測試使用（指向本地假伺服器）
  if (process.env.SMC_ALLOW_ANY_WEBHOOK === '1') return;
  const ok = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(WEBHOOK.trim());
  if (!ok) {
    throw new Error(
      'Secret 的內容看起來不是 Discord webhook 網址。\n' +
      '  正確格式：https://discord.com/api/webhooks/<一串數字>/<一串英數字>\n' +
      '  取得方式：Discord 頻道 → 編輯頻道 → 整合 → Webhook → 新增 Webhook → 複製 Webhook 網址\n' +
      '  （不是頻道網址、不是邀請連結、也不是伺服器網址）',
    );
  }
}

/**
 * 全市場掃描的機會：讀取 market-scan.mjs 產生的結果，
 * 挑出「現在可進場」且分數夠高、又不在固定監控清單裡的標的。
 */
async function marketOpportunities(cfg, state) {
  if (!cfg.market.notify) return [];
  let data;
  try {
    data = JSON.parse(await readFile(`${DATA_DIR}/market.json`, 'utf8'));
  } catch {
    return [];
  }
  const ageMin = (Date.now() - new Date(data.generatedAt).getTime()) / 60000;
  if (ageMin > cfg.market.maxAgeMin) {
    log(`  全市場掃描結果已是 ${ageMin.toFixed(0)} 分鐘前，不推播`);
    return [];
  }
  return data.rows
    .filter(
      (r) =>
        r.valid &&
        r.status === 'ready' &&
        r.score >= cfg.market.minScore &&
        !cfg.symbols.includes(r.symbol) &&
        !state[`market:${r.symbol}:${r.interval}:${r.dir}:${r.entry}`],
    )
    .slice(0, cfg.market.maxPerRun)
    .map((r) => ({ id: `market:${r.symbol}:${r.interval}:${r.dir}:${r.entry}`, kind: 'market', row: r, interval: r.interval, symbol: r.symbol }));
}

function buildMarketEmbed(sig, cfg) {
  const r = sig.row;
  const base = r.symbol.replace(/USDT$/, '');
  const long = r.dir === 'long';
  const tps = r.targets.map((t) => `**${t.name}** ${price(t.price)} · ${t.rr.toFixed(2)}R　*${t.label}*`).join('\n');
  return {
    title: `${long ? '🟢 做多' : '🔴 做空'} ${base}/USDT · ${r.interval} · ${r.grade} 級　🔎 全市場掃描`,
    url: cfg.siteUrl || undefined,
    color: long ? COLORS.bull : COLORS.bear,
    description: `**${r.poiType}** ${price(r.entry)}　(價格已在區間內)`,
    fields: [
      { name: '進場', value: price(r.entry), inline: true },
      { name: '停損', value: `${price(r.stop)}　(${r.riskPct.toFixed(2)}%)`, inline: true },
      { name: '風報比', value: `${r.rr.toFixed(2)}R`, inline: true },
      { name: '目標', value: tps || '—' },
      { name: '現價', value: price(r.price), inline: true },
      { name: '區間位置', value: r.pd ? `${zhZone(r.pd.zone)} ${r.pd.pct.toFixed(0)}%` : '—', inline: true },
      { name: '匯流', value: `${r.checksPassed}/${r.checksTotal} · 評分 ${r.score}`, inline: true },
      ...scanDerivField(r.deriv),
    ],
    footer: { text: `${r.symbol} · ${r.interval} · 全市場掃描（前 ${cfg.market.top ?? '—'} 名）· 僅供研究，非投資建議` },
    timestamp: new Date(r.updatedAt).toISOString(),
  };
}

/** 模擬單狀態變化 → Discord 訊息 */
async function postDiscord(payload) {
  assertWebhookLooksValid();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'SMC 終端', ...payload }),
    });
    if (res.ok || res.status === 204) return true;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      log(`  Discord 限流，等待 ${wait} ms 後重試`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Discord 回應 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('Discord 重試三次仍失敗');
}

/* ------------------------------------------------------------------ 晨報 */

const KILLZONES_TPE = [
  ['倫敦殺區', '15:00 – 18:00'],
  ['紐約早盤殺區', '20:00 – 23:00'],
  ['紐約午盤殺區', '01:30 – 04:00（隔日）'],
];

/** 過去 24 小時的掃描摘要：達標數與最接近的幾次，讓「今天沒訊號」也有交代 */
function summarize24h(journal, cfg) {
  const bests = journal.bests ?? [];
  if (!bests.length) return '尚無掃描紀錄';
  const qualified = bests.filter((b) => b.score >= cfg.minScore && b.rr >= cfg.minRR);
  // 每個幣種／週期取最高分
  const top = new Map();
  for (const b of bests) {
    const k = `${b.symbol}|${b.interval}`;
    if (!top.has(k) || b.score > top.get(k).score) top.set(k, b);
  }
  const lines = [...top.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((b) => {
      const ok = b.score >= cfg.minScore && b.rr >= cfg.minRR;
      return `${ok ? '✅' : '▫️'} ${b.symbol.replace(/USDT$/, '')} ${b.interval}　${b.grade}/${b.score} 分　${b.dir === 'long' ? '多' : '空'}　${b.rr.toFixed(1)}R`;
    });
  return `掃描 ${bests.length} 次 · 達標 ${qualified.length} 次（門檻 ${cfg.minScore} 分 / ${cfg.minRR}R）\n**各幣種最高分**\n${lines.join('\n')}`;
}

function buildBriefEmbed(snapshots, journal, cfg) {
  const st = journal.stats ?? computeStats(journal.closed);
  const rows = snapshots.map(({ symbol, analysis: a }) => {
    const b = a.bias;
    const icon = b.label === 'bullish' ? '🟢' : b.label === 'bearish' ? '🔴' : '⚪';
    const pd = a.pd ? `${zhZone(a.pd.zone)} ${a.pd.pct.toFixed(0)}%` : '—';
    const plan = a.setup && !a.setup.none
      ? `${a.setup.dir === 'long' ? '多' : '空'} ${a.setup.grade}(${a.setup.score})`
      : '—';
    return `${icon} **${symbol.replace(/USDT$/, '')}** \`${price(a.price)}\`　偏向 ${b.score > 0 ? '+' : ''}${b.score}　${pd}　計畫 ${plan}`;
  });

  const levels = snapshots.slice(0, 3).map(({ symbol, analysis: a }) => {
    const pick = ['PDH', 'PDL', 'PWH', 'PWL'].map((code) => a.keyLevels.find((l) => l.code === code)).filter(Boolean);
    return `**${symbol.replace(/USDT$/, '')}**　${pick.map((l) => `${l.code} ${price(l.price)}`).join('　')}`;
  });

  const draws = snapshots.map(({ symbol, analysis: a }) => {
    const up = a.liq.above[0];
    const down = a.liq.below[0];
    return `**${symbol.replace(/USDT$/, '')}**　上方 ${up ? price(up.price) : '—'}　下方 ${down ? price(down.price) : '—'}`;
  });

  const open = journal.open.length
    ? journal.open.map((t) => `${t.symbol.replace(/USDT$/, '')} ${t.dir === 'long' ? '多' : '空'} · ${t.status === 'pending' ? '等待進場' : '持有中'} · 進場 ${price(t.entry)}`).join('\n')
    : '目前沒有進行中的模擬單';

  return {
    title: `☀️ 今日市場簡報 · ${new Date().toLocaleDateString('zh-TW', { timeZone: cfg.timezone })}`,
    url: cfg.siteUrl || undefined,
    color: COLORS.info,
    description: rows.join('\n'),
    fields: [
      { name: '關鍵時間價位', value: levels.join('\n') || '—' },
      { name: '流動性目標（最近的未觸及）', value: draws.join('\n') || '—' },
      { name: '進行中的模擬單', value: open },
      { name: '過去 24 小時掃描摘要', value: summarize24h(journal, cfg) },
      {
        name: '模擬盤累計成效',
        value: st.count
          ? `${st.count} 筆 · 勝率 **${st.winRate.toFixed(0)}%** · 期望值 **${st.expectancy >= 0 ? '+' : ''}${st.expectancy.toFixed(2)}R** · 總計 ${st.totalR >= 0 ? '+' : ''}${st.totalR.toFixed(1)}R\n最大回撤 ${st.maxDrawdownR.toFixed(1)}R · 最長連敗 ${st.maxLossStreak}`
          : '尚未累積足夠樣本',
      },
      { name: '今日交易時段（台灣時間）', value: KILLZONES_TPE.map(([n, t]) => `${n}　${t}`).join('\n'), inline: false },
    ],
    footer: { text: '僅供研究，非投資建議' },
    timestamp: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const cfg = await loadConfig();

  if (PROBE) return probe(cfg);

  if (TEST) {
    await postDiscord({
      embeds: [{
        title: '✅ SMC 終端連線測試',
        color: COLORS.info,
        description: `Webhook 設定成功，之後有訊號就會推到這個頻道。\n\n**監控中**：${cfg.symbols.join('、')}\n**週期**：${cfg.intervals.join('、')}\n**門檻**：評分 ≥ ${cfg.minScore}、風報比 ≥ ${cfg.minRR}`,
        url: cfg.siteUrl || undefined,
        footer: { text: '僅供研究，非投資建議' },
        timestamp: new Date().toISOString(),
      }],
    });
    return log('✓ 測試訊息已送出');
  }

  const state = await loadState();
  const journal = await loadJournal();
  const found = [];
  const outcomes = [];
  const snapshots = [];
  const bests = [];

  const processed = new Set();

  for (const symbol of cfg.symbols) {
    for (const interval of cfg.intervals) {
      const isPrimary = interval === cfg.intervals[0];
      processed.add(`${symbol}|${interval}`);
      try {
        const { candles, provider } = await fetchCandles(symbol, interval, cfg.candles, cfg.providers);
        // 丟掉最後一根（尚未收盤），只用已確定的 K 棒判斷
        const closed = candles.slice(0, -1);

        // ── 推進這個幣種／週期的模擬單 ──
        if (cfg.tracking.enabled) {
          for (const trade of journal.open) {
            if (trade.symbol !== symbol || trade.interval !== interval) continue;
            const updated = advanceTrade(trade, closed, cfg.tracking);
            Object.assign(trade, updated);
            for (const ev of updated.events || []) outcomes.push({ trade, event: ev });
          }
        }

        // 高週期偏向：依進場週期自動對應（15m→4h、1h→1d…）
        const htfInterval = cfg.htfOverride && isPrimary ? cfg.htfOverride : tfSuite(interval).htf;
        let htf = null;
        try {
          const h = await fetchCandles(symbol, htfInterval, 300, [provider, ...cfg.providers]);
          const ha = analyze(h.candles.slice(0, -1));
          if (!ha.empty) htf = aggregateBias([{ interval: htfInterval, bias: ha.bias }]);
        } catch (e) {
          log(`  ${symbol} ${interval} 高週期(${htfInterval})取得失敗：${e.message}`);
        }

        const a = analyze(closed, { htfBias: htf });
        if (a.empty) { log(`  ${symbol} ${interval} K 棒不足，略過`); continue; }
        if (isPrimary) snapshots.push({ symbol, analysis: a, provider, htf });

        const signals = collectSignals({ symbol, interval, analysis: a, cfg, providerId: provider, htf, isPrimary });
        const fresh = signals.filter((s) => !state[s.id]);

        // 記錄這次掃到的最佳計畫分數（即使沒達標），晨報用來說明「為什麼沒訊號」
        if (a.setup && !a.setup.none) {
          bests.push({
            time: a.candles.at(-1).time, symbol, interval,
            score: a.setup.score, grade: a.setup.grade, dir: a.setup.dir, rr: a.setup.rrFinal,
          });
        }

        log(
          `  ${symbol.padEnd(9)} ${interval.padEnd(4)} 收盤 ${price(a.price).padStart(12)} · 偏向 ${String(a.bias.score).padStart(4)} · ` +
          `計畫 ${a.setup && !a.setup.none ? `${a.setup.grade}/${a.setup.score}` : '無'} · ` +
          `訊號 ${signals.length}（新 ${fresh.length}）`,
        );
        found.push(...fresh);
      } catch (e) {
        log(`  ${symbol} ${interval} 失敗：${e.message}`);
      }
    }
  }

  // 補推進：來自全市場掃描的模擬單不在固定監控清單裡，這裡單獨抓資料推進，
  // 否則那些單永遠不會結算
  if (cfg.tracking.enabled) {
    const pending = [...new Set(
      journal.open
        .map((t) => `${t.symbol}|${t.interval}`)
        .filter((k) => !processed.has(k)),
    )];
    for (const key of pending) {
      const [symbol, interval] = key.split('|');
      try {
        const { candles } = await fetchCandles(symbol, interval, 300, cfg.providers);
        const closed = candles.slice(0, -1);
        for (const trade of journal.open) {
          if (trade.symbol !== symbol || trade.interval !== interval) continue;
          const updated = advanceTrade(trade, closed, cfg.tracking);
          Object.assign(trade, updated);
          for (const ev of updated.events || []) outcomes.push({ trade, event: ev });
        }
        log(`  追蹤中（非固定清單）：${symbol} ${interval} 已更新`);
      } catch (e) {
        log(`  追蹤中的 ${symbol} ${interval} 更新失敗：${e.message}`);
      }
    }
  }

  // 已結束的模擬單移到歷史
  const stillOpen = [];
  for (const t of journal.open) {
    if (t.status === 'target' || t.status === 'stop' || t.status === 'expired') journal.closed.push(t);
    else stillOpen.push(t);
  }
  journal.open = stillOpen;
  const stats = computeStats(journal.closed);
  journal.stats = stats;

  // 保留最近 24 小時的「最高分計畫」紀錄，供晨報說明近失情況
  const DAY = 24 * 60 * 60 * 1000;
  journal.bests = [...(journal.bests ?? []), ...bests]
    .filter((b) => Date.now() - b.time < DAY)
    .slice(-400);

  if (BRIEF) {
    if (!snapshots.length) return log('沒有可用資料，晨報略過。');
    const embed = buildBriefEmbed(snapshots, journal, cfg);
    if (DRY) { log('[dry-run] ' + embed.title); if (ARGS.has('--verbose')) log(JSON.stringify(embed, null, 2)); return; }
    await postDiscord({ embeds: [embed] });
    await saveJournal(journal);
    return log('✓ 晨報已送出');
  }

  // 是否已有同方向的模擬單在追蹤：POI 每次重算都會換一個新 ID，
  // 若不做這層判斷，同一個設置會被當成「新訊號」無限累加重複的模擬單。
  const hasOpenTrade = (symbol, interval, dir) =>
    journal.open.some((t) => t.symbol === symbol && t.interval === interval && t.dir === dir);

  const errors = [];
  /** 单一項目失敗只記錄、不中斷整批 —— 這是這次修的核心：
   *  一筆爛資料不該讓後面所有「新交易計畫」的推播全部消失。 */
  async function safely(label, fn) {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      log(`  ⚠️ ${label} 失敗，已略過（不影響其他訊號）：${e.message}`);
    }
  }

  try {
    // ── 先推成效回報（先講結果，再講新機會） ──
    if (outcomes.length) log(`\n${outcomes.length} 則模擬單狀態更新：`);
    for (const { trade, event } of outcomes) {
      if (!cfg.notify.outcomes) break;
      await safely(`成效通知 ${trade.symbol} ${event.type}`, async () => {
        const embed = buildOutcomeEmbed(trade, event, stats, cfg);
        if (!embed) return; // 例如 breakeven：不需要獨立推播
        if (DRY) { log(`  [dry-run] ${embed.title}`); return; }
        await postDiscord({ embeds: [embed] });
        log(`  已推播：${embed.title}`);
        await sleep(600);
      });
    }

    // ── 全市場掃描的機會 ──
    const opportunities = await marketOpportunities(cfg, state).catch((e) => {
      errors.push(`全市場機會讀取失敗: ${e.message}`);
      log(`  ⚠️ 全市場機會讀取失敗，已略過：${e.message}`);
      return [];
    });
    if (opportunities.length) log(`\n全市場掃描機會 ${opportunities.length} 則：`);
    for (const sig of opportunities) {
      await safely(`全市場機會 ${sig.symbol}`, async () => {
        const embed = buildMarketEmbed(sig, cfg);
        if (DRY) { log(`  [dry-run] ${embed.title}`); return; }
        await postDiscord({ embeds: [embed] });
        log(`  已推播：${embed.title}`);
        state[sig.id] = new Date().toISOString();
        const r = sig.row;
        if (cfg.tracking.enabled && !hasOpenTrade(r.symbol, r.interval, r.dir)) {
          journal.open.push({
            ...tradeFromSetup({
              id: sig.id, symbol: r.symbol, interval: r.interval,
              setup: { dir: r.dir, entry: r.entry, stop: r.stop, targets: r.targets, entryType: 'market' },
              candleTime: r.updatedAt, grade: r.grade, score: r.score,
              management: cfg.tracking,
            }),
            poiType: r.poiType,
            source: 'market',
          });
          log(`    ↳ 已加入模擬盤追蹤`);
        }
        await sleep(600);
      });
    }

    // ── 再推新訊號 ──
    if (found.length) log(`\n共 ${found.length} 則新訊號：`);
    for (const sig of found) {
      await safely(`新訊號 ${sig.symbol}`, async () => {
        // 資金費率與未平倉量是加分項：取不到就算了，不能因此少推一則訊號
        if (sig.kind === 'plan' && cfg.derivatives !== false) {
          sig.deriv = await attachDerivatives(sig).catch(() => null);
        }
        const embed = buildEmbed(sig, cfg);
        if (DRY) {
          log(`  [dry-run] ${embed.title}`);
          if (ARGS.has('--verbose')) log(JSON.stringify(embed, null, 2));
          return;
        }
        await postDiscord({ embeds: [embed] });
        log(`  已推播：${embed.title}`);
        state[sig.id] = new Date().toISOString();

        // 交易計畫 → 建立一筆模擬單開始追蹤（同方向已有追蹤中的單就不重複建立）
        if (cfg.tracking.enabled && sig.kind === 'plan' && !hasOpenTrade(sig.symbol, sig.interval, sig.setup.dir)) {
          journal.open.push(tradeFromSetup({
            id: sig.id,
            symbol: sig.symbol,
            interval: sig.interval,
            setup: sig.setup,
            candleTime: sig.analysis.candles.at(-1).time,
            management: cfg.tracking,
          }));
          log(`    ↳ 已加入模擬盤追蹤`);
        }
        await sleep(600);
      });
    }
  } finally {
    // 不論上面推播過程有沒有出錯，都要存檔 ——
    // 否則同一批爛資料會在下次執行時被重新處理一次，重複崩潰、重複推播。
    await finish();
  }

  if (errors.length) {
    log(`\n本次共有 ${errors.length} 個項目推播失敗（已略過，其餘訊號正常送出）：`);
    errors.forEach((e) => log(`  - ${e}`));
  }

  async function finish() {
    if (DRY) return log('\n（dry-run：未送出、未寫入帳本）');
    await saveJournal(journal);
    await saveState(state);
    log(`\n模擬盤：進行中 ${journal.open.length} 筆 · 已結束 ${journal.closed.length} 筆` +
        (stats.count ? ` · 勝率 ${stats.winRate.toFixed(0)}% · 期望值 ${stats.expectancy.toFixed(2)}R` : ''));
  }
}

main().catch((e) => {
  console.error('執行失敗：', e);
  process.exit(1);
});
