/** 道場 2.0 主程式：存檔、分頁、首頁（每日）、複習、圖鑑 */
import { makeRng, todayKey } from './core.js';
import { CONCEPTS, CONCEPT, RARITY, CHAPTERS } from './concepts.js';
import { makeQuestion } from './gen.js';
import {
  freshSave, rollDay, dueCards, recordAnswer, openChest, stars, ink, levelOf, xpFor, card, pickConcepts,
  tierOf, TIERS, DAILY_GOAL, storyKey, INTERVALS, unlockedIds,
} from './srs.js';
import { runQuestion, $, $$, esc, el, sfx, toast, modal, setFeedback } from './ui.js';
import { renderRogue } from './rogue.js';
import { renderRanked } from './ranked.js';
import { renderStory } from './story.js';

const KEY = 'smc-dojo-v2';
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 2) return { ...freshSave(), ...s }; } catch { /* 沒存檔 */ }
  return freshSave();
}

const app = {
  save: loadSave(),
  rng: makeRng(),
  tab: 'home',
  persist() { try { localStorage.setItem(KEY, JSON.stringify(this.save)); } catch { /* 私密模式存不了 */ } },
  /** 換畫面：immersive＝戰鬥／答題，隱藏底部分頁、上面給「離開」 */
  view(title, immersive = false) {
    const main = $('#main');
    document.body.classList.toggle('immersive', immersive);
    $('#topTitle').textContent = immersive ? title : '';
    main.innerHTML = '';
    main.scrollTop = 0; window.scrollTo(0, 0);
    const v = el('<div class="view"></div>');
    main.appendChild(v);
    return v;
  },
  go(tab) {
    this.tab = tab;
    $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ({ home, rogue: renderRogue, ranked: renderRanked, story: renderStory, cards: collection })[tab](this);
    refreshTop();
  },
  /** 答題後的回饋：XP、升級、任務、連續天數 */
  celebrate(out = {}) {
    if (out.lvUp) { sfx.level(); toast(`升到 ${out.lvUp} 級`, 'gold'); }
    (out.missions || []).forEach((m) => { sfx.coin(); toast(`任務完成：${esc(m.text)}`, 'gold'); });
    if (out.streakUp) { sfx.level(); toast(`今天的 ${DAILY_GOAL} 題完成，連續 ${this.save.streak.count} 天`, 'fire'); }
    if (out.lapse) toast('這張卡退回第 1 格，明天再考你', 'dim');
    refreshTop();
  },
  flash(cls) { document.body.classList.add(cls); setTimeout(() => document.body.classList.remove(cls), 380); },
  confetti() {
    const box = el('<div class="confetti"></div>');
    for (let i = 0; i < 46; i++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = ['#E2483D', '#D8B24A', '#ECE6D6', '#3DBB8F'][i % 4];
      p.style.animationDelay = `${Math.random() * 0.4}s`;
      p.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
      p.style.setProperty('--rot', `${Math.random() * 720}deg`);
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 2600);
  },
  cardFace,
};
window.__dojo = app;

/* ---------- 頂部 ---------- */
function refreshTop() {
  const s = app.save, lv = levelOf(s.xp), a = xpFor(lv), b = xpFor(lv + 1);
  $('#lv').textContent = lv;
  $('#xpbar').style.width = `${((s.xp - a) / (b - a)) * 100}%`;
  $('#coins').textContent = s.coins;
  $('#streak').textContent = s.streak.count;
  $('#streakBox').classList.toggle('alive', s.streak.last === todayKey());
}

/* ---------- 卡面 ---------- */
function cardFace(id, { small = false } = {}) {
  const k = CONCEPT[id], c = app.save.cards[id], open = c?.unlocked;
  const lv = stars(c), inkv = ink(c);
  if (!open) return `<div class="kcard locked ${small ? 'sm' : ''}"><span class="kc-glyph">？</span><span class="kc-name">第 ${k.ch} 章</span></div>`;
  return `<div class="kcard ${small ? 'sm' : ''} ${inkv < 0.65 ? 'faded' : ''}" style="--ink:${inkv.toFixed(2)};--rc:${RARITY[k.rarity].color}">
    <span class="kc-rar">${RARITY[k.rarity].name}</span>
    <span class="kc-glyph">${k.glyph}</span>
    <span class="kc-name">${esc(k.name)}</span>
    <span class="kc-seal" title="熟練度">${lv ? '★'.repeat(lv) : '初'}</span>
    ${inkv < 0.65 ? '<span class="kc-fade">墨淡了</span>' : ''}
  </div>`;
}

