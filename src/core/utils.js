/**
 * 共用工具函式（純函式，無 DOM 依賴，可於 Node 中測試）
 * Shared pure utilities — no DOM dependency so they can be unit-tested in Node.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** 反向線性插值：value 在 [a,b] 之中的比例 */
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);

export const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map((v) => (v - m) ** 2)) / (arr.length - 1));
};

export const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const last = (arr, offset = 0) => arr[arr.length - 1 - offset];

/** 依價格量級決定合理的小數位數 */
export function precisionFor(price) {
  const p = Math.abs(price);
  if (!isFinite(p) || p === 0) return 2;
  if (p >= 10000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 7;
  return 9;
}

export function fmtPrice(price, digits) {
  if (price == null || !isFinite(price)) return '—';
  const d = digits ?? precisionFor(price);
  return price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtNum(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v) {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [div, suffix] of units) {
    if (abs >= div) return (v / div).toFixed(abs / div >= 100 ? 0 : 2) + suffix;
  }
  return v.toFixed(abs >= 1 ? 1 : 3);
}

export function fmtPct(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtSigned(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${fmtNum(v, digits)}`;
}

const PAD = (n) => String(n).padStart(2, '0');

/** 依使用者選擇的時區輸出時間（'UTC' 或 'local'） */
export function fmtTime(ts, { tz = 'UTC', withDate = true, withSeconds = false } = {}) {
  const d = new Date(ts);
  const get = (unit) => {
    if (tz === 'UTC') {
      return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(),
        h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
      }[unit];
    }
    return {
      y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(),
      h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(),
    }[unit];
  };
  const time = `${PAD(get('h'))}:${PAD(get('mi'))}${withSeconds ? ':' + PAD(get('s')) : ''}`;
  if (!withDate) return time;
  return `${get('y')}-${PAD(get('mo'))}-${PAD(get('da'))} ${time}`;
}

export function fmtAgo(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 週期字串 -> 毫秒 */
export function intervalToMs(interval) {
  const m = /^(\d+)([mhdwM])$/.exec(interval);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = m[2];
  const table = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
  return n * table[unit];
}

export function throttle(fn, wait = 100) {
  let t = 0;
  let queued = null;
  return (...args) => {
    const now = Date.now();
    if (now - t >= wait) {
      t = now;
      fn(...args);
    } else if (!queued) {
      queued = setTimeout(() => {
        queued = null;
        t = Date.now();
        fn(...args);
      }, wait - (now - t));
    }
  };
}

export function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export const uid = (() => {
  let n = 0;
  return (prefix = 'id') => `${prefix}_${(++n).toString(36)}${Date.now().toString(36).slice(-4)}`;
})();

/** 兩個價格區間是否重疊 */
export function overlaps(aLow, aHigh, bLow, bHigh) {
  return aLow <= bHigh && bLow <= aHigh;
}

/** 以百分比表示 a 相對 b 的距離 */
export function pctDiff(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

export function round(v, step) {
  if (!step) return v;
  return Math.round(v / step) * step;
}

/** 簡易深度合併（僅處理 plain object） */
export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 確定性亂數（供離線示範資料使用，確保每次結果一致） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
