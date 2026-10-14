/**
 * SMC 教練 App：一次掃 15 檔主流幣 × 15m／30m／1h，列出每個劇本走到哪一步，點進去看圖表＋教練清單。
 * 規則直接用 src/smc/coach.js（跟 Discord 教練提醒、道場看盤教室同一份），時段用 src/smc/sessions.js。
 * 行情由手機直接向交易所拿（Bybit 永續 → Binance 永續 → Binance 現貨），第一次抓 500 根，之後每根收盤只補最新幾根。
 */
import { analyze, structure, atrOf, coachState, coachFollow } from '../src/smc/coach.js';
import { sessionOf } from '../src/smc/sessions.js';

/* 戰績、日誌、盯這單在 extras.js，載入之前先放空函式 */
const X = window.__coachX = { loadLive() {}, loadJournal() {}, loadWatches() {}, watchButton() {} };

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT', 'NEAR', 'APT', 'ARB', 'OP'];
const TFS = ['15m', '30m', '1h'];
const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5 };
const IV = { '15m': ['15', '15m'], '30m': ['30', '30m'], '1h': ['60', '1h'], '4h': ['240', '4h'] };
const BARS = 500, HBARS = 299;
const WORKER = 'https://smc-signals.crypto-radar-guardian-24x7.workers.dev';
const SESS_IDX = { asia: 1, london: 2, nyam: 3, nypm: 4 };
const SESS_NAME = ['非時段', '亞洲盤', '倫敦殺區', '紐約早盤殺區', '紐約午盤殺區'];
const SESS_COL = [null, 'rgba(77,132,214,.11)', 'rgba(44,211,163,.09)', 'rgba(245,191,79,.10)', 'rgba(142,157,255,.10)'];
const COL = { bg: '#0A0F1D', grid: 'rgba(140,153,184,.08)', ax: '#8C99B8', up: '#2CD3A3', dn: '#FF6E6E', gold: '#F5BF4F', sel: '#8E9DFF', fg: '#E8EDF7' };
const STEP_N = ['掃流動性', '結構轉向', 'POI', '回踩', '計畫'];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sessIdx = (ms) => { const s = sessionOf(ms); return s ? SESS_IDX[s.id] : 0; };
const pad = (n) => (n < 10 ? '0' : '') + n;
const tpe = (sec) => { const d = new Date(sec * 1000 + 8 * 3600e3); return { M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes() }; };
const hm = (sec) => { const x = tpe(sec); return pad(x.h) + ':' + pad(x.m); };
const mdhm = (sec) => { const x = tpe(sec); return x.M + '/' + x.D + ' ' + pad(x.h) + ':' + pad(x.m); };
function fmt(p) {
  if (p == null || !isFinite(p)) return '—';
  const a = Math.abs(p), d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 私密模式等存不了就算了 */ } },
};

/* ═════════ 行情 ═════════ */
let SRC = null;
const bin = (j) => j.map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
function sources(coin, tf, limit, end) {
  const sym = coin + 'USDT', e1 = end ? `&end=${end}` : '', e2 = end ? `&endTime=${end}` : '';
  return [
    { n: 'Bybit 永續', u: `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${IV[tf][0]}&limit=${Math.min(limit, 1000)}${e1}`, p: (j) => { if (!j || !j.result || !j.result.list) throw new Error('格式不對'); return j.result.list.map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).reverse(); } },
    { n: 'Binance 永續', u: `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${IV[tf][1]}&limit=${Math.min(limit, 1500)}${e2}`, p: bin },
    { n: 'Binance 現貨', u: `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${IV[tf][1]}&limit=${Math.min(limit, 1000)}${e2}`, p: bin },
  ];
}
async function fetchK(coin, tf, limit, end) {
  const list = sources(coin, tf, limit, end), order = SRC != null ? [SRC, ...[0, 1, 2].filter((i) => i !== SRC)] : [0, 1, 2], errs = [];
  for (const k of order) {
    const s = list[k], ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(s.u, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const C = s.p(await r.json());
      if (!C.length) throw new Error('沒有資料');
      SRC = k;
      return { C, src: s.n };
    } catch (e) { errs.push(s.n + '：' + (e.name === 'AbortError' ? '逾時' : e.message)); } finally { clearTimeout(to); }
  }
  throw new Error(errs.join('；'));
}
function merge(C, add) {
  for (const k of add) {
    const last = C[C.length - 1];
    if (!last || k.t > last.t) C.push(k);
    else if (k.t === last.t) C[C.length - 1] = k;
  }
  if (C.length > 1100) C.splice(0, C.length - 1100);
}
async function pool(tasks, n) {
  let i = 0;
  const run = async () => { while (i < tasks.length) { const t = tasks[i++]; try { await t(); } catch { /* 個別失敗不影響其他 */ } } };
  await Promise.all(Array.from({ length: n }, run));
}

/* ═════════ 分析 ═════════ */
const D = {}, H = {}, R = {};
const key = (c, tf) => c + '|' + tf;
let booted = false, loading = 0, loadTotal = 0, lastSrc = '';
const cache = store.get('smc-coach-cache', null);
let events = store.get('smc-coach-events', []);

