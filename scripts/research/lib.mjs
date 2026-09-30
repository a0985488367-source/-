import { PROVIDERS } from '../../src/data/providers.js';
import { buildLadder, stepTrade, DEFAULT_MANAGEMENT } from '../../src/smc/manage.js';

export const opt = (args, n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);

/** 抓最近 limit 根 K 線；交易所單次最多給 1000 根，超過就用 endTime 往前一段一段補 */
export async function klines(symbol, interval, limit) {
  let err;
  for (const id of ['binance', 'okx', 'bybit']) {
    try { return await pagedKlines(PROVIDERS[id], symbol, interval, limit); }
    catch (e) { err = e; }
  }
  throw err;
}

export async function pagedKlines(provider, symbol, interval, limit) {
  let out = [];
  let endTime;
  while (out.length < limit) {
    const page = await provider.fetchKlines(symbol, interval, { limit: Math.min(1000, limit - out.length), endTime });
    const older = page.filter((c) => !out.length || c.time < out[0].time);
    if (!older.length) break; // 已經到上市第一根
    out = [...older, ...out];
    endTime = out[0].time - 1;
  }
  return out.slice(-limit);
}

/**
 * 研究用：改寫訊號的止盈目標（線上不用）
 *   fixedTpR  整筆在固定 R 一次出場，取代原本的結構目標
 *   tpScale   原本每個目標離進場價的距離都乘上這個倍數（例如 0.75＝全部拉近四分之一）
 */
export function researchTargets(sig, cfg = {}) {
  const risk = Math.abs(sig.entry - sig.stop);
  const dir = sig.stop < sig.entry ? 1 : -1;
  if (cfg.fixedTpR > 0) {
    return [{ name: 'TP1', price: sig.entry + dir * risk * cfg.fixedTpR, rr: cfg.fixedTpR }];
  }
  if (cfg.tpScale > 0 && cfg.tpScale !== 1) {
    return sig.targets.map((t) => ({ ...t, price: sig.entry + (t.price - sig.entry) * cfg.tpScale, rr: t.rr * cfg.tpScale }));
  }
  return sig.targets;
}

/**
 * 研究用：把停損拉近（線上不用）
 *   tightStopKeepSize  倉位照原本停損算，停損拉到原距離的這個倍數 → 打到只虧這麼多 R（R 仍以原停損為準）
 *   tightStopResize    停損拉到原距離的這個倍數，倉位照新停損重新算 → 打到一樣虧 1R，但倉位變大、手續費佔比變高
 */
export function applyStopResearch(t, cfg = {}) {
  const k = cfg.tightStopKeepSize || cfg.tightStopResize;
  if (!(k > 0 && k < 1)) return t;
  const newStop = t.entry - (t.entry - t.stop) * k;
  if (cfg.tightStopKeepSize) {
    t.initialStop = t.stop;
    t.stop = newStop;
  } else {
    t.stop = newStop;
    t.initialStop = newStop;
    if (Number.isFinite(t.stopPct)) t.stopPct *= k;
  }
  return t;
}

const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 };

/** 第一根 time >= t 的索引（沒有就 -1） */
function firstAtOrAfter(candles, t) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (candles[m].time >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
}

/**
 * 讓每個訊號照管理規則往後逐根跑到結束；還沒結束的不計入。
 * cfg.subBars：訊號照原週期產生，進場之後改用細 K 棒（candlesBy 的 `${symbol}|sub`，cfg.subMinutes 分鐘）
 * 一根一根跑 —— 這樣限價單成交那根裡面「先漲還是先跌」就不用猜；等待／持有的根數照比例換算。
 * 細 K 棒沒涵蓋到的訊號直接略過。
 */
export function runSignals(signals, candlesBy, cfg) {
  const closed = [];
  for (const sig of signals) {
    let candles = candlesBy.get(`${sig.symbol}|${sig.interval}`);
    let start = sig.index + 1;
    let stepCfg = cfg;
    if (cfg.subBars) {
      const sub = candlesBy.get(`${sig.symbol}|sub`);
      const next = candles[sig.index + 1];
      if (!sub?.length || !next || next.time < sub[0].time) continue;
      start = firstAtOrAfter(sub, next.time);
      if (start < 0) continue;
      candles = sub;
      const k = TF_MINUTES[sig.interval] / (cfg.subMinutes ?? 5);
      const o = { ...DEFAULT_MANAGEMENT, ...cfg };
      stepCfg = { ...cfg, entryWindowBars: o.entryWindowBars * k, maxHoldBars: o.maxHoldBars * k, stallBars: o.stallBars * k };
    }
    const t = {
      ...sig,
      targets: buildLadder(sig.entry, sig.stop, researchTargets(sig, cfg), cfg),
      status: sig.entryType === 'market' ? 'active' : 'pending',
      hitTargets: [], events: [], remaining: 1, realizedR: 0,
      barsSinceOpen: 0, barsSinceFill: 0, maxFavorableR: 0, maxAdverseR: 0,
    };
    applyStopResearch(t, cfg);
    for (let j = start; j < candles.length; j++) {
      if (stepTrade(t, candles[j], stepCfg)) break;
    }
    if (t.status === 'pending' || t.status === 'active') continue;
    closed.push(t);
  }
  return closed;
}

