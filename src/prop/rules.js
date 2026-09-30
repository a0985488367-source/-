/**
 * 自營商（Prop Firm）考試規則：狀態計算與倉位計算（純函式，網頁跟測試共用）。
 *
 * 平台規則的細節（每日虧損用餘額還是淨值、幾點重置、最大損失是固定還是追蹤）使用者沒辦法點開說明，
 * 所以一律採「最嚴格」的算法：
 *   - 每日虧損：含未平倉（用淨值），UTC 0 點（台灣早上 8 點）重置，
 *     底線 = 今天起始淨值 − 每日虧損上限
 *   - 最大帳戶損失：固定底線 = 起始資金 − 最大損失（不會跟著最高點往上移）
 *   - 獲利日：當天淨值增加 ≥ 起始資金 × 最小日盈利
 */

export const PRESETS = {
  'two-step-10k': {
    name: '兩步挑戰 10000 USDT',
    account: 10000,
    phases: [
      { name: '階段一', target: 500 },
      { name: '階段二', target: 1000 },
    ],
    dailyLoss: 500,
    maxLoss: 1000,
    minDayProfitPct: 0.5,
    minProfitDays: 3,
    maxLeverage: 5,
  },
};

const DAY_MS = 86_400_000;

/** UTC 日期（考試的「一天」從 UTC 0 點開始 = 台灣早上 8 點） */
export function dayKey(ts) {
  return new Date(Math.floor(ts / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** 依時間排序、去掉壞資料的淨值紀錄 */
function clean(snapshots) {
  return (snapshots || [])
    .filter((s) => s && Number.isFinite(s.time) && Number.isFinite(s.equity) && s.equity > 0)
    .sort((a, b) => a.time - b.time);
}

/**
 * 每一天的起始淨值、收盤淨值、當天最低淨值。
 * 起始淨值 = 前一天最後一筆紀錄（沒有就用起始資金）。
 */
export function dailyBreakdown(rules, snapshots) {
  const list = clean(snapshots);
  const days = [];
  let prevEnd = rules.account;
  for (const s of list) {
    const key = dayKey(s.time);
    let d = days[days.length - 1];
    if (!d || d.day !== key) {
      d = { day: key, start: prevEnd, end: s.equity, low: s.equity, count: 0 };
      days.push(d);
    }
    d.end = s.equity;
    d.low = Math.min(d.low, s.equity);
    d.count += 1;
    prevEnd = s.equity;
  }
  const minProfit = rules.account * rules.minDayProfitPct / 100;
  return days.map((d) => ({
    ...d,
    pnl: d.end - d.start,
    profitable: d.end - d.start >= minProfit,
    breachedDaily: d.low <= d.start - rules.dailyLoss,
  }));
}

/**
 * 考試現況。
 * @param {object} p
 *   rules        PRESETS 裡的一組規則
 *   phase        0 = 階段一, 1 = 階段二
 *   snapshots    [{ time, equity }] 使用者輸入的淨值紀錄（含未平倉）
 *   now          現在時間（毫秒）
 *   todayStart   手動指定今天起始淨值（平台上看到的），不填就用紀錄推算
 *   openRisk     目前持倉如果全部打到停損，還會再虧多少（還沒反映在淨值裡的部分）
 *   selfStopPct  自己的每日停手線：虧到每日上限的幾 % 就收工（預設 50%）
 */
export function challengeStatus({ rules, phase = 0, snapshots = [], now = Date.now(), todayStart = null, openRisk = 0, selfStopPct = 50, mode = 'guard' }) {
  const list = clean(snapshots);
  const equity = list.length ? list[list.length - 1].equity : rules.account;
  const today = dayKey(now);
  const days = dailyBreakdown(rules, list);
  const todayRow = days.find((d) => d.day === today);
  const beforeToday = list.filter((s) => dayKey(s.time) < today);
  const autoStart = beforeToday.length ? beforeToday[beforeToday.length - 1].equity : (todayRow ? todayRow.start : equity);
  const start = Number.isFinite(todayStart) && todayStart > 0 ? todayStart : autoStart;
  const risk = Math.max(0, Number(openRisk) || 0);

  const dailyFloor = start - rules.dailyLoss;
  const totalFloor = rules.account - rules.maxLoss;
  const dailyRoom = equity - dailyFloor - risk;
  const totalRoom = equity - totalFloor - risk;
  const todayPnl = equity - start;
  const target = rules.account + rules.phases[phase].target;
  const minDayProfit = rules.account * rules.minDayProfitPct / 100;
  const profitableDays = days.filter((d) => d.profitable).length;
  const todayProfitable = todayPnl >= minDayProfit;

  const failed = [];
  if (days.some((d) => d.breachedDaily) || equity <= dailyFloor) failed.push('daily');
  if (list.some((s) => s.equity <= totalFloor) || equity <= totalFloor) failed.push('total');

  const selfStop = rules.dailyLoss * selfStopPct / 100;
  const messages = [];
  let level = 'ok';
  const warn = (lv, text) => {
    messages.push({ level: lv, text });
    const rank = { ok: 0, info: 1, warn: 2, stop: 3, fail: 4 };
    if (rank[lv] > rank[level]) level = lv;
  };

  if (failed.includes('daily')) warn('fail', `今天虧損已經碰到每日上限 ${rules.dailyLoss}：依規則考試失敗，請到平台確認。`);
  if (failed.includes('total')) warn('fail', `淨值已經碰到最大損失底線 ${totalFloor}：依規則考試失敗，請到平台確認。`);
  if (!failed.length) {
    if (dailyRoom <= 0) warn('stop', '算上持倉的停損，今天已經沒有虧損空間了：馬上減倉或平倉。');
    // 衝刺模式沒有自己的停手線（回測就是這樣跑的），只守「全部停損也不破每日上限」
    else if (mode !== 'sprint' && -todayPnl + risk >= selfStop) warn('stop', `今天虧損（含持倉停損）已達 ${Math.round(-todayPnl + risk)}，超過自己的停手線 ${Math.round(selfStop)}：今天收工，不要再開新單。`);
    else if (dailyRoom < rules.dailyLoss * 0.6) warn('warn', `今天只剩 ${Math.round(dailyRoom)} 的虧損空間，下一筆要縮小。`);
    if (totalRoom < rules.maxLoss * 0.4) warn('warn', `離最大損失底線只剩 ${Math.round(totalRoom)}，每筆風險要降到 0.25% 以下。`);
    if (todayProfitable && level === 'ok') warn('info', `今天已經 +${Math.round(todayPnl)}（≥ ${minDayProfit}），這天算獲利日；想穩就今天收工。`);
    if (equity >= target && profitableDays >= rules.minProfitDays) warn('info', `已達成${rules.phases[phase].name}：目標跟獲利日都夠了，去平台確認過關。`);
    else if (equity >= target) warn('info', `獲利目標達成，但獲利日只有 ${profitableDays}/${rules.minProfitDays}：再做 ${rules.minProfitDays - profitableDays} 天各賺 ${minDayProfit} 以上（小倉位就好）。`);
  }

  return {
    equity,
    start,
    startIsAuto: !(Number.isFinite(todayStart) && todayStart > 0),
    todayPnl,
    openRisk: risk,
    dailyFloor,
    totalFloor,
    dailyRoom,
    totalRoom,
    target,
    toTarget: target - equity,
    progressPct: Math.max(0, Math.min(100, ((equity - rules.account) / rules.phases[phase].target) * 100)),
    minDayProfit,
    profitableDays,
    todayProfitable,
    days,
    failed,
    level,
    messages,
    selfStop,
  };
}

/**
 * 下單前的倉位計算。
 * mode = 'guard'（穩穩考，預設）或 'sprint'（衝刺：每筆固定風險，只要停損不會破每日上限／總額底線就照做）。
 * 風險預算取三者最小：每筆風險 %、今天剩餘空間的一半、總剩餘空間的四分之一
 * ——單一筆停損不會讓你當天或整個考試直接出局。
 * 手續費算進停損虧損（進出場都算）；槓桿超過上限就把數量壓到上限。
 */
export function sizePosition({ equity, entry, stop, takeProfit = null, riskPct = 0.5, dailyRoom = Infinity, totalRoom = Infinity, maxLeverage = 5, feePct = 0.06, mode = 'guard', account = null }) {
  entry = Number(entry);
  stop = Number(stop);
  if (!(entry > 0) || !(stop > 0) || entry === stop || !(equity > 0)) return { error: '請輸入正確的進場價跟停損價' };
  const dir = stop < entry ? 'long' : 'short';
  const tp = Number(takeProfit);
  if (tp > 0 && (dir === 'long' ? tp <= entry : tp >= entry)) return { error: '止盈價要在進場價的另一邊（多單比進場高、空單比進場低）' };

  const sprint = mode === 'sprint';
  const budgets = [
    // 衝刺模式每筆風險用起始資金算（跟回測 --prop-fast 一樣），不隨淨值縮小
    { key: 'risk', value: ((sprint && account > 0 ? account : equity) * riskPct) / 100 },
    { key: 'daily', value: dailyRoom * (sprint ? 0.95 : 0.5) },
    { key: 'total', value: totalRoom * (sprint ? 0.95 : 0.25) },
  ];
  const budget = budgets.reduce((a, b) => (b.value < a.value ? b : a));
  if (!(budget.value > 0)) return { error: '已經沒有虧損空間，今天不要再開新單', blocked: true };

  const fee = feePct / 100;
  const dist = Math.abs(entry - stop);
  const perUnitLoss = dist + (entry + stop) * fee;
  let qty = budget.value / perUnitLoss;
  let limitedBy = budget.key;
  const maxQty = (maxLeverage * equity) / entry;
  if (qty > maxQty) {
    qty = maxQty;
    limitedBy = 'leverage';
  }
  const notional = qty * entry;
  const lossAtStop = qty * perUnitLoss;
  const out = {
    dir,
    qty,
    notional,
    leverage: notional / equity,
    margin: notional / maxLeverage,
    lossAtStop,
    stopPct: (dist / entry) * 100,
    limitedBy,
    budgets: Object.fromEntries(budgets.map((b) => [b.key, b.value])),
    dailyRoomAfter: dailyRoom - lossAtStop,
    totalRoomAfter: totalRoom - lossAtStop,
  };
  if (tp > 0) {
    out.profitAtTp = qty * (Math.abs(tp - entry) - (entry + tp) * fee);
    out.rr = out.profitAtTp / lossAtStop;
  }
  return out;
}
