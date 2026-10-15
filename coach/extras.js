/**
 * SMC 教練 App：戰績（教練劇本的即時紀錄）、日誌（你自己的 Bybit 手動單檢討）、盯這單（到價推 Discord）。
 * 後端在 worker/coach-extras.js；日誌和盯單要 App 密碼（你在 GitHub Secrets 設過的 AI_TOKEN／AUTO_TRADE_TOKEN／APP_TOKEN 其中一個）。
 */
import { analyze, structure, atrOf, coachState, coachFollow } from '../src/smc/coach.js';
import { sessionOf } from '../src/smc/sessions.js';

let C0; // app.js 給的工具
const $ = (s, el = document) => el.querySelector(s);
const SESS = { asia: '亞洲盤', london: '倫敦殺區', nyam: '紐約早盤', nypm: '紐約午盤', none: '非時段' };
const tokenKey = 'smc-coach-token';
const getToken = () => C0.store.get(tokenKey, '');
const r1 = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R';
const pct = (x) => (x * 100).toFixed(0) + '%';
const usd = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'U';

export function install(c, X) {
  C0 = c;
  X.loadLive = loadLive;
  X.loadJournal = loadJournal;
  X.loadWatches = loadWatches;
  X.watchButton = watchButton;
  if ($('#live')) loadLive();
  if ($('#journal')) loadJournal();
  if ($('#watches')) loadWatches();
  if ($('#watchbox')) { const b = $('#watchbox'); b.dataset.pending = '1'; }
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(C0.WORKER + path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-app-token': getToken() }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { const e = new Error(j.error || '密碼不對'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
function tokenForm(el, why, after) {
  el.innerHTML = `<div class="card"><p class="h3" style="margin-top:0">輸入 App 密碼</p><p class="small mut">${why}</p>
    <p class="small mut">就是你在 GitHub Secrets 設過的 <b>AI_TOKEN</b>（問 AI 用的密碼）、<b>AUTO_TRADE_TOKEN</b> 或 <b>APP_TOKEN</b> 其中一個。只存在這支手機。</p>
    <input id="tok" type="password" autocomplete="off" placeholder="App 密碼" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--fg);font-size:16px">
    <button class="chip on" id="tokok" style="margin-top:8px">儲存</button></div>`;
  $('#tokok').onclick = () => { C0.store.set(tokenKey, $('#tok').value.trim()); after(); };
}

/* ═════════ 戰績 ═════════ */
let liveFilter = 'all';
async function loadLive() {
  const el = $('#live'); if (!el) return;
  let j;
  try { j = await (await fetch(C0.WORKER + '/coach-live', { cache: 'no-store' })).json(); } catch (e) { el.textContent = '讀不到戰績：' + e.message; return; }
  if (!$('#live')) return;
  const all = j.done || [], open = j.open || [];
  const list = all.filter((x) => liveFilter === 'all' || (liveFilter === 'aligned' ? x.bias === 2 : liveFilter === 'rr2' ? x.rr >= 2 : liveFilter === 'both' ? x.bias === 2 && x.rr >= 2 : liveFilter === 'new' ? x.rule !== 1 : true));
  const st = (l) => {
    const n = l.length; if (!n) return { n: 0 };
    const w = l.filter((x) => x.r > 0).length, sum = l.reduce((a, x) => a + x.r, 0);
    return { n, wr: w / n, avg: sum / n, sum };
  };
  const row = (name, l) => { const s = st(l); return `<tr><td>${name}</td><td>${s.n}</td><td>${s.n ? pct(s.wr) : '—'}</td><td class="${s.n && s.avg >= 0 ? 'up' : s.n ? 'dn' : ''}">${s.n ? r1(s.avg) : '—'}</td><td>${s.n ? r1(s.sum).replace('R', '') : '—'}</td></tr>`; };
  const table = (title, groups) => `<p class="h3">${title}</p><table class="tt st"><tr><th></th><th>筆數</th><th>勝率</th><th>平均</th><th>總 R</th></tr>${groups.map(([n, l]) => row(n, l)).join('')}</table>`;
  const s = st(list), since = all.length ? Math.min(...all.map((x) => x.rtT)) : null;
  el.classList.remove('mut');
  el.innerHTML = `<div id="auto"></div><p class="h3">📋 教練劇本紀錄（每個到位的劇本都算，不是真的下單）</p><p class="small mut" style="margin-top:0">Worker 每根 K 棒收盤自動記錄 15 檔 × 15m／30m／1h 的教練劇本：回踩就算成交，用回踩那根的進場／停損／目標往後算，扣手續費。是真實紀錄，不是回測。${since ? '從 ' + C0.mdhm(since) + ' 開始。' : ''}</p>
    <div class="filters">${[['all', '全部'], ['aligned', '只算順勢'], ['rr2', '只算 ≥2R'], ['both', '順勢＋≥2R'], ['new', '只算新規則']].map(([k, n]) => `<button class="chip ${liveFilter === k ? 'on' : ''}" data-lf="${k}">${n}</button>`).join('')}</div>
    ${totalHtml(list)}
    <div class="kpis"><div><b>${s.n || 0}</b><span>已結束</span></div><div><b>${s.n ? pct(s.wr) : '—'}</b><span>勝率</span></div><div><b class="${s.n && s.avg >= 0 ? 'up' : 'dn'}">${s.n ? r1(s.avg) : '—'}</b><span>平均每筆</span></div><div><b>${open.length}</b><span>進行中</span></div></div>
    ${s.n < 30 ? `<p class="small mut">筆數還少（${s.n || 0} 筆），至少 30～50 筆再下結論。</p>` : ''}
    ${s.n ? table('各週期', ['15m', '30m', '1h'].map((t) => [t, list.filter((x) => x.iv === t)])) +
      table('掃蕩發生的時段', Object.keys(SESS).map((k) => [SESS[k], list.filter((x) => x.sess === k)])) +
      table('大週期', [['順勢', list.filter((x) => x.bias === 2)], ['方向未定', list.filter((x) => x.bias === 1)], ['逆勢', list.filter((x) => x.bias === 0)]]) +
      table('位置', [['折溢價對', list.filter((x) => x.disc)], ['折溢價錯', list.filter((x) => !x.disc)]]) +
      `<p class="h3">最近結束的</p>${list.slice(0, 25).map((x) => `<button class="ev" data-open="${x.sym.replace(/USDT$/, '')}|${x.iv}|${x.side}"><span class="mut small">${C0.mdhm(x.endT)}</span><span class="side ${x.side}">${x.sym.replace(/USDT$/, '')} ${x.iv} ${C0.sideName(x.side)}</span><span class="${x.r >= 0 ? 'up' : 'dn'}">${x.out === 'tp' ? '到目標' : x.out === 'sl' ? '停損' : '到期'} ${r1(x.r)}</span></button>`).join('')}` : ''}
    ${open.length ? `<p class="h3">進行中（已回踩、還沒結果）</p>${open.slice(0, 20).map((x) => `<button class="ev" data-open="${x.sym.replace(/USDT$/, '')}|${x.iv}|${x.side}"><span class="mut small">${C0.mdhm(x.rtT)}</span><span class="side ${x.side}">${x.sym.replace(/USDT$/, '')} ${x.iv} ${C0.sideName(x.side)}</span><span>${x.rr}R・${x.bias === 2 ? '順勢' : x.bias === 0 ? '逆勢' : '未定'}</span></button>`).join('')}` : ''}`;
  el.querySelectorAll('[data-lf]').forEach((b) => { b.onclick = () => { liveFilter = b.dataset.lf; loadLive(); }; });
  drawCurve($('#eqc'), list);
  loadAuto();
  const ri = $('#riskU'); if (ri) ri.onchange = () => { C0.store.set('smc-risk-u', Math.max(0, Number(ri.value) || 0)); loadLive(); };
  bindOpen(el);
}
/* ═════════ 教練自動下單 ═════════ */
let autoView = null, liveConfirm = false;
async function loadAuto() {
  const el = $('#auto'); if (!el) return;
  if (!getToken()) { el.innerHTML = `<div class="card"><p class="h3" style="margin-top:0">🤖 教練自動下單</p><button class="chip on" id="autoTok">輸入 App 密碼來設定</button></div>`; $('#autoTok').onclick = () => tokenForm(el, '自動下單要動你的 Bybit 帳戶，所以要密碼。', loadAuto); return; }
  let j;
  try { j = await api('/coach-auto'); } catch (e) {
    if (e.auth) { C0.store.set(tokenKey, ''); tokenForm(el, '密碼不對，再輸入一次。', loadAuto); return; }
    el.innerHTML = `<div class="card no">讀不到自動下單狀態：${C0.esc(e.message)}</div>`; return;
  }
  if (!$('#auto')) return;
  const cfg = j.cfg, view = autoView || (cfg.mode === 'off' ? 'demo' : cfg.mode), now = Date.now();
  const T = (j.trades || []).filter((t) => t.account === view), closed = T.filter((t) => t.state === 'closed'), act = T.filter((t) => t.state === 'pending' || t.state === 'open');
  const sum = closed.reduce((a, t) => a + (t.r || 0), 0), usdSum = closed.reduce((a, t) => a + (t.pnl || 0), 0), d0 = Math.floor(now / 86400e3) * 86400e3;
  const today = closed.filter((t) => t.closedAt >= d0).reduce((a, t) => a + (t.r || 0), 0), wr = closed.length ? closed.filter((t) => t.r > 0).length / closed.length : 0;
  const nm = { off: '關', demo: 'Demo（假錢）', live: '真錢' };
  el.innerHTML = `<div class="card auto"><div class="row"><p class="h3" style="margin:0">🤖 教練自動下單</p><span class="sp"></span><span class="small ${cfg.mode === 'live' ? 'dn' : cfg.mode === 'demo' ? 'up' : 'mut'}">現在：${nm[cfg.mode]}</span></div>
    <div class="seg2 sides" style="margin-top:8px">${['off', 'demo', 'live'].map((m) => `<button data-am="${m}" class="${cfg.mode === m ? 'on' : ''}">${m === 'live' && liveConfirm ? '再按一次確認真錢' : nm[m]}</button>`).join('')}</div>
    <p class="small mut">劇本剛回踩、離進場點 0.5R 內就掛單（真錢只做順 4h＋≥2R${cfg.demoLoose !== false ? '；Demo 有訊號就進' : ''}）。每筆風險 <b>權益的 ${((cfg.riskPct ?? 0.09) * 100).toFixed(0)}%</b>${j.equity ? `（現在約 ${(Math.min(j.equity, cfg.mode === 'demo' ? (cfg.demoEquity || 220) : Infinity) * (cfg.riskPct ?? 0.09)).toFixed(1)}U）` : ''}，打到停損虧這麼多，槓桿照停損距離算、最高 ${cfg.maxLev}x、停損一定比強平近，保證金不夠就跳過；同時最多 ${cfg.maxPos} 筆；當天虧 ${cfg.dailyLosses ?? 5} 筆就停到隔天 8 點。停損目標都掛在 Bybit 上。</p>
    ${cfg.pausedUntil > now ? `<div class="next warn"><b>今天已暫停</b><br>今天已經虧 ${cfg.dailyLosses ?? 5} 筆，${C0.mdhm(cfg.pausedUntil / 1000)} 恢復。</div>` : ''}
    ${j.stateError ? `<p class="small dn">帳戶讀取錯誤：${C0.esc(j.stateError)}</p>` : j.equity != null ? `<p class="small">帳戶權益 <b>${j.equity.toFixed(2)}U</b></p>` : ''}
    <div class="filters"><span class="small mut">看成績：</span>${['demo', 'live'].map((a) => `<button class="chip ${view === a ? 'on' : ''}" data-av="${a}">${a === 'demo' ? 'Demo' : '真錢'}</button>`).join('')}</div>
    <div class="row"><b class="bigr ${sum >= 0 ? 'up' : 'dn'}">${sum >= 0 ? '+' : ''}${sum.toFixed(2)}R</b><span class="sp"></span><b class="${usdSum >= 0 ? 'up' : 'dn'}">${usd(usdSum)}</b></div>
    <div class="row small"><span>${closed.length} 筆・勝率 ${closed.length ? pct(wr) : '—'}</span><span>今天 <b class="${today >= 0 ? 'up' : 'dn'}">${today >= 0 ? '+' : ''}${today.toFixed(2)}R</b></span><span>進行中 ${act.length}</span></div>
    ${T.slice(0, 15).map((t) => `<div class="ev"><span class="mut small">${C0.mdhm(t.placedAt / 1000)}</span><span class="side ${t.side}">${t.sym.replace(/USDT$/, '')} ${t.iv} ${t.side === 'L' ? '多' : '空'} ${t.lev}x</span>${t.bias === 2 && t.rr >= 2 ? '<span class="small up">嚴格✓</span>' : t.bias != null ? '<span class="small mut">寬鬆</span>' : ''}<span class="small">${t.state === 'pending' ? '掛單中' : t.state === 'open' ? '持倉中' : t.state === 'cancelled' ? '取消・' + (t.why || '') : ''}</span>${t.state === 'closed' ? `<span class="${t.r >= 0 ? 'up' : 'dn'}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R（${usd(t.pnl)}）</span>` : `<span class="small mut">1R＝${(t.riskU || 0).toFixed(2)}U</span>`}</div>`).join('') || '<p class="small mut">還沒有單。</p>'}
  </div>`;
  el.querySelectorAll('[data-av]').forEach((b) => { b.onclick = () => { autoView = b.dataset.av; loadAuto(); }; });
  el.querySelectorAll('[data-am]').forEach((b) => {
    b.onclick = async () => {
      const m = b.dataset.am;
      if (m === cfg.mode) return;
      if (m === 'live' && !liveConfirm) { liveConfirm = true; loadAuto(); return; }
      liveConfirm = false;
      try { await api('/coach-auto', { method: 'POST', body: { mode: m } }); C0.toast(`自動下單：${nm[m]}`); autoView = m === 'off' ? autoView : m; } catch (e) { C0.toast('設定失敗：' + e.message); }
      loadAuto();
    };
  });
}

/** 總計 R：全部、今天（台灣時間）、近 7 天、最大回撤，再換算成每單風險 X U 的金額 */
function totalHtml(list) {
  const sum = list.reduce((a, x) => a + x.r, 0), now = Date.now() / 1000;
  const day0 = Math.floor((now + 8 * 3600) / 86400) * 86400 - 8 * 3600;
  const today = list.filter((x) => x.endT >= day0).reduce((a, x) => a + x.r, 0), w7 = list.filter((x) => x.endT >= now - 7 * 86400).reduce((a, x) => a + x.r, 0);
  let peak = 0, cum = 0, dd = 0;
  for (const x of [...list].sort((a, b) => a.endT - b.endT)) { cum += x.r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const riskU = C0.store.get('smc-risk-u', 5);
  const f1 = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + 'R';
  return `<div class="card total"><div class="row"><span class="mut small">總計</span><span class="sp"></span><span class="small mut">每單風險 <input id="riskU" type="number" min="0" step="1" value="${riskU}">U 的話</span></div>
    <div class="row"><b class="bigr ${sum >= 0 ? 'up' : 'dn'}">${f1(sum)}</b><span class="sp"></span><b class="${sum >= 0 ? 'up' : 'dn'}">${sum * riskU >= 0 ? '+' : ''}${(sum * riskU).toFixed(1)}U</b></div>
    <div class="row small"><span>今天 <b class="${today >= 0 ? 'up' : 'dn'}">${f1(today)}</b></span><span>近 7 天 <b class="${w7 >= 0 ? 'up' : 'dn'}">${f1(w7)}</b></span><span>最大回撤 <b class="dn">-${dd.toFixed(1)}R</b></span></div>
    <canvas id="eqc"></canvas></div>`;
}
/** 累積 R 曲線 */
function drawCurve(cv, list) {
  if (!cv || list.length < 2) { if (cv) cv.style.display = 'none'; return; }
  const pts = [0]; let c = 0;
  for (const x of [...list].sort((a, b) => a.endT - b.endT)) { c += x.r; pts.push(c); }
  const dpr = devicePixelRatio || 1, W = cv.clientWidth || 320, H = 110;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), Y = (v) => 6 + (hi - v) / ((hi - lo) || 1) * (H - 12), X = (i) => i / (pts.length - 1) * (W - 2) + 1;
  g.strokeStyle = 'rgba(140,153,184,.35)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke(); g.setLineDash([]);
  const last = pts[pts.length - 1], col = last >= 0 ? '#2CD3A3' : '#FF6E6E';
  g.beginPath(); pts.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.strokeStyle = col; g.lineWidth = 2; g.stroke();
  g.lineTo(X(pts.length - 1), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.fillStyle = last >= 0 ? 'rgba(44,211,163,.12)' : 'rgba(255,110,110,.12)'; g.fill();
}
function bindOpen(el) {
  el.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => { const [c, tf, s] = b.dataset.open.split('|'); if (C0.COINS.includes(c) && C0.TFS.includes(tf)) C0.openDetail(c, tf, s); else C0.toast('掃描板沒有這個幣／週期'); };
  });
}

/* ═════════ 盯這單 ═════════ */
async function loadWatches() {
  const el = $('#watches'); if (!el || !getToken()) return;
  let j;
  try { j = await api('/watch'); } catch { return; }
  if (!$('#watches') || !j.watches || !j.watches.length) return;
  el.innerHTML = `<p class="h3">👀 盯單中（到價會推 Discord）</p>${j.watches.map((w) => `<div class="ev"><span class="side ${w.side}">${w.sym.replace(/USDT$/, '')} ${w.iv} ${C0.sideName(w.side)}</span><span class="small">${w.state === 'filled' ? '已進場・等結果' : '等回到 ' + C0.fmt(w.en)}</span><span class="sp"></span><button class="chip" data-unwatch="${w.id}">取消</button></div>`).join('')}`;
  el.querySelectorAll('[data-unwatch]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { await api('/watch?id=' + encodeURIComponent(b.dataset.unwatch), { method: 'DELETE' }); } catch (e) { C0.toast(e.message); } el.innerHTML = ''; loadWatches(); }; });
}
function watchButton(coin, tf, side, x, f) {
  const el = $('#watchbox'); if (!el) return;
  const ok = f && f.plan && ['pending', 'near', 'ran', 'deep'].includes(x.fs);
  const k = `${coin}${tf}${side}${f && f.plan ? f.plan.en : ''}`;
  if (el.dataset.k === k) return; // 每 15 秒重畫時不要把按鈕狀態洗掉
  el.dataset.k = k;
  if (!ok) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="watchbtn" id="wbtn">👀 盯這單：${x.fs === 'pending' ? '回到進場價' : '到目標或停損'}時推 Discord 通知我</button>`;
  $('#wbtn').onclick = async () => {
    if (!getToken()) { tokenForm(el, '盯單會用你的 Discord 推播，所以要密碼。', () => { el.dataset.k = ''; watchButton(coin, tf, side, x, f); }); return; }
    const b = $('#wbtn'); b.disabled = true; b.textContent = '設定中…';
    try {
      await api('/watch', { method: 'POST', body: { sym: coin + 'USDT', iv: tf, side, en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, filled: x.fs !== 'pending' } });
      b.textContent = '✓ 盯著了（3 天內有結果會推 Discord）';
    } catch (e) {
      if (e.auth) { C0.store.set(tokenKey, ''); tokenForm(el, '密碼不對，再輸入一次。', () => { el.dataset.k = ''; watchButton(coin, tf, side, x, f); }); return; }
      b.disabled = false; b.textContent = '設定失敗：' + e.message;
    }
  };
}

/* ═════════ 交易日誌 ═════════ */
let jData = null, jBusy = false, jDays = 30;
const jCache = () => C0.store.get('smc-journal-check', {});
async function loadJournal(force) {
  const el = $('#journal'); if (!el) return;
  if (!getToken()) { tokenForm(el, '日誌要讀你 Bybit 帳戶的成交紀錄，所以要密碼。', () => loadJournal(true)); return; }
  if (jData && !force) return renderJournal();
  el.innerHTML = '<div class="card mut">讀取 Bybit 成交紀錄…</div>';
  try { jData = await api('/journal?days=' + jDays); } catch (e) {
    if (e.auth) { C0.store.set(tokenKey, ''); tokenForm(el, '密碼不對，再輸入一次。', () => loadJournal(true)); return; }
    el.innerHTML = `<div class="card no">讀不到日誌：${C0.esc(e.message)}</div>`; return;
  }
  if (!jData.configured) { el.innerHTML = setupHtml(jData.error); return; }
  renderJournal();
  checkTrades();
}
function setupHtml(err) {
  return `<div class="card help"><p class="h3" style="margin-top:0">還沒接上你的 Bybit 帳戶</p><p class="small mut">${C0.esc(err || '')}</p><ol>
    <li>GitHub Secrets 要有你那個 Bybit 真實帳戶的金鑰：<b>BYBIT_LIVE_API_KEY／BYBIT_LIVE_API_SECRET</b>（之前切真錢用的那組就可以），或另外開一組只有「讀取」權限的 <b>BYBIT_READ_API_KEY／BYBIT_READ_API_SECRET</b>（比較安全，有的話優先用）。</li>
    <li>金鑰如果有綁 IP，要把 Executor 的 IP 加進去，不然 Bybit 會拒絕。</li>
    <li>回來跟 Claude 說「設好了」，我會幫你重新部署 Executor，日誌就會出現。</li></ol>
    <p class="small mut">沒綁 IP 的唯讀金鑰 Bybit 大約 3 個月會過期，到時候重做一次就好。</p></div>`;
}
async function analyzeTrade(t) {
  const coin = t.symbol.replace(/USDT$/, ''), end = t.openTime - 1, MS = C0.MS;
  const [a, b] = await Promise.all([C0.fetchK(coin, '15m', 501, end), C0.fetchK(coin, '4h', 300, end)]);
  const W = a.C.filter((k) => k.t * 1000 + MS['15m'] <= t.openTime).slice(-500);
  const H = b.C.filter((k) => k.t * 1000 + MS['4h'] <= t.openTime).slice(-299);
  if (W.length < 120) throw new Error('K 棒不夠');
  const bias = H.length >= 30 ? (structure(H, 3, atrOf(H)).trend[H.length - 1] || 0) : 0;
  const A = analyze(W, 4, 2), st = coachState(W, A, bias), r = st[t.dir === 'long' ? 'L' : 'S'], f = coachFollow(W, A, r);
  return { stage: r.stage, bias: r.bias, disc: r.disc, fs: f.status, sess: (sessionOf(t.openTime) || { id: 'none' }).id };
}
async function checkTrades() {
  if (jBusy || !jData) return;
  jBusy = true;
  const cache = jCache(), todo = jData.trades.filter((t) => !cache[t.symbol + ':' + t.openTime]);
  let i = 0, n = 0;
  const run = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      try { cache[t.symbol + ':' + t.openTime] = await analyzeTrade(t); } catch (e) { cache[t.symbol + ':' + t.openTime] = { err: e.message }; }
      n++;
      if (n % 4 === 0 || n === todo.length) { C0.store.set('smc-journal-check', cache); if ($('#journal')) renderJournal(n, todo.length); }
    }
  };
  await Promise.all([run(), run(), run()]);
  jBusy = false;
  C0.store.set('smc-journal-check', cache);
  if ($('#journal')) renderJournal();
}

/** 用過去每筆的「佔權益 %」重抽模擬：從現在的權益開始，先到目標還是先剩不到 5%（等於爆倉） */
function simulate(rets, start, target, runs = 2000, maxTrades = 2000) {
  let hit = 0, bust = 0;
  for (let k = 0; k < runs; k++) {
    let e = start;
    for (let n = 0; n < maxTrades; n++) {
      e *= 1 + rets[(Math.random() * rets.length) | 0];
      if (e >= target) { hit++; break; }
      if (e <= start * 0.05) { bust++; break; }
    }
  }
  return { hit: hit / runs, bust: bust / runs };
}
let jFilter = 'manual', jTarget = 2000;
function renderJournal(done, total) {
  const el = $('#journal'); if (!el || !jData) return;
  const cache = jCache(), bal = jData.balance || 0;
  const all = jData.trades.filter((t) => t.pnl != null);
  const T = all.filter((t) => jFilter === 'all' || t.strategy === 'manual');
  // 每筆進場當下的權益 ≈ 現在權益 − 之後結束的交易損益
  const byClose = [...all].sort((a, b) => b.closeTime - a.closeTime);
  const eqAt = new Map();
  for (const t of byClose) eqAt.set(t, Math.max(1e-9, bal - sumAfter(byClose, t)));
  const n = T.length, wins = T.filter((t) => t.pnl > 0), losses = T.filter((t) => t.pnl <= 0);
  const net = T.reduce((a, t) => a + t.pnl, 0), fees = T.reduce((a, t) => a + t.fees, 0);
  const pctOf = (t) => t.pnl / eqAt.get(t), levOf = (t) => t.notional / eqAt.get(t);
  const avgLossPct = losses.length ? -losses.reduce((a, t) => a + pctOf(t), 0) / losses.length : 0;
  const maxLossPct = losses.length ? -Math.min(...losses.map(pctOf)) : 0;
  const levs = T.map(levOf), avgLev = levs.length ? levs.reduce((a, b) => a + b, 0) / levs.length : 0, maxLev = levs.length ? Math.max(...levs) : 0;
  let streak = 0, worst = 0;
  for (const t of [...T].sort((a, b) => a.closeTime - b.closeTime)) { if (t.pnl <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0; }
  const sim = n >= 10 && bal > 0 && jTarget > bal ? simulate(T.map(pctOf), bal, jTarget) : null;
  // 教練檢查
  const chk = (t) => cache[t.symbol + ':' + t.openTime];
  const withC = T.filter((t) => chk(t) && !chk(t).err);
  const grp = (name, f) => { const l = withC.filter(f); const s = l.reduce((a, t) => a + t.pnl, 0); return { name, n: l.length, wr: l.length ? l.filter((t) => t.pnl > 0).length / l.length : 0, net: s }; };
  const rows = [
    ['掃蕩', [grp('進場前有掃流動性', (t) => chk(t).stage >= 1), grp('沒掃就進', (t) => chk(t).stage === 0)]],
    ['結構', [grp('結構轉向後才進', (t) => chk(t).stage >= 2), grp('結構還沒轉就進', (t) => chk(t).stage < 2)]],
    ['大週期 4h', [grp('順勢', (t) => chk(t).bias === 2), grp('方向未定', (t) => chk(t).bias === 1), grp('逆勢', (t) => chk(t).bias === 0)]],
    ['位置', [grp('折溢價對', (t) => chk(t).disc), grp('做多買在溢價／做空賣在折價', (t) => !chk(t).disc)]],
    ['追價', [grp('回踩後已經跑掉還追', (t) => chk(t).fs === 'ran'), grp('沒有追價', (t) => chk(t).fs !== 'ran')]],
    ['進場時段', Object.keys(SESS).map((k) => grp(SESS[k], (t) => chk(t).sess === k))],
  ];
  const worstG = rows.flatMap(([, g]) => g).filter((g) => g.n >= 3).sort((a, b) => a.net - b.net)[0];
  const errs = Object.entries(jData.errors || {}).filter(([, v]) => v);
  const errHtml = errs.length ? `<div class="card no"><b>Bybit 回報錯誤</b>${errs.map(([k, v]) => `<p class="small">${{ executions: '成交紀錄', balance: '餘額', positions: '持倉' }[k] || k}：${C0.esc(v)}</p>`).join('')}<p class="small mut">常見原因：金鑰打錯、金鑰過期、金鑰綁了 IP 但沒加 Executor 的 IP、或沒有「合約／統一帳戶」的讀取權限。</p></div>` : '';
  el.innerHTML = errHtml + `<div class="filters"><button class="chip ${jFilter === 'manual' ? 'on' : ''}" data-jf="manual">只看手動單</button><button class="chip ${jFilter === 'all' ? 'on' : ''}" data-jf="all">全部</button>
      <span class="sp"></span><button class="chip" id="jre">重新讀取</button></div>
    <div class="kpis"><div><b>${bal ? bal.toFixed(1) : '—'}U</b><span>現在權益</span></div><div><b>${n}</b><span>${jDays} 天交易</span></div><div><b>${n ? pct(wins.length / n) : '—'}</b><span>勝率</span></div><div><b class="${net >= 0 ? 'up' : 'dn'}">${usd(net)}</b><span>淨損益</span></div></div>
    ${n ? `<div class="card"><p class="h3" style="margin-top:0">風險（照你的倉位）</p>
      <p>平均實際槓桿 <b>${avgLev.toFixed(1)} 倍</b>（最高 ${maxLev.toFixed(1)} 倍）：價格反向 <b>${avgLev > 0 ? (100 / avgLev).toFixed(1) : '—'}%</b> 就等於虧掉整個帳戶。</p>
      <p>平均一筆虧損 <b>${(avgLossPct * 100).toFixed(1)}%</b> 的帳戶（最大 ${(maxLossPct * 100).toFixed(1)}%）${avgLossPct > 0 ? `，照這樣大約<b>連虧 ${Math.ceil(Math.log(0.05) / Math.log(1 - avgLossPct))} 筆</b>帳戶就剩不到 5%` : ''}。你這段時間最多連虧 <b>${worst}</b> 筆。</p>
      <p>手續費共 <b>${fees.toFixed(2)}U</b>（平均每筆 ${(fees / n).toFixed(2)}U，約帳戶的 ${(T.reduce((q, t) => q + t.fees / eqAt.get(t), 0) / n * 100).toFixed(2)}%）。高槓桿時手續費吃很兇。</p>
      ${sim ? `<p>用你這 ${n} 筆的報酬重抽模擬 2000 次（從 ${bal.toFixed(0)}U 開始）：<b>先到 <input id="jt" type="number" value="${jTarget}" style="width:70px;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 4px">U 的機率 ${pct(sim.hit)}</b>、先剩不到 5%（等於爆倉）的機率 <b class="dn">${pct(sim.bust)}</b>。</p><p class="small mut">模擬假設之後的交易跟這段時間差不多；樣本少的時候誤差很大。</p>` : n < 10 ? '<p class="small mut">交易少於 10 筆，先不做模擬。</p>' : ''}
    </div>` : ''}
    <div class="card"><p class="h3" style="margin-top:0">對照教練清單（15m，進場當下）${total ? `<span class="small mut">　分析中 ${done}/${total}</span>` : ''}</p>
      ${worstG ? `<div class="next warn"><b>最傷的習慣：${worstG.name}</b><br>${worstG.n} 筆，勝率 ${pct(worstG.wr)}，合計 ${usd(worstG.net)}</div>` : ''}
      ${rows.map(([title, g]) => `<p class="h3">${title}</p><table class="tt st"><tr><th></th><th>筆數</th><th>勝率</th><th>合計</th></tr>${g.map((x) => `<tr><td>${x.name}</td><td>${x.n}</td><td>${x.n ? pct(x.wr) : '—'}</td><td class="${x.net >= 0 ? 'up' : 'dn'}">${x.n ? usd(x.net) : '—'}</td></tr>`).join('')}</table>`).join('')}
    </div>
    ${(jData.positions || []).length ? `<div class="card"><p class="h3" style="margin-top:0">現在持倉</p>${jData.positions.map((p) => `<div class="ev"><span class="side ${p.side === 'Buy' ? 'L' : 'S'}">${p.symbol.replace(/USDT$/, '')} ${p.side === 'Buy' ? '多' : '空'} ${p.leverage}x</span><span class="small">均價 ${C0.fmt(p.avgPrice)}${p.liqPrice ? `・強平 ${C0.fmt(p.liqPrice)}（${(Math.abs(p.liqPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1)}%）` : ''}${p.stopLoss ? '・停損 ' + C0.fmt(p.stopLoss) : '・<b class="dn">沒設停損</b>'}</span><span class="${p.unrealisedPnl >= 0 ? 'up' : 'dn'}">${usd(p.unrealisedPnl)}</span></div>`).join('')}</div>` : ''}
    <p class="h3">每一筆</p>${T.slice(0, 60).map((t) => { const c = chk(t), d = t.dir === 'long'; return `<div class="ev"><span class="mut small">${C0.mdhm(t.openTime / 1000)}</span><span class="side ${d ? 'L' : 'S'}">${t.symbol.replace(/USDT$/, '')} ${d ? '多' : '空'}</span><span class="small">${levOf(t).toFixed(1)}x</span><span class="${t.pnl >= 0 ? 'up' : 'dn'}">${usd(t.pnl)}（${(pctOf(t) * 100).toFixed(1)}%）</span>${c && !c.err ? `<span class="small mut">${c.stage >= 1 ? '✓掃' : '✗掃'} ${c.bias === 2 ? '✓順' : c.bias === 0 ? '✗逆' : '◐'} ${c.disc ? '✓位' : '✗位'}${c.fs === 'ran' ? ' ✗追' : ''}</span>` : ''}</div>`; }).join('') || '<p class="mut">這段時間沒有已結束的交易。</p>'}`;
  el.querySelectorAll('[data-jf]').forEach((b) => { b.onclick = () => { jFilter = b.dataset.jf; renderJournal(); }; });
  $('#jre').onclick = () => { jData = null; loadJournal(true); };
  const jt = $('#jt'); if (jt) jt.onchange = () => { jTarget = Math.max(1, Number(jt.value) || 2000); renderJournal(); };
}
function sumAfter(byClose, t) {
  // byClose 依結束時間由新到舊：t 之後（含自己）結束的交易損益總和
  let s = 0;
  for (const x of byClose) { s += x.pnl; if (x === t) break; }
  return s;
}
