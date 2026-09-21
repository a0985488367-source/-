/**
 * 側邊分析面板的 HTML 產生器（純函式 → 易測試、易維護）
 */

import { fmtPrice, fmtNum, fmtPct, fmtCompact, escapeHtml, fmtTime } from '../core/utils.js';

const dirClass = (d) => (d === 'bull' || d === 'long' || d === 'bullish' ? 'up' : d === 'bear' || d === 'short' || d === 'bearish' ? 'down' : 'flat');

const STATE_LABEL = {
  zh: { fresh: '新鮮', tapped: '已回測', mitigated: '已消耗', breaker: '破壞塊', partial: '部分填補', filled: '已填補', inverted: '反轉 IFVG', zone: '區間' },
  en: { fresh: 'Fresh', tapped: 'Tapped', mitigated: 'Mitigated', breaker: 'Breaker', partial: 'Partial', filled: 'Filled', inverted: 'Inverted', zone: 'Zone' },
};

export function stateLabel(state, lang) {
  return (STATE_LABEL[lang] || STATE_LABEL.zh)[state] || state;
}

/* --------------------------------------------------------------- 偏向面板 */

export function renderBias(a, agg, lang) {
  if (!a || a.empty) return '';
  const b = a.bias;
  const pct = (b.score + 100) / 2;
  const label = lang === 'zh' ? b.labelZh : b.label;
  const factors = b.factors
    .slice(0, 6)
    .map(
      (f) => `<div class="factor">
        <span class="factor__name">${lang === 'zh' ? f.zh : f.en}${f.detail ? ` <em>${escapeHtml(String(f.detail))}</em>` : ''}</span>
        <span class="factor__bar"><i style="width:${Math.min(100, Math.abs(f.score) * 2.4)}%" class="${f.score >= 0 ? 'up' : 'down'}"></i></span>
        <span class="factor__val ${f.score >= 0 ? 'up' : 'down'}">${f.score >= 0 ? '+' : ''}${f.score.toFixed(0)}</span>
      </div>`,
    )
    .join('');

  return `
  <section class="card">
    <header class="card__head">
      <h3>${lang === 'zh' ? '市場偏向' : 'Market Bias'}</h3>
      <span class="pill pill--${dirClass(b.label)}">${label}</span>
    </header>
    <div class="bias-meter">
      <div class="bias-meter__track"><i style="left:${pct}%"></i></div>
      <div class="bias-meter__labels"><span>${lang === 'zh' ? '極空' : 'Bearish'}</span><span>${lang === 'zh' ? '中性' : 'Neutral'}</span><span>${lang === 'zh' ? '極多' : 'Bullish'}</span></div>
    </div>
    <div class="kv-grid">
      <div><span>${lang === 'zh' ? '偏向分數' : 'Bias score'}</span><b class="${dirClass(b.label)}">${b.score > 0 ? '+' : ''}${b.score}</b></div>
      <div><span>${lang === 'zh' ? '強度' : 'Strength'}</span><b>${b.strength}%</b></div>
      ${agg ? `<div><span>${lang === 'zh' ? '多週期一致性' : 'MTF alignment'}</span><b>${agg.alignment}%</b></div>
      <div><span>${lang === 'zh' ? '多週期分數' : 'MTF score'}</span><b class="${dirClass(agg.label)}">${agg.score > 0 ? '+' : ''}${agg.score}</b></div>` : ''}
    </div>
    <div class="factors">${factors}</div>
  </section>`;
}

/* --------------------------------------------------------------- 結構面板 */

