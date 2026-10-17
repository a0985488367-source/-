#!/usr/bin/env node
/**
 * coach-improve 結果分析：出場方式 × 篩選條件 × 同方向張數上限，兩組幣、前後半段都看。
 *   node scripts/research/coach-improve-analyze.mjs data/research/coach-improve-g1.json data/research/coach-improve-g2.json
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
const groups = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const FILTERS = {
  '全部（>0R）': () => true,
  '≥1R': (s) => s.rr >= 1,
  '≥1.5R（現在線上）': (s) => s.rr >= 1.5,
  '≥2R': (s) => s.rr >= 2,
  '<1.5R': (s) => s.rr < 1.5,
  '順勢': (s) => s.bias === 2,
  '順勢≥1.5R': (s) => s.bias === 2 && s.rr >= 1.5,
  '逆勢': (s) => s.bias === 0,
  '1h': (s) => s.iv === '1h',
  '30m+1h': (s) => s.iv !== '15m',
  '1h順勢': (s) => s.iv === '1h' && s.bias === 2,
  'FVG': (s) => s.kind === 'FVG',
  'OB': (s) => s.kind === 'OB',
  '掃蕩不在亞洲': (s) => s.sess !== 'asia',
  '停損<1.5ATR': (s) => s.stopAtr < 1.5,
  '停損≥1.5ATR': (s) => s.stopAtr >= 1.5,
};
const CAPS = [0, 2];

/** 照成交時間排，同幣同週期同時只抱一張；cap>0 時全部幣同方向最多 cap 張 */
function pick(sigs, ex, cap) {
  const list = sigs.filter((s) => s.res[ex]).sort((a, b) => a.fillMs - b.fillMs);
  const busy = {}, open = [], out = [];
  for (const s of list) {
    const k = s.sym + s.iv;
    if ((busy[k] || 0) > s.fillMs) continue;
    if (cap) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i].end <= s.fillMs) open.splice(i, 1);
      if (open.filter((o) => o.dir === s.dir).length >= cap) continue;
    }
    const end = s.res[ex][2];
    busy[k] = end; open.push({ dir: s.dir, end }); out.push({ r: s.res[ex][0], t: s.fillMs });
  }
  return out;
}
const st = (l) => {
  if (!l.length) return { n: 0, w: 0, a: 0, pf: 0 };
  const gp = l.filter((x) => x.r > 0).reduce((a, x) => a + x.r, 0), gl = -l.filter((x) => x.r < 0).reduce((a, x) => a + x.r, 0);
  return { n: l.length, w: l.filter((x) => x.r > 0).length / l.length, a: l.reduce((a, x) => a + x.r, 0) / l.length, pf: gl ? gp / gl : 9 };
};
const rows = [];
for (const [fname, f] of Object.entries(FILTERS)) {
  for (const ex of groups[0].exits) {
    for (const cap of CAPS) {
      const cells = groups.map((g) => {
        const l = pick(g.sigs.filter(f), ex, cap), mid = g.from + (Date.parse(g.generatedAt) - g.from) / 2;
        return { all: st(l), a: st(l.filter((x) => x.t < mid)), b: st(l.filter((x) => x.t >= mid)), days: g.days };
      });
      const four = cells.flatMap((c) => [c.a.a, c.b.a]);
      rows.push({ fname, ex, cap, cells, minHalf: Math.min(...four), pos: four.filter((x) => x > 0).length });
    }
  }
}
const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(3);
const show = (r) => `${r.fname.padEnd(12)} ${r.ex.padEnd(4)} 同向上限${r.cap || '無'}｜` + r.cells.map((c, i) => `G${i + 1} ${c.all.n}筆(${(c.all.n / c.days).toFixed(1)}/天) 勝${Math.round(c.all.w * 100)}% ${fmt(c.all.a)}R PF${c.all.pf.toFixed(2)} [前${fmt(c.a.a)} 後${fmt(c.b.a)}]`).join('｜') + `｜四格正 ${r.pos}/4`;
console.log('=== 基準：≥1.5R、原本出場（現在線上）===');
rows.filter((r) => r.fname === '≥1.5R（現在線上）' && r.ex === 'S').forEach((r) => console.log(show(r)));
console.log('\n=== 各出場方式（全部訊號，無上限）===');
rows.filter((r) => r.fname === '全部（>0R）' && r.cap === 0).forEach((r) => console.log(show(r)));
console.log('\n=== 四格（兩組×前後半）都賺的組合，照最差那格排序（前 25）===');
rows.filter((r) => r.pos === 4).sort((a, b) => b.minHalf - a.minHalf).slice(0, 25).forEach((r) => console.log(show(r)));
console.log('\n=== 三格賺的組合（前 15）===');
rows.filter((r) => r.pos === 3).sort((a, b) => b.minHalf - a.minHalf).slice(0, 15).forEach((r) => console.log(show(r)));
