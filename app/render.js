/**
 * render — 純字串渲染，不碰 DOM
 *
 * 網頁版與 iPhone Scriptable 版共用同一份卡片標記，
 * 避免兩邊各寫一套後逐漸長歪。
 *
 * 這裡只負責把候選資料變成 HTML 字串。
 * 抓資料在各自的宿主環境做（瀏覽器用 fetch，Scriptable 用 Request）。
 */

import { ago, fmoney, fpct, fusd, fx, priceDigits, sgn } from './format.js';

export { ago, fpct, fusd, fx, priceDigits, sgn };

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

/** 逸出後把換行轉成 <br>，給診斷訊息這種多行文字用 */
export const escMultiline = (s) => esc(s).replace(/\r?\n/g, '<br>');

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

/* ------------------------------------------------------------------ */
/* 帳戶面板（唯讀）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 帳戶摘要與持倉。
 * 全部來自 Bybit 唯讀端點，本工具不會下單也不會改單。
 */
export function accountHtml(account) {
  if (!account) return '';

  if (account.error) {
    return `<h2>Bybit 帳戶</h2>
      <div class="banner err">
        <div class="bt">無法讀取帳戶資料</div>
        <div class="bd">${escMultiline(account.error)}</div>
      </div>`;
  }

  const w = account.wallet;
  const positions = account.positions ?? [];
  const today = account.todayPnl;

  const walletBlock = w ? `
    <div class="grid">
      <div class="cell"><span>總權益</span><b>${fmoney(w.totalEquityUsd)} USDT</b></div>
      <div class="cell"><span>可用</span><b>${fmoney(w.totalAvailableUsd)} USDT</b></div>
      <div class="cell"><span>未實現</span><b class="${sgn(w.unrealizedPnlUsd)}">${fmoney(w.unrealizedPnlUsd)}</b></div>
      <div class="cell"><span>今日已實現</span><b class="${sgn(today?.total)}">${fmoney(today?.total)}</b></div>
    </div>` : '';

  const posBlocks = positions.length
    ? positions.map((p) => {
        const prot = p.protection ?? { level: 'danger', text: '未知' };
        const d = priceDigits(p.entryPrice);
        return `
        <div class="card ${prot.level === 'ok' ? '' : 'excluded'}">
          <div class="chead">
            <span class="sym">${esc(p.symbol)}</span>
            <span class="tag ${p.side === 'long' ? 'near' : 'excl'}">${p.side === 'long' ? '▲ 多' : '▼ 空'}</span>
            <span class="tag ${prot.level === 'ok' ? 'build' : 'meme'}">${esc(prot.text)}</span>
            <span class="score"><b class="${sgn(p.unrealizedPnl)}">${fmoney(p.unrealizedPnl)}</b><span>未實現</span></span>
          </div>
          <div class="grid">
            <div class="cell"><span>進場</span><b>${fx(p.entryPrice, d)}</b></div>
            <div class="cell"><span>標記價</span><b>${fx(p.markPrice, d)}</b></div>
            <div class="cell"><span>數量</span><b>${fx(p.size, 4)}</b></div>
            <div class="cell"><span>槓桿</span><b>${fx(p.leverage, 0)}x</b></div>
            <div class="cell"><span>TP</span><b>${p.takeProfit > 0 ? fx(p.takeProfit, d) : '未設定'}</b></div>
            <div class="cell"><span>SL</span><b>${p.stopLoss > 0 ? fx(p.stopLoss, d) : '未設定'}</b></div>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">目前沒有持倉。</div>';

  return `<h2>Bybit 帳戶 · 唯讀</h2>
    <div class="card">
      <div class="chead">
        <span class="sym">帳戶摘要</span>
        <span class="tag build">${esc(account.keyMask ?? '已連接')}</span>
        <span class="noauto" style="margin-left:auto">唯讀 · 不會下單</span>
      </div>
      ${walletBlock}
    </div>
    ${posBlocks}`;
}

/* ------------------------------------------------------------------ */
/* 候選分區                                                             */
/* ------------------------------------------------------------------ */

function sectionHtml(title, subtitle, candidates, emptyText) {
  if (!candidates.length) {
    return `<h2>${title}</h2><div class="empty">${emptyText}</div>`;
  }
  const ready = candidates.filter((c) => c.entryReady);
  const watch = candidates.filter((c) => !c.entryReady);

  let html = `<h2>${title} · ${candidates.length} 檔</h2>`;
  if (subtitle) html += `<div class="note" style="margin:0 0 10px">${subtitle}</div>`;
  if (ready.length) {
    html += `<div class="subhead">符合全部進場條件 · ${ready.length} 檔</div>` + ready.map(cardHtml).join('');
  }
  if (watch.length) {
    html += `<div class="subhead">觀察中 · ${watch.length} 檔</div>` + watch.map(cardHtml).join('');
  }
  return html;
}

/** 候選清單，含錯誤與空狀態 */
export function listHtml(state) {
  let html = '';

  if (state.error) {
    html += `<div class="banner err">
      <div class="bt">無法取得 Bybit 資料</div>
      <div class="bd">${escMultiline(state.error)}</div>
    </div>`;
  }

  if (state.failed && state.failed.length) {
    html += `<div class="banner">
      <div class="bt">${state.failed.length} 檔標的資料抓取失敗</div>
      <div class="bd">${state.failed.map((f) => esc(f.symbol)).join('、')}</div>
    </div>`;
  }

  html += accountHtml(state.account);

  const groups = state.groups ?? { main: [], meme: [] };

  if (!state.busy && state.scannedAt) {
    html += sectionHtml(
      '主幣',
      '固定觀察清單，不論是否符合快噴型態都會顯示目前狀態。',
      groups.main,
      '主幣資料尚未取得。',
    );
    html += sectionHtml(
      '迷因幣／高風險',
      '一律套用固定 0.15% 防守倉，不因分數提高倉位。判斷不出來的標的也歸在這一區。',
      groups.meme,
      '目前沒有符合條件的候選。多數時間市場都不在壓縮待突破的狀態。',
    );
  }

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
