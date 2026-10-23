/**
 * 闖關（Roguelike）：帳戶就是血量，一層一層往下打。答對＝出手打怪，答錯＝怪打你（帳戶扣 %）。
 * 每 5 層一隻魔王；越深：題目越難、限時越短、扣得越多。爆倉就從頭來，留下最佳紀錄。
 * 途中抽遺物（被動）和道具（消耗品），遇到「事件」會考你會不會賭。
 */
import { makeQuestion } from './gen.js';
import { CHAPTERS, CONCEPT } from './concepts.js';
import { recordAnswer, track, pickConcepts } from './srs.js';
import { runQuestion, el, esc, $, sfx, toast, modal } from './ui.js';
import { clamp } from './core.js';

export const RELICS = {
  compound: { name: '複利', glyph: '複', text: '每打倒一隻怪，帳戶上限 +6%，並補回同樣的量' },
  leverage: { name: '三倍槓桿', glyph: '槓', text: '答對傷害 ×2，答錯扣血 ×1.5' },
  calm: { name: '冷靜', glyph: '靜', text: '每場戰鬥第一次答錯，扣血減半' },
  hedge: { name: '對沖', glyph: '沖', text: '單次扣血最多扣帳戶上限的 10%' },
  sniper: { name: '狙擊手', glyph: '狙', text: '點圖題答對多打 1 下' },
  patience: { name: '耐心', glyph: '耐', text: '每題多 8 秒' },
  rebound: { name: '回本術', glyph: '回', text: '連對 3 題，回復帳戶上限 4%' },
  scholar: { name: '筆記', glyph: '記', text: '說法題一出現就先刪掉 1 個錯的' },
};
export const TOOLS = {
  eliminate: { name: '刪去法', text: '刪掉 2 個錯的選項（選擇題）' },
  time: { name: '慢動作', text: '這題多 12 秒' },
  retry: { name: '時光倒流', text: '答錯時自動重答一次' },
  shield: { name: '停損盾', text: '擋掉下一次扣血' },
};
const MONSTERS = ['盤整鬼', '雜訊蟲', '假突破獸', '插針妖', '追高客', '凹單鬼', '情緒獸', '滑價蛇', '爆量怪', '空頭軍'];
const BOSSES = { 5: '假突破獸王', 10: '插針妖后', 15: '誘多大師', 20: '莊家' };
const GL = { 盤整鬼: '盤', 雜訊蟲: '雜', 假突破獸: '假', 插針妖: '針', 追高客: '追', 凹單鬼: '凹', 情緒獸: '躁', 滑價蛇: '滑', 爆量怪: '量', 空頭軍: '空', 假突破獸王: '假', 插針妖后: '針', 誘多大師: '誘', 莊家: '莊' };

const diffOf = (f) => clamp(1 + Math.floor((f - 1) / 3), 1, 5);
const timerOf = (f, run) => (f <= 2 ? null : Math.max(14, 42 - f * 2) + (run.relics.includes('patience') ? 8 : 0));
const dmgPct = (f, kind) => (5 + f * 0.9) * (kind === 'boss' ? 1.5 : kind === 'elite' ? 1.25 : 1);
function poolFor(f) {
  const maxCh = f <= 4 ? 2 : f <= 9 ? 4 : f <= 14 ? 6 : 8;
  return CHAPTERS.filter((c) => c.n <= maxCh).flatMap((c) => c.cards);
}

export function newRun(rng) {
  return { floor: 1, hp: 1000, max: 1000, gold: 0, relics: [], tools: { eliminate: 1, time: 0, retry: 0, shield: 0 }, kills: 0, answered: 0, ok: 0, doors: null, seed: Math.floor(rng() * 1e9) };
}
function doorsFor(run, rng) {
  const f = run.floor;
  if (f % 5 === 0) return [{ kind: 'boss' }];
  const pool = [['fight', 50], ['elite', f >= 3 ? 16 : 0], ['rest', f >= 2 ? 12 : 0], ['shop', f >= 2 ? 12 : 0], ['event', 12]];
  const pickOne = () => { let x = rng() * pool.reduce((a, p) => a + p[1], 0); for (const [k, w] of pool) { x -= w; if (x <= 0) return k; } return 'fight'; };
  const n = rng.chance(0.5) ? 3 : 2, out = [];
  while (out.length < n) { const k = pickOne(); if (!out.some((d) => d.kind === k) || k === 'fight') out.push({ kind: k }); }
  if (!out.some((d) => d.kind === 'fight' || d.kind === 'elite')) out[0] = { kind: 'fight' };
  return out;
}
const DOOR = {
  fight: { name: '戰鬥', glyph: '鬥', text: '一般怪，打完拿籌碼和獎勵' },
  elite: { name: '精英', glyph: '精', text: '比較難，掉遺物' },
  rest: { name: '休息', glyph: '憩', text: '回血或冥想抽遺物' },
  shop: { name: '商店', glyph: '市', text: '用籌碼買道具' },
  event: { name: '事件', glyph: '？', text: '不知道會遇到什麼' },
  boss: { name: '魔王', glyph: '王', text: '打贏才能往下走' },
};

