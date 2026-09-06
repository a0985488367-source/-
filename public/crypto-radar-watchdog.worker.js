// Crypto Radar Guardian — Discord 心跳守衛 (Cloudflare Worker)
//
// 這是什麼
//   每 10 分鐘去看 Guardian 的 /health。連不上、狀態異常、或心跳過期時
//   發 Discord 通知；恢復了也通知一次。
//
//   刻意做成另一支獨立的 Worker：Guardian 整個掛掉時，
//   守衛還活著才叫得出來。
//
//   它只做監控與通知，沒有任何交易或風險相關的程式路徑。
//
// 兩個刻意的設計
//   遲滯：連續兩次偵測不到才告警。Guardian 每 5 分鐘跑、守衛每 10 分鐘看，
//         單次漏跑很正常，不該立刻叫。
//   節流：重送間隔 0 → 60 → 360 分鐘，長時間斷線不會洗版。
//
// 部署（同樣可以在手機瀏覽器操作）
//   1. dash.cloudflare.com → Workers & Pages → Create → Start from Hello World
//      命名為 crypto-radar-watchdog
//   2. Edit code，貼上這整份檔案，Deploy
//   3. Settings → Bindings → KV Namespace
//        Variable name: WATCHDOG_KV
//   4. Settings → Variables and Secrets：
//        GUARDIAN_URL     Guardian Worker 的網址（必填）
//        DISCORD_WEBHOOK  Discord Webhook 網址（必填）
//   5. Settings → Trigger Events → Cron Triggers：
//        4,14,24,34,44,54 * * * *
//
// 端點
//   /  守衛自己的狀態，包含 dead-man switch（守衛自己多久沒執行了）
//
// 要改邏輯
//   改 app/watchdog-core.js，然後執行 node scripts/build-watchdog.mjs

/**
 * format — 共用數值格式化
 *
 * 畫面（render.js）與通知（discord.js）都要把同一批數字寫成字串。
 * 抽在這裡，兩邊格式一致，也避免內嵌成單一作用域時重複宣告。
 */

/** 依價格量級決定小數位數，避免低價幣顯示成 0.0000 */
function priceDigits(p) {
  if (!Number.isFinite(p)) return 4;
  if (p >= 1000) return 1;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d ?? 4) : '—');

const fpct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');

const fmoney = (v) => (Number.isFinite(v) ? (v >= 0 ? '' : '-') + Math.abs(v).toFixed(2) : '—');

