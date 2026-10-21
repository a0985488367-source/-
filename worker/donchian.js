/**
 * 唐奇安通道組合（2026-10-21 使用者選上 Demo 試跑，倉位 ×3）：每天 UTC 00:20 之後（台灣 08:20）跑一次。
 * 規則跟回測共用 src/strategies/donchian-ensemble.js（回測 scripts/research/wild-zoo.mjs 的 A）。
 *
 *   1. 抓 20 檔大幣的日 K（Binance 公開行情鏡像，最多 1500 天），算每個幣的目標權重（只做多）
 *   2. 目標名目＝權重 × 帳戶總額 × DONCHIAN_MULT；跟現在差不到 DONCHIAN_BAND（相對）就不動（回測的「少換倉」）
 *   3. 叫 Executor POST /dc/adjust 加倉／減倉，順便把災難停損設在「還開著的週期裡最低停損」再往下 DONCHIAN_STOP_BUFFER
 *   4. 自己的持倉數量記在 KV dc:state；別的策略或手動單佔著的幣不碰，其他策略也不會開唐奇安持有的幣（breakoutOrder 會查）
 * 只在 Executor 接 Demo、自動下單開著時下單；Executor 那邊接真錢也會一律拒絕。
 */

import { donchianLatest, alignDailyCloses, applyBand } from '../src/strategies/donchian-ensemble.js';

const DAY = 86_400_000;
export const DC_STATE_KEY = 'dc:state';
const DC_REPORT_KEY = 'dc:last-report';

