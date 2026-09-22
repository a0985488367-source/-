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
 *
 * ── 自動下單（選用，預設關閉）──────────────────────────────────────────
 * 價格到了進場區時，除了推播 Discord，也可以順手在 Bybit **模擬交易（Demo）**
 * 帳戶自動送出一張市價單（一定帶停損／停利，數量由帳戶餘額 × 風險 % 算出）。
 * 刻意只接 Demo（假錢）：這是為了先驗證整條自動下單的管線本身有沒有問題，
 * 不是為了真的用真錢自動交易 —— 之後真的要接真錢，需要另外、更謹慎地評估。
 *
 *   Secret    BYBIT_DEMO_API_KEY     Bybit 主站「模擬交易」的 API Key
 *   Secret    BYBIT_DEMO_API_SECRET  對應的 API Secret（只勾 Trade，絕對不要勾 Withdraw）
 *   Secret    AUTO_TRADE_TOKEN       自己取一串亂碼，用來保護下面的開關網址
 *   Variable  AUTO_TRADE_RISK_PCT    每筆風險占帳戶餘額的 %（預設 1）
 *   Variable  AUTO_TRADE_LEVERAGE    槓桿倍數（預設 5，會自動不超過該合約上限）
 *   KV        SMC_KV 的 auto-trade:enabled 這個 key，預設不存在＝關閉
 *
 * 開關（開啟後才會真的下單，就算金鑰都設定好了）：
 *   GET /auto-trade/status         查看目前開/關（不需要 token，唯讀）
 *   GET /auto-trade/on?token=xxx   開啟
 *   GET /auto-trade/off?token=xxx  關閉 —— 這個網址建議加到手機主畫面當緊急煞車
 *
 * 這裡刻意不 import ../src/exchange/bybit.js：部署走的是單一 index.js 檔案的
 * 經典上傳 API（見 deploy-worker.yml），沒有打包步驟，import 別的檔案在
 * Cloudflare 那邊會直接找不到模組。下面這段簽章/下單邏輯因此是獨立複製、
 * 行為刻意對齊 src/exchange/bybit.js 的一份；改動風控或簽章邏輯時兩邊都要看。
 */

const DEFAULTS = {
  MARKET_URL: 'https://raw.githubusercontent.com/a0985488367-source/-/main/data/market.json',
  MIN_SCORE: '65',
  MAX_MARKET_AGE_MIN: '240',
  ALERT_TTL_SEC: '21600', // 同一個進場區 6 小時內只通知一次
  NEAR_PCT: '0.08',       // 距離進場區多近就算「到了」（%）
  AUTO_TRADE_RISK_PCT: '1',
  AUTO_TRADE_LEVERAGE: '5',
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
    if (url.pathname === '/auto-trade/status') {
      return json({
        enabled: await isAutoTradeEnabled(env),
        hasKeys: !!(env.BYBIT_DEMO_API_KEY && env.BYBIT_DEMO_API_SECRET),
        mode: 'demo',
        riskPct: Number(cfg(env, 'AUTO_TRADE_RISK_PCT')),
        leverage: Number(cfg(env, 'AUTO_TRADE_LEVERAGE')),
      });
    }
    if (url.pathname === '/auto-trade/on' || url.pathname === '/auto-trade/off') {
      if (!env.AUTO_TRADE_TOKEN || url.searchParams.get('token') !== env.AUTO_TRADE_TOKEN) {
        return new Response('未授權：token 錯誤，或還沒設定 AUTO_TRADE_TOKEN 這個 secret。', { status: 403, headers: CORS_HEADERS });
      }
      if (!env.SMC_KV) return new Response('沒有設定 SMC_KV，無法記住開關狀態。', { status: 500, headers: CORS_HEADERS });
      const enable = url.pathname === '/auto-trade/on';
      await env.SMC_KV.put('auto-trade:enabled', String(enable));
      return new Response(
        enable ? '✅ 自動下單已開啟（Demo 模擬交易，非真錢）' : '⛔ 自動下單已關閉',
        { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS } },
      );
    }
    return new Response(
      'SMC 即時進場守門員\n\n' +
        '  GET /status         檢查設定與資料新鮮度\n' +
        '  GET /run            立刻執行一次（?dry=1 只看結果不推播）\n' +
        '  GET /auto-trade/status        查看自動下單開關（唯讀，不需要 token）\n' +
        '  GET /auto-trade/on?token=xxx  開啟自動下單（Demo）\n' +
        '  GET /auto-trade/off?token=xxx 關閉自動下單\n',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
};

