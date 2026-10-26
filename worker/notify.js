/**
 * Discord 安靜模式（2026-10-26 使用者：「通知太吵了，2 天一則盈利還是虧就好」）。
 *
 *   DISCORD_MODE=quiet：一般通知全部不推（開倉、平倉、保本、大方向、SMC／教練提醒、5/5 即時追蹤、盯單、每日戰報…），
 *   只推兩種：
 *     1. 兩天報告（Demo 帳戶）：台灣時間每隔一天早上 REPORT_HOUR_TPE 點，這兩天賺還是虧、各策略多少
 *     2. 緊急警報：下單失敗（urgent 旗標或文字有「下單失敗」）、持倉離強平價不到 NEAR_LIQ_PCT%、兩天內權益掉超過 DRAWDOWN_ALERT_PCT%
 *   被擋下的通知照樣記在 discord:log（結果寫 muted），查問題時還看得到。
 */
import { rebuildTrades, STRATEGY_NAMES } from '../scripts/lib/demo-trades.mjs';

export const NOTIFY_DEFAULTS = {
  DISCORD_MODE: 'all',           // quiet＝只推兩天報告＋緊急警報
  REPORT_EVERY_DAYS: '2',
  REPORT_HOUR_TPE: '9',
  REPORT_ANCHOR: '2026-10-27',   // 從這天起每 REPORT_EVERY_DAYS 天推一次
  DRAWDOWN_ALERT_PCT: '10',
  NEAR_LIQ_PCT: '3',
};
const ncfg = (env, k) => env[k] ?? NOTIFY_DEFAULTS[k];
const EQ_KEY = 'digest:eq', SENT_KEY = 'digest:sent:', ALERT_KEY = 'digest:alert:', CHECK_KEY = 'digest:check';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const tpeDate = (ms) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const u = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}U`;

export const quietMode = (env) => ncfg(env, 'DISCORD_MODE') === 'quiet';
const textOf = (p) => [p?.content, ...(p?.embeds || []).flatMap((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name} ${f.value}`)])].filter(Boolean).join('\n');
export const looksUrgent = (p) => !!p?.urgent || /下單失敗/.test(textOf(p));

/** postDiscord 開頭呼叫：回傳 { send, payload }（payload 拿掉內部用的旗標） */
export function gate(env, payload) {
  const { urgent, report, ...clean } = payload || {};
  if (!quietMode(env)) return { send: true, payload: clean };
  return { send: !!report || looksUrgent(payload), payload: clean };
}

