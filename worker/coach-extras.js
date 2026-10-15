/**
 * SMC 教練 App 的三個後端功能（2026-10-14 使用者要的）：
 *
 *  1. 教練即時戰績  GET /coach-live
 *     runCoach 每根 K 棒收盤都在算 45 組（15 檔 × 15m／30m／1h）的教練劇本；劇本一回踩（第 4 步、限價單成交），
 *     就用「回踩那根」固定好的進場／停損／目標記一筆，之後每根收盤往後看打到哪邊。跟 coach-study 回測同一套算法
 *     （回踩那根先算停損、掛單手續費 0.02%、停損吃單 0.055%、最多抱 300 根），但這是從現在開始的真實紀錄，不是回測。
 *
 *  2. 盯這單・到價提醒  GET／POST／DELETE /watch（要 App 密碼）
 *     App 在某個劇本按「盯這單」，Worker 每次排程（2 分鐘）看最新 K 棒：回到進場價、沒回踩就到目標、到目標、打到停損，
 *     各推一次 Discord。最多 10 筆、3 天後自動過期。
 *
 *  3. 交易日誌  GET /journal（要 App 密碼）
 *     透過 Executor 讀使用者自己手動下單那個 Bybit 帳戶（唯讀金鑰），把成交明細還原成一筆一筆的交易回給 App，
 *     App 再對照每筆進場當下的教練清單做檢討。Worker 直接打 Bybit 會被地理封鎖，所以一定要經過 Executor。
 *
 * App 密碼：沿用使用者已經設定過的其中一個 secret（APP_TOKEN／AI_TOKEN／AUTO_TRADE_TOKEN），header 帶 x-app-token。
 */
import { coachFollow } from '../src/smc/coach.js';
import { sessionOf } from '../src/smc/sessions.js';
import { rebuildTrades } from '../scripts/lib/demo-trades.mjs';

// v2：2026-10-15 換成「回踩一定在結構轉向之後」，舊規則的紀錄不混在一起
const LIVE_OPEN_KEY = 'coachlive2:open';
const LIVE_DONE_KEY = 'coachlive2:done';
const LIVE_DONE_MAX = 1500;
const LIVE_MAX_HOLD = 300;
const MAKER = 0.0002, TAKER = 0.00055;
const WATCH_KEY = 'watch:list';
const WATCH_MAX = 10;
const WATCH_TTL_MS = 3 * 86400e3;