/* ---------- 首頁 ---------- */
function home() {
  const s = app.save;
  rollDay(s); app.persist();
  const v = app.view('');
  const due = dueCards(s), un = unlockedIds(s);
  const pct = Math.min(1, s.day.ok / DAILY_GOAL);
  const allDone = s.day.missions.length && s.day.missions.every((m) => m.done);
  const t = TIERS[tierOf(s.ranked.lp)];
  const chDone = CHAPTERS.filter((c) => s.story.done[storyKey(c.n, 3)]).length;
  const R = 46, circ = 2 * Math.PI * R;
  v.innerHTML = `
  ${!un.length ? `<section class="welcome"><h1>歡迎來到 SMC 道場</h1><p>這裡的每一題都是真實歷史 K 線，由線上教練同一套規則判對錯。先去劇情第 1 章拜師，拿到你的第一張卡。</p><button class="btn primary big" data-go="story">拜師去</button></section>` : ''}
  <section class="today">
    <svg class="ring" viewBox="0 0 110 110"><circle cx="55" cy="55" r="${R}" class="ring-bg"/><circle cx="55" cy="55" r="${R}" class="ring-fg" style="stroke-dasharray:${circ};stroke-dashoffset:${circ * (1 - pct)}"/></svg>
    <div class="today-txt"><b>${Math.min(s.day.ok, DAILY_GOAL)}<small>／${DAILY_GOAL}</small></b><span>${s.day.ok >= DAILY_GOAL ? `今天練過了，連續 ${s.streak.count} 天` : `今天再答對 ${DAILY_GOAL - s.day.ok} 題，${s.streak.count ? `保住連續 ${s.streak.count} 天` : '開始連續天數'}`}</span>
    ${s.streak.freeze ? `<em>免斷符 ×${s.streak.freeze}（斷一天自動補）</em>` : ''}</div>
  </section>
  <section class="review">
    ${due.length ? `<div class="stack">${due.slice(0, 3).map((id) => cardFace(id, { small: true })).join('')}</div>
      <div class="rv-txt"><b>${due.length} 張卡到期了</b><span>每張換一張新的真實圖考你。答錯會退回第 1 格，明天再來。</span></div>
      <button class="btn primary big" id="doReview">開始複習</button>`
    : `<div class="rv-txt"><b>${un.length ? '今天的卡都複習完了' : '還沒有卡'}</b><span>${un.length ? '想多練就挑最弱的 10 題，或去闖關。' : '劇情第 1 章會給你前兩張卡。'}</span></div>
      ${un.length ? '<button class="btn big" id="doWeak">練最弱的 10 題</button>' : ''}`}
  </section>
  <section class="missions"><h2 class="sec-title">今日任務</h2>
    ${s.day.missions.map((m) => `<div class="mission ${m.done ? 'done' : ''}"><span class="m-txt">${esc(m.text)}</span><span class="m-prog">${m.prog}/${m.goal}</span><div class="bar"><i style="width:${(m.prog / m.goal) * 100}%"></i></div></div>`).join('')}
    <button class="chest ${allDone && !s.day.chest ? 'ready' : ''} ${s.day.chest ? 'opened' : ''}" id="chest" ${allDone && !s.day.chest ? '' : 'disabled'}>${s.day.chest ? '今天的寶箱開過了' : allDone ? '打開每日寶箱' : '三個任務都完成，開每日寶箱'}</button>
  </section>
  <section class="modes3">
    <button class="mtile rogue" data-go="rogue"><b>闖</b><span>闖關</span><small>${s.rogue.cur ? `第 ${s.rogue.cur.floor} 層進行中` : `最深 ${s.rogue.best || 0} 層`}</small></button>
    <button class="mtile ranked" data-go="ranked" style="--tc:${t.color}"><b>戰</b><span>排位</span><small>${t.name} ${s.ranked.lp} 分</small></button>
    <button class="mtile story" data-go="story"><b>師</b><span>劇情</span><small>${chDone}／8 章</small></button>
  </section>
  <p class="foot">題目用 Binance 真實歷史 K 線，SMC 判斷規則跟線上教練同一套。不構成投資建議。<button class="link" id="settings">設定</button></p>`;
  v.onclick = (e) => { const g = e.target.closest('[data-go]'); if (g) app.go(g.dataset.go); };
  const rv = $('#doReview', v); if (rv) rv.onclick = () => session(due.slice(), { title: '複習', review: true });
  const wk = $('#doWeak', v); if (wk) wk.onclick = () => session(pickConcepts(s, 10, app.rng), { title: '加強練習' });
  $('#chest', v).onclick = async () => {
    const r = openChest(s, app.rng); if (!r) return;
    app.persist(); sfx.coin(); app.confetti();
    await modal(`<h3>每日寶箱</h3>${r.card ? `<div class="card-reveal">${cardFace(r.card)}</div><p>抽到「${esc(CONCEPT[r.card].name)}」</p>` : ''}<p>銅錢 +${r.coins}</p>`);
    home();
  };
  $('#settings', v).onclick = settings;
}

