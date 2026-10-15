/**
 * SMC 教練自動下單（2026-10-15 使用者要的）。
 *
 * 什麼時候下：教練劇本到位（回踩在結構轉向之後）、跟 4h 同向、盈虧比 ≥ 2R、現在離進場點 0.5R 內、回踩就是剛收盤那一兩根。
 * 怎麼下：在進場點掛限價單，停損、目標一起掛在 Bybit；12 根 K 棒沒成交、或沒成交就先到目標，就取消。
 * 下多大：每筆風險＝權益 × riskPct（預設 9%，220U 約 20U；帳戶變大跟著變大、虧了跟著變小）；名目價值＝風險 ÷ 停損距離、槓桿最高 50 倍且停損一定比強平近，
 *         保證金不夠就不下。1R＝打到停損會虧的 U。
 * 條件：Demo 預設「有訊號就進」（demoLoose）；真錢預設只做順 4h＋≥2R，liveLoose 打開就跟 Demo 一樣（App 一鍵切換）。
 * 煞車：同時最多 maxPos 筆（預設 5，含還沒成交的掛單）；當天（台灣時間 08:00 起算）虧損 dailyLosses 筆（預設 5 筆）就停到隔天 08:00。
 * 帳戶：App 開關 off／demo／live／both（Demo 跟真錢同時跑），預設 off；煞車每個帳戶各算各的。Executor 那邊 demo、live 是兩個分開的帳戶，跟 6 個順勢策略的主帳戶無關。
 */

const CFG_KEY = 'coachauto:cfg';
const TRADES_KEY = 'coachauto:trades';
const TRADES_MAX = 400;
const VALID_BARS = 12;
// riskPct：每筆打到停損虧權益的幾 %（2026-10-15 使用者選 9%，約 20U，跟著帳戶大小變）
// dailyLosses：當天虧損幾筆就停（使用者選 5 筆）
// demoEquity：Demo 帳戶錢比較多（跟順勢策略共用），檢查保證金夠不夠時當成只有這麼多，才跟真錢帳戶（約 220U）一樣
// demoLoose：Demo 先「有訊號就進」（不限順勢、不限 2R，只要劇本剛回踩、離進場點 0.5R 內），真錢才用嚴格條件
const DEFAULT_CFG = { mode: 'off', riskPct: 0.09, maxPos: 5, dailyLosses: 5, maxLev: 50, maxNotional: 6000, demoEquity: 220, demoLoose: true, liveLoose: false };
const ACCT_NAME = { demo: 'Demo', live: '真錢' };
export const accountsOf = (mode) => (mode === 'both' ? ['demo', 'live'] : mode === 'demo' || mode === 'live' ? [mode] : []);
const pausedOf = (cfg, a) => (cfg.paused && cfg.paused[a]) || 0;

