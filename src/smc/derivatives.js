/**
 * 衍生品情緒解讀（資金費率 + 未平倉量）
 *
 * 這兩個數字單獨看都沒什麼用，一起看才有意義：
 *
 *   未平倉量（OI）＝ 場上還沒平掉的合約總量 → 「有沒有新錢進場」
 *   資金費率     ＝ 多空哪一邊在付錢給另一邊 → 「哪一邊比較擁擠」
 *
 * 跟 SMC 的關係：擁擠的那一邊，停損就掛在那一邊的反方向。
 * 資金費率極端偏多 = 一堆人做多 = 他們的停損都在下面
 * = 下方有一池流動性等著被掃。這正是 SMC 在找的東西。
 *
 * 全部是純函式，不碰網路，可以直接單元測試。
 */

/** 每 8 小時的費率換算成年化：一天 3 次、一年 365 天 */
export const annualizeFunding = (rate) => (Number.isFinite(rate) ? rate * 3 * 365 * 100 : null);

export const FUNDING_THRESHOLDS = {
  neutral: 0.0001,  // 0.01%／8h，這是交易所的基準值
  elevated: 0.0003, // 0.03%
  extreme: 0.0005,  // 0.05%
};

/**
 * 資金費率分級。
 * @returns {{level:string, side:'long'|'short'|null, zh:string, en:string}}
 */
export function classifyFunding(rate, th = FUNDING_THRESHOLDS) {
  if (!Number.isFinite(rate)) return { level: 'unknown', side: null, zh: '無資料', en: 'No data' };
  const a = Math.abs(rate);
  const side = rate > 0 ? 'long' : rate < 0 ? 'short' : null;
  const payer = rate > 0 ? '多方付給空方' : '空方付給多方';
  const payerEn = rate > 0 ? 'longs pay shorts' : 'shorts pay longs';

  if (a < th.neutral) return { level: 'neutral', side, zh: '中性，沒有明顯的一面倒', en: 'Neutral' };
  if (a < th.elevated) return { level: 'mild', side, zh: `${payer}，${rate > 0 ? '偏多' : '偏空'}但還算正常`, en: `Mild — ${payerEn}` };
  if (a < th.extreme) return { level: 'elevated', side, zh: `${payer}，${rate > 0 ? '多方' : '空方'}明顯擁擠`, en: `Elevated — ${payerEn}` };
  return { level: 'extreme', side, zh: `${payer}，${rate > 0 ? '多方' : '空方'}極度擁擠，反向掃損風險高`, en: `Extreme — ${payerEn}` };
}

/** 未平倉量變化率（%）。series 由舊到新。 */
export function oiChangePct(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = Number(series[0]?.value ?? series[0]);
  const last = Number(series[series.length - 1]?.value ?? series[series.length - 1]);
  if (!(first > 0) || !Number.isFinite(last)) return null;
  return ((last - first) / first) * 100;
}

export const OI_THRESHOLDS = { notable: 3, strong: 8 };

/**
 * 價格與未平倉量的四象限 —— 衍生品分析最實用的一張表。
 *
 *   價格 ↑ + OI ↑  新多進場，趨勢有新錢支撐
 *   價格 ↑ + OI ↓  空單回補推上去的，沒有新錢，容易回落
 *   價格 ↓ + OI ↑  新空進場，下跌有新錢支撐
 *   價格 ↓ + OI ↓  多單被清洗，下跌動能正在衰竭
 */
