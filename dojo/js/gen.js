/**
 * 出題引擎：每一題都從真實歷史 K 線隨機切一段，用 src/smc/coach.js（跟線上 Discord 教練同一套規則）自動判題。
 * 同一個概念每次都是新的圖，背不了答案。
 *
 * 題目格式：
 *   { concept, kind: 'pick'|'choice', prompt, sub?, why,
 *     chart?: { W, from, to, ov: [...一開始就畫], reveal: [...答完才畫], hint?: [...提示] },
 *     options?: [{ label, ok }],           // choice
 *     pick?: { mode: 'bar'|'price'|'point', test(i, price) },   // 點圖題
 *     meta: { coin, tf, t } }
 * 圖上標記（i 都是 W 的索引）：
 *   zone {i1,i2,p1,p2,c,label}、hline {i1,i2,p,c,label,dash}、mark {i,p,c,label}、band {i,c}、vline {i,c,label}、tag {i,p,text,c,up}
 */
import { sampleWindow, htfTrend, fmtPrice, fmtTime, clamp, COINS } from './core.js';
import { coachState } from '../../src/smc/coach.js';
import { sessionOf } from '../../src/smc/sessions.js';
import { CONCEPT, CONCEPTS } from './concepts.js';

export const COL = { gold: '#D8B24A', jade: '#3DBB8F', shu: '#E2483D', sky: '#6FA8FF', mist: '#9AA6C4', ink: '#ECE6D6', violet: '#B07CE8' };
const VLEN = [0, 70, 85, 100, 115, 130];
const view = (W, diff) => ({ from: Math.max(0, W.length - VLEN[clamp(diff, 1, 5)]), to: W.length - 1 });
const barTol = (diff) => (diff <= 2 ? 2 : 1);
const last = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return arr[i]; return null; };
const meta = (s) => ({ coin: s.coin, tf: s.tf, t: s.W[s.W.length - 1].t });
const choice = (labels, okIdx) => labels.map((label, i) => ({ label, ok: i === okIdx }));
const pivLabels = (A, from) => A.piv.filter((p) => p.i >= from && p.lab).map((p) => ({ t: 'tag', i: p.i, p: p.p, text: p.lab, c: COL.mist, up: !!p.hi }));
const evLine = (e, c = COL.gold) => ({ t: 'hline', i1: e.from, i2: e.i, p: e.p, c, label: `${e.t}${e.dir > 0 ? '↑' : '↓'}` });
const dirZh = (d) => (d > 0 ? '向上' : '向下');

/* ---------- 各概念的出題方式（每個回傳題目或 null＝這段圖不適合，換一段） ---------- */

function qSwing(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), hi = rng.chance(0.5) ? 1 : 0;
  const p = last(A.piv, (x) => x.hi === hi && x.i >= v.from + 3);
  if (!p) return null;
  const a = A.atr[W.length - 1], tol = barTol(diff);
  return {
    concept: 'swing', kind: 'pick',
    prompt: `點出最近一個「已經確認」的擺動${hi ? '高' : '低'}點`,
    sub: '外部擺動點：左右各 4 根都比它' + (hi ? '低' : '高'),
    chart: { ...v, W, ov: [], reveal: [{ t: 'mark', i: p.i, p: p.p, c: COL.gold, label: hi ? '擺動高點' : '擺動低點' }] },
    answer: { i: p.i, p: p.p },
    pick: { mode: 'point', test: (i, pr) => Math.abs(i - p.i) <= tol && Math.abs(pr - p.p) <= 2 * a },
    why: `最近確認的擺動${hi ? '高' : '低'}點在 ${fmtPrice(p.p)}。比它更新的${hi ? '高' : '低'}點，右邊還沒有走滿 4 根，還不能確認。`,
    meta: meta(s),
  };
}

function qTrend(s, diff) {
  const { W, A } = s, j = W.length - 1, v = view(W, diff), tr = A.trend[j];
  if (!tr) return null;
  const e = A.ev[A.ev.length - 1];
  if (!e || e.i < v.from) return null;
  const age = j - e.i;
  if (e.t === 'CHoCH' && age > 5 && age <= 12) return null; // 模稜兩可，換一段
  const labels = ['多頭延續（HH、HL）', '空頭延續（LH、LL）', '剛轉多（向上 CHoCH）', '剛轉空（向下 CHoCH）'];
  const ok = e.t === 'CHoCH' && age <= 5 ? (e.dir > 0 ? 2 : 3) : tr > 0 ? 0 : 1;
  const evs = A.ev.filter((x) => x.i >= v.from).slice(-4);
  return {
    concept: 'trend', kind: 'choice',
    prompt: '現在的外部市場結構是？',
    sub: '看擺動點排列和最近一次收盤突破',
    chart: { ...v, W, ov: diff <= 2 ? pivLabels(A, v.from) : [], reveal: [...evs.map((x) => evLine(x)), ...(diff <= 2 ? [] : pivLabels(A, v.from))] },
    options: choice(labels, ok),
    why: `最近一次是 ${fmtTime(W[e.i].t)} 的${dirZh(e.dir)} ${e.t}（${age} 根前），${ok >= 2 ? '剛發生轉向' : '結構延續中'}。`,
    meta: meta(s),
  };
}

