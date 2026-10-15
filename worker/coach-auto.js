/**
 * SMC 教練自動下單（2026-10-15 使用者要的）。
 *
 * 什麼時候下：教練劇本到位（回踩在結構轉向之後）、跟 4h 同向、盈虧比 ≥ 2R、現在離進場點 0.5R 內、回踩就是剛收盤那一兩根。
 * 怎麼下：在進場點掛限價單，停損、目標一起掛在 Bybit；12 根 K 棒沒成交、或沒成交就先到目標，就取消。
 * 下多大：每筆保證金固定 marginU（預設 20U）。風險＝權益的 1.5%，折溢價對 +0.5%、掃蕩在殺區 +0.5%（最多 2.5%）；
 *         名目價值＝風險 ÷ 停損距離，槓桿＝名目價值 ÷ 保證金（15m 停損近槓桿高、1h 停損遠槓桿低），
 *         最高 50 倍，而且停損距離 × 槓桿 ≤ 0.8（停損一定比強平近）。1R＝打到停損會虧的 U。
 * 煞車：同時最多 maxPos 筆（預設 5，含還沒成交的掛單）；當天（台灣時間 08:00 起算）累計虧到 dailyLossR（預設 3R）就停到隔天 08:00。
 * 帳戶：App 開關 off／demo／live，預設 off。Executor 那邊 demo、live 是兩個分開的帳戶，跟 6 個順勢策略的主帳戶無關。
 */

const CFG_KEY = 'coachauto:cfg';
const TRADES_KEY = 'coachauto:trades';
const TRADES_MAX = 400;
const VALID_BARS = 12;
const DEFAULT_CFG = { mode: 'off', marginU: 20, maxPos: 5, dailyLossR: 3, maxLev: 50 };
const ACCT_NAME = { demo: 'Demo', live: '真錢' };

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
export function sizeCoachOrder({ equity, en, sl, disc, sessKz, marginU = 20, maxLev = 50 }) {
  if (!(equity > 0 && en > 0 && sl > 0 && en !== sl)) return { skip: '資料不足' };
  const riskPct = 0.015 + (disc ? 0.005 : 0) + (sessKz ? 0.005 : 0);
  const stopDist = Math.abs(en - sl) / en;
  let lev = Math.ceil((equity * riskPct / stopDist) / marginU);
  lev = Math.max(1, Math.min(lev, maxLev, Math.floor(0.8 / stopDist)));
  if (lev < 1) return { skip: '停損太遠' };
  const notional = marginU * lev, qty = notional / en, riskU = qty * Math.abs(en - sl);
  return { riskPct, stopDist, lev, notional, qty, riskU };
}

/** runCoach 每根收盤找出來的「可以自動下單」的劇本 */
export function autoCandidate({ job, side, r, f, W, sessKz }) {
  const j = W.length - 1;
  if (r.stage < 4 || r.rt == null || !f.plan || f.status !== 'near') return null;
  if (r.bias !== 2 || f.plan.rr < 2) return null;
  if (j - r.rt > 1) return null; // 回踩要是剛收盤的那一兩根，太久以前的不追
  return {
    id: `cc:${coin(job.sym)}:${job.iv}:${side}:${W[r.sweep.u].t}`.slice(0, 36), sym: job.sym, iv: job.iv, ms: job.ms, side,
    en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, rr: f.plan.rr, disc: r.disc, sessKz, rtT: W[r.rt].t,
  };
}

