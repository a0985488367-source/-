/**
 * SMC 即時進場守門員（Cloudflare Worker）
 *
 * 分工（預設）：
 *   GitHub Actions  每小時做全市場 SMC 分析 → data/market.json（重運算）
 *   這支 Worker      每 2 分鐘比對現價與已算好的進場區 → 價格一到就推 Discord（輕運算）
 *
 * 為什麼原本這樣切：Workers 免費方案的 CPU 時間極短，跑不動完整的結構分析；
 * 但「比對價格」只是讀 JSON 加一個迴圈，幾毫秒就結束，非常適合高頻執行。
 * 升級到 Workers Paid（CPU 時間上限拉到 30 秒）之後，可以選擇性讓 Worker
 * 自己做縮小範圍的即時掃描，見下方「Worker 自己掃描」。
 *
 * 需要的設定：
 *   Secret    DISCORD_WEBHOOK_URL   Discord webhook 網址
 *   Variable  MARKET_URL            market.json 的網址（預設指向本倉庫）
 *   Variable  MIN_SCORE             只盯幾分以上的計畫（預設 65）
 *   KV        SMC_KV                用來記住已經通知過的標的，避免重複洗頻
 *
 * ── Worker 自己掃描（選用，預設關閉，需要 Workers Paid）───────────────
 * 開啟後不再讀 data/market.json，改成 Worker 自己即時分析市場，把「新機會
 * 多久出現一次」從 GitHub 排程實際上的 2～4 小時一次拉到每一批幾分鐘的
 * 等級。這份即時掃描只給這支 Worker 自己用，**不會**寫回 data/market.json，
 * App 網站的全市場掃描頁面看到的還是 GitHub 那份（120 檔、含資金費率），
 * 兩邊互不取代。
 *
 * 採「分批」架構，不是一次掃完整個候選池：Workers Paid 的 30 秒 CPU 上限
 * 撐不住一次把 WORKER_SCAN_TOP 檔都做完整的兩階段結構分析，所以每次真的
 * 重新掃描只處理 WORKER_SCAN_BATCH_SIZE 檔（候選池裡的一小段，循環索引），
 * 每隔 WORKER_SCAN_BATCH_INTERVAL_MIN 分鐘才算下一批，結果累積進 SMC_KV，
 * 繞完一輪候選池（≈ TOP / BATCH_SIZE 批）就等於整個候選池都更新過一次。
 * 例如 TOP=120、BATCH_SIZE=20、INTERVAL=10 分鐘 → 6 批 × 10 分鐘 ≈ 1 小時
 * 涵蓋 120 檔；拉長 INTERVAL 或縮小 BATCH_SIZE 可以再降低單批的運算量。
 *
 * 「算下一批」跟「Worker 每 2 分鐘的 cron 頻率」是兩回事：比對現價、自動
 * 下單這些仍然每 2 分鐘執行，只有「輪到的那一批要不要重新分析」照
 * WORKER_SCAN_BATCH_INTERVAL_MIN 的頻率跑，沒輪到批次的 tick 只讀 KV
 * 累積的結果，幾乎不用額外的請求或 CPU。
 *
 *   Variable  WORKER_SCAN_ENABLED             'true' 才會啟用（預設關閉）
 *   Variable  WORKER_SCAN_TOP                 候選池總大小（預設 120，依成交額
 *             排序取前 N 檔，循環一輪會全部掃過一次）
 *   Variable  WORKER_SCAN_BATCH_SIZE          每批真的重新掃描幾檔（預設 20；
 *             愈大單批 CPU 愈吃緊，愈小一輪要花愈久才能涵蓋整個候選池）
 *   Variable  WORKER_SCAN_BATCH_INTERVAL_MIN  幾分鐘算下一批（預設 10）
 *   Variable  WORKER_SCAN_INTERVAL            進場週期（預設 1h，跟 GitHub 那份一致）
 *
 * 注意：即使有分批，長期下來對外部交易所 API 的請求量還是會比原本 GitHub
 * 排程高（頻率拉高了），開啟前請留意交易所的速率限制。
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
 *   Variable  AUTO_TRADE_RISK_PCT    每筆風險占帳戶餘額的 %（預設 1，固定值，不分評分高低）
 *   Variable  AUTO_TRADE_LEVERAGE_MIN/MAX  槓桿倍數的範圍（預設 3～10），照訊號評分線性插值，
 *             評分等於 MIN_SCORE 給 MIN 倍、100 分給 MAX 倍，會自動不超過該合約上限。
 *             槓桿只影響「用多少保證金」，不影響「這筆最多虧多少錢」（停損永遠先決定風險
 *             金額），所以照評分調槓桿不會有「分數愈高賭愈大」的問題——這跟照評分調
 *             倉位大小是兩回事，倉位大小目前刻意維持固定 %，不分評分。
 *   KV        SMC_KV 的 auto-trade:enabled 這個 key，預設不存在＝關閉
 *
 * 下單成功後會把這筆部位記進 SMC_KV（key 開頭 open-pos:），之後每次執行都
 * 會比對「追蹤中的部位」跟 Bybit 現在實際的持倉，少了的就代表平倉了，
 * 推一則結算通知（用偵測到平倉當下的市價估算 R，不是交易所的精確成交價）。
 *
 * 開關（開啟後才會真的下單，就算金鑰都設定好了）：
 *   GET /auto-trade/status         查看目前開/關（不需要 token，唯讀）
 *   GET /auto-trade/on?token=xxx   開啟
 *   GET /auto-trade/off?token=xxx  關閉 —— 這個網址建議加到手機主畫面當緊急煞車
 *
 * 部署走的是 esbuild 打包（見 deploy-worker.yml），把這個檔案跟它 import
 * 的 SMC 引擎（src/market/scan.js 及其依賴）打包成一個檔案再上傳，所以這裡
 * 可以正常 import。但 Bybit 的簽章／下單邏輯是例外：那段刻意獨立複製、
 * 沒有 import ../src/exchange/bybit.js——純粹是因為那份程式碼很小、改動
 * 頻率低，獨立一份比較不會被市場掃描那邊的改動意外牽動；行為刻意對齊
 * src/exchange/bybit.js，改動風控或簽章邏輯時兩邊都要看。
 */