export function summarize(closed) {
  const traded = closed.filter((t) => t.status !== 'expired' || t.exitReason === 'maxHold');
  const unfilled = closed.length - traded.length;
  if (!traded.length) return { n: 0, unfilled };
  const wins = traded.filter((t) => t.r > 0);
  const totalR = traded.reduce((s, t) => s + t.r, 0);
  const gw = wins.reduce((s, t) => s + t.r, 0);
  const gl = Math.abs(traded.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const t of traded) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n: traded.length, unfilled,
    winRate: (wins.length / traded.length) * 100,
    totalR, expectancy: totalR / traded.length,
    avgWin: wins.length ? gw / wins.length : 0,
    avgLoss: traded.length - wins.length ? -gl / (traded.length - wins.length) : 0,
    profitFactor: gl ? gw / gl : Infinity,
    maxDdR: dd,
  };
}

export const pct = (v) => `${v.toFixed(1)}%`;
export const r2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

export function printTable(log, head, body) {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(w[i])).join('  ');
  log(line(head));
  log(w.map((n) => '─'.repeat(n)).join('  '));
  for (const b of body) log(line(b));
}

/**
 * 帳戶層級模擬：照時間開倉／平倉，每筆冒「開倉當下帳戶」的 riskPct%，平倉時 r 直接滾進帳戶（複利）。
 * trades 需要 filledTime、closedTime、r（已扣手續費）、symbol、dir、beTime（停損移到成本價的時間，沒有就 null）。
 *   oneBySymbol       同一個幣已經有持倉就不再開
 *   maxAtRisk         還沒保本（停損還在成本價另一側）的持倉最多幾筆
 *   maxSameDirAtRisk  同一個方向、還沒保本的持倉最多幾筆
 *   maxNewPerHour     最近一小時內最多新開幾筆
 *   stackScale        每多一筆還沒保本的持倉，新單的風險就再乘上這個倍數（0.5＝5%、2.5%、1.25%…）
 *   dailyStopPct      當天（台灣時間）帳戶從當天開始跌超過這個 % 就不再開新單，隔天恢復
 *   skip              (t) => true 的單不開
 * 回撤用平倉後的帳戶計算（持倉中的浮動虧損不算），所以實際會再大一點。
 */
/**
 * 自營商考試模擬（兩步挑戰）：從 startTime 開始考，照「考試守門員」的做法一筆一筆接交易。
 *   - 每筆風險 = min(淨值 × riskPct%、今天剩餘空間的一半、總剩餘空間的四分之一)，槓桿不超過 maxLeverage
 *   - 今天虧到 selfStop（每日上限的比例，含持倉停損）就不再開新單；lockProfitDay 時當天賺到獲利日門檻也收工
 *   - 一天從 UTC 0 點開始；碰到每日虧損上限或最大損失底線就失敗（只看平倉後的淨值，持倉中的浮虧看不到）
 *   - 達到目標而且獲利日夠了就過關（手上的單當作平掉），接著從起始資金開始考下一階段
 * trades：{ filledTime, closedTime, r（扣完手續費的 R）, stopPct（停損距離占進場價比例）, symbol, dir }，照 filledTime 排序
 * 回傳 { result: 'pass' | 'fail-daily' | 'fail-total' | 'open', phase（卡在第幾階段，0 起算）, days, phaseDays: [] }
 */
