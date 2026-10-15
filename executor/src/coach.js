/**
 * SMC 教練自動下單（2026-10-15 使用者要的）：Worker 判斷劇本到位、算好數量和槓桿，這裡只負責「照著掛單／取消／回報狀態」。
 *
 * 兩個帳戶，跟原本 6 個順勢策略用的主帳戶分開：
 *   demo  COACH_DEMO_API_KEY／SECRET（api-demo.bybit.com）；沒設的話，主帳戶是 Demo 就用主帳戶
 *   live  COACH_LIVE_API_KEY／SECRET（api.bybit.com，使用者自己的真實帳戶）；沒設的話，主帳戶是真錢才用主帳戶
 *
 * 安全規則（伺服器端再檢查一次，不完全相信 Worker）：
 *   - 只碰 orderLinkId 以 cc: 開頭的單；取消也只取消 cc: 的單
 *   - 停損、目標一定要在正確的一側，而且跟進場單一起掛在 Bybit（App／Worker 斷線也有停損）
 *   - 名目價值上限 COACH_MAX_NOTIONAL（預設 6500U）、槓桿上限 100 倍或合約上限
 *   - 這個幣已經有持倉，或有不是 cc: 的掛單（使用者自己的單），就不下，避免跟手動單混在一起
 *   - 緊急停止觸發時一律拒絕
 */
import { config } from './config.js';
import { bybitCall, decimalsOf } from './bybit.js';
import { emergencyState } from './healthcheck.js';
import { logger } from './logger.js';

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

export function coachAccount(kind) {
  const env = process.env;
  if (kind === 'live') {
    if (env.COACH_LIVE_API_KEY && env.COACH_LIVE_API_SECRET) return { kind, host: 'https://api.bybit.com', key: env.COACH_LIVE_API_KEY.trim(), secret: env.COACH_LIVE_API_SECRET.trim(), trade: true };
    if (config.liveTrading) return { kind, host: config.bybitHost, key: config.bybitApiKey, secret: config.bybitApiSecret, trade: true };
    return null;
  }
  if (kind === 'demo') {
    if (env.COACH_DEMO_API_KEY && env.COACH_DEMO_API_SECRET) return { kind, host: 'https://api-demo.bybit.com', key: env.COACH_DEMO_API_KEY.trim(), secret: env.COACH_DEMO_API_SECRET.trim(), trade: true };
    if (!config.liveTrading) return { kind, host: config.bybitHost, key: config.bybitApiKey, secret: config.bybitApiSecret, trade: true };
    return null;
  }
  return null;
}
const maxNotional = () => Number(process.env.COACH_MAX_NOTIONAL || 6500);
const call = (acct, method, path, params, retries = 1) => bybitCall(method, path, params, { retries, acct });

function roundDown(v, step) { const d = decimalsOf(step); return Number((Math.floor(v / step + 1e-9) * step).toFixed(d)); }
function roundTick(v, tick) { const d = decimalsOf(tick); return Number((Math.round(v / tick) * tick).toFixed(d)); }