import { scanMarket } from '../src/market/scan.js';

const DEFAULTS = {
  MARKET_URL: 'https://raw.githubusercontent.com/a0985488367-source/-/main/data/market.json',
  MIN_SCORE: '65',
  MAX_MARKET_AGE_MIN: '240',
  ALERT_TTL_SEC: '21600', // 同一個進場區 6 小時內只通知一次
  NEAR_PCT: '0.08',       // 距離進場區多近就算「到了」（%）
  AUTO_TRADE_RISK_PCT: '1',
  AUTO_TRADE_LEVERAGE_MIN: '3',
  AUTO_TRADE_LEVERAGE_MAX: '10',
  WORKER_SCAN_ENABLED: 'false',
  WORKER_SCAN_TOP: '120',              // 候選池總大小：想涵蓋幾檔（循環一輪會全部算過）
  WORKER_SCAN_BATCH_SIZE: '20',        // 每次真的重新掃描只算這麼多檔，CPU 才不會爆
  WORKER_SCAN_BATCH_INTERVAL_MIN: '10', // 幾分鐘算下一批；一輪時間 ≈ (TOP/BATCH_SIZE) × 這個值
  WORKER_SCAN_INTERVAL: '1h',
};

const cfg = (env, key) => env[key] ?? DEFAULTS[key];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 槓桿照評分線性插值：評分等於 MIN_SCORE（Worker 連看都不會看的下限）給
 * LEVERAGE_MIN 倍，100 分給 LEVERAGE_MAX 倍。分數不在這個範圍就夾住。
 */
