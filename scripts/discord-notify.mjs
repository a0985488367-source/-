/**
 * Discord 訊號推播（在 GitHub Actions 上定時執行，不需要開著網頁）
 *
 *   node scripts/discord-notify.mjs            正式執行（需要 DISCORD_WEBHOOK_URL）
 *   node scripts/discord-notify.mjs --probe    只測試各交易所是否連得上
 *   node scripts/discord-notify.mjs --test     送一則測試訊息到 Discord
 *   node scripts/discord-notify.mjs --dry-run  只在終端機印出訊號，不送出
 *
 * 另可用 --providers=demo、--min-score=40 覆寫設定，方便本機測試。
 *
 * 設計重點：
 *  - 直接重用瀏覽器版的同一套 SMC 引擎（src/smc/*），結論完全一致
 *  - 只分析「已收盤」的 K 棒，避免同一根 K 棒反覆觸發
 *  - 以穩定的訊號 ID 去重（存在 .signals-state.json，由 Actions 快取保存）
 */

import { readFile, writeFile } from 'node:fs/promises';
import { PROVIDERS } from '../src/data/providers.js';
import { analyze } from '../src/smc/engine.js';
import { aggregateBias } from '../src/smc/mtf.js';

const ARGS = new Set(process.argv.slice(2));
const opt = (name) => {
  const hit = [...ARGS].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const PROBE = ARGS.has('--probe');
const TEST = ARGS.has('--test');
const DRY = ARGS.has('--dry-run');

const STATE_FILE = '.signals-state.json';
const STATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

const COLORS = { bull: 0x26a69a, bear: 0xef5350, info: 0x3aa0ff, warn: 0xe2b13c };

/* ------------------------------------------------------------------ 工具 */

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** 依價格量級決定小數位 */
function digitsFor(p) {
  const a = Math.abs(p);
  if (a >= 10000) return 1;
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 7;
}
const price = (v) => fmt(v, digitsFor(v));

async function loadConfig() {
  const raw = await readFile(new URL('../signals.config.json', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw);
  return {
    symbols: cfg.symbols ?? ['BTCUSDT'],
    interval: cfg.interval ?? '15m',
    htfInterval: cfg.htfInterval ?? '4h',
    candles: cfg.candles ?? 400,
    minScore: cfg.minScore ?? 68,
    minRR: cfg.minRR ?? 2,
    notify: { plan: true, poiTouch: true, choch: false, sweep: false, ...(cfg.notify ?? {}) },
    freshBars: cfg.freshBars ?? 2,
    providers: cfg.providers ?? ['binance', 'bybit', 'okx'],
    siteUrl: cfg.siteUrl ?? '',
    lang: cfg.lang ?? 'zh',
    // 測試用的覆寫
    ...(opt('providers') ? { providers: opt('providers').split(',') } : {}),
    ...(opt('min-score') ? { minScore: Number(opt('min-score')) } : {}),
    ...(opt('symbols') ? { symbols: opt('symbols').split(',') } : {}),
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

const saveState = (state) => writeFile(STATE_FILE, JSON.stringify(state, null, 2));

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
      const c = await provider.fetchKlines('BTCUSDT', cfg.interval, { limit: 5 });
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

function collectSignals({ symbol, interval, analysis, cfg, providerId, htf }) {
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

  // 2) 價格進入高分 POI（只推與當前偏向一致的區塊，否則每次盤整都會叫）
  if (cfg.notify.poiTouch) {
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

async function postDiscord(payload) {
  if (!WEBHOOK) throw new Error('缺少環境變數 DISCORD_WEBHOOK_URL');
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

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const cfg = await loadConfig();

  if (PROBE) return probe(cfg);

  if (TEST) {
    await postDiscord({
      embeds: [{
        title: '✅ SMC 終端連線測試',
        color: COLORS.info,
        description: `Webhook 設定成功，之後有訊號就會推到這個頻道。\n\n**監控中**：${cfg.symbols.join('、')}\n**週期**：${cfg.interval}（高週期參考 ${cfg.htfInterval}）\n**門檻**：評分 ≥ ${cfg.minScore}、風報比 ≥ ${cfg.minRR}`,
        url: cfg.siteUrl || undefined,
        footer: { text: '僅供研究，非投資建議' },
        timestamp: new Date().toISOString(),
      }],
    });
    return log('✓ 測試訊息已送出');
  }

  const state = await loadState();
  const found = [];

  for (const symbol of cfg.symbols) {
    try {
      const { candles, provider } = await fetchCandles(symbol, cfg.interval, cfg.candles, cfg.providers);
      // 丟掉最後一根（尚未收盤），只用已確定的 K 棒判斷
      const closed = candles.slice(0, -1);

      let htf = null;
      try {
        const h = await fetchCandles(symbol, cfg.htfInterval, 300, [provider, ...cfg.providers]);
        const ha = analyze(h.candles.slice(0, -1));
        if (!ha.empty) htf = aggregateBias([{ interval: cfg.htfInterval, bias: ha.bias }]);
      } catch (e) {
        log(`  ${symbol} 高週期資料取得失敗（略過）：${e.message}`);
      }

      const a = analyze(closed, { htfBias: htf });
      if (a.empty) { log(`  ${symbol} K 棒不足，略過`); continue; }

      const signals = collectSignals({ symbol, interval: cfg.interval, analysis: a, cfg, providerId: provider, htf });
      const fresh = signals.filter((s) => !state[s.id]);
      log(
        `  ${symbol.padEnd(9)} 收盤 ${price(a.price).padStart(12)} · 偏向 ${String(a.bias.score).padStart(4)} · ` +
        `計畫 ${a.setup && !a.setup.none ? `${a.setup.grade}/${a.setup.score}` : '無'} · ` +
        `訊號 ${signals.length}（新 ${fresh.length}）`,
      );
      found.push(...fresh);
    } catch (e) {
      log(`  ${symbol} 失敗：${e.message}`);
    }
  }

  if (!found.length) return log('\n沒有新訊號。');

  log(`\n共 ${found.length} 則新訊號：`);
  for (const sig of found) {
    const embed = buildEmbed(sig, cfg);
    if (DRY) {
      log(`  [dry-run] ${embed.title}`);
      if (ARGS.has('--verbose')) log(JSON.stringify(embed, null, 2));
      continue;
    }
    await postDiscord({ embeds: [embed] });
    log(`  已推播：${embed.title}`);
    state[sig.id] = new Date().toISOString();
    await sleep(600); // 尊重 Discord 的速率限制
  }
  if (!DRY) await saveState(state);
}

main().catch((e) => {
  console.error('執行失敗：', e);
  process.exit(1);
});
