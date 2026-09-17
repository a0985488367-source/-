/**
 * K 線資料的輸入／輸出與品質檢查。
 *
 * 真實行情不像合成資料那樣乾淨：會有缺口（交易所維護、網路中斷）、
 * 重複時間戳、以及分頁抓取時的邊界重疊。這些若不先檢出，
 * 回測會安靜地量到錯誤的東西，而且看起來完全正常。
 */

/** 內部：把任意數值時間戳正規化為毫秒 */
const toMs = (t) => (t < 1e12 ? t * 1000 : t);

/**
 * 解析 OHLC CSV。欄位順序：time,open,high,low,close[,volume]
 * 允許表頭、允許逗號／分號／Tab 分隔、秒或毫秒時間戳。
 */
export function parseCandleCsv(text) {
  const out = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 5) continue;
    const nums = parts.map(Number);
    if (nums.slice(0, 5).some((n) => !Number.isFinite(n))) continue;   // 表頭或壞行
    const [time, open, high, low, close, volume] = nums;
    out.push({ time: toMs(time), open, high, low, close, volume: Number.isFinite(volume) ? volume : 100 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 解析 Bybit v5 /market/kline 的回應。
 * result.list 的每筆為 [startTime, open, high, low, close, volume, turnover]，
 * 且交易所回傳的順序是「新到舊」，必須反轉。
 * 可直接餵入整個回應物件、result 物件、或 list 陣列。
 */
export function parseBybitKline(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const list = Array.isArray(data) ? data : data?.result?.list ?? data?.list;
  if (!Array.isArray(list)) throw new Error('看不出是 Bybit kline 格式：找不到 result.list');
  return list
    .map((r) => ({
      time: toMs(Number(r[0])),
      open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
      volume: Number(r[5]) || 0,
    }))
    .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
}

/** 輸出為 CSV（含表頭） */
export function candlesToCsv(candles) {
  const rows = candles.map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume].join(','));
  return ['time,open,high,low,close,volume', ...rows].join('\n') + '\n';
}

/**
 * 品質檢查。回傳問題清單與去重後的 K 線。
 * 不自動填補缺口——缺口要讓使用者看見並決定，悄悄補值會製造假的連續性。
 */
export function validateCandles(candles) {
  const issues = [];
  if (candles.length < 2) return { candles, issues: ['K 棒數量不足'], stepMs: NaN, gaps: [] };

  // 去除重複時間戳（分頁邊界最常見），保留後出現者
  const byTime = new Map();
  for (const k of candles) byTime.set(k.time, k);
  const clean = [...byTime.values()].sort((a, b) => a.time - b.time);
  const dupes = candles.length - clean.length;
  if (dupes > 0) issues.push(`移除 ${dupes} 根重複時間戳的 K 棒`);

  // 以眾數推定間隔
  const diffs = clean.slice(1).map((k, i) => k.time - clean[i].time);
  const counts = new Map();
  for (const d of diffs) counts.set(d, (counts.get(d) || 0) + 1);
  const stepMs = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const gaps = [];
  diffs.forEach((d, i) => {
    if (d > stepMs) gaps.push({ afterTime: clean[i].time, missingBars: Math.round(d / stepMs) - 1 });
  });
  if (gaps.length) {
    const total = gaps.reduce((a, g) => a + g.missingBars, 0);
    issues.push(`發現 ${gaps.length} 處缺口，合計缺少 ${total} 根 K 棒（${(total / (clean.length + total) * 100).toFixed(2)}%）`);
  }

  const bad = clean.filter((k) =>
    !(k.high >= Math.max(k.open, k.close) - 1e-9 && k.low <= Math.min(k.open, k.close) + 1e-9 && k.high >= k.low));
  if (bad.length) issues.push(`⚠ ${bad.length} 根 K 棒的 OHLC 不自洽（high/low 未涵蓋 open/close）`);

  const nonPositive = clean.filter((k) => !(k.close > 0));
  if (nonPositive.length) issues.push(`⚠ ${nonPositive.length} 根 K 棒的收盤價非正數`);

  return { candles: clean, issues, stepMs, gaps };
}