function leverageForScore(env, score) {
  const min = Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MIN'));
  const max = Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MAX'));
  const floor = Number(cfg(env, 'MIN_SCORE'));
  if (!(max > min) || !(100 > floor)) return min;
  const t = clamp((score - floor) / (100 - floor), 0, 1);
  return Math.round(min + t * (max - min));
}

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
      // 這裡刻意固定讀 GitHub 那份（不管 WORKER_SCAN_ENABLED 有沒有開），
      // 讓 /status 維持是一個「秒回」的輕量檢查，不會因為呼叫它而觸發一次
      // 完整掃描。真正在跑的資料源看 workerScanEnabled 這個欄位就知道。
      const market = await getMarket(env).catch((e) => ({ error: e.message }));
      const workerScanEnabled = cfg(env, 'WORKER_SCAN_ENABLED') === 'true';
      // 只讀 KV，不會觸發真正的掃描——用來確認「分批掃描到底有沒有照
      // WORKER_SCAN_BATCH_INTERVAL_MIN 在跑、涵蓋到候選池多少比例」，
      // 不用另外查 Cloudflare 後台。
      let workerScanCache = null;
      if (workerScanEnabled && env.SMC_KV) {
        const metaRaw = await env.SMC_KV.get(WORKER_SCAN_META_KEY).catch(() => null);
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY).catch(() => null);
          const rows = rowsRaw ? JSON.parse(rowsRaw) : {};
          workerScanCache = {
            lastBatchAt: meta.lastBatchAt,
            lastBatchAgeMinutes: Math.round((Date.now() - new Date(meta.lastBatchAt).getTime()) / 60000),
            provider: meta.provider,
            coveredSymbols: Object.keys(rows).length,
            poolTotal: meta.poolTotal,
          };
        }
      }
      return json({
        ok: true,
        marketUrl: cfg(env, 'MARKET_URL'),
        minScore: Number(cfg(env, 'MIN_SCORE')),
        workerScanEnabled,
        workerScanTop: workerScanEnabled ? Number(cfg(env, 'WORKER_SCAN_TOP')) : null,
        workerScanBatchSize: workerScanEnabled ? Number(cfg(env, 'WORKER_SCAN_BATCH_SIZE')) : null,
        workerScanBatchIntervalMin: workerScanEnabled ? Number(cfg(env, 'WORKER_SCAN_BATCH_INTERVAL_MIN')) : null,
        workerScanCache,
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
        leverageMin: Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MIN')),
        leverageMax: Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MAX')),
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

  // 部位關閉偵測跟這次掃描的新訊號完全獨立，放在 market.json 新鮮度檢查
  // 之前執行——不然 market.json 剛好太舊的那幾分鐘，已經開倉的部位就算真的
  // 平倉了也不會被通知到。
  const closedPositions = dry ? { checked: 0, closed: 0 } : await checkClosedPositions(env).catch(() => ({ checked: 0, closed: 0, error: true }));

  const market = await getFreshMarket(env);
  const ageMin = (Date.now() - new Date(market.generatedAt).getTime()) / 60000;
  if (ageMin > Number(cfg(env, 'MAX_MARKET_AGE_MIN'))) {
    return { skipped: 'market-too-old', ageMinutes: Math.round(ageMin), closedPositions };
  }

  const minScore = Number(cfg(env, 'MIN_SCORE'));
  const nearPct = Number(cfg(env, 'NEAR_PCT'));
  const watch = market.rows.filter((r) => r.valid && r.status === 'waiting' && r.score >= minScore);
  if (!watch.length) return { checked: 0, alerts: 0, ageMinutes: Math.round(ageMin), closedPositions };

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
    closedPositions,
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

const WORKER_SCAN_ROWS_KEY = 'worker-scan:rows';
const WORKER_SCAN_META_KEY = 'worker-scan:meta';
const WORKER_SCAN_CURSOR_KEY = 'worker-scan:cursor';

/** 把 SMC_KV 裡累積的批次結果組成跟 data/market.json 一樣的結構 */
function assembleMarket(meta, rows) {
  return {
    generatedAt: meta.lastBatchAt,
    provider: meta.provider,
    interval: meta.interval,
    htfInterval: meta.htfInterval,
    universe: meta.poolTotal,
    rows: Object.values(rows),
  };
}

/**
 * 讀「這次要用哪份市場掃描結果」：預設沿用 GitHub Actions 算好的
 * data/market.json（每小時排程，GitHub 免費版實際上常常是 2～4 小時一次）；
 * 開啟 WORKER_SCAN_ENABLED 後改成 Worker 自己即時算一份，只給這支 Worker
 * 自己的即時比價／自動下單用，不會寫回 data/market.json，App 網站看到的
 * 全市場掃描頁面不受影響。
 *
 * 分批架構（細節見檔案開頭的說明）：候選池 WORKER_SCAN_TOP 檔，每次真的
 * 重新掃描只算 WORKER_SCAN_BATCH_SIZE 檔（用 SMC_KV 記住掃到候選池的第幾
 * 個位置，下次接著算，繞一圈就等於整個候選池都更新過），結果累積進
 * worker-scan:rows；還沒輪到下一批的 tick 直接沿用累積的結果，不會真的
 * 打任何外部 API。
 */
async function getFreshMarket(env) {
  if (cfg(env, 'WORKER_SCAN_ENABLED') !== 'true') return getMarket(env);

  const providerIds = env.WORKER_SCAN_PROVIDERS ? env.WORKER_SCAN_PROVIDERS.split(',') : undefined;
  const top = Number(cfg(env, 'WORKER_SCAN_TOP'));
  const batchSize = Number(cfg(env, 'WORKER_SCAN_BATCH_SIZE'));
  const interval = cfg(env, 'WORKER_SCAN_INTERVAL');
  const minScore = Number(cfg(env, 'MIN_SCORE'));

  if (!env.SMC_KV) {
    // 沒有 KV 就沒辦法記住批次進度／累積結果，退化成每次都整批重掃
    // WORKER_SCAN_TOP 檔——這個數字如果照預設值 120，很容易在 Workers Paid
    // 的 30 秒 CPU 上限內跑不完，沒設 KV 的話務必自己把它調小。
    return scanMarket({ providerIds, top, detailTop: top, interval, minScore });
  }

  const intervalMin = Number(cfg(env, 'WORKER_SCAN_BATCH_INTERVAL_MIN'));
  const metaRaw = await env.SMC_KV.get(WORKER_SCAN_META_KEY);
  const meta = metaRaw ? JSON.parse(metaRaw) : null;
  const dueForBatch = !meta || (Date.now() - new Date(meta.lastBatchAt).getTime()) / 60000 >= intervalMin;

  if (!dueForBatch) {
    const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY);
    return assembleMarket(meta, rowsRaw ? JSON.parse(rowsRaw) : {});
  }

  const cursor = Number((await env.SMC_KV.get(WORKER_SCAN_CURSOR_KEY)) || '0');
  const batch = await scanMarket({ providerIds, top, offset: cursor, batchSize, interval, minScore, detailTop: batchSize });

  const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY);
  const rows = rowsRaw ? JSON.parse(rowsRaw) : {};
  const qualified = new Map(batch.rows.map((r) => [r.symbol, r]));
  // 這一批考慮過但沒通過門檻的，要從累積結果裡刪掉——不然分數掉下去的
  // 標的會卡在舊資料裡，一直到下一輪才被清掉都不夠即時
  for (const symbol of batch.universeSymbols) {
    if (qualified.has(symbol)) rows[symbol] = qualified.get(symbol);
    else delete rows[symbol];
  }

  const newMeta = {
    provider: batch.provider,
    interval: batch.interval,
    htfInterval: batch.htfInterval,
    poolTotal: batch.poolTotal,
    lastBatchAt: batch.generatedAt,
  };
  const nextCursor = batch.poolTotal ? (cursor + batch.universe) % batch.poolTotal : 0;

  await Promise.all([
    env.SMC_KV.put(WORKER_SCAN_ROWS_KEY, JSON.stringify(rows)),
    env.SMC_KV.put(WORKER_SCAN_META_KEY, JSON.stringify(newMeta)),
    env.SMC_KV.put(WORKER_SCAN_CURSOR_KEY, String(nextCursor)),
  ]);

  return assembleMarket(newMeta, rows);
}

