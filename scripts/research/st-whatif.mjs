#!/usr/bin/env node
/**
 * 超級趨勢 Demo 實單「如果沒有手動平倉」會怎樣（2026-10-15 使用者要的）
 *
 * 1. 跟 Executor 拿 Demo 帳戶成交明細（GET /history），還原成一筆一筆的交易，只留超級趨勢（st:）
 * 2. 每筆用下單編號找出訊號那根 4h K 棒，重算當時的停損距離（2 ATR，跟線上同一份 trendExtraSignal）
 * 3. 從實際進場價、實際開倉時間開始，用 5 分鐘 K 棒照線上規則走：
 *    賺到 1R 停損移到成本＋0.05R、賺到 1.5R 之後停損追蹤在「最高獲利 − 1.5R」（EMA_CROSS_* 預設值）
 *    同一根 5 分 K 先看有沒有打到停損，再用這根的有利極值更新停損（保守）
 * 4. 跟實際結果比；還沒打到停損的用最新價格算「現在還開著的話」
 *
 * 用法（demo-report.yml 的 mode=st-whatif）：EXECUTOR_URL=… EXECUTOR_HMAC_SECRET=… DAYS=30 node scripts/research/st-whatif.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { rebuildTrades } from '../lib/demo-trades.mjs';
import { klines as anyKlines, pagedKlines } from './lib.mjs';
import { PROVIDERS } from '../../src/data/providers.js';
// Demo 單在 Bybit 成交，K 線優先用 Bybit（別家的影線不一樣，會誤判停損）
const klines = (s, iv, n) => pagedKlines(PROVIDERS.bybit, s, iv, n).catch(() => anyKlines(s, iv, n));
import { trendExtraSignal } from '../../src/strategies/trend-extra.js';

const URL_BASE = String(process.env.EXECUTOR_URL || '').replace(/\/$/, '');
const SECRET = process.env.EXECUTOR_HMAC_SECRET || '';
const DAYS = Number(process.env.DAYS || 30);
const M = { beR: 1, beOffR: 0.05, trailFromR: 1.5, trailGapR: 1.5 };
const FEE = 0.00055; // taker，進出各一次
const H4 = 4 * 3600e3, M5 = 5 * 60e3;

async function executorGet(path) {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  const res = await fetch(URL_BASE + path, { headers: { 'x-executor-timestamp': ts, 'x-executor-signature': sig } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const day = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const u = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}U`;
const rr = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;

/** 照線上規則從進場走到停損（或到現在還開著） */
export function walk(bars, { long, entry, stop0, openTime, risk = Math.abs(entry - stop0) }) {
  let stop = stop0, maxFav = 0, be = false;
  for (const b of bars) {
    if (b.time + M5 <= openTime) continue;
    if (long ? b.low <= stop : b.high >= stop) return { exit: stop, exitTime: b.time, maxFav, closed: true, be };
    const favR = long ? (b.high - entry) / risk : (entry - b.low) / risk;
    maxFav = Math.max(maxFav, favR);
    let next = stop;
    if (maxFav >= M.beR) { const p = long ? entry + risk * M.beOffR : entry - risk * M.beOffR; if (long ? p > next : p < next) { next = p; be = true; } }
    if (maxFav >= M.trailFromR) { const p = long ? entry + risk * (maxFav - M.trailGapR) : entry - risk * (maxFav - M.trailGapR); if (long ? p > next : p < next) next = p; }
    stop = next;
  }
  const last = bars.at(-1);
  return { exit: last.close, exitTime: last.time, maxFav, closed: false, be, stop };
}

