/**
 * SMC 教練自動下單（2026-10-15 使用者要的）。
 *
 * 什麼時候下：教練劇本到位（回踩在結構轉向之後）、跟 4h 同向、盈虧比 ≥ 2R、現在離進場點 0.5R 內、回踩就是剛收盤那一兩根。
 * 怎麼下：在進場點掛限價單，停損、目標一起掛在 Bybit；12 根 K 棒沒成交、或沒成交就先到目標，就取消。
 * 下多大：每筆風險＝權益 × riskPct（預設 9%，220U 約 20U；帳戶變大跟著變大、虧了跟著變小）；名目價值＝風險 ÷ 停損距離、槓桿最高 50 倍且停損一定比強平近，
 *         保證金不夠就不下。1R＝打到停損會虧的 U。
 * 條件：Demo 預設「有訊號就進」（demoLoose）；真錢預設只做順 4h＋≥2R，liveLoose 打開就跟 Demo 一樣（App 一鍵切換）。寬鬆也要盈虧比 ≥ minRR（預設 1.5R）。
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
// minRR：寬鬆模式也至少要這麼多 R 才下（2026-10-15 PYTH 30m 空單 0.6R、逆勢、空在折價區被下了；使用者交給我決定，選 1.5R）
// plan 'B'（2026-10-17 使用者選）：只做 1h、停損至少 1.5 ATR、固定 1R 止盈（不看順逆勢、不看盈虧比、寬鬆／嚴格不管）。
//   回測 150 天 5m 精算、兩組 15 幣：勝率 55%、每筆 +0.06～0.08R，兩組前後半段四格都賺（scripts/research/coach-improve2*.mjs）；
//   原本的做法（全部週期、結構目標、≥1.5R）兩組都虧（-0.07～-0.19R）。plan 'legacy' 回到原本的寬鬆／嚴格規則
const DEFAULT_CFG = { mode: 'off', riskPct: 0.09, maxPos: 5, dailyLosses: 5, maxLev: 50, maxNotional: 6000, demoEquity: 220, demoLoose: true, liveLoose: false, minRR: 1.5, plan: 'B', planIvs: ['1h'], minStopAtr: 1.5, tpR: 1, demoBoost: 3 };
// demoBoost（2026-10-17 使用者要在 Demo 試）：方案 B 的單如果順 4h＋跟 BTC 4h 同方向（回測勝率 58～62% 那組），Demo 每單風險放大這麼多倍；真錢不加碼
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
 *   槓桿＝最多 maxLev，而且強平距離（≈ 1/槓桿 − 維持保證金率，抓 1%）≥ 停損距離 × 1.3（停損一定比強平先打到，還留空間）
 *   ※ 2026-10-15 以前用「停損距離 × 槓桿 ≤ 0.8」，沒扣維持保證金，SOL 空單停損剛好落在強平價上；保證金＝名目價值 ÷ 槓桿
 *   保證金加上已經開著的單超過可用權益 95% 就不下
 */
/** 停損距離 stopDist（比例）下最多能開幾倍：強平距離（扣維持保證金率，抓 1%）≥ 停損距離 × 1.3 */
export function safeLev(stopDist, maxLev = 50) { return Math.max(1, Math.min(maxLev, Math.floor(1 / (stopDist * LIQ_X + MMR)))); }
const LIQ_X = 1.3, MMR = 0.01;
/** 強平價有沒有在停損外面而且留一點空間（至少再多停損距離的 15%），不夠就要降槓桿 */
export function liqSafe({ side, en, sl, liq }) {
  if (!(liq > 0)) return true;
  const gap = Math.abs(en - sl) * 0.15;
  return side === 'L' ? liq <= sl - gap : liq >= sl + gap;
}

export function sizeCoachOrder({ equity, en, sl, riskU = 20, maxLev = 50, maxNotional = 6000, usedMargin = 0 }) {
  if (!(equity > 0 && en > 0 && sl > 0 && en !== sl)) return { skip: '資料不足' };
  const stopDist = Math.abs(en - sl) / en;
  const notional = Math.min(riskU / stopDist, maxNotional);
  const lev = safeLev(stopDist, maxLev);
  const margin = notional / lev, qty = notional / en;
  if (usedMargin + margin > equity * 0.95) return { skip: `保證金不夠（要 ${margin.toFixed(0)}U，已用 ${usedMargin.toFixed(0)}U）`, margin };
  return { stopDist, lev, notional, qty, margin, riskU: qty * Math.abs(en - sl), riskPct: qty * Math.abs(en - sl) / equity };
}

