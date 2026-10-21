#!/usr/bin/env node
/**
 * 網路上宣稱報酬很高的策略／指標，用真實歷史資料重新驗證（2026-10-21 使用者要求：不要沿用帳號原本的策略，
 * 去找有沒有真的很誇張的）。全部扣手續費、分前後半段、兩組幣，跟「買了放著」比。
 *
 *   A 唐奇安通道組合（Zarattini／Pagani／Barbon 2025〈Catching Crypto Trends〉，宣稱 Sharpe > 1.5、每年贏 BTC 10.8%）
 *     日線收盤突破 5～360 天最高收盤就做多，停損＝區間中點往上追；9 個週期等權平均；
 *     每個幣用 90 天波動率把曝險調到年化 25%（最多 2 倍），資金平均分給有一年以上資料的幣。只做多。
 *   B 一天中的特定時段（Quantpedia：每天 UTC 21:00 買 BTC、23:00 賣，宣稱年化 33%、最大回撤 -22%）
 *   C 星期幾效應（Concretum：週日晚上到週一報酬特別高）
 *   D 橫截面動能／反轉（論文：大幣有動能、小幣隔天反轉）：依過去 k 天漲幅排名，多前 20%／空後 20%（或反過來）
 *   E 拉里·威廉斯波動突破（韓國很紅）：今天開盤＋k×昨天高低差被突破就買，隔天開盤賣
 *   F UT Bot（TradingView 最熱門的指標之一）：ATR 追蹤停損翻多翻空，一直在場內
 *
 * 用法（GitHub Actions research.yml study=wild）：node scripts/research/wild-zoo.mjs [--only=A,B] [--demo]
 *   --side-fee=0.0006  每邊手續費＋滑價（Bybit 吃單 0.055%）；B／C 另外算掛單 0.02%
 */

import { klines, opt } from './lib.mjs';
import { DC_LOOKBACKS, createDonchianState, stepDonchian, donchianWeights, applyBand } from '../../src/strategies/donchian-ensemble.js';

const args = process.argv.slice(2);
const FEE = Number(opt(args, 'side-fee', '0.0006'));
const MAKER = 0.0002;
const START = Date.parse(opt(args, 'start', '2019-01-01'));
const SPLIT = Date.parse(opt(args, 'split', '2022-07-01'));
const ONLY = opt(args, 'only', '').split(',').filter(Boolean);
const DEMO = args.includes('--demo');
const DAY = 86_400_000, HOUR = 3_600_000;
const run = (k) => !ONLY.length || ONLY.includes(k);

const G1 = 'BTC,ETH,BNB,XRP,ADA,DOGE,SOL,TRX,LTC,LINK,DOT,AVAX,ETC,BCH,XLM,ATOM,UNI,FIL,NEAR,ALGO'.split(',');
const G2 = 'VET,THETA,EOS,XTZ,AAVE,ICP,SAND,MANA,AXS,CHZ,EGLD,HBAR,GRT,MKR,CRV,COMP,SNX,ZEC,DASH,NEO'.split(',');
const H1 = 'BTC,ETH,SOL,XRP,DOGE,ADA,LINK,AVAX,LTC,BNB'.split(',');
const H2 = 'VET,EOS,XTZ,AAVE,SAND,CHZ,HBAR,ZEC,DASH,NEO'.split(',');

const out = [];
const log = (s = '') => { console.log(s); out.push(s); };
const pctS = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : '-');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');

// ───────────────────────── 資料 ─────────────────────────

function fakeCandles(sym, interval, n) {
  // --demo：隨機漫步，只用來確認程式跑得動
  let seed = [...sym].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const step = interval === '1d' ? DAY : HOUR;
  const vol = interval === '1d' ? 0.04 : 0.008;
  const end = Math.floor(Date.now() / step) * step;
  let p = 100;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    p = Math.max(0.01, p * Math.exp((rnd() - 0.5) * 2 * vol * 1.7));
    const h = Math.max(o, p) * (1 + rnd() * vol), l = Math.min(o, p) * (1 - rnd() * vol);
    out.push({ time: end - i * step, open: o, high: h, low: l, close: p, volume: 1 });
  }
  return out;
}

