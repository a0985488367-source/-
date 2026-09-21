/**
 * Bybit 下單面板
 *
 * 安全邊界（這一頁最重要的部分）：
 *  - API 金鑰只寫進這台裝置的 localStorage，不會上傳、不會進倉庫，
 *    也不會出現在任何推播裡。換一台裝置就要重新填。
 *  - 模擬盤與實盤各自存一組金鑰，切換時不會互相沿用。
 *  - 實盤下單需要額外打字確認，而且按鈕會變成紅色。
 *  - 任何一張進場單都一定同時帶停損；沒有停損就不送出。
 */

import { $, setHTML, toast } from './dom.js';
import { createClient, explainError, planToOrder, roundTick, MODE_LABELS, isRealMoney } from '../exchange/bybit.js';

const KEY_STORE = 'smc-terminal:bybit';

/** 金鑰存在瀏覽器本機。這裡刻意不加密：加密金鑰也得存在同一台機器，
 *  只是讓人誤以為更安全。真正的防護是「不要在公用裝置上填」與「不要開提領權限」。 */
export function loadKeys() {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    const v = raw ? JSON.parse(raw) : {};
    return { mode: v.mode ?? 'demo', demo: v.demo ?? {}, testnet: v.testnet ?? {}, live: v.live ?? {} };
  } catch { return { mode: 'demo', demo: {}, testnet: {}, live: {} }; }
}

export function saveKeys(v) {
  try { localStorage.setItem(KEY_STORE, JSON.stringify(v)); } catch { /* 隱私模式下會失敗，忽略 */ }
}

export function clearKeys(mode) {
  const v = loadKeys();
  v[mode] = {};
  saveKeys(v);
}

/** 顯示目前實際會連到哪個網址 —— 環境選錯是這一頁最常見的問題 */
const escapeHost = (mode) => ({ demo: 'api-demo.bybit.com', testnet: 'api-testnet.bybit.com', live: 'api.bybit.com' }[mode] ?? '—');

const money = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

/**
 * @param {object} deps { getPlan, getSymbol, getRisk, lang }
 */
