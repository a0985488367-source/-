/**
 * 行情資料來源（多交易所備援）
 *
 * 內部統一格式：
 *   Candle = { time(ms, 開盤時間), open, high, low, close, volume, closed }
 *   Symbol = 'BTCUSDT'（無分隔），各交易所再各自轉換。
 *
 * 設計重點：任何一家被地區封鎖或暫時失效時，可自動切換到下一家；
 * 全部失敗時退回「離線示範資料」，確保介面永遠可用。
 */

import { mulberry32 } from '../core/utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 逾時／連線被中斷／429（限流）／5xx 都常常只是暫時性的（尤其從
 * Cloudflare Worker 的共用邊緣 IP 打出去，特別容易被交易所偶爾擋一下），
 * 失敗先重試一次、間隔 300ms 再打，能救回不少這類暫時性失敗；4xx（除了
 * 429，通常是網址或參數本身有問題）重試也沒用，直接丟出去。
 */
const J = async (url, { timeout = 12000, retries = 1 } = {}) => {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (res.ok) return await res.json();
      const err = new Error(`HTTP ${res.status}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    } catch (e) {
      if (attempt >= retries || e.retryable === false) throw e;
    } finally {
      clearTimeout(t);
    }
    await sleep(300 * (attempt + 1));
  }
};

const mkCandle = (t, o, h, l, c, v, closed = true) => ({
  time: +t, open: +o, high: +h, low: +l, close: +c, volume: +v, closed,
});

/* ------------------------------------------------------------------ Binance */

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com'];

const binance = {
  id: 'binance',
  label: 'Binance',
  market: 'Spot',
  supportsStream: true,
  intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w'],
  async request(path) {
    let err;
    for (const host of BINANCE_HOSTS) {
      try {
        return await J(host + path);
      } catch (e) { err = e; }
    }
    throw err;
  },
  async fetchKlines(symbol, interval, { limit = 1000, endTime } = {}) {
    const q = new URLSearchParams({ symbol, interval, limit: String(Math.min(1000, limit)) });
    if (endTime) q.set('endTime', String(endTime));
    const rows = await this.request(`/api/v3/klines?${q}`);
    return rows.map((r) => mkCandle(r[0], r[1], r[2], r[3], r[4], r[5]));
  },
  async fetchSymbols() {
    const rows = await this.request('/api/v3/ticker/24hr');
    return rows
      .filter((r) => /USDT$/.test(r.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        base: r.symbol.replace(/USDT$/, ''),
        quote: 'USDT',
        price: +r.lastPrice,
        change: +r.priceChangePercent,
        quoteVolume: +r.quoteVolume,
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  },
  async fetchTicker(symbol) {
    const r = await this.request(`/api/v3/ticker/24hr?symbol=${symbol}`);
    return { symbol, price: +r.lastPrice, change: +r.priceChangePercent, high: +r.highPrice, low: +r.lowPrice, quoteVolume: +r.quoteVolume };
  },
  createStream(symbol, interval, onCandle, onStatus) {
    const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(url);
    ws.onopen = () => onStatus?.('live');
    ws.onclose = () => onStatus?.('closed');
    ws.onerror = () => onStatus?.('error');
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      const k = d.k;
      if (!k) return;
      onCandle(mkCandle(k.t, k.o, k.h, k.l, k.c, k.v, k.x));
    };
    return ws;
  },
};

/* -------------------------------------------------------------------- Bybit */

const BYBIT_TF = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' };

const bybit = {
  id: 'bybit',
  label: 'Bybit',
  market: 'Spot',
  supportsStream: true,
  intervals: Object.keys(BYBIT_TF),
  async fetchKlines(symbol, interval, { limit = 1000, endTime } = {}) {
    const tf = BYBIT_TF[interval] || '15';
    const q = new URLSearchParams({ category: 'spot', symbol, interval: tf, limit: String(Math.min(1000, limit)) });
    if (endTime) q.set('end', String(endTime));
    const res = await J(`https://api.bybit.com/v5/market/kline?${q}`);
    if (res.retCode !== 0) throw new Error(res.retMsg || 'bybit error');
    return res.result.list
      .map((r) => mkCandle(r[0], r[1], r[2], r[3], r[4], r[5]))
      .sort((a, b) => a.time - b.time);
  },
  async fetchSymbols() {
    const res = await J('https://api.bybit.com/v5/market/tickers?category=spot');
    return res.result.list
      .filter((r) => /USDT$/.test(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        base: r.symbol.replace(/USDT$/, ''),
        quote: 'USDT',
        price: +r.lastPrice,
        change: +r.price24hPcnt * 100,
        quoteVolume: +r.turnover24h,
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  },
  async fetchTicker(symbol) {
    const res = await J(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
    const r = res.result.list[0];
    return { symbol, price: +r.lastPrice, change: +r.price24hPcnt * 100, high: +r.highPrice24h, low: +r.lowPrice24h, quoteVolume: +r.turnover24h };
  },
  createStream(symbol, interval, onCandle, onStatus) {
    const tf = BYBIT_TF[interval] || '15';
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    ws.onopen = () => {
      onStatus?.('live');
      ws.send(JSON.stringify({ op: 'subscribe', args: [`kline.${tf}.${symbol}`] }));
    };
    ws.onclose = () => onStatus?.('closed');
    ws.onerror = () => onStatus?.('error');
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (!d.topic || !d.data) return;
      for (const k of d.data) onCandle(mkCandle(k.start, k.open, k.high, k.low, k.close, k.volume, k.confirm));
    };
    return ws;
  },
};

/* ---------------------------------------------------------------------- OKX */

const OKX_TF = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W' };
const toOkx = (s) => s.replace(/USDT$/, '-USDT');
const fromOkx = (s) => s.replace('-', '');

const okx = {
  id: 'okx',
  label: 'OKX',
  market: 'Spot',
  supportsStream: true,
  intervals: Object.keys(OKX_TF),
  async fetchKlines(symbol, interval, { limit = 300, endTime } = {}) {
    const bar = OKX_TF[interval] || '15m';
    const need = Math.min(1000, limit);
    const out = [];
    let after = endTime;
    // OKX 單次上限 300，需分頁抓取
    while (out.length < need) {
      const q = new URLSearchParams({ instId: toOkx(symbol), bar, limit: '300' });
      if (after) q.set('after', String(after));
      const path = after ? 'history-candles' : 'candles';
      const res = await J(`https://www.okx.com/api/v5/market/${path}?${q}`);
      if (res.code !== '0') throw new Error(res.msg || 'okx error');
      const rows = res.data || [];
      if (!rows.length) break;
      out.push(...rows.map((r) => mkCandle(r[0], r[1], r[2], r[3], r[4], r[5])));
      after = +rows[rows.length - 1][0];
      if (rows.length < 300) break;
    }
    return out.sort((a, b) => a.time - b.time).slice(-need);
  },
  async fetchSymbols() {
    const res = await J('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
    return (res.data || [])
      .filter((r) => /-USDT$/.test(r.instId))
      .map((r) => ({
        symbol: fromOkx(r.instId),
        base: r.instId.replace('-USDT', ''),
        quote: 'USDT',
        price: +r.last,
        change: r.open24h ? ((+r.last - +r.open24h) / +r.open24h) * 100 : 0,
        quoteVolume: +r.volCcy24h,
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  },
  async fetchTicker(symbol) {
    const res = await J(`https://www.okx.com/api/v5/market/ticker?instId=${toOkx(symbol)}`);
    const r = res.data[0];
    return {
      symbol,
      price: +r.last,
      change: r.open24h ? ((+r.last - +r.open24h) / +r.open24h) * 100 : 0,
      high: +r.high24h,
      low: +r.low24h,
      quoteVolume: +r.volCcy24h,
    };
  },
  createStream(symbol, interval, onCandle, onStatus) {
    const bar = OKX_TF[interval] || '15m';
    const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/business');
    ws.onopen = () => {
      onStatus?.('live');
      ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: `candle${bar}`, instId: toOkx(symbol) }] }));
    };
    ws.onclose = () => onStatus?.('closed');
    ws.onerror = () => onStatus?.('error');
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (!d.data) return;
      for (const r of d.data) onCandle(mkCandle(r[0], r[1], r[2], r[3], r[4], r[5], r[8] === '1'));
    };
    return ws;
  },
};

