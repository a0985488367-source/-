/**
 * 排位賽：跟 AI 對手同時回答同一組題目（全部是真實行情），答對加分、越快加越多，7 回合比總分。
 * 段位越高，AI 越準越快、題目越難、時間越短。只比「會不會」，不比運氣。
 */
import { makeQuestion } from './gen.js';
import { CHAPTERS } from './concepts.js';
import { recordAnswer, track, TIERS, tierOf, unlockedIds } from './srs.js';
import { runQuestion, $, esc, sfx, modal, countUp } from './ui.js';
import { clamp } from './core.js';

const ROUNDS = 7;
const DIFF = [1, 2, 2, 3, 4, 5, 5];
const TIME = [40, 35, 32, 28, 25, 22, 20];

function poolFor(save, t) {
  const un = unlockedIds(save);
  if (t >= 3) return CHAPTERS.flatMap((c) => c.cards);
  const base = CHAPTERS.filter((c) => c.n <= 2 + t).flatMap((c) => c.cards);
  return [...new Set([...base, ...un])];
}

export function renderRanked(app) {
  const { save } = app;
  const host = app.view('排位');
  const lp = save.ranked.lp, t = tierOf(lp), T = TIERS[t], N = TIERS[t + 1];
  const prog = N ? (lp - T.lp) / (N.lp - T.lp) * 100 : 100;
  const hist = save.ranked.history.slice(-10).map((h) => `<i class="${h.w ? 'w' : 'l'}"></i>`).join('');
  host.innerHTML = `<div class="mode-lobby">
    <div class="tier-badge" style="--tc:${T.color}"><span>${T.name}</span></div>
    <h1 class="mode-title">${T.name}　${lp} 分</h1>
    <div class="lp-bar"><i style="width:${prog}%;background:${T.color}"></i></div>
    <p class="mode-desc">${N ? `再 ${N.lp - lp} 分升上${N.name}。` : '已經是最高段位。'}跟 AI 對手同時回答 7 題真實行情，答對加分、越快越多，最後一題分數加倍。</p>
    <div class="opp"><b>這個段位的對手</b><span>${esc(T.ai)}　答對率約 ${Math.round(T.skill * 100)}%</span></div>
    <div class="stat-row"><div><b>${save.ranked.wins}</b><span>勝</span></div><div><b>${save.ranked.losses}</b><span>敗</span></div><div><b>${TIERS[tierOf(save.ranked.peak || 0)].name}</b><span>最高段位</span></div></div>
    ${hist ? `<div class="hist">${hist}</div>` : ''}
    <button class="btn primary big" id="go">開始對戰</button>
  </div>`;
  $('#go', host).onclick = () => match(app);
}