function computeBias(coin) {
  const h = H[coin]; if (!h) return;
  const now = Date.now(), Hc = h.C.filter((c) => c.t * 1000 + MS['4h'] <= now).slice(-HBARS);
  h.bias = Hc.length >= 30 ? (structure(Hc, 3, atrOf(Hc)).trend[Hc.length - 1] || 0) : 0;
  h.lastOpen = h.C[h.C.length - 1].t * 1000;
}
/* 劇本結束的幾種情況（coachFollow），結束超過 RECENT 根就當作沒有劇本、等新的掃蕩 */
const ENDED = { tp: '到目標', sl: '打到停損', missed: '沒回踩就走了', stale: '放太久沒結果', fail: '掃蕩失敗' };
const RECENT = 24;
const isEnded = (x) => x.fs in ENDED;
function sideSum(r, W, f) {
  const j = W.length - 1, age = f.at != null ? j - f.at : null;
  const x = {
    stage: r.stage, ready: r.ready, bias: r.bias, disc: r.disc,
    sess: r.sweep ? sessIdx(W[r.sweep.u].t * 1000) : -1, swT: r.sweep ? W[r.sweep.u].t : (r.dead ? W[r.dead.u].t : null), swP: r.sweep ? r.sweep.p : null,
    ev: r.ev ? r.ev.t : null, poi: r.poi ? { kind: r.poi.kind, top: r.poi.top, bot: r.poi.bot } : null,
    fs: f.status, fres: f.res ?? null, fcur: f.cur ?? null, fAt: f.at != null ? W[f.at].t : null, ssl: f.next.ssl, bsl: f.next.bsl,
    rr: f.plan ? f.plan.rr : r.plan ? r.plan.rr : null, en: f.plan ? f.plan.en : null, sl: f.plan ? f.plan.sl : null, tp: f.plan ? f.plan.tp : null,
  };
  if (f.fromDead) x.stage = f.stage;
  if (isEnded(x) && age > RECENT) { x.fs = 'old'; x.stage = 0; x.ready = false; } // 結束很久了：等新的掃蕩
  return x;
}
function compute(coin, tf) {
  const k = key(coin, tf), d = D[k]; if (!d) return;
  const now = Date.now(), ms = MS[tf];
  const W = d.C.filter((c) => c.t * 1000 + ms <= now).slice(-BARS);
  if (W.length < 120) { R[k] = { err: 'K 棒不夠' }; return; }
  const A = analyze(W, 4, 2), bias = H[coin] ? H[coin].bias : 0, st = coachState(W, A, bias);
  const f = { L: coachFollow(W, A, st.L), S: coachFollow(W, A, st.S) };
  const prev = R[k];
  R[k] = { coin, tf, W, A, st, f, bias, biasOk: !!H[coin], px: d.C[d.C.length - 1].c, closedT: W[W.length - 1].t, L: sideSum(st.L, W, f.L), S: sideSum(st.S, W, f.S) };
  if (booted && prev && prev.L) detect(k, prev, R[k]);
}
function detect(k, a, b) {
  for (const s of ['L', 'S']) {
    const x = a[s], y = b[s], same = x.swT === y.swT;
    let ev = null;
    if (isEnded(y) && !(isEnded(x) && same && x.fs === y.fs)) ev = 'end';
    else if (y.fs === 'near' && !(x.fs === 'near' && same)) ev = 'ready';
    else if (y.stage >= 2 && !isEnded(y) && y.fs !== 'old' && !(x.stage >= 2 && same)) ev = 'formed';
    if (!ev) continue;
    const e = { at: Date.now(), coin: b.coin, tf: b.tf, side: s, ev, stage: y.stage, bias: y.bias, sess: y.sess, rr: y.rr, fs: y.fs, fres: y.fres };
    events.unshift(e); events = events.slice(0, 40); store.set('smc-coach-events', events);
    toast(`${e.coin} ${e.tf} ${sideName(s)}劇本 ${evText(e)}`, () => openDetail(e.coin, e.tf, s));
  }
}
let saveT = 0;
function saveCache() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const out = {};
    for (const k in R) if (R[k].L) out[k] = { L: R[k].L, S: R[k].S, px: R[k].px, bias: R[k].bias };
    store.set('smc-coach-cache', { at: Date.now(), R: out });
  }, 800);
}

/* ═════════ 載入與更新 ═════════ */
async function loadAll() {
  const tasks = [];
  loading = 0; loadTotal = COINS.length * (TFS.length + 1);
  for (const coin of COINS) {
    let hp;
    tasks.push(() => (hp = fetchK(coin, '4h', 300).then((r) => { H[coin] = { C: r.C }; computeBias(coin); lastSrc = r.src; }).catch(() => {}).finally(() => { loading++; paint(); })));
    for (const tf of TFS) {
      tasks.push(async () => {
        try {
          const r = await fetchK(coin, tf, BARS + 1);
          await hp;
          D[key(coin, tf)] = { C: r.C, src: r.src }; lastSrc = r.src;
          compute(coin, tf); saveCache();
        } catch (e) { R[key(coin, tf)] = { err: e.message }; } finally { loading++; paint(); }
      });
    }
  }
  await pool(tasks, 6);
  booted = true; lastFull = Date.now(); paint();
}
let lastFull = 0, ticking = false;
async function tick() {
  if (!booted || ticking || document.hidden) return;
  ticking = true;
  try {
    const now = Date.now(), tasks = [];
    for (const coin of COINS) {
      const h = H[coin];
      if (h && now >= h.lastOpen + MS['4h']) tasks.push(async () => { const r = await fetchK(coin, '4h', 3); merge(h.C, r.C); computeBias(coin); for (const tf of TFS) compute(coin, tf); });
      for (const tf of TFS) {
        const d = D[key(coin, tf)];
        if (!d) { tasks.push(async () => { const r = await fetchK(coin, tf, BARS + 1); D[key(coin, tf)] = { C: r.C, src: r.src }; compute(coin, tf); }); continue; }
        if (now >= d.C[d.C.length - 1].t * 1000 + MS[tf]) tasks.push(async () => { const r = await fetchK(coin, tf, 3); merge(d.C, r.C); compute(coin, tf); });
      }
    }
    if (tasks.length) { await pool(tasks, 6); saveCache(); paint(); }
  } finally { ticking = false; }
}

/* ═════════ 文字 ═════════ */
const sideName = (s) => (s === 'L' ? '多單' : '空單');
const biasTxt = (b, d) => (b === 2 ? `4h 偏${d > 0 ? '多' : '空'}，順勢` : b === 1 ? '4h 方向未定' : `4h 偏${d > 0 ? '空' : '多'}，逆勢`);
function sessTxt(s) {
  if (s < 0) return ['掃蕩後再看', 1];
  if (s >= 2) return ['掃蕩在' + SESS_NAME[s], 2];
  if (s === 1) return ['掃蕩在亞洲盤（假突破多）', 0];
  return ['掃蕩不在殺區', 1];
}
const resTxt = (r) => (r == null ? '' : ` ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`);
function evText(e) {
  if (e.ev === 'end') return `${ENDED[e.fs]}${resTxt(e.fres)}`;
  if (e.ev === 'ready') return `已回踩，可進場${e.bias === 2 ? '（順勢）' : ''}`;
  return `${e.stage}/5 成形${e.bias === 2 ? '（順勢）' : ''}`;
}
function stageLabel(x) {
  const L = { pending: '等回踩', near: '可進場', ran: '已跑・不追', deep: '靠近停損', ...ENDED };
  return L[x.fs] || (x.stage >= 2 ? '成形' : x.stage === 1 ? '掃完' : '觀察');
}
function dots(x) { const n = x.ready ? 5 : x.stage; let h = ''; for (let i = 0; i < 5; i++) h += `<i class="${i < n ? 'on' : ''}"></i>`; return `<span class="dots">${h}</span>`; }
function score(x) {
  if (isEnded(x) || x.fs === 'old') return 0;
  const base = { near: 5, pending: 4, ran: 3, deep: 2.5 }[x.fs] ?? x.stage;
  return (base - (x.rr != null && x.rr < 2 ? 0.6 : 0)) * 10 + (x.bias === 2 ? 3 : x.bias === 1 ? 1 : 0) + (x.disc ? 1 : 0) + (x.sess >= 2 ? 1 : 0);
}
function nextShort(x) {
  const low = x.rr != null && x.rr < 2 ? `（只有 ${x.rr.toFixed(1)}R，不到 2R 寧可不做）` : '';
  switch (x.fs) {
    case 'pending': return `可以掛 ${fmt(x.en)} 等回踩${low}`;
    case 'near': return `已回踩、離進場價 ${resTxt(x.fcur).trim()}，還來得及${low}`;
    case 'ran': return `回踩後已經跑了${resTxt(x.fcur)}，不追，等回到 ${fmt(x.en)}`;
    case 'deep': return `往停損方向走了${resTxt(x.fcur)}，靠近停損，先別進`;
  }
  if (isEnded(x)) return nextAfter(x);
  return ['等掃流動性', '等收盤突破結構', '等留下 FVG／OB', '等回踩 POI', '等計畫'][x.stage];
}
/** 劇本結束後：下一個機會從哪裡開始 */
function nextAfter(x) { return `接下來：做多等掃下方 ${fmt(x.ssl)}、做空等掃上方 ${fmt(x.bsl)}`; }