export function renderRogue(app) {
  const { save } = app;
  const host = app.view('闖關');
  const cur = save.rogue.cur;
  host.innerHTML = `<div class="mode-lobby">
    <div class="lobby-art rogue-art"><span>闖</span></div>
    <h1 class="mode-title">闖關</h1>
    <p class="mode-desc">帳戶 $1,000 就是你的血量。答對出手打怪，答錯被怪打。每 5 層一隻魔王，越往下題目越難、時間越短。爆倉就從第 1 層重來。</p>
    <div class="stat-row"><div><b>${save.rogue.best || 0}</b><span>最深紀錄（層）</span></div><div><b>${save.rogue.runs || 0}</b><span>挑戰次數</span></div><div><b>${save.rogue.kills || 0}</b><span>打倒的怪</span></div></div>
    ${cur ? `<button class="btn primary big" id="cont">繼續第 ${cur.floor} 層（帳戶 $${Math.round(cur.hp)}）</button><button class="btn ghost" id="new">放棄這局，重新開始</button>` : '<button class="btn primary big" id="new">開始闖關</button>'}
  </div>`;
  if (cur) $('#cont', host).onclick = () => map(app, cur);
  $('#new', host).onclick = async () => {
    if (cur && !(await modal('<h3>放棄這一局？</h3><p>目前的進度會消失。</p>', [{ label: '算了', value: false }, { label: '放棄', value: true, primary: true }]))) return;
    const run = newRun(app.rng);
    save.rogue.cur = run; save.rogue.runs++; app.persist();
    await pickRelic(app, run, '出發前，選一個遺物帶著');
    map(app, run);
  };
}

function hud(run) {
  const pct = clamp(run.hp / run.max, 0, 1) * 100;
  const tl = Object.entries(run.tools).filter(([, n]) => n).map(([k, n]) => `${TOOLS[k].name}×${n}`).join('、');
  return `<div class="run-hud">
    <div class="acct"><span>帳戶</span><b>$${Math.max(0, Math.round(run.hp)).toLocaleString('en-US')}</b><div class="bar"><i style="width:${pct}%" class="${pct < 30 ? 'low' : ''}"></i></div></div>
    <div class="floor"><span>第</span><b>${run.floor}</b><span>層</span></div>
  </div>
  <div class="relics">${run.relics.map((r) => `<span class="relic" title="${esc(RELICS[r].text)}">${RELICS[r].glyph}</span>`).join('')}${tl ? `<span class="tools-txt">${tl}</span>` : ''}<span class="gold">籌碼 ${run.gold}</span></div>`;
}

function map(app, run) {
  const host = app.view('闖關', true);
  if (!run.doors) { run.doors = doorsFor(run, app.rng); app.persist(); }
  host.innerHTML = `${hud(run)}<div class="doors-wrap"><h2 class="sec-title">第 ${run.floor} 層，選一條路</h2><div class="doors">${run.doors.map((d, i) => `<button class="door door-${d.kind}" data-i="${i}"><b>${DOOR[d.kind].glyph}</b><span>${DOOR[d.kind].name}</span><small>${DOOR[d.kind].text}</small></button>`).join('')}</div></div>`;
  host.querySelector('.doors').onclick = (e) => {
    const b = e.target.closest('.door'); if (!b) return;
    const d = run.doors[+b.dataset.i];
    if (d.kind === 'fight' || d.kind === 'elite' || d.kind === 'boss') battle(app, run, d.kind);
    else if (d.kind === 'rest') rest(app, run);
    else if (d.kind === 'shop') shop(app, run);
    else event(app, run);
  };
}

