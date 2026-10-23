/**
 * 劇情：新手交易員拜入道場，跟師父老墨、師姐小鈴學 8 章，每章三關：
 *   ①課程（拿卡、看真實例子、換你答）②試煉（6 題對 5 題）③魔王（3 條命打倒魔王）
 * 打完第 8 章的「莊家」就出師。
 */
import { makeQuestion } from './gen.js';
import { CHAPTERS, CONCEPT } from './concepts.js';
import { recordAnswer, track, unlock, storyKey, chapterUnlocked, drawPack } from './srs.js';
import { runQuestion, $, esc, sfx, modal, el } from './ui.js';
import { createChart } from './chart.js';
import { fmtTime } from './core.js';

const WHO = { mo: { name: '老墨', glyph: '墨' }, ling: { name: '小鈴', glyph: '鈴' }, boss: { name: '', glyph: '魔' }, me: { name: '你', glyph: '我' } };

const SCRIPT = {
  1: {
    intro: [['ling', '你就是新來的？先說好，這裡不教明牌，只教怎麼看懂圖。'], ['mo', '圖上每一個轉折，都是一群人的停損和慾望。先學會找轉折點，再學別的。'], ['me', '轉折點……是最高點跟最低點嗎？'], ['mo', '是「左右都比它低」的高點。記住，要等右邊走出來才算數。']],
    taunt: ['我讓價格上上下下，看你分不分得出方向！', '又看錯了？盤整裡亂進場，就是在送錢。'], win: '……居然看得出我藏起來的高低點。',
  },
  2: {
    intro: [['mo', '高點越來越高、低點越來越高，就是多頭。破了前高，叫 BOS。'], ['ling', '反過來，空頭裡第一次收盤站上前高，叫 CHoCH。很多人在這裡衝進去，然後被打回來。'], ['mo', '所以要看保護點。保護點沒破，故事就還沒結束。']],
    taunt: ['你看，突破了！快追！……騙你的。', '影線刺過去就以為是突破？太嫩了。'], win: '收盤……原來你都在看收盤。',
  },
  3: {
    intro: [['ling', '你知道為什麼價格常常剛好打到你的停損就回頭嗎？'], ['mo', '因為停損都擺在一樣的地方：前高上面、前低下面。那裡就是流動性。'], ['ling', '大資金要買，需要很多人賣。你的停損，就是他的賣單。'], ['mo', '刺破又收回，叫掃流動性。最漂亮的進場點，常常是誘導。']],
    taunt: ['再往下刺一點……你的停損是我的晚餐。', '等高低點？那是我放的誘餌。'], win: '你……開始等我掃完才進場了。',
  },
  4: {
    intro: [['mo', '一口氣推很遠的大 K 棒，叫位移。急著推，代表有人非買不可。'], ['ling', '推得太快會留下空白，三根 K 棒影線沒重疊的地方，就是 FVG。'], ['mo', '價格常回來補這個洞。補的時候，就是進場的機會。被穿過的，就別再用了。']],
    taunt: ['我把價格吸過去，又吐回來！', '這個缺口早就補完了，你還在等？'], win: '缺口……被你看穿了。',
  },
  5: {
    intro: [['ling', '大資金不會一次買完，他會在某個區域慢慢吃貨，然後才推。'], ['mo', '推之前最後一根反方向的 K 棒，叫訂單塊。收盤穿過它，它就失效，甚至反過來變成壓力。']],
    taunt: ['我在這裡吃了好多貨，你看得出來嗎？', '失效的 OB 你還敢做多？'], win: '我的建倉位置……全被你標出來了。',
  },
  6: {
    intro: [['mo', '好單要在好位置。區間下半部便宜，上半部貴。多單在便宜的地方找。'], ['ling', '還要看大週期。4h 空頭時，15 分鐘的反彈多半只是反彈。'], ['mo', '時間也重要。倫敦、紐約開盤時，常常先掃亞洲盤的高低點。']],
    taunt: ['現在幾點？你連時段都分不清楚。', '在溢價區追多？謝謝你的錢。'], win: '時間和位置……你都對了。',
  },
  7: {
    intro: [['mo', '把前面學的串起來：掃流動性、結構轉向、留下 POI、回踩、計畫。少一步都不進。'], ['ling', '停損放在劇本失效的地方，目標放在對面的流動性。盈虧比算出來太差，再漂亮也不做。'], ['mo', '這五步，就是線上教練用的同一套規則。']],
    taunt: ['第三步就進場了？你跳步驟了。', '停損放這麼近，我抖一下就掃掉了。'], win: '五步……一步都沒漏。',
  },
  8: {
    intro: [['mo', '最後一課，也是最重要的一課：活下來。'], ['ling', '每一單只冒 1～2% 的險。連虧十次也只是小傷。'], ['mo', '想一把翻本的人，最後都在幫莊家付手續費。槓桿不是風險，倉位和停損才是。'], ['boss', '……說完了嗎？讓我看看你能不能守住你的帳戶。']],
    taunt: ['加倍下注啊，你不是很想拼回來嗎？', '150 倍，小資金也能賺大錢喔。'], win: '你不貪，也不怕……我拿你沒辦法。出師吧。',
  },
};