function qBreak(s, diff, rng, concept) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const want = concept === 'choch' ? (rng.chance(0.65) ? 'CHoCH' : 'BOS') : rng.chance(0.65) ? 'BOS' : 'CHoCH';
  const e = last(A.ev, (x) => x.t === want && x.from >= v.from && x.i <= j - 2);
  if (!e) return null;
  if (rng.chance(diff >= 3 ? 0.6 : 0.3)) {
    // 點圖：自己找出那一根
    const tol = barTol(diff) - 1 || 1;
    const later = A.ev.some((x) => x.i > e.i && x.t === e.t && x.dir === e.dir);
    if (later) return null;
    return {
      concept, kind: 'pick',
      prompt: `點出最近一次${dirZh(e.dir)} ${e.t} 的那根 K 棒（收盤突破的那根）`,
      sub: e.t === 'BOS' ? '順著原本趨勢突破＝BOS' : '逆著原本趨勢突破＝CHoCH',
      chart: { ...v, W, ov: [], reveal: [evLine(e), { t: 'band', i: e.i, c: COL.gold }] },
      answer: { i: e.i, p: e.p },
      pick: { mode: 'bar', test: (i) => Math.abs(i - e.i) <= tol },
      why: `${fmtTime(W[e.i].t)} 那根收盤${e.dir > 0 ? '站上' : '跌破'} ${fmtPrice(e.p)}。突破前的趨勢是${e.prev > 0 ? '多頭' : e.prev < 0 ? '空頭' : '不明'}，所以是 ${e.t}。`,
      meta: meta(s),
    };
  }
  const labels = ['向上 BOS', '向上 CHoCH', '向下 BOS', '向下 CHoCH'];
  const ok = (e.dir > 0 ? 0 : 2) + (e.t === 'CHoCH' ? 1 : 0);
  return {
    concept, kind: 'choice',
    prompt: '標出來的這次收盤突破是？',
    sub: '先判斷突破前的結構是多頭還是空頭',
    chart: { ...v, W, ov: [{ t: 'hline', i1: e.from, i2: e.i, p: e.p, c: COL.sky }, { t: 'band', i: e.i, c: COL.sky }], reveal: [evLine(e), ...pivLabels(A, v.from)] },
    options: choice(labels, ok),
    why: `突破前是${e.prev > 0 ? '多頭' : e.prev < 0 ? '空頭' : '還沒有方向的'}結構，這次${dirZh(e.dir)}突破${e.prev === 0 ? '算 BOS（第一次定方向）' : e.t === 'BOS' ? '跟原趨勢同向＝BOS' : '跟原趨勢反向＝CHoCH'}。`,
    meta: meta(s),
  };
}

function qProtected(s, diff) {
  const { W, A } = s, v = view(W, diff);
  const e = last(A.ev, (x) => x.t === 'CHoCH' && x.pi != null && x.pi >= v.from && x.from >= v.from);
  if (!e) return null;
  const tol = barTol(diff);
  return {
    concept: 'protected', kind: 'pick',
    prompt: `這次${dirZh(e.dir)} CHoCH 的保護${e.dir > 0 ? '低' : '高'}點在哪？點那根 K 棒`,
    sub: '就是推動這次突破的那段走勢的起點',
    chart: { ...v, W, ov: [evLine(e)], reveal: [{ t: 'mark', i: e.pi, p: e.pp, c: COL.shu, label: e.dir > 0 ? '保護低點' : '保護高點' }] },
    answer: { i: e.pi, p: e.pp },
    pick: { mode: 'bar', test: (i) => Math.abs(i - e.pi) <= tol },
    why: `這波${e.dir > 0 ? '上漲' : '下跌'}是從 ${fmtPrice(e.pp)} 開始的。之後收盤${e.dir > 0 ? '跌破' : '站上'}它，這次 CHoCH 就失效。`,
    meta: meta(s),
  };
}

function qLiq(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1, px = W[j].c, a = A.atr[j];
  const hi = rng.chance(0.5) ? 1 : 0;
  const cands = A.piv.filter((p) => p.hi === hi && p.i >= v.from && p.sw == null && (hi ? p.p > px : p.p < px));
  if (!cands.length) return null;
  const p = cands.reduce((b, x) => (Math.abs(x.p - px) < Math.abs(b.p - px) ? x : b));
  if (Math.abs(p.p - px) < 0.5 * a) return null;
  const tol = barTol(diff) + 1;
  return {
    concept: 'liq', kind: 'pick',
    prompt: `點出現價${hi ? '上方' : '下方'}最近的${hi ? '買方流動性（BSL）' : '賣方流動性（SSL）'}`,
    sub: `還沒被碰過的擺動${hi ? '高' : '低'}點，${hi ? '空單停損' : '多單停損'}都堆在那裡`,
    chart: { ...v, W, ov: [], reveal: [{ t: 'hline', i1: p.i, i2: j, p: p.p, c: COL.sky, dash: true, label: hi ? 'BSL' : 'SSL' }] },
    answer: { i: p.i, p: p.p },
    pick: { mode: 'point', test: (i, pr) => Math.abs(i - p.i) <= tol && Math.abs(pr - p.p) <= 1.5 * a },
    why: `${fmtPrice(p.p)} 這個擺動${hi ? '高' : '低'}點還沒被碰過，離現價最近。${hi ? '上面' : '下面'}的停損就是價格的磁鐵。`,
    meta: meta(s),
  };
}

