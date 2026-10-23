/** 共用介面：DOM 小工具、音效、震動、出題畫面（runQuestion） */
import { createChart } from './chart.js';
import { CONCEPT } from './concepts.js';
import { fmtTime } from './core.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* ---------- 音效（WebAudio 合成，不用音檔） ---------- */
let actx = null, soundOn = true, hapticOn = true;
export function setFeedback({ sound, haptics }) { soundOn = sound !== false; hapticOn = haptics !== false; }
function tone(freq, dur, type = 'sine', vol = 0.12, when = 0) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime + when, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch { /* 不支援就安靜 */ }
}
const buzz = (p) => { if (hapticOn && navigator.vibrate) try { navigator.vibrate(p); } catch { /* 沒震動也沒差 */ } };
export const sfx = {
  ok(combo = 0) { const b = 520 * Math.pow(1.06, Math.min(combo, 12)); tone(b, 0.12, 'triangle'); tone(b * 1.5, 0.18, 'triangle', 0.1, 0.08); buzz(15); },
  bad() { tone(160, 0.25, 'sawtooth', 0.08); tone(120, 0.3, 'sawtooth', 0.06, 0.05); buzz([40, 40, 60]); },
  hit() { tone(90, 0.15, 'square', 0.1); buzz(25); },
  coin() { tone(988, 0.08, 'square', 0.06); tone(1319, 0.14, 'square', 0.06, 0.07); },
  level() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.1, i * 0.09)); buzz([20, 30, 20, 30, 60]); },
  tick() { tone(1200, 0.03, 'square', 0.03); },
  stamp() { tone(70, 0.2, 'sine', 0.25); tone(140, 0.08, 'square', 0.05); buzz(35); },
};

export function toast(msg, kind = '') {
  const t = el(`<div class="toast ${kind}">${msg}</div>`);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 2400);
}

/** 全畫面彈窗，回傳 Promise（按按鈕後 resolve 按鈕的 value） */
export function modal(html, buttons = [{ label: '好', value: true, primary: true }]) {
  return new Promise((res) => {
    const m = el(`<div class="modal"><div class="sheet">${html}<div class="row-btns">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div></div>`);
    document.body.appendChild(m);
    requestAnimationFrame(() => m.classList.add('in'));
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      m.classList.remove('in');
      setTimeout(() => m.remove(), 200);
      res(buttons[+b.dataset.i].value);
    });
  });
}

/**
 * 出題畫面。host 裡會被清空，畫完一題。
 * opts:
 *   timer        秒數（null＝不限時）
 *   tools        [{ id, label, n, use(api) }]：刪去法、加時…（n＝剩幾次）
 *   canRetry()   答錯時回傳 true 就給一次重答（時光倒流）
 *   onAnswer(r)  一答完馬上呼叫（模式拿來扣血、打怪），r＝{ ok, timeout }
 *   nextLabel    下一步按鈕文字
 *   auto         答對後自動跳下一題的毫秒數（閃電／戰鬥用）
 *   top          題目上方的 HTML（血條之類）
 * 回傳 Promise<{ ok, timeout }>，在使用者按「下一步」後 resolve。
 */