/** runCoach 每根收盤找出來的「可以自動下單」的劇本 */
export function autoCandidate({ job, side, r, f, W, sessKz, atr, btc = 0 }) {
  const j = W.length - 1;
  if (r.stage < 4 || r.rt == null || !f.plan || f.status !== 'near') return null;
  if (!(f.plan.rr > 0)) return null;
  if (j - r.rt > 1) return null; // 回踩要是剛收盤的那一兩根，太久以前的不追
  return {
    id: `cc:${coin(job.sym)}:${job.iv}:${side}:${W[r.sweep.u].t}`.slice(0, 36), sym: job.sym, iv: job.iv, ms: job.ms, side,
    en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, rr: f.plan.rr, bias: r.bias, disc: r.disc, sessKz, rtT: W[r.rt].t,
    stopAtr: atr > 0 ? Math.round(Math.abs(f.plan.en - f.plan.sl) / atr * 100) / 100 : null,
    btc: btc ? btc * r.d : 0, // 1＝跟 BTC 4h 同方向、-1＝相反
  };
}

/** GET／POST /coach-auto（要 App 密碼） */
export async function handleCoachAuto(request, env, { executorCall } = {}) {
  const cfg = await loadAutoCfg(env);
  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return { status: 400, body: { error: '格式不對' } }; }
    const next = { ...cfg };
    if (b.mode !== undefined) { if (!['off', 'demo', 'live', 'both'].includes(b.mode)) return { status: 400, body: { error: 'mode 只能是 off／demo／live／both' } }; next.mode = b.mode; }
    for (const [k, lo, hi] of [['riskPct', 0.005, 0.2], ['maxPos', 1, 10], ['dailyLosses', 1, 20], ['minRR', 0, 5]]) if (b[k] !== undefined) next[k] = Math.max(lo, Math.min(hi, Number(b[k]) || cfg[k]));
    if (typeof b.liveLoose === 'boolean') next.liveLoose = b.liveLoose;
    if (typeof b.demoLoose === 'boolean') next.demoLoose = b.demoLoose;
    if (['B', 'legacy'].includes(b.plan)) next.plan = b.plan;
    if (b.demoBoost !== undefined) next.demoBoost = Math.max(1, Math.min(5, Number(b.demoBoost) || 1));
    if (typeof b.trendLive === 'boolean' || ['coach', 'market'].includes(b.trendEntry)) {
      const tc = await kvJson(env, TL_CFG_KEY, {});
      if (typeof b.trendLive === 'boolean') tc.enabled = b.trendLive;
      if (['coach', 'market'].includes(b.trendEntry)) tc.entry = b.trendEntry;
      if (env.SMC_KV) await env.SMC_KV.put(TL_CFG_KEY, JSON.stringify(tc));
    }
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
        positions: (st?.positions || []).map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice, leverage: p.leverage, liqPrice: p.liqPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit, coach: trades.some((t) => t.account === a && t.sym === p.symbol && t.state === 'open') })),
        orders: st?.orders || [],
        // Bybit 自己算的已平倉損益（最近 3 天，含手續費）：查帳用
        closedPnl: (st?.closedPnl || []).slice(0, 60).map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, pnl: p.closedPnl, entry: p.avgEntryPrice, exit: p.avgExitPrice, at: p.updatedTime })),
      };
    }
  }
  const first = Object.values(accounts)[0] || {};
  const trendLive = { cfg: await loadTrendLiveCfg(env), trades: (await kvJson(env, TL_TRADES_KEY, [])).slice(0, 100) };
  return { status: 200, body: { cfg, trades: trades.slice(0, 200), accounts, equity: first.equity ?? null, stateError: first.error || null, trendLive } };
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
            const tgt = t.tpS ?? t.tp;
            if (rows.some((k) => k.time + t.ms > t.placedAt && (t.side === 'L' ? +k.high >= tgt : +k.low <= tgt))) why = '沒回到進場點就先到目標';
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
    // open：強平價太靠近停損（或在停損裡面）→ 降槓桿／補保證金，每筆最多試 3 次
    const op = st.positions.find((p) => p.symbol === t.sym);
    if (op && !dry && (t.liqFix || 0) < 3 && !liqSafe({ side: t.side, en: op.avgPrice || t.en, sl: t.sl, liq: op.liqPrice })) {
      const px = op.avgPrice || t.en, dist = Math.abs(px - t.sl) / px, lev = safeLev(dist, cfg.maxLev);
      const notional = op.size * px, addMargin = Math.max(0, notional / lev - (op.positionIM || notional / (op.leverage || lev)));
      t.liqFix = (t.liqFix || 0) + 1; dirty = true;
      let r; try { r = await executorCall(env, 'POST', '/coach/leverage', { body: { account: t.account, symbol: t.sym, leverage: lev, addMargin: Math.round(addMargin * 100 + 50) / 100 } }); } catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok && !r.unchanged) { t.lev = r.leverage; t.margin = notional / r.leverage; await say(`🛟 ${tag}：強平價 ${fmtP(op.liqPrice)} 太靠近停損 ${fmtP(t.sl)}，槓桿 ${op.leverage}x → ${r.leverage}x${r.liqPrice ? `，強平價移到 ${fmtP(r.liqPrice)}` : ''}（${r.how === 'add-margin' ? `補了約 ${addMargin.toFixed(1)}U 保證金` : '交易所自動補保證金'}）`); }
      else if (!r.ok) { out.errors.push(`${t.id} 降槓桿失敗：${r.error}`); if (t.liqFix >= 3) await say(`⚠️ ${tag}：強平價 ${fmtP(op.liqPrice)} 在停損 ${fmtP(t.sl)} 附近，自動降槓桿失敗（${r.error}），請手動補保證金或降槓桿`); }
    }
    // open：持倉不見了＝停損或目標打到了（或使用者手動平倉）
    if (!op) {
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
      if (cfg.plan === 'B') {
        // 方案 B：只做 1h、停損至少 1.5 ATR（太近的容易被掃），止盈固定 1R
        if (!(cfg.planIvs || ['1h']).includes(c.iv)) continue;
        if (!(c.stopAtr >= (cfg.minStopAtr ?? 1.5))) continue;
      } else {
        // 寬鬆＝有訊號就進；嚴格＝只做順 4h＋≥2R。Demo 看 demoLoose、真錢看 liveLoose
        const strict = !(acct === 'demo' ? cfg.demoLoose : cfg.liveLoose);
        if (strict && (c.bias !== 2 || c.rr < 2)) continue;
        if (!strict && c.rr < (cfg.minRR ?? 0)) continue; // 寬鬆也不做盈虧比太低的（賠的比賺的多）
      }
      const live = trades.filter((t) => t.account === acct && (t.state === 'pending' || t.state === 'open'));
      if (live.length >= cfg.maxPos) { out.errors.push(`${ACCT_NAME[acct]}：已經 ${live.length} 筆，達上限`); break; }
      if (trades.some((t) => t.id === c.id && t.account === acct)) continue;
      if (live.some((t) => t.sym === c.sym)) continue;
      const st = await getState(acct);
      if (st.error || !st.configured || !(st.equity > 0)) { out.errors.push(`讀不到 ${ACCT_NAME[acct]} 帳戶：${st.error || Object.values(st.errors || {})[0] || '權益是 0'}`); break; }
      // 真錢帳戶還有超級趨勢的單一起吃保證金：已經開著的倉位用交易所的實際保證金，加上教練還沒成交的掛單
      const usedMargin = acct === 'live'
        ? (st.positions || []).reduce((a, p) => a + (p.positionIM || 0), 0) + live.filter((t) => t.state === 'pending').reduce((a, t) => a + (t.margin || 0), 0)
        : live.reduce((a, t) => a + (t.margin || 0), 0);
      const eq = acct === 'demo' ? Math.min(st.equity, cfg.demoEquity) : st.equity;
      const boost = cfg.plan === 'B' && acct === 'demo' && c.bias === 2 && c.btc === 1 ? (cfg.demoBoost || 1) : 1;
      const sz = sizeCoachOrder({ equity: eq, en: c.en, sl: c.sl, riskU: eq * (cfg.riskPct ?? 0.09) * boost, maxLev: cfg.maxLev, maxNotional: cfg.maxNotional, usedMargin });
      if (sz.skip) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${sz.skip}`); continue; }
      // 方案 B：交易所上的止盈掛 1R；結構目標只拿來判斷「還沒成交就先到目標」要取消
      const tpOrder = cfg.plan === 'B' ? c.en + (c.side === 'L' ? 1 : -1) * Math.abs(c.en - c.sl) * (cfg.tpR || 1) : c.tp;
      const body = { account: acct, symbol: c.sym, side: c.side === 'L' ? 'Buy' : 'Sell', qty: sz.qty, price: c.en, stopLoss: c.sl, takeProfit: tpOrder, leverage: sz.lev, orderLinkId: c.id };
      if (dry) { out.placed.push({ ...body, dry: true }); continue; }
      let r;
      try { r = await executorCall(env, 'POST', '/coach/order', { body }); } catch (e) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${e.message}`); continue; }
      if (!r.ok) { out.errors.push(`${ACCT_NAME[acct]} ${c.id}：${r.skipped || r.error}`); continue; }
      const t = {
        id: c.id, account: acct, sym: c.sym, iv: c.iv, ms: c.ms, side: c.side, en: r.price, sl: r.stopLoss ?? c.sl, tp: r.takeProfit ?? tpOrder, tpS: c.tp, plan: cfg.plan || 'legacy', stopAtr: c.stopAtr, boost, btc: c.btc, rr: Math.round(c.rr * 100) / 100,
        qty: r.qty, lev: r.leverage, riskU: r.qty * Math.abs(r.price - (r.stopLoss ?? c.sl)), riskPct: sz.riskPct, margin: r.qty * r.price / r.leverage, equity: st.equity, bias: c.bias, disc: c.disc, sessKz: c.sessKz,
        placedAt: now, validUntil: now + VALID_BARS * c.ms, state: 'pending',
      };
      trades.unshift(t); dirty = true; out.placed.push(accts.length > 1 ? `${acct}:${t.id}` : t.id);
      await say(`🤖 教練自動下單（${ACCT_NAME[acct]}）｜${coin(c.sym)} ${c.iv} ${c.side === 'L' ? '多單' : '空單'}：掛 ${fmtP(t.en)} 限價・停損 ${fmtP(t.sl)}・目標 ${fmtP(t.tp)}（${cfg.plan === 'B' ? `1R，方案 B・停損 ${c.stopAtr} ATR` : `${c.rr.toFixed(1)}R`}）・${t.lev}x・保證金 ${t.margin.toFixed(0)}U・1R＝${t.riskU.toFixed(2)}U${c.bias === 2 ? '・順勢' : c.bias === 0 ? '・逆勢' : ''}${boost > 1 ? `・🔥 順 4h＋跟 BTC 同向，加碼 ${boost} 倍` : ''}`);
    }
  }
  if (dirty && !dry) await env.SMC_KV.put(TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  if (cfgDirty && !dry) await env.SMC_KV.put(CFG_KEY, JSON.stringify(cfg));
  return out;
}