/* --------------------------------------------------------------- Demo（離線） */

const DEMO_SYMBOLS = [
  ['BTCUSDT', 64000, 1], ['ETHUSDT', 3200, 2], ['SOLUSDT', 148, 3], ['BNBUSDT', 580, 4],
  ['XRPUSDT', 0.62, 5], ['DOGEUSDT', 0.14, 6], ['ADAUSDT', 0.45, 7], ['AVAXUSDT', 34, 8],
  ['LINKUSDT', 16.5, 9], ['TONUSDT', 6.8, 10], ['ARBUSDT', 1.05, 11], ['OPUSDT', 2.3, 12],
];

/**
 * 產生具備 SMC 特徵的合成行情：趨勢腿、回調、流動性掃除、位移缺口。
 * 使用固定亂數種子 → 結果可重現，適合教學與離線展示。
 */
export function generateDemoCandles(symbol, interval, limit = 800, endTime = Date.now()) {
  const meta = DEMO_SYMBOLS.find((s) => s[0] === symbol) || ['BTCUSDT', 64000, 1];
  const rnd = mulberry32(meta[2] * 9973 + hashCode(interval));
  const stepMs = intervalMs(interval);
  // 固定長度 + 對齊週期的錨點：不論呼叫者要多少根，價格序列都一致
  const TOTAL = 1200;
  const anchor = Math.floor(endTime / stepMs) * stepMs;
  const start = anchor - stepMs * TOTAL;
  const want = Math.min(TOTAL, limit);
  limit = TOTAL;
  let price = meta[1];
  const vol = meta[1] * 0.004;
  const candles = [];
  let trend = rnd() > 0.5 ? 1 : -1;
  let legBars = 0;
  let legTarget = 30 + Math.floor(rnd() * 40);
  let phase = 'impulse';

  for (let i = 0; i < limit; i++) {
    legBars++;
    if (legBars > legTarget) {
      legBars = 0;
      legTarget = 18 + Math.floor(rnd() * 45);
      if (phase === 'impulse') phase = rnd() > 0.35 ? 'pullback' : 'range';
      else if (phase === 'pullback') { phase = 'impulse'; if (rnd() > 0.78) trend *= -1; }
      else phase = 'impulse';
    }
    let drift = 0;
    let sigma = vol;
    if (phase === 'impulse') { drift = trend * vol * 0.55; sigma = vol * 1.25; }
    else if (phase === 'pullback') { drift = -trend * vol * 0.28; sigma = vol * 0.8; }
    else { drift = 0; sigma = vol * 0.6; }

    // 軟性均值回歸：避免長序列隨機漂移到不合理的價位
    const pull = -((price - meta[1]) / meta[1]) * vol * 0.9;
    const open = price;
    let close = open + drift + pull + (rnd() - 0.5) * sigma * 2;
    let high = Math.max(open, close) + rnd() * sigma * 0.9;
    let low = Math.min(open, close) - rnd() * sigma * 0.9;

    // 隨機製造流動性掃除（長影線後收回）
    if (rnd() > 0.965) {
      const up = rnd() > 0.5;
      if (up) high += sigma * (1.5 + rnd() * 1.5);
      else low -= sigma * (1.5 + rnd() * 1.5);
      close = open + (up ? -1 : 1) * sigma * 0.3;
    }
    // 位移 K 棒 → 製造 FVG
    if (phase === 'impulse' && rnd() > 0.93) {
      close = open + trend * sigma * (2.2 + rnd() * 1.8);
      if (trend > 0) { high = close + sigma * 0.3; low = open - sigma * 0.1; }
      else { low = close - sigma * 0.3; high = open + sigma * 0.1; }
    }
    price = close;
    const volume = (0.6 + rnd() * 1.1) * (phase === 'impulse' ? 1.7 : 1) * meta[1] * 12;
    candles.push(mkCandle(start + i * stepMs, open, Math.max(high, open, close), Math.min(low, open, close), close, volume));
  }
  return candles.slice(-want);
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function intervalMs(interval) {
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) return 900000;
  const n = +m[1];
  return n * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]];
}