/**
 * 取得現價，優先用 Bybit（USDT 永續，跟自動下單實際下單的合約類別一致，
 * 觸發判斷才會跟真正成交的價格對得上）。Bybit 打不到才退到 Binance，
 * 兩者都失敗最後退到 OKX。三個都只用一次請求拿回全部需要的價格。
 */
async function getPrices(symbols) {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    if (res.ok) {
      const data = await res.json();
      if (data.retCode === 0 && Array.isArray(data.result?.list)) {
        const out = {};
        for (const r of data.result.list) out[r.symbol] = Number(r.lastPrice);
        return out;
      }
    }
  } catch {}
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
  return `✅ 已送出市價單 · 數量 ${t.qty} · ${t.leverage}x 槓桿 · 這筆最多虧 ${fmt(t.riskAmount)} USDT`;
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

    const leverage = Math.min(leverageForScore(env, r.score), maxLeverage);
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

    // 記住這筆倉位，之後每次執行才知道要去比對它是不是已經平倉了。
    // 同一個「幣種＋方向」如果本來就有追蹤中的紀錄會直接覆蓋——Bybit 單向模式下
    // 同幣種同方向本來就只會有一個聚合部位，第二筆訂單是加碼到同一個部位，
    // 不是開一個新的；代價是進場價會變成「最後一次加碼的價格」而不是均價，
    // 這裡先接受這個簡化，不做加權平均。
    if (env.SMC_KV) {
      await env.SMC_KV.put(`open-pos:${r.symbol}:${r.dir}`, JSON.stringify({
        symbol: r.symbol, dir: r.dir, entry: r.entry, stop: r.stop, targets: r.targets,
        qty, riskAmount, leverage, grade: r.grade, score: r.score, openedAt: Date.now(),
      }));
    }

    return { orderId: order?.orderId, qty, riskAmount, leverage };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 比對追蹤中的部位跟 Bybit 現在實際的持倉：追蹤中但現在不在了 = 平倉了，
 * 推一則結算通知。跟 /v5/position/closed-pnl 不一樣——那個端點官方文件跟
 * 社群回報都提到對 Demo 帳戶不穩定，這裡改用已經在用、確定可靠的
 * /v5/position/list（App 的「目前持倉」也是靠它），只是換一個角度：
 * 「原本追蹤的部位不見了」就代表平倉，用偵測到當下的市價回推大概的 R，
 * 不是交易所回報的精確成交價，這點會清楚寫在推播裡，不假裝比實際準確。
 */