(async () => {
  if (!URL_BASE || !SECRET) throw new Error('缺少 EXECUTOR_URL 或 EXECUTOR_HMAC_SECRET');
  const hist = await executorGet(`/history?days=${DAYS}`);
  const { trades, stillOpen } = rebuildTrades(hist.executions);
  const st = [...trades, ...stillOpen.map((t) => ({ ...t, open: true }))].filter((t) => t.strategy === 'st').sort((a, b) => a.openTime - b.openTime);
  const out = [];
  let sumA = 0, sumS = 0, sumAR = 0, sumSR = 0;
  for (const t of st) {
    try {
      const m = /^st:([A-Z0-9]+):([ls]):(\w+):([0-9a-z]+)$/.exec(t.orderLinkId);
      if (!m) { out.push(`${t.symbol} 下單編號看不懂：${t.orderLinkId}`); continue; }
      const barOpen = parseInt(m[4], 36) * 3600e3, long = m[2] === 'l';
      const h4 = await klines(t.symbol, '4h', Math.ceil((Date.now() - barOpen) / H4) + 320);
      const i = h4.findIndex((c) => c.time === barOpen);
      if (i < 0) { out.push(`${t.symbol} 找不到訊號 K 棒`); continue; }
      const sig = trendExtraSignal('st', h4.slice(0, i + 1));
      if (!sig) { out.push(`${t.symbol} 重算沒有訊號（資料來源不同）`); continue; }
      const entry = t.avg, risk = sig.stopDistance, stop0 = long ? entry - risk : entry + risk;
      const qty = t.maxSize, riskU = qty * risk;
      const m5 = await klines(t.symbol, '5m', Math.ceil((Date.now() - t.openTime) / M5) + 3);
      let w = walk(m5, { long, entry, stop0, openTime: t.openTime }), adj = false;
      // 模擬的停損是用成交價重算的，跟實際掛的差一點點；實際上那時候沒被打到（後來才手動平倉），就把停損放到那段期間的極值外面再走一次
      if (!t.open && w.closed && !w.be && w.exitTime < t.closeTime) {
        const seg = m5.filter((b) => b.time + M5 > t.openTime && b.time <= Math.min(t.closeTime, w.exitTime + M5));
        const ext = long ? Math.min(...seg.map((b) => b.low)) : Math.max(...seg.map((b) => b.high));
        const s2 = long ? Math.min(stop0, ext * (1 - 1e-5)) : Math.max(stop0, ext * (1 + 1e-5));
        if (Math.abs(s2 - stop0) / risk < 0.15) { w = walk(m5, { long, entry, stop0: s2, openTime: t.openTime, risk }); adj = true; }
      }
      const simR = (long ? w.exit - entry : entry - w.exit) / risk;
      const simU = simR * riskU - qty * (entry + w.exit) * FEE;
      const actU = t.open ? null : t.pnl, actR = actU == null ? null : actU / riskU;
      const manual = !t.open && !/^StopLoss/.test(t.exitBy || '');
      if (actU != null) { sumA += actU; sumAR += actR; }
      sumS += simU; sumSR += simU / riskU;
      out.push(`${day(t.openTime)} ${t.symbol.replace(/USDT$/, '')} ${long ? '多' : '空'}｜進 ${+entry.toPrecision(6)} 停 ${+stop0.toPrecision(6)}（1R=${riskU.toFixed(1)}U）｜實際：${t.open ? '還開著' : `${manual ? '手動' : '停損'}平倉 ${day(t.closeTime)} ${u(actU)}（${rr(actR)}）`}｜沒手動的話：${w.closed ? `${day(w.exitTime)} ${w.be ? (w.maxFav >= M.trailFromR ? '追蹤停損' : '保本停損') : '原始停損'}出場` : `到現在還開著（停損 ${+w.stop.toPrecision(6)}）`}${adj ? '※停損照實際沒被打到' : ''} ${u(simU)}（${rr(simU / riskU)}）・最多浮盈 ${w.maxFav.toFixed(2)}R`);
    } catch (e) { out.push(`${t.symbol} 失敗：${e.message}`); }
  }
  out.push(`合計 ${st.length} 筆｜實際 ${u(sumA)}（${rr(sumAR)}）｜沒手動平倉的話 ${u(sumS)}（${rr(sumSR)}，還開著的用現價算）`);
  for (const l of out) console.log(l);
  const enc = (x) => x.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for (let k = 0; k < out.length; k += 10) console.log(`::notice title=超級趨勢 what-if ${k / 10 + 1}::${enc(out.slice(k, k + 10).join('\n'))}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.map((l) => `- ${l}`).join('\n') + '\n');
})().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
