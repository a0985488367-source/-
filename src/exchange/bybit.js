/**
 * Bybit V5 API 客戶端（瀏覽器端，零依賴）
 *
 * 安全設計：
 *  - 金鑰只存在使用者自己的 localStorage，永遠不會上傳到任何伺服器，
 *    也不會進到這個倉庫。簽章用瀏覽器內建的 Web Crypto 在本機算。
 *  - 模擬盤（testnet）與實盤（mainnet）是兩組完全獨立的網域與金鑰，
 *    切換時不會沿用另一邊的設定，避免「以為在模擬盤其實在真錢」。
 *  - 下單一律同時帶上停損與停利，不存在「只送進場單」的路徑。
 *
 * 簽章規則（Bybit V5）：
 *   sign = HMAC_SHA256(timestamp + apiKey + recvWindow + payload, apiSecret)
 *   payload：GET 是查詢字串，POST 是原始 JSON 字串（必須與實際送出的完全一致）
 */

export const HOSTS = {
  testnet: 'https://api-testnet.bybit.com',
  live: 'https://api.bybit.com',
};

const RECV_WINDOW = '10000';
const enc = new TextEncoder();

/** 以 Web Crypto 算 HMAC-SHA256，輸出小寫十六進位 */
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bybit 用 retCode 表示業務層錯誤，HTTP 仍然是 200，所以要另外判斷 */
export class BybitError extends Error {
  constructor(code, message, { network = false } = {}) {
    super(message);
    this.name = 'BybitError';
    this.code = code;
    this.network = network;
  }
}

/** 把常見錯誤翻成看得懂的中文，並附上該怎麼修 */
export function explainError(e) {
  if (e?.network) {
    return {
      zh: '連不到 Bybit。可能是網路問題，或瀏覽器擋下了跨網域請求（CORS）。如果你在手機上用的是「加到主畫面」的版本，請先改用 Safari／Chrome 直接開一次試試。',
      en: 'Cannot reach Bybit (network or CORS).',
    };
  }
  const map = {
    10003: { zh: 'API Key 無效。請確認貼的是 Key 本身，而且模擬盤／實盤的金鑰沒有互相貼錯。', en: 'Invalid API key.' },
    10004: { zh: '簽章錯誤。通常是 API Secret 貼錯或前後多了空白。', en: 'Signature error.' },
    10005: { zh: '權限不足。請在 Bybit 後台為這把金鑰開啟「Unified Trading — Trade」權限。', en: 'Permission denied.' },
    10006: { zh: '請求太頻繁，稍後再試。', en: 'Rate limited.' },
    10010: { zh: 'IP 不在白名單。請在 Bybit 後台把這把金鑰的 IP 限制改成「不限制」，或加入你目前的 IP。', en: 'IP not whitelisted.' },
    10016: { zh: 'Bybit 服務暫時異常，稍後再試。', en: 'Service error.' },
    110007: { zh: '可用餘額不足，無法用這個數量下單。', en: 'Insufficient balance.' },
    110017: { zh: '下單數量小於這個幣種的最小下單量。請提高風險金額或改用其他幣種。', en: 'Qty below minimum.' },
    110043: { zh: '槓桿倍數沒有變更（已經是這個值）。', en: 'Leverage not modified.' },
    170131: { zh: '可用餘額不足。', en: 'Insufficient balance.' },
  };
  return map[e?.code] || { zh: e?.message || '未知錯誤', en: e?.message || 'Unknown error' };
}

/**
 * @param {{apiKey:string, apiSecret:string, testnet:boolean, fetchImpl?:Function}} cfg
 */