/**
 * 超級趨勢上真錢（2026-10-15 使用者要的）：6 個順勢策略照樣在 Demo 主帳戶跑，超級趨勢有訊號時「另外」在使用者的真錢帳戶下一張。
 *   每單風險＝真錢權益 × riskPct（使用者選 9%）、最多同時 maxOpen 張（使用者選 5 張），跟教練共用真錢帳戶、保證金一起算
 *   市價進場＋停損掛在 Bybit；不設止盈，之後照 Demo 一樣保本＋追蹤停損（EMA_CROSS_* 參數）
 *   槓桿用 safeLev，強平一定在停損外面；這個幣已經有倉位（教練的或使用者自己的）就不下
 *   App／開關流程可以關掉（trendlive:cfg enabled）
 */
const TL_CFG_KEY = 'trendlive:cfg';
const TL_TRADES_KEY = 'trendlive:trades';
export const TREND_LIVE_DEFAULT = { enabled: true, riskPct: 0.09, maxOpen: 5, strategies: ['st'], maxLev: 50, maxNotional: 6000, entry: 'coach', waitH: 24 };
const TL_NAME = { st: '超級趨勢', ema: 'EMA 交叉', macd: 'MACD 零軸', gc: '黃金交叉' };
export async function loadTrendLiveCfg(env) { return { ...TREND_LIVE_DEFAULT, ...(await kvJson(env, TL_CFG_KEY, {})) }; }

