/**
 * 市場掃描器：一次分析多個幣種，找出「現在最值得看」的標的。
 * 排序依據：計畫評分 → 風報比 → 與 POI 的距離。
 */

import { analyze } from '../smc/engine.js';
import { fmtPrice, fmtPct, fmtNum } from '../core/utils.js';

export async function runScan(feed, { symbols, interval, settings, limit = 260, concurrency = 4, onProgress }) {
  const results = [];
  let done = 0;
  const queue = [...symbols];

  async function worker() {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const candles = await feed.getCandles(symbol, interval, limit);
        const a = analyze(candles, settings);
        if (!a.empty) {
          results.push({
            symbol,
            price: a.price,
            bias: a.bias,
            setup: a.setup,
            pd: a.pd,
            structure: a.structure.swing.trendLabel,
            lastEvent: a.structure.internal.lastEvent,
            sweep: a.sweeps[a.sweeps.length - 1] || null,
            nearestPoi: a.pois[0] || null,
            changePct: ((a.price - candles[Math.max(0, candles.length - 96)].close) / candles[Math.max(0, candles.length - 96)].close) * 100,
          });
        }
      } catch (e) {
        results.push({ symbol, error: e?.message || String(e) });
      }
      done++;
      onProgress?.({ done, total: symbols.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return results.sort(byScore);
}

const byScore = (a, b) => (b.setup?.score ?? -1) - (a.setup?.score ?? -1);

export function renderScanTable(rows, lang) {
  if (!rows.length) return `<p class="dim pad">${lang === 'zh' ? '尚未掃描。' : 'No scan yet.'}</p>`;
  const body = rows.map((r) => {
    if (r.error) return `<tr class="muted"><td>${r.symbol}</td><td colspan="7" class="dim">${r.error}</td></tr>`;
    const s = r.setup && !r.setup.none ? r.setup : null;
    const dirCls = s ? (s.dir === 'long' ? 'up' : 'down') : 'flat';
    return `<tr data-symbol="${r.symbol}" class="scan-row">
      <td><b>${r.symbol.replace('USDT', '')}</b><span class="dim">/USDT</span></td>
      <td class="mono">${fmtPrice(r.price)}</td>
      <td class="mono ${r.changePct >= 0 ? 'up' : 'down'}">${fmtPct(r.changePct)}</td>
      <td><span class="pill pill--sm pill--${r.bias.label === 'bullish' ? 'up' : r.bias.label === 'bearish' ? 'down' : 'flat'}">${lang === 'zh' ? r.bias.labelZh : r.bias.label}</span></td>
      <td>${r.pd ? `<span class="tiny">${r.pd.pct.toFixed(0)}%</span>` : '—'}</td>
      <td>${s ? `<span class="pill pill--sm pill--${dirCls}">${s.dir === 'long' ? 'L' : 'S'}</span>` : '<span class="dim">—</span>'}</td>
      <td class="mono">${s ? s.rrFinal.toFixed(2) + 'R' : '—'}</td>
      <td class="mono"><b class="${s && s.score >= 68 ? 'up' : ''}">${s ? s.score : '—'}</b>${s ? ` <span class="dim">${s.grade}</span>` : ''}</td>
    </tr>`;
  }).join('');
  return `<table class="table table--scan">
    <thead><tr>
      <th>${lang === 'zh' ? '幣種' : 'Symbol'}</th><th>${lang === 'zh' ? '價格' : 'Price'}</th><th>24×15m</th>
      <th>${lang === 'zh' ? '偏向' : 'Bias'}</th><th>${lang === 'zh' ? '區間' : 'Range'}</th>
      <th>${lang === 'zh' ? '方向' : 'Dir'}</th><th>R:R</th><th>${lang === 'zh' ? '評分' : 'Score'}</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}