export function renderStructure(a, lang) {
  if (!a || a.empty) return '';
  const sw = a.structure.swing;
  const it = a.structure.internal;
  const evRow = (e) => {
    if (!e) return `<span class="dim">—</span>`;
    return `<span class="pill pill--${dirClass(e.dir)} pill--sm">${e.type}</span> <span class="mono">${fmtPrice(e.price)}</span>`;
  };
  const pd = a.pd;
  return `
  <section class="card">
    <header class="card__head"><h3>${lang === 'zh' ? '市場結構' : 'Market Structure'}</h3>
      <span class="pill pill--${dirClass(sw.trendLabel)}">${trendText(sw.trendLabel, lang)}</span>
    </header>
    <div class="rows">
      <div class="row"><span>${lang === 'zh' ? '擺動結構（HTF 邏輯）' : 'Swing structure'}</span><b>${evRow(sw.lastEvent)}</b></div>
      <div class="row"><span>${lang === 'zh' ? '內部結構（進場邏輯）' : 'Internal structure'}</span><b>${evRow(it.lastEvent)}</b></div>
      <div class="row"><span>${lang === 'zh' ? '受保護高點' : 'Protected high'}</span><b class="mono">${sw.protectedHigh ? `${fmtPrice(sw.protectedHigh.price)} <em class="dim">${sw.protectedHigh.kind === 'strong' ? (lang === 'zh' ? '強' : 'strong') : (lang === 'zh' ? '弱' : 'weak')}</em>` : '—'}</b></div>
      <div class="row"><span>${lang === 'zh' ? '受保護低點' : 'Protected low'}</span><b class="mono">${sw.protectedLow ? `${fmtPrice(sw.protectedLow.price)} <em class="dim">${sw.protectedLow.kind === 'strong' ? (lang === 'zh' ? '強' : 'strong') : (lang === 'zh' ? '弱' : 'weak')}</em>` : '—'}</b></div>
      ${pd ? `<div class="row"><span>${lang === 'zh' ? '區間位置' : 'Range position'}</span><b>
        <span class="pill pill--sm ${pd.zone === 'premium' ? 'pill--down' : pd.zone === 'discount' ? 'pill--up' : 'pill--flat'}">${zoneText(pd.zone, lang)} ${pd.pct.toFixed(1)}%</span></b></div>
      <div class="range-bar"><i style="left:${Math.max(0, Math.min(100, pd.pct))}%"></i>
        <span class="range-bar__eq"></span>
        <label class="lo">${fmtPrice(pd.low)}</label><label class="hi">${fmtPrice(pd.high)}</label>
      </div>` : ''}
      ${a.inducement ? `<div class="row"><span>IDM ${lang === 'zh' ? '誘導' : 'Inducement'}</span><b class="mono">${fmtPrice(a.inducement.price)} ${a.inducement.taken ? '<span class="pill pill--sm pill--flat">✓</span>' : `<span class="pill pill--sm pill--warn">${lang === 'zh' ? '未取' : 'pending'}</span>`}</b></div>` : ''}
    </div>
  </section>`;
}

const trendText = (t, lang) =>
  lang === 'zh' ? (t === 'bullish' ? '多頭趨勢' : t === 'bearish' ? '空頭趨勢' : '盤整') : t;
const zoneText = (z, lang) =>
  lang === 'zh' ? (z === 'premium' ? '溢價' : z === 'discount' ? '折價' : '均衡') : z;

/* ------------------------------------------------------------------ POI */