/** GET／POST /coach-auto（要 App 密碼） */
export async function handleCoachAuto(request, env, { executorCall } = {}) {
  const cfg = await loadAutoCfg(env);
  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return { status: 400, body: { error: '格式不對' } }; }
    const next = { ...cfg };
    if (b.mode !== undefined) { if (!['off', 'demo', 'live'].includes(b.mode)) return { status: 400, body: { error: 'mode 只能是 off／demo／live' } }; next.mode = b.mode; }
    for (const [k, lo, hi] of [['marginU', 5, 200], ['maxPos', 1, 10], ['dailyLossR', 1, 20]]) if (b[k] !== undefined) next[k] = Math.max(lo, Math.min(hi, Number(b[k]) || cfg[k]));
    if (next.mode !== cfg.mode) next.pausedUntil = 0;
    if (env.SMC_KV) await env.SMC_KV.put(CFG_KEY, JSON.stringify(next));
    return { status: 200, body: { ok: true, cfg: next } };
  }
  const trades = await kvJson(env, TRADES_KEY, []);
  let state = null;
  if (cfg.mode !== 'off' && executorCall && env.EXECUTOR_URL) {
    try { state = await executorCall(env, 'GET', '/coach/state', { query: { account: cfg.mode } }); } catch (e) { state = { error: e.message }; }
  }
  return { status: 200, body: { cfg, trades: trades.slice(0, 200), equity: state?.equity ?? null, stateError: state?.error || (state && Object.values(state.errors || {})[0]) || null } };
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
  if (cfg.mode === 'off' && !active.length) return { mode: 'off' };
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

  // ── 煞車：當天（台灣 08:00 起）這個帳戶已平倉的 R 加總
  const d0 = dayStart(now);
  const todayR = trades.filter((t) => t.account === cfg.mode && t.state === 'closed' && t.closedAt >= d0).reduce((a, t) => a + (t.r || 0), 0);
  if (cfg.mode !== 'off' && todayR <= -cfg.dailyLossR && !(cfg.pausedUntil > now)) {
    cfg.pausedUntil = d0 + 86400e3; cfgDirty = true;
    await say(`🛑 教練自動下單（${ACCT_NAME[cfg.mode]}）今天累計 ${todayR.toFixed(2)}R，已達 -${cfg.dailyLossR}R，暫停到明天早上 8 點。已經在場內的單照停損／目標走。`);
  }

  // ── 下新單
  if (cfg.mode !== 'off' && !(cfg.pausedUntil > now) && candidates.length) {
    for (const c of candidates) {
      const live = trades.filter((t) => t.account === cfg.mode && (t.state === 'pending' || t.state === 'open'));
      if (live.length >= cfg.maxPos) { out.errors.push(`已經 ${live.length} 筆，達上限`); break; }
      if (trades.some((t) => t.id === c.id && t.account === cfg.mode)) continue;
      if (live.some((t) => t.sym === c.sym)) continue;
      const st = await getState(cfg.mode);
      if (st.error || !st.configured || !(st.equity > 0)) { out.errors.push(`讀不到 ${ACCT_NAME[cfg.mode]} 帳戶：${st.error || Object.values(st.errors || {})[0] || '權益是 0'}`); break; }
      const sz = sizeCoachOrder({ equity: st.equity, en: c.en, sl: c.sl, disc: c.disc, sessKz: c.sessKz, marginU: cfg.marginU, maxLev: cfg.maxLev });
      if (sz.skip) continue;
      const body = { account: cfg.mode, symbol: c.sym, side: c.side === 'L' ? 'Buy' : 'Sell', qty: sz.qty, price: c.en, stopLoss: c.sl, takeProfit: c.tp, leverage: sz.lev, orderLinkId: c.id };
      if (dry) { out.placed.push({ ...body, dry: true }); continue; }
      let r;
      try { r = await executorCall(env, 'POST', '/coach/order', { body }); } catch (e) { out.errors.push(`${c.id}：${e.message}`); continue; }
      if (!r.ok) { out.errors.push(`${c.id}：${r.skipped || r.error}`); continue; }
      const t = {
        id: c.id, account: cfg.mode, sym: c.sym, iv: c.iv, ms: c.ms, side: c.side, en: r.price, sl: r.stopLoss ?? c.sl, tp: r.takeProfit ?? c.tp, rr: Math.round(c.rr * 100) / 100,
        qty: r.qty, lev: r.leverage, riskU: r.qty * Math.abs(r.price - (r.stopLoss ?? c.sl)), riskPct: sz.riskPct, equity: st.equity, disc: c.disc, sessKz: c.sessKz,
        placedAt: now, validUntil: now + VALID_BARS * c.ms, state: 'pending',
      };
      trades.unshift(t); dirty = true; out.placed.push(t.id);
      await say(`🤖 教練自動下單（${ACCT_NAME[cfg.mode]}）｜${coin(c.sym)} ${c.iv} ${c.side === 'L' ? '多單' : '空單'}：掛 ${fmtP(t.en)} 限價・停損 ${fmtP(t.sl)}・目標 ${fmtP(t.tp)}（${c.rr.toFixed(1)}R）・${t.lev}x・1R＝${t.riskU.toFixed(2)}U（權益 ${(sz.riskPct * 100).toFixed(1)}%）`);
    }
  }
  if (dirty && !dry) await env.SMC_KV.put(TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  if (cfgDirty && !dry) await env.SMC_KV.put(CFG_KEY, JSON.stringify(cfg));
  return out;
}