export function priceOiRegime({ priceChangePct, oiChangePct: oi }, opts = {}) {
  const { priceEps = 0.5, oiEps = OI_THRESHOLDS.notable } = opts;
  if (!Number.isFinite(priceChangePct) || !Number.isFinite(oi)) {
    return { key: 'unknown', zh: '資料不足', en: 'No data', quality: null };
  }
  const up = priceChangePct > priceEps;
  const down = priceChangePct < -priceEps;
  const oiUp = oi > oiEps;
  const oiDown = oi < -oiEps;

  if (!up && !down) {
    if (oiUp) return { key: 'buildup', zh: '價格盤整但未平倉量增加 —— 有人在佈局，等突破方向', en: 'Position build-up in range', quality: 'neutral' };
    if (oiDown) return { key: 'flush', zh: '價格盤整且未平倉量下降 —— 場內在減碼觀望', en: 'De-risking in range', quality: 'neutral' };
    return { key: 'quiet', zh: '價格與持倉都沒什麼變化', en: 'Quiet', quality: 'neutral' };
  }
  if (up && oiUp) return { key: 'longBuild', zh: '上漲且未平倉量增加 —— 新多進場，趨勢有新錢支撐', en: 'New longs — healthy uptrend', quality: 'healthy', bias: 'long' };
  if (up && oiDown) return { key: 'shortCover', zh: '上漲但未平倉量下降 —— 空單回補推上來的，沒有新錢，漲勢容易回落', en: 'Short covering — weak rally', quality: 'weak', bias: 'long' };
  if (down && oiUp) return { key: 'shortBuild', zh: '下跌且未平倉量增加 —— 新空進場，跌勢有新錢支撐', en: 'New shorts — healthy downtrend', quality: 'healthy', bias: 'short' };
  if (down && oiDown) return { key: 'longFlush', zh: '下跌且未平倉量下降 —— 多單被清洗，跌勢動能正在衰竭', en: 'Long liquidation — downtrend exhausting', quality: 'weak', bias: 'short' };
  return { key: 'mixed', zh: '訊號混雜', en: 'Mixed', quality: 'neutral' };
}

/**
 * 給交易方向的加減分與警告。
 *
 * 重點：這裡回傳的是「提醒」而不是「否決」——
 * 我刻意不讓它過濾掉任何訊號，因為那會讓訊號數量變少。
 * 它只調整信心度，並在擁擠側站錯邊時明講風險。
 */
export function derivativesVerdict({ dir, funding, priceChangePct, oiChangePct: oi }, opts = {}) {
  const f = classifyFunding(funding);
  const regime = priceOiRegime({ priceChangePct, oiChangePct: oi }, opts);
  const notes = [];
  const notesEn = [];
  let score = 0;

  // 站在擁擠側的反方向 → 順勢掃流動性，加分
  if (f.level === 'extreme' || f.level === 'elevated') {
    const crowded = f.side;
    if (crowded && crowded !== dir) {
      score += f.level === 'extreme' ? 12 : 6;
      notes.push(`資金費率顯示${crowded === 'long' ? '多方' : '空方'}擁擠，而你站在反向 —— 對手的停損就是你的目標流動性。`);
      notesEn.push(`Funding shows crowded ${crowded}s; you are on the other side — their stops are your target liquidity.`);
    } else if (crowded === dir) {
      score -= f.level === 'extreme' ? 12 : 6;
      notes.push(`⚠ 資金費率顯示${crowded === 'long' ? '多方' : '空方'}已經很擁擠，你跟大多數人站同一邊，被反向掃損的風險較高。`);
      notesEn.push(`⚠ You are on the crowded side — higher risk of being swept.`);
    }
  }

  // 持倉結構是否支持這個方向
  if (regime.quality === 'healthy' && regime.bias === dir) {
    score += 8;
    notes.push(`未平倉量與價格同向增加，${dir === 'long' ? '漲' : '跌'}勢有新資金支撐。`);
    notesEn.push('Open interest confirms the move.');
  } else if (regime.quality === 'weak' && regime.bias === dir) {
    score -= 8;
    notes.push(`⚠ ${regime.zh}，這個方向缺乏新資金，追價要小心。`);
    notesEn.push(`⚠ ${regime.en} — the move lacks fresh money.`);
  } else if (regime.quality === 'weak' && regime.bias && regime.bias !== dir) {
    score += 5;
    notes.push(`${regime.zh} —— 反向動能正在衰竭，對你有利。`);
    notesEn.push(`${regime.en} — the opposing move is exhausting.`);
  }

  return {
    score,                       // -20 ~ +20，用來微調信心度而不是決定進不進場
    funding: f,
    regime,
    fundingAnnualPct: annualizeFunding(funding),
    notes,
    notesEn,
  };
}

/** 距離下次收取資金費率還有多久 */
export function fundingCountdown(nextFundingTime, now = Date.now()) {
  if (!Number.isFinite(nextFundingTime)) return null;
  const ms = nextFundingTime - now;
  if (ms <= 0) return { ms: 0, zh: '即將收取', en: 'Due now' };
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return { ms, hours: h, minutes: m, zh: `${h} 小時 ${m} 分後收取`, en: `in ${h}h ${m}m` };
}