/* ═════════ 時段列 ═════════ */
function nextKz(nowMs) {
  const d = new Date(nowMs), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const nx = h < 7 ? [7, 2] : h < 12 ? [12, 3] : h < 17.5 ? [17.5, 4] : [31, 2];
  return { at: nowMs + Math.round((nx[0] - h) * 60) * 60000, s: nx[1] };
}
function sessionBar() {
  const now = Date.now(), s = sessIdx(now), nk = nextKz(now), mins = Math.round((nk.at - now) / 60000);
  // 台灣時間 0～24 點：亞洲 8–14、倫敦 15–18、紐約早盤 20–23、紐約午盤 1:30–4
  const seg = [[1.5, 4, 4], [8, 14, 1], [15, 18, 2], [20, 23, 3]];
  const x = tpe(now / 1000), pos = (x.h + x.m / 60) / 24 * 100;
  return `<div class="sess card">
    <div class="row"><b class="now">${pad(x.h)}:${pad(x.m)}</b><span class="tag s${s}">${SESS_NAME[s]}${s >= 2 ? '・波動大' : ''}</span><span class="sp"></span>
    <span class="mut small">${s >= 2 ? '現在就是殺區' : `下個殺區 ${SESS_NAME[nk.s].replace('殺區', '')} ${hm(nk.at / 1000)}（${Math.floor(mins / 60)}h${mins % 60}m 後）`}</span></div>
    <div class="tl">${seg.map(([a, b, k]) => `<span class="seg s${k}" style="left:${a / 24 * 100}%;width:${(b - a) / 24 * 100}%"></span>`).join('')}<span class="nowm" style="left:${pos}%"></span></div>
    <div class="tlx"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
  </div>`;
}