export const DC_DEFAULTS = {
  DONCHIAN_ENABLED: 'false',
  DONCHIAN_SYMBOLS: 'BTC,ETH,BNB,XRP,ADA,DOGE,SOL,TRX,LTC,LINK,DOT,AVAX,ETC,BCH,XLM,ATOM,UNI,FIL,NEAR,ALGO',
  DONCHIAN_MULT: '3',            // 倉位倍數（使用者選 3 倍）
  DONCHIAN_VOL_TARGET: '0.25',   // 每個幣調到年化波動 25%
  DONCHIAN_CAP: '2',             // 每個幣最多 2 倍（乘倍數之前）
  DONCHIAN_BAND: '0.3',          // 跟現在差不到 30% 不換倉
  DONCHIAN_STOP_BUFFER: '0.1',   // 災難停損＝最低停損再往下 10%
  DONCHIAN_LEVERAGE: '10',       // 交易所槓桿設定（只影響佔用的保證金，不影響倉位大小）
  DONCHIAN_RUN_AFTER_MIN: '20',  // UTC 00:20 之後才跑（跟 4h／6h 收盤錯開）
  DONCHIAN_RUN_UNTIL_MIN: '180', // UTC 03:00 前資料一直抓不齊，就用抓到的跑
  DONCHIAN_DAYS: '1500',
};
const dcfg = (env, k) => env[k] ?? DC_DEFAULTS[k];
const symbolsOf = (env) => String(dcfg(env, 'DONCHIAN_SYMBOLS')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 唐奇安現在持有的幣（其他策略開單前查，避免單向持倉模式下兩個策略疊在同一個部位） */
export async function donchianHeld(env) {
  if (!env.SMC_KV) return new Set();
  const st = JSON.parse((await env.SMC_KV.get(DC_STATE_KEY)) ?? 'null');
  return new Set(Object.entries(st?.pos ?? {}).filter(([, p]) => p.qty > 0).map(([s]) => s));
}

/** 日 K：Binance 公開行情鏡像，一次 1000 根，往前再補一頁；失敗改 Bybit 合約（最多 1000 根） */
export async function fetchDaily(symbol, days, fetchImpl = fetch) {
  try {
    let out = [];
    let endTime;
    while (out.length < days) {
      const q = new URLSearchParams({ symbol, interval: '1d', limit: String(Math.min(1000, days - out.length)) });
      if (endTime) q.set('endTime', String(endTime));
      const res = await fetchImpl(`https://data-api.binance.vision/api/v3/klines?${q}`);
      if (!res.ok) throw new Error(`binance HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('binance 格式不對');
      const page = rows.map((r) => ({ time: +r[0], close: +r[4] })).filter((k) => !out.length || k.time < out[0].time);
      if (!page.length) break;
      out = [...page, ...out];
      endTime = out[0].time - 1;
      if (rows.length < 1000) break;
    }
    if (out.length) return out;
    throw new Error('binance 沒有資料');
  } catch (e) {
    const q = new URLSearchParams({ category: 'linear', symbol, interval: 'D', limit: '1000' });
    const res = await fetchImpl(`https://api.bybit.com/v5/market/kline?${q}`);
    if (!res.ok) throw new Error(`${e.message}；bybit HTTP ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0 || !data.result?.list?.length) throw new Error(`${e.message}；bybit ${data.retMsg || '沒有資料'}`);
    return data.result.list.map((r) => ({ time: +r[0], close: +r[4] })).sort((a, b) => a.time - b.time);
  }
}

/** 算目標（不下單）：回傳每個幣的權重、訊號、停損，給排程和 /dc/preview 共用 */
export async function computeDonchian(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const symbols = symbolsOf(env);
  const days = Number(dcfg(env, 'DONCHIAN_DAYS'));
  const candles = {}, errors = [];
  for (let i = 0; i < symbols.length; i += 5) {
    await Promise.all(symbols.slice(i, i + 5).map(async (s) => {
      try { candles[s] = await fetchDaily(s, days, fetchImpl); } catch (e) { errors.push(`${s}：${e.message}`); }
    }));
  }
  const { days: axis, closes } = alignDailyCloses(candles, now);
  const lastDay = axis.at(-1);
  const r = donchianLatest(closes, { volTarget: Number(dcfg(env, 'DONCHIAN_VOL_TARGET')), cap: Number(dcfg(env, 'DONCHIAN_CAP')) });
  const lastClose = Object.fromEntries(Object.entries(closes).map(([s, a]) => [s, a.at(-1)]));
  return { symbols, errors, lastDay, lastClose, weights: r.weights, detail: r.detail, eligible: r.eligible };
}

/**
 * 排程進入點（run() 每 2 分鐘叫一次；一天只真的跑一次）。
 * deps：executorCall、getPrices、postDiscord、isAutoTradeEnabled、executorMode、trackedPositions
 */
export async function runDonchian(env, deps, { now = Date.now(), force = false } = {}) {
  if (dcfg(env, 'DONCHIAN_ENABLED') !== 'true') return { enabled: false };
  if (!env.SMC_KV) return { skipped: 'no-kv' };
  const today = ymd(now);
  const minOfDay = (now % DAY) / 60000;
  const after = Number(dcfg(env, 'DONCHIAN_RUN_AFTER_MIN')), until = Number(dcfg(env, 'DONCHIAN_RUN_UNTIL_MIN'));
  if (!force && (minOfDay < after || minOfDay > until + 60)) return { skipped: 'not-time' };
  const state = JSON.parse((await env.SMC_KV.get(DC_STATE_KEY)) ?? 'null') ?? { pos: {} };
  if (!force && state.lastRun === today) return { skipped: 'done', lastRun: today };
  if (!(await deps.isAutoTradeEnabled(env))) return { skipped: 'auto-trade-off' };
  if ((await deps.executorMode(env)) !== 'demo') return { skipped: 'not-demo' };

  const c = await computeDonchian(env, { now, fetchImpl: deps.fetchImpl ?? fetch });
  const expectDay = Math.floor(now / DAY) * DAY - DAY;
  const stale = c.lastDay !== expectDay;
  // 資料沒抓齊（或還沒更新到昨天收盤）先等下一次排程；拖到 until 還不齊就用抓到的跑
  if ((c.errors.length || stale) && minOfDay < until && !force) return { skipped: 'waiting-data', errors: c.errors.slice(0, 5), stale };

  const wallet = await deps.executorCall(env, 'GET', '/balance');
  const equity = Number(wallet?.totalWalletBalance);
  if (!(equity > 0)) return { error: `查帳戶餘額失敗：${wallet?.error ?? equity}` };
  const prices = await deps.getPrices(c.symbols).catch(() => ({}));
  const tracked = await deps.trackedPositions(env).catch(() => []);
  const busy = new Set(tracked.map((p) => p.symbol));
  const mult = Number(dcfg(env, 'DONCHIAN_MULT')), band = Number(dcfg(env, 'DONCHIAN_BAND'));
  const buffer = Number(dcfg(env, 'DONCHIAN_STOP_BUFFER')), lev = Number(dcfg(env, 'DONCHIAN_LEVERAGE'));
  const tag = today.replaceAll('-', '');
  const rows = [];

  for (const sym of c.symbols) {
    const price = Number(prices[sym]) || c.lastClose[sym];
    const cur = state.pos[sym]?.qty ?? 0;
    const d = c.detail[sym];
    const row = { sym, signal: d?.signal ?? null, before: cur };
    if (!(price > 0)) { rows.push({ ...row, after: cur, error: '沒有價格' }); continue; }
    // 這個幣的日 K 沒抓到：維持原狀，不要因為資料問題把部位平掉
    if (!(sym in c.lastClose)) { rows.push({ ...row, after: cur, note: '資料抓不到，維持原狀' }); continue; }
    if (!d && !cur) { rows.push({ ...row, note: c.errors.some((e) => e.startsWith(sym)) ? '資料抓不到' : '資料不到一年' }); continue; }
    const want = (c.weights[sym] ?? 0) * mult;
    const curW = (cur * price) / equity;
    const w = applyBand(want, curW, band);
    const target = w === curW ? cur : (w * equity) / price;
    row.weight = w;
    if (!cur && !(target > 0)) { rows.push({ ...row, after: 0 }); continue; }
    if (busy.has(sym) && !cur) { rows.push({ ...row, skipped: 'occupied', note: '別的策略的單佔著' }); continue; }
    const stopRaw = d?.stop ? d.stop * (1 - buffer) : null;
    const stopLoss = stopRaw && stopRaw < price ? stopRaw : null;
    const body = { symbol: sym, targetQty: target, expectQty: cur, refPrice: price, stopLoss, leverage: lev, orderLinkId: `dc:${sym.replace(/USDT$/, '')}:${tag}` };
    let res = await deps.executorCall(env, 'POST', '/dc/adjust', { body }).catch((e) => ({ ok: false, error: e.message }));
    // 部位被停損（或手動）平掉了：記錄歸零再試一次
    if (res.skipped === 'occupied' && res.current === 0 && cur > 0) {
      row.note = '原本的部位已經不在（可能打到災難停損或被手動平掉）';
      res = await deps.executorCall(env, 'POST', '/dc/adjust', { body: { ...body, expectQty: 0, orderLinkId: `${body.orderLinkId}:r` } }).catch((e) => ({ ok: false, error: e.message }));
      if (!res.ok) { delete state.pos[sym]; row.before = 0; }
    }
    // 上一次下單其實成交了只是沒收到回應：交易所數量已經是目標，就當完成
    if (res.skipped === 'occupied' && res.current > 0 && Math.abs(res.current - target) <= Math.max(1e-9, target * 0.02)) res = { ok: true, after: res.current, ordered: 0 };
    if (res.ok) {
      if (res.after > 0) state.pos[sym] = { qty: res.after, since: state.pos[sym]?.since ?? now, stop: res.stopLoss ?? null };
      else delete state.pos[sym];
      rows.push({ ...row, after: res.after, ordered: res.ordered, stopLoss: res.stopLoss, stopError: res.stopError });
    } else rows.push({ ...row, after: state.pos[sym]?.qty ?? 0, skipped: res.skipped, error: res.error, current: res.current });
  }

  state.lastRun = today;
  state.lastRunAt = now;
  await env.SMC_KV.put(DC_STATE_KEY, JSON.stringify(state));
  const report = { at: now, day: c.lastDay ? ymd(c.lastDay) : '-', equity, mult, rows, errors: c.errors };
  await env.SMC_KV.put(DC_REPORT_KEY, JSON.stringify(report), { expirationTtl: 30 * 86400 });
  await deps.postDiscord(env, buildDonchianEmbed(report, prices, c)).catch(() => {});
  return { ran: true, orders: rows.filter((r) => r.ordered).length, held: Object.keys(state.pos).length };
}

export function buildDonchianEmbed(report, prices, c) {
  const base = (s) => s.replace(/USDT$/, '');
  const sig = (x) => (x == null ? '-' : `${Math.round(x * 9)}/9`);
  const fmt = (q) => (q ? +Number(q).toPrecision(4) : 0);
  const lines = [];
  let notional = 0, held = 0;
  for (const r of report.rows) {
    const p = Number(prices[r.sym]) || c.lastClose[r.sym] || 0;
    if (r.after > 0) { held++; notional += r.after * p; }
    if (r.ordered) lines.push(`${r.ordered > 0 ? '🟢 加' : r.after > 0 ? '🟡 減' : '🔴 平'} **${base(r.sym)}** ${fmt(r.before)} → ${fmt(r.after)}（訊號 ${sig(r.signal)}）`);
    else if (r.skipped === 'occupied') lines.push(`⏸️ ${base(r.sym)} 有別的單佔著，先不動`);
    else if (r.error) lines.push(`⚠️ ${base(r.sym)}：${String(r.error).slice(0, 80)}`);
    if (r.stopError) lines.push(`⚠️ ${base(r.sym)} 災難停損沒設成：${String(r.stopError).slice(0, 60)}`);
  }
  if (!lines.length) lines.push('今天不用調倉');
  const holds = report.rows.filter((r) => r.after > 0).map((r) => `${base(r.sym)} ${sig(r.signal)}`).join('、') || '無';
  return {
    embeds: [{
      title: `📐 唐奇安組合每日調倉（Demo，${report.mult} 倍）`,
      color: 0x1f3a5f,
      description: lines.join('\n').slice(0, 3800),
      fields: [
        { name: '持有', value: `${held} / ${report.rows.length} 檔：${holds}`.slice(0, 1000), inline: false },
        { name: '總曝險', value: `${notional.toFixed(0)}U（帳戶 ${report.equity.toFixed(0)}U 的 ${((notional / report.equity) * 100).toFixed(0)}%）`, inline: true },
        { name: '依據', value: `${report.day} 日線收盤`, inline: true },
        ...(report.errors.length ? [{ name: '資料沒抓到', value: report.errors.slice(0, 5).join('\n').slice(0, 1000), inline: false }] : []),
      ],
    }],
  };
}

/** GET /dc/status：現在持有、上一次調倉結果；?preview=1 另外用最新資料算一次目標（不下單） */
export async function handleDonchianStatus(env, url, deps) {
  const state = env.SMC_KV ? JSON.parse((await env.SMC_KV.get(DC_STATE_KEY)) ?? 'null') : null;
  const last = env.SMC_KV ? JSON.parse((await env.SMC_KV.get(DC_REPORT_KEY)) ?? 'null') : null;
  const out = {
    enabled: dcfg(env, 'DONCHIAN_ENABLED') === 'true',
    mult: Number(dcfg(env, 'DONCHIAN_MULT')),
    symbols: symbolsOf(env),
    state,
    last,
  };
  if (url.searchParams.get('preview') === '1') {
    const c = await computeDonchian(env);
    const wallet = await deps.executorCall(env, 'GET', '/balance').catch((e) => ({ error: e.message }));
    const equity = Number(wallet?.totalWalletBalance) || null;
    const mult = out.mult;
    out.preview = {
      day: c.lastDay ? ymd(c.lastDay) : null, equity, errors: c.errors, eligible: c.eligible.length,
      targets: c.symbols.map((s) => ({
        sym: s, signal: c.detail[s]?.signal ?? null, vol: c.detail[s]?.vol ?? null,
        weight: (c.weights[s] ?? 0) * mult,
        notional: equity ? (c.weights[s] ?? 0) * mult * equity : null,
        stop: c.detail[s]?.stop ?? null, close: c.lastClose[s] ?? null,
      })),
    };
  }
  return out;
}