async function load(syms, interval, n) {
  const res = {};
  for (const s of syms) {
    try {
      const c = DEMO ? fakeCandles(s, interval, n) : await klines(`${s}USDT`, interval, n);
      if (c.length < 50) throw new Error(`只有 ${c.length} 根`);
      res[s] = c;
      if (!DEMO) console.error(`  ${s} ${interval} ${c.length} 根，從 ${new Date(c[0].time).toISOString().slice(0, 10)}`);
    } catch (e) { log(`  （${s} ${interval} 抓不到，略過：${e.message}）`); }
  }
  return res;
}

/** 日線對齊成同一條日期軸：closes[sym][i]，沒有資料是 NaN */
function alignDaily(data) {
  let t0 = Infinity, t1 = -Infinity;
  for (const c of Object.values(data)) { t0 = Math.min(t0, c[0].time); t1 = Math.max(t1, c[c.length - 1].time); }
  const days = [];
  for (let t = Math.floor(t0 / DAY) * DAY; t <= t1; t += DAY) days.push(t);
  const idx = new Map(days.map((t, i) => [t, i]));
  const closes = {};
  for (const [s, c] of Object.entries(data)) {
    const a = new Array(days.length).fill(NaN);
    for (const k of c) { const i = idx.get(Math.floor(k.time / DAY) * DAY); if (i != null) a[i] = k.close; }
    closes[s] = a;
  }
  return { days, closes };
}

// ───────────────────────── 績效 ─────────────────────────

/** rets：[{t, r}]（每天一筆，t＝那天的時間）→ 年化報酬、最大回撤、Sharpe */
function stats(rets) {
  const xs = rets.filter((x) => Number.isFinite(x.r));
  if (xs.length < 30) return null;
  let eq = 1, peak = 1, mdd = 0, s = 0, s2 = 0;
  for (const { r } of xs) {
    eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1);
    s += r; s2 += r * r;
  }
  const n = xs.length, mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  const years = (xs[n - 1].t - xs[0].t + DAY) / (365 * DAY);
  return { total: eq - 1, cagr: eq > 0 ? eq ** (1 / years) - 1 : -1, mdd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0, n };
}

const HEAD = ['策略', '全期年化', '最大回撤', 'Sharpe', '前半年化', '前半Sharpe', '後半年化', '後半Sharpe', '備註'];
function row(name, rets, note = '') {
  const inRange = rets.filter((x) => x.t >= START);
  const a = stats(inRange), b = stats(inRange.filter((x) => x.t < SPLIT)), c = stats(inRange.filter((x) => x.t >= SPLIT));
  return [name, pctS(a?.cagr), pctS(a?.mdd), f2(a?.sharpe), pctS(b?.cagr), f2(b?.sharpe), pctS(c?.cagr), f2(c?.sharpe), note];
}
function table(title, rows) {
  log('');
  log(`■ ${title}`);
  const w = HEAD.map((h, i) => Math.max(h.length * 2, ...rows.map((r) => String(r[i]).length + (i === 0 ? String(r[i]).replace(/[\x00-\x7f]/g, '').length : 0))));
  const pad = (s, n, i) => { const t = String(s); const vis = t.length + (i === 0 || i === 8 ? t.replace(/[\x00-\x7f]/g, '').length : 0); return t + ' '.repeat(Math.max(1, n - vis + 1)); };
  log(HEAD.map((h, i) => pad(h, w[i], 0)).join(''));
  for (const r of rows) log(r.map((x, i) => pad(x, w[i], i)).join(''));
}

/** 等權重買了放著（每天再平衡），比較基準 */
function buyHold({ days, closes }, syms) {
  const rets = [];
  for (let t = 1; t < days.length; t++) {
    const rs = syms.map((s) => closes[s][t] / closes[s][t - 1] - 1).filter(Number.isFinite);
    if (rs.length) rets.push({ t: days[t], r: rs.reduce((a, b) => a + b, 0) / rs.length });
  }
  return rets;
}