/* ═════════ 畫面：掃描板 ═════════ */
const P = store.get('smc-coach-prefs', { tf: 'all', aligned: false, kz: false, tab: 'board' });
let view = 'board', DT = null;
function paint() {
  if (view === 'detail') return renderDetail();
  if (view !== 'board') return;
  if (paint.raf) return;
  paint.raf = requestAnimationFrame(() => { paint.raf = 0; renderBoard(); });
}
function getSum(k) { if (R[k] && R[k].L) return { ...R[k], fresh: true }; if (cache && cache.R[k]) return { ...cache.R[k], fresh: false }; return null; }
function renderBoard() {
  const tabs = `<div class="tabs">${[['board', '掃描'], ['live', '戰績'], ['journal', '日誌'], ['push', '推播'], ['help', '說明']].map(([v, n]) => `<button data-tab="${v}" class="${P.tab === v ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  let body = '';
  if (P.tab === 'push') body = '<div id="push" class="card mut">載入推播紀錄…</div>';
  else if (P.tab === 'help') body = helpHtml();
  else if (P.tab === 'live') body = '<div id="live" class="card mut">載入教練即時戰績…</div>';
  else if (P.tab === 'journal') body = '<div id="journal"></div>';
  else body = boardHtml();
  const prog = !booted ? `<span class="mut small">${cache ? '先顯示上次結果，' : ''}更新中 ${loading}/${loadTotal}</span>` : `<span class="mut small">${lastSrc}・${hm(lastFull / 1000)} 更新</span>`;
  $('#app').innerHTML = `<header class="row"><div><p class="eyebrow">SMC COACH</p><h1>🧭 SMC 教練</h1></div><span class="sp"></span>${prog}</header>${sessionBar()}${tabs}${body}`;
  bindBoard();
  if (P.tab === 'push') loadPush();
  if (P.tab === 'live') X.loadLive();
  if (P.tab === 'journal') X.loadJournal();
  if (P.tab === 'board') X.loadWatches();
}
function boardHtml() {
  const tfs = P.tf === 'all' ? TFS : [P.tf];
  const items = [];
  for (const c of COINS) for (const tf of tfs) {
    const r = getSum(key(c, tf)); if (!r) continue;
    for (const s of ['L', 'S']) {
      const x = r[s];
      if (x.stage < 2 || x.fs === 'old') continue;
      if (P.aligned && x.bias !== 2) continue;
      if (P.kz && x.sess < 2) continue;
      items.push({ c, tf, s, x, fresh: r.fresh });
    }
  }
  items.sort((a, b) => score(b.x) - score(a.x));
  const active = items.filter((it) => !isEnded(it.x)), ended = items.filter((it) => isEnded(it.x)).sort((a, b) => b.x.fAt - a.x.fAt);
  const filt = `<div class="filters"><div class="seg2">${['all', ...TFS].map((t) => `<button data-tf="${t}" class="${P.tf === t ? 'on' : ''}">${t === 'all' ? '全部' : t}</button>`).join('')}</div>
    <button class="chip ${P.aligned ? 'on' : ''}" data-f="aligned">只看順勢</button><button class="chip ${P.kz ? 'on' : ''}" data-f="kz">只看殺區掃蕩</button></div>`;
  const cards = active.length ? active.map(({ c, tf, s, x, fresh }) => {
    const st = sessTxt(x.sess), d = s === 'L' ? 1 : -1, hot = x.fs === 'near' && x.rr >= 2;
    return `<button class="setup ${hot ? 'ready' : ''} ${x.fs === 'ran' || x.fs === 'deep' ? 'cold' : ''} ${fresh ? '' : 'stale'}" data-open="${c}|${tf}|${s}">
      <div class="row"><b class="sym">${c}</b><span class="mut">${tf}</span><span class="side ${s}">${sideName(s)}</span><span class="sp"></span>${dots(x)}<b class="stg ${hot ? 'gold' : ''}">${x.ready ? 5 : x.stage}/5 ${stageLabel(x)}</b></div>
      <div class="badges"><span class="b${x.bias === 2 ? ' ok' : x.bias === 0 ? ' no' : ''}">${x.bias === 2 ? '✓' : x.bias === 0 ? '✗' : '◐'} ${biasTxt(x.bias, d)}</span><span class="b${x.disc ? ' ok' : ' no'}">${x.disc ? '✓' : '✗'} ${x.disc ? (d > 0 ? '折價' : '溢價') : (d > 0 ? '溢價' : '折價')}</span><span class="b${st[1] === 2 ? ' ok' : st[1] === 0 ? ' no' : ''}">⏰ ${st[0]}</span></div>
      <div class="nx">下一步：${nextShort(x)}${x.rr && x.fs !== 'ran' && x.fs !== 'deep' && x.rr >= 2 ? `・約 ${x.rr.toFixed(1)}R` : ''}</div></button>`;
  }).join('') : `<div class="card mut">${booted || cache ? '目前沒有還能做的劇本' + (P.aligned || P.kz ? '（篩選條件下）' : '') + '。下面的總表可以看每個幣在第幾步。' : '載入中…'}</div>`;
  const endCards = ended.length ? `<p class="h3">剛結束（最近 ${RECENT} 根內，不能再進）</p>` + ended.map(({ c, tf, s, x, fresh }) => `<button class="setup done ${fresh ? '' : 'stale'}" data-open="${c}|${tf}|${s}">
      <div class="row"><b class="sym">${c}</b><span class="mut">${tf}</span><span class="side ${s}">${sideName(s)}</span><span class="sp"></span><b class="stg ${x.fs === 'tp' ? 'up' : x.fs === 'sl' || x.fs === 'fail' ? 'dn' : 'mut'}">${ENDED[x.fs]}${resTxt(x.fres)}</b></div>
      <div class="nx mut">${x.fAt ? hm(x.fAt) + ' 結束・' : ''}${nextAfter(x)}</div></button>`).join('') : '';
  const grid = `<div class="grid"><div class="gh"><span></span>${TFS.map((t) => `<span>${t}</span>`).join('')}</div>${COINS.map((c) => `<div class="gr"><b>${c}</b>${TFS.map((tf) => {
    const r = getSum(key(c, tf));
    if (!r) return `<span class="cell mut">${R[key(c, tf)] && R[key(c, tf)].err ? '✗' : '…'}</span>`;
    let s = score(r.L) >= score(r.S) ? 'L' : 'S', x = r[s];
    if (score(x) === 0) { const e = ['L', 'S'].find((q) => isEnded(r[q])); if (e) { s = e; x = r[e]; } else { s = r.L.stage >= r.S.stage ? 'L' : 'S'; x = r[s]; } }
    if (isEnded(x)) return `<button class="cell ended ${r.fresh ? '' : 'stale'}" data-open="${c}|${tf}|${s}">${s === 'L' ? '多' : '空'} ${x.fs === 'tp' ? '✓完' : '✗完'}</button>`;
    const n = x.ready ? 5 : x.stage, hot = x.fs === 'near';
    return `<button class="cell ${n >= 2 ? s : ''} ${hot ? 'ready' : ''} ${r.fresh ? '' : 'stale'}" data-open="${c}|${tf}|${s}">${n ? `${s === 'L' ? '多' : '空'} ${n}` : '—'}${x.bias === 2 && n >= 2 ? '<i>順</i>' : ''}</button>`;
  }).join('')}</div>`).join('')}</div>`;
  const evs = events.length ? `<div class="card"><p class="h3">最新動態（App 開著時）</p>${events.slice(0, 8).map((e) => `<button class="ev" data-open="${e.coin}|${e.tf}|${e.side}"><span class="mut small">${hm(e.at / 1000)}</span><span class="side ${e.side}">${e.coin} ${e.tf} ${sideName(e.side)}</span><span>${evText(e)}${e.ev !== 'end' && e.sess >= 2 ? '・' + SESS_NAME[e.sess].replace('殺區', '') : ''}</span></button>`).join('')}</div>` : '';
  return `<div id="watches"></div>${filt}<p class="h3">還能做的劇本（第 2 步以上）</p>${cards}${endCards}${evs}<p class="h3">全部幣種（每格顯示走得比較前面的那一邊）</p>${grid}
    <p class="foot mut small">教練只說劇本走到哪一步，不是進場訊號。回測 150 天、15 檔：教練劇本＋4h 同向平均每筆約 -0.05R，沒有穩定優勢。</p>`;
}
function helpHtml() {
  return `<div class="card help"><p class="h3">教練看的 5 步</p><ol>
    <li><b>掃流動性</b>：最近 45 根內，影線刺破一個還沒被碰過的前低（做多）／前高（做空），當根或下一根收回。</li>
    <li><b>結構轉向</b>：掃完之後收盤突破外部擺動點（BOS／CHoCH），只有影線不算。</li>
    <li><b>POI</b>：突破那段留下的 FVG（沒有就用 OB）。</li>
    <li><b>回踩</b>：價格回到 POI。</li>
    <li><b>計畫</b>：進場＝POI 邊緣、停損＝掃出來的極值外 0.15 ATR、目標＝最近還沒被掃的對面擺動點。</li></ol>
    <p class="h3">劇本走到後面會怎樣</p><p>回踩那根收盤時把進場／停損／目標固定下來，之後逐根追蹤：<b>可以先掛單</b>（POI 出來還沒回踩）、<b>已回踩・還來得及</b>（離進場價 0.5R 內）、<b>已經跑了・不追</b>（往獲利方向超過 0.5R）、<b>靠近停損</b>。到目標、打到停損、沒回踩就走掉、掃蕩被收盤破掉、回踩後 48 根沒結果，都算<b>結束</b>，移到「剛結束」，並告訴你下一個劇本要等價格去掃哪裡。</p>
    <p class="h3">背景三項</p><p>4h 方向（順勢／逆勢）、位置（近 80 根區間的折價／溢價）、⏰ 時段（掃蕩有沒有發生在倫敦或紐約殺區）。</p>
    <p class="h3">時段（台灣時間，固定 UTC，不跟夏令時間變）</p>
    <table class="tt"><tr><td><span class="sw s1"></span>亞洲盤</td><td>08:00–14:00</td><td>波動小，常畫出區間</td></tr><tr><td><span class="sw s2"></span>倫敦殺區</td><td>15:00–18:00</td><td>常去掃亞洲高／低</td></tr><tr><td><span class="sw s3"></span>紐約早盤殺區</td><td>20:00–23:00</td><td>一天波動最大</td></tr><tr><td><span class="sw s4"></span>紐約午盤殺區</td><td>01:30–04:00</td><td>常見反轉</td></tr></table>
    <p class="h3">怎麼加到主畫面</p><p>用 Safari 打開這個網址 → 分享 → 加入主畫面。行情是手機直接向 Bybit 拿，App 開著時每根 K 棒收盤會自動更新；關掉時改看 Discord 的教練提醒。</p>
    <p class="mut small">跟 Discord 教練提醒、SMC 道場看盤教室是同一份規則（src/smc/coach.js）。</p></div>`;
}
async function loadPush() {
  const el = $('#push'); if (!el) return;
  try {
    const r = await fetch(WORKER + '/coach', { cache: 'no-store' }); const j = await r.json(); const list = j.alerts || [];
    if (!$('#push')) return;
    el.classList.remove('mut');
    el.innerHTML = list.length ? list.slice(0, 40).map((a) => {
      const coin = a.sym.replace(/USDT$/, ''), ok = COINS.includes(coin) && TFS.includes(a.iv);
      return `<button class="ev" ${ok ? `data-open="${coin}|${a.iv}|${a.side}"` : 'disabled'}><span class="mut small">${mdhm(a.at / 1000)}</span><span class="side ${a.side}">${coin} ${a.iv} ${sideName(a.side)}</span><span>${a.event === 'ready' ? '5/5 到位' : a.stage + '/5 成形'}${a.rr ? '・' + a.rr + 'R' : ''}</span></button>`;
    }).join('') : '還沒有推播。Discord 推出第一則教練提醒之後就會出現在這裡。';
  } catch (e) { el.textContent = '讀不到推播紀錄：' + e.message; }
}
function bindBoard() {
  document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { P.tab = b.dataset.tab; store.set('smc-coach-prefs', P); renderBoard(); }; });
  document.querySelectorAll('[data-tf]').forEach((b) => { b.onclick = () => { P.tf = b.dataset.tf; store.set('smc-coach-prefs', P); renderBoard(); }; });
  document.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { P[b.dataset.f] = !P[b.dataset.f]; store.set('smc-coach-prefs', P); renderBoard(); }; });
  document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { const [c, tf, s] = b.dataset.open.split('|'); openDetail(c, tf, s); }; });
}

