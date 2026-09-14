/**
 * 自製 Canvas 圖表引擎
 * 不依賴任何第三方圖表庫 → 完全掌握 SMC 疊圖的繪製順序、命中測試與效能。
 *
 * 功能：K 棒／實心線圖、成交量副圖、價格與時間軸、十字線、平移縮放（滑鼠＋觸控）、
 *      疊圖層、圖例、最後價格標籤、區塊命中測試（滑鼠移到 OB/FVG 顯示詳情）。
 */

import { getTheme } from './theme.js';
import { createScales, autoRange, priceTicks, timeTicks } from './scales.js';
import * as L from './layers.js';
import { fmtPrice, fmtTime, fmtCompact, clamp, precisionFor } from '../core/utils.js';

const TIME_AXIS_H = 22;
const PRICE_AXIS_W = 68;

export class Chart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.candles = [];
    this.analysis = null;
    this.themeName = opts.theme || 'dark';
    this.lang = opts.lang || 'zh';
    this.timezone = opts.timezone || 'UTC';
    this.layers = opts.layers || {};
    this.chartType = opts.chartType || 'candles';
    this.logScale = false;
    this.barsVisible = 160;
    this.rightIndex = 0;
    this.autoScroll = true;
    this.pointer = null;
    this.hover = null;
    this.onHover = opts.onHover || (() => {});
    this.onViewChange = opts.onViewChange || (() => {});
    this.volumePaneRatio = 0.16;
    this._raf = null;
    this._bind();
    this.resize();
  }

  setTheme(name) { this.themeName = name; this.requestRender(); }
  setLang(l) { this.lang = l; this.requestRender(); }
  setTimezone(tz) { this.timezone = tz; this.requestRender(); }
  setLayers(layers) { this.layers = layers; this.requestRender(); }
  setChartType(t) { this.chartType = t; this.requestRender(); }

  setData(candles, analysis, { keepView = true } = {}) {
    const wasAtRight = this.autoScroll || this.rightIndex >= this.candles.length - 1;
    this.candles = candles;
    this.analysis = analysis;
    if (!keepView || !this.rightIndex || wasAtRight) this.rightIndex = candles.length + 6;
    this.rightIndex = clamp(this.rightIndex, 10, candles.length + this.barsVisible * 0.5);
    this.requestRender();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = Math.max(260, rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.width = w;
    this.height = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.requestRender();
  }

  get layout() {
    const padding = { top: 10, right: PRICE_AXIS_W, bottom: TIME_AXIS_H };
    const volumeHeight = Math.round(this.height * this.volumePaneRatio);
    const priceHeight = this.height - padding.top - TIME_AXIS_H - volumeHeight;
    return { padding, volumeHeight, priceHeight, width: this.width, height: this.height, volumeTop: padding.top + priceHeight };
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      try { this.render(); } catch (e) { console.error('[chart]', e); }
    });
  }

  /* ------------------------------------------------------------ 事件綁定 */

  _bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const s = this._scales();
      const anchorIdx = s.xToIndex(px);
      const newBars = clamp(this.barsVisible * factor, 25, 1500);
      const ratio = (anchorIdx - s.leftIndex) / this.barsVisible;
      this.barsVisible = newBars;
      this.rightIndex = anchorIdx + (1 - ratio) * newBars;
      this.autoScroll = this.rightIndex >= this.candles.length;
      this.clampView();
      this.onViewChange();
      this.requestRender();
    }, { passive: false });

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    c.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; c.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', () => { dragging = false; c.style.cursor = 'crosshair'; });
    window.addEventListener('mousemove', (e) => {
      if (dragging) {
        const s = this._scales();
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        lastY = e.clientY;
        this.rightIndex -= dx / s.barWidth;
        this.autoScroll = false;
        this.clampView();
        this.requestRender();
        return;
      }
    });
    c.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.hover = this.hitTest(this.pointer.x, this.pointer.y);
      this.onHover(this.hover, this.pointer, this.pointerInfo());
      this.requestRender();
    });
    c.addEventListener('mouseleave', () => {
      this.pointer = null;
      this.hover = null;
      this.onHover(null, null, null);
      this.requestRender();
    });
    c.addEventListener('dblclick', () => { this.resetView(); });

    // 觸控：單指平移、雙指縮放
    let touchStart = null;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchStart = { x: e.touches[0].clientX, bars: this.barsVisible, right: this.rightIndex };
      else if (e.touches.length === 2) {
        touchStart = {
          dist: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY),
          bars: this.barsVisible,
          right: this.rightIndex,
        };
      }
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (!touchStart) return;
      if (e.touches.length === 1 && touchStart.x != null) {
        const s = this._scales();
        this.rightIndex = touchStart.right - (e.touches[0].clientX - touchStart.x) / s.barWidth;
        this.autoScroll = false;
      } else if (e.touches.length === 2 && touchStart.dist) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.barsVisible = clamp(touchStart.bars * (touchStart.dist / Math.max(1, d)), 25, 1500);
      }
      this.clampView();
      this.requestRender();
      e.preventDefault();
    }, { passive: false });
    c.addEventListener('touchend', () => { touchStart = null; });
  }

  clampView() {
    const n = this.candles.length || 1;
    this.rightIndex = clamp(this.rightIndex, Math.min(30, n), n + this.barsVisible * 0.6);
  }

  resetView() {
    this.barsVisible = 160;
    this.rightIndex = this.candles.length + 6;
    this.autoScroll = true;
    this.requestRender();
  }

  zoom(factor) {
    this.barsVisible = clamp(this.barsVisible * factor, 25, 1500);
    this.clampView();
    this.requestRender();
  }

  pointerInfo() {
    if (!this.pointer) return null;
    const s = this._scales();
    const idx = Math.round(s.xToIndex(this.pointer.x));
    const c = this.candles[idx];
    if (!c) return null;
    return { candle: c, index: idx, price: s.yToPrice(this.pointer.y) };
  }

  _scales() {
    const { padding, priceHeight } = this.layout;
    const from = this.rightIndex - this.barsVisible;
    const extras = [];
    const a = this.analysis;
    if (a && !a.empty) {
      if (this.layers.setup && a.setup && !a.setup.none) {
        extras.push(a.setup.entry, a.setup.stop, ...a.setup.targets.map((t) => t.price));
      }
      if (this.layers.premiumDiscount && a.range) extras.push(a.range.high, a.range.low);
    }
    const { min, max } = autoRange(this.candles, from, this.rightIndex, extras);
    return createScales({
      width: this.width,
      height: padding.top + priceHeight + padding.bottom,
      padding: { top: padding.top, right: PRICE_AXIS_W, bottom: 0 },
      barsVisible: this.barsVisible,
      rightIndex: this.rightIndex,
      min,
      max,
      logScale: this.logScale,
    });
  }

  /* ---------------------------------------------------------------- 繪製 */

  render() {
    const ctx = this.ctx;
    const t = getTheme(this.themeName);
    const layout = this.layout;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.candles.length) {
      ctx.fillStyle = t.textDim;
      ctx.font = '13px system-ui';
      ctx.fillText(this.lang === 'zh' ? '載入中…' : 'Loading…', 16, 28);
      return;
    }
    const s = this._scales();
    const a = this.analysis && !this.analysis.empty ? this.analysis : null;
    const env = { ctx, s, t, a, candles: this.candles, layout, layers: this.layers, lang: this.lang };

    this._grid(ctx, t, s, layout);
    this._watermark(ctx, t, layout);

    if (a) {
      if (this.layers.sessions) L.drawSessions(env);
      if (this.layers.premiumDiscount) L.drawPremiumDiscount(env);
      if (this.layers.ote) L.drawOte(env);
      if (this.layers.fib) L.drawFib(env);
      if (this.layers.volumeProfile) L.drawVolumeProfile(env);
      if (this.layers.fvg) L.drawFvg(env);
      if (this.layers.orderBlocks || this.layers.breakers) L.drawOrderBlocks(env);
      if (this.layers.keyLevels) L.drawKeyLevels(env);
      if (this.layers.liquidity) L.drawLiquidity(env);
    }

    this._candles(ctx, t, s, layout);
    this._volume(ctx, t, s, layout);

    if (a) {
      if (this.layers.ema) L.drawEmas(env);
      if (this.layers.vwap) L.drawVwap(env);
      if (this.layers.structure) L.drawStructure(env);
      if (this.layers.swingLabels) L.drawSwingLabels(env);
      if (this.layers.sweeps) L.drawSweeps(env);
      if (this.layers.inducement) L.drawInducement(env);
      if (this.layers.setup) L.drawSetup(env);
    }

    this._priceAxis(ctx, t, s, layout);
    this._timeAxis(ctx, t, s, layout);
    this._lastPrice(ctx, t, s, layout);
    this._crosshair(ctx, t, s, layout);
    this._legend(ctx, t, layout);
  }

  _grid(ctx, t, s, layout) {
    ctx.save();
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    for (const p of priceTicks(s.min, s.max, 7)) {
      const y = Math.round(s.y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s.plotW, y);
      ctx.stroke();
    }
    for (const tk of timeTicks(this.candles, s.leftIndex, s.rightIndex, 8)) {
      const x = Math.round(s.x(tk.index)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, layout.padding.top);
      ctx.lineTo(x, layout.height - TIME_AXIS_H);
      ctx.stroke();
    }
    ctx.restore();
  }

  _watermark(ctx, t, layout) {
    const base = layout.padding.top + layout.priceHeight - 14;
    ctx.save();
    ctx.fillStyle = t.watermark;
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText('SMC TERMINAL', 18, base - 16);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(this.lang === 'zh' ? 'Smart Money Concepts 分析終端' : 'Smart Money Concepts Analysis', 20, base);
    ctx.restore();
  }

  _candles(ctx, t, s, layout) {
    const from = Math.max(0, Math.floor(s.leftIndex) - 1);
    const to = Math.min(this.candles.length - 1, Math.ceil(s.rightIndex) + 1);
    const bw = Math.max(1, s.barWidth * 0.7);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, layout.padding.top, s.plotW, layout.priceHeight);
    ctx.clip();

    if (this.chartType === 'line' || this.chartType === 'area') {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const x = s.x(i);
        const y = s.y(this.candles[i].close);
        i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = t.ema20;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (this.chartType === 'area') {
        ctx.lineTo(s.x(to), layout.padding.top + layout.priceHeight);
        ctx.lineTo(s.x(from), layout.padding.top + layout.priceHeight);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, layout.padding.top, 0, layout.padding.top + layout.priceHeight);
        g.addColorStop(0, 'rgba(91,163,245,0.25)');
        g.addColorStop(1, 'rgba(91,163,245,0)');
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    for (let i = from; i <= to; i++) {
      const c = this.candles[i];
      const x = Math.round(s.x(i));
      const up = c.close >= c.open;
      const color = up ? t.up : t.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.min(1.4, Math.max(0.7, s.barWidth * 0.14));
      ctx.beginPath();
      ctx.moveTo(x + 0.5, s.y(c.high));
      ctx.lineTo(x + 0.5, s.y(c.low));
      ctx.stroke();
      const yo = s.y(c.open);
      const yc = s.y(c.close);
      const top = Math.min(yo, yc);
      const h = Math.max(1, Math.abs(yc - yo));
      if (bw <= 1.6) {
        ctx.fillRect(x, top, 1.4, h);
      } else if (this.chartType === 'hollow' && up) {
        ctx.strokeRect(x - bw / 2 + 0.5, top + 0.5, bw, h);
      } else {
        ctx.fillRect(x - bw / 2, top, bw, h);
      }
    }
    ctx.restore();
  }

  _volume(ctx, t, s, layout) {
    const from = Math.max(0, Math.floor(s.leftIndex));
    const to = Math.min(this.candles.length - 1, Math.ceil(s.rightIndex));
    let maxV = 0;
    for (let i = from; i <= to; i++) maxV = Math.max(maxV, this.candles[i].volume || 0);
    if (!maxV) return;
    const top = layout.volumeTop;
    const h = layout.volumeHeight - 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, s.plotW, h + 4);
    ctx.clip();
    const bw = Math.max(1, s.barWidth * 0.7);
    for (let i = from; i <= to; i++) {
      const c = this.candles[i];
      const vh = ((c.volume || 0) / maxV) * h;
      ctx.fillStyle = c.close >= c.open ? t.volUp : t.volDown;
      ctx.fillRect(s.x(i) - bw / 2, top + h - vh, bw, vh);
    }
    ctx.strokeStyle = t.axis;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(s.plotW, top + 0.5);
    ctx.stroke();
    ctx.fillStyle = t.textDim;
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(`VOL ${fmtCompact(this.candles[to]?.volume)}`, 6, top + 11);
    ctx.restore();
  }

  _priceAxis(ctx, t, s, layout) {
    ctx.save();
    ctx.fillStyle = t.bg;
    ctx.fillRect(s.plotW, 0, PRICE_AXIS_W, layout.height);
    ctx.strokeStyle = t.axis;
    ctx.beginPath();
    ctx.moveTo(s.plotW + 0.5, 0);
    ctx.lineTo(s.plotW + 0.5, layout.height);
    ctx.stroke();
    ctx.fillStyle = t.textDim;
    ctx.font = '10px ui-monospace, monospace';
    const digits = precisionFor(s.max);
    for (const p of priceTicks(s.min, s.max, 7)) {
      const y = s.y(p);
      if (y < 8 || y > layout.padding.top + layout.priceHeight) continue;
      ctx.fillText(fmtPrice(p, digits), s.plotW + 6, y + 3);
    }
    ctx.restore();
  }

  _timeAxis(ctx, t, s, layout) {
    const y = layout.height - TIME_AXIS_H;
    ctx.save();
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, y, this.width, TIME_AXIS_H);
    ctx.strokeStyle = t.axis;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(this.width, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = t.textDim;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = timeTicks(this.candles, s.leftIndex, s.rightIndex, 8);
    let lastDay = null;
    for (const tk of ticks) {
      const x = s.x(tk.index);
      if (x < 20 || x > s.plotW - 10) continue;
      const d = new Date(tk.time);
      const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      const showDate = dayKey !== lastDay;
      lastDay = dayKey;
      const label = showDate
        ? fmtTime(tk.time, { tz: this.timezone, withDate: true }).slice(5)
        : fmtTime(tk.time, { tz: this.timezone, withDate: false });
      ctx.fillStyle = showDate ? t.text : t.textDim;
      ctx.fillText(label, x, y + 14);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _lastPrice(ctx, t, s, layout) {
    const c = this.candles[this.candles.length - 1];
    if (!c) return;
    const y = s.y(c.close);
    const up = c.close >= c.open;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = up ? t.up : t.down;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = up ? t.up : t.down;
    ctx.fillRect(s.plotW, y - 9, PRICE_AXIS_W, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillText(fmtPrice(c.close), s.plotW + 5, y + 3.5);
    ctx.restore();
  }

  _crosshair(ctx, t, s, layout) {
    if (!this.pointer) return;
    const { x, y } = this.pointer;
    if (x > s.plotW) return;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = t.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, layout.padding.top);
    ctx.lineTo(x + 0.5, layout.height - TIME_AXIS_H);
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(s.plotW, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    // 價格標籤
    const price = s.yToPrice(y);
    if (y < layout.padding.top + layout.priceHeight) {
      ctx.fillStyle = t.tagBg;
      ctx.fillRect(s.plotW, y - 9, PRICE_AXIS_W, 18);
      ctx.fillStyle = t.text;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(fmtPrice(price), s.plotW + 5, y + 3.5);
    }
    // 時間標籤
    const idx = Math.round(s.xToIndex(x));
    const c = this.candles[idx];
    if (c) {
      const label = fmtTime(c.time, { tz: this.timezone });
      ctx.font = '10px ui-monospace, monospace';
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = t.tagBg;
      ctx.fillRect(clamp(x - w / 2, 0, s.plotW - w), layout.height - TIME_AXIS_H + 3, w, 16);
      ctx.fillStyle = t.text;
      ctx.fillText(label, clamp(x - w / 2, 0, s.plotW - w) + 5, layout.height - TIME_AXIS_H + 14);
    }
    ctx.restore();
  }

  _legend(ctx, t, layout) {
    const info = this.pointerInfo();
    const c = info?.candle || this.candles[this.candles.length - 1];
    if (!c) return;
    const chg = ((c.close - c.open) / c.open) * 100;
    const parts = [
      `O ${fmtPrice(c.open)}`,
      `H ${fmtPrice(c.high)}`,
      `L ${fmtPrice(c.low)}`,
      `C ${fmtPrice(c.close)}`,
      `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
    ];
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    let x = 16;
    const y = layout.padding.top + 14;
    for (let i = 0; i < parts.length; i++) {
      ctx.fillStyle = i === parts.length - 1 ? (chg >= 0 ? t.up : t.down) : t.textDim;
      ctx.fillText(parts[i], x, y);
      x += ctx.measureText(parts[i]).width + 10;
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ 命中測試 */

  hitTest(px, py) {
    const a = this.analysis;
    if (!a || a.empty) return null;
    const s = this._scales();
    if (px > s.plotW) return null;
    const price = s.yToPrice(py);
    const idx = s.xToIndex(px);
    const hits = [];
    const within = (z) => price <= z.top && price >= z.bottom && idx >= z.index - 1;

    if (this.layers.orderBlocks || this.layers.breakers) {
      for (const b of a.orderBlocks) if (within(b)) hits.push({ type: 'orderblock', data: b });
    }
    if (this.layers.fvg) {
      for (const g of a.gaps) {
        if (g.kind === 'vi' && !this.layers.volumeImbalance) continue;
        if (within(g)) hits.push({ type: 'fvg', data: g });
      }
    }
    if (this.layers.liquidity) {
      for (const p of a.pools) {
        if (Math.abs(s.y(p.price) - py) < 4) hits.push({ type: 'liquidity', data: p });
      }
    }
    return hits.length ? hits.slice(0, 3) : null;
  }

  /** 匯出目前畫面為 PNG DataURL */
  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }
}
