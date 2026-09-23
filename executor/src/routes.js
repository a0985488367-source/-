import { logger } from './logger.js';
import { alertDiscord } from './discord.js';
import { idempotencyStore } from './idempotency.js';
import { emergencyState, setEmergencyStop, runHealthCheck } from './healthcheck.js';
import { config } from './config.js';
import {
  getBalance, getInstrument, getPositions, setLeverage, setStopLoss,
  cancelAllOrders, placeReduceOnlyLimit, placeMarketEntry, bybitCall,
} from './bybit.js';

const json = (res, status, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

/** 交易／改單路由開頭都要先過這關——緊急停止觸發時，不管 Worker 有沒有發現，直接拒絕 */
function requireHealthy(res) {
  const state = emergencyState();
  if (state.tripped) {
    json(res, 503, { error: `Executor 目前處於緊急停止狀態，拒絕任何交易：${state.reason}` });
    return false;
  }
  return true;
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  return missing.length ? `缺少欄位：${missing.join('、')}` : null;
}

/**
 * POST /trade —— 開一筆新倉位（市價進場 + 停損 + 分批出場階梯）。
 * Worker 那邊已經算好 qty／leverage／每一段出場單的價格跟數量（沿用
 * src/smc/manage.js 的 buildLadder，跟原本 Worker 直接呼叫 Bybit 時的
 * 邏輯完全一樣，只是現在改成把算好的結果送過來執行），這裡只負責
 * 「照著做」，不重新計算風控——策略判斷留在 Worker，這裡只管執行跟
 * 冪等／安全機制，避免 Executor 變成第二套（可能跟 Worker 不同步的）
 * 策略邏輯。
 *
 * body: {
 *   signal_id, symbol, side ('Buy'|'Sell'), qty, leverage, stop_loss,
 *   ladder: [{ name, price, qty }, ...]
 * }
 */
export async function handleTrade(req, res, body) {
  const missing = requireFields(body, ['signal_id', 'symbol', 'side', 'qty', 'leverage', 'stop_loss']);
  if (missing) return json(res, 400, { error: missing });

  const { signal_id: signalId, symbol, side, qty, leverage, stop_loss: stopLoss, ladder = [] } = body;

  if (idempotencyStore.has(signalId)) {
    logger.info('signal_id 已經處理過，直接回傳原本的結果，不會重複下單', { signalId });
    return json(res, 200, { ...idempotencyStore.get(signalId), idempotent: true });
  }

  if (!requireHealthy(res)) return;

  try {
    await setLeverage(symbol, leverage);

    const order = await placeMarketEntry({ symbol, side, qty, stopLoss, orderLinkId: signalId });

    // 保險：進場單本身雖然帶了 stopLoss，但實測發生過部位開出來卻完全
    // 沒停損的情況，再明確設定一次，失敗不影響主流程。
    await setStopLoss(symbol, stopLoss).catch((e) => logger.warn('開倉後再次明確設定停損失敗（不影響主流程）', { symbol, error: e.message }));

    const legResults = [];
    for (let i = 0; i < ladder.length; i++) {
      const leg = ladder[i];
      try {
        const legOrder = await placeReduceOnlyLimit({
          symbol, side: side === 'Buy' ? 'Sell' : 'Buy', qty: leg.qty, price: leg.price,
          orderLinkId: `${signalId}:leg:${i}`,
        });
        legResults.push({ name: leg.name, price: leg.price, qty: leg.qty, orderId: legOrder?.orderId });
      } catch (e) {
        legResults.push({ name: leg.name, price: leg.price, qty: leg.qty, error: e.message });
      }
    }

    const result = { orderId: order?.orderId, orderLinkId: signalId, qty, leverage, ladder: legResults };
    idempotencyStore.set(signalId, result);
    logger.info('下單完成', { signalId, symbol, side, qty, orderId: order?.orderId });
    return json(res, 200, result);
  } catch (e) {
    const result = { error: e.message };
    // 錯誤也要記進 idempotency store：同一個 signal_id 不該因為 Worker
    // 重送同一個請求就再試一次（可能是保證金不足這種重試也沒用的錯誤，
    // 也可能是進場單真的沒下成——不管哪種，同一個 signal_id 的決策只
    // 執行一次，之後有新訊號會有新的 signal_id）。
    idempotencyStore.set(signalId, result);
    logger.error('下單失敗', { signalId, symbol, error: e.message });
    return json(res, 200, result); // 200：這是「有結果、結果是失敗」，不是 HTTP 層級的錯誤
  }
}

/** POST /add-exit-leg —— 補掛單一段分批出場限價單（Worker 的 ladder 修補邏輯用） */
export async function handleAddExitLeg(req, res, body) {
  const missing = requireFields(body, ['symbol', 'side', 'qty', 'price']);
  if (missing) return json(res, 400, { error: missing });
  if (!requireHealthy(res)) return;

  try {
    const order = await placeReduceOnlyLimit(body);
    return json(res, 200, { orderId: order?.orderId });
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** POST /set-stop —— 搬動已開倉部位的停損（保本鏢／追蹤停損用） */
export async function handleSetStop(req, res, body) {
  const missing = requireFields(body, ['symbol', 'stop_loss']);
  if (missing) return json(res, 400, { error: missing });
  if (!requireHealthy(res)) return;

  try {
    await setStopLoss(body.symbol, body.stop_loss);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** POST /cancel-all —— 取消某個 symbol 還沒成交的所有委託（平倉後清理殘留的分批出場單用） */
export async function handleCancelAll(req, res, body) {
  const missing = requireFields(body, ['symbol']);
  if (missing) return json(res, 400, { error: missing });
  if (!requireHealthy(res)) return;

  try {
    await cancelAllOrders(body.symbol);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/**
 * POST /close —— 直接用市價把某個 symbol 現在的持倉全部平掉（不是
 * 「劇本正常出場」，是給緊急情況／人工介入用：例如發現部位設定錯誤、
 * 或想立刻停損停利出場）。會先取消所有還沒成交的委託，避免平倉後
 * 殘留的 reduce-only 限價單又意外成交。
 */
export async function handleClose(req, res, body) {
  const missing = requireFields(body, ['symbol']);
  if (missing) return json(res, 400, { error: missing });
  if (!requireHealthy(res)) return;

  try {
    const positions = await getPositions(body.symbol);
    if (!positions.length) return json(res, 200, { ok: true, note: '目前沒有這個 symbol 的持倉，不用平' });

    await cancelAllOrders(body.symbol).catch(() => {});
    const closed = [];
    for (const pos of positions) {
      const order = await bybitCall('POST', '/v5/order/create', {
        category: 'linear', symbol: body.symbol,
        side: pos.side === 'Buy' ? 'Sell' : 'Buy',
        orderType: 'Market', qty: pos.size, reduceOnly: true, timeInForce: 'IOC',
      });
      closed.push({ side: pos.side, qty: pos.size, orderId: order?.orderId });
    }
    await alertDiscord(`⚠️ **手動平倉**：${body.symbol} 已用市價全部平掉（${closed.map((c) => `${c.side} ${c.qty}`).join('、')}）`);
    return json(res, 200, { ok: true, closed });
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** GET /position —— 查目前實際持倉（Worker 拿來比對追蹤中的部位是不是已經平倉了） */
export async function handlePosition(req, res, query) {
  try {
    const positions = await getPositions(query.symbol || undefined);
    return json(res, 200, {
      positions: positions.map((p) => ({
        symbol: p.symbol, side: p.side, size: Number(p.size),
        avgPrice: Number(p.avgPrice), unrealisedPnl: Number(p.unrealisedPnl ?? 0),
      })),
    });
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** GET /balance */
export async function handleBalance(req, res) {
  try {
    return json(res, 200, await getBalance());
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** GET /instrument?symbol=X —— Worker 算部位大小／出場階梯需要的合約規格（沒有列在原本規劃裡，是必要的補充端點） */
export async function handleInstrument(req, res, query) {
  const missing = requireFields(query, ['symbol']);
  if (missing) return json(res, 400, { error: missing });
  try {
    return json(res, 200, await getInstrument(query.symbol));
  } catch (e) {
    return json(res, 200, { error: e.message });
  }
}

/** GET /health —— 不需要驗證，給存活監控用；不會洩漏金鑰，只回報連線狀態 */
export async function handleHealth(req, res) {
  const state = emergencyState();
  return json(res, 200, {
    ok: !state.tripped,
    liveTrading: config.liveTrading,
    emergencyStop: state.tripped,
    reason: state.reason,
    lastCheckedAt: state.lastCheckedAt,
    publicIp: state.publicIp,
  });
}

/** POST /emergency-stop —— 手動觸發／解除緊急停止；body: { tripped: true|false, reason? } */
export async function handleEmergencyStop(req, res, body) {
  if (typeof body.tripped !== 'boolean') return json(res, 400, { error: '需要 boolean 欄位 tripped' });
  setEmergencyStop(body.tripped, body.reason || '手動觸發');
  await alertDiscord(body.tripped ? `🛑 **手動觸發緊急停止**：${body.reason || '（沒有附原因）'}` : '✅ **手動解除緊急停止**');
  if (!body.tripped) await runHealthCheck({ announceRecovery: false }).catch(() => {});
  return json(res, 200, emergencyState());
}
