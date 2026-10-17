#!/usr/bin/env node
/** coach-improve2 分析：週期 × 進場 × 停損 × 出場 × 篩選 × 同方向上限，兩組前後半都看 */
import fs from 'node:fs';

const G = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const allAtr = G.flatMap((g) => g.sigs.map((s) => s.atrPct)).sort((a, b) => a - b), atrMed = allAtr[allAtr.length >> 1];
const FILTERS = {
  '全部': () => true, '順勢': (s) => s.bias === 2, '1h同向': (s) => s.h1 === 1, 'BTC同向': (s) => s.btc === 1, 'BTC逆向': (s) => s.btc === -1,
  '不在亞洲': (s) => s.sess !== 'asia', '波動大': (s) => s.atrPct >= atrMed, '波動小': (s) => s.atrPct < atrMed, 'FVG': (s) => s.kind === 'FVG',
  '≥1.5R': (s) => s.rr >= 1.5, '停損≥1.5ATR': (s) => s.stopAtr >= 1.5, '順勢+1h同向': (s) => s.bias === 2 && s.h1 === 1, '順勢+BTC同向': (s) => s.bias === 2 && s.btc === 1,
};
const IVS = ['15m', '30m', '1h', '2h', '4h', '1h+2h', '1h+2h+4h', '30m+1h+2h'];
const ivOk = (iv, s) => iv.split('+').includes(s.iv);
const KEYS = [];
for (const e of ['E', 'M', 'K']) for (const st of ['P', 'W']) for (const ex of ['S', 'T1', 'T15', 'T2', 'P']) KEYS.push(e + st + ex);

function pick(sigs, key, cap) {
  const list = sigs.filter((s) => s.res[key]).sort((a, b) => a.res[key][2] - b.res[key][2]);
  const busy = {}, open = [], out = [];
  for (const s of list) {
    const [r, end, t] = s.res[key], k = s.sym + s.iv;
    if ((busy[k] || 0) > t) continue;
    if (cap) { for (let i = open.length - 1; i >= 0; i--) if (open[i].end <= t) open.splice(i, 1); if (open.filter((o) => o.dir === s.dir).length >= cap) continue; }
    busy[k] = end; open.push({ dir: s.dir, end }); out.push({ r, t });
  }
  return out;
}
const avg = (l) => (l.length ? l.reduce((a, x) => a + x.r, 0) / l.length : 0);
const rows = [];
for (const iv of IVS) for (const [fn, f] of Object.entries(FILTERS)) for (const key of KEYS) for (const cap of [0, 3]) {
  const cells = G.map((g) => {
    const l = pick(g.sigs.filter((s) => ivOk(iv, s) && f(s)), key, cap), mid = g.from + (Date.parse(g.generatedAt) - g.from) / 2;
    return { n: l.length, a: avg(l), w: l.filter((x) => x.r > 0).length / (l.length || 1), h1: avg(l.filter((x) => x.t < mid)), h2: avg(l.filter((x) => x.t >= mid)), perDay: l.length / g.days };
  });
  if (cells.some((c) => c.n < 40)) continue;
  const four = cells.flatMap((c) => [c.h1, c.h2]);
  rows.push({ iv, fn, key, cap, cells, min: Math.min(...four), mean: cells.reduce((a, c) => a + c.a, 0) / cells.length, pos: four.filter((x) => x > 0).length });
}
const name = (k) => ({ E: '掛邊緣', M: '掛中間', K: '收盤市價' }[k[0]] + '・' + ({ P: '原停損', W: '停損放寬' }[k[1]]) + '・' + ({ S: '結構目標', T1: '1R', T15: '1.5R', T2: '2R', P: '1R平半' }[k.slice(2)]));
const show = (r) => `${r.iv.padEnd(9)} ${r.fn.padEnd(8)} ${name(r.key).padEnd(18)} 上限${r.cap || '無'}｜` + r.cells.map((c, i) => `G${i + 1} ${c.n}筆 ${c.perDay.toFixed(1)}/天 勝${Math.round(c.w * 100)}% ${c.a >= 0 ? '+' : ''}${c.a.toFixed(3)} [${c.h1.toFixed(3)} ${c.h2.toFixed(3)}]`).join('｜') + `｜最差格 ${r.min.toFixed(3)}`;
console.log(`(波動中位數 ATR ${atrMed}% )\n=== 四格都賺，照「最差那格」排序（前 40）===`);
rows.filter((r) => r.pos === 4).sort((a, b) => b.min - a.min).slice(0, 40).forEach((r) => console.log(show(r)));
console.log('\n=== 四格都賺，照「平均」排序、每天至少 1 筆（前 20）===');
rows.filter((r) => r.pos === 4 && r.cells.every((c) => c.perDay >= 1)).sort((a, b) => b.mean - a.mean).slice(0, 20).forEach((r) => console.log(show(r)));
console.log('\n=== 各週期最好的一個（不加篩選、上限無）===');
for (const iv of IVS) { const b = rows.filter((r) => r.iv === iv && r.fn === '全部' && r.cap === 0).sort((a, b) => b.min - a.min)[0]; if (b) console.log(show(b) + `｜四格正 ${b.pos}`); }
console.log(`\n四格都賺的組合共 ${rows.filter((r) => r.pos === 4).length} 個（總共測 ${rows.length} 個）`);