export function simulateProp(trades, {
  startTime, account = 10000, targets = [500, 1000], dailyLoss = 500, maxLoss = 1000,
  minDayProfit = 50, minProfitDays = 3, riskPct = 0.5, maxOpen = 5, maxLeverage = 5,
  selfStop = 0.5, lockProfitDay = false,
  // endTime：到這個時間還沒過關就算沒過（有期限的衝刺）
  // aggressive：不照守門員縮倉位，每筆固定 riskPct；只守一條硬規則——所有持倉一起停損也不會超過今天的虧損上限跟總額底線
  endTime = Infinity, aggressive = false,
} = {}) {
  const DAY = 86_400_000;
  const ev = [];
  trades.forEach((t, i) => {
    if (t.filledTime < startTime || t.filledTime >= endTime) return;
    ev.push({ time: t.filledTime, kind: 1, i });
    ev.push({ time: Math.max(t.closedTime, t.filledTime + 1), kind: 0, i });
  });
  ev.sort((a, b) => a.time - b.time || a.kind - b.kind);

  let phase = 0;
  let phaseStart = startTime;
  const phaseDays = [];
  let equity = account;
  let day = Math.floor(startTime / DAY);
  let dayStart = account;
  let profitDays = 0;
  let open = new Map();
  const result = (r, time) => ({ result: r, phase, days: (time - startTime) / DAY, phaseDays });

  const rollDay = (time) => {
    const d = Math.floor(time / DAY);
    if (d === day) return;
    if (equity - dayStart >= minDayProfit) profitDays += 1;
    day = d;
    dayStart = equity;
  };
  const passed = () => equity >= account + targets[phase]
    && profitDays + (equity - dayStart >= minDayProfit ? 1 : 0) >= minProfitDays;

  for (const e of ev) {
    if (e.time >= endTime) break;
    rollDay(e.time);
    const t = trades[e.i];
    if (e.kind === 0) {
      const p = open.get(e.i);
      if (!p) continue;
      open.delete(e.i);
      equity += p.risk * t.r;
      if (equity <= account - maxLoss) return result('fail-total', e.time);
      if (equity <= dayStart - dailyLoss) return result('fail-daily', e.time);
      if (passed()) {
        phaseDays.push((e.time - phaseStart) / DAY);
        if (phase === targets.length - 1) return result('pass', e.time);
        phase += 1;
        phaseStart = e.time;
        equity = account;
        dayStart = account;
        profitDays = 0;
        open = new Map();
      }
      continue;
    }
    const positions = [...open.values()];
    if (positions.length >= maxOpen || positions.some((p) => p.symbol === t.symbol)) continue;
    const openRisk = positions.reduce((a, p) => a + p.risk, 0);
    if (!aggressive && dayStart - equity + openRisk >= dailyLoss * selfStop) continue;
    if (lockProfitDay && equity - dayStart >= minDayProfit) continue;
    const dailyRoom = equity - (dayStart - dailyLoss) - openRisk;
    const totalRoom = equity - (account - maxLoss) - openRisk;
    let risk = aggressive
      ? Math.min((account * riskPct) / 100, dailyRoom * 0.95, totalRoom * 0.95)
      : Math.min((equity * riskPct) / 100, dailyRoom * 0.5, totalRoom * 0.25);
    if (t.stopPct > 0) risk = Math.min(risk, maxLeverage * equity * t.stopPct);
    if (!(risk > account * 0.0005)) continue;
    open.set(e.i, { risk, symbol: t.symbol });
  }
  return result('open', Number.isFinite(endTime) ? endTime : ev.length ? ev[ev.length - 1].time : startTime);
}

export function simulatePortfolio(trades, {
  riskPct = 5, maxAtRisk = Infinity, oneBySymbol = false, maxSameDirAtRisk = Infinity,
  maxNewPerHour = Infinity, stackScale = 1, dailyStopPct = 0, skip = null,
} = {}) {
  const ev = [];
  trades.forEach((t, i) => {
    ev.push({ time: t.filledTime, kind: 1, i });
    ev.push({ time: Math.max(t.closedTime, t.filledTime + 1), kind: 0, i });
  });
  ev.sort((a, b) => a.time - b.time || a.kind - b.kind);
  const HOUR = 3_600_000;
  const dayOf = (ms) => Math.floor((ms + 8 * HOUR) / (24 * HOUR));
  let equity = 1, peak = 1, maxDd = 0, taken = 0;
  let day = null, dayStart = 1;
  const opened = [];
  const open = new Map();
  for (const e of ev) {
    const t = trades[e.i];
    if (e.kind === 0) {
      const p = open.get(e.i);
      if (!p) continue;
      open.delete(e.i);
      equity += p.risk * t.r;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, 1 - equity / peak);
      continue;
    }
    if (dayOf(e.time) !== day) { day = dayOf(e.time); dayStart = equity; }
    if (skip && skip(t)) continue;
    if (dailyStopPct > 0 && equity < dayStart * (1 - dailyStopPct / 100)) continue;
    const positions = [...open.values()];
    if (oneBySymbol && positions.some((p) => p.symbol === t.symbol)) continue;
    const atRisk = positions.filter((p) => !(p.beTime != null && p.beTime <= e.time));
    if (atRisk.length >= maxAtRisk) continue;
    if (atRisk.filter((p) => p.dir === t.dir).length >= maxSameDirAtRisk) continue;
    while (opened.length && opened[0] <= e.time - HOUR) opened.shift();
    if (opened.length >= maxNewPerHour) continue;
    opened.push(e.time);
    const scale = stackScale ** atRisk.length;
    open.set(e.i, { risk: (equity * riskPct * scale) / 100, symbol: t.symbol, dir: t.dir, beTime: t.beTime });
    taken++;
  }
  return { taken, multiple: equity, maxDdPct: maxDd * 100 };
}