function nextFloor(app, run) {
  run.floor++; run.doors = null;
  app.save.rogue.best = Math.max(app.save.rogue.best || 0, run.floor);
  app.celebrate({ missions: track(app.save, 'rogue', run.floor) });
  app.persist();
  map(app, run);
}

function hurt(run, amount) {
  if (run.tools.shield > 0) { run.tools.shield--; toast('停損盾擋下了這一擊', 'gold'); return 0; }
  let a = amount;
  if (run.relics.includes('hedge')) a = Math.min(a, run.max * 0.1);
  run.hp -= a;
  return a;
}

async function battle(app, run, kind) {
  const { rng, save } = app;
  const f = run.floor;
  const name = kind === 'boss' ? (BOSSES[f] || `莊家 Lv.${Math.floor(f / 5) - 3}`) : rng.pick(MONSTERS);
  let mhp = kind === 'boss' ? 5 + Math.floor(f / 5) : kind === 'elite' ? 3 + Math.floor(f / 4) : 2 + Math.floor(f / 5);
  const mmax = mhp;
  let combo = 0, calmUsed = false;
  const diff = diffOf(f);
  const pool = poolFor(f);
  const host = app.view('闖關', true);
  const mon = () => `<div class="monster ${kind}"><div class="m-glyph">${GL[name] || '怪'}</div><div><div class="m-name">${esc(name)}${kind === 'boss' ? '（魔王）' : kind === 'elite' ? '（精英）' : ''}</div><div class="m-hp">${'<i class="on"></i>'.repeat(mhp)}${'<i></i>'.repeat(mmax - mhp)}</div></div></div>`;
  while (mhp > 0 && run.hp > 0) {
    const [cid] = pickConcepts(save, 1, rng, Date.now(), pool);
    host.innerHTML = '<div class="loading">讀取行情…</div>';
    let q;
    try { q = await makeQuestion(cid, { rng, diff: clamp(diff + (kind === 'boss' ? 1 : 0), 1, 5), explainRate: 0.15 }); } catch (e) { host.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (q.explain && run.relics.includes('scholar')) q.options = dropOneWrong(q.options);
    const tools = [
      { id: 'eliminate', label: '刪去法', n: run.tools.eliminate, choiceOnly: true, use: (api) => { run.tools.eliminate--; api.eliminate(2); } },
      { id: 'time', label: '慢動作', n: run.tools.time, use: (api) => { run.tools.time--; api.addTime(12); } },
    ];
    let tm = timerOf(f, run);
    if (tm && q.kind === 'pick') tm += 10;
    await runQuestion(host, q, {
      timer: tm, tools, top: hud(run) + mon(), combo,
      canRetry: () => { if (run.tools.retry > 0) { run.tools.retry--; return true; } return false; },
      onAnswer: (res) => {
        run.answered++;
        const out = recordAnswer(save, q, res.ok, { combo: res.ok ? combo + 1 : 0 });
        if (res.ok) {
          run.ok++; combo++;
          let dmg = 1 + (combo >= 4 ? 1 : 0) + (run.relics.includes('sniper') && q.kind === 'pick' ? 1 : 0);
          if (run.relics.includes('leverage')) dmg *= 2;
          mhp = Math.max(0, mhp - dmg);
          if (run.relics.includes('rebound') && combo % 3 === 0) { run.hp = Math.min(run.max, run.hp + run.max * 0.04); toast('回本術：帳戶 +4%', 'gold'); }
          app.flash('hit-mon');
        } else {
          combo = 0;
          let a = run.max * dmgPct(f, kind) / 100;
          if (run.relics.includes('leverage')) a *= 1.5;
          if (run.relics.includes('calm') && !calmUsed) { calmUsed = true; a /= 2; }
          const lost = hurt(run, a);
          if (lost) { sfx.hit(); app.flash('hit-me'); }
        }
        app.celebrate(out);
        app.persist();
        const hudEl = host.querySelector('.q-hud'); if (hudEl) hudEl.innerHTML = hud(run) + mon();
      },
      nextLabel: '繼續',
      auto: 900,
    });
  }
  if (run.hp <= 0) return death(app, run);
  // 打贏
  run.kills++; save.rogue.kills = (save.rogue.kills || 0) + 1;
  const g = kind === 'boss' ? 50 : kind === 'elite' ? 22 : 9;
  run.gold += g;
  if (run.relics.includes('compound')) { const add = Math.round(run.max * 0.06); run.max += add; run.hp += add; }
  sfx.coin();
  app.persist();
  if (kind === 'boss') { app.confetti(); await modal(`<h3>打倒 ${esc(name)}！</h3><p>籌碼 +${g}。帳戶回復 30%。</p>`); run.hp = Math.min(run.max, run.hp + run.max * 0.3); }
  await reward(app, run, kind);
  nextFloor(app, run);
}

function dropOneWrong(opts) { const i = opts.findIndex((o) => !o.ok); return opts.filter((_, k) => k !== i); }

async function reward(app, run, kind) {
  const { rng } = app;
  const choices = [];
  if (kind !== 'fight') { const r = randomRelic(run, rng); if (r) choices.push({ t: 'relic', id: r }); }
  const toolIds = rng.shuffle(Object.keys(TOOLS));
  while (choices.length < 3) { const t = toolIds.shift(); choices.push({ t: 'tool', id: t }); }
  const label = (c) => (c.t === 'relic' ? `遺物「${RELICS[c.id].name}」：${RELICS[c.id].text}` : `道具「${TOOLS[c.id].name}」：${TOOLS[c.id].text}`);
  const pick = await modal(`<h3>戰利品，選一個</h3>`, choices.map((c) => ({ label: label(c), value: c, primary: c.t === 'relic' })));
  if (pick.t === 'relic') run.relics.push(pick.id); else run.tools[pick.id] = (run.tools[pick.id] || 0) + 1;
  app.persist();
}
function randomRelic(run, rng) {
  const left = Object.keys(RELICS).filter((r) => !run.relics.includes(r));
  return left.length ? rng.pick(left) : null;
}
async function pickRelic(app, run, title) {
  const ids = app.rng.shuffle(Object.keys(RELICS).filter((r) => !run.relics.includes(r))).slice(0, 3);
  if (!ids.length) return;
  const id = await modal(`<h3>${esc(title)}</h3>`, ids.map((r) => ({ label: `${RELICS[r].name}：${RELICS[r].text}`, value: r })));
  run.relics.push(id);
  app.persist();
}

async function rest(app, run) {
  const heal = Math.round(run.max * 0.25);
  const c = await modal('<h3>休息站</h3><p>喝杯茶，想一想剛才的單。</p>', [{ label: `回血 $${heal}`, value: 'heal', primary: true }, { label: '冥想：抽一個遺物', value: 'relic' }]);
  if (c === 'heal') run.hp = Math.min(run.max, run.hp + heal); else await pickRelic(app, run, '冥想中看見了…');
  nextFloor(app, run);
}

async function shop(app, run) {
  const items = [
    { id: 'eliminate', price: 15 }, { id: 'time', price: 12 }, { id: 'retry', price: 30 }, { id: 'shield', price: 25 }, { id: 'heal', price: 20 },
  ];
  for (;;) {
    const c = await modal(`<h3>商店</h3><p>籌碼：${run.gold}</p>`, [
      ...items.map((it) => ({ label: it.id === 'heal' ? `回血 15%（${it.price}）` : `${TOOLS[it.id].name}：${TOOLS[it.id].text}（${it.price}）`, value: it })),
      { label: '離開商店', value: null, primary: true },
    ]);
    if (!c) break;
    if (run.gold < c.price) { toast('籌碼不夠'); continue; }
    run.gold -= c.price; sfx.coin();
    if (c.id === 'heal') run.hp = Math.min(run.max, run.hp + run.max * 0.15); else run.tools[c.id]++;
    app.persist();
  }
  nextFloor(app, run);
}

/* 事件：大多是在考你會不會賭（期望值為負的選項看起來都很誘人） */
const EVENTS = [
  {
    title: '群組喊單', text: '有人在群組大喊：「這個幣今晚一定拉 10 倍，All in！」',
    opts: [
      { label: 'All in 跟單', run: (run, rng) => (rng.chance(0.25) ? [run.max * 0.5, '真的拉了！帳戶 +50%。但你知道剛剛那是賭博嗎？'] : [-run.max * 0.45, '被倒貨了，帳戶 −45%。喊單的人早就先買好等你接。']) },
      { label: '不理它，回去看自己的計畫', run: (run) => { run.tools.shield++; return [0, '你拿到一面停損盾。沒有計畫的單，不碰。']; } },
    ],
    lesson: 'All in 跟單：25% 機會 +50%、75% 機會 −45%，期望值 ＝ 0.25×50 − 0.75×45 ＝ −21%。看起來能翻身，其實是在加速爆倉。',
  },
  {
    title: '連虧之後', text: '你剛連虧三筆，心裡很不甘心。下一單要不要加倍下注拼回來？',
    opts: [
      { label: '加倍拼回來', run: (run, rng) => (rng.chance(0.45) ? [run.max * 0.2, '這次贏了，帳戶 +20%。但下次呢？'] : [-run.max * 0.3, '又虧了，帳戶 −30%。情緒單的勝率不會比較高。']) },
      { label: '停下來休息', run: (run) => [run.max * 0.08, '冷靜下來，帳戶回復 8%。'] },
    ],
    lesson: '虧損後加大倉位不會提高勝率，只會讓下一次虧損更痛。職業交易員連虧時反而會縮小倉位。',
  },
  {
    title: '老手的筆記', text: '一位老手把他的交易日誌借你看：「我每一單都只冒 1～2% 的險，停損放在劇本失效的地方。」',
    opts: [{ label: '認真抄下來', run: (run) => { run.tools.retry++; return [0, '你學到了。拿到時光倒流 ×1。']; } }],
    lesson: '活得久才能等到大行情。',
  },
  {
    title: '150 倍槓桿', text: '交易所跳出廣告：「最高 150 倍槓桿，小資金也能賺大錢！」',
    opts: [
      { label: '開 150 倍試試', run: (run, rng) => (rng.chance(0.2) ? [run.max * 0.35, '運氣好賺了 35%。但價格反向不到 0.7% 你就爆倉了。'] : [-run.max * 0.5, '價格抖一下就爆倉了，帳戶 −50%。']) },
      { label: '關掉廣告', run: (run) => { run.gold += 15; return [0, '你省下了手續費，籌碼 +15。']; } },
    ],
    lesson: '150 倍槓桿，價格反向約 0.67% 就把保證金虧光。風險要用停損和倉位控制，不是靠槓桿放大。',
  },
];

async function event(app, run) {
  const ev = app.rng.pick(EVENTS);
  const o = await modal(`<h3>${esc(ev.title)}</h3><p>${esc(ev.text)}</p>`, ev.opts.map((x, i) => ({ label: x.label, value: i, primary: i === ev.opts.length - 1 })));
  const [delta, msg] = ev.opts[o].run(run, app.rng);
  if (delta < 0) { hurt(run, -delta); sfx.hit(); } else if (delta > 0) { run.hp = Math.min(run.max * 1.5, run.hp + delta); sfx.coin(); }
  app.persist();
  await modal(`<p>${esc(msg)}</p><p class="lesson">${esc(ev.lesson)}</p>`, [{ label: '繼續', value: true, primary: true }]);
  if (run.hp <= 0) return death(app, run);
  nextFloor(app, run);
}

async function death(app, run) {
  const { save } = app;
  const coins = run.floor * 5 + run.kills * 2;
  save.coins += coins;
  save.rogue.best = Math.max(save.rogue.best || 0, run.floor);
  save.rogue.cur = null;
  app.persist();
  sfx.bad();
  const host = app.view('闖關', true);
  const acc = run.answered ? Math.round(run.ok / run.answered * 100) : 0;
  host.innerHTML = `<div class="death"><div class="death-stamp">爆倉</div>
    <p>你打到第 <b>${run.floor}</b> 層，打倒 ${run.kills} 隻怪，答對率 ${acc}%。</p>
    <p>最深紀錄：第 ${save.rogue.best} 層。獲得銅錢 ${coins}。</p>
    <p class="lesson">答錯的概念已經排進複習，過幾天會再考你。</p>
    <button class="btn primary big" id="again">再闖一次</button><button class="btn ghost" id="home">回道場</button></div>`;
  $('#again', host).onclick = async () => { const r = newRun(app.rng); save.rogue.cur = r; save.rogue.runs++; app.persist(); await pickRelic(app, r, '出發前，選一個遺物帶著'); map(app, r); };
  $('#home', host).onclick = () => app.go('home');
}

export { CONCEPT };