/* ---------- 練習／複習一輪 ---------- */
async function session(ids, { title, review = false }) {
  const s = app.save;
  const queue = ids.slice(), wrongOnce = new Set();
  let ok = 0, n = 0, combo = 0;
  const v = app.view(title, true);
  while (queue.length) {
    const id = queue.shift();
    v.innerHTML = '<div class="loading">從真實行情出題…</div>';
    const c = card(s, id);
    let q;
    try { q = await makeQuestion(id, { rng: app.rng, diff: Math.min(5, 1 + Math.max(0, c.box - 1)), explainRate: 0.2 }); } catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    n++;
    const r = await runQuestion(v, q, {
      top: `<div class="trial-hud">${esc(title)}　剩 ${queue.length + 1} 題　連對 ${combo}</div>`, combo,
      onAnswer: (res) => {
        combo = res.ok ? combo + 1 : 0;
        app.celebrate(recordAnswer(s, q, res.ok, { combo, review }));
        app.persist();
      },
    });
    if (r.ok) ok++;
    else if (!wrongOnce.has(id)) { wrongOnce.add(id); queue.push(id); } // 答錯的這輪最後再考一次
  }
  sfx.level();
  await modal(`<h3>${esc(title)}完成</h3><p>${n} 題答對 ${ok} 題。</p>${wrongOnce.size ? `<p class="lesson">答錯過的：${[...wrongOnce].map((x) => esc(CONCEPT[x].name)).join('、')}。它們明天會再出現。</p>` : ''}`);
  app.go('home');
}

/* ---------- 圖鑑 ---------- */
function collection() {
  const s = app.save;
  const v = app.view('');
  const got = unlockedIds(s).length;
  v.innerHTML = `<h1 class="mode-title">圖鑑</h1><p class="mode-desc">${got}／${CONCEPTS.length} 張。太久沒複習，卡上的墨會慢慢變淡；複習答對，墨就回來。印章上的星星是熟練度。</p>
    ${CHAPTERS.map((c) => `<h2 class="sec-title">第 ${c.n} 章・${esc(c.title)}</h2><div class="kgrid">${c.cards.map((id) => `<button class="kslot" data-id="${id}">${cardFace(id)}</button>`).join('')}</div>`).join('')}`;
  v.onclick = (e) => { const b = e.target.closest('.kslot'); if (b) detail(b.dataset.id); };
}

async function detail(id) {
  const s = app.save, k = CONCEPT[id], c = s.cards[id];
  if (!c?.unlocked) { await modal(`<h3>還沒拿到這張卡</h3><p>第 ${k.ch} 章的課程、每日寶箱、或在闖關／排位裡遇到它答對，都會拿到。</p>`); return; }
  const next = c.due > Date.now() ? `${Math.ceil((c.due - Date.now()) / 864e5)} 天後` : '現在（已到期）';
  const v = await modal(`<div class="card-reveal">${cardFace(id)}</div><p class="card-def">${esc(k.short)}</p><ul class="pts">${k.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <p class="kstat">答過 ${c.seen} 次、答對 ${c.ok} 次、忘記 ${c.lapses} 次　第 ${c.box} 格（間隔 ${INTERVALS[c.box]} 天）　下次複習：${next}</p>`,
  [{ label: '練這張 5 題', value: 'drill', primary: true }, { label: '關閉', value: null }]);
  if (v === 'drill') session([id, id, id, id, id], { title: `練「${k.name}」` });
}

/* ---------- 設定 ---------- */
async function settings() {
  const s = app.save;
  const v = await modal(`<h3>設定</h3><p>音效：${s.settings.sound ? '開' : '關'}　震動：${s.settings.haptics ? '開' : '關'}</p><p class="lesson">存檔只在這台手機的瀏覽器裡。清除網站資料會讓進度消失。</p>`, [
    { label: `音效${s.settings.sound ? '關掉' : '打開'}`, value: 'sound' }, { label: `震動${s.settings.haptics ? '關掉' : '打開'}`, value: 'hap' },
    { label: '全部重來', value: 'reset' }, { label: '完成', value: null, primary: true },
  ]);
  if (v === 'sound') s.settings.sound = !s.settings.sound;
  if (v === 'hap') s.settings.haptics = !s.settings.haptics;
  if (v === 'reset' && (await modal('<h3>確定全部重來？</h3><p>卡牌、段位、紀錄都會清空，不能復原。</p>', [{ label: '取消', value: false }, { label: '清空', value: true, primary: true }]))) app.save = freshSave();
  setFeedback(s.settings); app.persist();
  if (v) settings(); else home();
}

/* ---------- 啟動 ---------- */
function boot() {
  setFeedback(app.save.settings);
  $('.tabbar').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) app.go(b.dataset.tab); };
  $('#leave').onclick = async () => {
    if (await modal('<h3>離開這一輪？</h3><p>已經答完的題目都有記錄。闖關進度會保留，下次可以繼續。</p>', [{ label: '留下', value: false }, { label: '離開', value: true, primary: true }])) app.go(app.tab);
  };
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  app.go('home');
}
boot();
