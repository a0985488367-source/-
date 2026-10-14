/**
 * TradingView「SMC 教練」指標（tradingview/coach.pine）跟原版教練規則（src/smc/coach.js）逐項比對。
 *
 * tradingview/pine2js.py --funcs 只把 Pine 的函式轉成 JS，用同一批真實 K 棒（dojo/mdata）
 * 分別跑兩邊：階段、掃蕩、結構轉向、POI、回踩、進場／停損／目標／盈虧比、折溢價、大週期趨勢、時段。
 * 改了 src/smc/coach.js 卻沒同步改 coach.pine，這裡就會失敗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, structure, atrOf, coachState } from '../src/smc/coach.js';
import { sessionOf, SESSIONS } from '../src/smc/sessions.js';

const ROOT = new URL('..', import.meta.url);
const pineJs = execFileSync('python3', [new URL('tradingview/pine2js.py', ROOT).pathname, '--funcs', new URL('tradingview/coach.pine', ROOT).pathname], { encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'pine-coach-'));
const file = join(dir, 'coach.mjs');
writeFileSync(file, `
function isNa(x) { return x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x)); }
function newArr(n, v) { return Array.from({ length: n }, () => (v === undefined ? NaN : v)); }
function arrFrom(...a) { return a; }
function utc_hour(t) { return new Date(t).getUTCHours(); }
function utc_minute(t) { return new Date(t).getUTCMinutes(); }
if (!Array.prototype.get) {
  Object.defineProperty(Array.prototype, 'get', { value(i) { return this[i]; } });
  Object.defineProperty(Array.prototype, 'set', { value(i, v) { this[i] = v; } });
  Object.defineProperty(Array.prototype, 'size', { value() { return this.length; } });
}
${pineJs}
export { sessOf, atrOf, structureOf, fvgsOf, obsOf, coachSide };
`);
const P = await import(pathToFileURL(file).href);

/* dojo/ 裡打包的 Binance 真實 K 棒（壓縮格式）解回 {t,o,h,l,c}，t 是秒 */
function decode(o) {
  const d = o.d.split(','), C = [], m = 10 ** o.dec;
  let pc = o.o0, t = o.t0, i = 0;
  while (i < d.length) {
    const tk = d[i];
    if (tk[0] === '~') { t += parseInt(tk.slice(1), 36) * o.dt; i++; continue; }
    const a = parseInt(tk, 36), bh = parseInt(d[i + 1], 36), c = parseInt(d[i + 2], 36), bl = parseInt(d[i + 3], 36);
    i += 4;
    const op = pc + a, cl = op + c;
    C.push({ t, o: op / m, h: (Math.max(op, cl) + bh) / m, l: (Math.min(op, cl) - bl) / m, c: cl / m });
    pc = cl; t += o.dt;
  }
  return C;
}
const load = (name) => decode(JSON.parse(readFileSync(new URL(`dojo/mdata/${name}.json`, ROOT))));