function fusd(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

/** CSS class 用的正負號 */
const sgn = (v) => (Number.isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '');

function ago(ts, now) {
  if (!ts) return '尚未掃描';
  const s = Math.max(0, Math.round(((now ?? Date.now()) - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  return Math.round(s / 60) + ' 分鐘前';
}

/**
 * discord — Discord Webhook 通知
 *
 * 只做通知，不觸發任何交易動作（對應交接規格第八節的守衛原則）。
 *
 * Webhook URL 本身是機密：由宿主環境提供（iPhone 版存在 iOS Keychain），
 * 不寫進原始碼、不寫進 Git、不出現在通知內容或錯誤訊息裡。
 */


/** Discord Webhook 的合法網址型態 */
const WEBHOOK_PATTERN = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function isValidWebhookUrl(url) {
  return typeof url === 'string' && WEBHOOK_PATTERN.test(url.trim());
}

/** 遮罩後的顯示字串，永遠不顯示完整 URL */
function maskWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return '未設定';
  const m = /\/webhooks\/(\d+)\//.exec(url);
  return m ? `Webhook ••••${m[1].slice(-4)}` : 'Webhook ••••';
}

/* ------------------------------------------------------------------ */
/* 訊息組裝                                                             */
/* ------------------------------------------------------------------ */

/**
 * 單一候選的通知內容。
 *
 * 刻意不寫任何勝率、獲利或「必漲」字眼。
 * 只陳述掃描結果與機械換算出的參考價位。
 */
function candidateMessage(c) {
  const d = priceDigits(c.lastPrice);
  const group = c.isMeme ? '迷因幣／高風險' : '主幣';
  const lines = [
    `**${c.symbol}** · ${group} · 完成度 ${c.score}`,
    `進場條件 ${c.readiness.passed}/${c.readiness.total} 已通過`,
    '',
    `Entry　${fx(c.entryLow, d)} – ${fx(c.entryHigh, d)}`,
    `SL　　${fx(c.stopLoss, d)}`,
    `TP1　 ${fx(c.takeProfit1, d)}　(1.5R)`,
    `TP2　 ${fx(c.takeProfit2, d)}　(2.5R)`,
    '',
    `距突破點 ${fpct(c.breakoutDistancePct)}　壓縮比 ${fx(c.compressionRatio, 3)}`,
    `量能 ${fx(c.volumeMultiple, 2)}x　OI ${fpct(c.oiChangePct)}`,
  ];
  if (c.riskLabel) lines.push('', `⚠ ${c.riskLabel}`);
  lines.push('', '完成度不是勝率。這是掃描結果，不是投資建議，也不會自動下單。');
  lines.push(c.bybitUrl);
  return lines.join('\n');
}

/**
 * 掃描摘要通知。
 * @param {{ready: Array, mainCount: number, memeCount: number, scannedAt: number}} summary
 */
function summaryMessage(summary) {
  const when = new Date(summary.scannedAt).toISOString().replace('T', ' ').slice(0, 16);
  if (!summary.ready.length) {
    return `**Crypto Radar 掃描完成** · ${when} UTC\n主幣 ${summary.mainCount} 檔、迷因幣 ${summary.memeCount} 檔已分析，目前沒有符合全部進場條件的候選。`;
  }
  const names = summary.ready.map((c) => `${c.symbol}(${c.score})`).join('、');
  return `**Crypto Radar 掃描完成** · ${when} UTC\n符合全部進場條件：${names}\n完成度不是勝率，請自行確認風險。`;
}

/** 帳戶保護單缺漏的警示 */
function protectionAlertMessage(positions) {
  const bad = positions.filter((p) => p.protection && p.protection.level !== 'ok');
  if (!bad.length) return null;
  const lines = ['**持倉保護檢查**', ''];
  for (const p of bad) {
    lines.push(`${p.symbol} ${p.side === 'long' ? '多' : '空'}　${p.protection.text}`);
  }
  lines.push('', '這是唯讀檢查，本工具不會替你掛單或平倉。');
  return lines.join('\n');
}

function testMessage() {
  return '**Crypto Radar** 通知測試成功。\n本工具只讀取 Bybit 公開行情與唯讀帳戶資料，不會下單。';
}

/* ------------------------------------------------------------------ */
/* 去重與節流                                                           */
/* ------------------------------------------------------------------ */

/** 一則通知的識別碼：同一標的、同一狀態不重複發 */
function notificationKey(c) {
  return `${c.symbol}:${c.entryReady ? 'ready' : 'watch'}:${c.stage}`;
}

/**
 * 決定這一輪要發哪些通知。
 *
 * @param {Array} readyCandidates 目前符合全部進場條件的候選
 * @param {{sent: Object, lastSentAt: number}} state 先前狀態
 * @param {number} now
 * @param {number} cooldownMinutes 同一標的的重複通知間隔
 */
function selectNotifications(readyCandidates, state, now, cooldownMinutes = 60) {
  const sent = { ...(state?.sent ?? {}) };
  const cooldownMs = cooldownMinutes * 60_000;
  const toSend = [];

  for (const c of readyCandidates ?? []) {
    const key = notificationKey(c);
    const last = sent[key];
    if (!Number.isFinite(last) || now - last >= cooldownMs) {
      toSend.push(c);
      sent[key] = now;
    }
  }

  // 清掉超過一天的舊紀錄，避免狀態無限成長
  for (const key of Object.keys(sent)) {
    if (now - sent[key] > 86_400_000) delete sent[key];
  }

  return { toSend, state: { sent, lastSentAt: toSend.length ? now : (state?.lastSentAt ?? null) } };
}

/* ------------------------------------------------------------------ */
/* 送出                                                                */
/* ------------------------------------------------------------------ */

const MAX_CONTENT_LENGTH = 1900;

function buildPayload(content) {
  const text = String(content ?? '');
  return {
    content: text.length > MAX_CONTENT_LENGTH ? `${text.slice(0, MAX_CONTENT_LENGTH)}…` : text,
    allowed_mentions: { parse: [] },
  };
}

/**
 * 送出一則通知。
 *
 * @param {(url: string, payload: Object) => Promise<any>} post 由宿主環境注入的 POST 實作
 * @returns {Promise<{ok: boolean, error: string|null}>} 永遠不把 webhook URL 放進回傳
 */
async function sendNotification(post, webhookUrl, content) {
  if (!isValidWebhookUrl(webhookUrl)) {
    return { ok: false, error: 'Webhook 網址格式不正確' };
  }
  try {
    await post(webhookUrl, buildPayload(content));
    return { ok: true, error: null };
  } catch (err) {
    const raw = String((err && err.message) ? err.message : err);
    // 錯誤訊息可能被記錄，先把 webhook URL 從裡面清掉
    return { ok: false, error: raw.split(webhookUrl).join('[webhook]') };
  }
}

/**
 * watchdog-core — 獨立 Discord 心跳守衛的判斷邏輯
 *
 * 這支 Worker 只做一件事：定時去看 Guardian 的 /health，
 * 有問題就通知 Discord，恢復了也通知一次。
 *
 * 它不碰交易、不碰風險參數、不會替任何人下單。
 *
 * 兩個刻意的設計：
 *   遲滯 —— 連續兩次偵測不到才告警。Guardian 每 5 分鐘跑一次、
 *           守衛每 10 分鐘看一次，單次漏跑很正常，不該立刻叫。
 *   節流 —— 重送間隔逐步拉長，長時間斷線不會洗版。
 */

const ALERT_AFTER_CONSECUTIVE_MISSES = 2;

/** 重送間隔（分鐘），依已告警次數遞增 */
const REALERT_INTERVAL_MINUTES = Object.freeze([0, 60, 360]);

function initialState() {
  return { consecutiveMisses: 0, lastAlertAt: null, alertCount: 0, alerting: false, checkedAt: null };
}

/**
 * 依這一輪的探測結果決定要不要發通知。
 *
 * @param {{state: object, now: number, reachable: boolean, health: object|null, httpStatus: number|null}} input
 */
function evaluate(input) {
  const prev = input.state ?? initialState();
  const now = input.now;
  const reasons = [];

  if (!input.reachable) {
    reasons.push('Guardian /health 無法連線');
  } else {
    const health = input.health;
    if (!health || typeof health !== 'object') {
      reasons.push('Guardian /health 回應格式不正確');
    } else {
      if (health.ok !== true) {
        reasons.push(`Guardian 狀態異常：${health.status ?? '未知'}`);
      }
      if (Number.isFinite(health.ageSeconds) && health.ageSeconds > 900) {
        reasons.push(`Guardian 心跳已 ${Math.round(health.ageSeconds / 60)} 分鐘未更新`);
      }
      if (health.heartbeatAt === null || health.heartbeatAt === undefined) {
        reasons.push('Guardian 沒有回報心跳時間');
      }
    }
  }

  const problem = reasons.length > 0;
  const base = { ...prev, checkedAt: now };

  // 恢復通知
  if (!problem && prev.alerting) {
    return {
      state: { consecutiveMisses: 0, lastAlertAt: prev.lastAlertAt, alertCount: 0, alerting: false, checkedAt: now },
      notify: true,
      kind: 'recovery',
      message: 'Guardian 已恢復正常。心跳與狀態均正常。',
      reasons: [],
    };
  }

  if (!problem) {
    return {
      state: { ...base, consecutiveMisses: 0, alerting: false },
      notify: false, kind: 'none', message: null, reasons: [],
    };
  }

  const consecutiveMisses = prev.consecutiveMisses + 1;

  // 遲滯：連續兩次才告警
  if (consecutiveMisses < ALERT_AFTER_CONSECUTIVE_MISSES) {
    return {
      state: { ...base, consecutiveMisses },
      notify: false, kind: 'none', message: null, reasons,
    };
  }

  // 節流
  const sinceLast = Number.isFinite(prev.lastAlertAt) ? (now - prev.lastAlertAt) / 60000 : null;
  const idx = Math.min(prev.alertCount, REALERT_INTERVAL_MINUTES.length - 1);
  const requiredGap = REALERT_INTERVAL_MINUTES[idx];

  if (prev.alerting && sinceLast !== null && sinceLast < requiredGap) {
    return {
      state: { ...base, consecutiveMisses },
      notify: false, kind: 'none', message: null, reasons,
    };
  }

  return {
    state: {
      consecutiveMisses,
      lastAlertAt: now,
      alertCount: prev.alertCount + 1,
      alerting: true,
      checkedAt: now,
    },
    notify: true,
    kind: 'alert',
    message: `**Guardian 異常**\n${reasons.map((r) => `· ${r}`).join('\n')}\n\n這是監控通知，守衛不會改動任何交易或風險設定。`,
    reasons,
  };
}

/**
 * Dead-man switch：守衛自己是否還活著。
 * 由 Guardian 或人工反查，避免「守衛死了卻沒人知道」。
 */
function watchdogAlive(checkedAt, now, staleAfterMinutes = 25) {
  if (!Number.isFinite(checkedAt)) {
    return { alive: false, ageMinutes: null, detail: '守衛沒有回報時間，可能未部署或已停止' };
  }
  const ageMinutes = (now - checkedAt) / 60000;
  if (ageMinutes > staleAfterMinutes) {
    return { alive: false, ageMinutes, detail: `守衛已 ${Math.round(ageMinutes)} 分鐘未執行` };
  }
  return { alive: true, ageMinutes, detail: `守衛正常，${Math.round(ageMinutes)} 分鐘前執行` };
}

/* ============================================================
   Worker 進入點
   ============================================================ */

const STATE_KEY = 'watchdog:state';

async function loadState(kv) {
  try {
    const raw = await kv.get(STATE_KEY);
    return raw ? JSON.parse(raw) : initialState();
  } catch (e) {
    return initialState();
  }
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Discord 回應 HTTP ' + res.status);
}

async function probe(guardianUrl) {
  try {
    const res = await fetch(guardianUrl.replace(/\/+$/, '') + '/health', {
      headers: { accept: 'application/json' },
    });
    let health = null;
    try { health = await res.json(); } catch (e) { health = null; }
    return { reachable: true, httpStatus: res.status, health };
  } catch (e) {
    return { reachable: false, httpStatus: null, health: null };
  }
}

async function runCheck(env, kv, now) {
  if (!env.GUARDIAN_URL) return { skipped: '缺少 GUARDIAN_URL' };

  const prev = await loadState(kv);
  const result = await probe(env.GUARDIAN_URL);
  const decision = evaluate({
    state: prev,
    now,
    reachable: result.reachable,
    health: result.health,
    httpStatus: result.httpStatus,
  });

  await kv.put(STATE_KEY, JSON.stringify(decision.state));

  if (decision.notify && isValidWebhookUrl(env.DISCORD_WEBHOOK)) {
    const sent = await sendNotification(post, env.DISCORD_WEBHOOK, decision.message);
    return { kind: decision.kind, sent: sent.ok, error: sent.error, reasons: decision.reasons };
  }
  return { kind: decision.kind, sent: false, error: null, reasons: decision.reasons };
}

export default {
  /**
   * Cron 觸發。設定為錯開整點的每 10 分鐘： 4,14,24,34,44,54 * * * *
   * 刻意與 Guardian 的排程錯開，避免同時執行時看到半完成的狀態。
   */
  async scheduled(event, env, ctx) {
    const kv = env.WATCHDOG_KV;
    if (!kv) {
      console.log('缺少 KV 綁定 WATCHDOG_KV，略過這一輪');
      return;
    }
    const out = await runCheck(env, kv, Date.now());
    console.log('守衛檢查：' + JSON.stringify(out));
  },

  async fetch(request, env, ctx) {
    const kv = env.WATCHDOG_KV;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (!kv) {
      return new Response(JSON.stringify({ error: '缺少 KV 綁定 WATCHDOG_KV' }, null, 2), { status: 500, headers });
    }
    const state = await loadState(kv);
    const alive = watchdogAlive(state.checkedAt, Date.now());
    return new Response(JSON.stringify({
      ok: alive.alive,
      role: 'discord-heartbeat-watchdog',
      guardianUrl: env.GUARDIAN_URL ? '已設定' : '未設定',
      discordConfigured: Boolean(env.DISCORD_WEBHOOK),
      lastCheckedAt: state.checkedAt,
      lastCheckAgeMinutes: alive.ageMinutes === null ? null : Math.round(alive.ageMinutes),
      alerting: state.alerting,
      consecutiveMisses: state.consecutiveMisses,
      detail: alive.detail,
      note: '本服務只做監控與通知，不會改動任何交易或風險設定。',
    }, null, 2), { status: alive.alive ? 200 : 503, headers });
  },
};