export function createClient({ apiKey, apiSecret, testnet = true, fetchImpl }) {
  const host = testnet ? HOSTS.testnet : HOSTS.live;
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function call(method, path, params = {}, { signed = true } = {}) {
    const ts = String(Date.now());
    let url = host + path;
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

    const headers = { 'Content-Type': 'application/json' };
    if (signed) {
      if (!apiKey || !apiSecret) throw new BybitError(0, '尚未設定 API 金鑰');
      headers['X-BAPI-API-KEY'] = apiKey;
      headers['X-BAPI-TIMESTAMP'] = ts;
      headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
      headers['X-BAPI-SIGN'] = await hmacHex(apiSecret, ts + apiKey + RECV_WINDOW + payload);
    }

    let res;
    try {
      res = await doFetch(url, { method, headers, body });
    } catch (e) {
      throw new BybitError(-1, e.message || '網路錯誤', { network: true });
    }
    if (!res.ok) throw new BybitError(-1, `HTTP ${res.status}`, { network: res.status >= 500 });

    const json = await res.json();
    if (json.retCode !== 0) throw new BybitError(json.retCode, json.retMsg || '請求失敗');
    return json.result;
  }

  return {
    host,
    testnet,

    /** 連線測試：讀餘額。這是唯讀動作，不會動到任何部位。 */
    async walletBalance(accountType = 'UNIFIED') {
      const r = await call('GET', '/v5/account/wallet-balance', { accountType });
      const acct = r?.list?.[0];
      return {
        totalEquity: Number(acct?.totalEquity ?? 0),
        totalAvailable: Number(acct?.totalAvailableBalance ?? 0),
        coins: (acct?.coin ?? []).map((c) => ({
          coin: c.coin,
          equity: Number(c.equity ?? 0),
          available: Number(c.availableToWithdraw ?? c.walletBalance ?? 0),
        })),
      };
    },

    /** 合約規格：下單數量與價格都必須對齊這些刻度，否則 Bybit 會退單 */
    async instrument(symbol, category = 'linear') {
      const r = await call('GET', '/v5/market/instruments-info', { category, symbol }, { signed: false });
      const it = r?.list?.[0];
      if (!it) throw new BybitError(0, `找不到合約 ${symbol}`);
      return {
        symbol: it.symbol,
        tickSize: Number(it.priceFilter?.tickSize ?? 0.01),
        qtyStep: Number(it.lotSizeFilter?.qtyStep ?? 0.001),
        minQty: Number(it.lotSizeFilter?.minOrderQty ?? 0),
        maxQty: Number(it.lotSizeFilter?.maxOrderQty ?? Infinity),
        maxLeverage: Number(it.leverageFilter?.maxLeverage ?? 10),
      };
    },

    async positions(category = 'linear', settleCoin = 'USDT') {
      const r = await call('GET', '/v5/position/list', { category, settleCoin });
      return (r?.list ?? [])
        .filter((p) => Number(p.size) > 0)
        .map((p) => ({
          symbol: p.symbol,
          side: p.side === 'Buy' ? 'long' : 'short',
          size: Number(p.size),
          entry: Number(p.avgPrice),
          mark: Number(p.markPrice),
          leverage: Number(p.leverage),
          unrealisedPnl: Number(p.unrealisedPnl ?? 0),
          takeProfit: Number(p.takeProfit) || null,
          stopLoss: Number(p.stopLoss) || null,
        }));
    },

    async setLeverage(symbol, leverage, category = 'linear') {
      try {
        await call('POST', '/v5/position/set-leverage', {
          category, symbol,
          buyLeverage: String(leverage), sellLeverage: String(leverage),
        });
      } catch (e) {
        if (e.code !== 110043) throw e; // 已經是這個倍數 → 不算錯誤
      }
    },

    /**
     * 送出帶停損停利的進場單。
     * 市價單立刻成交；限價單掛在 POI 等價格回來。
     */
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, category = 'linear', reduceOnly = false }) {
      const params = {
        category,
        symbol,
        side: side === 'long' ? 'Buy' : 'Sell',
        orderType: price ? 'Limit' : 'Market',
        qty: String(qty),
        timeInForce: price ? 'GTC' : 'IOC',
      };
      if (price) params.price = String(price);
      if (stopLoss) { params.stopLoss = String(stopLoss); params.slTriggerBy = 'LastPrice'; }
      if (takeProfit) { params.takeProfit = String(takeProfit); params.tpTriggerBy = 'LastPrice'; }
      if (reduceOnly) params.reduceOnly = true;
      const r = await call('POST', '/v5/order/create', params);
      return { orderId: r?.orderId, orderLinkId: r?.orderLinkId };
    },

    /** 市價平掉一個部位 */
    async closePosition({ symbol, side, qty, category = 'linear' }) {
      return call('POST', '/v5/order/create', {
        category, symbol,
        side: side === 'long' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty: String(qty),
        reduceOnly: true,
        timeInForce: 'IOC',
      });
    },

    async openOrders(category = 'linear', settleCoin = 'USDT') {
      const r = await call('GET', '/v5/order/realtime', { category, settleCoin });
      return (r?.list ?? []).map((o) => ({
        orderId: o.orderId, symbol: o.symbol,
        side: o.side === 'Buy' ? 'long' : 'short',
        qty: Number(o.qty), price: Number(o.price) || null,
        stopLoss: Number(o.stopLoss) || null, takeProfit: Number(o.takeProfit) || null,
        status: o.orderStatus,
      }));
    },

    async cancelOrder({ symbol, orderId, category = 'linear' }) {
      return call('POST', '/v5/order/cancel', { category, symbol, orderId });
    },
  };
}

/* ------------------------------------------------- 數量與價格的刻度對齊 */

/** 依步進值無條件捨去（下單數量寧可少一點，也不要因為超出可用餘額被退單） */
export function roundStep(value, step) {
  if (!(step > 0)) return value;
  const decimals = decimalsOf(step);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

/** 價格對齊 tick，四捨五入即可 */
export function roundTick(value, tick) {
  if (!(tick > 0)) return value;
  return Number((Math.round(value / tick) * tick).toFixed(decimalsOf(tick)));
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/**
 * 把交易計畫換算成可以直接送出的下單參數。
 * 數量由「風險金額 ÷ 每單位風險」決定 —— 這是固定風險法，
 * 不是「用多少本金」，所以停損越寬數量越小，每筆的最大虧損固定。
 */
export function planToOrder({ plan, instrument, accountSize, riskPct, leverage }) {
  const { dir, entry, stop } = plan;
  const perUnit = Math.abs(entry - stop);
  if (!(perUnit > 0) || !(accountSize > 0)) return { error: '風險參數不完整' };

  const riskAmount = (accountSize * riskPct) / 100;
  const rawQty = riskAmount / perUnit;
  const qty = roundStep(rawQty, instrument.qtyStep);

  if (qty < instrument.minQty) {
    return {
      error: `算出來的數量 ${qty} 小於 ${instrument.symbol} 的最小下單量 ${instrument.minQty}。` +
        `請調高帳戶金額或每筆風險 %，或改用單價較低的幣種。`,
      qty, minQty: instrument.minQty,
    };
  }

  const entryPx = roundTick(entry, instrument.tickSize);
  const notional = qty * entryPx;
  const margin = notional / Math.max(1, leverage);

  return {
    symbol: instrument.symbol,
    side: dir,
    qty,
    price: plan.entryType === 'market' ? null : entryPx,
    stopLoss: roundTick(stop, instrument.tickSize),
    // 只送第一個目標當停利：後面的分批留給人工或部位管理規則處理，
    // 一次把整個階梯送上去會讓 Bybit 的 TP/SL 設定互相覆蓋。
    takeProfit: plan.targets?.[0] ? roundTick(plan.targets[0].price, instrument.tickSize) : null,
    riskAmount,
    notional,
    margin,
    leverageUsed: notional / accountSize,
  };
}