async function match(app) {
  const { save, rng } = app;
  const t = tierOf(save.ranked.lp), T = TIERS[t];
  const pool = poolFor(save, t);
  const concepts = rng.shuffle(pool).concat(rng.shuffle(pool)).slice(0, ROUNDS);
  let me = 0, ai = 0, combo = 0;
  const host = app.view('排位', true);
  const board = (round, aiState = '') => `<div class="duel"><div class="side me"><span>你</span><b class="sc-me">${me}</b></div><div class="mid">第 ${round}／${ROUNDS} 題${round === ROUNDS ? '（分數 ×2）' : ''}<small class="ai-status">${aiState}</small></div><div class="side ai"><span>${esc(T.ai)}</span><b class="sc-ai">${ai}</b></div></div>`;
  for (let r = 1; r <= ROUNDS; r++) {
    host.innerHTML = board(r) + '<div class="loading">對手在看圖…</div>';
    let q;
    try { q = await makeQuestion(concepts[r - 1], { rng, diff: clamp(DIFF[t] + (r === ROUNDS ? 1 : 0), 1, 5), explainRate: 0.15 }); } catch (e) { host.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const timer = TIME[t] + (q.kind === 'pick' ? 10 : 0);
    // AI 這題答不答得對、花多久：段位越高越準越快；點圖題和難題稍微降低
    const aiOk = rng() < clamp(T.skill - (q.kind === 'pick' ? 0.05 : 0) + (rng() - 0.5) * 0.1, 0.05, 0.98);
    const aiFrac = clamp(0.78 - t * 0.07 + (rng() - 0.5) * 0.3, 0.15, 0.95);
    const aiPts = aiOk ? Math.round((100 + 100 * (1 - aiFrac)) * (r === ROUNDS ? 2 : 1)) : 0;
    const t0 = performance.now();
    let aiTimer = null, gained = 0;
    const p = runQuestion(host, q, {
      timer, top: board(r, '對手思考中…'), combo,
      onAnswer: (res) => {
        clearTimeout(aiTimer);
        const el = (performance.now() - t0) / 1000;
        gained = res.ok ? Math.round((100 + 100 * Math.max(0, 1 - el / timer)) * (r === ROUNDS ? 2 : 1)) : 0;
        combo = res.ok ? combo + 1 : 0;
        const out = recordAnswer(save, q, res.ok, { combo });
        app.celebrate(out);
        me += gained; ai += aiPts;
        const s = host.querySelector('.ai-status'); if (s) s.textContent = aiOk ? `對手答對 +${aiPts}` : '對手答錯了';
        const a = host.querySelector('.sc-me'), b = host.querySelector('.sc-ai');
        if (a) countUp(a, me - gained, me); if (b) countUp(b, ai - aiPts, ai);
        app.persist();
      },
      extra: () => `<p class="pts-line">你 +${gained}　對手 +${aiPts}</p>`,
      nextLabel: r === ROUNDS ? '看結果' : '下一題',
    });
    aiTimer = setTimeout(() => { const s = host.querySelector('.ai-status'); if (s) { s.textContent = '對手已作答！'; s.classList.add('hot'); sfx.tick(); } }, aiFrac * timer * 1000);
    await p;
    clearTimeout(aiTimer);
  }
  await result(app, me, ai, t);
}

async function result(app, me, ai, t0) {
  const { save } = app;
  const win = me > ai;
  const streak = (() => { let n = 0; for (let i = save.ranked.history.length - 1; i >= 0 && save.ranked.history[i].w; i--) n++; return n; })();
  const delta = win ? 22 + Math.min(8, Math.round((me - ai) / 60)) + Math.min(10, streak * 3) : -Math.min(save.ranked.lp, 16 + Math.min(6, Math.round((ai - me) / 80)));
  save.ranked.lp += delta;
  save.ranked.peak = Math.max(save.ranked.peak || 0, save.ranked.lp);
  win ? save.ranked.wins++ : save.ranked.losses++;
  save.ranked.history.push({ w: win, me, ai, at: Date.now() });
  save.ranked.history = save.ranked.history.slice(-50);
  save.coins += win ? 20 : 5;
  if (win) app.celebrate({ missions: track(save, 'ranked', 1) });
  app.persist();
  const t1 = tierOf(save.ranked.lp);
  win ? sfx.level() : sfx.bad();
  if (t1 > t0) app.confetti();
  await modal(`<div class="result ${win ? 'win' : 'lose'}"><div class="res-big">${win ? '勝' : '敗'}</div><p>你 ${me} 分　對手 ${ai} 分</p><p class="lp-delta">${delta >= 0 ? '+' : ''}${delta} 分${win && streak ? `（連勝 ${streak + 1}）` : ''}</p>${t1 > t0 ? `<p class="promo">升上 ${TIERS[t1].name}！</p>` : t1 < t0 ? `<p>掉到 ${TIERS[t1].name}</p>` : ''}</div>`, [{ label: '再打一場', value: 'again', primary: true }, { label: '回排位', value: 'lobby' }]).then((v) => (v === 'again' ? match(app) : renderRanked(app)));
}