export function renderPois(a, lang, limit = 8) {
  if (!a || a.empty) return '';
  const rows = a.pois.slice(0, limit).map((p) => {
    const d = p.distancePct;
    return `<tr data-poi="${escapeHtml(p.id)}" class="${p.aligned ? '' : 'muted'}">
      <td><span class="dot ${dirClass(p.dir)}"></span>${p.type}${p.scale === 'swing' ? '<sup>HTF</sup>' : ''}</td>
      <td class="mono">${fmtPrice(p.bottom)}<span class="dim"> – </span>${fmtPrice(p.top)}</td>
      <td class="mono ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</td>
      <td><span class="pill pill--sm ${p.state === 'fresh' ? 'pill--up' : p.state === 'mitigated' ? 'pill--flat' : 'pill--warn'}">${stateLabel(p.state, lang)}</span></td>
      <td class="mono"><b>${Math.round(p.score)}</b></td>
    </tr>`;
  }).join('');
  return `
  <section class="card">
    <header class="card__head"><h3>${lang === 'zh' ? '興趣點 POI（依優先度）' : 'Points of Interest'}</h3>
      <span class="dim">${a.pois.length}</span></header>
    <table class="table table--compact">
      <thead><tr>
        <th>${lang === 'zh' ? '類型' : 'Type'}</th><th>${lang === 'zh' ? '區間' : 'Zone'}</th>
        <th>${lang === 'zh' ? '距離' : 'Dist'}</th><th>${lang === 'zh' ? '狀態' : 'State'}</th><th>${lang === 'zh' ? '品質' : 'Score'}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="dim">—</td></tr>`}</tbody>
    </table>
  </section>`;
}

/* ------------------------------------------------------------- 流動性面板 */

export function renderLiquidity(a, lang) {
  if (!a || a.empty) return '';
  const lb = a.liqBias;
  const mk = (p) => `<li><span class="mono">${fmtPrice(p.price)}</span>
    <span class="dim">${p.equal ? (p.side === 'buyside' ? 'EQH' : 'EQL') : (lang === 'zh' ? '擺動' : 'swing')} ×${p.touches}</span>
    <span class="bar"><i style="width:${Math.min(100, p.strength)}%"></i></span></li>`;
  const above = a.liq.above.slice(0, 5).map(mk).join('');
  const below = a.liq.below.slice(0, 5).map(mk).join('');
  const sweeps = a.sweeps.slice(-3).reverse().map((s) => `
    <div class="row"><span>${s.side === 'buyside' ? (lang === 'zh' ? '掃買方（前高）' : 'Buy-side sweep') : (lang === 'zh' ? '掃賣方（前低）' : 'Sell-side sweep')}</span>
    <b class="mono ${dirClass(s.dir)}">${fmtPrice(s.level)} · ${s.depthAtr.toFixed(2)} ATR</b></div>`).join('');
  return `
  <section class="card">
    <header class="card__head"><h3>${lang === 'zh' ? '流動性地圖' : 'Liquidity Map'}</h3>
      <span class="pill pill--sm ${lb.bias === 'buyside' ? 'pill--up' : lb.bias === 'sellside' ? 'pill--down' : 'pill--flat'}">
        ${lang === 'zh' ? (lb.bias === 'buyside' ? '上方吸引' : lb.bias === 'sellside' ? '下方吸引' : '均衡') : lb.bias}</span>
    </header>
    <div class="liq-split">
      <div><h4 class="up">${lang === 'zh' ? '上方 買方流動性 BSL' : 'Above · BSL'}</h4><ul class="liq">${above || '<li class="dim">—</li>'}</ul></div>
      <div><h4 class="down">${lang === 'zh' ? '下方 賣方流動性 SSL' : 'Below · SSL'}</h4><ul class="liq">${below || '<li class="dim">—</li>'}</ul></div>
    </div>
    ${sweeps ? `<div class="rows rows--tight">${sweeps}</div>` : ''}
  </section>`;
}

/* ---------------------------------------------------------------- 交易計畫 */

export function renderSetup(a, lang, risk) {
  if (!a || a.empty) return '';
  const s = a.setup;
  if (s?.none) {
    return `<section class="card card--setup"><header class="card__head"><h3>${lang === 'zh' ? '交易計畫' : 'Trade Plan'}</h3>
      <span class="pill pill--flat">${lang === 'zh' ? '暫無計畫' : 'Standby'}</span></header>
      <p class="pad dim" style="line-height:1.7">${escapeHtml(lang === 'zh' ? s.reasonZh : s.reasonEn)}</p></section>`;
  }
  if (!s) {
    return `<section class="card card--setup"><header class="card__head"><h3>${lang === 'zh' ? '交易計畫' : 'Trade Plan'}</h3></header>
      <p class="dim pad">${lang === 'zh' ? '目前沒有符合條件的計畫，請等待價格進入 POI 或結構明朗。' : 'No qualifying setup right now.'}</p></section>`;
  }
  const checks = s.checklist.map((c) => `<li class="${c.ok ? 'ok' : 'no'}">
    <span class="tick">${c.ok ? '✓' : '✕'}</span>${lang === 'zh' ? c.zh : c.en}<em>${c.weight}</em></li>`).join('');
  const tps = s.targets.map((t) => `<div class="row"><span>${t.name} <em class="dim">${lang === 'zh' ? t.label : t.labelEn}</em></span>
    <b class="mono up">${fmtPrice(t.price)} <span class="dim">${t.rr.toFixed(2)}R</span></b></div>`).join('');
  const notes = (lang === 'zh' ? s.notes.zh : s.notes.en).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const pos = risk || null;
  return `
  <section class="card card--setup ${s.dir}">
    <header class="card__head">
      <h3>${lang === 'zh' ? '交易計畫' : 'Trade Plan'}</h3>
      <span class="head-actions">
        <button class="btn btn--sm" data-copy-setup>${lang === 'zh' ? '複製計畫' : 'Copy'}</button>
        <span class="grade grade--${s.grade.replace('+', 'plus')}">${s.grade}</span>
      </span>
    </header>
    ${s.valid ? '' : `<p class="setup-warn">⚠ ${lang === 'zh'
      ? '此計畫未達標準（評分或風報比不足），僅供觀察，不建議執行。'
      : 'Below threshold (score or R:R) — observation only, not a tradable plan.'}</p>`}
    <div class="setup-top">
      <span class="pill pill--${s.dir === 'long' ? 'up' : 'down'} pill--lg">${s.dir === 'long' ? (lang === 'zh' ? '做多 LONG' : 'LONG') : (lang === 'zh' ? '做空 SHORT' : 'SHORT')}</span>
      <div class="setup-score"><b>${s.score}</b><span>/100</span></div>
      <div class="setup-rr"><b>${s.rrFinal.toFixed(2)}R</b><span>${lang === 'zh' ? '最終風報比' : 'final R:R'}</span></div>
    </div>
    <div class="rows">
      <div class="row"><span>${lang === 'zh' ? '進場方式' : 'Entry type'}</span><b>${s.entryType === 'market' ? (lang === 'zh' ? '已在區間內（可市價/掛單）' : 'Inside zone') : (lang === 'zh' ? '限價等待回測' : 'Limit at POI')}</b></div>
      <div class="row"><span>${lang === 'zh' ? '進場區' : 'Entry zone'}</span><b class="mono">${fmtPrice(s.entryZone.bottom)} – ${fmtPrice(s.entryZone.top)}</b></div>
      <div class="row"><span>${lang === 'zh' ? '參考進場' : 'Entry'}</span><b class="mono entry">${fmtPrice(s.entry)}</b></div>
      <div class="row"><span>${lang === 'zh' ? '停損' : 'Stop loss'}</span><b class="mono down">${fmtPrice(s.stop)} <span class="dim">(${s.riskPct.toFixed(2)}%)</span></b></div>
      ${tps}
      <div class="row"><span>POI</span><b>${s.poi.type} <span class="dim">${stateLabel(s.poi.state, lang)}</span></b></div>
    </div>
    ${pos ? `<div class="rows rows--tight risk-box">
      <div class="row"><span>${lang === 'zh' ? '風險金額' : 'Risk amount'}</span><b class="mono">${fmtNum(pos.riskAmount)} USDT</b></div>
      <div class="row"><span>${lang === 'zh' ? '部位大小' : 'Position size'}</span><b class="mono">${fmtNum(pos.qty, 4)}</b></div>
      <div class="row"><span>${lang === 'zh' ? '名目價值' : 'Notional'}</span><b class="mono">${fmtNum(pos.notional)} USDT</b></div>
    </div>` : ''}
    <details class="checklist" open>
      <summary>${lang === 'zh' ? '匯流檢查表' : 'Confluence checklist'} <span class="dim">${s.checklist.filter((c) => c.ok).length}/${s.checklist.length}</span></summary>
      <ul>${checks}</ul>
    </details>
    <details class="notes">
      <summary>${lang === 'zh' ? '劇本說明與失效條件' : 'Narrative & invalidation'}</summary>
      <ul>${notes}</ul>
      <p class="invalid">⚠ ${lang === 'zh' ? s.invalidation : s.invalidationEn}</p>
    </details>
  </section>`;
}

/* ------------------------------------------------------------- MTF 表格 */

export function renderMtf(rows, agg, lang) {
  if (!rows?.length) return '';
  const body = rows.map((r) => `
    <tr>
      <td><b>${r.interval}</b></td>
      <td><span class="pill pill--sm pill--${dirClass(r.bias.label)}">${lang === 'zh' ? r.bias.labelZh : r.bias.label}</span></td>
      <td class="mono ${r.bias.score >= 0 ? 'up' : 'down'}">${r.bias.score > 0 ? '+' : ''}${r.bias.score}</td>
      <td>${r.structure?.swing?.lastEvent ? `<span class="tiny ${dirClass(r.structure.swing.lastEvent.dir)}">${r.structure.swing.lastEvent.type}</span>` : '<span class="dim">—</span>'}</td>
      <td>${r.pd ? `<span class="tiny">${zoneText(r.pd.zone, lang)} ${r.pd.pct.toFixed(0)}%</span>` : '<span class="dim">—</span>'}</td>
      <td>${r.setup && !r.setup.none ? `<span class="tiny ${dirClass(r.setup.dir)}">${r.setup.grade} · ${r.setup.rrFinal.toFixed(1)}R</span>` : '<span class="dim">—</span>'}</td>
    </tr>`).join('');
  return `
  <section class="card">
    <header class="card__head"><h3>${lang === 'zh' ? '多週期矩陣' : 'Multi-Timeframe Matrix'}</h3>
      ${agg ? `<span class="pill pill--${dirClass(agg.label)}">${lang === 'zh' ? agg.labelZh : agg.label} ${agg.alignment}%</span>` : ''}</header>
    <table class="table table--compact">
      <thead><tr><th>TF</th><th>${lang === 'zh' ? '偏向' : 'Bias'}</th><th>${lang === 'zh' ? '分數' : 'Score'}</th><th>${lang === 'zh' ? '結構' : 'Struct'}</th><th>${lang === 'zh' ? '區間' : 'Range'}</th><th>${lang === 'zh' ? '計畫' : 'Plan'}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