/**
 * 考試規則下「哪一組訊號過關最快」的比較表（alt-strategies／smc-mix 的 --prop-compare 共用）。
 * groups：[{ name, trades }]，trades 的 r 要是扣完手續費的 R，照 filledTime 排序。
 * 每組算：每天幾筆、每筆平均 R、衝刺（每筆 2%、最多 5 張、30 天期限）過關／爆掉機率與平均要買幾次、
 * 穩穩考（每筆 1%、守門員縮倉位）有結果的開考裡過關要幾天（中位數）。
 */
export function propCompare(groups, { log, fee = 59.4, sprintRisk = 2, guardRisk = 1, maxOpen = 5, deadline = 30, stepDays = 2 } = {}) {
  const DAY = 86_400_000;
  const rules = { account: 10000, targets: [500, 1000], dailyLoss: 500, maxLoss: 1000, minDayProfit: 50, minProfitDays: 3, maxLeverage: 5 };
  const rows = [];
  const json = [];
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  for (const g of groups) {
    const xs = [...g.trades].filter((t) => Number.isFinite(t.r) && Number.isFinite(t.filledTime)).sort((a, b) => a.filledTime - b.filledTime);
    if (xs.length < 10) { rows.push([g.name, String(xs.length), '-', '-', '-', '-', '-', '-']); continue; }
    const first = xs[0].filledTime;
    const last = Math.max(...xs.map((t) => t.closedTime));
    const days = (last - first) / DAY;
    const avgR = xs.reduce((a, t) => a + t.r, 0) / xs.length;
    let n = 0, pass = 0, fail = 0;
    for (let st = Math.ceil(first / DAY) * DAY; st + deadline * DAY <= last; st += DAY) {
      const r = simulateProp(xs, { ...rules, startTime: st, endTime: st + deadline * DAY, riskPct: sprintRisk, maxOpen, aggressive: true });
      n++;
      if (r.result === 'pass') pass++;
      else if (r.result.startsWith('fail')) fail++;
    }
    const guardDays = [];
    let gn = 0, gdone = 0;
    for (let st = first; st < last - 7 * DAY; st += stepDays * DAY) {
      const r = simulateProp(xs, { ...rules, startTime: st, riskPct: guardRisk, maxOpen });
      gn++;
      if (r.result !== 'open') gdone++;
      if (r.result === 'pass') guardDays.push(r.days);
    }
    const p = n ? pass / n : NaN;
    json.push({ g: g.name, n: xs.length, perDay: Math.round((xs.length / days) * 10) / 10, avgR: Math.round(avgR * 1000) / 1000,
      sprint: { n, pass, fail }, guard: { n: gn, done: gdone, pass: guardDays.length, med: Math.round(med(guardDays)) } });
    rows.push([
      g.name, String(xs.length), (xs.length / days).toFixed(1), avgR.toFixed(3),
      n ? pct(p * 100) : '-', n ? pct((fail / n) * 100) : '-',
      p > 0 ? `${(1 / p).toFixed(1)} 次（${(fee / p).toFixed(0)}U）` : n ? '過不了' : '-',
      guardDays.length ? `${med(guardDays).toFixed(0)} 天（${gdone}/${gn} 有結果）` : `—（${gdone}/${gn} 有結果）`,
    ]);
  }
  printTable(log, ['訊號組', '筆數', '每天幾筆', '每筆淨 R', `衝刺 ${sprintRisk}% ${deadline} 天內全過`, '衝刺爆掉', '平均要買幾次', `穩穩考 ${guardRisk}% 過關天數（中位）`], rows);
  return json;
}