/* ═════════ 畫面：單一劇本（圖表＋教練） ═════════ */
let dTimer = 0, chart = null;
function openDetail(coin, tf, side, push = true) {
  DT = { coin, tf, side: side || 'L' };
  if (push) { view = 'detail'; scrollTo(0, 0); history.pushState({ d: 1 }, ''); }
  $('#app').innerHTML = `<header class="row"><button class="back" id="bk">‹ 掃描板</button><span class="sp"></span><span class="mut small" id="dst"></span></header>
    <div class="row dh"><b class="sym big">${coin}</b><span class="seg2">${TFS.map((t) => `<button data-dtf="${t}" class="${t === tf ? 'on' : ''}">${t}</button>`).join('')}</span><span class="sp"></span><b id="dpx" class="num"></b></div>
    <div class="seg2 sides"><button data-side="L">多單劇本</button><button data-side="S">空單劇本</button></div>
    <div class="chartbox"><canvas id="cv"></canvas><div class="zoom"><button data-z="1.25">＋</button><button data-z="0.8">－</button><button data-z="0">最新</button></div></div>
    <div id="coach"></div>
    <div id="watchbox"></div>
    <a class="tvlink mut small" target="_blank" rel="noopener" href="https://www.tradingview.com/chart/?symbol=BYBIT:${coin}USDT.P&interval=${IV[tf][0]}">在 TradingView 打開 ${coin} ${tf} ↗</a>`;
  $('#bk').onclick = () => history.back();
  document.querySelectorAll('[data-dtf]').forEach((b) => { b.onclick = () => openDetail(DT.coin, b.dataset.dtf, DT.side, false); });
  document.querySelectorAll('[data-side]').forEach((b) => { b.onclick = () => { DT.side = b.dataset.side; if (chart) { chart.fitted = false; chart.end = null; } renderDetail(); }; });
  chart = new Chart($('#cv'));
  document.querySelectorAll('[data-z]').forEach((b) => { b.onclick = () => { const z = +b.dataset.z; if (z) chart.zoom(z); else { chart.end = null; chart.draw(); } }; });
  clearInterval(dTimer); dTimer = setInterval(liveTick, 15000);
  ensureData(coin, tf).then(renderDetail, (e) => { $('#coach').innerHTML = `<div class="card no">連不到交易所：${esc(e.message)}</div>`; });
  renderDetail();
}
async function ensureData(coin, tf) {
  const k = key(coin, tf);
  if (!H[coin]) { try { const r = await fetchK(coin, '4h', 300); H[coin] = { C: r.C }; computeBias(coin); } catch { /* 沒有大週期就當方向未定 */ } }
  if (!D[k]) { const r = await fetchK(coin, tf, BARS + 1); D[k] = { C: r.C, src: r.src }; }
  compute(coin, tf);
}
async function liveTick() {
  if (view !== 'detail' || document.hidden) return;
  const { coin, tf } = DT, d = D[key(coin, tf)]; if (!d) return;
  try { const r = await fetchK(coin, tf, 3); merge(d.C, r.C); compute(coin, tf); renderDetail(); } catch { /* 下次再試 */ }
}
window.addEventListener('popstate', () => { if (view === 'detail') { view = 'board'; clearInterval(dTimer); chart = null; renderBoard(); } });