/* ------------------------------------------------------------- 關鍵價位 */

export function renderKeyLevels(a, lang) {
  if (!a || a.empty || !a.keyLevels.length) return '';
  const price = a.price;
  const rows = [...a.keyLevels]
    .sort((x, y) => y.price - x.price)
    .map((l) => `<div class="row"><span><i class="swatch" style="background:${l.color}"></i>${l.code} · ${lang === 'zh' ? l.zh : l.en}</span>
      <b class="mono ${l.price > price ? 'up' : 'down'}">${fmtPrice(l.price)} <span class="dim">${(((l.price - price) / price) * 100).toFixed(2)}%</span></b></div>`).join('');
  return `<section class="card"><header class="card__head"><h3>${lang === 'zh' ? '關鍵時間價位' : 'Key Levels'}</h3></header><div class="rows rows--tight">${rows}</div></section>`;
}

/* ---------------------------------------------------------------- 滑鼠提示 */

export function renderHoverTip(hits, lang) {
  if (!hits?.length) return '';
  return hits.map((h) => {
    const d = h.data;
    if (h.type === 'orderblock') {
      return `<div class="tip__block"><b class="${dirClass(d.state === 'breaker' ? d.breakerDir : d.dir)}">${d.state === 'breaker' ? 'Breaker Block' : 'Order Block'} ${d.scale === 'swing' ? '(HTF)' : ''}</b>
        <div>${fmtPrice(d.bottom)} – ${fmtPrice(d.top)}</div>
        <div class="dim">${lang === 'zh' ? '成因' : 'Cause'}: ${d.causedBy} · ${lang === 'zh' ? '位移' : 'Disp'} ${d.displacementAtr.toFixed(2)} ATR · RVOL ${fmtNum(d.rvol, 2)}</div>
        <div class="dim">${lang === 'zh' ? '狀態' : 'State'}: ${stateLabel(d.state, lang)} · ${lang === 'zh' ? '消耗' : 'Mitigated'} ${(d.mitigationPct * 100).toFixed(0)}% · ${lang === 'zh' ? '品質' : 'Score'} ${d.score}</div>
        ${d.containsFvg ? `<div class="up">✓ ${lang === 'zh' ? '內含 FVG（高機率）' : 'Contains FVG'}</div>` : ''}
        ${d.sweptBefore ? `<div class="up">✓ ${lang === 'zh' ? '形成前掃流動性' : 'Swept liquidity first'}</div>` : ''}</div>`;
    }
    if (h.type === 'fvg') {
      return `<div class="tip__block"><b class="${dirClass(d.state === 'inverted' ? d.invertedDir : d.dir)}">${d.state === 'inverted' ? 'Inversion FVG' : d.kind === 'vi' ? 'Volume Imbalance' : 'Fair Value Gap'}</b>
        <div>${fmtPrice(d.bottom)} – ${fmtPrice(d.top)}</div>
        <div class="dim">CE ${fmtPrice(d.mid)} · ${lang === 'zh' ? '大小' : 'Size'} ${d.sizeAtr.toFixed(2)} ATR · ${lang === 'zh' ? '填補' : 'Filled'} ${(d.fill * 100).toFixed(0)}%</div>
        <div class="dim">${lang === 'zh' ? '狀態' : 'State'}: ${stateLabel(d.state, lang)} · ${lang === 'zh' ? '品質' : 'Score'} ${d.score}</div></div>`;
    }
    if (h.type === 'liquidity') {
      return `<div class="tip__block"><b class="${d.side === 'buyside' ? 'up' : 'down'}">${d.side === 'buyside' ? (lang === 'zh' ? '買方流動性 BSL' : 'Buy-side liquidity') : (lang === 'zh' ? '賣方流動性 SSL' : 'Sell-side liquidity')}</b>
        <div>${fmtPrice(d.price)} ${d.equal ? (d.side === 'buyside' ? '· EQH' : '· EQL') : ''}</div>
        <div class="dim">${lang === 'zh' ? '觸及' : 'Touches'} ${d.touches} · ${d.swept ? (lang === 'zh' ? '已掃除' : 'swept') : (lang === 'zh' ? '未觸及' : 'untapped')}</div></div>`;
    }
    return '';
  }).join('');
}