/** 找出窗內所有「刺破擺動點又收回」的掃蕩 */
export function findSweeps(W, A) {
  const out = [];
  for (const p of A.piv) {
    for (let u = p.k; u < W.length; u++) {
      if (u <= p.i) continue;
      const pierce = p.hi ? W[u].h > p.p : W[u].l < p.p;
      if (!pierce) continue;
      const back = p.hi ? W[u].c < p.p : W[u].c > p.p;
      if (back) out.push({ u, p: p.p, hi: p.hi, pi: p.i });
      break;
    }
  }
  return out.sort((x, y) => x.u - y.u);
}

function qSweep(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const hi = rng.chance(0.5) ? 1 : 0;
  const sw = last(findSweeps(W, A), (x) => x.hi === hi && x.u >= v.from + 5 && x.u <= j - 1 && x.pi >= v.from);
  if (!sw) return null;
  return {
    concept: 'sweep', kind: 'pick',
    prompt: `點出最近一根「刺破前${hi ? '高' : '低'}又收回」、掃${hi ? '買方' : '賣方'}流動性的 K 棒`,
    sub: '影線出去、收盤回來',
    chart: { ...v, W, ov: [], reveal: [{ t: 'hline', i1: sw.pi, i2: sw.u, p: sw.p, c: COL.sky, dash: true }, { t: 'mark', i: sw.u, p: hi ? W[sw.u].h : W[sw.u].l, c: COL.shu, label: '掃' }] },
    answer: { i: sw.u, p: sw.p },
    pick: { mode: 'bar', test: (i) => Math.abs(i - sw.u) <= 1 },
    why: `${fmtTime(W[sw.u].t)} 那根影線${hi ? '刺過' : '刺穿'} ${fmtPrice(sw.p)}，收盤又收回來。`,
    meta: meta(s),
  };
}

function qFvg(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1, a = A.atr[j];
  const d = rng.chance(0.5) ? 1 : -1;
  const cands = A.fv.filter((f) => f.dir === d && f.i >= v.from && f.k <= j && f.fill == null);
  if (!cands.length) return null;
  return {
    concept: 'fvg', kind: 'pick',
    prompt: `點出一個還沒被回補的看${d > 0 ? '漲' : '跌'} FVG（點缺口中間那根）`,
    sub: d > 0 ? '第 3 根的低點 > 第 1 根的高點，而且之後價格沒回來碰過' : '第 3 根的高點 < 第 1 根的低點，而且之後價格沒回來碰過',
    chart: { ...v, W, ov: [], reveal: cands.map((f) => ({ t: 'zone', i1: f.i - 1, i2: j, p1: f.p1, p2: f.p2, c: COL.gold, label: 'FVG' })) },
    answer: { i: cands[0].i, p: (cands[0].p1 + cands[0].p2) / 2 },
    pick: { mode: 'point', test: (i, pr) => cands.some((f) => Math.abs(i - f.i) <= 1 && pr >= Math.min(f.p1, f.p2) - 0.8 * a && pr <= Math.max(f.p1, f.p2) + 0.8 * a) },
    why: `畫面上有 ${cands.length} 個還沒被回補的看${d > 0 ? '漲' : '跌'} FVG，點到任何一個都算對。`,
    meta: meta(s),
  };
}

function qFvgFill(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const wantFilled = rng.chance(0.5);
  const cands = A.fv.filter((f) => f.i >= v.from + 2 && f.i <= j - 6 && (f.fill != null) === wantFilled);
  if (!cands.length) return null;
  const f = rng.pick(cands);
  const labels = ['看漲・已回補', '看漲・還沒回補', '看跌・已回補', '看跌・還沒回補'];
  const ok = (f.dir > 0 ? 0 : 2) + (f.fill != null ? 0 : 1);
  return {
    concept: 'fvgfill', kind: 'choice',
    prompt: '框起來的缺口是？',
    sub: '先看方向，再看之後價格有沒有回來碰到',
    chart: { ...v, W, ov: [{ t: 'zone', i1: f.i - 1, i2: j, p1: f.p1, p2: f.p2, c: COL.sky }], reveal: f.fill != null ? [{ t: 'band', i: f.fill, c: COL.shu }] : [] },
    options: choice(labels, ok),
    why: `這是看${f.dir > 0 ? '漲' : '跌'} FVG，${f.fill != null ? `在 ${fmtTime(W[f.fill].t)} 被回補了（紅色那根）` : '之後價格都沒有回來碰到'}。`,
    meta: meta(s),
  };
}