function stepsOf(R0, s) {
  const W = R0.W, A = R0.A, r = R0.st[s], f = R0.f[s], d = s === 'L' ? 1 : -1, j = W.length - 1, a = A.atr[j], px = W[j].c, D2 = (x, y) => (d > 0 ? x : y);
  const out = [];
  const sw = r.sweep;
  out.push(sw ? { ok: 2, t: `影線刺破 ${fmt(sw.p)} ${D2('下方 SSL（多單止損）', '上方 BSL（空單止損）')}後收回・${mdhm(W[sw.u].t)}` } : { ok: 0, t: `等價格刺破前${D2('低（SSL）', '高（BSL）')}又收回來` });
  let lvl = null;
  if (sw && !r.ev) for (const p of A.piv) if (p.hi === (d > 0 ? 1 : 0) && p.k <= j && p.sw == null && (d > 0 ? p.p > px : p.p < px)) lvl = lvl == null ? p.p : (d > 0 ? Math.min(lvl, p.p) : Math.max(lvl, p.p));
  out.push(r.ev ? { ok: 2, t: `收盤${D2('突破', '跌破')} ${fmt(r.ev.p)}，${r.ev.t} 成立` } : { ok: 0, t: !sw ? '等前一步' : `等收盤${D2('突破', '跌破')}${lvl != null ? '最近的擺動點 ' + fmt(lvl) : '下一個擺動點'}，只有影線不算` });
  out.push(r.poi ? { ok: 2, t: `留下${D2('多方', '空方')} ${r.poi.kind} ${fmt(r.poi.bot)} – ${fmt(r.poi.top)}` } : { ok: 0, t: !r.ev ? '等前一步' : '這次轉向沒留下乾淨的 FVG／OB，等下一段位移' });
  out.push(r.rt != null ? { ok: 2, t: `已回到 POI・${mdhm(W[r.rt].t)}` } : { ok: 0, t: !r.poi ? '等前一步' : `等價格回到 ${fmt(D2(r.poi.top, r.poi.bot))}，現在還差 ${(Math.abs(px - D2(r.poi.top, r.poi.bot)) / a).toFixed(1)} 根 ATR，不要追價` });
  const pl = f.plan;
  out.push(pl && r.rt != null ? { ok: pl.rr >= 2 ? 2 : 1, t: `進場 ${fmt(pl.en)}・停損 ${fmt(pl.sl)}・目標 ${fmt(pl.tp)}・${pl.rr.toFixed(1)}R${pl.rr < 2 ? '（不到 2R，寧可不做）' : ''}（回踩那根算好的，之後不會變）` }
    : pl ? { ok: 0, t: `預計：進場 ${fmt(pl.en)}・停損 ${fmt(pl.sl)}・目標 ${fmt(pl.tp)}・${pl.rr.toFixed(1)}R，可以先掛限價單` } : { ok: 0, t: r.stage >= 4 ? '盈虧比算不出來，先不做' : '有 POI 之後再算停損和目標' });
  return out;
}
function renderDetail() {
  if (view !== 'detail' || !DT) return;
  const { coin, tf, side } = DT, R0 = R[key(coin, tf)];
  document.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
  const d = D[key(coin, tf)];
  if (d) { $('#dpx').textContent = fmt(d.C[d.C.length - 1].c); $('#dst').textContent = `${d.src}・${hm(Date.now() / 1000)}`; }
  if (R0 && R0.err) { $('#coach').innerHTML = `<div class="card no">這個週期沒有資料：${esc(R0.err)}</div>`; return; }
  if (!R0 || !R0.W) { if (!$('#coach').innerHTML) $('#coach').innerHTML = '<div class="card mut">載入中…</div>'; return; }
  const x = R0[side], r = R0.st[side], f = R0.f[side], dd = side === 'L' ? 1 : -1, steps = stepsOf(R0, side), st = sessTxt(x.sess);
  const ended = isEnded(x), old = x.fs === 'old', other = side === 'L' ? 'S' : 'L', ox = R0[other];
  const n = x.ready ? 5 : x.stage, nextI = steps.findIndex((s, i) => (i < 4 ? i >= x.stage : !x.ready));
  const now = Date.now(), sc = sessIdx(now), nk = nextKz(now);
  const bad = [x.bias !== 2 ? '大週期' : '', !x.disc ? '位置' : '', x.sess < 2 ? '時段' : ''].filter(Boolean).join('、');
  const pl = f.plan, low = pl && pl.rr < 2;
  let head = '下一步還差', cls = '', next = steps[nextI] ? `${STEP_N[nextI]}：${steps[nextI].t}` : '';
  if (x.fs === 'pending') { head = '可以先掛單'; next = `POI 已經出來、還沒回踩：可以在 ${fmt(pl.en)} 掛限價單等，停損 ${fmt(pl.sl)}、目標 ${fmt(pl.tp)}（${pl.rr.toFixed(1)}R）。${low ? '不到 2R，寧可不做。' : ''}價格先走到目標就算錯過，取消掛單。`; }
  if (x.fs === 'near') { head = '已回踩，還來得及'; cls = low ? '' : 'ok'; next = `現在離進場價${resTxt(f.cur)}（在 0.5R 內），還能照計畫進：進場 ${fmt(pl.en)}・停損 ${fmt(pl.sl)}・目標 ${fmt(pl.tp)}（${pl.rr.toFixed(1)}R）。` + (low ? '但不到 2R，寧可不做。' : bad ? `背景有 ✗（${bad}），倉位減半或跳過。` : '背景都對，停損一定要放。'); }
  if (x.fs === 'ran') { head = '已經跑了，不要追'; cls = 'warn'; next = `回踩之後已經往${dd > 0 ? '上' : '下'}跑了${resTxt(f.cur)}，現在進盈虧比太差。等價格回到 ${fmt(pl.en)} 附近再考慮（停損 ${fmt(pl.sl)} 不變）；先到目標 ${fmt(pl.tp)} 就結束。`; }
  if (x.fs === 'deep') { head = '靠近停損，先別進'; cls = 'warn'; next = `回踩之後往停損方向走了${resTxt(f.cur)}，離停損 ${fmt(pl.sl)} 很近。已經在場內的照計畫，沒進的不要現在進。`; }
  if (ended || old) {
    head = old ? '這邊目前沒有劇本' : `這個劇本已經結束：${ENDED[x.fs]}${resTxt(x.fres)}`; cls = 'end';
    const why = { tp: '價格已經到目標', sl: '價格打到停損', missed: '還沒回踩就先走到目標，錯過了', stale: '回踩後很久都沒走到目標或停損', fail: '收盤破掉掃出來的影線，這次掃蕩是假的' }[x.fs];
    next = (old ? '' : `${why}${x.fAt ? '（' + mdhm(x.fAt) + '）' : ''}，不能再照這個劇本進場。`) + `接下來還有沒有機會：${dd > 0 ? `做多要等價格再掃一次下方流動性 ${fmt(x.ssl)} 並收回` : `做空要等價格再掃一次上方流動性 ${fmt(x.bsl)} 並收回`}，才會開始新的劇本。` +
      (ox && ox.stage >= 1 && !isEnded(ox) && ox.fs !== 'old' ? `反方向的${sideName(other)}劇本現在 ${ox.ready ? 5 : ox.stage}/5（${stageLabel(ox)}），可以切過去看。` : '');
  }
  const showSteps = !(ended || old);
  $('#coach').innerHTML = `<div class="card">
    <div class="row"><b>${coin} ${tf} ${sideName(side)}劇本</b><span class="sp"></span>${showSteps ? dots(x) : ''}<b class="${x.fs === 'near' && !low ? 'gold' : ''}">${showSteps ? n + '/5 ' : ''}${stageLabel(x)}</b></div>
    <div class="next ${cls}"><b>${head}</b><br>${esc(next)}</div>
    ${showSteps ? steps.map((s, i) => `<div class="step ${s.ok === 2 ? 'ok' : s.ok === 1 ? 'half' : ''} ${i === nextI && !x.ready ? 'cur' : ''}"><span class="ic">${s.ok === 2 ? '✓' : s.ok === 1 ? '◐' : i === nextI ? '▶' : '○'}</span><div><b>${i + 1}. ${STEP_N[i]}</b><p>${esc(s.t)}</p></div></div>`).join('') : ''}
    <p class="h3">背景</p>
    <div class="step ctx ${x.bias === 2 ? 'ok' : x.bias === 0 ? 'bad' : 'half'}"><span class="ic">${x.bias === 2 ? '✓' : x.bias === 0 ? '✗' : '◐'}</span><div><b>大週期 4h</b><p>${R0.biasOk ? biasTxt(x.bias, dd) + (x.bias === 0 ? '，要更嚴格、倉位要小' : '') : '4h 行情沒抓到，先當方向未定'}</p></div></div>
    <div class="step ctx ${x.disc ? 'ok' : 'bad'}"><span class="ic">${x.disc ? '✓' : '✗'}</span><div><b>位置（折價／溢價）</b><p>${x.disc ? `在近 80 根區間 50% 的${dd > 0 ? '下方（折價，便宜）' : '上方（溢價，貴）'}` : `價格在${dd > 0 ? '溢價區，做多偏貴' : '折價區，做空偏便宜'}，等回到 50% ${dd > 0 ? '以下' : '以上'}`}</p></div></div>
    <div class="step ctx ${st[1] === 2 ? 'ok' : st[1] === 0 ? 'bad' : 'half'}"><span class="ic">${st[1] === 2 ? '✓' : st[1] === 0 ? '✗' : '◐'}</span><div><b>⏰ 時段</b><p>${st[0]}${x.sess >= 2 ? '，大資金進場的時段，比較可信' : ''}。現在是${SESS_NAME[sc]}${sc >= 2 ? '（波動大）' : `，下個殺區 ${hm(nk.at / 1000)} 開始`}。</p></div></div>
  </div>`;
  // 圖表：已收盤的 W 對到含盤中那根的 C
  const C = d.C, base = C.findIndex((c) => c.t === R0.W[0].t), ann = [], W0c = (i) => R0.W[i].c;
  if (base >= 0) {
    const I = (i) => i + base;
    if (r.sweep) { ann.push({ t: 'line', i1: I(r.sweep.u) - 14, i2: I(r.sweep.u) + 2, p: r.sweep.p, c: COL.gold, dash: 1, label: dd > 0 ? 'SSL 被掃' : 'BSL 被掃' }); ann.push({ t: 'mark', i: I(r.sweep.u), p: r.sweep.x, c: COL.gold, up: dd < 0, label: '掃' }); }
    if (r.ev) ann.push({ t: 'line', i1: I(r.ev.i) - 8, i2: I(r.ev.i), p: r.ev.p, c: dd > 0 ? COL.up : COL.dn, w: 1.6, label: r.ev.t });
    if (r.poi) ann.push({ t: 'zone', i1: I(r.poi.i), p1: r.poi.top, p2: r.poi.bot, fill: dd > 0 ? 'rgba(44,211,163,.16)' : 'rgba(255,110,110,.16)', stroke: dd > 0 ? COL.up : COL.dn, label: 'POI ' + r.poi.kind });
    if (f.plan && !old) ann.push({ t: 'plan', i1: I(r.rt != null ? r.rt : f.plan.at), en: f.plan.en, sl: f.plan.sl, tp: f.plan.tp, label: `${dd > 0 ? '多' : '空'} ${f.plan.rr.toFixed(1)}R${ended ? '・' + ENDED[x.fs] : r.rt == null ? '・掛單' : ''}` });
    if (f.at != null && ended) ann.push({ t: 'mark', i: I(f.at), p: x.fs === 'tp' ? f.plan.tp : x.fs === 'sl' ? f.plan.sl : W0c(f.at), c: x.fs === 'tp' ? COL.up : COL.dn, up: x.fs === 'tp' ? dd < 0 : dd > 0, label: '' });
    const nx = dd > 0 ? x.ssl : x.bsl;
    if (nx != null && (ended || old || r.stage === 0)) ann.push({ t: 'line', i1: C.length - 30, i2: C.length + 3, p: nx, c: COL.sel, dash: 1, label: `下一個${dd > 0 ? ' SSL' : ' BSL'}：等掃這裡` });
  }
  if (chart && !chart.fitted && base >= 0) {
    // 第一次打開：縮放到看得到掃蕩那根（往前多留 12 根）
    const from = r.sweep ? base + r.sweep.u - 12 : C.length - 90, pw = (chart.cv.clientWidth || 360) - 58;
    chart.bw = Math.max(2.5, Math.min(10, pw / (C.length + 4 - from)));
    chart.fitted = true;
  }
  if (chart) chart.set(C, ann);
  X.watchButton(coin, tf, side, x, f);
}

