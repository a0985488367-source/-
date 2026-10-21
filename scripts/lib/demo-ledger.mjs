/**
 * Demo 帳戶「錢跑去哪」對帳：把每段時間的帳戶餘額變化，拆成
 *   已平倉損益（Bybit closed-pnl，已含手續費）＋資金費（成交明細 execType=Funding）＋對不上的部分，
 * 已平倉損益再依開倉那筆的 orderLinkId 分到各策略（手動單沒有編號）。
 *
 * 為什麼另外做：demo-report 的「一筆一筆還原」只算區間內完整開平、而且部位回到 0 的交易，
 * 區間前就開著的、分批平但還沒平完的、同幣不同策略疊在一起的都會漏掉；這裡直接用 Bybit 自己算的已平倉損益。
 */

import { strategyOf } from './demo-trades.mjs';

/**
 * 每筆已平倉損益算哪個策略：同一個幣、在這筆平倉之前最近一次「開倉／加倉」成交（closedSize=0）的 orderLinkId。
 * 找不到（區間前就開著）就算「不明」。
 */
export function attributeClosedPnl(executions, closedPnl) {
  const opens = new Map();
  for (const e of executions) {
    if ((e.execType ?? 'Trade') !== 'Trade' || Number(e.closedSize) > 0 || !(Number(e.execQty) > 0)) continue;
    if (!opens.has(e.symbol)) opens.set(e.symbol, []);
    opens.get(e.symbol).push(e);
  }
  for (const xs of opens.values()) xs.sort((a, b) => a.execTime - b.execTime);
  return closedPnl.map((p) => {
    const t = p.updatedTime || p.createdTime; // updatedTime＝真正平倉的時間（createdTime 可能是停損單掛出去的時間）
    const xs = opens.get(p.symbol) || [];
    let hit = null;
    for (const e of xs) { if (e.execTime <= t) hit = e; else break; }
    return { ...p, time: t, strategy: hit ? strategyOf(hit.orderLinkId) : 'unknown' };
  });
}

/**
 * 依餘額快照切段：snapshots=[{time,balance}]（舊到新，最後一筆可以是「現在」）。
 * 回傳每段的餘額變化、已平倉損益（分策略）、資金費、其他特殊成交（強平 BustTrade、ADL 等）、對不上的差額。
 */
export function ledgerByWindow({ executions, closedPnl, snapshots }) {
  const attributed = attributeClosedPnl(executions, closedPnl);
  const out = [];
  for (let i = 1; i < snapshots.length; i++) {
    const from = snapshots[i - 1].time, to = snapshots[i].time;
    const inWin = (t) => t > from && t <= to;
    const byStrategy = {};
    let closed = 0;
    for (const p of attributed) {
      if (!inWin(p.time)) continue;
      closed += p.closedPnl;
      byStrategy[p.strategy] = (byStrategy[p.strategy] || 0) + p.closedPnl;
    }
    let funding = 0, fundingN = 0;
    const special = {};
    for (const e of executions) {
      if (!inWin(e.execTime)) continue;
      const type = e.execType ?? 'Trade';
      if (type === 'Funding') { funding -= Number(e.execFee) || 0; fundingN++; } // execFee 正＝付出
      else if (type !== 'Trade') special[type] = (special[type] || 0) + 1;
    }
    const change = snapshots[i].balance - snapshots[i - 1].balance;
    out.push({ from, to, start: snapshots[i - 1].balance, end: snapshots[i].balance, change, closed, byStrategy, funding, fundingN, special, unexplained: change - closed - funding });
  }
  return out;
}

/**
 * 資金流水（Executor GET /ledger 的 logs）依餘額快照分段，每段每種類型（TRADE、SETTLEMENT 資金費、TRANSFER_OUT…）×幣別加總，
 * 再找「流水沒記到的餘額跳動」：同一個幣照時間排，上一筆餘額＋這筆變動 ≠ 這筆餘額，差額就是中間有沒記錄的變動
 * （例如 Demo 調整模擬資金）。Bybit 回傳是新到舊，同一毫秒的照回傳順序倒過來排。
 */
export function summarizeTxLog(logs, snapshots, { gapMin = 5 } = {}) {
  const sorted = logs.map((l, i) => ({ ...l, _i: i })).sort((a, b) => a.time - b.time || b._i - a._i);
  const gaps = [];
  const last = new Map();
  for (const l of sorted) {
    const prev = last.get(l.currency);
    if (prev) {
      const gap = l.cashBalance - (prev.cashBalance + l.change);
      if (Math.abs(gap) >= gapMin) gaps.push({ currency: l.currency, from: prev.time, to: l.time, before: prev.cashBalance, after: l.cashBalance - l.change, gap });
    }
    last.set(l.currency, l);
  }
  const windows = [];
  for (let i = 1; i < snapshots.length; i++) {
    const from = snapshots[i - 1].time, to = snapshots[i].time;
    const inWin = (t) => t > from && t <= to;
    const byType = {};
    for (const l of sorted) {
      if (!inWin(l.time)) continue;
      const k = `${l.type}${l.category ? '/' + l.category : ''} ${l.currency}`;
      const r = (byType[k] ||= { n: 0, change: 0 });
      r.n++; r.change += l.change;
    }
    windows.push({ from, to, byType, gaps: gaps.filter((g) => inWin(g.to)) });
  }
  return { windows, gaps, first: sorted[0] || null, last: sorted[sorted.length - 1] || null };
}