function qDisp(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const cat = rng.int(0, 2); // 0 不是、1 是沒 FVG、2 是而且有 FVG
  const fvAt = new Set(A.fv.map((f) => f.i));
  const cands = [];
  for (let u = v.from + 3; u <= j - 2; u++) {
    const body = Math.abs(W[u].c - W[u].o) / A.atr[u];
    const c = body >= 1.1 ? (fvAt.has(u) ? 2 : 1) : body < 0.7 ? 0 : -1;
    if (c === cat && (cat > 0 || body > 0.35)) cands.push(u);
  }
  if (!cands.length) return null;
  const u = rng.pick(cands), body = Math.abs(W[u].c - W[u].o) / A.atr[u];
  return {
    concept: 'disp', kind: 'choice',
    prompt: '標出的這根 K 棒是位移（displacement）嗎？',
    sub: '實體大約超過 1 個 ATR（平均波動）才算',
    chart: { ...v, W, ov: [{ t: 'band', i: u, c: COL.sky }], reveal: fvAt.has(u) ? A.fv.filter((f) => f.i === u).map((f) => ({ t: 'zone', i1: u - 1, i2: Math.min(j, u + 8), p1: f.p1, p2: f.p2, c: COL.gold, label: 'FVG' })) : [] },
    options: choice(['不是位移', '是位移，沒有留下 FVG', '是位移，而且留下 FVG'], cat),
    why: `這根實體約 ${body.toFixed(1)} 個 ATR${cat === 0 ? '，不夠大' : cat === 2 ? '，前後兩根影線沒重疊，留下了 FVG' : '，但前後影線有重疊，沒有 FVG'}。`,
    meta: meta(s),
  };
}

function qOb(s, diff) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const e = last(A.ev, (x) => x.from >= v.from && x.i <= j - 1 && A.obs.some((o) => o.k === x.i && o.dir === x.dir));
  if (!e) return null;
  const o = A.obs.find((x) => x.k === e.i && x.dir === e.dir);
  return {
    concept: 'ob', kind: 'pick',
    prompt: `標出的是一次${dirZh(e.dir)}結構突破。點出推動它的訂單塊（OB）`,
    sub: `這段${e.dir > 0 ? '上漲' : '下跌'}開始之前，最後一根${e.dir > 0 ? '陰' : '陽'}線`,
    chart: { ...v, W, ov: [evLine(e)], reveal: [{ t: 'zone', i1: o.i, i2: Math.min(j, e.i + 6), p1: o.p1, p2: o.p2, c: e.dir > 0 ? COL.jade : COL.shu, label: 'OB' }] },
    answer: { i: o.i, p: (o.p1 + o.p2) / 2 },
    pick: { mode: 'bar', test: (i) => Math.abs(i - o.i) <= 1 },
    why: `OB 是 ${fmtTime(W[o.i].t)} 那根${e.dir > 0 ? '陰' : '陽'}線（${fmtPrice(o.p2)}～${fmtPrice(o.p1)}），之後價格一路推到突破 ${fmtPrice(e.p)}。`,
    meta: meta(s),
  };
}

function qObInv(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const wantInv = rng.chance(0.5);
  const cands = A.obs.filter((o) => o.i >= v.from && o.k <= j - 5 && (o.inv != null) === wantInv);
  if (!cands.length) return null;
  const o = rng.pick(cands);
  return {
    concept: 'obinv', kind: 'choice',
    prompt: `框起來的看${o.dir > 0 ? '漲' : '跌'} OB 現在還有效嗎？`,
    sub: `收盤${o.dir > 0 ? '跌破 OB 低點' : '站上 OB 高點'}就失效`,
    chart: { ...v, W, ov: [{ t: 'zone', i1: o.i, i2: j, p1: o.p1, p2: o.p2, c: COL.sky, label: 'OB' }], reveal: o.inv != null ? [{ t: 'band', i: o.inv, c: COL.shu }] : [] },
    options: choice(['還有效', '已經失效'], o.inv != null ? 1 : 0),
    why: o.inv != null ? `${fmtTime(W[o.inv].t)} 那根收盤穿過了 OB，失效了。` : '之後沒有任何一根收盤穿過 OB 的另一端，還有效。',
    meta: meta(s),
  };
}

function qPd(s, diff) {
  const { W } = s, v = view(W, diff), j = W.length - 1, px = W[j].c;
  let rH = -Infinity, rL = Infinity;
  for (let i = j - 79; i <= j; i++) { rH = Math.max(rH, W[i].h); rL = Math.min(rL, W[i].l); }
  const eq = (rH + rL) / 2;
  if (Math.abs(px - eq) < 0.12 * (rH - rL)) return null;
  const ov = [{ t: 'vline', i: j - 79, c: COL.mist, label: '區間起點' }];
  if (diff <= 3) ov.push({ t: 'hline', i1: j - 79, i2: j, p: rH, c: COL.mist }, { t: 'hline', i1: j - 79, i2: j, p: rL, c: COL.mist });
  if (diff <= 1) ov.push({ t: 'hline', i1: j - 79, i2: j, p: eq, c: COL.gold, dash: true, label: '50%' });
  return {
    concept: 'pd', kind: 'choice',
    prompt: '用最近 80 根的最高到最低當區間，現價在？',
    sub: '區間對半切，上面貴、下面便宜',
    chart: { ...v, W, ov, reveal: [{ t: 'hline', i1: j - 79, i2: j, p: eq, c: COL.gold, dash: true, label: '50%' }, { t: 'zone', i1: j - 79, i2: j, p1: eq, p2: rL, c: COL.jade, label: '折價' }, { t: 'zone', i1: j - 79, i2: j, p1: rH, p2: eq, c: COL.shu, label: '溢價' }] },
    options: choice(['折價區（便宜，找多單）', '溢價區（貴，找空單）'], px < eq ? 0 : 1),
    why: `區間 ${fmtPrice(rL)}～${fmtPrice(rH)}，50% 在 ${fmtPrice(eq)}，現價 ${fmtPrice(px)} 在${px < eq ? '下半部（折價）' : '上半部（溢價）'}。`,
    meta: meta(s),
  };
}

