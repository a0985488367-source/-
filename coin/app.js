/**
 * 幣種全週期雷達：搜一個幣，15m～1w 每個週期的偏向、結構、流動性與獵取、關鍵點位、進場計畫、
 * 順勢策略狀態、合約數據一次列出來（2026-10-07 使用者要的獨立網頁）。
 * 分析邏輯全在 src/radar/coin-report.js（純函式、有測試）；這裡只負責抓資料跟畫畫面。
 */

import { PROVIDERS } from '../src/data/providers.js';
import { fetchDerivatives } from '../src/data/derivatives.js';
import { oiChangePct, annualizeFunding, fundingCountdown } from '../src/smc/derivatives.js';
import { buildCoinReport, REPORT_TFS } from '../src/radar/coin-report.js';

const bybit = PROVIDERS.bybit;
const $ = (id) => document.getElementById(id);
const QUICK = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'LINK', 'AVAX', 'SUI'];
const STORE = 'coin-radar:last';
const FULL_REFRESH_MS = 60_000;
const TICK_MS = 3_000;

let sym = null;
let report = null;
let livePrice = null;
let ticker = null;
let deriv = null;
let ls = null;
let fullTimer = null;
let tickTimer = null;
let loadSeq = 0;
const openTfs = new Set(['4h']);

