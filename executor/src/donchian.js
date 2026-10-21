/**
 * 唐奇安通道組合（2026-10-21 使用者選上 Demo 試跑）的調倉端點。只做多、每天收盤後 Worker 算好目標數量叫這裡調。
 *
 * POST /dc/adjust { symbol, targetQty, expectQty, refPrice, stopLoss?, leverage?, orderLinkId: 'dc:…' }
 *   - 只在 Demo 跑：Executor 接真錢帳戶時一律不動（skipped: 'live-account'）
 *   - 先核對交易所上這個幣的部位＝Worker 記的唐奇安數量（expectQty）；對不上代表有別的單（其他策略或手動）
 *     佔著這個幣，不碰（skipped: 'occupied'），避免單向持倉模式下跟別人的部位混在一起
 *   - 目標比現在多就市價買、少就 reduce-only 市價賣；目標四捨五入到交易所的數量單位，低於最小數量／最小名目價值（通常 5U）當 0（全平）
 *   - 還有部位就把整個部位的停損設成 stopLoss（災難停損；正常出場是 Worker 每天收盤判斷）
 */

import { config } from './config.js';
import { bybitCall, decimalsOf, getInstrument, getPositions, setLeverage, setStopLoss } from './bybit.js';
import { emergencyState } from './healthcheck.js';
import { logger } from './logger.js';

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const maxNotional = () => Number(process.env.DC_MAX_NOTIONAL || 3000);
function roundNear(v, step) { const d = decimalsOf(step); return Number((Math.round(v / step) * step).toFixed(d)); }
function roundTick(v, tick) { const d = decimalsOf(tick); return Number((Math.round(v / tick) * tick).toFixed(d)); }

export async function handleDcAdjust(req, res, b) {
  if (config.liveTrading) return json(res, 200, { ok: false, skipped: 'live-account' });
  const st = emergencyState();
  if (st.tripped) return json(res, 503, { error: `緊急停止中：${st.reason}` });
  const symbol = String(b.symbol || ''), link = String(b.orderLinkId || '');
  const want = Number(b.targetQty), expect = Number(b.expectQty ?? 0), ref = Number(b.refPrice);
  const sl = Number(b.stopLoss || 0), lev = Math.round(Number(b.leverage || 10));
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !/^dc:[A-Za-z0-9:._-]{1,33}$/.test(link)) return json(res, 400, { error: '參數不對（symbol／orderLinkId）' });
  if (!(want >= 0) || !(expect >= 0) || !(ref > 0) || !(lev >= 1)) return json(res, 400, { error: '數量／參考價／槓桿不對' });
  if (sl && !(sl < ref)) return json(res, 400, { error: '停損要在現價下面' });
  try {
    const { qtyStep, minQty, tickSize, maxLeverage, minNotional } = await getInstrument(symbol);
    const before = await getPositions(symbol);
    if (before.some((p) => p.side === 'Sell')) return json(res, 200, { ok: false, skipped: 'occupied', reason: '這個幣有空單' });
    const cur = Number(before.find((p) => p.side === 'Buy')?.size || 0);
    if (Math.abs(cur - expect) > qtyStep / 2) return json(res, 200, { ok: false, skipped: 'occupied', current: cur, expect });
    // 四捨五入到最接近的單位（無條件捨去會讓小倉位系統性偏小）；低於最小數量或最小名目價值就當 0
    let target = roundNear(want, qtyStep);
    if (target < minQty || target * ref < minNotional) target = 0;
    if (target * ref > maxNotional()) return json(res, 400, { error: `名目價值 ${(target * ref).toFixed(0)}U 超過上限 ${maxNotional()}U` });
    const diff = Number((target - cur).toFixed(decimalsOf(qtyStep)));
    let order = null, side = null;
    try {
      if (diff > 0 && diff >= minQty && diff * ref >= minNotional) {
        side = 'Buy';
        await setLeverage(symbol, Math.max(1, Math.min(lev, maxLeverage)));
        order = await bybitCall('POST', '/v5/order/create', { category: 'linear', symbol, side, orderType: 'Market', qty: String(diff), timeInForce: 'IOC', orderLinkId: link });
      } else if (diff < 0 && (target === 0 || (-diff >= minQty && -diff * ref >= minNotional))) {
        side = 'Sell';
        order = await bybitCall('POST', '/v5/order/create', { category: 'linear', symbol, side, orderType: 'Market', qty: String(-diff), timeInForce: 'IOC', reduceOnly: true, orderLinkId: link });
      }
    } catch (e) {
      if (e.code === 110072) return json(res, 200, { ok: false, skipped: 'duplicate' }); // 同一個 orderLinkId 已經下過
      throw e;
    }
    const after = (await getPositions(symbol)).find((p) => p.side === 'Buy');
    const size = Number(after?.size || 0);
    let stopLoss = null, stopError = null;
    if (size > 0 && sl > 0) {
      stopLoss = roundTick(sl, tickSize);
      await setStopLoss(symbol, stopLoss).catch((e) => { stopError = e.message; logger.warn('唐奇安災難停損設定失敗', { symbol, stopLoss, error: e.message }); });
    }
    if (order) logger.info('唐奇安調倉', { symbol, side, qty: Math.abs(diff), before: cur, after: size, link });
    return json(res, 200, {
      ok: true, before: cur, after: size, ordered: order ? diff : 0, orderId: order?.orderId ?? null,
      avgPrice: Number(after?.avgPrice) || null, stopLoss, stopError, minQty, qtyStep,
    });
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message, code: e.code });
  }
}