/* ═════════ K 線圖（拖曳、雙指縮放、時段底色） ═════════ */
class Chart {
  constructor(cv) {
    this.cv = cv; this.bw = 7; this.end = null; this.C = []; this.ann = [];
    const P2 = {}; let drag = null, pinch = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId); P2[e.pointerId] = { x: e.clientX, y: e.clientY }; const ks = Object.keys(P2);
      if (ks.length === 2) { const a = P2[ks[0]], b = P2[ks[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), bw: this.bw }; drag = null; } else drag = { x: e.clientX, end: this.right() };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!P2[e.pointerId]) return; P2[e.pointerId] = { x: e.clientX, y: e.clientY }; const ks = Object.keys(P2);
      if (pinch && ks.length === 2) { const a = P2[ks[0]], b = P2[ks[1]]; this.bw = Math.max(2.5, Math.min(26, pinch.bw * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); this.draw(); return; }
      if (drag) { this.end = Math.max(20, Math.min(this.C.length + 6, drag.end - (e.clientX - drag.x) / this.bw)); this.draw(); }
    });
    const up = (e) => { delete P2[e.pointerId]; if (Object.keys(P2).length < 2) pinch = null; if (!Object.keys(P2).length) drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    new ResizeObserver(() => this.draw()).observe(cv);
  }
  right() { return this.end == null ? this.C.length - 1 + 4 : this.end; }
  zoom(f) { this.bw = Math.max(2.5, Math.min(26, this.bw * f)); this.draw(); }
  set(C, ann) { this.C = C; this.ann = ann || []; this.draw(); }
  draw() {
    const cv = this.cv, C = this.C, dpr = devicePixelRatio || 1, W = cv.clientWidth || 360, Hh = cv.clientHeight || 340;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(Hh * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.fillStyle = COL.bg; x.fillRect(0, 0, W, Hh);
    if (!C.length) return;
    const AX = 58, pw = W - AX, ph = Hh - 20, bw = this.bw, right = this.right(), left = right - pw / bw;
    const i0 = Math.max(0, Math.floor(left)), i1 = Math.min(C.length - 1, Math.ceil(right));
    let lo = 1e18, hi = -1e18;
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, C[i].l); hi = Math.max(hi, C[i].h); }
    for (const a of this.ann) if (a.t === 'plan') { lo = Math.min(lo, a.sl, a.tp); hi = Math.max(hi, a.sl, a.tp); }
    const pv = (hi - lo) * 0.08 || 1; lo -= pv; hi += pv;
    const X = (i) => pw - (right - i + 0.5) * bw, Y = (p) => 6 + (hi - p) / (hi - lo) * (ph - 12);
    // 時段底色
    let prevS = -1, lastLab = -1e9; x.font = '600 9.5px "Noto Sans TC",sans-serif';
    const SHORT = ['', '亞洲', '倫敦', '紐約', '紐午'];
    for (let i = i0; i <= i1; i++) {
      const s = sessIdx(C[i].t * 1000);
      if (s) { x.fillStyle = SESS_COL[s]; x.fillRect(X(i) - bw / 2, 0, bw + 0.6, ph); const lx = Math.max(2, X(i) - bw / 2 + 2); if (s !== prevS && lx - lastLab > 30) { x.fillStyle = 'rgba(232,237,247,.4)'; x.fillText(SHORT[s], lx, 12); lastLab = lx; } }
      prevS = s;
    }
    // 格線＋價格軸
    const step = nice((hi - lo) / 6); x.font = '10.5px "Chakra Petch",ui-monospace,monospace'; x.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) { const yy = Math.round(Y(v)) + 0.5; x.strokeStyle = COL.grid; x.beginPath(); x.moveTo(0, yy); x.lineTo(pw, yy); x.stroke(); x.fillStyle = COL.ax; x.fillText(fmt(v), pw + 4, yy); }
    // 時間軸
    x.textBaseline = 'alphabetic'; x.textAlign = 'center'; const every = Math.max(1, Math.ceil(64 / bw));
    for (let i = Math.ceil(i0 / every) * every; i <= i1; i += every) { const xx = X(i); if (xx < 18 || xx > pw - 18) continue; const tt = tpe(C[i].t); x.fillStyle = COL.ax; x.fillText(tt.h === 0 && tt.m === 0 ? tt.M + '/' + tt.D : pad(tt.h) + ':' + pad(tt.m), xx, Hh - 5); }
    x.textAlign = 'left';
    x.save(); x.beginPath(); x.rect(0, 0, pw, ph); x.clip();
    for (const a of this.ann) {
      if (a.t === 'zone') { const xa = X(a.i1) - bw / 2, yt = Y(Math.max(a.p1, a.p2)), hh = Math.max(1, Math.abs(Y(a.p1) - Y(a.p2))); x.fillStyle = a.fill; x.fillRect(xa, yt, pw - xa, hh); x.strokeStyle = a.stroke; x.setLineDash([3, 3]); x.strokeRect(xa, yt, pw - xa, hh); x.setLineDash([]); x.fillStyle = a.stroke; x.font = '600 10px "Noto Sans TC",sans-serif'; x.textAlign = 'right'; x.fillText(a.label, pw - 4, yt + 11); x.textAlign = 'left'; }
      if (a.t === 'plan') { const xs = X(a.i1) - bw / 2, xe = pw; x.fillStyle = 'rgba(44,211,163,.11)'; x.fillRect(xs, Math.min(Y(a.en), Y(a.tp)), xe - xs, Math.abs(Y(a.tp) - Y(a.en))); x.fillStyle = 'rgba(255,110,110,.12)'; x.fillRect(xs, Math.min(Y(a.en), Y(a.sl)), xe - xs, Math.abs(Y(a.sl) - Y(a.en))); x.strokeStyle = COL.fg; x.beginPath(); x.moveTo(xs, Y(a.en)); x.lineTo(xe, Y(a.en)); x.stroke(); x.fillStyle = COL.fg; x.font = '600 10px "Noto Sans TC",sans-serif'; x.fillText(a.label, xs + 3, Y(a.en) - 4); }
    }
    const cw = Math.max(1, bw * 0.68);
    for (let i = i0; i <= i1; i++) { const k = C[i], u = k.c >= k.o, cx = X(i); x.strokeStyle = x.fillStyle = u ? COL.up : COL.dn; x.beginPath(); x.moveTo(Math.round(cx) + 0.5, Y(k.h)); x.lineTo(Math.round(cx) + 0.5, Y(k.l)); x.stroke(); const yt = Y(Math.max(k.o, k.c)), yb = Y(Math.min(k.o, k.c)); x.fillRect(cx - cw / 2, yt, cw, Math.max(1, yb - yt)); }
    for (const a of this.ann) {
      if (a.t === 'line') { const xa = X(a.i1), xb = X(a.i2), y = Math.round(Y(a.p)) + 0.5; x.strokeStyle = a.c; x.lineWidth = a.w || 1; x.setLineDash(a.dash ? [4, 3] : []); x.beginPath(); x.moveTo(xa, y); x.lineTo(xb, y); x.stroke(); x.setLineDash([]); x.lineWidth = 1; x.fillStyle = a.c; x.font = '700 10px "Noto Sans TC",sans-serif'; x.fillText(a.label, Math.max(2, xa + 2), y - 4); }
      if (a.t === 'mark') { const mx = X(a.i), my = Y(a.p); x.fillStyle = a.c; x.beginPath(); if (a.up) { x.moveTo(mx, my - 4); x.lineTo(mx - 4, my - 10); x.lineTo(mx + 4, my - 10); } else { x.moveTo(mx, my + 4); x.lineTo(mx - 4, my + 10); x.lineTo(mx + 4, my + 10); } x.fill(); x.font = '700 10px "Noto Sans TC",sans-serif'; x.fillText(a.label, mx - 5, a.up ? my - 13 : my + 21); }
    }
    x.restore();
    const lc = C[C.length - 1], ly = Y(lc.c), col = lc.c >= lc.o ? COL.up : COL.dn;
    x.strokeStyle = col; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(Math.min(pw, X(C.length - 1)), ly); x.lineTo(pw, ly); x.stroke(); x.setLineDash([]);
    x.fillStyle = col; x.fillRect(pw + 1, ly - 8, AX - 2, 16); x.fillStyle = '#0A0F1D'; x.font = '700 10.5px "Chakra Petch",monospace'; x.textBaseline = 'middle'; x.fillText(fmt(lc.c), pw + 4, ly); x.textBaseline = 'alphabetic';
  }
}
function nice(r) { const m = Math.pow(10, Math.floor(Math.log10(r))), f = r / m; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * m; }

/* ═════════ 其他 ═════════ */
let toastT = 0;
function toast(msg, onTap) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = '🧭 ' + msg; t.className = 'show'; t.onclick = () => { t.className = ''; onTap && onTap(); };
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 6000);
}

renderBoard();
loadAll();
setInterval(tick, 20000);
setInterval(() => { if (view === 'board' && P.tab === 'board' && booted) renderBoard(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (view === 'board') renderBoard(); } });
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
window.__coach = { R, D, H, openDetail, events: () => events };
/* 戰績、日誌、盯這單（extras.js）要用到的東西 */
Object.assign(window.__coach, { fetchK, MS, TFS, COINS, WORKER, fmt, hm, mdhm, esc, sessIdx, SESS_NAME, ENDED, store, openDetail, renderBoard, toast, sideName });
import('./extras.js').then((m) => m.install(window.__coach, X)).catch((e) => console.error('extras', e));