const BIG = { '15m': '1h', '1h': '4h', '4h': '16h' };
function qMtf(s, diff) {
  const { W, tf } = s;
  const h = htfTrend(W, tf, 4);
  if (!h.trend || h.agg.length < 40) return null;
  const G = h.agg, vlen = Math.min(G.length, VLEN[diff] - 20);
  return {
    concept: 'mtf', kind: 'choice',
    prompt: `這是 ${BIG[tf]} 圖。到 ${tf} 找劇本時，該找哪個方向？`,
    sub: '大週期定方向，小週期找進場',
    chart: { W: G, from: G.length - vlen, to: G.length - 1, ov: [], reveal: h.S.ev.filter((e) => e.i >= G.length - vlen).slice(-3).map((e) => evLine(e)) },
    options: choice(['只找多單', '只找空單', '多空兩邊都做'], h.trend > 0 ? 0 : 1),
    why: `${BIG[tf]} 最近的結構是${h.trend > 0 ? '多頭' : '空頭'}，小週期只做${h.trend > 0 ? '多' : '空'}；逆向的小週期訊號多半只是回檔。`,
    meta: meta(s),
  };
}

function qSession(s, diff, rng) {
  const { W } = s, v = view(W, diff), j = W.length - 1;
  const want = rng.pick(['asia', 'london', 'nyam', 'nypm', null]);
  const cands = [];
  for (let u = v.from + 5; u <= j - 3; u++) { const ss = sessionOf(W[u].t * 1000); if ((ss ? ss.id : null) === want) cands.push(u); }
  if (!cands.length) return null;
  const u = rng.pick(cands);
  const ids = ['asia', 'london', 'nyam', 'nypm', null];
  return {
    concept: 'session', kind: 'choice',
    prompt: `標出的這根 K 棒開盤時間是台灣 ${fmtTime(W[u].t).slice(11)}，它在哪個時段？`,
    sub: '台灣時間＝UTC＋8',
    chart: { ...v, W, ov: [{ t: 'band', i: u, c: COL.sky }], reveal: [] },
    options: choice(['亞洲盤', '倫敦殺區', '紐約早盤殺區', '紐約午盤殺區', '都不是'], ids.indexOf(want)),
    why: '亞洲＝台灣 8～14 點、倫敦殺區＝15～18 點、紐約早盤＝20～23 點、紐約午盤＝凌晨 1:30～4 點。',
    meta: meta(s),
  };
}

/** 教練劇本（多或空）的狀態，給劇本相關題目共用 */
function setupOf(s, d) {
  const bias = htfTrend(s.W, s.tf, 4).trend;
  const st = coachState(s.W, s.A, bias);
  return st[d > 0 ? 'L' : 'S'];
}
const STAGES = ['還沒掃流動性', '已掃流動性，等結構轉向', '已轉向，等 POI（FVG／OB）', 'POI 出現，等回踩', '已回踩，計畫成立'];
function setupOverlays(s, r) {
  const { W } = s, j = W.length - 1, ov = [];
  if (r.sweep) ov.push({ t: 'mark', i: r.sweep.u, p: r.d > 0 ? W[r.sweep.u].l : W[r.sweep.u].h, c: COL.shu, label: '①掃' });
  if (r.ev) ov.push({ t: 'hline', i1: Math.max(0, r.ev.i - 12), i2: r.ev.i, p: r.ev.p, c: COL.gold, label: `②${r.ev.t}` });
  if (r.poi) ov.push({ t: 'zone', i1: r.poi.i - 1, i2: j, p1: r.poi.top, p2: r.poi.bot, c: COL.jade, label: `③${r.poi.kind}` });
  if (r.rt != null) ov.push({ t: 'band', i: r.rt, c: COL.violet });
  return ov;
}

function qStage(s, diff, rng, _c, want) {
  const d = rng.chance(0.5) ? 1 : -1, r = setupOf(s, d);
  if (want != null && r.stage !== want) return null;
  const v = view(s.W, diff);
  return {
    concept: 'stage', kind: 'choice',
    prompt: `找${d > 0 ? '多' : '空'}單的五步劇本，現在走到哪？`,
    sub: '掃流動性 → 結構轉向 → POI → 回踩 → 計畫',
    chart: { ...v, W: s.W, ov: diff <= 2 ? pivLabels(s.A, v.from) : [], reveal: setupOverlays(s, r) },
    options: choice(STAGES, r.stage),
    why: r.stage === 0 ? '最近 45 根裡沒有「刺破又收回、而且沒被破掉」的掃蕩，劇本還沒開始。' : `走到「${STAGES[r.stage]}」。圖上 ①②③ 是教練找到的各步驟。`,
    meta: meta(s),
  };
}

