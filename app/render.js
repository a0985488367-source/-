/**
 * render — 純字串渲染，不碰 DOM
 *
 * 網頁版與 iPhone Scriptable 版共用同一份卡片標記，
 * 避免兩邊各寫一套後逐漸長歪。
 *
 * 這裡只負責把候選資料變成 HTML 字串。
 * 抓資料在各自的宿主環境做（瀏覽器用 fetch，Scriptable 用 Request）。
 */

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

export function priceDigits(p) {
  if (!Number.isFinite(p)) return 4;
  if (p >= 1000) return 1;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

export const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d ?? 4) : '—');
export const fpct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');

export function fusd(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

export const sgn = (v) => (Number.isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '');

export function ago(ts, now) {
  if (!ts) return '尚未掃描';
  const s = Math.max(0, Math.round(((now ?? Date.now()) - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  return Math.round(s / 60) + ' 分鐘前';
}

const STAGE_TEXT = {
  NEAR_BREAKOUT: '接近突破',
  BUILDING: '醞釀中',
  WATCH: '觀察',
  EXCLUDED: '已排除',
};

export function cardHtml(c) {
  const d = priceDigits(c.lastPrice);
  const stageClass = c.stage === 'NEAR_BREAKOUT' ? 'near' : c.stage === 'EXCLUDED' ? 'excl' : 'build';
  const dots = Array.from({ length: c.readiness.total }, (_, i) =>
    '<i class="dot' + (i < c.readiness.passed ? ' on' : '') + '"></i>').join('');

  const entryBlock = c.entryReady ? `
    <div class="entry">
      <div class="erow"><span>Entry 區</span><b>${fx(c.entryLow, d)} – ${fx(c.entryHigh, d)}</b></div>
      <div class="erow sl"><span>停損 SL</span><b>${fx(c.stopLoss, d)}</b></div>
      <div class="erow tp"><span>TP1 · 1.5R</span><b>${fx(c.takeProfit1, d)}</b></div>
      <div class="erow tp"><span>TP2 · 2.5R</span><b>${fx(c.takeProfit2, d)}</b></div>
      ${c.maxPositionUsd > 0 ? '<div class="erow"><span>盤口可承受</span><b>約 ' + fusd(c.maxPositionUsd) + ' USDT</b></div>' : ''}
    </div>` : '';

  const reasonBlock = c.blockingReasons.length
    ? '<div class="reasons">' + c.blockingReasons.map((r) => '<div>' + esc(r) + '</div>').join('') + '</div>'
    : '';

  const staleBlock = c.staleWarning
    ? '<div class="banner"><div class="bt">資料偏舊</div><div class="bd">此標的資料已 '
      + Math.round(c.dataAgeMinutes) + ' 分鐘未更新。</div></div>'
    : '';

  return `
  <div class="card ${c.entryReady ? 'ready' : ''} ${c.stage === 'EXCLUDED' ? 'excluded' : ''}">
    <div class="chead">
      <span class="sym">${esc(c.symbol)}</span>
      <span class="tag ${stageClass}">${STAGE_TEXT[c.stage] ?? esc(c.stage)}</span>
      ${c.riskLabel ? '<span class="tag meme">' + esc(c.riskLabel) + '</span>' : ''}
      <span class="score"><b>${c.score}</b><span>完成度</span></span>
    </div>

    <div class="readiness">
      <span class="dots">${dots}</span>
      <span class="rtext">進場條件 ${c.readiness.passed}/${c.readiness.total}</span>
    </div>

    ${entryBlock}
    ${reasonBlock}
    ${staleBlock}

    <div class="grid">
      <div class="cell"><span>現價</span><b>${fx(c.lastPrice, d)}</b></div>
      <div class="cell"><span>距突破點</span><b>${fpct(c.breakoutDistancePct)}</b></div>
      <div class="cell"><span>15m 壓縮比</span><b>${fx(c.compressionRatio, 3)}</b></div>
      <div class="cell"><span>量能倍率</span><b>${fx(c.volumeMultiple, 2)}x</b></div>
      <div class="cell"><span>OI 變化</span><b class="${sgn(c.oiChangePct)}">${fpct(c.oiChangePct)}</b></div>
      <div class="cell"><span>資金費率</span><b>${fx(c.fundingRatePct, 4)}%</b></div>
      <div class="cell"><span>1H / 6H</span><b><span class="${sgn(c.change1hPct)}">${fpct(c.change1hPct)}</span> / <span class="${sgn(c.change6hPct)}">${fpct(c.change6hPct)}</span></b></div>
      <div class="cell"><span>24H 成交額</span><b>${fusd(c.turnover24hUsd)}</b></div>
    </div>

    <div class="foot">
      <a href="${c.bybitUrl}" target="_blank" rel="noopener noreferrer">在 Bybit 開啟合約 ↗</a>
      <span class="noauto">僅供研究觀察 · 不自動下單</span>
    </div>
  </div>`;
}

/** 候選清單，含錯誤與空狀態 */
export function listHtml(state) {
  let html = '';

  if (state.error) {
    html += `<div class="banner err">
      <div class="bt">無法取得 Bybit 資料</div>
      <div class="bd">${esc(state.error)}</div>
    </div>`;
  }

  if (state.failed && state.failed.length) {
    html += `<div class="banner">
      <div class="bt">${state.failed.length} 檔標的資料抓取失敗</div>
      <div class="bd">${state.failed.map((f) => esc(f.symbol)).join('、')}</div>
    </div>`;
  }

  const candidates = state.candidates ?? [];
  const ready = candidates.filter((c) => c.entryReady);
  const watch = candidates.filter((c) => !c.entryReady);

  if (!candidates.length && !state.busy && state.scannedAt) {
    html += '<div class="empty">目前沒有符合條件的早期候選。<br>這是正常結果 —— 多數時間市場都不在壓縮待突破的狀態。</div>';
  }

  if (ready.length) html += '<h2>條件式 Entry · ' + ready.length + ' 檔</h2>' + ready.map(cardHtml).join('');
  if (watch.length) html += '<h2>觀察中 · ' + watch.length + ' 檔</h2>' + watch.map(cardHtml).join('');

  return html;
}

/** 掃描統計文字 */
export function statText(state) {
  if (!state.scannedAt || state.busy) return '';
  return `通過第一階段 ${state.universeCount} 檔，詳細分析 ${state.analyzedCount} 檔`;
}

export const DISCLAIMER_HTML = `
  <div class="disc">
    <b>使用前請務必了解</b>
    <ul>
      <li>本頁只讀取 Bybit 公開行情端點，<strong>不連接任何帳戶、不需要也不接受 API Key</strong>，並且<strong>永遠不會下單</strong>。</li>
      <li>完成度分數衡量的是「型態成熟程度」，<strong>不是勝率，也不是報酬預期</strong>。分數高不等於可以進場，必須十項進場條件全部通過。</li>
      <li>Entry、SL、TP 為依 1.5R 與 2.5R 機械換算的參考值，不是投資建議。實際下單前請自行確認盤口深度與可承受風險。</li>
      <li>迷因幣一律標記並套用固定 0.15% 防守倉，不因分數提高倉位。</li>
      <li>加密貨幣永續合約風險極高，可能損失全部本金。本工具不對任何結果作出保證。</li>
    </ul>
  </div>`;