const demo = {
  id: 'demo',
  label: 'Demo（離線示範）',
  market: 'Synthetic',
  supportsStream: false,
  offline: true,
  intervals: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],
  async fetchKlines(symbol, interval, { limit = 800, endTime } = {}) {
    return generateDemoCandles(symbol, interval, limit, endTime || Date.now());
  },
  async fetchSymbols() {
    return DEMO_SYMBOLS.map(([symbol, price], i) => ({
      symbol,
      base: symbol.replace('USDT', ''),
      quote: 'USDT',
      price,
      change: ((i % 5) - 2) * 1.7,
      quoteVolume: 1e9 / (i + 1),
    }));
  },
  async fetchTicker(symbol, interval = '15m') {
    const bars = Math.max(24, Math.round(86_400_000 / intervalMs(interval))); // 取最近 24 小時
    const c = await this.fetchKlines(symbol, interval, { limit: bars });
    const last = c[c.length - 1];
    const first = c[0];
    return {
      symbol,
      price: last.close,
      change: ((last.close - first.open) / first.open) * 100,
      high: Math.max(...c.map((x) => x.high)),
      low: Math.min(...c.map((x) => x.low)),
      quoteVolume: c.reduce((s, x) => s + x.volume, 0),
    };
  },
  createStream() { return null; },
};

export const PROVIDERS = { binance, bybit, okx, demo };
export const PROVIDER_ORDER = ['binance', 'bybit', 'okx', 'demo'];
export const getProvider = (id) => PROVIDERS[id] || PROVIDERS.binance;