function readySetup(s, rng) {
  for (const d of rng.shuffle([1, -1])) { const r = setupOf(s, d); if (r.ready) return r; }
  return null;
}

function qStop(s, diff, rng) {
  const r = readySetup(s, rng);
  if (!r) return null;
  const { W } = s, j = W.length - 1, a = s.A.atr[j], v = view(W, diff), p = r.plan, d = r.d;
  const from = Math.min(v.from, r.sweep.u - 5);
  const tol = [0, 0.7, 0.55, 0.45, 0.35, 0.3][diff] * a;
  return {
    concept: 'stop', kind: 'pick',
    prompt: `${d > 0 ? '多' : '空'}單計畫：在${p.kind}${d > 0 ? '上緣' : '下緣'}進場。停損該放哪？點出價位`,
    sub: '放在「劇本不成立」的地方',
    chart: { from, to: j, W, ov: [{ t: 'zone', i1: r.poi.i - 1, i2: j, p1: r.poi.top, p2: r.poi.bot, c: COL.jade, label: p.kind }, { t: 'hline', i1: r.poi.i, i2: j, p: p.en, c: COL.ink, label: '進場' }], reveal: [{ t: 'hline', i1: r.sweep.u, i2: j, p: p.sl, c: COL.shu, label: '停損' }, { t: 'mark', i: r.sweep.u, p: d > 0 ? W[r.sweep.u].l : W[r.sweep.u].h, c: COL.shu, label: '掃' }] },
    answer: { i: j, p: p.sl },
    pick: { mode: 'price', test: (_i, pr) => Math.abs(pr - p.sl) <= tol },
    why: `停損在掃蕩極值 ${fmtPrice(r.sweep.ext)} 外面 0.15 ATR＝${fmtPrice(p.sl)}。價格回到那裡＝掃蕩失敗。`,
    meta: meta(s),
  };
}

function qTarget(s, diff, rng) {
  const r = readySetup(s, rng);
  if (!r) return null;
  const { W } = s, j = W.length - 1, a = s.A.atr[j], v = view(W, diff), p = r.plan, d = r.d;
  const tol = [0, 0.9, 0.7, 0.55, 0.45, 0.4][diff] * a;
  return {
    concept: 'target', kind: 'pick',
    prompt: `${d > 0 ? '多' : '空'}單已經有進場和停損，第一個目標放哪？點出價位`,
    sub: `對面最近、還沒被掃過的擺動${d > 0 ? '高' : '低'}點`,
    chart: { ...v, W, ov: [{ t: 'hline', i1: r.poi.i, i2: j, p: p.en, c: COL.ink, label: '進場' }, { t: 'hline', i1: r.poi.i, i2: j, p: p.sl, c: COL.shu, label: '停損' }], reveal: [{ t: 'hline', i1: v.from, i2: j, p: p.tp, c: COL.jade, label: '目標' }] },
    answer: { i: j, p: p.tp },
    pick: { mode: 'price', test: (_i, pr) => Math.abs(pr - p.tp) <= tol },
    why: `目標 ${fmtPrice(p.tp)}：進場之${d > 0 ? '上' : '下'}最近、還沒被碰過的擺動點（沒有的話用 80 根區間極值）。`,
    meta: meta(s),
  };
}

function qRr(s, diff, rng) {
  const r = readySetup(s, rng);
  if (!r) return null;
  const { W } = s, j = W.length - 1, v = view(W, diff), p = r.plan;
  const rr = Math.round(p.rr * 10) / 10;
  if (rr < 0.3) return null;
  const pool = [rr, Math.round(10 / p.rr) / 10, Math.round((p.rr + 1) * 10) / 10, Math.round(p.rr * 2 * 10) / 10, Math.round(p.rr * 0.5 * 10) / 10];
  const opts = [...new Set(pool.map((x) => x.toFixed(1)))].slice(0, 4);
  if (opts.length < 3) return null;
  const sh = rng.shuffle(opts);
  return {
    concept: 'rr', kind: 'choice',
    prompt: '這個計畫的盈虧比是多少？',
    sub: `進場 ${fmtPrice(p.en)}・停損 ${fmtPrice(p.sl)}・目標 ${fmtPrice(p.tp)}`,
    chart: { ...v, W, ov: [{ t: 'hline', i1: v.from, i2: j, p: p.en, c: COL.ink, label: '進場' }, { t: 'hline', i1: v.from, i2: j, p: p.sl, c: COL.shu, label: '停損' }, { t: 'hline', i1: v.from, i2: j, p: p.tp, c: COL.jade, label: '目標' }], reveal: [] },
    options: sh.map((x) => ({ label: `${x} R`, ok: x === rr.toFixed(1) })),
    why: `（${fmtPrice(p.tp)} − ${fmtPrice(p.en)}）÷（${fmtPrice(p.en)} − ${fmtPrice(p.sl)}）≈ ${rr.toFixed(1)}。`,
    meta: meta(s),
  };
}

