/**
 * 設定儲存（localStorage）— 含版本遷移與預設值合併。
 */
import { deepMerge } from './utils.js';

const KEY = 'smc-terminal:v1';

export const DEFAULT_STATE = {
  provider: 'binance',
  symbol: 'BTCUSDT',
  interval: '15m',
  lang: 'zh',
  theme: 'dark',
  timezone: 'UTC',
  chartType: 'candles',
  candleCount: 500,
  live: true,
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  risk: { account: 10000, riskPct: 1, leverage: 10 },
  layers: {
    orderBlocks: true,
    breakers: true,
    fvg: true,
    volumeImbalance: false,
    liquidity: true,
    sweeps: true,
    structure: true,
    swingLabels: true,
    premiumDiscount: true,
    ote: true,
    fib: false,
    keyLevels: true,
    sessions: true,
    ema: true,
    vwap: false,
    volumeProfile: false,
    setup: true,
    inducement: true,
  },
  smc: {
    internalStrength: 2,
    swingStrength: 7,
    breakBy: 'close',
    obZoneMode: 'wick',
    minDisplacementAtr: 1.0,
    fvgMinAtr: 0.25,
    liquidityTolAtr: 0.18,
    minRR: 2,
    riskBufferAtr: 0.35,
    maxPois: 14,
    showVolumeImbalance: true,
  },
  alerts: [],
  mtfList: ['15m', '1h', '4h', '1d'],
};

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    return deepMerge(structuredClone(DEFAULT_STATE), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('無法儲存設定', e);
  }
}

export function resetState() {
  try { localStorage.removeItem(KEY); } catch {}
  return structuredClone(DEFAULT_STATE);
}
