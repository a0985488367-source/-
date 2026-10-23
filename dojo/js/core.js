/**
 * 道場 2.0 共用：亂數、真實 K 線資料（dojo/mdata，Binance 歷史 K 線壓縮檔）、日期工具。
 * 純函式，Node 測試也能直接 import（資料讀取由呼叫端注入 fetchJson）。
 */
import { analyze, aggregate, structure, atrOf } from '../../src/smc/coach.js';

export { analyze, aggregate, structure, atrOf };

/** 可重現的亂數（mulberry32） */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.shuffle = (arr) => {
    const b = arr.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  };
  next.chance = (p) => next() < p;
  return next;
}

export const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
export const TFS = ['15m', '1h', '4h'];
export const TF_SEC = { '15m': 900, '1h': 3600, '4h': 14400 };

/** mdata 壓縮格式 → [{t（秒）,o,h,l,c}] */
export function decode(o) {
  const d = o.d.split(','), C = [], m = Math.pow(10, o.dec);
  let pc = o.o0, t = o.t0, i = 0;
  while (i < d.length) {
    const tk = d[i];
    if (tk.charAt(0) === '~') { t += parseInt(tk.slice(1), 36) * o.dt; i++; continue; }
    const a = parseInt(tk, 36), bh = parseInt(d[i + 1], 36), c = parseInt(d[i + 2], 36), bl = parseInt(d[i + 3], 36);
    i += 4;
    const op = pc + a, cl = op + c;
    C.push({ t, o: op / m, h: (Math.max(op, cl) + bh) / m, l: (Math.min(op, cl) - bl) / m, c: cl / m });
    pc = cl; t += o.dt;
  }
  return C;
}

const cache = new Map();
let fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`讀不到行情資料（HTTP ${r.status}）`); return r.json(); });
/** 測試時換成讀檔 */
export function setFetcher(fn) { fetchJson = fn; cache.clear(); }

export function loadSeries(coin, tf) {
  const k = `${coin}_${tf}`;
  if (!cache.has(k)) cache.set(k, fetchJson(`mdata/${k}.json`).then(decode).catch((e) => { cache.delete(k); throw e; }));
  return cache.get(k);
}

/**
 * 從真實行情隨機切一段：W＝到決策那根為止（含）的 len 根，future＝之後的 K 棒（預測／排位用）。
 * A＝coach.js 的 analyze(W)：所有標記都只用到 W 裡的資料，不會偷看未來。
 */
export async function sampleWindow(rng, { coin, tf, len = 260, future = 0 } = {}) {
  coin = coin || rng.pick(COINS);
  tf = tf || rng.pick(TFS);
  const C = await loadSeries(coin, tf);
  const j = rng.int(len + 20, C.length - 2 - future);
  const W = C.slice(j - len + 1, j + 1);
  return { coin, tf, W, A: analyze(W), fut: future ? C.slice(j + 1, j + 1 + future) : [], C, j };
}

/** 大週期方向：把 W 合併成 g 倍週期，看外部結構（1 多、-1 空、0 不明） */
export function htfTrend(W, tf, g = 4) {
  const agg = aggregate(W, W.length - 1, g, TF_SEC[tf]);
  // 最後一根大週期還沒收完，不算
  const closed = agg.slice(0, -1);
  if (closed.length < 30) return { trend: 0, agg: closed };
  const S = structure(closed, 3, atrOf(closed));
  return { trend: S.trend[closed.length - 1], agg: closed, S };
}

export const fmtPrice = (p) => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));
export const todayKey = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10); // 台灣日期
export const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
export const fmtTime = (sec) => new Date(sec * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