/** POST /coach/order —— 限價進場＋停損＋目標一次掛上 */
export async function handleCoachOrder(req, res, b) {
  const st = emergencyState();
  if (st.tripped) return json(res, 503, { error: `緊急停止中：${st.reason}` });
  const acct = coachAccount(b.account);
  if (!acct) return json(res, 400, { error: `${b.account === 'live' ? '真錢' : 'Demo'}帳戶沒有設定金鑰` });
  const symbol = String(b.symbol || ''), side = b.side, link = String(b.orderLinkId || '');
  let qty = Number(b.qty), price = Number(b.price), sl = Number(b.stopLoss), tp = Number(b.takeProfit), lev = Math.round(Number(b.leverage));
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !['Buy', 'Sell'].includes(side) || !link.startsWith('cc:') || link.length > 36) return json(res, 400, { error: '參數不對（symbol／side／orderLinkId）' });
  if (!(qty > 0 && price > 0 && sl > 0 && tp > 0 && lev >= 1)) return json(res, 400, { error: '數量／價格／停損／目標／槓桿不對' });
  const d = side === 'Buy' ? 1 : -1;
  if (!(d * (price - sl) > 0 && d * (tp - price) > 0)) return json(res, 400, { error: '停損或目標在錯的一側' });
  try {
    const info = (await call(acct, 'GET', '/v5/market/instruments-info', { category: 'linear', symbol }))?.list?.[0];
    if (!info) return json(res, 400, { error: `找不到合約 ${symbol}` });
    const step = Number(info.lotSizeFilter?.qtyStep), minQty = Number(info.lotSizeFilter?.minOrderQty), tick = Number(info.priceFilter?.tickSize), maxLev = Number(info.leverageFilter?.maxLeverage || 25);
    qty = roundDown(qty, step); price = roundTick(price, tick); sl = roundTick(sl, tick); tp = roundTick(tp, tick);
    lev = Math.max(1, Math.min(lev, maxLev, 100));
    if (qty < minQty) return json(res, 200, { ok: false, skipped: 'qty-too-small', minQty, qty });
    if (qty * price > maxNotional()) return json(res, 400, { error: `名目價值 ${(qty * price).toFixed(0)}U 超過上限 ${maxNotional()}U` });
    // 使用者自己的持倉或掛單在這個幣上，就不要混進去
    const pos = ((await call(acct, 'GET', '/v5/position/list', { category: 'linear', symbol }))?.list ?? []).filter((p) => Number(p.size) > 0);
    if (pos.length) return json(res, 200, { ok: false, skipped: 'symbol-has-position' });
    const open = (await call(acct, 'GET', '/v5/order/realtime', { category: 'linear', symbol }))?.list ?? [];
    if (open.some((o) => !String(o.orderLinkId || '').startsWith('cc:'))) return json(res, 200, { ok: false, skipped: 'symbol-has-manual-orders' });
    if (open.some((o) => o.orderLinkId === link)) return json(res, 200, { ok: true, duplicate: true, qty, price, leverage: lev });
    await call(acct, 'POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev) }).catch((e) => { if (e.code !== 110043) throw e; });
    const params = {
      category: 'linear', symbol, side, orderType: 'Limit', qty: String(qty), price: String(price), timeInForce: 'GTC', orderLinkId: link,
      takeProfit: String(tp), stopLoss: String(sl), tpslMode: 'Full', tpOrderType: 'Market', slOrderType: 'Market', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice',
    };
    let r;
    try { r = await call(acct, 'POST', '/v5/order/create', { ...params, positionIdx: 0 }, 0); } catch (e) {
      if (e.code === 10001 && /position idx/i.test(e.message)) r = await call(acct, 'POST', '/v5/order/create', { ...params, positionIdx: d > 0 ? 1 : 2 }, 0); // 雙向持倉模式
      else if (e.code === 110072) return json(res, 200, { ok: true, duplicate: true, qty, price, leverage: lev }); // 同一個 orderLinkId 已經送過
      else throw e;
    }
    logger.info('教練掛單', { account: acct.kind, symbol, side, qty, price, sl, tp, lev, link });
    return json(res, 200, { ok: true, orderId: r?.orderId, qty, price, stopLoss: sl, takeProfit: tp, leverage: lev });
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message, code: e.code });
  }
}

/**
 * POST /coach/leverage —— 已經開著的教練倉位「降槓桿」，把強平價推到停損外面（停損要比強平先打到）
 * 先試 set-leverage（逐倉會自動補保證金）；交易所不讓改的話，逐倉就直接追加保證金 addMargin。只能往低改。
 */
export async function handleCoachLeverage(req, res, b) {
  const acct = coachAccount(b.account);
  if (!acct) return json(res, 400, { error: '帳戶沒有設定金鑰' });
  const symbol = String(b.symbol || ''), lev = Math.round(Number(b.leverage)), add = Number(b.addMargin) || 0;
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !(lev >= 1)) return json(res, 400, { error: '參數不對' });
  try {
    const pos = ((await call(acct, 'GET', '/v5/position/list', { category: 'linear', symbol }))?.list ?? []).find((p) => Number(p.size) > 0);
    if (!pos) return json(res, 200, { ok: false, error: '沒有持倉' });
    if (lev >= Number(pos.leverage)) return json(res, 200, { ok: true, unchanged: true, leverage: Number(pos.leverage), liqPrice: Number(pos.liqPrice) || null });
    let how = 'set-leverage', err1 = null;
    try {
      await call(acct, 'POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev) }, 0);
    } catch (e) {
      err1 = e.message;
      if (!(add > 0 && add < 500)) throw e;
      await call(acct, 'POST', '/v5/position/add-margin', { category: 'linear', symbol, margin: add.toFixed(2), positionIdx: Number(pos.positionIdx) || 0 }, 0);
      how = 'add-margin';
    }
    const after = ((await call(acct, 'GET', '/v5/position/list', { category: 'linear', symbol }))?.list ?? []).find((p) => Number(p.size) > 0);
    logger.info('教練倉位降槓桿', { account: acct.kind, symbol, lev, how, err1 });
    return json(res, 200, { ok: true, how, leverage: Number(after?.leverage) || lev, liqPrice: Number(after?.liqPrice) || null, firstError: err1 });
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message, code: e.code });
  }
}