export function renderStory(app) {
  const { save } = app;
  const host = app.view('劇情');
  host.innerHTML = `<div class="story-list"><h1 class="mode-title">劇情</h1><p class="mode-desc">拜師學藝，一章三關：課程、試煉、魔王。打倒第 8 章的莊家就出師。</p>
  ${CHAPTERS.map((c) => {
    const open = chapterUnlocked(save, c.n);
    const done = [1, 2, 3].filter((s) => save.story.done[storyKey(c.n, s)]).length;
    return `<button class="chapter ${open ? '' : 'locked'} ${done === 3 ? 'clear' : ''}" data-n="${c.n}" ${open ? '' : 'disabled'}>
      <span class="ch-n">${c.n}</span><span class="ch-body"><b>${esc(c.title)}</b><small>${open ? c.cards.map((id) => CONCEPT[id].name).join('、') : '打倒上一章魔王後解鎖'}</small></span>
      <span class="ch-prog">${[1, 2, 3].map((s) => `<i class="${save.story.done[storyKey(c.n, s)] ? 'on' : ''}"></i>`).join('')}</span></button>`;
  }).join('')}</div>`;
  host.querySelector('.story-list').onclick = (e) => { const b = e.target.closest('.chapter'); if (b && !b.disabled) chapter(app, +b.dataset.n); };
}

function chapter(app, n) {
  const { save } = app;
  const c = CHAPTERS.find((x) => x.n === n);
  const host = app.view('劇情', true);
  const st = (s) => save.story.done[storyKey(n, s)];
  const stages = [['課程', '拿到本章的概念卡，看真實例子'], ['試煉', '6 題答對 5 題'], ['魔王', `打倒「${c.boss}」`]];
  host.innerHTML = `<div class="chapter-page"><p class="ch-kicker">第 ${n} 章</p><h1 class="mode-title">${esc(c.title)}</h1>
    <div class="stages">${stages.map(([t, d], i) => { const s = i + 1, open = s === 1 || st(s - 1); return `<button class="stage ${st(s) ? 'clear' : ''}" data-s="${s}" ${open ? '' : 'disabled'}><b>${t}</b><small>${esc(d)}</small><span>${st(s) ? '已通過' : open ? '開始' : '未解鎖'}</span></button>`; }).join('')}</div>
    <button class="btn ghost" id="back">回章節列表</button></div>`;
  host.querySelector('.stages').onclick = (e) => { const b = e.target.closest('.stage'); if (!b || b.disabled) return; const s = +b.dataset.s; (s === 1 ? lesson : s === 2 ? trial : boss)(app, n); };
  $('#back', host).onclick = () => renderStory(app);
}