/** 依目標權重算每日報酬：w[t] 在第 t 天收盤設定，吃第 t+1 天的報酬；換倉成本＝|Δw|×手續費 */
function runWeights({ days, closes }, weightsAt, fee = FEE) {
  const syms = Object.keys(closes);
  let prev = {};
  const rets = [];
  let turnover = 0;
  for (let t = 0; t < days.length - 1; t++) {
    const w = weightsAt(t, prev) || {};
    let cost = 0;
    for (const s of new Set([...Object.keys(w), ...Object.keys(prev)])) cost += Math.abs((w[s] || 0) - (prev[s] || 0));
    turnover += cost;
    let r = -cost * fee;
    for (const [s, x] of Object.entries(w)) {
      const g = closes[s][t + 1] / closes[s][t] - 1;
      if (Number.isFinite(g)) r += x * g;
    }
    rets.push({ t: days[t + 1], r });
    prev = w;
  }
  return { rets, turnover };
}

// ───────────────────────── A 唐奇安通道組合 ─────────────────────────

function donchianEnsemble(D, { lbs = DC_LOOKBACKS, volTarget = 0.25, cap = 2, band = 0, only = null, fee = FEE, mult = 1 } = {}) {
  // 規則跟線上共用 src/strategies/donchian-ensemble.js
  const syms = only || Object.keys(D.closes);
  const states = Object.fromEntries(syms.map((s) => [s, createDonchianState(lbs)]));
  const closes = Object.fromEntries(syms.map((s) => [s, D.closes[s]]));
  return runWeights(D, (t, prev) => {
    for (const s of syms) stepDonchian(states[s], closes[s], t);
    const { weights } = donchianWeights(states, closes, t, { volTarget, cap });
    for (const s of Object.keys(weights)) weights[s] = applyBand(weights[s] * mult, prev[s] || 0, band);
    return weights;
  }, fee);
}

// ───────────────────────── D 橫截面動能／反轉 ─────────────────────────

function crossSection(D, { k, hold, mode, frac = 0.2, longOnly = false }) {
  const syms = Object.keys(D.closes);
  const hist = Object.fromEntries(syms.map((s) => [s, 0]));
  let last = {};
  return runWeights(D, (t) => {
    for (const s of syms) hist[s] = Number.isFinite(D.closes[s][t]) ? hist[s] + 1 : 0;
    if (t % hold !== 0) {
      // 中間如果有幣下市，那一部分改成空手
      const w = {};
      for (const [s, x] of Object.entries(last)) if (Number.isFinite(D.closes[s][t])) w[s] = x;
      return (last = w);
    }
    const ranked = syms
      .filter((s) => hist[s] >= 60 && Number.isFinite(D.closes[s][t - k]))
      .map((s) => ({ s, r: D.closes[s][t] / D.closes[s][t - k] - 1 }))
      .sort((a, b) => b.r - a.r);
    if (ranked.length < 8) return (last = {});
    const n = Math.max(1, Math.round(ranked.length * frac));
    const top = ranked.slice(0, n).map((x) => x.s), bot = ranked.slice(-n).map((x) => x.s);
    const [L, S] = mode === 'mom' ? [top, bot] : [bot, top];
    const w = {};
    if (longOnly) for (const s of L) w[s] = 1 / L.length;
    else { for (const s of L) w[s] = 0.5 / L.length; for (const s of S) w[s] = -0.5 / S.length; }
    return (last = w);
  });
}

// ───────────────────────── 小時線工具 ─────────────────────────

/** 小時線依 UTC 日期分組：[{day, bars}] */
function byDay(c) {
  const m = new Map();
  for (const k of c) { const d = Math.floor(k.time / DAY) * DAY; if (!m.has(d)) m.set(d, []); m.get(d).push(k); }
  return [...m.entries()].map(([day, bars]) => ({ day, bars })).filter((x) => x.bars.length >= 20);
}

/** 多個幣的每日報酬平均（每個幣分 1/N 資金，沒交易的那份是現金） */
function avgDaily(perCoin, N) {
  const m = new Map();
  for (const rets of perCoin) for (const { t, r } of rets) m.set(t, (m.get(t) || 0) + r / N);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => ({ t, r }));
}

