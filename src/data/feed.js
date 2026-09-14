/**
 * 行情串接層：負責抓取歷史 K 線、開啟即時串流、處理備援與快取。
 */

import { PROVIDERS, PROVIDER_ORDER, getProvider } from './providers.js';
import { bus } from '../core/bus.js';

const cache = new Map();
const cacheKey = (p, s, i, l) => `${p}:${s}:${i}:${l}`;
const TTL = 20_000;

export class Feed {
  constructor(state) {
    this.state = state;
    this.ws = null;
    this.activeProvider = state.provider;
    this.streamStatus = 'idle';
    this.symbolsCache = new Map();
  }

  get provider() {
    return getProvider(this.activeProvider);
  }

  /** 依序嘗試各資料源，回傳第一個成功者 */
  async withFallback(fn, { preferred } = {}) {
    const order = [preferred || this.state.provider, ...PROVIDER_ORDER.filter((p) => p !== (preferred || this.state.provider))];
    let lastErr;
    for (const id of order) {
      const provider = PROVIDERS[id];
      if (!provider) continue;
      try {
        const out = await fn(provider);
        if (this.activeProvider !== id) {
          this.activeProvider = id;
          bus.emit('provider:changed', { id, fallback: id !== this.state.provider });
        }
        return out;
      } catch (e) {
        lastErr = e;
        bus.emit('provider:error', { id, error: e?.message || String(e) });
      }
    }
    throw lastErr || new Error('所有資料源皆無法連線');
  }

  async getCandles(symbol, interval, limit = 500, { force = false } = {}) {
    const key = cacheKey(this.state.provider, symbol, interval, limit);
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < TTL) return hit.data;
    const data = await this.withFallback((p) => p.fetchKlines(symbol, interval, { limit }));
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  async getSymbols() {
    const key = this.state.provider;
    const hit = this.symbolsCache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return hit.data;
    const data = await this.withFallback((p) => p.fetchSymbols());
    this.symbolsCache.set(key, { at: Date.now(), data });
    return data;
  }

  async getTicker(symbol, interval) {
    return this.withFallback((p) => p.fetchTicker(symbol, interval));
  }

  /** 多週期批次抓取（用於 MTF 面板與掃描器） */
  async getMulti(symbol, intervals, limit = 320) {
    const out = {};
    await Promise.all(
      intervals.map(async (iv) => {
        try {
          out[iv] = await this.getCandles(symbol, iv, limit);
        } catch {
          out[iv] = [];
        }
      }),
    );
    return out;
  }

  stopStream() {
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.close(); } catch {}
      this.ws = null;
    }
    this.streamStatus = 'idle';
    bus.emit('stream:status', 'idle');
  }

  startStream(symbol, interval, onCandle) {
    this.stopStream();
    const provider = getProvider(this.activeProvider);
    if (!provider.supportsStream || typeof WebSocket === 'undefined') {
      this.streamStatus = 'polling';
      bus.emit('stream:status', 'polling');
      this.pollTimer && clearInterval(this.pollTimer);
      this.pollTimer = setInterval(async () => {
        try {
          const c = await provider.fetchKlines(symbol, interval, { limit: 2 });
          if (c.length) onCandle(c[c.length - 1]);
        } catch {}
      }, 15000);
      return;
    }
    try {
      this.ws = provider.createStream(symbol, interval, onCandle, (status) => {
        this.streamStatus = status;
        bus.emit('stream:status', status);
        if (status === 'closed' && this.state.live) {
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.startStream(symbol, interval, onCandle), 3000);
        }
      });
    } catch (e) {
      bus.emit('provider:error', { id: provider.id, error: e?.message || String(e) });
    }
  }

  /** 將即時 K 棒合併進既有序列 */
  static merge(candles, candle) {
    if (!candles.length) return [candle];
    const last = candles[candles.length - 1];
    if (candle.time === last.time) {
      candles[candles.length - 1] = { ...last, ...candle };
      return candles;
    }
    if (candle.time > last.time) {
      candles.push(candle);
      return candles;
    }
    return candles;
  }
}