async function checkClosedPositions(env) {
  if (!env.SMC_KV || !env.BYBIT_DEMO_API_KEY || !env.BYBIT_DEMO_API_SECRET) return { checked: 0, closed: 0 };
  const tracked = await env.SMC_KV.list({ prefix: 'open-pos:' });
  if (!tracked.keys.length) return { checked: 0, closed: 0 };

  const real = await bybitCall(env, 'GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
  const stillOpen = new Set(
    (real?.list ?? [])
      .filter((p) => Number(p.size) > 0)
      .map((p) => `open-pos:${p.symbol}:${p.side === 'Buy' ? 'long' : 'short'}`),
  );

  let closed = 0;
  for (const { name: key } of tracked.keys) {
    if (stillOpen.has(key)) continue;
    const raw = await env.SMC_KV.get(key);
    if (raw) {
      const pos = JSON.parse(raw);
      try {
        const prices = await getPrices([pos.symbol]);
        const exitPrice = prices[pos.symbol];
        if (exitPrice) await postDiscord(env, buildCloseEmbed(pos, exitPrice));
      } catch { /* 平倉通知失敗也要把追蹤紀錄刪掉，不然會卡住一直重試同一筆 */ }
    }
    await env.SMC_KV.delete(key);
    closed++;
  }
  return { checked: tracked.keys.length, closed };
}

function buildCloseEmbed(pos, exitPrice) {
  const base = pos.symbol.replace(/USDT$/, '');
  const long = pos.dir === 'long';
  const perUnit = Math.abs(pos.entry - pos.stop);
  const r = perUnit > 0 ? ((long ? exitPrice - pos.entry : pos.entry - exitPrice) / perUnit) : 0;
  const win = r > 0;
  return {
    username: 'SMC 即時守門員',
    embeds: [{
      title: `${win ? '✅' : '❌'} ${base}/USDT ${long ? '做多' : '做空'} 已平倉（Demo）· ${r >= 0 ? '+' : ''}${r.toFixed(2)}R`,
      color: win ? 0x26a69a : 0xef5350,
      description: `進場 ${fmt(pos.entry)} → 平倉當下市價約 ${fmt(exitPrice)}（用偵測到平倉那一刻的市價估算，不是交易所回報的精確成交價，會有些微誤差）`,
      fields: [
        { name: '數量', value: String(pos.qty), inline: true },
        { name: '槓桿', value: `${pos.leverage}x`, inline: true },
        { name: '當初風險', value: `${fmt(pos.riskAmount)} USDT`, inline: true },
        { name: '等級', value: `${pos.grade}（${pos.score} 分）`, inline: true },
      ],
      footer: { text: '僅供研究，非投資建議' },
      timestamp: new Date().toISOString(),
    }],
  };
}