/** 持有時段 [h0, h1)（UTC 小時）每天的報酬 */
function hourWindow(c, h0, h1, fee) {
  const rets = [];
  for (const { day, bars } of byDay(c)) {
    const a = bars.find((k) => new Date(k.time).getUTCHours() === h0);
    const b = bars.find((k) => new Date(k.time).getUTCHours() === h1 - 1);
    rets.push({ t: day, r: a && b ? b.close / a.open - 1 - 2 * fee : 0 });
  }
  return rets;
}

/** 每個 UTC 小時的平均報酬（萬分之幾），前後半段分開 */
function hourTable(data) {
  const acc = Array.from({ length: 24 }, () => ({ a: [0, 0, 0], b: [0, 0, 0] }));
  for (const c of Object.values(data)) {
    for (const k of c) {
      if (k.time < START) continue;
      const h = new Date(k.time).getUTCHours();
      const r = k.close / k.open - 1;
      const x = k.time < SPLIT ? acc[h].a : acc[h].b;
      x[0] += r; x[1]++; x[2] += r > 0 ? 1 : 0;
    }
  }
  return acc.map((x, h) => ({ h, a: x.a[0] / x.a[1] * 1e4, b: x.b[0] / x.b[1] * 1e4, pa: x.a[2] / x.a[1], pb: x.b[2] / x.b[1] }));
}

// ───────────────────────── E 波動突破 ─────────────────────────

function volBreakout(c, { k = 0.5, ma = 0, fee = FEE }) {
  const days = byDay(c);
  const rets = [];
  for (let i = Math.max(1, ma); i < days.length; i++) {
    const prev = days[i - 1].bars, bars = days[i].bars;
    const H = Math.max(...prev.map((x) => x.high)), L = Math.min(...prev.map((x) => x.low));
    const O = bars[0].open, target = O + k * (H - L);
    if (ma) {
      let s = 0;
      for (let j = i - ma; j < i; j++) s += days[j].bars[days[j].bars.length - 1].close;
      if (O <= s / ma) { rets.push({ t: days[i].day, r: 0 }); continue; }
    }
    const hit = bars.find((x) => x.high >= target);
    if (!hit) { rets.push({ t: days[i].day, r: 0 }); continue; }
    const entry = Math.max(target, hit.open);
    rets.push({ t: days[i].day, r: bars[bars.length - 1].close / entry - 1 - 2 * fee });
  }
  return rets;
}

// ───────────────────────── F UT Bot ─────────────────────────