async function kvJson(env, key, dflt) {
  if (!env.SMC_KV) return dflt;
  try { const v = await env.SMC_KV.get(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}
export async function loadAutoCfg(env) { return { ...DEFAULT_CFG, ...(await kvJson(env, CFG_KEY, {})) }; }
const coin = (s) => s.replace(/USDT$/, '');
const fmtP = (p) => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(3) : p >= 1 ? p.toFixed(4) : p.toPrecision(5));
/** 台灣時間今天 08:00 的時間戳（ms） */
export function dayStart(now = Date.now()) { return Math.floor(now / 86400e3) * 86400e3; } // 台灣 08:00＝UTC 00:00

/** 倉位大小：純函式，測試用 */
/**
 * 倉位大小（純函式）：每筆固定風險 riskU（打到停損虧多少 U）
 *   名目價值＝riskU ÷ 停損距離（最多 maxNotional，超過就縮，實際風險變小）
 *   槓桿＝最多 maxLev，而且停損距離 × 槓桿 ≤ 0.8（停損一定比強平近）；保證金＝名目價值 ÷ 槓桿
 *   保證金加上已經開著的單超過可用權益 95% 就不下
 */
export function sizeCoachOrder({ equity, en, sl, riskU = 20, maxLev = 50, maxNotional = 6000, usedMargin = 0 }) {
  if (!(equity > 0 && en > 0 && sl > 0 && en !== sl)) return { skip: '資料不足' };
  const stopDist = Math.abs(en - sl) / en;
  const notional = Math.min(riskU / stopDist, maxNotional);
  const lev = Math.max(1, Math.min(maxLev, Math.floor(0.8 / stopDist)));
  const margin = notional / lev, qty = notional / en;
  if (usedMargin + margin > equity * 0.95) return { skip: `保證金不夠（要 ${margin.toFixed(0)}U，已用 ${usedMargin.toFixed(0)}U）`, margin };
  return { stopDist, lev, notional, qty, margin, riskU: qty * Math.abs(en - sl), riskPct: qty * Math.abs(en - sl) / equity };
}

/** runCoach 每根收盤找出來的「可以自動下單」的劇本 */
export function autoCandidate({ job, side, r, f, W, sessKz }) {
  const j = W.length - 1;
  if (r.stage < 4 || r.rt == null || !f.plan || f.status !== 'near') return null;
  if (!(f.plan.rr > 0)) return null;
  if (j - r.rt > 1) return null; // 回踩要是剛收盤的那一兩根，太久以前的不追
  return {
    id: `cc:${coin(job.sym)}:${job.iv}:${side}:${W[r.sweep.u].t}`.slice(0, 36), sym: job.sym, iv: job.iv, ms: job.ms, side,
    en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, rr: f.plan.rr, bias: r.bias, disc: r.disc, sessKz, rtT: W[r.rt].t,
  };
}

/** GET／POST /coach-auto（要 App 密碼） */
export async function handleCoachAuto(request, env, { executorCall } = {}) {
  const cfg = await loadAutoCfg(env);
  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return { status: 400, body: { error: '格式不對' } }; }
    const next = { ...cfg };
    if (b.mode !== undefined) { if (!['off', 'demo', 'live', 'both'].includes(b.mode)) return { status: 400, body: { error: 'mode 只能是 off／demo／live／both' } }; next.mode = b.mode; }
    for (const [k, lo, hi] of [['riskPct', 0.005, 0.2], ['maxPos', 1, 10], ['dailyLosses', 1, 20]]) if (b[k] !== undefined) next[k] = Math.max(lo, Math.min(hi, Number(b[k]) || cfg[k]));
    if (typeof b.liveLoose === 'boolean') next.liveLoose = b.liveLoose;
    if (typeof b.demoLoose === 'boolean') next.demoLoose = b.demoLoose;
    if (next.mode !== cfg.mode) { next.pausedUntil = 0; next.paused = {}; }
    if (env.SMC_KV) await env.SMC_KV.put(CFG_KEY, JSON.stringify(next));
    return { status: 200, body: { ok: true, cfg: next } };
  }
  const trades = await kvJson(env, TRADES_KEY, []);
  const accounts = {};
  if (executorCall && env.EXECUTOR_URL) {
    for (const a of accountsOf(cfg.mode)) {
      let st;
      try { st = await executorCall(env, 'GET', '/coach/state', { query: { account: a } }); } catch (e) { st = { error: e.message }; }
      accounts[a] = {
        equity: st?.equity ?? null, error: st?.error || (st && !st.configured ? '帳戶沒設定金鑰' : null) || Object.values(st?.errors || {})[0] || null, pausedUntil: pausedOf(cfg, a),
        // 帳戶上現在的持倉（含不是教練下的）跟教練掛單，看停損／止盈有沒有真的掛上
        positions: (st?.positions || []).map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit, coach: trades.some((t) => t.account === a && t.sym === p.symbol && t.state === 'open') })),
        orders: st?.orders || [],
      };
    }
  }
  const first = Object.values(accounts)[0] || {};
  return { status: 200, body: { cfg, trades: trades.slice(0, 200), accounts, equity: first.equity ?? null, stateError: first.error || null } };
}

/**
 * 每次排程都跑：先對帳（掛單成交了沒、該不該取消、倉位平了沒、算 R），再看煞車，最後下新單。
 * deps: executorCall, postDiscord, fetchKlines(env, sym, iv, n), now
 */
