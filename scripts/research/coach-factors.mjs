#!/usr/bin/env node
/** 教練劇本紀錄（/coach-live）依條件分組：週期、方向、順逆勢、位置、時段、盈虧比、POI。stdin 吃 /coach-live 的 JSON */
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const j = JSON.parse(s);
  const t = j.done.filter((x) => !x.rule && !(x.late > 2) && x.r != null);
  const avg = (l) => (l.length ? l.reduce((a, x) => a + x.r, 0) / l.length : 0);
  const line = (name, key) => {
    const g = {};
    for (const x of t) (g[key(x)] ??= []).push(x);
    return `${name}：` + Object.entries(g).sort().map(([k, l]) => `${k} ${l.length}筆 勝${Math.round(l.filter((x) => x.r > 0).length / l.length * 100)}% 平均${avg(l) >= 0 ? '+' : ''}${avg(l).toFixed(2)}R`).join('｜');
  };
  const tpe = (sec) => new Date(sec * 1000 + 8 * 3600e3).toISOString().slice(5, 10);
  const L = [
    `教練劇本紀錄 ${t.length} 筆（${t.length ? tpe(Math.min(...t.map((x) => x.rtT))) : ''} 起）勝${Math.round(t.filter((x) => x.r > 0).length / t.length * 100)}% 合計 ${t.reduce((a, x) => a + x.r, 0).toFixed(2)}R`,
    line('週期', (x) => x.iv), line('方向', (x) => (x.side === 'L' ? '多' : '空')), line('順逆勢', (x) => ['逆勢', '未定', '順勢'][x.bias]),
    line('位置對（多在折價／空在溢價）', (x) => (x.disc ? '對' : '不對')), line('掃蕩時段', (x) => x.sess || '-'), line('回踩時段', (x) => x.sessEntry || '-'),
    line('盈虧比', (x) => (x.rr < 1 ? '<1' : x.rr < 1.5 ? '1-1.5' : x.rr < 2 ? '1.5-2' : x.rr < 3 ? '2-3' : '3+')), line('POI', (x) => x.kind || '-'),
    line('出場', (x) => x.out),
  ];
  for (const l of L) console.log(l);
  const enc = (x) => x.replace(/%/g, '%25').replace(/\n/g, '%0A');
  console.log(`::notice title=教練紀錄分組::${enc(L.join('\n'))}`);
});
