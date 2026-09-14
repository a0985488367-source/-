/**
 * 警報系統：價格穿越、進入 POI、結構事件。
 * 使用瀏覽器通知（若使用者授權）＋ 畫面提示。
 */

import { fmtPrice, uid } from '../core/utils.js';
import { toast } from './dom.js';

export const ALERT_TYPES = {
  price: { zh: '價格穿越', en: 'Price cross' },
  poi: { zh: '進入 POI', en: 'Enter POI' },
  structure: { zh: '結構事件 (BOS/CHoCH)', en: 'Structure event' },
  sweep: { zh: '流動性掃除', en: 'Liquidity sweep' },
};

export function createAlert({ symbol, interval, type, level, note }) {
  return {
    id: uid('al'),
    symbol,
    interval,
    type,
    level: level ? Number(level) : null,
    note: note || '',
    createdAt: Date.now(),
    triggeredAt: null,
    active: true,
  };
}

export class AlertEngine {
  constructor(state) {
    this.state = state;
    this.lastPrice = new Map();
    this.lastEventId = new Map();
    this.lastSweepId = new Map();
  }

  requestPermission() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  notify(title, body) {
    toast(`${title} — ${body}`, 'alert', 6000);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body, tag: title + body });
      }
    } catch {}
  }

  /** 每次分析更新後呼叫 */
  check(symbol, interval, analysis, lang = 'zh') {
    if (!analysis || analysis.empty) return;
    const price = analysis.price;
    const prev = this.lastPrice.get(symbol);
    this.lastPrice.set(symbol, price);

    for (const al of this.state.alerts) {
      if (!al.active || al.symbol !== symbol) continue;
      if (al.type === 'price' && prev != null && al.level) {
        const crossedUp = prev < al.level && price >= al.level;
        const crossedDown = prev > al.level && price <= al.level;
        if (crossedUp || crossedDown) this.fire(al, `${symbol} ${lang === 'zh' ? '價格穿越' : 'crossed'} ${fmtPrice(al.level)}`, lang);
      }
      if (al.type === 'poi') {
        const hit = analysis.pois.find((p) => price <= p.top && price >= p.bottom);
        if (hit) this.fire(al, `${symbol} ${lang === 'zh' ? '進入' : 'entered'} ${hit.type} ${fmtPrice(hit.bottom)}–${fmtPrice(hit.top)}`, lang);
      }
      if (al.type === 'structure') {
        const ev = analysis.structure.internal.lastEvent;
        if (ev && this.lastEventId.get(symbol) !== ev.id) {
          this.lastEventId.set(symbol, ev.id);
          if (analysis.candles.length - ev.breakIndex <= 2) {
            this.fire(al, `${symbol} ${ev.type} ${ev.dir === 'bull' ? '↑' : '↓'} @ ${fmtPrice(ev.price)}`, lang, false);
          }
        }
      }
      if (al.type === 'sweep') {
        const sw = analysis.sweeps[analysis.sweeps.length - 1];
        if (sw && this.lastSweepId.get(symbol) !== sw.id && analysis.candles.length - sw.index <= 2) {
          this.lastSweepId.set(symbol, sw.id);
          this.fire(al, `${symbol} ${lang === 'zh' ? '流動性掃除' : 'sweep'} ${sw.side} @ ${fmtPrice(sw.level)}`, lang, false);
        }
      }
    }
  }

  fire(alert, message, lang, deactivate = true) {
    if (alert.triggeredAt && Date.now() - alert.triggeredAt < 60_000) return;
    alert.triggeredAt = Date.now();
    if (deactivate && alert.type === 'price') alert.active = false;
    this.notify(lang === 'zh' ? '⚡ SMC 警報' : '⚡ SMC Alert', message + (alert.note ? ` · ${alert.note}` : ''));
  }
}

export function renderAlerts(alerts, lang) {
  if (!alerts.length) return `<p class="dim pad">${lang === 'zh' ? '尚未建立警報。' : 'No alerts yet.'}</p>`;
  return `<ul class="alert-list">${alerts.map((a) => `
    <li class="${a.active ? '' : 'muted'}">
      <div><b>${a.symbol}</b> <span class="dim">${a.interval}</span>
        <span class="pill pill--sm">${(ALERT_TYPES[a.type] || {})[lang] || a.type}</span></div>
      <div class="mono">${a.level ? fmtPrice(a.level) : '—'} ${a.note ? `<span class="dim">· ${a.note}</span>` : ''}</div>
      <button class="btn btn--icon" data-del-alert="${a.id}" title="delete">✕</button>
    </li>`).join('')}</ul>`;
}