export function appTokenOk(request, env) {
  const got = request.headers.get('x-app-token') ?? new URL(request.url).searchParams.get('token') ?? '';
  return [env.APP_TOKEN, env.AI_TOKEN, env.AUTO_TRADE_TOKEN].filter(Boolean).some((t) => safeEq(got, t));
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
const sessId = (ms) => (sessionOf(ms) || { id: 'none' }).id;
async function kvJson(env, key, dflt) {
  if (!env.SMC_KV) return dflt;
  try { const v = await env.SMC_KV.get(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}

/* ═════════ 1. 教練即時戰績 ═════════ */

/** runCoach 開始時呼叫一次，拿到可以累加的狀態；結束時 saveCoachLive 寫回 KV（有變才寫） */
export async function loadCoachLive(env) {
  const open = await kvJson(env, LIVE_OPEN_KEY, []), done = await kvJson(env, LIVE_DONE_KEY, []);
  return { open, done, ids: new Set([...open, ...done].map((x) => x.id)), dirty: false };
}
export async function saveCoachLive(env, S) {
  if (!S.dirty || !env.SMC_KV) return;
  await env.SMC_KV.put(LIVE_OPEN_KEY, JSON.stringify(S.open));
  await env.SMC_KV.put(LIVE_DONE_KEY, JSON.stringify(S.done.slice(0, LIVE_DONE_MAX)));
}

/** 一個幣、一個週期剛收盤：先結算這組之前開著的紀錄，再看有沒有新回踩的劇本要記 */
export function trackCoachLive(S, job, W, A, st, biasTf) {
  const j = W.length - 1;
  // 結算
  for (const rec of S.open.filter((x) => x.sym === job.sym && x.iv === job.iv)) {
    const res = resolveLive(rec, W);
    if (!res) continue;
    S.open = S.open.filter((x) => x !== rec);
    S.done.unshift({ ...rec, ...res });
    S.dirty = true;
  }
  // 新紀錄：第 4 步（已回踩＝限價單成交），計畫固定在回踩那根
  for (const side of ['L', 'S']) {
    const r = st[side];
    if (r.rt == null || !r.sweep) continue;
    const f = coachFollow(W, A, r);
    if (!f.plan) continue;
    const id = `${job.sym}:${job.iv}:${side}:${W[r.sweep.u].t}`;
    if (S.ids.has(id)) continue;
    S.ids.add(id);
    const rec = {
      id, sym: job.sym, iv: job.iv, side, en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, rr: Math.round(f.plan.rr * 100) / 100,
      rtT: W[r.rt].t, late: j - r.rt, bias: r.bias, biasTf, disc: r.disc, sess: sessId(W[r.sweep.u].t * 1000), sessEntry: sessId(W[r.rt].t * 1000),
      kind: r.poi.kind, at: Date.now(),
    };
    const res = resolveLive(rec, W);
    if (res) S.done.unshift({ ...rec, ...res }); else S.open.push(rec);
    S.dirty = true;
  }
}

/** 從回踩那根往後看：回踩那根先算停損，之後每根先停損再目標；最多抱 300 根，到期用收盤價平 */
export function resolveLive(rec, W) {
  const d = rec.side === 'L' ? 1 : -1, risk = d * (rec.en - rec.sl);
  const i0 = W.findIndex((k) => k.t >= rec.rtT);
  if (i0 < 0 || !(risk > 0)) return null;
  const R = (px, feeOut) => Math.round(((d * (px - rec.en) - rec.en * MAKER - px * feeOut) / risk) * 1000) / 1000;
  for (let u = i0; u < W.length; u++) {
    const k = W[u];
    if (d > 0 ? k.l <= rec.sl : k.h >= rec.sl) return { out: 'sl', r: R(rec.sl, TAKER), endT: k.t };
    if (u > i0 && (d > 0 ? k.h >= rec.tp : k.l <= rec.tp)) return { out: 'tp', r: R(rec.tp, MAKER), endT: k.t };
    if (u - i0 >= LIVE_MAX_HOLD) return { out: 'timeout', r: R(k.c, TAKER), endT: k.t };
  }
  return null;
}

export async function coachLiveResponse(env) {
  const open = await kvJson(env, LIVE_OPEN_KEY, []), done = await kvJson(env, LIVE_DONE_KEY, []);
  return { open, done, fees: { maker: MAKER, taker: TAKER }, maxHold: LIVE_MAX_HOLD };
}

/* ═════════ 2. 盯這單 ═════════ */

export async function handleWatch(request, env) {
  if (!env.SMC_KV) return { status: 500, body: { error: '沒有設定 SMC_KV' } };
  let list = await kvJson(env, WATCH_KEY, []);
  const url = new URL(request.url);
  if (request.method === 'GET') return { status: 200, body: { watches: list } };
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    list = list.filter((w) => w.id !== id);
    await env.SMC_KV.put(WATCH_KEY, JSON.stringify(list));
    return { status: 200, body: { ok: true, watches: list } };
  }
  if (request.method !== 'POST') return { status: 405, body: { error: '不支援' } };
  let b;
  try { b = await request.json(); } catch { return { status: 400, body: { error: '格式不對' } }; }
  const w = {
    sym: String(b.sym || '').toUpperCase(), iv: String(b.iv || ''), side: b.side === 'S' ? 'S' : 'L',
    en: Number(b.en), sl: Number(b.sl), tp: Number(b.tp), state: b.filled ? 'filled' : 'waiting',
  };
  const d = w.side === 'L' ? 1 : -1;
  if (!/^[A-Z0-9]{2,20}USDT$/.test(w.sym) || !['15m', '30m', '1h', '4h'].includes(w.iv) || !(d * (w.en - w.sl) > 0) || !(d * (w.tp - w.en) > 0)) {
    return { status: 400, body: { error: '進場／停損／目標的方向不對，或幣種、週期不支援' } };
  }
  w.id = `${w.sym}:${w.iv}:${w.side}:${Date.now()}`;
  w.created = Date.now();
  w.expires = w.created + WATCH_TTL_MS;
  list = [w, ...list.filter((x) => !(x.sym === w.sym && x.iv === w.iv && x.side === w.side))].slice(0, WATCH_MAX);
  await env.SMC_KV.put(WATCH_KEY, JSON.stringify(list));
  return { status: 200, body: { ok: true, watch: w, watches: list } };
}

/**
 * 每次排程跑一次：抓每個盯單的最新幾根 K 棒（含盤中那根），照狀態機推 Discord。
 *   waiting → 碰到進場價：「回到進場價」→ filled；先碰到目標：「沒回踩就走了」→ 結束
 *   filled  → 碰到停損：「停損」→ 結束；碰到目標：「到目標」→ 結束
 * 同一根 K 棒同時碰到停損和目標時先算停損（保守）。
 */
export async function checkWatches(env, { fetchKlines, postDiscord, intervalToMs, dry = false }) {
  if (!env.SMC_KV) return { checked: 0 };
  const list = await kvJson(env, WATCH_KEY, []);
  if (!list.length) return { checked: 0 };
  const now = Date.now(), keep = [], sent = [];
  for (const w of list) {
    if (now > w.expires) { sent.push(await note(w, 'expired')); continue; }
    let rows;
    try { rows = await fetchKlines(env, w.sym, w.iv, 4); } catch { keep.push(w); continue; }
    const ms = intervalToMs(w.iv), d = w.side === 'L' ? 1 : -1;
    let ended = false;
    if (w.state === 'filled' && w.fillBarT == null) w.fillBarT = Math.floor(w.created / ms) * ms; // App 按下去時已經回踩過
    for (const k of rows) {
      if (k.time + ms <= w.created) continue; // 按下去之前就收盤的 K 棒不算
      const hi = +k.high, lo = +k.low;
      if (w.state === 'waiting') {
        if (d > 0 ? lo <= w.en : hi >= w.en) { w.state = 'filled'; w.fillBarT = k.time; sent.push(await note(w, 'filled')); }
        else if (d > 0 ? hi >= w.tp : lo <= w.tp) { sent.push(await note(w, 'missed')); ended = true; break; }
      }
      if (w.state === 'filled' && k.time >= w.fillBarT) {
        if (d > 0 ? lo <= w.sl : hi >= w.sl) { sent.push(await note(w, 'sl')); ended = true; break; }
        if (k.time > w.fillBarT && (d > 0 ? hi >= w.tp : lo <= w.tp)) { sent.push(await note(w, 'tp')); ended = true; break; } // 成交那根之後才算到目標
      }
    }
    if (!ended) keep.push(w);
  }
  if (!dry) await env.SMC_KV.put(WATCH_KEY, JSON.stringify(keep));
  return { checked: list.length, sent: sent.filter(Boolean) };

  async function note(w, what) {
    const side = w.side === 'L' ? '多單' : '空單', coin = w.sym.replace(/USDT$/, '');
    const R = (px) => ((w.side === 'L' ? 1 : -1) * (px - w.en) / Math.abs(w.en - w.sl)).toFixed(1);
    const msg = {
      filled: `👀 盯單｜${coin} ${w.iv} ${side}：價格回到進場價 ${w.en}（停損 ${w.sl}、目標 ${w.tp}）`,
      missed: `👀 盯單｜${coin} ${w.iv} ${side}：沒回到進場價就先走到目標 ${w.tp}，這單錯過了，取消掛單`,
      tp: `✅ 盯單｜${coin} ${w.iv} ${side}：到目標 ${w.tp}（+${R(w.tp)}R）`,
      sl: `⛔ 盯單｜${coin} ${w.iv} ${side}：打到停損 ${w.sl}（-1R）`,
      expired: `⌛ 盯單｜${coin} ${w.iv} ${side}：盯了 3 天沒結果，自動停止`,
    }[what];
    if (!dry) await postDiscord(env, { content: msg }).catch(() => {});
    return msg;
  }
}

/* ═════════ 3. 交易日誌 ═════════ */

export async function journalResponse(env, days, executorCall) {
  if (!env.EXECUTOR_URL || !env.EXECUTOR_HMAC_SECRET) return { configured: false, error: 'Worker 還沒接上 Executor（EXECUTOR_URL／EXECUTOR_HMAC_SECRET）' };
  const r = await executorCall(env, 'GET', '/journal', { query: { days } });
  if (!r.configured) return { configured: false, error: r.error || 'Executor 還沒設定唯讀金鑰' };
  const { trades, stillOpen } = rebuildTrades(r.executions || []);
  const pick = (t) => ({
    symbol: t.symbol, dir: t.dir, strategy: t.strategy, openTime: t.openTime, closeTime: t.closeTime ?? null,
    entry: t.avg, exit: t.exitPrice ?? null, qty: t.maxSize, notional: t.avg * t.maxSize,
    pnl: t.pnl ?? null, fees: t.fees,
  });
  return {
    configured: true, days, balance: r.balance, positions: r.positions || [], errors: r.errors || {},
    trades: trades.map(pick).sort((a, b) => b.closeTime - a.closeTime), open: stillOpen.map(pick),
  };
}

/* ═════════ 4. 每日戰報（台灣時間每天早上 8 點推 Discord） ═════════ */

const DAILY_KEY = 'daily-report:';
/** 現在是不是該推（UTC 00:00～00:30＝台灣 08:00～08:30），而且今天還沒推過 */
export async function maybeDailyReport(env, { executorCall, postDiscord, dry = false, force = false, now = Date.now() } = {}) {
  const d = new Date(now), day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  if (!force && !(d.getUTCHours() === 0 && d.getUTCMinutes() < 30)) return { skipped: 'not-time' };
  if (!force && env.SMC_KV && (await env.SMC_KV.get(DAILY_KEY + day))) return { skipped: 'already-sent' };
  const text = await buildDailyReport(env, { executorCall, now });
  if (!dry) {
    if (env.SMC_KV) await env.SMC_KV.put(DAILY_KEY + day, String(now), { expirationTtl: 3 * 86400 });
    await postDiscord(env, { embeds: [{ title: `📊 每日戰報｜${day}`, description: text, color: 0x8e9dff, timestamp: new Date(now).toISOString() }] });
  }
  return { sent: !dry, day, text };
}

export async function buildDailyReport(env, { executorCall, now = Date.now() } = {}) {
  const sec = now / 1000, from = sec - 86400;
  const done = await kvJson(env, LIVE_DONE_KEY, []), open = await kvJson(env, LIVE_OPEN_KEY, []);
  const y = done.filter((x) => x.endT >= from && x.endT < sec);
  const sumR = (l) => l.reduce((a, x) => a + x.r, 0);
  const fR = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}R`;
  const wr = (l) => (l.length ? Math.round(l.filter((x) => x.r > 0).length / l.length * 100) + '%' : '—');
  const coin = (s) => s.replace(/USDT$/, '');
  const lines = ['**🧭 教練劇本（過去 24 小時結束的）**'];
  if (!y.length) lines.push('沒有結束的劇本');
  else {
    const al = y.filter((x) => x.bias === 2);
    lines.push(`${y.length} 筆・勝率 ${wr(y)}・總計 **${fR(sumR(y))}**`);
    lines.push(`只算順勢：${al.length} 筆・${fR(sumR(al))}　｜　≥2R：${fR(sumR(y.filter((x) => x.rr >= 2)))}`);
    const best = [...y].sort((a, b) => b.r - a.r)[0], worst = [...y].sort((a, b) => a.r - b.r)[0];
    lines.push(`最好 ${coin(best.sym)} ${best.iv} ${fR(best.r)}・最差 ${coin(worst.sym)} ${worst.iv} ${fR(worst.r)}`);
  }
  if (done.length) {
    const days = Math.max(1, Math.round((sec - Math.min(...done.map((x) => x.rtT))) / 86400));
    lines.push(`開始記錄以來（${days} 天）：${done.length} 筆・總計 ${fR(sumR(done))}・進行中 ${open.length} 筆`);
  }
  // 你的手動單（有接日誌才有）
  if (executorCall && env.EXECUTOR_URL && env.EXECUTOR_HMAC_SECRET) {
    try {
      const j = await journalResponse(env, 2, executorCall);
      if (j.configured) {
        const t = j.trades.filter((x) => x.strategy === 'manual' && x.closeTime >= now - 86400e3 && x.pnl != null);
        const net = t.reduce((a, x) => a + x.pnl, 0), fees = t.reduce((a, x) => a + x.fees, 0);
        lines.push('', '**💼 你的手動單（過去 24 小時）**');
        lines.push(t.length ? `${t.length} 筆・勝率 ${Math.round(t.filter((x) => x.pnl > 0).length / t.length * 100)}%・淨損益 **${net >= 0 ? '+' : ''}${net.toFixed(2)}U**（手續費 ${fees.toFixed(2)}U）` : '沒有平倉的單');
        if (j.balance) lines.push(`現在權益 ${j.balance.toFixed(2)}U`);
        const noSl = (j.positions || []).filter((p) => !p.stopLoss);
        if (noSl.length) lines.push(`⚠️ 沒設停損的持倉：${noSl.map((p) => `${coin(p.symbol)} ${p.side === 'Buy' ? '多' : '空'} ${p.leverage}x`).join('、')}`);
      }
    } catch (e) { lines.push('', `💼 手動單讀取失敗：${e.message}`); }
  }
  const watches = await kvJson(env, WATCH_KEY, []);
  lines.push('', '**⏰ 今天的殺區（台灣時間）**', '倫敦 15:00–18:00・紐約早盤 20:00–23:00・紐約午盤 01:30–04:00');
  if (watches.length) lines.push(`👀 盯單中 ${watches.length} 筆`);
  lines.push('', '教練劇本回測沒有穩定優勢，戰報是幫你檢查紀律，不是進場建議。');
  return lines.join('\n');
}