export function createTradePanel(deps) {
  let keys = loadKeys();
  let client = null;
  let instrument = null;
  let lastQuote = null;
  let liveArmed = false;

  const isZh = () => deps.lang() === 'zh';
  const cur = () => keys[keys.mode] ?? {};
  const isLive = () => isRealMoney(keys.mode);

  function build() {
    if (!client && cur().apiKey && cur().apiSecret) {
      client = createClient({ apiKey: cur().apiKey, apiSecret: cur().apiSecret, mode: keys.mode });
    }
    return client;
  }

  function render() {
    const k = cur();
    const connected = !!(k.apiKey && k.apiSecret);
    setHTML('#tradeBody', `
      <div class="card">
        <header class="card__head"><h3>${isZh() ? '帳戶' : 'Account'}</h3>
          <span class="pill ${isLive() ? 'pill--down' : 'pill--up'}">${isLive() ? (isZh() ? '實盤 · 真錢' : 'LIVE · real money') : (isZh() ? '模擬盤' : 'Testnet')}</span>
        </header>
        <div class="seg seg--full" id="tradeMode">
          ${['demo', 'testnet', 'live'].map((m) => `<button data-mode="${m}" class="${keys.mode === m ? 'active' : ''}">${isZh() ? MODE_LABELS[m].zh : MODE_LABELS[m].en}</button>`).join('')}
        </div>
        <p class="muted small">${isZh() ? MODE_LABELS[keys.mode].hint.zh : MODE_LABELS[keys.mode].hint.en}
          · <span class="mono tiny">${escapeHost(keys.mode)}</span></p>
        <p class="muted small">${isZh()
          ? '⚠️ <b>模擬交易</b>與<b>測試網</b>是 Bybit 兩套獨立系統，金鑰不能互通 —— 選錯會出現「API Key 無效」。<br>金鑰只會存在這支手機／這個瀏覽器裡，不會上傳到任何地方。申請時請<b>只勾 Unified Trading — Trade</b>，<b>絕對不要勾提領（Withdraw）</b>。'
          : 'Demo and Testnet are separate systems — keys are not interchangeable. Keys stay in this browser. Grant Trade only, never Withdraw.'}</p>
        <div class="form-row"><label>API Key</label><input id="bbKey" class="input" type="password" autocomplete="off" value="${k.apiKey ?? ''}" /></div>
        <div class="form-row"><label>API Secret</label><input id="bbSecret" class="input" type="password" autocomplete="off" value="${k.apiSecret ?? ''}" /></div>
        <div class="btn-row">
          <button class="btn btn--block" id="bbClear">${isZh() ? '清除' : 'Clear'}</button>
          <button class="btn btn--primary btn--block" id="bbTest">${isZh() ? '儲存並測試連線' : 'Save & test'}</button>
        </div>
        <div id="bbStatus" class="muted small">${connected ? (isZh() ? '已填入金鑰，按「儲存並測試連線」確認。' : 'Keys present — run the test.') : (isZh() ? '尚未設定金鑰。' : 'No keys yet.')}</div>
      </div>

      <div class="card">
        <header class="card__head"><h3>${isZh() ? '依目前計畫下單' : 'Order from plan'}</h3></header>
        <div id="bbTicket" class="muted small">${isZh() ? '先在「分析」頁產生一個交易計畫。' : 'Generate a plan first.'}</div>
      </div>

      <div class="card">
        <header class="card__head"><h3>${isZh() ? '目前持倉' : 'Positions'}</h3>
          <button class="btn btn--sm" id="bbRefresh">${isZh() ? '重新整理' : 'Refresh'}</button>
        </header>
        <div id="bbPositions" class="muted small">—</div>
      </div>
    `);
    bind();
    renderTicket();
  }

  function bind() {
    $('#tradeMode')?.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const next = b.dataset.mode;
        if (isRealMoney(next) && !confirm(isZh()
          ? '切換到實盤後，送出的每一張單都是真錢。確定要切換嗎？'
          : 'Live mode places real orders. Continue?')) return;
        keys.mode = next;
        client = null;
        instrument = null;
        liveArmed = false;
        saveKeys(keys);
        render();
      };
    });

    $('#bbClear').onclick = () => {
      clearKeys(keys.mode);
      keys = loadKeys();
      client = null;
      render();
      toast(isZh() ? '已清除這個模式的金鑰' : 'Keys cleared');
    };

    $('#bbTest').onclick = async () => {
      const apiKey = $('#bbKey').value.trim();
      const apiSecret = $('#bbSecret').value.trim();
      if (!apiKey || !apiSecret) return toast(isZh() ? '請先填入 Key 與 Secret' : 'Enter key and secret', 'error');
      keys[keys.mode] = { apiKey, apiSecret };
      saveKeys(keys);
      client = null;
      const c = build();
      $('#bbStatus').textContent = isZh() ? '連線中…' : 'Connecting…';
      try {
        const w = await c.walletBalance();
        $('#bbStatus').innerHTML = `<span class="pill pill--up">${isZh() ? '已連線' : 'Connected'}</span> ` +
          `${isZh() ? '權益' : 'Equity'} <b>${money(w.totalEquity)}</b> USDT · ${isZh() ? '可用' : 'Available'} ${money(w.totalAvailable)}`;
        toast(isZh() ? '連線成功' : 'Connected');
        refreshPositions();
        renderTicket();
      } catch (e) {
        const msg = explainError(e);
        const code = Number.isFinite(e?.code) && e.code > 0 ? ` <span class="mono tiny dim">[retCode ${e.code}]</span>` : '';
        $('#bbStatus').innerHTML = `<span class="pill pill--down">${isZh() ? '連線失敗' : 'Failed'}</span>${code} ` +
          `${isZh() ? msg.zh : msg.en}` +
          `<br><span class="tiny dim">${isZh() ? '目前連線的網址' : 'Endpoint'}：${escapeHost(keys.mode)}</span>`;
      }
    };

    $('#bbRefresh').onclick = refreshPositions;
  }

  async function renderTicket() {
    const plan = deps.getPlan();
    const el = $('#bbTicket');
    if (!el) return;
    if (!plan) {
      el.textContent = isZh() ? '先在「分析」頁產生一個交易計畫。' : 'Generate a plan first.';
      return;
    }
    const c = build();
    if (!c) {
      el.textContent = isZh() ? '請先在上面設定並測試 API 金鑰。' : 'Set up API keys above first.';
      return;
    }

    const symbol = deps.getSymbol();
    try {
      if (!instrument || instrument.symbol !== symbol) instrument = await c.instrument(symbol);
    } catch (e) {
      el.innerHTML = `<span class="pill pill--warn">${isZh() ? '找不到這個永續合約' : 'No perpetual'}</span> ` +
        (isZh() ? `Bybit 的 USDT 永續沒有 ${symbol}，無法下單。` : `${symbol} is not a Bybit USDT perpetual.`);
      return;
    }

    const risk = deps.getRisk();
    const q = planToOrder({ plan, instrument, accountSize: risk.account, riskPct: risk.riskPct, leverage: risk.leverage });
    lastQuote = q;
    if (q.error) {
      el.innerHTML = `<span class="pill pill--warn">${isZh() ? '無法下單' : 'Cannot size'}</span> ${q.error}`;
      return;
    }

    const long = q.side === 'long';
    const rr = plan.targets?.[0] ? Math.abs(plan.targets[0].price - plan.entry) / Math.abs(plan.entry - plan.stop) : null;
    el.innerHTML = `
      <div class="rows">
        <div class="row"><span>${isZh() ? '幣種' : 'Symbol'}</span><b>${q.symbol}</b></div>
        <div class="row"><span>${isZh() ? '方向' : 'Side'}</span><b class="${long ? 'up' : 'down'}">${long ? (isZh() ? '做多' : 'Long') : (isZh() ? '做空' : 'Short')}</b></div>
        <div class="row"><span>${isZh() ? '進場' : 'Entry'}</span><b>${q.price ? money(q.price, 6) + (isZh() ? '（限價）' : ' (limit)') : (isZh() ? '市價' : 'Market')}</b></div>
        <div class="row"><span>${isZh() ? '停損' : 'Stop'}</span><b class="down">${money(q.stopLoss, 6)}</b></div>
        <div class="row"><span>${isZh() ? '停利' : 'Take profit'}</span><b class="up">${q.takeProfit ? money(q.takeProfit, 6) : '—'}${rr ? ` (${rr.toFixed(2)}R)` : ''}</b></div>
        <div class="row"><span>${isZh() ? '數量' : 'Qty'}</span><b>${q.qty}</b></div>
        <div class="row"><span>${isZh() ? '名目價值' : 'Notional'}</span><b>${money(q.notional)} USDT</b></div>
        <div class="row"><span>${isZh() ? '所需保證金' : 'Margin'}</span><b>${money(q.margin)} USDT</b>（${risk.leverage}x）</div>
        <div class="row"><span>${isZh() ? '這筆最多虧' : 'Max loss'}</span><b class="down">${money(q.riskAmount)} USDT</b>（${risk.riskPct}%）</div>
      </div>
      ${isLive() ? `<div class="form-row"><label>${isZh() ? '輸入 REAL 解鎖' : 'Type REAL'}</label><input id="bbArm" class="input" type="text" placeholder="REAL" /></div>` : ''}
      <button class="btn btn--block ${isLive() ? 'btn--danger' : 'btn--primary'}" id="bbSend">
        ${isLive() ? (isZh() ? '送出實盤委託（真錢）' : 'Place LIVE order') : (isZh() ? '送出模擬委託' : 'Place testnet order')}
      </button>
    `;

    $('#bbSend').onclick = () => send(q);
  }

  async function send(q) {
    if (!q?.stopLoss) return toast(isZh() ? '沒有停損價，拒絕送單' : 'Refusing: no stop loss', 'error');
    if (isLive()) {
      const typed = ($('#bbArm')?.value || '').trim().toUpperCase();
      if (typed !== 'REAL') return toast(isZh() ? '請輸入 REAL 才能送出實盤委託' : 'Type REAL to confirm', 'error');
      if (!confirm(isZh()
        ? `最後確認：${q.symbol} ${q.side === 'long' ? '做多' : '做空'} ${q.qty}，最多虧 ${money(q.riskAmount)} USDT。送出嗎？`
        : `Confirm ${q.symbol} ${q.side} ${q.qty}?`)) return;
    }
    const c = build();
    const btn = $('#bbSend');
    btn.disabled = true;
    btn.textContent = isZh() ? '送出中…' : 'Sending…';
    try {
      const risk = deps.getRisk();
      await c.setLeverage(q.symbol, Math.min(risk.leverage, instrument.maxLeverage));
      const r = await c.placeOrder({
        symbol: q.symbol, side: q.side, qty: q.qty, price: q.price,
        stopLoss: q.stopLoss, takeProfit: q.takeProfit,
      });
      toast(isZh() ? `已送出，委託編號 ${String(r.orderId).slice(0, 8)}…` : `Order ${r.orderId}`);
      liveArmed = false;
      refreshPositions();
      renderTicket();
    } catch (e) {
      const msg = explainError(e);
      toast(isZh() ? msg.zh : msg.en, 'error');
      btn.disabled = false;
      renderTicket();
    }
  }

  async function refreshPositions() {
    const el = $('#bbPositions');
    if (!el) return;
    const c = build();
    if (!c) { el.textContent = isZh() ? '尚未連線。' : 'Not connected.'; return; }
    el.textContent = isZh() ? '讀取中…' : 'Loading…';
    try {
      const list = await c.positions();
      if (!list.length) { el.textContent = isZh() ? '目前沒有持倉。' : 'No open positions.'; return; }
      el.innerHTML = `<div class="rows">${list.map((p) => `
        <div class="row">
          <span>${p.symbol} <b class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? (isZh() ? '多' : 'L') : (isZh() ? '空' : 'S')}</b> ×${p.size}</span>
          <b class="${p.unrealisedPnl >= 0 ? 'up' : 'down'}">${p.unrealisedPnl >= 0 ? '+' : ''}${money(p.unrealisedPnl)} USDT</b>
        </div>
        <div class="row muted small">
          <span>${isZh() ? '均價' : 'Entry'} ${money(p.entry, 6)} · SL ${p.stopLoss ? money(p.stopLoss, 6) : '—'} · TP ${p.takeProfit ? money(p.takeProfit, 6) : '—'}</span>
          <button class="btn btn--sm btn--danger" data-close="${p.symbol}" data-side="${p.side}" data-size="${p.size}">${isZh() ? '市價平倉' : 'Close'}</button>
        </div>`).join('')}</div>`;
      el.querySelectorAll('[data-close]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm(isZh() ? `市價平掉 ${b.dataset.close} 的部位？` : `Close ${b.dataset.close}?`)) return;
          try {
            await c.closePosition({ symbol: b.dataset.close, side: b.dataset.side, qty: b.dataset.size });
            toast(isZh() ? '已送出平倉' : 'Close sent');
            refreshPositions();
          } catch (e) { toast(isZh() ? explainError(e).zh : explainError(e).en, 'error'); }
        };
      });
    } catch (e) {
      const msg = explainError(e);
      el.innerHTML = `<span class="pill pill--down">${isZh() ? '讀取失敗' : 'Failed'}</span> ${isZh() ? msg.zh : msg.en}`;
    }
  }

  return { render, renderTicket, refreshPositions };
}