export async function runCoachAuto(env, { candidates = [], executorCall, postDiscord, fetchKlines, dry = false, now = Date.now() } = {}) {
  if (!env.SMC_KV || !env.EXECUTOR_URL) return { skipped: 'no-executor' };
  const cfg = await loadAutoCfg(env);
  let trades = await kvJson(env, TRADES_KEY, []);
  const active = trades.filter((t) => t.state === 'pending' || t.state === 'open');
  const accts = accountsOf(cfg.mode);
  if (!accts.length && !active.length) return { mode: 'off' };
  cfg.paused = cfg.paused || {};
  const out = { mode: cfg.mode, placed: [], updates: [], errors: [] };
  let dirty = false, cfgDirty = false;
  const say = async (msg) => { out.updates.push(msg); if (!dry) await postDiscord(env, { content: msg }).catch(() => {}); };
  const states = {};
  const getState = async (acct) => (states[acct] ??= await executorCall(env, 'GET', '/coach/state', { query: { account: acct } }).catch((e) => ({ error: e.message })));

  // ── 對帳
  for (const t of active) {
    const st = await getState(t.account);
    if (st.error || !st.configured) { out.errors.push(`${t.id}：${st.error || '帳戶沒設定'}`); continue; }
    const tag = `🤖 ${ACCT_NAME[t.account]}｜${coin(t.sym)} ${t.iv} ${t.side === 'L' ? '多' : '空'}`;
    if (t.state === 'pending') {
      const o = st.orders.find((x) => x.orderLinkId === t.id);
      if (o) {
        let why = null;
        if (now > t.validUntil) why = `${VALID_BARS} 根沒成交`;
        else {
          try {
            const rows = await fetchKlines(env, t.sym, t.iv, 4);
            if (rows.some((k) => k.time + t.ms > t.placedAt && (t.side === 'L' ? +k.high >= t.tp : +k.low <= t.tp))) why = '沒回到進場點就先到目標';
          } catch { /* 下次再看 */ }
        }
        if (why && !dry) {
          await executorCall(env, 'POST', '/coach/cancel', { body: { account: t.account, symbol: t.sym, orderLinkId: t.id } }).catch(() => {});
          if (o.cumExecQty > 0) { Object.assign(t, { state: 'open', qty: o.cumExecQty, fillPrice: t.en, fillAt: now, riskU: o.cumExecQty * Math.abs(t.en - t.sl) }); await say(`${tag}：部分成交 ${o.cumExecQty}，剩下的取消（${why}）`); }
          else { Object.assign(t, { state: 'cancelled', why, closedAt: now }); await say(`${tag}：取消掛單（${why}）`); }
          dirty = true;
        }
        continue;
      }
      const h = st.history.find((x) => x.orderLinkId === t.id);
      const pos = st.positions.find((p) => p.symbol === t.sym);
      if ((h && h.cumExecQty > 0) || (!h && pos)) {
        const q = h?.cumExecQty || pos.size, px = h?.avgPrice || pos.avgPrice || t.en;
        Object.assign(t, { state: 'open', qty: q, fillPrice: px, fillAt: h?.updatedTime || now, riskU: q * Math.abs(px - t.sl) });
        await say(`${tag}：成交 ${fmtP(px)}・停損 ${fmtP(t.sl)}・目標 ${fmtP(t.tp)}・1R＝${t.riskU.toFixed(2)}U`);
      } else {
        Object.assign(t, { state: 'cancelled', why: h ? `交易所狀態 ${h.orderStatus}` : '找不到這張單', closedAt: now });
        await say(`${tag}：掛單沒成交就不見了（${t.why}）`);
      }
      dirty = true;
      continue;
    }
    // open：持倉不見了＝停損或目標打到了（或使用者手動平倉）
    if (!st.positions.some((p) => p.symbol === t.sym)) {
      const pnl = st.closedPnl.filter((p) => p.symbol === t.sym && p.updatedTime >= (t.fillAt || t.placedAt) - 60e3).reduce((a, p) => a + p.closedPnl, 0);
      const r = t.riskU > 0 ? pnl / t.riskU : 0;
      Object.assign(t, { state: 'closed', closedAt: now, pnl: Math.round(pnl * 100) / 100, r: Math.round(r * 100) / 100 });
      await say(`${r >= 0 ? '✅' : '⛔'} ${tag}：平倉 ${r >= 0 ? '+' : ''}${r.toFixed(2)}R（${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}U）`);
      dirty = true;
    }
  }

  // ── 每個帳戶各自：煞車（當天虧損筆數）→ 下新單
  const d0 = dayStart(now);
  for (const acct of accts) {
    const todayClosed = trades.filter((t) => t.account === acct && t.state === 'closed' && t.closedAt >= d0);
    const todayLosses = todayClosed.filter((t) => (t.r || 0) < 0).length, todayR = todayClosed.reduce((a, t) => a + (t.r || 0), 0);
    if (todayLosses >= cfg.dailyLosses && !(pausedOf(cfg, acct) > now)) {
      cfg.paused[acct] = d0 + 86400e3; cfgDirty = true;
      await say(`🛑 教練自動下單（${ACCT_NAME[acct]}）今天已經虧 ${todayLosses} 筆（合計 ${todayR.toFixed(2)}R），暫停到明天早上 8 點。已經在場內的單照停損／目標走。`);
    }
    if (pausedOf(cfg, acct) > now || !candidates.length) continue;
    for (const c of candidates) {
      // 寬鬆＝有訊號就進；嚴格＝只做順 4h＋≥2R。Demo 看 demoLoose、真錢看 liveLoose
      const strict = !(acct === 'demo' ? cfg.demoLoose : cfg.liveLoose);
      if (strict && (c.bias !== 2 || c.rr < 2)) continue;
      const live = trades.filter((t) => t.account === acct && (t.state === 'pending' || t.state === 'open'));
      if (live.length >= cfg.maxPos) { out.errors.push(`${ACCT_NAME[acct]}：已經 ${live.length} 筆，達上限`); break; }
      if (trades.some((t) => t.id === c.id && t.account === acct)) continue;
      if (live.some((t) => t.sym === c.sym)) continue;
      const st = await getState(acct);
      if (st.error || !st.configured || !(st.equity > 0)) { out.errors.push(`讀不到 ${ACCT_NAME[acct]} 帳戶：${st.error || Object.values(st.errors || {})[0] || '權益是 0'}`); break; }
      const usedMargin = live.reduce((a, t) => a + (t.margin || 0), 0);
      const eq = acct === 'demo' ? Math.min(st.equity, cfg.demoEquity) : st.equity;
      const sz = sizeCoachOrder({ equity: eq, en: c.en, sl: c.sl, riskU: eq * (cfg.riskPct ?? 0.09), maxLev: cfg.maxLev, maxNotional: cfg.maxNotional, usedMargin });
      if (sz.skip) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${sz.skip}`); continue; }
      const body = { account: acct, symbol: c.sym, side: c.side === 'L' ? 'Buy' : 'Sell', qty: sz.qty, price: c.en, stopLoss: c.sl, takeProfit: c.tp, leverage: sz.lev, orderLinkId: c.id };
      if (dry) { out.placed.push({ ...body, dry: true }); continue; }
      let r;
      try { r = await executorCall(env, 'POST', '/coach/order', { body }); } catch (e) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${e.message}`); continue; }
      if (!r.ok) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${r.skipped || r.error}`); continue; }
      const t = {
        id: c.id, account: acct, sym: c.sym, iv: c.iv, ms: c.ms, side: c.side, en: r.price, sl: r.stopLoss ?? c.sl, tp: r.takeProfit ?? c.tp, rr: Math.round(c.rr * 100) / 100,
        qty: r.qty, lev: r.leverage, riskU: r.qty * Math.abs(r.price - (r.stopLoss ?? c.sl)), riskPct: sz.riskPct, margin: r.qty * r.price / r.leverage, equity: st.equity, bias: c.bias, disc: c.disc, sessKz: c.sessKz,
        placedAt: now, validUntil: now + VALID_BARS * c.ms, state: 'pending',
      };
      trades.unshift(t); dirty = true; out.placed.push(accts.length > 1 ? `${acct}:${t.id}` : t.id);
      await say(`🤖 教練自動下單（${ACCT_NAME[acct]}）｜${coin(c.sym)} ${c.iv} ${c.side === 'L' ? '多單' : '空單'}：掛 ${fmtP(t.en)} 限價・停損 ${fmtP(t.sl)}・目標 ${fmtP(t.tp)}（${c.rr.toFixed(1)}R）・${t.lev}x・保證金 ${t.margin.toFixed(0)}U・1R＝${t.riskU.toFixed(2)}U${c.bias === 2 ? '・順勢' : c.bias === 0 ? '・逆勢' : ''}`);
    }
  }
  if (dirty && !dry) await env.SMC_KV.put(TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  if (cfgDirty && !dry) await env.SMC_KV.put(CFG_KEY, JSON.stringify(cfg));
  return out;
}