/* ------------------------------------------------------------ 市場快照列 */

export function renderTicker(ticker, a, lang, interval) {
  if (!ticker) return '';
  const chg = ticker.change ?? 0;
  const atrPct = a && !a.empty ? (a.atrValue / a.price) * 100 : null;
  return `
    <span class="tk__price ${chg >= 0 ? 'up' : 'down'}">${fmtPrice(ticker.price)}</span>
    <span class="tk__chg ${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>
    <span class="tk__item"><i>24h H</i>${fmtPrice(ticker.high)}</span>
    <span class="tk__item"><i>24h L</i>${fmtPrice(ticker.low)}</span>
    <span class="tk__item"><i>VOL</i>${fmtCompact(ticker.quoteVolume)}</span>
    ${atrPct != null ? `<span class="tk__item"><i>ATR(14)</i>${atrPct.toFixed(2)}%</span>` : ''}
    ${a && !a.empty && a.currentSession ? `<span class="tk__item tk__session"><i>${lang === 'zh' ? '時段' : 'Session'}</i>${lang === 'zh' ? a.currentSession.nameZh : a.currentSession.name}</span>` : ''}
  `;
}

/**
 * 資金費率與未平倉量。
 *
 * 這一區刻意放在交易計畫底下：它不決定要不要進場，
 * 而是告訴你「現在跟你站同一邊的人多不多」。
 */
