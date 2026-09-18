/**
 * SMC 即時進場守門員（Cloudflare Worker）
 *
 * 分工：
 *   GitHub Actions  每小時做全市場 SMC 分析 → data/market.json（重運算）
 *   這支 Worker      每 2 分鐘比對現價與已算好的進場區 → 價格一到就推 Discord（輕運算）
 *
 * 為什麼這樣切：Workers 免費方案的 CPU 時間極短，跑不動完整的結構分析；
 * 但「比對價格」只是讀 JSON 加一個迴圈，幾毫秒就結束，非常適合高頻執行。
 *
 * 需要的設定：
 *   Secret    DISCORD_WEBHOOK_URL   Discord webhook 網址
 *   Variable  MARKET_URL            market.json 的網址（預設指向本倉庫）
 *   Variable  MIN_SCORE             只盯幾分以上的計畫（預設 65）
 *   KV        SMC_KV                用來記住已經通知過的標的，避免重複洗頻
 */

const DEFAULTS = {
  MARKET_URL: 'https://raw.githubusercontent.com/a0985488367-source/-/main/data/market.json',
  MIN_SCORE: '65',
  MAX_MARKET_AGE_MIN: '240',
  ALERT_TTL_SEC: '21600', // 同一個進場區 6 小時內只通知一次
  NEAR_PCT: '0.08',       // 距離進場區多近就算「到了」（%）
};

const cfg = (env, key) => env[key] ?? DEFAULTS[key];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await run(env, { dry: url.searchParams.get('dry') === '1' });
      return json(result);
    }
    if (url.pathname === '/status') {
      const market = await getMarket(env).catch((e) => ({ error: e.message }));
      return json({
        ok: true,
        marketUrl: cfg(env, 'MARKET_URL'),
        minScore: Number(cfg(env, 'MIN_SCORE')),
        market: market.error
          ? market
          : {
              generatedAt: market.generatedAt,
              ageMinutes: Math.round((Date.now() - new Date(market.generatedAt).getTime()) / 60000),
              interval: market.interval,
              waiting: market.rows.filter((r) => r.valid && r.status === 'waiting').length,
              ready: market.rows.filter((r) => r.valid && r.status === 'ready').length,
            },
        hasWebhook: !!env.DISCORD_WEBHOOK_URL,
        hasKv: !!env.SMC_KV,
      });
    }
    return new Response(
      'SMC 即時進場守門員\n\n' +
        '  GET /status  檢查設定與資料新鮮度\n' +
        '  GET /run     立刻執行一次（?dry=1 只看結果不推播）\n',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
};

const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });

/* ------------------------------------------------------------------ 主流程 */

async function run(env, { dry = false } = {}) {
  const t0 = Date.now();
  const market = await getMarket(env);
  const ageMin = (Date.now() - new Date(market.generatedAt).getTime()) / 60000;
  if (ageMin > Number(cfg(env, 'MAX_MARKET_AGE_MIN'))) {
    return { skipped: 'market-too-old', ageMinutes: Math.round(ageMin) };
  }

  const minScore = Number(cfg(env, 'MIN_SCORE'));
  const nearPct = Number(cfg(env, 'NEAR_PCT'));
  const watch = market.rows.filter((r) => r.valid && r.status === 'waiting' && r.score >= minScore);
  if (!watch.length) return { checked: 0, alerts: 0, ageMinutes: Math.round(ageMin) };

  const prices = await getPrices(watch.map((r) => r.symbol));
  const hits = [];

  for (const r of watch) {
    const p = prices[r.symbol];
    if (!p) continue;
    // 多單：價格跌到進場價（或已很接近）；空單相反
    const reached = r.dir === 'long'
      ? p <= r.entry * (1 + nearPct / 100)
      : p >= r.entry * (1 - nearPct / 100);
    if (!reached) continue;
    // 已經穿過停損就不必再提醒，劇本已經失效
    const blown = r.dir === 'long' ? p <= r.stop : p >= r.stop;
    if (blown) continue;
    hits.push({ row: r, price: p });
  }

  const sent = [];
  for (const hit of hits) {
    const key = `hit:${hit.row.symbol}:${hit.row.interval}:${hit.row.dir}:${hit.row.entry}`;
    if (env.SMC_KV) {
      if (await env.SMC_KV.get(key)) continue;
    }
    if (!dry) {
      await postDiscord(env, buildEmbed(hit, market));
      if (env.SMC_KV) await env.SMC_KV.put(key, String(Date.now()), { expirationTtl: Number(cfg(env, 'ALERT_TTL_SEC')) });
    }
    sent.push(`${hit.row.symbol} ${hit.row.dir} @ ${hit.price}`);
  }

  return {
    checked: watch.length,
    reached: hits.length,
    alerts: sent.length,
    sent,
    ageMinutes: Math.round(ageMin),
    ms: Date.now() - t0,
    dry,
  };
}

