/**
 * K 線圖（canvas）：畫 W[from..to]、各種標記，點圖回傳 (K 棒索引, 價格)。
 * 標記格式見 gen.js 開頭。
 */
const C = { bg: '#101b35', grid: 'rgba(143,154,184,.10)', up: '#3DBB8F', dn: '#E2483D', axis: '#8F9AB8', ink: '#ECE6D6', pick: '#F2D27A' };

export function createChart(canvas, { height = 300 } = {}) {
  const ctx = canvas.getContext('2d');
  let st = null, w = 0, h = 0, dpr = 1, pick = null, tapFn = null, mode = null;
  const pad = { l: 6, r: 52, t: 24, b: 14 };
  let lo = 0, hi = 1, bw = 4;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    w = canvas.clientWidth || canvas.parentElement.clientWidth;
    h = height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const x = (i) => pad.l + (i - st.from + 0.5) * bw;
  const y = (p) => pad.t + (hi - p) / (hi - lo) * (h - pad.t - pad.b);
  const priceAt = (py) => hi - (py - pad.t) / (h - pad.t - pad.b) * (hi - lo);
  const idxAt = (px) => Math.round((px - pad.l) / bw - 0.5) + st.from;

  function range() {
    const { W, from, to } = st;
    lo = Infinity; hi = -Infinity;
    for (let i = from; i <= to; i++) { lo = Math.min(lo, W[i].l); hi = Math.max(hi, W[i].h); }
    for (const o of [...(st.ov || []), ...(st.reveal || []), ...(st.extra || [])]) {
      for (const p of [o.p, o.p1, o.p2]) if (p != null && Number.isFinite(p)) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
    }
    const m = (hi - lo) * 0.06 || hi * 0.01;
    lo -= m; hi += m;
    const bars = to - from + 1 + 3;
    bw = (w - pad.l - pad.r) / bars;
  }

  function label(text, px, py, color, align = 'left', bgc = 'rgba(16,27,53,.85)') {
    ctx.font = '600 11px "Barlow Semi Condensed", "Noto Sans TC", sans-serif';
    const tw = ctx.measureText(text).width;
    let lx = align === 'right' ? px - tw - 6 : px + 3;
    lx = Math.max(2, Math.min(w - pad.r - tw - 6, lx));
    ctx.fillStyle = bgc;
    ctx.fillRect(lx - 2, py - 8, tw + 6, 15);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 1, py);
  }

  function drawOv(o, faded) {
    const { from, to } = st;
    ctx.save();
    if (faded) ctx.globalAlpha = 0.55;
    const clipX = (i) => x(Math.max(from, Math.min(to, i)));
    if (o.t === 'zone') {
      const x1 = clipX(o.i1) - bw / 2, x2 = clipX(o.i2 ?? to) + bw / 2;
      const y1 = y(Math.max(o.p1, o.p2)), y2 = y(Math.min(o.p1, o.p2));
      ctx.fillStyle = o.c + '33'; ctx.fillRect(x1, y1, x2 - x1, Math.max(2, y2 - y1));
      ctx.strokeStyle = o.c; ctx.lineWidth = 1; ctx.strokeRect(x1, y1, x2 - x1, Math.max(2, y2 - y1));
      if (o.label) label(o.label, x1, y1 - 2 < 10 ? y2 + 8 : y1 - 8, o.c);
    } else if (o.t === 'hline') {
      const x1 = clipX(o.i1 ?? from) - bw / 2, x2 = clipX(o.i2 ?? to) + bw / 2, py = y(o.p);
      ctx.strokeStyle = o.c; ctx.lineWidth = 1.5; ctx.setLineDash(o.dash ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(x1, py); ctx.lineTo(x2, py); ctx.stroke(); ctx.setLineDash([]);
      if (o.label) label(o.label, x2, py, o.c, 'right');
    } else if (o.t === 'mark') {
      if (o.i < from || o.i > to) { ctx.restore(); return; }
      const px = x(o.i), py = y(o.p);
      ctx.strokeStyle = o.c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, Math.max(6, bw * 0.9), 0, Math.PI * 2); ctx.stroke();
      if (o.label) { const r = Math.max(6, bw * 0.9) + 3; px > w * 0.62 ? label(o.label, px - r, py - r, o.c, 'right') : label(o.label, px + r, py - r, o.c); }
    } else if (o.t === 'band') {
      if (o.i < from || o.i > to) { ctx.restore(); return; }
      ctx.fillStyle = o.c + '30'; ctx.fillRect(x(o.i) - Math.max(bw, 6) / 2, pad.t, Math.max(bw, 6), h - pad.t - pad.b);
    } else if (o.t === 'vline') {
      if (o.i < from || o.i > to) { ctx.restore(); return; }
      ctx.strokeStyle = o.c; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x(o.i), pad.t); ctx.lineTo(x(o.i), h - pad.b); ctx.stroke(); ctx.setLineDash([]);
      if (o.label) label(o.label, x(o.i), pad.t + 6, o.c);
    } else if (o.t === 'tag') {
      if (o.i < from || o.i > to) { ctx.restore(); return; }
      const py = y(o.p) + (o.up ? -10 : 10);
      ctx.font = '700 10px "Barlow Semi Condensed", sans-serif';
      ctx.fillStyle = o.c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(o.text, x(o.i), py); ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  function draw() {
    if (!st) return;
    size(); range();
    const { W, from, to } = st;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    // 格線＋價格刻度
    ctx.font = '500 10px "Barlow Semi Condensed", sans-serif'; ctx.textBaseline = 'middle';
    const step = niceStep((hi - lo) / 5);
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      const py = y(p);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(w - pad.r, py); ctx.stroke();
      ctx.fillStyle = C.axis; ctx.fillText(fmt(p), w - pad.r + 4, py);
    }
    (st.ov || []).filter((o) => o.t === 'band' || o.t === 'zone').forEach((o) => drawOv(o));
    if (st.showReveal) (st.reveal || []).filter((o) => o.t === 'band' || o.t === 'zone').forEach((o) => drawOv(o));
    // K 棒
    const body = Math.max(1, bw * 0.62);
    for (let i = from; i <= to; i++) {
      const k = W[i], up = k.c >= k.o, cx = x(i);
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.dn;
      ctx.globalAlpha = st.dimAfter != null && i > st.dimAfter ? 0.9 : 1;
      ctx.beginPath(); ctx.moveTo(cx, y(k.h)); ctx.lineTo(cx, y(k.l)); ctx.lineWidth = Math.max(1, bw > 6 ? 1.2 : 1); ctx.stroke();
      const yo = y(k.o), yc = y(k.c);
      ctx.fillRect(cx - body / 2, Math.min(yo, yc), body, Math.max(1, Math.abs(yc - yo)));
    }
    ctx.globalAlpha = 1;
    if (st.dimAfter != null && st.dimAfter < to) {
      ctx.strokeStyle = 'rgba(236,230,214,.35)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x(st.dimAfter) + bw / 2, pad.t); ctx.lineTo(x(st.dimAfter) + bw / 2, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
    }
    (st.ov || []).filter((o) => o.t !== 'band' && o.t !== 'zone').forEach((o) => drawOv(o));
    if (st.showReveal) (st.reveal || []).filter((o) => o.t !== 'band' && o.t !== 'zone').forEach((o) => drawOv(o));
    // 現價
    const px = W[to].c;
    label(fmt(px), w - pad.r + 1, y(px), '#0F1A33', 'left', C.ink);
    // 使用者點的位置
    if (pick) {
      ctx.strokeStyle = C.pick; ctx.fillStyle = C.pick; ctx.lineWidth = 1.5;
      if (mode === 'price') { ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(pad.l, y(pick.p)); ctx.lineTo(w - pad.r, y(pick.p)); ctx.stroke(); ctx.setLineDash([]); label(fmt(pick.p), w - pad.r + 1, y(pick.p), '#0F1A33', 'left', C.pick); }
      else if (mode === 'bar') { ctx.globalAlpha = 0.25; ctx.fillRect(x(pick.i) - Math.max(bw, 8) / 2, pad.t, Math.max(bw, 8), h - pad.t - pad.b); ctx.globalAlpha = 1; }
      else { ctx.beginPath(); ctx.arc(x(pick.i), y(pick.p), 9, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x(pick.i), y(pick.p), 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  function onDown(ev) {
    if (!mode || !st) return;
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    if (px > w - pad.r + 2) return;
    const i = Math.max(st.from, Math.min(st.to, idxAt(px)));
    pick = { i, p: priceAt(py) };
    draw();
    tapFn && tapFn(pick.i, pick.p);
  }
  canvas.addEventListener('pointerdown', onDown);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  ro && ro.observe(canvas);

  return {
    set(s) { st = { ...s }; pick = null; draw(); },
    update(patch) { st = { ...st, ...patch }; draw(); },
    reveal() { st.showReveal = true; draw(); },
    setMode(m) { mode = m; if (m) pick = null; canvas.style.cursor = m ? 'crosshair' : 'default'; canvas.style.touchAction = m ? 'none' : 'pan-y'; },
    /** 微調點的位置：di 根 K 棒、dp 個刻度（1／120 的畫面高度） */
    nudge(di, dp) {
      if (!pick || !st) return null;
      pick = { i: Math.max(st.from, Math.min(st.to, pick.i + di)), p: pick.p + dp * (hi - lo) / 120 };
      draw();
      return pick;
    },
    onTap(fn) { tapFn = fn; },
    get pick() { return pick; },
    get state() { return st; },
    draw,
    destroy() { canvas.removeEventListener('pointerdown', onDown); ro && ro.disconnect(); },
  };
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
function fmt(p) { return p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toPrecision(4); }