export function runQuestion(host, q, opts = {}) {
  return new Promise((resolve) => {
    const c = CONCEPT[q.concept];
    host.innerHTML = '';
    const root = el(`<section class="q">
      ${opts.top ? `<div class="q-hud">${opts.top}</div>` : ''}
      <header class="q-head">
        <span class="q-card" style="--rc:${c ? '' : ''}">${c ? `<b>${c.glyph}</b>${esc(c.name)}` : ''}</span>
        ${opts.combo >= 2 ? `<span class="combo">連對 ${opts.combo}</span>` : ''}
        ${q.spot ? '<span class="q-kind">找錯</span>' : q.explain ? '<span class="q-kind">說法題</span>' : q.kind === 'pick' ? '<span class="q-kind">點圖</span>' : ''}
      </header>
      <h2 class="q-prompt">${esc(q.prompt)}</h2>
      ${q.sub ? `<p class="q-sub">${esc(q.sub)}</p>` : ''}
      ${opts.timer ? '<div class="q-timer"><i></i></div>' : ''}
      ${q.chart ? `<div class="q-chart"><canvas></canvas><div class="q-meta">${q.meta?.coin ? `${q.meta.coin}/USDT ${q.meta.tf}｜${fmtTime(q.meta.t)}` : ''}</div></div>` : ''}
      <div class="q-tools"></div>
      <div class="q-act"></div>
      <div class="q-res" hidden></div>
    </section>`);
    host.appendChild(root);
    let chart = null, done = false, timerId = null, left = opts.timer || 0, picked = null, retried = false;
    const act = $('.q-act', root), res = $('.q-res', root);

    if (q.chart) {
      chart = createChart($('canvas', root), { height: Math.round(Math.min(360, Math.max(250, window.innerHeight * 0.42))) });
      chart.set({ W: q.chart.W, from: q.chart.from, to: q.chart.to, ov: q.chart.ov, reveal: q.chart.reveal });
    }

    const api = {
      eliminate(n = 2) {
        const wrong = $$('.opt:not(.gone)', act).filter((b) => !q.options[+b.dataset.i].ok);
        wrong.sort(() => Math.random() - 0.5).slice(0, n).forEach((b) => { b.classList.add('gone'); b.disabled = true; });
      },
      addTime(s) { left += s; },
      hint() { if (chart) chart.update({ ov: [...(q.chart.ov || []), ...(q.chart.reveal || []).filter((o) => o.t === 'tag' || o.t === 'hline').slice(0, 1)] }); },
    };
    const tools = $('.q-tools', root);
    (opts.tools || []).forEach((t) => {
      if (!t.n) return;
      if (t.choiceOnly && q.kind !== 'choice') return;
      const b = el(`<button class="tool">${esc(t.label)} <small>×${t.n}</small></button>`);
      b.onclick = () => { if (done) return; t.n--; t.use(api); b.remove(); };
      tools.appendChild(b);
    });

    function finish(ok, timeout = false) {
      if (done) return;
      if (!ok && !timeout && opts.canRetry && !retried && opts.canRetry()) {
        retried = true;
        sfx.hit();
        toast('時光倒流！再答一次', 'gold');
        $$('.opt', act).forEach((b) => { if (b.classList.contains('wrong')) { b.disabled = true; b.classList.add('gone'); } b.classList.remove('sel', 'wrong'); });
        const cb = $('.confirm', act); if (cb) cb.disabled = true;
        picked = null;
        return;
      }
      done = true;
      clearInterval(timerId);
      if (chart) { chart.setMode(null); chart.reveal(); }
      root.classList.add(ok ? 'is-ok' : 'is-bad');
      if (q.options) $$('.opt', act).forEach((b) => { const o = q.options[+b.dataset.i]; b.disabled = true; if (o.ok) b.classList.add('right'); });
      ok ? sfx.ok(opts.combo || 0) : sfx.bad();
      const r = { ok, timeout };
      opts.onAnswer && opts.onAnswer(r);
      res.hidden = false;
      res.innerHTML = `<div class="verdict">${ok ? '對' : timeout ? '時間到' : '錯'}</div><p class="why">${esc(q.why || '')}</p>${opts.extra ? opts.extra(r) : ''}<button class="btn primary next">${esc(opts.nextLabel || '下一題')}</button>`;
      const go = () => { if (chart) chart.destroy(); resolve(r); };
      $('.next', res).onclick = go;
      if (ok && opts.auto) setTimeout(() => { if (root.isConnected) go(); }, opts.auto);
      res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (q.kind === 'choice') {
      act.innerHTML = `<div class="opts">${q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o.label)}</button>`).join('')}</div>`;
      act.onclick = (e) => {
        const b = e.target.closest('.opt');
        if (!b || done || b.disabled) return;
        const o = q.options[+b.dataset.i];
        b.classList.add('sel');
        if (!o.ok) b.classList.add('wrong');
        finish(o.ok);
      };
    } else {
      const how = q.pick.mode === 'price' ? '點圖上的價位（上下位置）' : q.pick.mode === 'bar' ? '點那根 K 棒' : '點圖上的位置';
      const m = q.pick.mode, lr = m !== 'price', ud = m !== 'bar';
      act.innerHTML = `<div class="pickbar"><span>${how}，可以用箭頭微調，再按確定</span>
        <div class="nudge">${lr ? '<button data-n="-1,0" aria-label="往左一根">◀</button><button data-n="1,0" aria-label="往右一根">▶</button>' : ''}${ud ? '<button data-n="0,1" aria-label="往上">▲</button><button data-n="0,-1" aria-label="往下">▼</button>' : ''}</div>
        <button class="btn primary confirm" disabled>確定</button></div>`;
      chart.setMode(m);
      chart.onTap((i, p) => { picked = { i, p }; $('.confirm', act).disabled = false; sfx.tick(); });
      $('.nudge', act).onclick = (e) => {
        const b = e.target.closest('[data-n]'); if (!b || done) return;
        const [di, dp] = b.dataset.n.split(',').map(Number);
        const r = chart.nudge(di, dp); if (r) { picked = r; sfx.tick(); }
      };
      $('.confirm', act).onclick = () => { if (!picked || done) return; finish(!!q.pick.test(picked.i, picked.p)); };
    }

    // 測試用：網址加 ?debug 時可以直接作答
    if (/debug/.test(location.search)) { window.__q = q; window.__answer = (ok) => finish(ok); }
    if (opts.timer) {
      const bar = $('.q-timer i', root), total = opts.timer;
      timerId = setInterval(() => {
        if (!root.isConnected) { clearInterval(timerId); return; } // 已經離開這個畫面
        left -= 0.1;
        bar.style.width = `${Math.max(0, left / total) * 100}%`;
        bar.classList.toggle('low', left < total * 0.3);
        if (left <= 0) finish(false, true);
      }, 100);
    }
  });
}

/** 數字跳動動畫 */
export function countUp(node, from, to, ms = 600, fmt = (v) => Math.round(v)) {
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); node.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