export function renderDerivatives(d, lang) {
  const zh = lang === 'zh';
  if (!d) return '';
  if (d.error) {
    return `<section class="card"><header class="card__head"><h3>${zh ? '資金費率 · 未平倉量' : 'Funding · Open Interest'}</h3>
      <span class="pill pill--flat">${zh ? '無資料' : 'No data'}</span></header>
      <p class="pad dim">${escapeHtml(zh ? '這個幣種在幾家交易所上都沒有永續合約，或資料暫時取不到。' : 'No perpetual data available.')}</p></section>`;
  }

  const { funding, regime, fundingAnnualPct, notes, notesEn, raw, countdown } = d;
  const rate = raw?.fundingRate;
  const pillClass = funding.level === 'extreme' ? 'pill--down' : funding.level === 'elevated' ? 'pill--warn' : 'pill--flat';
  const qualityClass = regime.quality === 'healthy' ? 'up' : regime.quality === 'weak' ? 'down' : '';
  const list = zh ? notes : notesEn;

  return `<section class="card"><header class="card__head">
      <h3>${zh ? '資金費率 · 未平倉量' : 'Funding · Open Interest'}</h3>
      <span class="pill ${pillClass}">${escapeHtml(funding.level === 'neutral' ? (zh ? '中性' : 'Neutral')
        : funding.level === 'extreme' ? (zh ? '極端' : 'Extreme')
        : funding.level === 'elevated' ? (zh ? '偏高' : 'Elevated') : (zh ? '輕微' : 'Mild'))}</span>
    </header>
    <div class="rows">
      <div class="row"><span>${zh ? '資金費率（每 8 小時）' : 'Funding (8h)'}</span>
        <b class="${rate > 0 ? 'up' : rate < 0 ? 'down' : ''}">${Number.isFinite(rate) ? (rate * 100).toFixed(4) + '%' : '—'}</b></div>
      <div class="row"><span>${zh ? '年化' : 'Annualised'}</span>
        <b>${Number.isFinite(fundingAnnualPct) ? fundingAnnualPct.toFixed(1) + '%' : '—'}</b></div>
      ${countdown ? `<div class="row"><span>${zh ? '下次收取' : 'Next funding'}</span><b>${escapeHtml(zh ? countdown.zh : countdown.en)}</b></div>` : ''}
      <div class="row"><span>${zh ? '未平倉量變化' : 'OI change'}</span>
        <b class="${d.oiChangePct > 0 ? 'up' : d.oiChangePct < 0 ? 'down' : ''}">${Number.isFinite(d.oiChangePct) ? (d.oiChangePct > 0 ? '+' : '') + d.oiChangePct.toFixed(2) + '%' : '—'}</b></div>
    </div>
    <div class="deriv-regime">
      <span class="deriv-regime__label">${zh ? '持倉結構' : 'Structure'}</span>
      <b class="${qualityClass}">${escapeHtml(zh ? regime.zh : regime.en)}</b>
    </div>
    ${list?.length ? `<ul class="deriv-notes">${list.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    <p class="pad dim small">${escapeHtml(zh
      ? `資料來源：${raw?.provider ?? '—'}。費率為正代表多方付錢給空方（做多的人比較多）。擁擠的那一邊，停損就掛在反方向 —— 那裡常常就是下一次被掃的流動性。`
      : `Source: ${raw?.provider ?? '—'}. Positive funding means longs pay shorts.`)}</p>
  </section>`;
}