// App（跟這支 Worker不同網域）要能直接用 fetch() 打 /auto-trade/* 這幾個端點，
// 才能在 App 裡放開關按鈕，不用手動貼網址；這裡的資訊本來就設計成公開唯讀
// 或需要 token 才能寫，加開 CORS 不會多暴露什麼。
const CORS_HEADERS = { 'access-control-allow-origin': '*' };
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS } });

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

  const autoTradeOn = await isAutoTradeEnabled(env);
  const sent = [];
  for (const hit of hits) {
    const key = `hit:${hit.row.symbol}:${hit.row.interval}:${hit.row.dir}:${hit.row.entry}`;
    if (env.SMC_KV) {
      if (await env.SMC_KV.get(key)) continue;
    }
    let autoTrade = null;
    if (!dry) {
      // 跟 Discord 通知共用同一個去重 key：同一個進場區只會下單一次，
      // 不會因為 Worker 每 2 分鐘重跑就對同一個訊號重複下單。
      if (autoTradeOn) autoTrade = await autoTradeOrder(env, hit);
      await postDiscord(env, buildEmbed(hit, market, autoTrade));
      if (env.SMC_KV) await env.SMC_KV.put(key, String(Date.now()), { expirationTtl: Number(cfg(env, 'ALERT_TTL_SEC')) });
    }
    sent.push(`${hit.row.symbol} ${hit.row.dir} @ ${hit.price}${autoTrade?.orderId ? ' 🤖已下單' : ''}`);
  }

  return {
    checked: watch.length,
    reached: hits.length,
    alerts: sent.length,
    sent,
    autoTradeOn,
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

function buildEmbed({ row: r, price }, market, autoTrade) {
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
        ...(autoTrade ? [{ name: '🤖 自動下單（Demo）', value: autoTradeText(autoTrade) }] : []),
      ],
      footer: { text: `${r.interval} 計畫 · 分析於 ${new Date(market.generatedAt).toISOString().slice(5, 16).replace('T', ' ')} UTC · 僅供研究，非投資建議` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function autoTradeText(t) {
  if (t.skipped === 'no-keys') return '⏭️ 尚未設定 BYBIT_DEMO_API_KEY／SECRET，已略過';
  if (t.error) return `❌ ${t.error}`;
  return `✅ 已送出市價單 · 數量 ${t.qty} · 這筆最多虧 ${fmt(t.riskAmount)} USDT`;
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

/* -------------------------------------------------------------- 自動下單（Demo） */

async function isAutoTradeEnabled(env) {
  if (!env.SMC_KV) return false;
  return (await env.SMC_KV.get('auto-trade:enabled')) === 'true';
}

const BYBIT_DEMO_HOST = 'https://api-demo.bybit.com';

/** 跟 src/exchange/bybit.js 同一套簽章規則：HMAC_SHA256(ts + apiKey + recvWindow + payload) */
async function bybitHmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function bybitCall(env, method, path, params = {}) {
  const apiKey = env.BYBIT_DEMO_API_KEY;
  const apiSecret = env.BYBIT_DEMO_API_SECRET;
  const ts = String(Date.now());
  const recvWindow = '10000';
  let url = BYBIT_DEMO_HOST + path;
  let body;
  let payload;
  if (method === 'GET') {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    payload = qs;
    if (qs) url += `?${qs}`;
  } else {
    body = JSON.stringify(params);
    payload = body;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': await bybitHmac(apiSecret, ts + apiKey + recvWindow + payload),
    },
    body,
  });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
  const j = await res.json();
  if (j.retCode !== 0) {
    const err = new Error(`Bybit [${j.retCode}] ${j.retMsg || '請求失敗'}`);
    err.code = j.retCode;
    throw err;
  }
  return j.result;
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/** 依步進值無條件捨去，寧可數量少一點也不要超出可用餘額被退單 */
function roundStep(value, step) {
  if (!(step > 0)) return value;
  return Number((Math.floor(value / step) * step).toFixed(decimalsOf(step)));
}

function roundTick(value, tick) {
  if (!(tick > 0)) return value;
  return Number((Math.round(value / tick) * tick).toFixed(decimalsOf(tick)));
}

/**
 * 用 Demo 帳戶目前的可用餘額 × 風險 % 算出下單數量，附停損與第一個停利，
 * 送出市價單。任何一步失敗都回傳 { error }——「有訊號要通知」永遠比
 * 「這筆有沒有下成」重要，所以呼叫端不會因為這裡失敗就不推播 Discord。
 */
async function autoTradeOrder(env, hit) {
  if (!env.BYBIT_DEMO_API_KEY || !env.BYBIT_DEMO_API_SECRET) return { skipped: 'no-keys' };
  const r = hit.row;
  try {
    const [wallet, instrument] = await Promise.all([
      bybitCall(env, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      bybitCall(env, 'GET', '/v5/market/instruments-info', { category: 'linear', symbol: r.symbol }),
    ]);
    const accountSize = Number(wallet?.list?.[0]?.totalAvailableBalance ?? 0);
    const it = instrument?.list?.[0];
    if (!it) return { error: `找不到合約 ${r.symbol}` };

    const qtyStep = Number(it.lotSizeFilter?.qtyStep ?? 0.001);
    const minQty = Number(it.lotSizeFilter?.minOrderQty ?? 0);
    const tickSize = Number(it.priceFilter?.tickSize ?? 0.01);
    const maxLeverage = Number(it.leverageFilter?.maxLeverage ?? 10);

    const perUnit = Math.abs(r.entry - r.stop);
    if (!(perUnit > 0) || !(accountSize > 0)) return { error: '風險參數不完整（帳戶餘額或停損距離為 0）' };

    const riskPct = Number(cfg(env, 'AUTO_TRADE_RISK_PCT'));
    const riskAmount = (accountSize * riskPct) / 100;
    const qty = roundStep(riskAmount / perUnit, qtyStep);
    if (qty < minQty) return { error: `算出數量 ${qty} 小於最小下單量 ${minQty}，可調高 AUTO_TRADE_RISK_PCT` };

    const leverage = Math.min(Number(cfg(env, 'AUTO_TRADE_LEVERAGE')), maxLeverage);
    await bybitCall(env, 'POST', '/v5/position/set-leverage', {
      category: 'linear', symbol: r.symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    }).catch((e) => { if (e.code !== 110043) throw e; }); // 已經是這個倍數，不算錯誤

    const order = await bybitCall(env, 'POST', '/v5/order/create', {
      category: 'linear',
      symbol: r.symbol,
      side: r.dir === 'long' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: String(qty),
      timeInForce: 'IOC',
      stopLoss: String(roundTick(r.stop, tickSize)),
      slTriggerBy: 'LastPrice',
      ...(r.targets?.[0] ? { takeProfit: String(roundTick(r.targets[0].price, tickSize)), tpTriggerBy: 'LastPrice' } : {}),
    });

    return { orderId: order?.orderId, qty, riskAmount };
  } catch (e) {
    return { error: e.message };
  }
}