async function kvJson(env, key, dflt) {
  if (!env.SMC_KV) return dflt;
  try { const v = await env.SMC_KV.get(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}

/** 這一刻該不該推兩天報告 */
export function reportDue(env, now = Date.now()) {
  const h = new Date(now + 8 * HOUR).getUTCHours(), m = new Date(now).getUTCMinutes();
  if (h !== Number(ncfg(env, 'REPORT_HOUR_TPE')) || m >= 40) return false;
  const gap = Math.round((Date.parse(tpeDate(now)) - Date.parse(ncfg(env, 'REPORT_ANCHOR'))) / DAY);
  const every = Math.max(1, Number(ncfg(env, 'REPORT_EVERY_DAYS')));
  return gap >= 0 && gap % every === 0;
}

/** 權益快照：每小時記一筆，留 5 天 */
async function snapshot(env, eq, now) {
  const list = await kvJson(env, EQ_KEY, []);
  if (list.length && now - list[list.length - 1].t < HOUR - 60_000) return list;
  list.push({ t: now, eq: Math.round(eq * 100) / 100 });
  const keep = list.filter((x) => now - x.t <= 5 * DAY);
  if (env.SMC_KV) await env.SMC_KV.put(EQ_KEY, JSON.stringify(keep));
  return keep;
}
/** 最接近 now − ms 的那筆快照（太新的不算） */
const eqAgo = (list, now, ms) => list.filter((x) => x.t <= now - ms + HOUR).sort((a, b) => Math.abs(a.t - (now - ms)) - Math.abs(b.t - (now - ms)))[0] || list[0] || null;

async function once(env, key, ttlSec) {
  if (!env.SMC_KV) return true;
  if (await env.SMC_KV.get(key)) return false;
  await env.SMC_KV.put(key, '1', { expirationTtl: ttlSec });
  return true;
}

/** 兩天報告內容（Demo 帳戶）：權益變化、各策略已平倉、現在持倉 */
export function buildReport({ trades, positions, eqNow, eqThen, periodMs, now }) {
  const from = now - periodMs;
  const closed = trades.filter((t) => t.closeTime >= from && t.closeTime <= now);
  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const unreal = positions.reduce((a, p) => a + (p.unrealisedPnl || 0), 0);
  const delta = eqThen ? eqNow - eqThen.eq : net;
  const by = {};
  for (const t of closed) { const k = t.strategy; (by[k] ||= { n: 0, pnl: 0, w: 0 }); by[k].n++; by[k].pnl += t.pnl; if (t.pnl > 0) by[k].w++; }
  const rows = Object.entries(by).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => `${v.pnl >= 0 ? '🟢' : '🔴'} ${STRATEGY_NAMES[k] || k}：${u(v.pnl)}（${v.n} 筆，贏 ${v.w}）`);
  const win = closed.filter((t) => t.pnl > 0).length;
  const lines = [
    eqThen ? `帳戶權益 ${eqThen.eq.toFixed(0)}U → ${eqNow.toFixed(0)}U（${u(delta)}，${(delta / eqThen.eq * 100).toFixed(1)}%）` : `帳戶權益 ${eqNow.toFixed(0)}U（還沒有兩天前的紀錄，下面只算已平倉）`,
    `已平倉 ${closed.length} 筆：${u(net)}（贏 ${win}、輸 ${closed.length - win}）`,
    ...(rows.length ? ['', ...rows] : []),
    '',
    `現在持倉 ${positions.length} 張，未實現 ${u(unreal)}`,
  ];
  return {
    report: true,
    embeds: [{
      title: `${delta >= 0 ? '📈' : '📉'} 兩天報告（Demo）：${delta >= 0 ? '賺' : '虧'} ${u(delta).slice(1)}`,
      color: delta >= 0 ? 0x0a7a3b : 0xc0392b,
      description: lines.join('\n').slice(0, 3900),
      footer: { text: `${tpeDate(from)} ～ ${tpeDate(now)}（台灣時間）` },
    }],
  };
}

/**
 * 每次排程呼叫：記權益快照、檢查緊急狀況（10 分鐘一次）、時間到推兩天報告。
 * deps：executorCall、postDiscord
 */
export async function runDigest(env, { executorCall, postDiscord, now = Date.now(), force = false, dry = false }) {
  if (!env.EXECUTOR_URL || !env.EXECUTOR_HMAC_SECRET) return { skipped: 'no-executor' };
  if (!quietMode(env) && !force) return { skipped: 'not-quiet' }; // 一般模式本來就每筆都推，不另外做報告
  const due = force || reportDue(env, now);
  const last = Number((env.SMC_KV && (await env.SMC_KV.get(CHECK_KEY))) || 0);
  if (!due && now - last < 10 * 60_000) return { skipped: 'recent' };
  if (env.SMC_KV && !dry) await env.SMC_KV.put(CHECK_KEY, String(now));
  const [bal, pos] = await Promise.all([
    executorCall(env, 'GET', '/balance').catch((e) => ({ error: e.message })),
    executorCall(env, 'GET', '/position').catch((e) => ({ error: e.message })),
  ]);
  if (bal.error) return { error: `查餘額失敗：${bal.error}` };
  const positions = pos.positions || [];
  const eqNow = Number(bal.totalEquity || 0) || Number(bal.totalWalletBalance || 0) + positions.reduce((a, p) => a + (p.unrealisedPnl || 0), 0);
  const list = dry ? await kvJson(env, EQ_KEY, []) : await snapshot(env, eqNow, now);
  const every = Math.max(1, Number(ncfg(env, 'REPORT_EVERY_DAYS'))) * DAY;
  const out = { eqNow, alerts: [] };

  // 緊急 1：兩天內權益掉超過 N%（一天最多推一次）
  const then = eqAgo(list, now, 2 * DAY);
  const ddPct = Number(ncfg(env, 'DRAWDOWN_ALERT_PCT'));
  if (then && now - then.t >= 20 * HOUR && then.eq > 0 && (then.eq - eqNow) / then.eq * 100 >= ddPct && (dry || await once(env, `${ALERT_KEY}dd`, 86400))) {
    const msg = `🚨 Demo 帳戶兩天內掉了 ${((then.eq - eqNow) / then.eq * 100).toFixed(1)}%（${then.eq.toFixed(0)}U → ${eqNow.toFixed(0)}U）`;
    out.alerts.push(msg);
    if (!dry) await postDiscord(env, { urgent: true, content: msg }).catch(() => {});
  }
  // 緊急 2：持倉離強平價太近（同一個幣 12 小時最多推一次）
  const near = Number(ncfg(env, 'NEAR_LIQ_PCT'));
  for (const p of positions) {
    const liq = Number(p.liqPrice || 0), mark = Number(p.markPrice || p.avgPrice || 0);
    if (!(liq > 0 && mark > 0)) continue;
    const dist = Math.abs(mark - liq) / mark * 100;
    if (dist < near && (dry || await once(env, `${ALERT_KEY}liq:${p.symbol}`, 12 * 3600))) {
      const msg = `🚨 ${p.symbol.replace(/USDT$/, '')} ${p.side === 'Buy' ? '多' : '空'}單離強平價只剩 ${dist.toFixed(1)}%（現價 ${mark}、強平 ${liq}）`;
      out.alerts.push(msg);
      if (!dry) await postDiscord(env, { urgent: true, content: msg }).catch(() => {});
    }
  }
  // 兩天報告
  if (due && (force || dry || await once(env, SENT_KEY + tpeDate(now), 3 * 86400))) {
    const hist = await executorCall(env, 'GET', '/history', { query: { days: 7 } }).catch((e) => ({ error: e.message }));
    const { trades } = rebuildTrades(hist.executions || []);
    const payload = buildReport({ trades, positions, eqNow, eqThen: eqAgo(list, now, every), periodMs: every, now });
    if (hist.errors?.executions || hist.error) payload.embeds[0].description += `\n\n（成交明細沒抓完整：${hist.errors?.executions || hist.error}）`;
    out.report = payload.embeds[0];
    if (!dry) await postDiscord(env, payload);
  }
  return out;
}