/* ---------- 不用圖的計算題 ---------- */
const round = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
function numOpts(rng, right, wrongs, fmt) {
  const set = [right, ...wrongs].map(round).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
  return rng.shuffle(set).map((x) => ({ label: fmt(x), ok: x === round(right) }));
}
function qRisk(rng) {
  const kind = rng.int(0, 2);
  if (kind === 0) {
    const E = rng.pick([200, 300, 500, 1000, 2000]), r = rng.pick([1, 2, 3]), st = rng.pick([1, 1.5, 2, 2.5, 4, 5]);
    const n = E * r / st, amt = E * r / 100;
    return { concept: 'risk', kind: 'choice', prompt: `帳戶 ${E}U，每筆風險 ${r}%，停損距離 ${st}%。倉位名目應該開多大？`, options: numOpts(rng, n, [amt, n * 2, E * st / 100, n / 2], (x) => `${x}U`), why: `願意虧 ${E}×${r}%＝${amt}U；倉位＝${amt} ÷ ${st}%＝${round(n)}U。`, meta: {} };
  }
  if (kind === 1) {
    const x = rng.pick([20, 30, 40, 50, 60, 75, 80, 90]), need = x / (100 - x) * 100;
    return { concept: 'risk', kind: 'choice', prompt: `帳戶虧了 ${x}%，要賺幾 % 才能回本？`, options: numOpts(rng, need, [x, x * 1.2, need / 2], (y) => `${y}%`), why: `剩 ${100 - x}%，要回到 100% 得漲 ${x}÷${100 - x}＝${round(need)}%。虧損越大，回本越難。`, meta: {} };
  }
  const r = rng.pick([2, 5, 10, 20, 30]), n = rng.pick([5, 8, 10]), left = Math.pow(1 - r / 100, n) * 100;
  return { concept: 'risk', kind: 'choice', prompt: `每筆拿帳戶的 ${r}% 去冒險，連虧 ${n} 筆（很常見）之後，帳戶剩多少？`, options: numOpts(rng, left, [100 - r * n > 0 ? 100 - r * n : left * 2, left * 1.6, Math.min(99, left * 0.5)], (y) => `${y}%`), why: `每次都是剩下的 ${100 - r}%，${n} 次＝${100 - r}%^${n} ≈ ${round(left)}%。`, meta: {} };
}
function qLev(rng) {
  const kind = rng.int(0, 2);
  if (kind === 0) {
    const L = rng.pick([10, 20, 25, 50, 75, 100, 125, 150]), dist = 100 / L;
    return { concept: 'lev', kind: 'choice', prompt: `用 ${L} 倍槓桿開倉（全部保證金都押上），價格反向大約走多少就爆倉？（先不算維持保證金）`, options: numOpts(rng, dist, [dist * 10, L / 10, dist * 3], (y) => `${y}%`), why: `${L} 倍＝保證金是倉位的 1/${L}，反向 ${round(dist)}% 就虧光。實際上維持保證金會讓爆倉價更近。`, meta: {} };
  }
  if (kind === 1) {
    const N = rng.pick([500, 1000, 2000, 5000]), L = rng.pick([5, 10, 20, 50]);
    return { concept: 'lev', kind: 'choice', prompt: `倉位名目 ${N}U、${L} 倍槓桿，要押多少保證金？`, options: numOpts(rng, N / L, [N, N * L / 100, N / L * 2], (x) => `${x}U`), why: `保證金＝名目 ÷ 槓桿＝${N}÷${L}＝${round(N / L)}U。虧多少看的是名目 × 價格變動，跟槓桿無關。`, meta: {} };
  }
  const L = rng.pick([10, 20, 50, 75, 100, 150]), st = rng.pick([1, 1.5, 2, 3]);
  const liqFirst = 100 / L * 0.85 < st;
  return { concept: 'lev', kind: 'choice', prompt: `${L} 倍槓桿、停損設在反向 ${st}%。價格反向走，會先發生什麼？`, options: choice(['先打到停損，照計畫虧', '先爆倉，停損根本沒機會執行'], liqFirst ? 1 : 0), why: `${L} 倍大約反向 ${round(100 / L)}%（扣維持保證金更近）就爆倉，${liqFirst ? `比停損 ${st}% 還近，所以先爆倉` : `比停損 ${st}% 遠，所以會先停損`}。`, meta: {} };
}

/* ---------- 選出最正確的說法 ---------- */
export function qExplain(conceptId, rng) {
  const c = CONCEPT[conceptId];
  const it = rng.pick(c.explain);
  const opts = rng.shuffle(it.opts.map((label, i) => ({ label, ok: i === 0 })));
  return { concept: conceptId, kind: 'choice', explain: true, prompt: it.q, options: opts, why: it.why, meta: {} };
}