/* -------------------------------------------------------------- 資料來源 */

async function getMarket(env) {
  const res = await fetch(cfg(env, 'MARKET_URL'), { cf: { cacheTtl: 120, cacheEverything: true } });
  if (!res.ok) throw new Error(`market.json HTTP ${res.status}`);
  return res.json();
}

/**
 * 取得現價。Binance 在部分機房會被擋（451），所以自動退到 OKX。
 * 兩者都只用一次請求拿回全部需要的價格。
 */
async function getPrices(symbols) {
  try {
    const q = encodeURIComponent(JSON.stringify(symbols));
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${q}`);
    if (res.ok) {
      const rows = await res.json();
      return Object.fromEntries(rows.map((r) => [r.symbol, Number(r.price)]));
    }
  } catch {}
  // 退路：OKX 一次回傳所有現貨報價
  const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const r of data.data || []) {
    if (!r.instId.endsWith('-USDT')) continue;
    out[r.instId.replace('-', '')] = Number(r.last);
  }
  return out;
}

/* ---------------------------------------------------------------- Discord */

function fmt(v) {
  const a = Math.abs(v);
  const d = a >= 10000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function buildEmbed({ row: r, price }, market) {
  const base = r.symbol.replace(/USDT$/, '');
  const long = r.dir === 'long';
  const tps = (r.targets || []).map((t) => `**${t.name}** ${fmt(t.price)} · ${t.rr.toFixed(2)}R`).join('\n');
  return {
    username: 'SMC 即時守門員',
    embeds: [{
      title: `⚡ ${base}/USDT 價格到了　${long ? '🟢 做多' : '🔴 做空'} · ${r.grade} 級`,
      color: long ? 0x26a69a : 0xef5350,
      description:
        `等待中的計畫，價格剛剛回到進場區。\n` +
        `**現價 ${fmt(price)}**　進場區 ${fmt(r.entry)}　(${r.poiType})`,
      fields: [
        { name: '進場', value: fmt(r.entry), inline: true },
        { name: '停損', value: `${fmt(r.stop)}　(${r.riskPct?.toFixed?.(2) ?? '—'}%)`, inline: true },
        { name: '風報比', value: `${r.rr.toFixed(2)}R`, inline: true },
        { name: '目標', value: tps || '—' },
        { name: '評分', value: `${r.score}/100（匯流 ${r.checksPassed}/${r.checksTotal}）`, inline: true },
        { name: '區間位置', value: r.pd ? `${r.pd.zone} ${r.pd.pct?.toFixed?.(0) ?? ''}%` : '—', inline: true },
      ],
      footer: { text: `${r.interval} 計畫 · 分析於 ${new Date(market.generatedAt).toISOString().slice(5, 16).replace('T', ' ')} UTC · 僅供研究，非投資建議` },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function postDiscord(env, payload) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error('缺少 DISCORD_WEBHOOK_URL');
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
    return postDiscord(env, payload);
  }
  if (!res.ok && res.status !== 204) throw new Error(`Discord ${res.status}`);
}