function toInterval(c, hours) {
  if (hours === 1) return c;
  const m = new Map();
  for (const k of c) {
    const b = Math.floor(k.time / (hours * HOUR)) * hours * HOUR;
    const x = m.get(b);
    if (!x) m.set(b, { time: b, open: k.open, high: k.high, low: k.low, close: k.close });
    else { x.high = Math.max(x.high, k.high); x.low = Math.min(x.low, k.low); x.close = k.close; }
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function utBot(c, { a = 1, atrLen = 10, longOnly = false, fee = FEE, hours = 1 }) {
  const bars = toInterval(c, hours);
  let atr = null, stop = null, pos = 0;
  const dayR = new Map();
  for (let i = 1; i < bars.length; i++) {
    const k = bars[i], p = bars[i - 1];
    // 這根的報酬算給上一根收盤時的部位
    const g = pos * (k.close / p.close - 1);
    const tr = Math.max(k.high - k.low, Math.abs(k.high - p.close), Math.abs(k.low - p.close));
    atr = atr == null ? tr : atr + (tr - atr) / atrLen;
    const loss = a * atr, src = k.close, src1 = p.close;
    const ps = stop ?? src - loss;
    if (src > ps && src1 > ps) stop = Math.max(ps, src - loss);
    else if (src < ps && src1 < ps) stop = Math.min(ps, src + loss);
    else stop = src > ps ? src - loss : src + loss;
    let next = pos;
    if (src1 <= ps && src > stop) next = 1;           // 往上穿過停損線＝買
    else if (src1 >= ps && src < stop) next = longOnly ? 0 : -1; // 往下穿過＝賣
    const cost = Math.abs(next - pos) * fee;
    pos = next;
    const d = Math.floor((k.time + hours * HOUR - 1) / DAY) * DAY;
    dayR.set(d, (1 + (dayR.get(d) || 0)) * (1 + g) * (1 - cost) - 1);
  }
  return [...dayR.entries()].map(([t, r]) => ({ t, r }));
}

// ───────────────────────── 主程式 ─────────────────────────

(async () => {
  log(`網路上宣稱報酬很高的策略，用真實歷史資料重測（${new Date().toISOString().slice(0, 10)}）`);
  log(`期間 ${new Date(START).toISOString().slice(0, 10)} 起，前半＝${new Date(SPLIT).toISOString().slice(0, 10)} 以前；每邊手續費＋滑價 ${(FEE * 100).toFixed(3)}%；年化＝1 倍曝險（不開槓桿）`);
  log('資料：Binance 現貨 K 棒（跟 Bybit 永續價格幾乎一樣）。注意：幣是用「現在還在交易的」挑的，已經下市歸零的幣沒算進來，結果會偏樂觀。');

  const daysNeeded = Math.ceil((Date.now() - START) / DAY) + 420;
  const needDaily = run('A') || run('C') || run('D');
  const D1 = needDaily ? alignDaily(await load(G1, '1d', daysNeeded)) : null;
  const D2 = needDaily && (run('A') || run('D')) ? alignDaily(await load(G2, '1d', daysNeeded)) : null;

  if (needDaily) {
    table('比較基準：買了放著', [
      row('BTC 買了放著', buyHold(D1, ['BTC'])),
      row('第一組 20 幣等權', buyHold(D1, Object.keys(D1.closes))),
      row('第二組 20 幣等權', buyHold(D2 || D1, Object.keys((D2 || D1).closes))),
    ]);
  }

  if (run('A')) {
    const rows = [];
    for (const [g, D] of [['第一組', D1], ['第二組', D2]]) {
      const a = donchianEnsemble(D);
      rows.push(row(`${g} 唐奇安組合`, a.rets, `年換手 ${(a.turnover / (a.rets.length / 365)).toFixed(0)} 倍`));
      const b = donchianEnsemble(D, { band: 0.3 });
      rows.push(row(`${g} 唐奇安組合（少換倉）`, b.rets, `年換手 ${(b.turnover / (b.rets.length / 365)).toFixed(0)} 倍`));
      for (const mult of [2, 3]) {
        const m = donchianEnsemble(D, { band: 0.3, mult });
        rows.push(row(`${g} 唐奇安組合 ×${mult}（少換倉）`, m.rets, mult === 3 ? "線上 Demo 用這個" : ""));
      }
    }
    rows.push(row('只做 BTC 唐奇安組合', donchianEnsemble(D1, { only: ['BTC'] }).rets));
    rows.push(row('只做 BTC（不扣手續費）', donchianEnsemble(D1, { only: ['BTC'], fee: 0 }).rets, '對照'));
    table('A 唐奇安通道組合（論文宣稱 Sharpe > 1.5）', rows);
  }

  if (run('D')) {
    const rows = [];
    const sets = [[1, 1], [3, 1], [7, 7], [14, 7], [28, 7]];
    for (const [g, D] of [['第一組', D1], ['第二組', D2]]) {
      for (const [k, hold] of sets) {
        for (const mode of ['mom', 'rev']) {
          const r = crossSection(D, { k, hold, mode });
          rows.push(row(`${g} ${mode === 'mom' ? '動能' : '反轉'} 看${k}天 抱${hold}天`, r.rets, '多空各半'));
        }
      }
      rows.push(row(`${g} 只做多最強 20% 看28天`, crossSection(D, { k: 28, hold: 7, mode: 'mom', longOnly: true }).rets, '只做多'));
    }
    table('D 橫截面動能／反轉（多前 20%、空後 20%）', rows);
  }

  if (run('C')) {
    const btc = D1.closes.BTC, eth = D1.closes.ETH;
    const wk = (arr, wd, fee) => D1.days.slice(1).map((t, i) => ({ t, r: new Date(t).getUTCDay() === wd ? arr[i + 1] / arr[i] - 1 - 2 * fee : 0 }));
    const names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const rows = [];
    for (let wd = 0; wd < 7; wd++) rows.push(row(`BTC 只抱${names[wd]}`, wk(btc, wd, MAKER), '掛單手續費'));
    rows.push(row('ETH 只抱週一', wk(eth, 1, MAKER), '掛單手續費'));
    table('C 星期幾效應（UTC 日線，只在那一天持有）', rows);
  }

  const needHourly = run('B') || run('E') || run('F');
  if (needHourly) {
    const hoursNeeded = Math.ceil((Date.now() - START) / HOUR) + 24 * 40;
    for (const [g, syms] of [['大幣 10 檔', H1], ['第二組 10 檔', H2]]) {
      const data = await load(syms, '1h', hoursNeeded);
      const coins = Object.keys(data);
      if (!coins.length) continue;
      log('');
      log(`══════ 小時線：${g}（${coins.join(',')}）══════`);

      if (run('B')) {
        if (data.BTC || data[coins[0]]) {
          const c = data.BTC || data[coins[0]];
          const name = data.BTC ? 'BTC' : coins[0];
          const t = hourTable({ [name]: c });
          log('');
          log(`■ B ${name} 每個 UTC 小時的平均報酬（萬分之幾）：前半｜後半｜上漲比例（前半／後半）`);
          for (const x of t) log(`  ${String(x.h).padStart(2, '0')}:00  ${x.a.toFixed(1).padStart(6)}｜${x.b.toFixed(1).padStart(6)}   ${(x.pa * 100).toFixed(0)}%／${(x.pb * 100).toFixed(0)}%`);
          // 用前半段挑出最好的連續 2 小時，拿到後半段驗證（真正的樣本外）
          let best = 0, bh = 0;
          for (let h = 0; h < 23; h++) { const v = t[h].a + t[h + 1].a; if (v > best) { best = v; bh = h; } }
          const rows = [
            row(`${name} UTC 21～23 點持有（吃單）`, hourWindow(c, 21, 23, FEE)),
            row(`${name} UTC 21～23 點持有（掛單）`, hourWindow(c, 21, 23, MAKER)),
            row(`${name} 前半最好的 ${bh}～${bh + 2} 點（掛單）`, hourWindow(c, bh, bh + 2, MAKER), '後半＝樣本外'),
          ];
          const all = avgDaily(coins.map((s) => hourWindow(data[s], 21, 23, MAKER)), coins.length);
          rows.push(row(`${coins.length} 檔平均 21～23 點（掛單）`, all));
          table(`B 特定時段持有（${g}）`, rows);
        }
      }

      if (run('E')) {
        const rows = [];
        for (const k of [0.3, 0.5, 0.7]) {
          for (const ma of [0, 5]) {
            const per = coins.map((s) => volBreakout(data[s], { k, ma }));
            rows.push(row(`k=${k}${ma ? ` 開盤在 ${ma} 日均線上` : ''}`, avgDaily(per, coins.length), `${coins.length} 檔各 1/${coins.length}`));
          }
        }
        if (data.BTC) rows.push(row('只做 BTC k=0.5', volBreakout(data.BTC, { k: 0.5 })));
        table(`E 拉里·威廉斯波動突破（${g}，隔天開盤出場）`, rows);
      }

      if (run('F')) {
        const rows = [];
        for (const hours of [1, 4]) {
          for (const a of [1, 2, 3]) {
            rows.push(row(`${hours}h 敏感度 ${a} 多空`, avgDaily(coins.map((s) => utBot(data[s], { a, hours })), coins.length)));
          }
          rows.push(row(`${hours}h 敏感度 2 只做多`, avgDaily(coins.map((s) => utBot(data[s], { a: 2, hours, longOnly: true })), coins.length)));
        }
        table(`F UT Bot（${g}，ATR 10）`, rows);
      }
    }
  }

  log('');
  log('提醒：年化是 1 倍曝險；開槓桿報酬和回撤會一起放大，回撤 -35% 的策略開 3 倍就接近爆倉。');
})().catch((e) => { console.error(e); process.exit(1); });