/** POST /coach/cancel —— 只取消 cc: 開頭的單 */
export async function handleCoachCancel(req, res, b) {
  const acct = coachAccount(b.account);
  if (!acct) return json(res, 400, { error: '帳戶沒有設定金鑰' });
  const link = String(b.orderLinkId || '');
  if (!link.startsWith('cc:') || !/^[A-Z0-9]{2,20}USDT$/.test(String(b.symbol || ''))) return json(res, 400, { error: '只能取消 cc: 開頭的教練單' });
  try {
    await call(acct, 'POST', '/v5/order/cancel', { category: 'linear', symbol: b.symbol, orderLinkId: link }, 0);
    return json(res, 200, { ok: true });
  } catch (e) {
    if (e.code === 110001) return json(res, 200, { ok: true, gone: true }); // 單已經不在（成交或取消了）
    return json(res, 200, { ok: false, error: e.message, code: e.code });
  }
}

/** GET /coach/state?account= —— 權益、持倉、cc: 掛單、最近的 cc: 訂單歷史、最近 3 天已平倉損益 */
export async function handleCoachState(req, res, q) {
  const acct = coachAccount(q.account);
  if (!acct) return json(res, 200, { configured: false, error: `${q.account === 'live' ? '真錢' : 'Demo'}帳戶沒有設定金鑰` });
  const out = { configured: true, account: acct.kind, equity: null, positions: [], orders: [], history: [], closedPnl: [], errors: {} };
  const tryDo = async (k, fn) => { try { await fn(); } catch (e) { out.errors[k] = e.message; } };
  await tryDo('equity', async () => { const w = await call(acct, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }); out.equity = Number(w?.list?.[0]?.totalEquity ?? w?.list?.[0]?.totalWalletBalance ?? 0); });
  await tryDo('positions', async () => {
    out.positions = ((await call(acct, 'GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }))?.list ?? []).filter((p) => Number(p.size) > 0)
      .map((p) => ({ symbol: p.symbol, side: p.side, size: Number(p.size), avgPrice: Number(p.avgPrice), leverage: Number(p.leverage), liqPrice: Number(p.liqPrice) || null, positionIM: Number(p.positionIM) || null, tradeMode: Number(p.tradeMode), stopLoss: Number(p.stopLoss) || null, takeProfit: Number(p.takeProfit) || null, unrealisedPnl: Number(p.unrealisedPnl), updatedTime: Number(p.updatedTime) }));
  });
  await tryDo('orders', async () => {
    out.orders = ((await call(acct, 'GET', '/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: '50' }))?.list ?? [])
      .filter((o) => String(o.orderLinkId || '').startsWith('cc:')).map((o) => ({ orderLinkId: o.orderLinkId, symbol: o.symbol, side: o.side, price: Number(o.price), qty: Number(o.qty), cumExecQty: Number(o.cumExecQty), orderStatus: o.orderStatus }));
  });
  await tryDo('history', async () => {
    out.history = ((await call(acct, 'GET', '/v5/order/history', { category: 'linear', limit: '50' }))?.list ?? [])
      .filter((o) => String(o.orderLinkId || '').startsWith('cc:')).map((o) => ({ orderLinkId: o.orderLinkId, symbol: o.symbol, orderStatus: o.orderStatus, avgPrice: Number(o.avgPrice) || null, cumExecQty: Number(o.cumExecQty), updatedTime: Number(o.updatedTime) }));
  });
  await tryDo('closedPnl', async () => {
    const now = Date.now();
    out.closedPnl = ((await call(acct, 'GET', '/v5/position/closed-pnl', { category: 'linear', startTime: String(now - 3 * 86400e3), endTime: String(now), limit: '100' }))?.list ?? [])
      .map((p) => ({ symbol: p.symbol, side: p.side, qty: Number(p.qty), closedPnl: Number(p.closedPnl), avgEntryPrice: Number(p.avgEntryPrice), avgExitPrice: Number(p.avgExitPrice), createdTime: Number(p.createdTime), updatedTime: Number(p.updatedTime) }));
  });
  return json(res, 200, out);
}