async function talk(app, lines, bossName) {
  const host = app.view('劇情', true);
  for (const [who, text] of lines) {
    const w = WHO[who];
    host.innerHTML = `<div class="dialog"><div class="speaker ${who}"><span class="sp-glyph">${who === 'boss' ? '魔' : w.glyph}</span><b>${esc(who === 'boss' ? bossName : w.name)}</b></div><p class="line">${esc(text)}</p><button class="btn primary next">繼續</button></div>`;
    sfx.tick();
    await new Promise((r) => { $('.next', host).onclick = r; });
  }
}

function done(app, n, s) {
  const k = storyKey(n, s);
  if (!app.save.story.done[k]) { app.save.story.done[k] = true; app.celebrate({ missions: track(app.save, 'story', 1) }); }
  app.persist();
}

async function lesson(app, n) {
  const { save, rng } = app;
  const c = CHAPTERS.find((x) => x.n === n);
  await talk(app, SCRIPT[n].intro, c.boss);
  for (const id of c.cards) {
    const k = CONCEPT[id];
    const fresh = unlock(save, id);
    app.persist();
    // 拿卡
    sfx.stamp();
    await modal(`<div class="card-reveal">${app.cardFace(id)}</div><p class="card-def">${esc(k.short)}</p><ul class="pts">${k.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${fresh ? '<p class="new-card">新卡入手</p>' : ''}`, [{ label: '看真實例子', value: true, primary: true }]);
    // 示範：一張真實圖，直接把答案畫出來
    const host = app.view('劇情', true);
    host.innerHTML = '<div class="loading">找一段真實行情…</div>';
    const demo = await makeQuestion(id, { rng, diff: 1, explainRate: 0 });
    if (demo.chart) {
      host.innerHTML = `<div class="demo"><p class="ch-kicker">示範・${esc(k.name)}</p><h2 class="q-prompt">${esc(demo.prompt)}</h2><div class="q-chart"><canvas></canvas><div class="q-meta">${demo.meta.coin}/USDT ${demo.meta.tf}｜${fmtTime(demo.meta.t)}</div></div><p class="why">${esc(demo.why)}</p><button class="btn primary next">換你試試</button></div>`;
      const ch = createChart($('canvas', host), { height: 280 });
      ch.set({ W: demo.chart.W, from: demo.chart.from, to: demo.chart.to, ov: demo.chart.ov, reveal: demo.chart.reveal });
      ch.reveal();
      await new Promise((r) => { $('.next', host).onclick = r; });
      ch.destroy();
    }
    // 換你：一樣的概念、新的一張圖，可以重答一次
    let ok = false;
    while (!ok) {
      host.innerHTML = '<div class="loading">出題中…</div>';
      const q = await makeQuestion(id, { rng, diff: 1, explainRate: 0 });
      let retry = 1;
      const r = await runQuestion(host, q, { canRetry: () => retry-- > 0, onAnswer: (res) => { app.celebrate(recordAnswer(save, q, res.ok)); app.persist(); }, nextLabel: '繼續' });
      ok = r.ok;
      if (!ok) await modal('<p>沒關係，再換一張圖練一次。</p>', [{ label: '再來', value: true, primary: true }]);
    }
  }
  done(app, n, 1);
  await modal(`<h3>第 ${n} 章課程完成</h3><p>試煉已解鎖。今天學的卡，明天會回來考你。</p>`);
  chapter(app, n);
}

