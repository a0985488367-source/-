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
 * 採「分批」架構，不是一次掃完整個候選池：實測 SMC 結構分析本身很便宜
 * （120 檔全掃只要不到 1 秒 CPU 時間，30 秒上限完全夠用），真正的瓶頸是
 * 對外請求——Cloudflare Worker 打外部 API 是從邊緣節點的共用 IP 出去，
 * 跟同時間其他 Cloudflare 客戶共用同一個 IP，一次塞太多請求容易被交易所
 * 的 IP 限流擋掉（實測一次掃 20 檔就有 3 成起跳的失敗率）。分批把請求量
 * 攤開在時間軸上，同一批內也用 WORKER_SCAN_CONCURRENCY 限制同時發出的
 * 請求數，兩者都是在跟「這個 IP 看起來太像機器人」拉開距離，不是在省
 * CPU。每次真的重新掃描只處理 WORKER_SCAN_BATCH_SIZE 檔（候選池裡的一
 * 小段，循環索引），每隔 WORKER_SCAN_BATCH_INTERVAL_MIN 分鐘才算下一批，
 * 結果累積進 SMC_KV，繞完一輪候選池（≈ TOP / BATCH_SIZE 批）就等於整個
 * 候選池都更新過一次。例如 TOP=120、BATCH_SIZE=20、INTERVAL=10 分鐘 →
 * 6 批 × 10 分鐘 ≈ 1 小時涵蓋 120 檔；縮小 BATCH_SIZE 或 CONCURRENCY 可以
 * 再降低單批的請求密度。
 *
 * 「算下一批」跟「Worker 每 2 分鐘的 cron 頻率」是兩回事：比對現價、自動
 * 下單這些仍然每 2 分鐘執行，只有「輪到的那一批要不要重新分析」照
 * WORKER_SCAN_BATCH_INTERVAL_MIN 的頻率跑，沒輪到批次的 tick 只讀 KV
 * 累積的結果，幾乎不用額外的請求或 CPU。
 *
 * 累積門檻（WORKER_SCAN_MIN_SCORE）刻意跟推播／下單門檻（MIN_SCORE）分開，
 * 不能搞混：掃描階段只要「這是個有效計畫」就先存起來（跟 GitHub Actions
 * 那份 data/market.json 的做法一致），要不要因此推播、下單留到 run() 檢查
 * 現價那一步才照 MIN_SCORE 篩。如果掃描這一步就直接套用 MIN_SCORE，等於
 * 「這一批剛好有幾檔當下超過門檻」才留得下來，候選池繞完一輪也累積不了
 * 多少標的——這是實測踩到的坑，記錄下來避免以後又改回去。
 *
 *   Variable  WORKER_SCAN_ENABLED             'true' 才會啟用（預設關閉）
 *   Variable  WORKER_SCAN_TOP                 候選池總大小（預設 120，依成交額
 *             排序取前 N 檔，循環一輪會全部掃過一次）
 *   Variable  WORKER_SCAN_BATCH_SIZE          每批真的重新掃描幾檔（預設 20；
 *             愈大單批 CPU 愈吃緊，愈小一輪要花愈久才能涵蓋整個候選池）
 *   Variable  WORKER_SCAN_BATCH_INTERVAL_MIN  幾分鐘算下一批（預設 10）
 *   Variable  WORKER_SCAN_INTERVAL            進場週期，可以逗號分隔開多個
 *             （例如 "3m,15m,30m,1h"，預設 1h，跟 GitHub 那份一致）：每個
 *             週期各自輪流掃描，同一個 tick 只會真的重新掃描一個到期的
 *             週期，不會因為多加週期就讓單批的請求量變大——細節見
 *             getFreshMarket() 的說明
 *   Variable  WORKER_SCAN_MIN_SCORE           掃描累積門檻（預設 0，幾乎不濾）
 *   Variable  WORKER_SCAN_CONCURRENCY         單批內同時發出的請求數（預設 3；
 *             Cloudflare 邊緣節點是共用 IP，愈大愈容易被交易所限流擋掉）
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
 * ── 部位管理（保本鏢／移到成本價／追蹤停損）─────────────────────────────
 * 下單套用的是 README「部位管理」那段 A/B 實測驗證過的同一組規則
 * （src/smc/manage.js 的 DEFAULT_MANAGEMENT／buildLadder，跟模擬盤追蹤、
 * 回測共用同一份常數，三條規則綁在一起才有實測的 75% 勝率）：
 *   1. 保本鏢：開倉當下就把 +0.5R 的分批出場單（34% 部位）掛成真的 Bybit
 *      reduce-only 限價單，剩餘部位平均分給原本的目標價，也都掛成限價單——
 *      價格到了交易所自己成交，不用等 Worker 輪詢才發現。
 *   2. 移到成本價：獲利到 +0.5R 之後，把停損搬到進場價 +0.05R（多單，空單反向）。
 *   3. 追蹤停損：獲利超過 +1.5R 之後，停損改成跟著最高獲利走，距離 0.8R，
 *      只會愈移愈緊，不會反向鬆開。
 * 這兩條停損規則靠 Worker 每 2 分鐘輪詢現價、算目前的 maxFavorableR 有沒有
 * 過門檻，過了就呼叫 Bybit 的 /v5/position/trading-stop 把停損單搬過去
 * （分批出場單是開倉當下就掛好的真實限價單，不需要輪詢）。
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
 *
 * ── 把 Worker 自己的掃描結果寫回 data/market.json（選用，預設關閉）────────
 * 開了 WORKER_SCAN_ENABLED 之後，Worker 自己算的那份預設只給自己用，
 * App 網站「全市場掃描」頁面看到的還是 GitHub Actions 那份（會被 GitHub
 * 免費版的排程節流，常常 2～4 小時才更新一次）。設定這個 secret 之後，
 * Worker 每算完一批（約每 WORKER_SCAN_BATCH_INTERVAL_MIN 分鐘一次）就會
 * 順便透過 GitHub Contents API 把累積的結果寫回 data/market.json，
 * App 頁面也會跟著即時更新，不用再等 GitHub 的排程。
 *
 * 資金費率／未平倉量（GitHub 那份才有算）不會因此消失：寫回前會先讀舊檔，
 * 把舊資料裡每個標的的 `deriv` 欄位原封不動接到新資料同一個標的上，沒有
 * 對到的（Worker 這批新掃到、舊檔沒有的標的）就沒有這欄，UI 會顯示「—」。
 *
 *   Secret    GITHUB_API_TOKEN   GitHub fine-grained PAT，只需要這個倉庫的
 *             Contents 讀寫權限（Settings → Developer settings →
 *             Fine-grained tokens），絕對不要給超出這個倉庫的權限
 *   Variable  GITHUB_REPO        預設 a0985488367-source/-
 *   Variable  GITHUB_MARKET_PATH 預設 data/market.json
 *
 * 沒設定 GITHUB_API_TOKEN 就完全不會嘗試寫入，行為跟現在一樣。
 */

