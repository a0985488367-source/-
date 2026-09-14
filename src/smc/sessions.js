/**
 * 交易時段（Killzones）與關鍵時間價位
 *
 * ICT 的時間框架（UTC）：
 *  - Asia      00:00–06:00（亞洲盤整，形成 Asia Range）
 *  - London KZ 07:00–10:00（倫敦殺區，常見掃亞洲高低）
 *  - NY AM KZ  12:00–15:00（紐約早盤殺區，主要行情）
 *  - NY PM KZ  17:30–20:00（紐約午盤，常見反轉）
 *
 * 另提供 PDH/PDL（前日高低）、PWH/PWL（前週高低）、PMH/PML（前月高低）。
 */

export const SESSIONS = [
  { id: 'asia', name: 'Asia', nameZh: '亞洲盤', startH: 0, endH: 6, color: '#2b6cb0' },
  { id: 'london', name: 'London KZ', nameZh: '倫敦殺區', startH: 7, endH: 10, color: '#2f855a' },
  { id: 'nyam', name: 'New York AM KZ', nameZh: '紐約早盤殺區', startH: 12, endH: 15, color: '#b7791f' },
  { id: 'nypm', name: 'New York PM KZ', nameZh: '紐約午盤殺區', startH: 17.5, endH: 20, color: '#805ad5' },
];

const dayKey = (ts) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export function utcHourFloat(ts) {
  const d = new Date(ts);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

export function sessionOf(ts) {
  const h = utcHourFloat(ts);
  return SESSIONS.find((s) => h >= s.startH && h < s.endH) || null;
}

/** 計算每個交易日各時段的高低點（可作為流動性目標） */
export function sessionRanges(candles, { maxDays = 5 } = {}) {
  const byDay = new Map();
  for (const c of candles) {
    const k = dayKey(c.time);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b).slice(-maxDays);
  const out = [];
  for (const day of days) {
    const list = byDay.get(day);
    for (const s of SESSIONS) {
      const inSession = list.filter((c) => {
        const h = utcHourFloat(c.time);
        return h >= s.startH && h < s.endH;
      });
      if (!inSession.length) continue;
      const high = Math.max(...inSession.map((c) => c.high));
      const low = Math.min(...inSession.map((c) => c.low));
      out.push({
        id: `${s.id}-${day}`,
        session: s.id,
        name: s.name,
        nameZh: s.nameZh,
        color: s.color,
        day,
        start: inSession[0].time,
        end: inSession[inSession.length - 1].time,
        high,
        low,
        mid: (high + low) / 2,
      });
    }
  }
  return out;
}

/** 依較大週期彙整 K 線（用於取得前日／前週高低） */
export function resample(candles, bucketFn) {
  const map = new Map();
  for (const c of candles) {
    const k = bucketFn(c.time);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { time: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

const weekKey = (ts) => {
  const d = new Date(ts);
  const dow = (d.getUTCDay() + 6) % 7; // 週一為 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
};
const monthKey = (ts) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** 關鍵時間價位：PDH/PDL、PWH/PWL、PMH/PML、今日開盤 */
export function keyLevels(candles) {
  if (!candles.length) return [];
  const daily = resample(candles, dayKey);
  const weekly = resample(candles, weekKey);
  const monthly = resample(candles, monthKey);
  const levels = [];
  const push = (code, zh, en, price, color) => {
    if (price != null && isFinite(price)) levels.push({ code, zh, en, price, color });
  };
  const pd = daily[daily.length - 2];
  const pw = weekly[weekly.length - 2];
  const pm = monthly[monthly.length - 2];
  const today = daily[daily.length - 1];
  if (pd) {
    push('PDH', '前日高', 'Prev Day High', pd.high, '#e2b13c');
    push('PDL', '前日低', 'Prev Day Low', pd.low, '#e2b13c');
  }
  if (pw) {
    push('PWH', '前週高', 'Prev Week High', pw.high, '#3aa0ff');
    push('PWL', '前週低', 'Prev Week Low', pw.low, '#3aa0ff');
  }
  if (pm) {
    push('PMH', '前月高', 'Prev Month High', pm.high, '#b06ce8');
    push('PML', '前月低', 'Prev Month Low', pm.low, '#b06ce8');
  }
  if (today) push('DO', '今日開盤', 'Daily Open', today.open, '#8b97a8');
  return levels;
}
