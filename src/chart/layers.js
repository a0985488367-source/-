/**
 * SMC 疊圖層（Overlay Layers）
 * 每個函式都吃同一個 env：{ ctx, s(scales), t(theme), a(analysis), candles, layout, layers, lang }
 */

import { fmtPrice } from '../core/utils.js';
import { SESSIONS, utcHourFloat } from '../smc/sessions.js';

const RIGHT_EXTEND = 12; // 區塊往右延伸的 K 棒數

function clipPlot(env) {
  const { ctx, layout } = env;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, layout.padding.top, layout.width - layout.padding.right, layout.priceHeight);
  ctx.clip();
}

function tag(env, x, y, text, { bg, color, align = 'left', size = 10, pad = 3 }) {
  const { ctx } = env;
  ctx.save();
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const w = ctx.measureText(text).width + pad * 2;
  const h = size + pad * 2 - 1;
  const rx = align === 'right' ? x - w : x;
  ctx.fillStyle = bg;
  roundRect(ctx, rx, y - h / 2, w, h, 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rx + pad, y + 0.5);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function dashLine(ctx, x1, y1, x2, y2, dash = [4, 4], color, width = 1) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ 交易時段 */

export function drawSessions(env) {
  const { ctx, s, t, candles, layout } = env;
  clipPlot(env);
  let i = Math.max(1, Math.floor(s.leftIndex));
  const end = Math.min(candles.length - 1, Math.ceil(s.rightIndex));
  let cur = null;
  for (; i <= end; i++) {
    const h = utcHourFloat(candles[i].time);
    const sess = SESSIONS.find((x) => h >= x.startH && h < x.endH);
    if (sess && (!cur || cur.id !== sess.id || i - cur.end > 1)) {
      if (cur) paint(cur);
      cur = { id: sess.id, sess, start: i, end: i };
    } else if (sess && cur) {
      cur.end = i;
    } else if (!sess && cur) {
      paint(cur);
      cur = null;
    }
  }
  if (cur) paint(cur);
  ctx.restore();

  function paint(seg) {
    const x1 = s.x(seg.start) - s.barWidth / 2;
    const x2 = s.x(seg.end) + s.barWidth / 2;
    ctx.fillStyle = hexToRgba(seg.sess.color, 0.07);
    ctx.fillRect(x1, layout.padding.top, x2 - x1, layout.priceHeight);
    if (x2 - x1 > 44) {
      ctx.save();
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = hexToRgba(seg.sess.color, 0.85);
      ctx.fillText(env.lang === 'zh' ? seg.sess.nameZh : seg.sess.name, x1 + 4, layout.padding.top + 11);
      ctx.restore();
    }
  }
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* --------------------------------------------------------------- 折溢價區間 */

export function drawPremiumDiscount(env) {
  const { ctx, s, t, a, layout, candles } = env;
  const range = a.range;
  if (!range) return;
  clipPlot(env);
  const x1 = s.x(Math.max(0, range.startIndex));
  const x2 = s.x(candles.length - 1 + RIGHT_EXTEND);
  const yHigh = s.y(range.high);
  const yLow = s.y(range.low);
  const yEq = s.y(range.equilibrium);
  ctx.fillStyle = t.premium;
  ctx.fillRect(x1, yHigh, x2 - x1, yEq - yHigh);
  ctx.fillStyle = t.discount;
  ctx.fillRect(x1, yEq, x2 - x1, yLow - yEq);
  dashLine(ctx, x1, yEq, x2, yEq, [6, 4], t.eq, 1);
  dashLine(ctx, x1, yHigh, x2, yHigh, [2, 3], t.eq, 1);
  dashLine(ctx, x1, yLow, x2, yLow, [2, 3], t.eq, 1);
  tag(env, x1 + 4, yEq, 'EQ 50%', { bg: t.tagBg, color: t.text, size: 9 });
  tag(env, x1 + 4, yHigh + 8, env.lang === 'zh' ? '溢價 Premium' : 'Premium', { bg: 'transparent', color: t.textDim, size: 9 });
  tag(env, x1 + 4, yLow - 8, env.lang === 'zh' ? '折價 Discount' : 'Discount', { bg: 'transparent', color: t.textDim, size: 9 });
  ctx.restore();
}

export function drawOte(env) {
  const { ctx, s, t, a, candles } = env;
  if (!a.ote) return;
  clipPlot(env);
  const x1 = s.x(Math.max(0, a.range?.startIndex ?? 0));
  const x2 = s.x(candles.length - 1 + RIGHT_EXTEND);
  const yTop = s.y(a.ote.top);
  const yBot = s.y(a.ote.bottom);
  ctx.fillStyle = t.ote;
  ctx.fillRect(x1, Math.min(yTop, yBot), x2 - x1, Math.abs(yBot - yTop));
  dashLine(ctx, x1, s.y(a.ote.sweet), x2, s.y(a.ote.sweet), [3, 3], t.ote.replace('0.14', '0.6'), 1);
  tag(env, x2 - 4, Math.min(yTop, yBot) + 8, 'OTE 0.62–0.79', { bg: t.tagBg, color: '#b89bff', align: 'right', size: 9 });
  ctx.restore();
}

export function drawFib(env) {
  const { ctx, s, t, a, candles } = env;
  if (!a.fib?.length) return;
  clipPlot(env);
  const x1 = s.x(Math.max(0, a.range?.startIndex ?? 0));
  const x2 = s.x(candles.length - 1 + RIGHT_EXTEND);
  for (const f of a.fib) {
    const y = s.y(f.price);
    dashLine(ctx, x1, y, x2, y, [2, 6], t.textDim, 1);
    tag(env, x2 - 4, y, `${f.label}  ${fmtPrice(f.price)}`, { bg: 'transparent', color: t.textDim, align: 'right', size: 9 });
  }
  ctx.restore();
}

/* ---------------------------------------------------------------------- FVG */

const MAX_FVG_DRAWN = 26;
const MAX_OB_DRAWN = 20;

export function drawFvg(env) {
  const { ctx, s, t, a, candles, layers } = env;
  clipPlot(env);
  // 只畫最近的 N 個缺口，避免整張圖被色塊淹沒
  const list = a.gaps.slice(-MAX_FVG_DRAWN);
  for (const g of list) {
    if (g.kind === 'vi' && !layers.volumeImbalance) continue;
    if (g.state === 'filled' && !layers.filledZones) continue;
    const endIdx = g.invertedIndex ?? g.filledIndex ?? candles.length - 1 + RIGHT_EXTEND;
    const x1 = s.x(g.index);
    const x2 = s.x(endIdx);
    if (x2 < 0 || x1 > s.plotW) continue;
    const yTop = s.y(g.top);
    const yBot = s.y(g.bottom);
    const bull = (g.state === 'inverted' ? g.invertedDir : g.dir) === 'bull';
    ctx.fillStyle = bull ? t.fvgBull : t.fvgBear;
    ctx.fillRect(x1, yTop, Math.max(2, x2 - x1), yBot - yTop);
    ctx.strokeStyle = bull ? t.fvgBullEdge : t.fvgBearEdge;
    ctx.lineWidth = 0.6;
    ctx.setLineDash(g.state === 'inverted' ? [3, 3] : []);
    ctx.strokeRect(x1, yTop, Math.max(2, x2 - x1), yBot - yTop);
    ctx.setLineDash([]);
    if (Math.abs(yBot - yTop) > 11 && x2 - x1 > 34) {
      const label = g.state === 'inverted' ? 'IFVG' : g.kind === 'vi' ? 'VI' : 'FVG';
      tag(env, x1 + 3, (yTop + yBot) / 2, label, { bg: 'transparent', color: bull ? t.fvgBullEdge : t.fvgBearEdge, size: 9 });
    }
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- Order Block */

export function drawOrderBlocks(env) {
  const { ctx, s, t, a, candles, layers, lang } = env;
  clipPlot(env);
  const obs = [...a.orderBlocks].sort((x, y) => y.index - x.index).slice(0, MAX_OB_DRAWN).sort((x, y) => x.index - y.index);
  for (const b of obs) {
    if (b.state === 'breaker' && !layers.breakers) continue;
    if (b.state !== 'breaker' && !layers.orderBlocks) continue;
    if (b.state === 'mitigated' && !layers.filledZones) continue;
    const endIdx = b.state === 'breaker' && b.brokenIndex ? Math.max(b.brokenIndex, b.index + 3) : candles.length - 1 + RIGHT_EXTEND;
    const x1 = s.x(b.index);
    const x2 = s.x(endIdx);
    if (x2 < 0 || x1 > s.plotW) continue;
    const yTop = s.y(b.top);
    const yBot = s.y(b.bottom);
    const eff = b.state === 'breaker' ? b.breakerDir : b.dir;
    const bull = eff === 'bull';
    const alpha = b.state === 'mitigated' ? 0.35 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bull ? t.bullZone : t.bearZone;
    ctx.fillRect(x1, yTop, Math.max(2, x2 - x1), yBot - yTop);
    ctx.strokeStyle = bull ? t.bullEdge : t.bearEdge;
    ctx.lineWidth = b.scale === 'swing' ? 1.2 : 0.7;
    ctx.setLineDash(b.state === 'breaker' ? [5, 3] : []);
    ctx.strokeRect(x1, yTop, Math.max(2, x2 - x1), yBot - yTop);
    ctx.setLineDash([]);
    const name = b.state === 'breaker' ? 'BB' : b.scale === 'swing' ? 'OB+' : 'OB';
    if (x2 - x1 > 30) {
      tag(env, x2 - 4, yTop + 7, `${name} ${b.score}`, {
        bg: t.tagBg, color: bull ? t.bullEdge : t.bearEdge, align: 'right', size: 9,
      });
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/* ----------------------------------------------------------------- 流動性 */

export function drawLiquidity(env) {
  const { ctx, s, t, a, candles, lang } = env;
  clipPlot(env);
  for (const p of a.pools) {
    if (p.touches < 2 && !p.equal && p.strength < 45) continue;
    const x1 = s.x(p.firstIndex);
    const x2 = p.swept ? s.x(p.sweptIndex) : s.x(candles.length - 1 + RIGHT_EXTEND);
    if (x2 < 0 || x1 > s.plotW) continue;
    const y = s.y(p.price);
    dashLine(ctx, x1, y, x2, y, p.swept ? [2, 4] : [6, 3], p.swept ? t.liquiditySwept : t.liquidity, p.equal ? 1.3 : 0.8);
    if (!p.swept && x2 - x1 > 40) {
      const lbl = `${p.side === 'buyside' ? 'BSL' : 'SSL'}${p.equal ? (p.side === 'buyside' ? ' EQH' : ' EQL') : ''}`;
      tag(env, x2 - 3, y, lbl, { bg: t.tagBg, color: t.liquidity, align: 'right', size: 9 });
    }
  }
  ctx.restore();
}

export function drawSweeps(env) {
  const { ctx, s, t, a } = env;
  clipPlot(env);
  for (const sw of a.sweeps) {
    const x = s.x(sw.index);
    if (x < -20 || x > s.plotW + 20) continue;
    const y = s.y(sw.extreme);
    const up = sw.side === 'buyside';
    ctx.save();
    ctx.fillStyle = t.sweep;
    ctx.beginPath();
    const dy = up ? -6 : 6;
    ctx.moveTo(x, y + dy * 0.2);
    ctx.lineTo(x - 4, y + dy);
    ctx.lineTo(x + 4, y + dy);
    ctx.closePath();
    ctx.fill();
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('×', x - 2, y + dy * 2.2);
    ctx.restore();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ 結構線 */

export function drawStructure(env) {
  const { ctx, s, t, a, layers } = env;
  clipPlot(env);
  const events = [...a.structure.swing.events.map((e) => ({ ...e, major: true })), ...a.structure.internal.events];
  for (const e of events) {
    const x1 = s.x(e.fromIndex);
    const x2 = s.x(e.breakIndex);
    if (x2 < 0 || x1 > s.plotW) continue;
    const y = s.y(e.price);
    const color = e.type === 'CHoCH' ? t.structureChoch : t.structureBos;
    dashLine(ctx, x1, y, x2, y, e.major ? [] : [3, 3], color, e.major ? 1.3 : 0.8);
    if (x2 - x1 > 24) {
      tag(env, x2 + 2, y, `${e.type}${e.major ? '' : 'ᵢ'}`, { bg: t.tagBg, color, size: e.major ? 10 : 9 });
    }
  }
  ctx.restore();
}

export function drawSwingLabels(env) {
  const { ctx, s, t, a } = env;
  clipPlot(env);
  ctx.font = '9px ui-monospace, monospace';
  for (const sw of a.swings) {
    const x = s.x(sw.index);
    if (x < -10 || x > s.plotW + 10) continue;
    const y = s.y(sw.price) + (sw.type === 'high' ? -8 : 12);
    ctx.fillStyle = sw.label === 'HH' || sw.label === 'HL' ? t.up : sw.label === 'LL' || sw.label === 'LH' ? t.down : t.textDim;
    ctx.textAlign = 'center';
    ctx.fillText(sw.label || (sw.type === 'high' ? 'H' : 'L'), x, y);
  }
  ctx.textAlign = 'left';
  ctx.restore();
}

export function drawInducement(env) {
  const { ctx, s, t, a, candles } = env;
  const idm = a.inducement;
  if (!idm) return;
  clipPlot(env);
  const x1 = s.x(idm.index);
  const x2 = s.x(idm.taken ? idm.takenIndex : candles.length - 1 + RIGHT_EXTEND);
  const y = s.y(idm.price);
  dashLine(ctx, x1, y, x2, y, [1, 3], idm.taken ? t.textDim : '#ff9f43', 1);
  tag(env, x1 + 3, y, idm.taken ? 'IDM ✓' : 'IDM', { bg: t.tagBg, color: idm.taken ? t.textDim : '#ff9f43', size: 9 });
  ctx.restore();
}

/* --------------------------------------------------------------- 關鍵價位 */

export function drawKeyLevels(env) {
  const { ctx, s, t, a, lang } = env;
  clipPlot(env);
  for (const l of a.keyLevels) {
    const y = s.y(l.price);
    if (y < 0 || y > env.layout.height) continue;
    dashLine(ctx, 0, y, s.plotW, y, [8, 5], l.color, 0.9);
    tag(env, 6, y, `${l.code} ${fmtPrice(l.price)}`, { bg: t.tagBg, color: l.color, size: 9 });
  }
  ctx.restore();
}

/* ------------------------------------------------------------------- 均線 */

function linePath(env, arr, color, width = 1.2) {
  const { ctx, s, candles } = env;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  const from = Math.max(0, Math.floor(s.leftIndex) - 1);
  const to = Math.min(candles.length - 1, Math.ceil(s.rightIndex) + 1);
  for (let i = from; i <= to; i++) {
    const v = arr[i];
    if (v == null) { started = false; continue; }
    const x = s.x(i);
    const y = s.y(v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawEmas(env) {
  const { a, t } = env;
  clipPlot(env);
  linePath(env, a.indicators.ema20, t.ema20, 1);
  linePath(env, a.indicators.ema50, t.ema50, 1.1);
  linePath(env, a.indicators.ema200, t.ema200, 1.3);
  env.ctx.restore();
}

export function drawVwap(env) {
  const { a, t } = env;
  clipPlot(env);
  linePath(env, a.indicators.vwap, t.vwap, 1.2);
  linePath(env, a.indicators.upper1, t.vwap, 0.5);
  linePath(env, a.indicators.lower1, t.vwap, 0.5);
  env.ctx.restore();
}

export function drawVolumeProfile(env) {
  const { ctx, s, t, a, layout } = env;
  const vp = a.indicators.volumeProfile;
  if (!vp) return;
  clipPlot(env);
  const maxW = Math.min(140, s.plotW * 0.22);
  const x0 = s.plotW;
  for (const b of vp.bins) {
    const y = s.y(b.price);
    const h = Math.max(1, Math.abs(s.y(vp.low) - s.y(vp.low + vp.step)) - 1);
    const w = b.ratio * maxW;
    const inVa = b.price <= vp.vah && b.price >= vp.val;
    ctx.fillStyle = inVa ? 'rgba(120,160,255,0.28)' : 'rgba(140,150,170,0.16)';
    ctx.fillRect(x0 - w, y - h / 2, w, h);
  }
  const yPoc = s.y(vp.poc);
  dashLine(ctx, x0 - maxW, yPoc, x0, yPoc, [], '#ffcf5c', 1.2);
  tag(env, x0 - maxW - 2, yPoc, `POC ${fmtPrice(vp.poc)}`, { bg: t.tagBg, color: '#ffcf5c', align: 'right', size: 9 });
  ctx.restore();
}

/* ------------------------------------------------------------ 交易計畫疊圖 */

export function drawSetup(env) {
  const { ctx, s, t, a, candles, lang } = env;
  const setup = a.setup;
  if (!setup || setup.none) return;
  clipPlot(env);
  const x1 = s.x(candles.length - 14);
  const x2 = s.x(candles.length - 1 + RIGHT_EXTEND);
  const yEntry = s.y(setup.entry);
  const yStop = s.y(setup.stop);

  // 風險區
  ctx.fillStyle = 'rgba(239,83,80,0.12)';
  ctx.fillRect(x1, Math.min(yEntry, yStop), x2 - x1, Math.abs(yStop - yEntry));
  // 報酬區（到最終目標）
  const lastTp = setup.targets[setup.targets.length - 1];
  if (lastTp) {
    const yTp = s.y(lastTp.price);
    ctx.fillStyle = 'rgba(38,166,154,0.10)';
    ctx.fillRect(x1, Math.min(yEntry, yTp), x2 - x1, Math.abs(yTp - yEntry));
  }
  dashLine(ctx, x1, yEntry, x2, yEntry, [], t.entry, 1.4);
  dashLine(ctx, x1, yStop, x2, yStop, [4, 3], t.stop, 1.2);
  tag(env, x1 + 3, yEntry, `${lang === 'zh' ? '進場' : 'Entry'} ${fmtPrice(setup.entry)}`, { bg: t.tagBg, color: t.entry, size: 9 });
  tag(env, x1 + 3, yStop, `SL ${fmtPrice(setup.stop)}`, { bg: t.tagBg, color: t.stop, size: 9 });
  setup.targets.forEach((tp) => {
    const y = s.y(tp.price);
    dashLine(ctx, x1, y, x2, y, [4, 3], t.target, 1);
    tag(env, x1 + 3, y, `${tp.name} ${fmtPrice(tp.price)} · ${tp.rr.toFixed(1)}R`, { bg: t.tagBg, color: t.target, size: 9 });
  });
  ctx.restore();
}