/**
 * 順勢策略有訊號時呼叫。回傳 null＝這個策略不上真錢
 *   entry='coach'（預設，2026-10-15 使用者要的「教練幫超級趨勢找進場點」）：先不進場，記成「等教練」，
 *     waitH 小時內 15m～1h 出現同方向的教練劇本剛回踩（離進場點 0.5R 內），才用教練的停損市價進場（fillTrendFromCoach）；等不到就放棄
 *   entry='market'：訊號一出來就市價進、停損 2 ATR（原本的做法）
 */
export async function placeTrendLive(env, sig, { interval, signalId, price, plan, management, executorCall, postDiscord, now = Date.now() }) {
  const cfg = await loadTrendLiveCfg(env);
  if (!cfg.enabled || !cfg.strategies.includes(sig.strategy) || !env.SMC_KV || !env.EXECUTOR_URL) return null;
  const trades = await kvJson(env, TL_TRADES_KEY, []);
  const tag = `💰 ${TL_NAME[sig.strategy] || sig.strategy}（真錢）｜${coin(sig.symbol)} ${interval} ${sig.dir === 'long' ? '多單' : '空單'}`;
  const say = (msg) => postDiscord(env, { content: msg }).catch(() => {});
  const id = ('ct:' + signalId).slice(0, 36);
  if (trades.some((t) => (t.state === 'open' || t.state === 'waiting') && t.sym === sig.symbol) || trades.some((t) => t.id === id)) return { skipped: '這個幣已經有單' };
  if (!plan || plan.skipped || plan.error || !(plan.risk > 0)) { await say(`${tag}：沒下（${plan?.error || plan?.skipped || '算不出停損'}）`); return { skipped: 'plan' }; }
  if (cfg.entry !== 'market') {
    const t = { id, sym: sig.symbol, strategy: sig.strategy, iv: interval, dir: sig.dir, state: 'waiting', createdAt: now, until: now + cfg.waitH * 3600e3, riskBase: plan.risk, signalPrice: price || plan.entry, management };
    trades.unshift(t);
    await env.SMC_KV.put(TL_TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
    await say(`${tag}：4h 超級趨勢翻${sig.dir === 'long' ? '多' : '空'}，先不追，等教練 ${cfg.waitH} 小時內在 15m～1h 找到${sig.dir === 'long' ? '多' : '空'}單劇本回踩再進場`);
    return { waiting: true, id };
  }
  return enterTrendLive(env, { trades, cfg, t: { id, sym: sig.symbol, strategy: sig.strategy, iv: interval, dir: sig.dir, riskBase: plan.risk, management }, en: plan.entry, sl: plan.stop, price, via: '訊號一出來', executorCall, postDiscord, now });
}

/** 真的下單：市價進場＋停損掛 Bybit，倉位大小照停損距離算（每單風險權益 riskPct） */
async function enterTrendLive(env, { trades, cfg, t: base, en, sl, price, via, executorCall, postDiscord, now }) {
  const tag = `💰 ${TL_NAME[base.strategy] || base.strategy}（真錢）｜${coin(base.sym)} ${base.iv} ${base.dir === 'long' ? '多單' : '空單'}`;
  const skip = async (why) => { await postDiscord(env, { content: `${tag}：沒下（${why}）` }).catch(() => {}); return { skipped: why }; };
  const open = trades.filter((x) => x.state === 'open');
  if (open.length >= cfg.maxOpen) return skip(`已經 ${open.length} 張，達上限 ${cfg.maxOpen}`);
  const st = await executorCall(env, 'GET', '/coach/state', { query: { account: 'live' } }).catch((e) => ({ error: e.message }));
  if (st.error || !st.configured || !(st.equity > 0)) return skip(`讀不到真錢帳戶：${st.error || '權益是 0'}`);
  if ((st.positions || []).some((p) => p.symbol === base.sym)) return skip('這個幣真錢帳戶已經有倉位');
  const ref = price || en, dist = Math.abs(ref - sl) / ref;
  if (!(dist > 0) || (base.dir === 'long' ? sl >= ref : sl <= ref)) return skip('停損在錯的一側');
  const riskU = st.equity * cfg.riskPct;
  const notional = Math.min(riskU / dist, cfg.maxNotional);
  const lev = safeLev(dist, cfg.maxLev);
  const margin = notional / lev;
  const usedMargin = (st.positions || []).reduce((a, p) => a + (p.positionIM || 0), 0);
  if (usedMargin + margin > st.equity * 0.95) return skip(`保證金不夠（要 ${margin.toFixed(0)}U，已用 ${usedMargin.toFixed(0)}U）`);
  const body = { account: 'live', symbol: base.sym, side: base.dir === 'long' ? 'Buy' : 'Sell', qty: notional / ref, stopLoss: sl, leverage: lev, orderLinkId: base.id, refPrice: ref };
  let r; try { r = await executorCall(env, 'POST', '/coach/market', { body }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) return skip(r.skipped || r.error);
  const fill = r.avgPrice || ref, stop = r.stopLoss || sl;
  const t = trades.find((x) => x.id === base.id) || (trades.unshift({ ...base }), trades[0]);
  Object.assign(t, {
    ...base, entry: fill, stop, initialStop: stop, qty: r.qty, lev: r.leverage, riskU: r.qty * Math.abs(fill - stop), margin: r.qty * fill / r.leverage,
    maxFavorableR: 0, beMoved: false, trailing: false, state: 'open', openedAt: now, equity: st.equity, via,
  });
  await env.SMC_KV.put(TL_TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  const m = base.management || {}, unitTxt = base.riskBase && Math.abs(base.riskBase - Math.abs(fill - stop)) / base.riskBase > 0.05 ? `（保本／追蹤照 4h 的 2 ATR＝${fmtP(base.riskBase)} 算）` : '';
  await postDiscord(env, { content: `${tag}：${via}，市價成交 ${fmtP(fill)}・停損 ${fmtP(stop)}・${t.lev}x・保證金 ${t.margin.toFixed(0)}U・1R＝${t.riskU.toFixed(2)}U${r.liqPrice ? `・強平 ${fmtP(r.liqPrice)}` : ''}（不設止盈，賺到 ${m.breakevenAtR ?? 1} 個 4h 停損距離保本、之後追蹤停損${unitTxt}）` }).catch(() => {});
  return { ok: true, id: t.id, qty: t.qty, lev: t.lev, riskU: t.riskU };
}

/** 現在在「等教練」的幣（runCoach 要多掃這些幣） */
export async function trendWaitingSyms(env, now = Date.now()) {
  return (await kvJson(env, TL_TRADES_KEY, [])).filter((t) => t.state === 'waiting' && t.until > now).map((t) => t.sym);
}

/**
 * 每次排程（runCoach 之後、教練自動下單之前）：「等教練」的超級趨勢單，有同方向的教練劇本剛回踩就用教練的停損進場；過期就放棄。
 * 教練自動下單在同一個幣有單（掛單或持倉）就先不進，下次再看。
 */
export async function fillTrendFromCoach(env, { candidates = [], executorCall, postDiscord, getPrices, now = Date.now() }) {
  if (!env.SMC_KV || !env.EXECUTOR_URL) return { skipped: 'no-executor' };
  const trades = await kvJson(env, TL_TRADES_KEY, []);
  const waiting = trades.filter((t) => t.state === 'waiting');
  if (!waiting.length) return { waiting: 0 };
  const cfg = await loadTrendLiveCfg(env);
  const coachTrades = await kvJson(env, TRADES_KEY, []);
  const out = { waiting: waiting.length, entered: [], expired: [] };
  let dirty = false;
  for (const t of waiting) {
    const tag = `💰 ${TL_NAME[t.strategy] || t.strategy}（真錢）｜${coin(t.sym)} ${t.iv} ${t.dir === 'long' ? '多單' : '空單'}`;
    if (now > t.until || !cfg.enabled) {
      Object.assign(t, { state: 'expired', closedAt: now }); dirty = true; out.expired.push(t.sym);
      await postDiscord(env, { content: `${tag}：${cfg.enabled ? `${cfg.waitH} 小時內教練沒有找到同方向的回踩，這次不進` : '超級趨勢真錢已關掉，不等了'}` }).catch(() => {});
      continue;
    }
    const side = t.dir === 'long' ? 'L' : 'S';
    const c = candidates.filter((x) => x.sym === t.sym && x.side === side).sort((a, b) => b.ms - a.ms)[0]; // 同時有好幾個週期就用大的
    if (!c) continue;
    if (coachTrades.some((x) => x.account === 'live' && x.sym === t.sym && (x.state === 'pending' || x.state === 'open'))) continue;
    const prices = await getPrices([t.sym]).catch(() => ({}));
    const r = await enterTrendLive(env, { trades, cfg, t, en: c.en, sl: c.sl, price: Number(prices[t.sym]) || c.en, via: `教練 ${c.iv} ${side === 'L' ? '多' : '空'}單劇本回踩`, executorCall, postDiscord, now });
    if (r.ok) out.entered.push(t.sym);
    else { Object.assign(t, { state: 'expired', closedAt: now, why: r.skipped }); dirty = true; }
  }
  if (dirty) await env.SMC_KV.put(TL_TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  return out;
}

/** 每次排程：真錢的順勢單平倉了沒（算 R）、要不要保本／追蹤停損 */
export async function manageTrendLive(env, { executorCall, postDiscord, getPrices, now = Date.now() }) {
  if (!env.SMC_KV || !env.EXECUTOR_URL) return { skipped: 'no-executor' };
  const trades = await kvJson(env, TL_TRADES_KEY, []);
  const open = trades.filter((t) => t.state === 'open');
  if (!open.length) return { open: 0 };
  const st = await executorCall(env, 'GET', '/coach/state', { query: { account: 'live' } }).catch((e) => ({ error: e.message }));
  if (st.error || !st.configured) return { error: st.error || '真錢帳戶沒設定' };
  const prices = await getPrices(open.map((t) => t.sym)).catch(() => ({}));
  let dirty = false, moved = 0, closed = 0;
  for (const t of open) {
    const tag = `💰 ${TL_NAME[t.strategy] || t.strategy}（真錢）｜${coin(t.sym)} ${t.iv} ${t.dir === 'long' ? '多' : '空'}`;
    const pos = (st.positions || []).find((p) => p.symbol === t.sym);
    if (!pos) {
      const pnl = (st.closedPnl || []).filter((p) => p.symbol === t.sym && p.updatedTime >= t.openedAt - 60e3).reduce((a, p) => a + p.closedPnl, 0);
      const r = t.riskU > 0 ? pnl / t.riskU : 0;
      Object.assign(t, { state: 'closed', closedAt: now, pnl: Math.round(pnl * 100) / 100, r: Math.round(r * 100) / 100 });
      await postDiscord(env, { content: `${r >= 0 ? '✅' : '⛔'} ${tag}：平倉 ${r >= 0 ? '+' : ''}${r.toFixed(2)}R（${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}U）` }).catch(() => {});
      dirty = true; closed++;
      continue;
    }
    const px = Number(prices[t.sym]);
    const m = t.management || {};
    // 教練找進場點的單：停損是教練的（比較近），保本／追蹤還是照 4h 超級趨勢的停損距離（riskBase）算，才抱得住趨勢
    const risk = t.riskBase || Math.abs(t.entry - t.initialStop);
    if (!(px > 0) || !(risk > 0)) continue;
    const long = t.dir === 'long';
    const fav = (long ? px - t.entry : t.entry - px) / risk;
    if (fav > (t.maxFavorableR || 0)) { t.maxFavorableR = fav; dirty = true; }
    let next = t.stop;
    if (!t.beMoved && m.breakevenAtR > 0 && t.maxFavorableR >= m.breakevenAtR) {
      const be = long ? t.entry + risk * (m.breakevenOffsetR || 0) : t.entry - risk * (m.breakevenOffsetR || 0);
      if (long ? be > next : be < next) next = be;
    }
    if (m.trailFromR > 0 && t.maxFavorableR >= m.trailFromR) {
      const lockR = t.maxFavorableR - (m.trailGapR || 0);
      const tp = long ? t.entry + risk * lockR : t.entry - risk * lockR;
      if (long ? tp > next : tp < next) next = tp;
    }
    if (next !== t.stop) {
      const r = await executorCall(env, 'POST', '/coach/set-stop', { body: { account: 'live', symbol: t.sym, stopLoss: next } }).catch((e) => ({ ok: false, error: e.message }));
      if (r.ok) {
        const first = !t.beMoved;
        t.stop = r.stopLoss || next; t.beMoved = true; t.trailing = t.maxFavorableR >= (m.trailFromR || Infinity); dirty = true; moved++;
        if (first) await postDiscord(env, { content: `🔒 ${tag}：賺到 ${(t.maxFavorableR * risk / Math.abs(t.entry - t.initialStop)).toFixed(1)}R，停損移到 ${fmtP(t.stop)}（保本）` }).catch(() => {});
      }
    }
  }
  if (dirty) await env.SMC_KV.put(TL_TRADES_KEY, JSON.stringify(trades.slice(0, TRADES_MAX)));
  return { open: open.length - closed, moved, closed };
}
