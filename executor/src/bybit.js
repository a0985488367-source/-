import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

/** 跟 worker/index.js 的 bybitHmac 同一套規則：HMAC_SHA256(ts + apiKey + recvWindow + payload) */
function sign(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * retries 預設 0（不重試）：非冪等操作（尤其市價進場單）絕對不能重試，
 * 網路逾時不代表 Bybit 沒收到，可能只是回應沒送達，重試有把同一張單
 * 重複送出兩次的風險。只有明確知道這次呼叫是冪等的（查餘額、查合約
 * 資訊、查持倉、設槓桿、設停損、reduce-only 限價單）才傳 retries > 0。
 *
 * 可重試的失敗只挑「明確知道請求根本沒被處理」的情況：網路層失敗、
 * HTTP 5xx、429（限流）、403——同一套判斷跟 worker/index.js 的
 * bybitCall 一致（403 併入可重試：Bybit 對某些地區/IP 觸發限流保護時
 * 不是每次都乖乖回 429，實測過連續回 403）。403 如果重試用盡還是失敗，
 * 呼叫端要自己判斷這是不是「connectivity / region failure」而不是
 * 「這筆請求本身有問題」——見 healthcheck.js。
 */
export async function bybitCall(method, path, params = {}, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ts = String(Date.now());
    const recvWindow = '10000';
    let url = config.bybitHost + path;
    let body;
    let payload;
    if (method === 'GET') {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      ).toString();
      payload = qs;
      if (qs) url += `?${qs}`;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }

    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), config.bybitTimeoutSec * 1000);
    try {
      const res = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': config.bybitApiKey,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': sign(config.bybitApiSecret, ts + config.bybitApiKey + recvWindow + payload),
        },
        body,
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        }
        const bodyText = await res.text().catch(() => '');
        const err = new Error(`Bybit HTTP ${res.status}${bodyText ? `：${bodyText.slice(0, 300)}` : ''}`);
        err.httpStatus = res.status;
        throw err;
      }
      const j = await res.json();
      if (j.retCode !== 0) {
        if (j.retCode === 10006 && attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
        const err = new Error(`Bybit [${j.retCode}] ${j.retMsg || '請求失敗'}`);
        err.code = j.retCode;
        throw err;
      }
      return j.result;
    } catch (e) {
      if (e instanceof Error && (/^Bybit \[/.test(e.message) || /^Bybit HTTP/.test(e.message))) throw e;
      if (attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
      if (e.name === 'AbortError') throw new Error(`Bybit 請求逾時（超過 ${config.bybitTimeoutSec} 秒）`);
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

export function roundTick(value, tick) {
  if (!(tick > 0)) return value;
  return Number((Math.round(value / tick) * tick).toFixed(decimalsOf(tick)));
}

export async function getBalance() {
  const w = await bybitCall('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, { retries: 1 });
  return {
    totalAvailableBalance: Number(w?.list?.[0]?.totalAvailableBalance ?? 0),
    totalWalletBalance: Number(w?.list?.[0]?.totalWalletBalance ?? 0),
  };
}

export async function getInstrument(symbol) {
  const r = await bybitCall('GET', '/v5/market/instruments-info', { category: 'linear', symbol }, { retries: 1 });
  const it = r?.list?.[0];
  if (!it) throw new Error(`找不到合約 ${symbol}`);
  return {
    qtyStep: Number(it.lotSizeFilter?.qtyStep ?? 0.001),
    minQty: Number(it.lotSizeFilter?.minOrderQty ?? 0),
    tickSize: Number(it.priceFilter?.tickSize ?? 0.01),
    maxLeverage: Number(it.leverageFilter?.maxLeverage ?? 10),
  };
}

export async function getPositions(symbol) {
  const r = await bybitCall(
    'GET', '/v5/position/list',
    symbol ? { category: 'linear', symbol } : { category: 'linear', settleCoin: 'USDT' },
    { retries: 1 },
  );
  return (r?.list ?? []).filter((p) => Number(p.size) > 0);
}

export async function setLeverage(symbol, leverage) {
  return bybitCall('POST', '/v5/position/set-leverage', {
    category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
  }, { retries: 1 }).catch((e) => { if (e.code !== 110043) throw e; }); // 110043＝已經是這個倍數，不算錯誤
}

export async function setStopLoss(symbol, stopLoss) {
  return bybitCall('POST', '/v5/position/trading-stop', {
    category: 'linear', symbol, positionIdx: 0,
    stopLoss: String(stopLoss), slTriggerBy: 'LastPrice',
  }, { retries: 1 });
}

export async function cancelAllOrders(symbol) {
  return bybitCall('POST', '/v5/order/cancel-all', { category: 'linear', symbol }, { retries: 1 });
}

/** 冪等的 reduce-only 限價單——分批出場的每一段、以及補掛失敗腿都用這個 */
export async function placeReduceOnlyLimit({ symbol, side, qty, price, orderLinkId }) {
  return bybitCall('POST', '/v5/order/create', {
    category: 'linear', symbol, side, orderType: 'Limit',
    qty: String(qty), price: String(price), reduceOnly: true, timeInForce: 'GTC',
    ...(orderLinkId ? { orderLinkId } : {}),
  }, { retries: 1 });
}

/** 依 orderLinkId 查訂單現在的狀態——用來在「市價進場單逾時、不確定有沒有成交」時查清楚，而不是用猜的 */
export async function getOrderByLinkId(symbol, orderLinkId) {
  const r = await bybitCall('GET', '/v5/order/realtime', { category: 'linear', symbol, orderLinkId }, { retries: 1 });
  return r?.list?.[0] ?? null;
}

/**
 * 市價進場單——刻意不在這裡直接重試（原因跟 worker/index.js 原本的
 * 註解一樣：重試有把同一張單重複送出兩次的風險）。但這裡比原本的
 * Worker 版本更進一步：如果請求本身逾時或網路層失敗（不確定 Bybit
 * 到底收到了沒有），不會直接當作「沒下成」回報出去，而是先用
 * orderLinkId 去查一次訂單／持倉現在的狀態，確認清楚再決定——避免
 * 「其實已經成交了，只是回應沒送達」卻被誤判成失敗，導致下一次訊號
 * 又重複開倉。orderLinkId 固定用呼叫端傳進來的 signal_id，Bybit 自己
 * 也會拒絕重複的 orderLinkId，是這層保護之外的第二層防呆。
 */
export async function placeMarketEntry({ symbol, side, qty, stopLoss, orderLinkId }) {
  try {
    return await bybitCall('POST', '/v5/order/create', {
      category: 'linear', symbol, side, orderType: 'Market', qty: String(qty),
      timeInForce: 'IOC', stopLoss: String(stopLoss), slTriggerBy: 'LastPrice', orderLinkId,
    });
  } catch (e) {
    // Bybit 業務錯誤（retCode 明確回應過）代表請求確定有被處理、只是被
    // 拒絕，不需要再查——例如保證金不足，直接把錯誤丟出去就好。
    if (e.code !== undefined) throw e;

    // 走到這裡代表是網路層失敗（逾時／連線中斷／HTTP 5xx 等），沒辦法
    // 確定 Bybit 到底有沒有收到並處理這筆請求——查一次同一個 orderLinkId
    // 現在的狀態，而不是直接假設失敗。
    logger.warn('進場單請求本身失敗（逾時或網路層問題），查 orderLinkId 確認是否其實已經成交', {
      symbol, orderLinkId, error: e.message,
    });
    await sleep(1000);
    try {
      const order = await getOrderByLinkId(symbol, orderLinkId);
      if (order && ['Filled', 'PartiallyFilled', 'New'].includes(order.orderStatus)) {
        logger.warn('查到這筆 orderLinkId 其實已經送進去了，用查到的結果繼續，不會重複下單', {
          symbol, orderLinkId, orderStatus: order.orderStatus,
        });
        return { orderId: order.orderId, orderLinkId: order.orderLinkId };
      }
    } catch (queryErr) {
      logger.error('查 orderLinkId 狀態也失敗了，沒辦法確認這筆進場單到底有沒有成交', {
        symbol, orderLinkId, error: queryErr.message,
      });
    }
    // 查不到／查到的狀態不是「已受理」：判定這筆真的沒下成，往上丟原始錯誤。
    throw e;
  }
}

export { sign };