import { scanMarket } from '../src/market/scan.js';
import { DEFAULT_MANAGEMENT, buildLadder } from '../src/smc/manage.js';

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
  WORKER_SCAN_BATCH_SIZE: '20',        // 每次真的重新掃描只算這麼多檔，請求量才不會一次太密集
  WORKER_SCAN_BATCH_INTERVAL_MIN: '10', // 幾分鐘算下一批；一輪時間 ≈ (TOP/BATCH_SIZE) × 這個值
  WORKER_SCAN_INTERVAL: '1h',
  WORKER_SCAN_MIN_SCORE: '0', // 掃描時累積用的門檻，故意很低；真正要不要推播/下單看 MIN_SCORE
  WORKER_SCAN_CONCURRENCY: '3', // 單批內同時發出的請求數，共用 IP 愈大愈容易被限流
  GITHUB_REPO: 'a0985488367-source/-',
  GITHUB_MARKET_PATH: 'data/market.json',
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
        const configuredIntervals = cfg(env, 'WORKER_SCAN_INTERVAL').split(',').map((s) => s.trim()).filter(Boolean);
        const metaRaw = await env.SMC_KV.get(WORKER_SCAN_META_KEY).catch(() => null);
        const metaByInterval = parseScanMeta(metaRaw, configuredIntervals);
        if (Object.keys(metaByInterval).length) {
          const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY).catch(() => null);
          const rows = parseScanRows(rowsRaw, configuredIntervals);
          const entries = Object.entries(metaByInterval);
          // 有多個週期（WORKER_SCAN_INTERVAL 逗號分隔）時，每個週期是各自
          // 分開輪流掃描的，所以每個週期都有自己的 lastBatchAt／診斷欄位——
          // perInterval 逐一列出；下面幾個頂層欄位則是取「最新更新的那個
          // 週期」當代表，方便一眼看整體狀態。
          const latestEntry = entries.reduce(
            (a, b) => (!a || new Date(b[1].lastBatchAt) > new Date(a[1].lastBatchAt) ? b : a),
            null,
          );
          const latest = latestEntry?.[1] ?? null;
          workerScanCache = {
            lastBatchAt: latest?.lastBatchAt ?? null,
            lastBatchAgeMinutes: latest ? Math.round((Date.now() - new Date(latest.lastBatchAt).getTime()) / 60000) : null,
            provider: latest?.provider ?? null,
            coveredSymbols: Object.keys(rows).length,
            poolTotal: latest?.poolTotal ?? null,
            // coveredSymbols 是 0 的時候，靠這幾個欄位分辨是「這一批真的都沒
            // 通過門檻」還是「資料源這批幾乎都要不到資料」（lastBatchErrors
            // 接近 lastBatchScanned 就是後者——這種情況調 WORKER_SCAN_MIN_SCORE
            // 沒有用，要查的是資料源本身）。這些數字是最新更新那個週期的，
            // 其他週期各自的數字看 perInterval。
            lastBatchScanned: latest?.lastBatchScanned ?? null,
            lastBatchSkippedLowVolatility: latest?.lastBatchSkippedLowVolatility ?? null,
            lastBatchErrors: latest?.lastBatchErrors ?? null,
            lastBatchQualified: latest?.lastBatchQualified ?? null,
            lastBatchSampleError: latest?.lastBatchSampleError ?? null,
            perInterval: entries.map(([interval, m]) => ({
              interval,
              lastBatchAt: m.lastBatchAt,
              lastBatchAgeMinutes: Math.round((Date.now() - new Date(m.lastBatchAt).getTime()) / 60000),
              provider: m.provider,
              poolTotal: m.poolTotal,
              lastBatchErrors: m.lastBatchErrors ?? null,
              lastBatchQualified: m.lastBatchQualified ?? null,
            })),
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
        workerScanMinScore: workerScanEnabled ? Number(cfg(env, 'WORKER_SCAN_MIN_SCORE')) : null,
        workerScanConcurrency: workerScanEnabled ? Number(cfg(env, 'WORKER_SCAN_CONCURRENCY')) : null,
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
      const hasKeys = !!(env.BYBIT_DEMO_API_KEY && env.BYBIT_DEMO_API_SECRET);
      // 多週期上線後訊號變多，同時間可能有更多部位在開——加上帳戶餘額跟
      // 追蹤中的部位數，排查「[110007] ab not enough for new order」這種
      // 下單失敗時，才能直接看出是保證金真的被既有部位佔滿，還是別的問題，
      // 不用再另外查 Bybit 後台。只讀，不會因為查狀態就多下單。
      let wallet = null;
      if (hasKeys) {
        wallet = await bybitCall(env, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, { retries: 1 })
          .then((w) => ({ totalAvailableBalance: Number(w?.list?.[0]?.totalAvailableBalance ?? 0), totalWalletBalance: Number(w?.list?.[0]?.totalWalletBalance ?? 0) }))
          .catch((e) => ({ error: e.message }));
      }
      const openPositions = env.SMC_KV ? await env.SMC_KV.list({ prefix: 'open-pos:' }).then((r) => r.keys.map((k) => k.name)) : [];
      return json({
        enabled: await isAutoTradeEnabled(env),
        hasKeys,
        mode: 'demo',
        riskPct: Number(cfg(env, 'AUTO_TRADE_RISK_PCT')),
        leverageMin: Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MIN')),
        leverageMax: Number(cfg(env, 'AUTO_TRADE_LEVERAGE_MAX')),
        wallet,
        trackedOpenPositions: openPositions.length,
        openPositions,
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
  // 平倉了也不會被通知到。停損的移動（成本價／追蹤）也一樣獨立，接在關閉
  // 偵測後面：先把已經不在的部位清掉，剩下的才需要考慮搬停損。
  const closedPositions = dry ? { checked: 0, closed: 0 } : await checkClosedPositions(env).catch(() => ({ checked: 0, closed: 0, error: true }));
  const trailingStops = dry ? { checked: 0, moved: 0 } : await updateTrailingStops(env).catch(() => ({ checked: 0, moved: 0, error: true }));

  const market = await getFreshMarket(env);
  const ageMin = (Date.now() - new Date(market.generatedAt).getTime()) / 60000;
  if (ageMin > Number(cfg(env, 'MAX_MARKET_AGE_MIN'))) {
    return { skipped: 'market-too-old', ageMinutes: Math.round(ageMin), closedPositions, trailingStops };
  }

  const minScore = Number(cfg(env, 'MIN_SCORE'));
  const nearPct = Number(cfg(env, 'NEAR_PCT'));
  const watch = market.rows.filter((r) => r.valid && r.status === 'waiting' && r.score >= minScore);
  if (!watch.length) return { checked: 0, alerts: 0, ageMinutes: Math.round(ageMin), closedPositions, trailingStops };

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
    trailingStops,
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

/**
 * 支援多週期之前，worker-scan:meta 是攤平的單一物件（{provider, interval,
 * lastBatchAt, ...}），不是「週期 → meta」的巢狀結構。升級後如果 KV 裡
 * 還留著這種舊格式，Object.entries() 會把 provider/interval 這些欄位名
 * 誤判成「週期名稱」，而且舊格式裡某些欄位的值本來就會是 null（例如
 * lastBatchSampleError），對 null 取 .lastBatchAt 會直接丟例外炸掉整個
 * request——實測部署後 /status、/run 全部回 500 就是這個問題。
 * 偵測格式不符就當成沒掃過（回傳空物件），讓系統用新格式從頭累積，
 * 比硬解析猜測舊資料該對應到哪個新設定的週期安全。
 * 另外，如果 WORKER_SCAN_INTERVAL 後來把某個週期拿掉了（例如原本開了
 * 3m/15m，後來覺得雜訊太多改回只留 30m/1h/4h），KV 裡屬於那個週期的舊
 * meta 不會自動消失——不主動濾掉的話，/status 的 perInterval 會一直
 * 顯示一個已經不會再更新、早就過期的週期，容易誤導。傳入目前設定的
 * intervals 清單，濾掉不在清單裡的週期。
 */
function parseScanMeta(metaRaw, intervals) {
  if (!metaRaw) return {};
  let meta;
  try { meta = JSON.parse(metaRaw); } catch { return {}; }
  const looksValid = meta && typeof meta === 'object'
    && Object.values(meta).every((m) => m && typeof m === 'object' && typeof m.lastBatchAt === 'string');
  if (!looksValid) return {};
  return intervals ? Object.fromEntries(Object.entries(meta).filter(([iv]) => intervals.includes(iv))) : meta;
}

/**
 * 支援多週期之前，worker-scan:rows 是用裸 symbol 當 key；現在改成
 * `${interval}::${symbol}`（見 scanRowKey）避免不同週期的同一個 symbol
 * 互相覆蓋。升級後 KV 裡如果還留著舊格式的 key（沒有 "::"），直接濾掉
 * ——不然這些資料格式對不上，卻會被 Object.values() 當成正常的計畫，
 * 混進 run() 的監看名單，用不知道是哪個週期、可能早就過期的進場價／
 * 停損價去比對現價，非常危險。
 *
 * 同樣，WORKER_SCAN_INTERVAL 拿掉某個週期之後，屬於那個週期的舊
 * `${interval}::${symbol}` 資料也要濾掉——不然已經不想再看的短週期
 * 計畫（例如刻意拿掉的 3m/15m）會一直卡在累積結果裡，永遠不會被下一批
 * 掃描更新或清掉，卻仍然混進 run() 的監看名單，可能觸發推播或下單。
 * 傳入目前設定的 intervals 清單才會做這層過濾；不傳就只做格式檢查
 * （呼叫端還沒讀到 intervals 設定的極少數情況）。
 */
function parseScanRows(rowsRaw, intervals) {
  if (!rowsRaw) return {};
  let rows;
  try { rows = JSON.parse(rowsRaw); } catch { return {}; }
  if (!rows || typeof rows !== 'object') return {};
  return Object.fromEntries(Object.entries(rows).filter(([k]) => {
    const sep = k.indexOf('::');
    if (sep < 0) return false;
    return !intervals || intervals.includes(k.slice(0, sep));
  }));
}

/**
 * 同樣的道理，worker-scan:cursor 以前是單一數字（字串形式），現在改成
 * `{ [interval]: number }`。JSON.parse 一個數字字串會得到 JS 數字（不是
 * 物件），如果直接照舊格式沿用，之後對它寫入 cursorByInterval[interval]
 * = ... 在 strict mode 下會丟「Cannot create property on number」的例外
 * ——所以一樣要先驗證格式，不是物件就當成沒有游標，從頭開始算。
 */
function parseScanCursor(cursorRaw) {
  if (!cursorRaw) return {};
  let cursor;
  try { cursor = JSON.parse(cursorRaw); } catch { return {}; }
  return cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor : {};
}

/**
 * 支援多個進場週期（WORKER_SCAN_INTERVAL 可以是逗號分隔的清單，例如
 * "3m,15m,30m,1h"）之後，同一個 symbol 在不同週期會有不同的計畫，
 * 存進 worker-scan:rows 時要用「週期+symbol」當 key，不然不同週期的
 * 計畫會互相覆蓋掉。
 */
const scanRowKey = (interval, symbol) => `${interval}::${symbol}`;

/**
 * 把 SMC_KV 裡累積的批次結果組成跟 data/market.json 一樣的結構。
 * meta 現在是「每個週期各自的 meta」（{ [interval]: {...} }），因為每個
 * 週期是分開輪流掃描的；用最新一次的那個週期的 meta 當代表（provider、
 * generatedAt 這些欄位本來就只是給人看的摘要，真正要看的資料在 rows，
 * 每一列都自己帶著 interval 欄位）。
 */
function assembleMarket(metaByInterval, rows) {
  const metas = Object.values(metaByInterval);
  const latest = metas.reduce((a, b) => (!a || new Date(b.lastBatchAt) > new Date(a.lastBatchAt) ? b : a), null);
  return {
    generatedAt: latest?.lastBatchAt ?? null,
    provider: latest?.provider ?? null,
    interval: metas.map((m) => m.interval).join(','),
    htfInterval: latest?.htfInterval ?? null,
    universe: latest?.poolTotal ?? null,
    rows: Object.values(rows),
  };
}

/** UTF-8 安全的 base64 編碼／解碼——GitHub Contents API 的 content 欄位是 base64，
 *  但市場資料裡的中文欄位（regimeZh 等）用 btoa/atob 直接轉會壞掉，要先過 TextEncoder。 */
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 把 Worker 自己累積的掃描結果透過 GitHub Contents API 寫回 data/market.json，
 * 讓 App 網站「全市場掃描」頁面也能即時更新，不用再等 GitHub Actions 那個
 * 會被排程節流的排程。選用功能：沒設定 GITHUB_API_TOKEN 就完全不會嘗試。
 *
 * 資金費率／未平倉量（`row.deriv`）是 GitHub Actions 那份才會另外去抓的，
 * Worker 自己的掃描沒有算這個——寫入前先讀舊檔，把舊資料裡每個標的的
 * `deriv` 原封不動接到新資料同一個標的上，沒對到的就沒有這欄（UI 會顯示
 * 「—」，不是壞掉）。
 */
async function publishMarketToGitHub(env, rows, meta) {
  if (!env.GITHUB_API_TOKEN) return { skipped: 'no-token' };
  const repo = cfg(env, 'GITHUB_REPO');
  const path = cfg(env, 'GITHUB_MARKET_PATH');
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_API_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'smc-signals-worker',
  };
  try {
    const getRes = await fetch(url, { headers });
    if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}`);
    const file = await getRes.json();
    const existing = JSON.parse(b64DecodeUtf8(file.content));
    const derivBySymbol = new Map((existing.rows ?? []).filter((r) => r.deriv).map((r) => [r.symbol, r.deriv]));

    const merged = rows.map((r) => (derivBySymbol.has(r.symbol) ? { ...r, deriv: derivBySymbol.get(r.symbol) } : r));
    const ready = merged.filter((r) => r.status === 'ready' && r.valid).length;
    const waiting = merged.filter((r) => r.status === 'waiting' && r.valid).length;
    const out = {
      generatedAt: meta.lastBatchAt,
      provider: meta.provider,
      interval: meta.interval,
      htfInterval: meta.htfInterval,
      universe: merged.length,
      poolTotal: meta.poolTotal,
      universeSymbols: merged.map((r) => r.symbol),
      scanned: merged.length,
      skippedLowVolatility: 0,
      minScore: Number(cfg(env, 'WORKER_SCAN_MIN_SCORE')),
      counts: { ready, waiting, total: merged.length },
      rows: merged,
    };

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `chore: Worker 即時更新市場掃描（${merged.length} 檔）`,
        content: b64EncodeUtf8(JSON.stringify(out)),
        sha: file.sha,
      }),
    });
    if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}`);
    return { ok: true, rows: merged.length };
  } catch (e) {
    return { error: e.message };
  }
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
 *
 * 累積用的門檻刻意跟「要不要推播／下單」的門檻（MIN_SCORE）分開：掃描這
 * 一步只濾掉根本沒有有效計畫的（SCAN_MIN_SCORE，預設 0），跟 GitHub
 * Actions 那份 data/market.json 的做法一致——存全部有效計畫，篩選留到
 * 之後那一層。如果掃描這一步就直接套用 MIN_SCORE，累積結果會被鎖死在
 * 「這一批剛好有幾檔當下就超過門檻」，候選池繞完一輪也不會有多少標的
 * 留下來；分開之後，只要是有效計畫都會先留著，run() 檢查現價那一步才會
 * 真的照 MIN_SCORE 篩要不要繼續看。
 *
 * WORKER_SCAN_INTERVAL 可以是逗號分隔的多個週期（例如 "3m,15m,30m,1h"）：
 * 每個週期各自有自己的批次進度（rows/meta/cursor 三個 KV 值內部都是用
 * 「週期」當 key 的物件），每個 tick 只挑「一個」最久沒更新的週期真的
 * 重新掃描一批，其他到期的週期留給下一個 tick——這樣同一個 tick 的請求量
 * （固定是一批 WORKER_SCAN_BATCH_SIZE 檔）不會因為多加週期而變大，只是
 * 把原本大部分 tick 都空著沒用的時間拿來輪流服務其他週期；每個週期各自
 * 涵蓋一輪候選池的時間跟只有單一週期時一樣（≈ TOP/BATCH_SIZE ×
 * BATCH_INTERVAL_MIN），不會因為週期變多就變慢。
 */
async function getFreshMarket(env) {
  if (cfg(env, 'WORKER_SCAN_ENABLED') !== 'true') return getMarket(env);

  const providerIds = env.WORKER_SCAN_PROVIDERS ? env.WORKER_SCAN_PROVIDERS.split(',') : undefined;
  const top = Number(cfg(env, 'WORKER_SCAN_TOP'));
  const batchSize = Number(cfg(env, 'WORKER_SCAN_BATCH_SIZE'));
  const intervals = cfg(env, 'WORKER_SCAN_INTERVAL').split(',').map((s) => s.trim()).filter(Boolean);
  // 掃描階段刻意用很低的門檻（不是拿來決定要不要推播的 MIN_SCORE）：
  // 存起來的候選池要盡量完整，真正的評分門檻在 run() 檢查現價那一步才套用。
  const scanMinScore = Number(cfg(env, 'WORKER_SCAN_MIN_SCORE'));
  // Cloudflare 邊緣節點是共用 IP，同時發太多請求容易被交易所限流擋掉；
  // 用比 scripts/market-scan.mjs（有專屬 IP，預設 concurrency=8）低的並行數。
  const concurrency = Number(cfg(env, 'WORKER_SCAN_CONCURRENCY'));

  if (!env.SMC_KV) {
    // 沒有 KV 就沒辦法記住批次進度／累積結果，退化成每個週期都整批重掃
    // WORKER_SCAN_TOP 檔——請求量會隨週期數等比增加，沒設 KV 的話務必
    // 把 TOP 調小或只留一個週期。
    const results = [];
    for (const interval of intervals) {
      results.push(await scanMarket({ providerIds, top, detailTop: top, interval, minScore: scanMinScore, concurrency }));
    }
    return { ...results[0], rows: results.flatMap((r) => r.rows) };
  }

  const intervalMin = Number(cfg(env, 'WORKER_SCAN_BATCH_INTERVAL_MIN'));
  const metaRaw = await env.SMC_KV.get(WORKER_SCAN_META_KEY);
  const metaByInterval = parseScanMeta(metaRaw, intervals);

  // 找出「到期該重新掃描」的週期，優先處理最久沒更新的那個（沒 meta 的
  // 當成最久沒更新，第一次一定會被排到）——同一個 tick 只真的重新掃描
  // 一個週期，其他到期的留給下一個 tick，避免一次塞爆對外請求。
  const due = intervals
    .filter((iv) => !metaByInterval[iv] || (Date.now() - new Date(metaByInterval[iv].lastBatchAt).getTime()) / 60000 >= intervalMin)
    .sort((a, b) => {
      const at = metaByInterval[a]?.lastBatchAt;
      const bt = metaByInterval[b]?.lastBatchAt;
      if (!at) return -1;
      if (!bt) return 1;
      return new Date(at) - new Date(bt);
    });

  if (!due.length) {
    const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY);
    return assembleMarket(metaByInterval, parseScanRows(rowsRaw, intervals));
  }

  const interval = due[0];
  const cursorRaw = await env.SMC_KV.get(WORKER_SCAN_CURSOR_KEY);
  const cursorByInterval = parseScanCursor(cursorRaw);
  const cursor = cursorByInterval[interval] || 0;
  const batch = await scanMarket({ providerIds, top, offset: cursor, batchSize, interval, minScore: scanMinScore, detailTop: batchSize, concurrency });

  const rowsRaw = await env.SMC_KV.get(WORKER_SCAN_ROWS_KEY);
  const rows = parseScanRows(rowsRaw, intervals);
  const qualified = new Map(batch.rows.map((r) => [r.symbol, r]));
  // 這一批考慮過但沒通過門檻的，要從累積結果裡刪掉——不然分數掉下去的
  // 標的會卡在舊資料裡，一直到下一輪才被清掉都不夠即時
  for (const symbol of batch.universeSymbols) {
    const key = scanRowKey(interval, symbol);
    if (qualified.has(symbol)) rows[key] = qualified.get(symbol);
    else delete rows[key];
  }

  metaByInterval[interval] = {
    provider: batch.provider,
    interval: batch.interval,
    htfInterval: batch.htfInterval,
    poolTotal: batch.poolTotal,
    lastBatchAt: batch.generatedAt,
    // 這一批的診斷資訊：跟 coveredSymbols 一起看，能分辨「候選池真的沒
    // 通過門檻的計畫」還是「資料源這批幾乎都要不到資料」（後者不會被
    // WORKER_SCAN_MIN_SCORE 篩掉，是完全不同的問題，之前只看 coveredSymbols
    // 沒辦法分辨）
    lastBatchScanned: batch.scanned,
    lastBatchSkippedLowVolatility: batch.skippedLowVolatility,
    lastBatchErrors: batch.errorCount,
    lastBatchQualified: batch.rows.length,
    lastBatchSampleError: batch.sampleError,
  };
  cursorByInterval[interval] = batch.poolTotal ? (cursor + batch.universe) % batch.poolTotal : 0;

  await Promise.all([
    env.SMC_KV.put(WORKER_SCAN_ROWS_KEY, JSON.stringify(rows)),
    env.SMC_KV.put(WORKER_SCAN_META_KEY, JSON.stringify(metaByInterval)),
    env.SMC_KV.put(WORKER_SCAN_CURSOR_KEY, JSON.stringify(cursorByInterval)),
  ]);

  // 選用：把這批更新後的累積結果（所有週期合併）順便寫回 data/market.json，
  // 讓 App 網站的全市場掃描頁面也能跟著即時更新。只在真的算出新一批時才寫
  // （不會每 2 分鐘都寫一次），沒設定 GITHUB_API_TOKEN 就完全不會呼叫。
  // 失敗不影響主流程——「這次比對現價、判斷有沒有進場」永遠比「有沒有寫成
  // GitHub」重要。
  await publishMarketToGitHub(env, Object.values(rows), metaByInterval[interval]).catch(() => {});

  return assembleMarket(metaByInterval, rows);
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

/**
 * retries 預設 0（不重試）：跟交易所下單這種非冪等操作有關的呼叫，重試
 * 有把同一張單重複送出兩次的風險（例如網路逾時，但 Bybit 其實已經收到
 * 並處理掉第一次的請求，只是回應沒送到）。只有明確知道這次呼叫是冪等
 * 的（查餘額、查合約資訊、查持倉、設槓桿、設停損——同一個值設兩次沒有
 * 副作用）才在呼叫端傳 retries: 1。
 *
 * 可重試的失敗只挑「明確知道請求根本沒被處理」的情況：網路層失敗（fetch
 * 丟例外／HTTP 5xx，這代表根本沒進到 Bybit 的撮合邏輯）跟 Bybit 自己的
 * 限流回應（retCode 10006／HTTP 429）——其他錯誤（餘額不足、參數不合法
 * 等）重試也不會變好，直接丟出去。
 */
async function bybitCall(env, method, path, params = {}, { retries = 0 } = {}) {
  const apiKey = env.BYBIT_DEMO_API_KEY;
  const apiSecret = env.BYBIT_DEMO_API_SECRET;
  for (let attempt = 0; ; attempt++) {
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
    try {
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
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          if (attempt < retries) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
        }
        throw new Error(`Bybit HTTP ${res.status}`);
      }
      const j = await res.json();
      if (j.retCode !== 0) {
        if (j.retCode === 10006 && attempt < retries) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
        const err = new Error(`Bybit [${j.retCode}] ${j.retMsg || '請求失敗'}`);
        err.code = j.retCode;
        throw err;
      }
      return j.result;
    } catch (e) {
      if (e instanceof Error && /^Bybit \[/.test(e.message)) throw e; // 明確的業務錯誤，不算網路層失敗
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
      throw e;
    }
  }
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
 * 把 buildLadder() 算出來的階梯（保本鏢 + 原本目標）轉成「每一段各自的
 * 絕對出場比例」。buildLadder 是給回測用的循序模擬器寫的，最後一段的
 * fraction 故意是 0（代表「不管剩多少，全部出清」），但這裡是要一次把
 * 所有分批單都掛成真實的限價單（互相獨立、平行存在），所以要把最後一段
 * 換成「扣掉前面幾段之後真正剩下的比例」，掛單的量才會真的加起來等於 1。
 */
function ladderWithAbsoluteFractions(ladder) {
  const legs = ladder.map((t) => ({ ...t }));
  const last = legs[legs.length - 1];
  if (last && !last.scalp) {
    const sumOthers = legs.slice(0, -1).reduce((s, t) => s + (t.fraction || 0), 0);
    last.fraction = Math.max(0, 1 - sumOthers);
  }
  return legs;
}

/**
 * 用 Demo 帳戶目前的可用餘額 × 風險 % 算出下單數量，送出市價進場單並帶
 * 停損；出場則套用 README「部位管理」那組驗證過的規則（src/smc/manage.js）
 * ——保本鏢跟原本的目標價都在這裡就掛成真的 reduce-only 限價單，停損的
 * 移動（成本價／追蹤）交給 updateTrailingStops() 每次執行時輪詢處理。
 * 任何一步失敗都回傳 { error }——「有訊號要通知」永遠比「這筆有沒有下成」
 * 重要，所以呼叫端不會因為這裡失敗就不推播 Discord。
 */
async function autoTradeOrder(env, hit) {
  if (!env.BYBIT_DEMO_API_KEY || !env.BYBIT_DEMO_API_SECRET) return { skipped: 'no-keys' };
  const r = hit.row;
  try {
    const [wallet, instrument] = await Promise.all([
      bybitCall(env, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, { retries: 1 }),
      bybitCall(env, 'GET', '/v5/market/instruments-info', { category: 'linear', symbol: r.symbol }, { retries: 1 }),
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

    // 倉位大小要先確認「分批出場的階梯每一段都掛得了單」才進場——先算好
    // 這筆會用到的階梯，任何一段的數量四捨五入後低於最小下單量，就整筆
    // 跳過，不要開倉。以前的行為是先開倉，掛腿單時個別跳過太小的那一段
    // （甚至可能全部段都太小、整筆變成完全沒有止盈的裸部位），跟「進場了
    // 就該有完整的出場計畫」的預期不符，乾脆一開始就不要進這種倉位大小。
    const ladder = ladderWithAbsoluteFractions(buildLadder(r.entry, r.stop, r.targets, DEFAULT_MANAGEMENT));
    const legQtys = ladder.map((leg) => roundStep(qty * (leg.fraction || 0), qtyStep));
    const tooSmallLeg = legQtys.findIndex((legQty) => !(legQty >= minQty));
    if (tooSmallLeg >= 0) {
      return {
        error: `倉位太小（數量 ${qty}），分批出場階梯的「${ladder[tooSmallLeg].name}」那一段只有 ${legQtys[tooSmallLeg]}，低於最小下單量 ${minQty}，跳過這筆進場`,
      };
    }

    const leverage = Math.min(leverageForScore(env, r.score), maxLeverage);
    await bybitCall(env, 'POST', '/v5/position/set-leverage', {
      category: 'linear', symbol: r.symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    }, { retries: 1 }).catch((e) => { if (e.code !== 110043) throw e; }); // 已經是這個倍數，不算錯誤

    // 市價進場單刻意不重試：重試有把同一張單重複送出兩次的風險（網路逾時
    // 不代表 Bybit 沒收到，可能只是回應沒送達），寧可這次失敗、下一次價格
    // 再到進場區時才重新嘗試，也不要冒重複進場的風險。
    const order = await bybitCall(env, 'POST', '/v5/order/create', {
      category: 'linear',
      symbol: r.symbol,
      side: r.dir === 'long' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: String(qty),
      timeInForce: 'IOC',
      stopLoss: String(roundTick(r.stop, tickSize)),
      slTriggerBy: 'LastPrice',
      // 不在這裡設 takeProfit：分批出場單另外用下面的限價單掛，
      // 交易所原生的單一 takeProfit 欄位放不下「保本鏢 + 好幾段目標」。
    });

    // 保險：進場單本身雖然帶了 stopLoss，但實測發生過部位開出來卻完全沒
    // 停損的情況——不確定確切原因（Demo 環境本來就有其他端點被回報過不
    // 穩定），與其猜測，不如直接用已經在用、確定冪等的 trading-stop 端點
    // 再明確設定一次同樣的停損，多這一次呼叫不會有副作用，失敗也不影響
    // 主流程（updateTrailingStops 下次執行還會再檢查）。
    await bybitCall(env, 'POST', '/v5/position/trading-stop', {
      category: 'linear', symbol: r.symbol, positionIdx: 0,
      stopLoss: String(roundTick(r.stop, tickSize)), slTriggerBy: 'LastPrice',
    }, { retries: 1 }).catch(() => {});

    // 保本鏢 + 原本目標，一次全部掛成真的 reduce-only 限價單——價格到了
    // 交易所自己成交，不用等 Worker 下次輪詢才發現、才補下單。這裡允許
    // 重試一次：跟進場單不同，reduce-only 限價單就算意外重複送出，最多
    // 也只是同一個價位多一張限價單，Bybit 會依實際持倉量限制成交，不會
    // 讓倉位不小心反向或超賣，風險遠比重試進場單低。ladder/legQtys 用
    // 進場前就驗證過的那一份，這裡不用再重算、也不用再擔心量不夠。
    const legOrders = [];
    for (let i = 0; i < ladder.length; i++) {
      const leg = ladder[i];
      const legQty = legQtys[i];
      try {
        const legOrder = await bybitCall(env, 'POST', '/v5/order/create', {
          category: 'linear',
          symbol: r.symbol,
          side: r.dir === 'long' ? 'Sell' : 'Buy', // 出場方向跟進場相反
          orderType: 'Limit',
          qty: String(legQty),
          price: String(roundTick(leg.price, tickSize)),
          reduceOnly: true,
          timeInForce: 'GTC',
        }, { retries: 1 });
        legOrders.push({ name: leg.name, price: leg.price, fraction: leg.fraction, qty: legQty, orderId: legOrder?.orderId });
      } catch (e) {
        legOrders.push({ name: leg.name, price: leg.price, fraction: leg.fraction, qty: legQty, error: e.message });
      }
    }

    // 記住這筆倉位，之後每次執行才知道要去比對它是不是已經平倉了、
    // 獲利有沒有過門檻要搬停損。同一個「幣種＋方向」如果本來就有追蹤中的
    // 紀錄會直接覆蓋——Bybit 單向模式下同幣種同方向本來就只會有一個聚合
    // 部位，第二筆訂單是加碼到同一個部位，不是開一個新的；代價是進場價會
    // 變成「最後一次加碼的價格」而不是均價，這裡先接受這個簡化，不做加權平均。
    if (env.SMC_KV) {
      await env.SMC_KV.put(`open-pos:${r.symbol}:${r.dir}`, JSON.stringify({
        symbol: r.symbol, dir: r.dir, entry: r.entry, stop: r.stop, initialStop: r.stop,
        targets: r.targets, ladder: legOrders, tickSize,
        maxFavorableR: 0, beMoved: false, trailing: false,
        qty, riskAmount, leverage, grade: r.grade, score: r.score, openedAt: Date.now(),
      }));
    }

    return { orderId: order?.orderId, qty, riskAmount, leverage, ladder: legOrders };
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

  const real = await bybitCall(env, 'GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, { retries: 1 });
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
      // 部位平倉了（不管是停損還是分批出場單打到），開倉時掛的那批分批
      // 出場限價單如果還有沒成交的殘單，取消掉——reduce-only 單獨留著不會
      // 加碼部位，但留著容易讓人誤會這幣種還在追蹤中。
      await bybitCall(env, 'POST', '/v5/order/cancel-all', { category: 'linear', symbol: pos.symbol }, { retries: 1 }).catch(() => {});
    }
    await env.SMC_KV.delete(key);
    closed++;
  }
  return { checked: tracked.keys.length, closed };
}

/**
 * 追蹤中的部位如果獲利超過門檻，把 Bybit 上的停損單往有利的方向搬——
 * 套用跟 README「部位管理」那段驗證過的同一組規則（src/smc/manage.js 的
 * DEFAULT_MANAGEMENT）：
 *   maxFavorableR ≥ breakevenAtR（0.5）→ 停損搬到成本價 + 0.05R（多單）
 *   maxFavorableR ≥ trailFromR（1.5）  → 停損跟著最高獲利走，距離 0.8R
 * 停損只會愈移愈緊，不會反向鬆開；分批出場的限價單開倉當下就掛好了，
 * 不需要在這裡處理。
 */
async function updateTrailingStops(env) {
  if (!env.SMC_KV || !env.BYBIT_DEMO_API_KEY || !env.BYBIT_DEMO_API_SECRET) return { checked: 0, moved: 0 };
  const tracked = await env.SMC_KV.list({ prefix: 'open-pos:' });
  if (!tracked.keys.length) return { checked: 0, moved: 0 };

  const positions = [];
  for (const { name: key } of tracked.keys) {
    const raw = await env.SMC_KV.get(key);
    if (raw) positions.push({ key, pos: JSON.parse(raw) });
  }
  if (!positions.length) return { checked: 0, moved: 0 };

  const prices = await getPrices(positions.map(({ pos }) => pos.symbol));
  let moved = 0;
  for (const { key, pos } of positions) {
    const price = prices[pos.symbol];
    if (!price) continue;
    const long = pos.dir === 'long';
    const initialStop = Number.isFinite(pos.initialStop) ? pos.initialStop : pos.stop;
    const risk = Math.abs(pos.entry - initialStop);
    if (!(risk > 0)) continue;

    const favorableR = (long ? price - pos.entry : pos.entry - price) / risk;
    pos.maxFavorableR = Math.max(pos.maxFavorableR ?? 0, favorableR);

    let nextStop = pos.stop;
    if (!pos.beMoved && pos.maxFavorableR >= DEFAULT_MANAGEMENT.breakevenAtR) {
      const be = long
        ? pos.entry + risk * DEFAULT_MANAGEMENT.breakevenOffsetR
        : pos.entry - risk * DEFAULT_MANAGEMENT.breakevenOffsetR;
      if (long ? be > nextStop : be < nextStop) { nextStop = be; pos.beMoved = true; }
    }
    if (pos.maxFavorableR >= DEFAULT_MANAGEMENT.trailFromR) {
      const lockR = pos.maxFavorableR - DEFAULT_MANAGEMENT.trailGapR;
      const trailPx = long ? pos.entry + risk * lockR : pos.entry - risk * lockR;
      if (long ? trailPx > nextStop : trailPx < nextStop) { nextStop = trailPx; pos.trailing = true; }
    }

    if (nextStop !== pos.stop) {
      try {
        await bybitCall(env, 'POST', '/v5/position/trading-stop', {
          category: 'linear',
          symbol: pos.symbol,
          positionIdx: 0,
          stopLoss: String(roundTick(nextStop, pos.tickSize || 0.01)),
          slTriggerBy: 'LastPrice',
        }, { retries: 1 });
        pos.stop = nextStop;
        moved++;
      } catch { /* 這次搬不動就算了，下次執行再試，不影響其他部位 */ }
    }
    await env.SMC_KV.put(key, JSON.stringify(pos));
  }
  return { checked: positions.length, moved };
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