/* ---------- 找錯：三個標記裡有一個是錯的 ---------- */
function qSpot(s, diff, rng) {
  const { W, A } = s, v = view(W, diff), j = W.length - 1;
  const items = [];
  const e = last(A.ev, (x) => x.from >= v.from && x.prev !== 0);
  if (e) items.push({ concept: e.t === 'BOS' ? 'bos' : 'choch', right: evLine(e, COL.sky), wrong: { ...evLine(e, COL.sky), label: `${e.t === 'BOS' ? 'CHoCH' : 'BOS'}${e.dir > 0 ? '↑' : '↓'}` }, fact: `那條線是 ${e.t}（突破前是${e.prev > 0 ? '多頭' : '空頭'}）` });
  const p = last(A.piv, (x) => x.i >= v.from + 2 && x.lab);
  if (p) {
    const flip = { HH: 'LH', LH: 'HH', HL: 'LL', LL: 'HL' }[p.lab];
    items.push({ concept: 'trend', right: { t: 'tag', i: p.i, p: p.p, text: p.lab, c: COL.sky, up: !!p.hi }, wrong: { t: 'tag', i: p.i, p: p.p, text: flip, c: COL.sky, up: !!p.hi }, fact: `那個擺動點是 ${p.lab}` });
  }
  const f = last(A.fv, (x) => x.i >= v.from + 2 && x.i <= j - 5);
  if (f) {
    const st = f.fill != null ? '已回補' : '未回補', other = f.fill != null ? '未回補' : '已回補';
    const z = { t: 'zone', i1: f.i - 1, i2: j, p1: f.p1, p2: f.p2, c: COL.sky };
    items.push({ concept: 'fvgfill', right: { ...z, label: `FVG ${st}` }, wrong: { ...z, label: `FVG ${other}` }, fact: `那個 FVG 其實${st}` });
  }
  if (items.length < 3) return null;
  const bad = rng.int(0, 2), L = ['A', 'B', 'C'];
  const ov = items.map((it, k) => {
    const o = { ...(k === bad ? it.wrong : it.right) };
    if (o.label != null) o.label = `${L[k]} ${o.label}`; else o.text = `${L[k]} ${o.text}`;
    return o;
  });
  return {
    concept: items[bad].concept, kind: 'choice', spot: true,
    prompt: '找錯：A、B、C 三個標記裡，哪一個是錯的？',
    sub: '只有一個是錯的',
    chart: { ...v, W, ov, reveal: [] },
    options: L.map((x, k) => ({ label: `${x} 錯了`, ok: k === bad })),
    why: `${L[bad]} 錯了：${items[bad].fact}。`,
    meta: meta(s),
  };
}

/* ---------- 對外 ---------- */
const CHART_GEN = {
  swing: [qSwing], trend: [qTrend], bos: [qBreak], choch: [qBreak], protected: [qProtected],
  liq: [qLiq], sweep: [qSweep], fvg: [qFvg], fvgfill: [qFvgFill], disp: [qDisp],
  ob: [qOb], obinv: [qObInv], pd: [qPd], mtf: [qMtf], session: [qSession],
  stage: [qStage], stop: [qStop], target: [qTarget], rr: [qRr],
};
const SPOTTABLE = new Set(['trend', 'bos', 'choch', 'fvgfill']);
const NEEDS_SETUP = new Set(['stop', 'target', 'rr']);

/**
 * 出一題。concept＝概念 id；diff 1～5；opts.explainRate：多少比例出「選最正確說法」；opts.coin／tf 指定行情。
 * 回傳 Promise<題目>。真實行情找不到合適的段落時，退回說法題（一定出得來）。
 */
export async function makeQuestion(concept, { rng, diff = 2, explainRate = 0.2, spotRate = null, coin, tf } = {}) {
  if (concept === 'risk') return rng.chance(explainRate) ? qExplain('risk', rng) : qRisk(rng);
  if (concept === 'lev') return rng.chance(explainRate) ? qExplain('lev', rng) : qLev(rng);
  const gens = CHART_GEN[concept];
  if (!gens || rng.chance(explainRate)) return qExplain(concept, rng);
  const spot = SPOTTABLE.has(concept) && rng.chance(spotRate ?? (diff >= 3 ? 0.25 : 0));
  const tries = NEEDS_SETUP.has(concept) || concept === 'stage' ? 60 : 30;
  const wantStage = concept === 'stage' ? (rng.chance(0.15) ? 0 : rng.int(1, 4)) : null;
  for (let k = 0; k < tries; k++) {
    const useTf = concept === 'session' ? rng.pick(['15m', '1h']) : tf;
    let s;
    try { s = await sampleWindow(rng, { coin, tf: useTf }); } catch (e) { if (k > 2) throw e; continue; }
    const q = spot ? qSpot(s, diff, rng) : gens[0](s, diff, rng, concept, wantStage);
    if (q && (!spot || q.concept === concept || k > 10)) { q.diff = diff; return q; }
    if (concept === 'stage' && k > 40) { const q2 = qStage(s, diff, rng, concept, null); if (q2) { q2.diff = diff; return q2; } }
  }
  return qExplain(concept, rng);
}

export const ALL_IDS = CONCEPTS.map((c) => c.id);
export { COINS };