/* ───────────── 格式 ───────────── */
let decimals = 2;
const setDecimals = (p) => { decimals = p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 8; };
const fp = (p) => (Number.isFinite(p) ? p.toFixed(decimals) : '-');
const dist = (p) => (Number.isFinite(p) && livePrice ? ((p - livePrice) / livePrice) * 100 : null);
const fd = (d) => (d == null ? '-' : `${d > 0 ? '+' : ''}${d.toFixed(Math.abs(d) < 1 ? 2 : 1)}%`);
const dcls = (d) => (d == null ? '' : d > 0 ? 'up' : d < 0 ? 'down' : '');
const tw = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const BIAS = { bullish: '偏多', bearish: '偏空', neutral: '中性' };
const TREND = { bullish: '多頭', bearish: '空頭', ranging: '盤整' };
const DIRZ = { long: '做多', short: '做空', bull: '多', bear: '空' };
const POI_ZH = { 'Order Block': 'OB', Breaker: 'Breaker', FVG: 'FVG', 'Inversion FVG': '反轉 FVG', 'Volume Imbalance': '量能缺口' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const biasCls = (score) => (score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral');

/* ───────────── 資料 ───────────── */
async function fetchLsRatio(symbol) {
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=24`).then((x) => x.json());
    if (r.retCode !== 0) return null;
    return r.result.list.map((x) => ({ time: Number(x.timestamp), buy: Number(x.buyRatio), sell: Number(x.sellRatio) })).sort((a, b) => a.time - b.time);
  } catch { return null; }
}

async function loadAll(symbol, { quiet = false } = {}) {
  const seq = ++loadSeq;
  if (!quiet) {
    $('out').innerHTML = `<p class="loading">正在抓 ${esc(symbol)} 的 15m～週線資料並分析…</p>`;
    $('head').hidden = true;
  }
  $('status').textContent = '更新中…';
  try {
    const [raw, tk, dv, lr] = await Promise.all([
      Promise.all(REPORT_TFS.map((tf) => bybit.fetchKlines(symbol, tf, { limit: 500 }))),
      bybit.fetchTicker(symbol),
      fetchDerivatives(symbol, { limit: 25, period: '1h' }).catch(() => null),
      fetchLsRatio(symbol),
    ]);
    if (seq !== loadSeq) return;
    const closed = {};
    REPORT_TFS.forEach((tf, k) => { closed[tf] = raw[k].slice(0, -1); });
    if (!(closed['1h']?.length > 100)) throw new Error('這個幣的 K 棒太少（可能剛上線），沒辦法分析');
    ticker = tk;
    livePrice = tk.price;
    deriv = dv;
    ls = lr;
    setDecimals(livePrice);
    report = buildCoinReport(closed, { daily: raw[REPORT_TFS.indexOf('1d')], h1: closed['1h'], price: livePrice, derivatives: dv, lsRatio: lr });
    if (report.empty) throw new Error('資料不夠，沒辦法分析');
    render();
    $('status').textContent = `分析於 ${tw(Date.now())}（每分鐘重算、價格每 3 秒更新）`;
  } catch (e) {
    if (seq !== loadSeq) return;
    $('out').innerHTML = `<p class="err">${esc(symbol)}：${esc(e.message || e)}。確認是 Bybit 上有的 USDT 永續合約（例如 BTCUSDT）。</p>`;
    $('status').textContent = '';
  }
}

async function tick() {
  if (!sym || !report) return;
  try {
    const tk = await bybit.fetchTicker(sym);
    ticker = tk;
    livePrice = tk.price;
    renderHead();
    renderLadder();
    renderBest();
  } catch { /* 下一次再試 */ }
}

function start(symbol) {
  symbol = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!symbol) return;
  if (!/USDT$/.test(symbol)) symbol += 'USDT';
  sym = symbol;
  try { localStorage.setItem(STORE, symbol); } catch { /* 無痕模式 */ }
  history.replaceState(null, '', `?s=${symbol}`);
  $('q').value = symbol.replace(/USDT$/, '');
  clearInterval(fullTimer);
  clearInterval(tickTimer);
  loadAll(symbol);
  fullTimer = setInterval(() => loadAll(symbol, { quiet: true }), FULL_REFRESH_MS);
  tickTimer = setInterval(tick, TICK_MS);
}

/* ───────────── 畫面 ───────────── */
function render() {
  $('out').innerHTML = `
    <div class="grid2">
      <section class="card" id="summary"></section>
      <section class="card" id="best"></section>
    </div>
    <div class="grid2">
      <section class="card"><h2>價格地圖：上下方的關鍵價位（由近到遠，紫色是現價）</h2><div class="ladder" id="ladder"></div></section>
      <div style="display:grid;gap:16px;align-content:start;min-width:0">
        <section class="card" id="sweeps"></section>
        <section class="card" id="deriv"></section>
      </div>
    </div>
    <section class="card"><h2>各週期一覽</h2><div class="scroll" id="matrix"></div></section>
    <section style="display:grid;gap:10px" id="tfs"></section>`;
  renderHead();
  renderSummary();
  renderBest();
  renderLadder();
  renderSweeps();
  renderDeriv();
  renderMatrix();
  renderTfs();
}

function renderHead() {
  $('head').hidden = false;
  $('symName').textContent = `${sym.replace(/USDT$/, '')}／USDT 永續`;
  $('price').textContent = fp(livePrice);
  if (ticker) {
    $('chg').innerHTML = `<span class="${dcls(ticker.change)}">${fd(ticker.change)}</span>`;
    $('hl').textContent = `${fp(ticker.high)}／${fp(ticker.low)}`;
  }
  if (deriv && Number.isFinite(deriv.fundingRate)) {
    const fr = deriv.fundingRate * 100;
    $('fund').innerHTML = `<span class="${fr > 0.03 ? 'down' : fr < -0.01 ? 'up' : ''}">${fr.toFixed(4)}%</span>`;
    const oc = oiChangePct(deriv.oiSeries ?? []);
    $('oi').innerHTML = oc == null ? '-' : `<span class="${dcls(oc)}">${fd(oc)}</span>`;
  }
  if (ls?.length) {
    const r = ls[ls.length - 1];
    $('ls').innerHTML = `<span class="up">${(r.buy * 100).toFixed(0)}%</span>／<span class="down">${(r.sell * 100).toFixed(0)}%</span>`;
  }
  $('tv').href = `https://www.tradingview.com/chart/?symbol=BYBIT:${sym}.P`;
}

function renderSummary() {
  const a = report.agg;
  $('summary').innerHTML = `
    <h2>多空總結（15m～週線，越大的週期權重越高）</h2>
    <div class="verdict">
      <span class="badge ${a.label}">${a.labelZh}</span>
      <span class="num">分數 ${a.score > 0 ? '+' : ''}${a.score}／方向一致 ${a.alignment}%（多 ${a.bulls}、空 ${a.bears}、中性 ${a.neutrals}）</span>
    </div>
    <div class="chips">${report.tfs.map((t) => `<span class="chip ${biasCls(t.bias.score)}">${t.interval} ${BIAS[biasCls(t.bias.score)]} <span class="num">${t.bias.score > 0 ? '+' : ''}${t.bias.score}</span></span>`).join('')}</div>
    <ul class="narr">${report.narrative.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
}

function planTable(p) {
  const rows = [
    ['進場', `${fp(p.entry)} <span class="${dcls(dist(p.entry))}">${fd(dist(p.entry))}</span>${p.entryType === 'market' ? '（已經在進場區）' : '（掛單等回踩）'}`],
    ['停損', `${fp(p.stop)} <span class="muted">（風險 ${p.riskPct}%）</span>`],
    ...p.targets.map((t) => [t.name, `${fp(t.price)} <span class="muted">${t.rr}R｜${esc(t.label ?? '')}</span> <span class="${dcls(dist(t.price))}">${fd(dist(t.price))}</span>`]),
  ];
  if (p.poi) rows.push(['進場區', `${POI_ZH[p.poi.type] ?? p.poi.type} ${fp(p.poi.bottom)}～${fp(p.poi.top)}`]);
  return `<table><tbody>${rows.map(([k, v]) => `<tr><td class="muted" style="width:72px">${k}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>`;
}

function renderBest() {
  if (!$('best')) return;
  const b = report.best;
  const others = report.plans.filter((p) => p.valid && (!b || p.tf !== b.tf)).slice(0, 5);
  $('best').innerHTML = `
    <h2>最值得看的週期</h2>
    ${b ? `<div class="plan">
      <div class="head"><span class="dir ${b.dir === 'long' ? 'up' : 'down'}">${b.tf} ${DIRZ[b.dir]}</span><span class="chip">${b.grade} 級 ${b.score} 分</span><span class="muted">最後目標 ${b.rrFinal}R</span></div>
      ${planTable(b)}
      ${b.invalidation ? `<div class="note">失效條件：${esc(b.invalidation)}</div>` : ''}
    </div>` : '<p class="muted">現在沒有任何週期有有效的進場計畫，等價格回到進場區或結構轉向。</p>'}
    ${others.length ? `<h2 style="margin-top:14px">其他有效計畫（由近到遠）</h2>
      <div class="scroll"><table class="tbl"><thead><tr><th>週期</th><th>方向</th><th class="r">進場</th><th class="r">距離</th><th class="r">停損</th><th class="r">分數</th></tr></thead><tbody>
      ${others.map((p) => `<tr><td>${p.tf}</td><td class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}</td><td class="r num">${fp(p.entry)}</td><td class="r num ${dcls(dist(p.entry))}">${fd(dist(p.entry))}</td><td class="r num">${fp(p.stop)}</td><td class="r num">${p.grade} ${p.score}</td></tr>`).join('')}
      </tbody></table></div>` : ''}`;
}

/** 價格地圖：把各週期的流動性、前日／前週／前月高低、高週期 OB／FVG、成交量分布、計畫進場價、爆倉估算排成一條梯子 */
function ladderItems() {
  const items = [];
  const add = (price, cls, text) => { if (Number.isFinite(price) && price > 0) items.push({ price, cls, text }); };
  for (const x of [...report.liqAbove, ...report.liqBelow]) add(x.price, 'liq', `流動性 ${x.tfs.join('／')}${x.touches > 1 ? `（${x.touches} 次）` : ''}`);
  for (const l of report.levels) add(l.price, 'key', l.zh);
  for (const t of report.tfs) {
    if (!['1h', '4h', '1d', '1w'].includes(t.interval)) continue;
    for (const p of t.pois.slice(0, 3)) add((p.top + p.bottom) / 2, p.dir === 'bull' ? 'bull' : 'bear', `${t.interval} ${POI_ZH[p.type] ?? p.type} ${fp(p.bottom)}～${fp(p.top)}`);
    if (['4h', '1d', '1w'].includes(t.interval) && t.vp) {
      add(t.vp.poc, '', `${t.interval} 成交量 POC`);
      add(t.vp.vah, '', `${t.interval} VAH`);
      add(t.vp.val, '', `${t.interval} VAL`);
    }
    if (['1d', '1w'].includes(t.interval) && t.pd) {
      add(t.pd.high, 'key', `${t.interval} 區間高`);
      add(t.pd.low, 'key', `${t.interval} 區間低`);
      add(t.pd.eq, '', `${t.interval} 區間中線`);
    }
  }
  for (const p of report.plans.filter((x) => x.valid)) add(p.entry, 'plan', `${p.tf} ${DIRZ[p.dir]}進場（${p.grade}）`);
  if (report.liquidation) {
    for (const x of report.liquidation.longs) add(x.price, 'liqd', `多單爆倉區 估 ${x.strength}`);
    for (const x of report.liquidation.shorts) add(x.price, 'liqd', `空單爆倉區 估 ${x.strength}`);
  }
  return items;
}

function renderLadder() {
  if (!$('ladder')) return;
  const items = ladderItems().sort((a, b) => b.price - a.price);
  // 0.1% 以內的併成一列
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs((last.price - it.price) / it.price) < 0.001) last.tags.push(it);
    else rows.push({ price: it.price, tags: [it] });
  }
  const above = rows.filter((r) => r.price > livePrice).slice(-18);
  const below = rows.filter((r) => r.price <= livePrice).slice(0, 18);
  const row = (r) => `<div class="lrow"><span class="num">${fp(r.price)}</span><span class="num ${dcls(dist(r.price))}">${fd(dist(r.price))}</span><span class="tags">${r.tags.map((t) => `<span class="tag ${t.cls}">${esc(t.text)}</span>`).join('')}</span></div>`;
  $('ladder').innerHTML = above.map(row).join('')
    + `<div class="lrow now"><span class="num">${fp(livePrice)}</span><span>現價</span><span class="tags"><span class="tag">上方 ${above.length} 個／下方 ${below.length} 個價位</span></span></div>`
    + below.map(row).join('');
}

function renderSweeps() {
  const xs = report.recentSweeps;
  $('sweeps').innerHTML = `<h2>最近被獵取的流動性（各週期）</h2>
    ${xs.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>時間</th><th>週期</th><th>掃哪邊</th><th class="r">價位</th><th class="r">刺穿到</th><th>意思</th></tr></thead><tbody>
    ${xs.map((s) => `<tr><td class="num">${tw(s.time)}</td><td>${s.tf}</td><td class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方買方流動性' : '掃下方賣方流動性'}</td><td class="r num">${fp(s.level)}</td><td class="r num">${fp(s.extreme)}</td><td class="muted">${s.side === 'buyside' ? '假突破，偏空訊號' : '假跌破，偏多訊號'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">最近沒有明顯的掃流動性。</p>'}`;
}

function spark(values, { w = 240, h = 40, color = 'var(--info)' } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const sx = (i) => (i / (v.length - 1)) * (w - 4) + 2;
  const sy = (x) => h - 3 - ((x - lo) / (hi - lo || 1)) * (h - 6);
  const d = v.map((x, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(x).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img"><path d="${d} L${sx(v.length - 1)},${h} L2,${h} Z" fill="${color}" fill-opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="${sx(v.length - 1)}" cy="${sy(v.at(-1))}" r="2.6" fill="${color}"/></svg>`;
}

function renderDeriv() {
  const parts = ['<h2>合約數據</h2>'];
  if (deriv && Number.isFinite(deriv.fundingRate)) {
    const fr = deriv.fundingRate * 100;
    const cd = fundingCountdown(deriv.nextFundingTime);
    parts.push(`<div class="sec"><h3>資金費率（${esc(deriv.provider)}）</h3><p class="num" style="margin:0">${fr.toFixed(4)}%／8h，年化 ${annualizeFunding(deriv.fundingRate)?.toFixed(1)}%${cd ? `，${esc(cd.zh)}` : ''}
      <br><span class="muted">${fr > 0.05 ? '多單付錢給空單、而且很貴：多單擠，容易往下掃' : fr > 0.01 ? '多單付錢給空單：偏多擁擠' : fr < -0.01 ? '空單付錢給多單：空單擠，容易往上軋' : '正常範圍'}</span></p></div>`);
    const oc = oiChangePct(deriv.oiSeries ?? []);
    if (deriv.oiSeries?.length > 1) {
      parts.push(`<div class="sec" style="margin-top:10px"><h3>未平倉量（近 24 小時 ${oc == null ? '' : fd(oc)}）</h3>${spark(deriv.oiSeries.map((x) => x.value))}
      <p class="note" style="margin:2px 0 0">${oc == null ? '' : oc > 3 && (ticker?.change ?? 0) > 0 ? '價漲＋未平倉增：新多單進場，趨勢有力' : oc > 3 && (ticker?.change ?? 0) < 0 ? '價跌＋未平倉增：新空單進場，空方有力' : oc < -3 && (ticker?.change ?? 0) > 0 ? '價漲＋未平倉減：空單回補推上去，持續性較弱' : oc < -3 ? '價跌＋未平倉減：多單停損／平倉，殺多' : '未平倉變化不大'}</p></div>`);
    }
  } else parts.push('<p class="muted">資金費率／未平倉量暫時抓不到。</p>');
  if (ls?.length) {
    const r = ls.at(-1);
    parts.push(`<div class="sec" style="margin-top:10px"><h3>Bybit 帳戶多空比（近 24 小時，線＝做多帳戶比例）</h3>${spark(ls.map((x) => x.buy), { color: 'var(--up)' })}
      <p class="note" style="margin:2px 0 0">現在 ${(r.buy * 100).toFixed(1)}% 帳戶做多。${r.buy > 0.6 ? '大部分人做多：主力常反向往下掃多單停損' : r.sell > 0.6 ? '大部分人做空：小心往上軋空' : '多空差不多'}</p></div>`);
  }
  const lq = report.liquidation;
  if (lq) {
    const max = Math.max(1, ...[...lq.longs, ...lq.shorts].map((x) => x.strength));
    const row = (x) => `<tr><td class="num">${fp(x.price)}</td><td class="num ${dcls(dist(x.price))}">${fd(dist(x.price))}</td><td style="width:40%"><div class="bar"><i style="width:${(x.strength / max) * 100}%;background:var(${x.side === 'long' ? '--down' : '--up'})"></i></div></td></tr>`;
    parts.push(`<div class="sec" style="margin-top:10px"><h3>爆倉密集區（估算，近 7 天）</h3>
      <table class="tbl"><tbody>
        <tr><td colspan="3" class="muted">上方：空單爆倉（價格漲上去會被強制買回，容易一路衝）</td></tr>${lq.shorts.slice().sort((a, b) => b.price - a.price).map(row).join('')}
        <tr><td colspan="3" class="muted">下方：多單爆倉（價格跌下去會被強制賣出，容易一路殺）</td></tr>${lq.longs.slice().sort((a, b) => b.price - a.price).map(row).join('')}
      </tbody></table></div>`);
  }
  $('deriv').innerHTML = parts.join('');
}

function trendCell(t) {
  if (!t) return '-';
  const st = t.supertrend === 1 ? '<span class="up">多</span>' : t.supertrend === -1 ? '<span class="down">空</span>' : '-';
  const last = Object.entries(t.last).filter(([, v]) => v).sort((a, b) => a[1].barsAgo - b[1].barsAgo)[0];
  const NAME = { breakout: '唐奇安突破', ema: 'EMA 交叉', macd: 'MACD 零軸', vol: '放量突破', st: '超級趨勢', gc: '黃金交叉' };
  return `超級趨勢 ${st}${last ? `｜最近：${NAME[last[0]]} <span class="${last[1].dir === 'long' ? 'up' : 'down'}">${DIRZ[last[1].dir]}</span>（${last[1].barsAgo} 根前）` : ''}`;
}

function renderMatrix() {
  const near = (arr) => (arr[0] ? `${fp(arr[0].price)} <span class="${dcls(dist(arr[0].price))}">${fd(dist(arr[0].price))}</span>${arr[0].touches > 1 ? ` ×${arr[0].touches}` : ''}` : '-');
  $('matrix').innerHTML = `<table class="tbl"><thead><tr><th>週期</th><th>偏向</th><th>結構（大／小）</th><th>最近結構事件</th><th>折溢價</th><th>上方流動性</th><th>下方流動性</th><th>最近獵取</th><th>SMC 計畫</th><th>順勢策略</th></tr></thead><tbody>
    ${report.tfs.map((t) => {
      const e = t.events[0];
      const s = t.liquidity.sweeps[0];
      const p = t.setup;
      return `<tr>
        <td><b>${t.interval}</b></td>
        <td class="${biasCls(t.bias.score) === 'bullish' ? 'up' : biasCls(t.bias.score) === 'bearish' ? 'down' : 'muted'} num">${BIAS[biasCls(t.bias.score)]} ${t.bias.score > 0 ? '+' : ''}${t.bias.score}</td>
        <td>${TREND[t.swingTrend] ?? t.swingTrend}／${TREND[t.internalTrend] ?? t.internalTrend}</td>
        <td>${e ? `<span class="${e.dir === 'bull' ? 'up' : 'down'}">${e.type} ${DIRZ[e.dir]}</span> <span class="muted">${e.barsAgo} 根前</span>` : '-'}</td>
        <td>${t.pd ? `${t.pd.zone === 'premium' ? '溢價' : t.pd.zone === 'discount' ? '折價' : '中間'} ${t.pd.pct}%` : '-'}</td>
        <td class="num">${near(t.liquidity.above)}</td>
        <td class="num">${near(t.liquidity.below)}</td>
        <td>${s ? `<span class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方' : '掃下方'}</span> <span class="num">${fp(s.level)}</span> <span class="muted">${s.barsAgo} 根前</span>` : '-'}</td>
        <td>${p.none ? '<span class="muted">沒有</span>' : `<span class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}</span> ${p.valid ? '' : '<span class="muted">（無效）</span>'} <span class="num">${fp(p.entry)}</span> <span class="${dcls(dist(p.entry))}">${fd(dist(p.entry))}</span> <span class="muted">${p.grade} ${p.score}</span>`}</td>
        <td>${trendCell(t.trend)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function tfDetail(t) {
  const L = (arr, cls) => (arr.length ? `<ul>${arr.map((p) => `<li class="num">${fp(p.price)} <span class="${dcls(dist(p.price))}">${fd(dist(p.price))}</span>${p.touches > 1 ? ` <span class="${cls}">等${cls === 'up' ? '高' : '低'} ×${p.touches}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">沒有</p>');
  const p = t.setup;
  const tr = t.trend;
  const NAME = { breakout: ['唐奇安 55 突破', '6h'], ema: ['EMA20／50 交叉', '6h'], macd: ['MACD 穿零軸', '6h'], vol: ['放量突破', '6h'], st: ['超級趨勢', '4h'], gc: ['黃金／死亡交叉', '6h'] };
  return `
    <div class="sec"><h3>結構</h3><ul>
      <li>大結構 ${TREND[t.swingTrend]}、小結構 ${TREND[t.internalTrend]}${t.htfBias ? `；上一層週期偏向 ${BIAS[biasCls(t.htfBias.score)]}（${t.htfBias.score}）` : ''}</li>
      ${t.events.map((e) => `<li><span class="${e.dir === 'bull' ? 'up' : 'down'}">${e.scope === 'swing' ? '大' : '小'} ${e.type} ${DIRZ[e.dir]}</span> 破 <span class="num">${fp(e.price)}</span> <span class="muted">${tw(e.time)}（${e.barsAgo} 根前）</span></li>`).join('')}
      <li>ATR ${fp(t.atr)}（${t.atrPct}%）、RSI ${t.rsi ?? '-'}</li>
    </ul></div>
    <div class="sec"><h3>上方流動性（買方停損：空單停損、突破單）</h3>${L(t.liquidity.above, 'up')}</div>
    <div class="sec"><h3>下方流動性（賣方停損：多單停損）</h3>${L(t.liquidity.below, 'down')}</div>
    <div class="sec"><h3>最近獵取</h3>${t.liquidity.sweeps.length ? `<ul>${t.liquidity.sweeps.map((s) => `<li><span class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方' : '掃下方'}</span> <span class="num">${fp(s.level)}</span> → 刺到 <span class="num">${fp(s.extreme)}</span> <span class="muted">${tw(s.time)}，${s.barsAgo} 根前</span></li>`).join('')}</ul>` : '<p class="muted">沒有</p>'}
      ${t.liquidity.inducement ? `<p class="note" style="margin:6px 0 0">誘導價位（IDM）${fp(t.liquidity.inducement.price)}${t.liquidity.inducement.taken ? '，已被拿走' : '，還沒被拿走：價格可能先去掃它再進 OB'}</p>` : ''}</div>
    <div class="sec"><h3>關鍵區塊（還有效的 OB／FVG／Breaker）</h3>${t.pois.length ? `<ul>${t.pois.map((z) => `<li><span class="${z.dir === 'bull' ? 'up' : 'down'}">${POI_ZH[z.type] ?? z.type} ${z.dir === 'bull' ? '需求' : '供給'}</span> <span class="num">${fp(z.bottom)}～${fp(z.top)}</span> <span class="${dcls(dist((z.top + z.bottom) / 2))}">${fd(dist((z.top + z.bottom) / 2))}</span></li>`).join('')}</ul>` : '<p class="muted">沒有</p>'}</div>
    <div class="sec"><h3>區間與均線</h3><ul>
      ${t.pd ? `<li>交易區間 <span class="num">${fp(t.pd.low)}～${fp(t.pd.high)}</span>，中線 <span class="num">${fp(t.pd.eq)}</span>，現在在 ${t.pd.zone === 'premium' ? '溢價區（偏貴，適合找空）' : t.pd.zone === 'discount' ? '折價區（偏便宜，適合找多）' : '中間'}（${t.pd.pct}%）</li>` : ''}
      ${t.ote ? `<li>OTE 回撤區（${DIRZ[t.ote.dir]}）<span class="num">${fp(t.ote.bottom)}～${fp(t.ote.top)}</span>，甜蜜點 <span class="num">${fp(t.ote.sweet)}</span></li>` : ''}
      ${t.vp ? `<li>成交量分布 POC <span class="num">${fp(t.vp.poc)}</span>、VAH <span class="num">${fp(t.vp.vah)}</span>、VAL <span class="num">${fp(t.vp.val)}</span></li>` : ''}
      <li>EMA20 <span class="num">${fp(t.ema.e20)}</span>、EMA50 <span class="num">${fp(t.ema.e50)}</span>、EMA200 <span class="num">${fp(t.ema.e200)}</span></li>
    </ul></div>
    <div class="sec"><h3>SMC 進場計畫</h3>${p.none ? `<p class="muted">${esc(p.reasonZh)}</p>` : `
      <p style="margin:0 0 6px"><b class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}</b>　${p.grade} 級 ${p.score} 分${p.valid ? '' : '　<span class="warn">（分數或風報比不夠，計畫無效）</span>'}</p>
      ${planTable(p)}
      <ul class="check" style="margin-top:6px">${p.checklist.map((c) => `<li class="${c.ok ? 'up' : 'muted'}">${c.ok ? '✓' : '✗'} ${esc(c.zh)}</li>`).join('')}</ul>`}</div>
    <div class="sec"><h3>6 個順勢策略（線上 Demo 只在括號內的週期下單）</h3>${tr ? `<ul>
      <li>現在：超級趨勢 ${tr.supertrend === 1 ? '<span class="up">多</span>' : '<span class="down">空</span>'}、EMA20 ${tr.emaFastAbove ? '在 EMA50 上' : '在 EMA50 下'}、價格${tr.aboveEma200 ? '在' : '不在'} EMA200 上、MACD ${tr.macdAboveZero ? '零軸上' : '零軸下'}、SMA50 在 SMA200 ${tr.sma50Above200 ? '上（黃金交叉後）' : '下（死亡交叉後）'}</li>
      <li>55 根高低點：<span class="num">${fp(tr.donchian55.high)}</span>／<span class="num">${fp(tr.donchian55.low)}</span>（收盤突破就是唐奇安訊號）</li>
      ${Object.entries(NAME).map(([k, [zh, live]]) => { const v = tr.last[k]; return `<li>${zh}（${live}）：${v ? `<span class="${v.dir === 'long' ? 'up' : 'down'}">${DIRZ[v.dir]}</span> ${tw(v.time)}，${v.barsAgo} 根前${v.barsAgo === 0 ? ' <b class="warn">剛出現</b>' : ''}` : '<span class="muted">最近 120 根沒有</span>'}</li>`; }).join('')}
    </ul>` : '<p class="muted">K 棒不夠 210 根，算不出來</p>'}</div>`;
}

function renderTfs() {
  $('tfs').innerHTML = `<h2 style="margin:6px 0 0">各週期細節（點開看）</h2>` + report.tfs.map((t) => `
    <details class="tf" data-tf="${t.interval}" ${openTfs.has(t.interval) ? 'open' : ''}>
      <summary><span class="tfname">${t.interval}</span>
        <span class="chip ${biasCls(t.bias.score)}">${BIAS[biasCls(t.bias.score)]} ${t.bias.score}</span>
        <span class="muted">${TREND[t.swingTrend]}</span>
        ${t.setup.none ? '' : `<span class="${t.setup.dir === 'long' ? 'up' : 'down'}">計畫 ${DIRZ[t.setup.dir]} ${fp(t.setup.entry)}</span>${t.setup.valid ? '' : ' <span class="muted">（無效）</span>'}`}
      </summary>
      <div class="body">${tfDetail(t)}</div>
    </details>`).join('');
  for (const d of $('tfs').querySelectorAll('details.tf')) {
    d.addEventListener('toggle', () => { if (d.open) openTfs.add(d.dataset.tf); else openTfs.delete(d.dataset.tf); });
  }
}

/* ───────────── 初始化 ───────────── */
$('quick').innerHTML = QUICK.map((b) => `<button type="button" data-s="${b}">${b}</button>`).join('');
$('quick').addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) start(b.dataset.s); });
$('form').addEventListener('submit', (e) => { e.preventDefault(); start($('q').value); });
bybit.fetchSymbols().then((list) => {
  $('symbols').innerHTML = list.map((x) => `<option value="${x.base}">${x.symbol}</option>`).join('');
}).catch(() => { /* 沒有清單也能手動輸入 */ });
const first = new URLSearchParams(location.search).get('s') || (() => { try { return localStorage.getItem(STORE); } catch { return null; } })() || 'BTCUSDT';
start(first);
document.addEventListener('visibilitychange', () => { if (!document.hidden && sym) loadAll(sym, { quiet: true }); });
