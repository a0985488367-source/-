/**
 * 設定儲存（localStorage）— 含版本遷移與預設值合併。
 */
import { deepMerge } from './utils.js';

const KEY = 'smc-terminal:v1';

/**
 * 設定格式版本。2：預設資料源從 Binance 改成 Bybit——Discord 通知（Worker 掃描）
 * 用的是 Bybit 的 K 線，兩邊資料源不同，同一個幣的高低點、計畫就會有差。
 */
const DATA_VERSION = 2;

export const DEFAULT_STATE = {
  dataVersion: DATA_VERSION,
  provider: 'bybit',
  symbol: 'BTCUSDT',
  interval: '15m',
  lang: 'zh',
  theme: 'dark',
  timezone: 'UTC',
  chartType: 'candles',
  split: 68,
  layerPreset: 'standard',
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
    mtfPlan: true,
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
    const saved = JSON.parse(raw);
    // 舊設定還停在當時預設的 Binance：改成 Bybit，跟 Discord 通知同一個資料源
    if ((saved.dataVersion ?? 1) < 2 && (saved.provider ?? 'binance') === 'binance') saved.provider = 'bybit';
    saved.dataVersion = DATA_VERSION;
    return deepMerge(structuredClone(DEFAULT_STATE), saved);
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
