/**
 * 全市場掃描結果的讀取與呈現
 *
 * 掃描本身跑在 GitHub Actions 上（scripts/market-scan.mjs），結果寫成 data/market.json。
 * 網站只負責讀檔與顯示，所以打開就有上百個交易對的分析，瀏覽器不必自己去打 API。
 */

import { fmtPrice, fmtAgo, escapeHtml } from '../core/utils.js';

/**
 * 掃描結果的位置：
 *  - GitHub Pages 上改讀 raw.githubusercontent.com，因為資料更新不會觸發網站重新部署，
 *    Pages 上那份會是舊的
 *  - 其他情況（本機開發）直接讀相對路徑
 */
export function marketDataUrl() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const { hostname, pathname } = location;
  if (hostname.endsWith('github.io')) {
    const owner = hostname.split('.')[0];
    const repo = pathname.split('/').filter(Boolean)[0];
    if (owner && repo) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/market.json${bust}`;
    }
  }
  return `data/market.json${bust}`;
}

export async function fetchMarket() {
  const res = await fetch(marketDataUrl(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const dirCls = (d) => (d === 'long' ? 'up' : 'down');

/**
 * 資金費率欄。極端值才上色 —— 平常這個數字只是背景資訊，
 * 只有在一面倒的時候才值得你多看一眼。
 */
function fundingCell(d, zh) {
  if (!d || !Number.isFinite(d.fundingRate)) return '<td class="mono tiny dim">—</td>';
  const pct = (d.fundingRate * 100).toFixed(3) + '%';
  const cls = d.fundingLevel === 'extreme' ? 'down' : d.fundingLevel === 'elevated' ? 'warn' : 'dim';
  const title = zh
    ? `${d.regimeZh}（年化 ${d.fundingAnnualPct ?? '—'}%，未平倉量 ${d.oiChangePct ?? '—'}%）`
    : `${d.regime} (annualised ${d.fundingAnnualPct ?? '—'}%)`;
  return `<td class="mono tiny ${cls}" title="${escapeHtml(title)}">${pct}</td>`;
}
const gradeCls = (g) => (g === 'A+' || g === 'A' ? 'up' : g === 'B' ? 'warn' : 'dim');

function rowHtml(r, lang) {
  const base = r.symbol.replace(/USDT$/, '');
  const dist = r.distancePct;
  return `<tr class="scan-row" data-symbol="${r.symbol}" data-interval="${r.interval}">
    <td><b>${base}</b></td>
    <td><span class="pill pill--sm pill--${r.grade === 'A+' || r.grade === 'A' ? 'up' : r.grade === 'B' ? 'warn' : 'flat'}">${r.grade}</span><span class="dim"> ${r.score}</span></td>
    <td class="${dirCls(r.dir)}">${r.dir === 'long' ? (lang === 'zh' ? '多' : 'L') : (lang === 'zh' ? '空' : 'S')}</td>
    <td class="mono">${fmtPrice(r.entry)}</td>
    <td class="mono down">${fmtPrice(r.stop)}</td>
    <td class="mono">${r.rr.toFixed(1)}R</td>
    <td class="tiny dim">${escapeHtml(r.poiType ?? '—')}</td>
    <td class="mono tiny ${Math.abs(dist) < 0.5 ? 'up' : 'dim'}">${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%</td>
    ${fundingCell(r.deriv, lang === 'zh')}
  </tr>`;
}

export function renderMarket(data, lang, filter = {}) {
  if (!data) return '';
  const zh = lang === 'zh';
  const minScore = filter.minScore ?? 0;
  const dirFilter = filter.dir ?? 'all';
  const pick = (status) =>
    data.rows.filter(
      (r) => r.status === status && r.valid && r.score >= minScore && (dirFilter === 'all' || r.dir === dirFilter),
    );
  const ready = pick('ready');
  const waiting = pick('waiting');

  const head = `<thead><tr>
    <th>${zh ? '幣種' : 'Symbol'}</th><th>${zh ? '評級' : 'Grade'}</th><th>${zh ? '方向' : 'Dir'}</th>
    <th>${zh ? '進場' : 'Entry'}</th><th>${zh ? '停損' : 'Stop'}</th><th>R:R</th>
    <th>POI</th><th>${zh ? '距現價' : 'Dist'}</th><th>${zh ? '費率' : 'Funding'}</th>
  </tr></thead>`;

  const table = (rows) =>
    rows.length
      ? `<div class="scroll-x"><table class="table table--compact table--scan">${head}<tbody>${rows.map((r) => rowHtml(r, lang)).join('')}</tbody></table></div>`
      : `<p class="dim pad">${zh ? '目前沒有符合條件的標的。' : 'Nothing matches right now.'}</p>`;

  return `
    <div class="market-head">
      <span class="dim">${zh ? '掃描' : 'Scanned'} ${data.universe} ${zh ? '個交易對' : 'pairs'} · ${data.interval}
        · ${zh ? '更新於' : 'updated'} ${fmtAgo(new Date(data.generatedAt).getTime())} ${zh ? '前' : 'ago'}</span>
    </div>

    <section class="card">
      <header class="card__head">
        <h3>🟢 ${zh ? '現在可進場' : 'Ready now'}</h3>
        <span class="pill pill--up">${ready.length}</span>
      </header>
      <p class="hint pad-x">${zh ? '價格已經在 POI 區間內，可以直接執行。' : 'Price is inside the POI — executable now.'}</p>
      ${table(ready)}
    </section>

    <section class="card">
      <header class="card__head">
        <h3>⏳ ${zh ? '等待回測' : 'Waiting'}</h3>
        <span class="pill pill--warn">${waiting.length}</span>
      </header>
      <p class="hint pad-x">${zh ? '計畫成立但價格還沒回到進場區 —— 掛限價單或設價格提醒。' : 'Plan is valid but price has not returned to the entry zone yet.'}</p>
      ${table(waiting.slice(0, 40))}
    </section>`;
}