/** 照 coach.pine 主程式的順序呼叫 Pine 版函式 */
function runPine(W) {
  const o = W.map((k) => k.o), h = W.map((k) => k.h), l = W.map((k) => k.l), c = W.map((k) => k.c);
  const atr = P.atrOf(h, l, c);
  const [pI, pP, pK, pHi, pSw, eDir, eI, eP, eT, eFrom, trend] = P.structureOf(h, l, c, 4);
  const [fDir, fI, fTop, fBot, fK, fFill] = P.fvgsOf(h, l, atr);
  const [oDir, oI, oTop, oBot, oK, oInv] = P.obsOf(o, h, l, c, eDir, eI, eFrom);
  const side = (d) => {
    const [stage, ready, swU, swP, swX, ext, ev, pk, pTop, pBot, pAtI, pAtK, rt, en, sl, tp, rr, disc] = P.coachSide(h, l, c, atr, pI, pP, pK, pHi, pSw, eDir, eI, fDir, fI, fTop, fBot, fK, fFill, oDir, oI, oTop, oBot, oK, oInv, d);
    return { stage, ready, swU, swP, swX, ext, ev: ev >= 0 ? { p: eP[ev], i: eI[ev], t: eT[ev] === 2 ? 'CHoCH' : 'BOS' } : null, pk, pTop, pBot, pAtI, pAtK, rt, en, sl, tp, rr, disc };
  };
  return { atr, trend, L: side(1), S: side(-1) };
}

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function compare(label, W) {
  const A = analyze(W, 4, 2), js = coachState(W, A, 0), pine = runPine(W);
  assert.ok(near(pine.atr.at(-1), A.atr.at(-1)), `${label}：ATR`);
  assert.equal(pine.trend, A.trend[W.length - 1], `${label}：外部結構趨勢`);
  const tally = [];
  for (const k of ['L', 'S']) {
    const r = js[k], p = pine[k], L = `${label} ${k}`;
    assert.equal(p.stage, r.stage, `${L}：階段`);
    assert.equal(p.disc, r.disc, `${L}：折溢價`);
    if (r.sweep) {
      assert.equal(p.swU, r.sweep.u, `${L}：掃蕩那根`);
      assert.ok(near(p.swP, r.sweep.p) && near(p.ext, r.sweep.ext), `${L}：掃蕩價位／極值`);
    } else assert.equal(p.swU, -1, `${L}：不該有掃蕩`);
    assert.deepEqual(p.ev, r.ev, `${L}：結構轉向`);
    if (r.poi) {
      assert.equal(p.pk, r.poi.kind === 'FVG' ? 1 : 2, `${L}：POI 種類`);
      assert.ok(near(p.pTop, r.poi.top) && near(p.pBot, r.poi.bot), `${L}：POI 上下緣`);
      assert.equal(p.pAtI, r.poi.i, `${L}：POI 那根`);
      assert.equal(p.pAtK, r.poi.k, `${L}：POI 確認那根`);
    } else assert.equal(p.pk, 0, `${L}：不該有 POI`);
    assert.equal(p.rt < 0 ? null : p.rt, r.rt, `${L}：回踩`);
    assert.equal(p.ready, r.ready, `${L}：到位`);
    if (r.ready) {
      for (const f of ['en', 'sl', 'tp', 'rr']) assert.ok(near(p[f], r.plan[f]), `${L}：${f} ${p[f]} vs ${r.plan[f]}`);
    }
    tally.push(r.ready ? 5 : r.stage);
  }
  return tally;
}

test('Pine 教練跟 coach.js：真實 K 棒（BTC／ETH／SOL 1h、15m、4h），每個時間點兩邊劇本完全一樣', () => {
  const seen = [0, 0, 0, 0, 0, 0];
  for (const [name, step] of [['BTC_1h', 7], ['ETH_1h', 11], ['SOL_4h', 5], ['BTC_15m', 13], ['DOGE_15m', 17]]) {
    const C = load(name);
    for (let j = 520, cnt = 0; j < C.length && cnt < 400; j += step, cnt++) {
      for (const s of compare(`${name} #${j}`, C.slice(j - 499, j + 1))) seen[s]++;
    }
  }
  // 確認每個階段都真的有比到，不是全部「沒劇本」剛好一樣
  assert.ok([0, 1, 2, 3, 5].every((k) => seen[k] > 10), `各階段筆數 ${seen.join('/')}`); // 4 = 回踩了但盈虧比算不出來，很少見
});

test('Pine 教練的大週期趨勢跟 Worker 一樣（299 根已收盤、擺動點左右各 3 根）', () => {
  const H = load('BTC_4h');
  const got = new Set();
  for (let j = 300; j < H.length; j += 23) {
    const W = H.slice(j - 299, j);
    const want = structure(W, 3, atrOf(W)).trend[W.length - 1];
    const [, , , , , , , , , , trend] = P.structureOf(W.map((k) => k.h), W.map((k) => k.l), W.map((k) => k.c), 3);
    assert.equal(trend, want, `#${j}`);
    got.add(trend);
  }
  assert.ok(got.has(1) && got.has(-1), '多空都有比到');
});

test('Pine 教練的時段跟 src/smc/sessions.js 一樣', () => {
  const ids = ['asia', 'london', 'nyam', 'nypm'];
  for (let m = 0; m < 24 * 60; m += 5) {
    const ts = Date.UTC(2026, 9, 14, 0, m);
    const s = sessionOf(ts);
    assert.equal(P.sessOf(ts), s ? ids.indexOf(s.id) + 1 : 0, `UTC ${Math.floor(m / 60)}:${m % 60}`);
  }
  assert.equal(SESSIONS.length, 4);
});