async function trial(app, n) {
  const { save, rng } = app;
  const c = CHAPTERS.find((x) => x.n === n);
  const prev = CHAPTERS.filter((x) => x.n < n).flatMap((x) => x.cards);
  const host = app.view('劇情', true);
  let ok = 0, combo = 0;
  for (let i = 1; i <= 6; i++) {
    const id = prev.length && rng.chance(0.3) ? rng.pick(prev) : rng.pick(c.cards);
    host.innerHTML = '<div class="loading">出題中…</div>';
    const q = await makeQuestion(id, { rng, diff: 2, explainRate: 0.2 });
    await runQuestion(host, q, {
      top: `<div class="trial-hud">試煉 ${i}／6　答對 ${ok}　需要 5 題</div>`, combo,
      onAnswer: (res) => { if (res.ok) { ok++; combo++; } else combo = 0; app.celebrate(recordAnswer(save, q, res.ok, { combo })); app.persist(); },
      nextLabel: i === 6 ? '看結果' : '下一題',
    });
    if (i - ok > 1) break;
  }
  if (ok >= 5) { done(app, n, 2); sfx.level(); await modal(`<h3>試煉通過</h3><p>答對 ${ok} 題。魔王「${esc(c.boss)}」在等你。</p>`); }
  else await modal(`<h3>試煉沒過</h3><p>錯了 2 題以上。答錯的概念已經排進複習，再挑戰一次吧。</p>`);
  chapter(app, n);
}

async function boss(app, n) {
  const { save, rng } = app;
  const c = CHAPTERS.find((x) => x.n === n), S = SCRIPT[n];
  const all = CHAPTERS.filter((x) => x.n <= n).flatMap((x) => x.cards);
  let bhp = 6, lives = 3, combo = 0;
  await talk(app, [['boss', S.taunt[0]]], c.boss);
  const host = app.view('劇情', true);
  const top = () => `<div class="boss-hud"><div class="monster boss"><div class="m-glyph">魔</div><div><div class="m-name">${esc(c.boss)}</div><div class="m-hp">${'<i class="on"></i>'.repeat(bhp)}${'<i></i>'.repeat(6 - bhp)}</div></div></div><div class="lives">${'<i class="on"></i>'.repeat(lives)}${'<i></i>'.repeat(3 - lives)}</div></div>`;
  while (bhp > 0 && lives > 0) {
    const id = rng.chance(0.6) ? rng.pick(c.cards) : rng.pick(all);
    host.innerHTML = '<div class="loading">魔王出招中…</div>';
    const q = await makeQuestion(id, { rng, diff: 3, explainRate: 0.15 });
    await runQuestion(host, q, {
      timer: q.kind === 'pick' ? 40 : 30, top: top(), combo,
      onAnswer: (res) => {
        if (res.ok) { combo++; bhp = Math.max(0, bhp - (combo >= 3 ? 2 : 1)); app.flash('hit-mon'); }
        else { combo = 0; lives--; sfx.hit(); app.flash('hit-me'); }
        app.celebrate(recordAnswer(save, q, res.ok, { combo }));
        app.persist();
        const h = host.querySelector('.q-hud'); if (h) h.innerHTML = top();
      },
      extra: (res) => (res.ok ? '' : `<p class="taunt">「${esc(rng.pick(S.taunt))}」</p>`),
      nextLabel: '繼續', auto: 900,
    });
  }
  if (bhp <= 0) {
    app.confetti(); sfx.level();
    const first = !save.story.done[storyKey(n, 3)];
    done(app, n, 3);
    let reward = '';
    if (first) { const p = drawPack(save, rng, Date.now(), 40); app.persist(); reward = `<p>銅錢 +${p.coins}${p.card ? `，抽到「${esc(CONCEPT[p.card].name)}」卡` : ''}</p>`; }
    await talk(app, [['boss', S.win]], c.boss);
    await modal(`<h3>打倒 ${esc(c.boss)}！</h3>${reward}${n < 8 ? `<p>第 ${n + 1} 章解鎖了。</p>` : '<p>你出師了。之後的路，靠每天的複習和闖關。</p>'}`);
  } else {
    await modal(`<h3>被 ${esc(c.boss)} 打敗了</h3><p>三條命都用完了。答錯的概念已經排進複習。</p>`, [{ label: '再挑戰', value: true, primary: true }]);
  }
  chapter(app, n);
}

export { el };
