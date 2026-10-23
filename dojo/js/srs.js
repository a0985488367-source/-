/**
 * 記憶系統（純函式，方便測試）：
 *   卡牌間隔重考：答對升一格、答錯掉回第 1 格；第 n 格隔 INTERVALS[n] 天再考。
 *   墨色：到期沒複習，卡會慢慢褪色（ink 1 → 0.2）。
 *   每日任務：每天 3 個（用日期決定），全完成開每日寶箱。
 *   連續天數：一天答對 10 題就算有練，斷一天會歸零（有「免斷符」可以補一天）。
 */
import { CONCEPTS, CONCEPT, CHAPTERS } from './concepts.js';
import { makeRng, todayKey, dayDiff, clamp } from './core.js';

export const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
export const DAY = 864e5;
export const DAILY_GOAL = 10;

export function freshSave() {
  return {
    v: 2, created: Date.now(), xp: 0, coins: 50,
    cards: {},                 // id → { box, due, seen, ok, lapses, unlocked, at }
    streak: { count: 0, best: 0, last: null, freeze: 1 },
    day: { date: null, ok: 0, answered: 0, missions: [], chest: false, dueStart: 0 },
    rogue: { best: 0, runs: 0, kills: 0 },
    ranked: { lp: 0, wins: 0, losses: 0, peak: 0, history: [] },
    story: { done: {} },       // "1-1" → true
    stats: { answered: 0, ok: 0, bestCombo: 0 },
    settings: { sound: true, haptics: true },
  };
}

/* ---------- 卡牌 ---------- */
export function card(save, id) {
  return save.cards[id] || (save.cards[id] = { box: 0, due: 0, seen: 0, ok: 0, lapses: 0, unlocked: false, at: 0 });
}
export function unlock(save, id, now = Date.now()) {
  const c = card(save, id);
  if (c.unlocked) return false;
  Object.assign(c, { unlocked: true, at: now, box: Math.max(c.box, 1), due: now + DAY });
  return true;
}
/** 答完一題：更新那張卡。回傳 { levelUp, lapse } */
export function review(save, id, ok, now = Date.now()) {
  const c = card(save, id);
  c.seen++;
  if (!c.unlocked) unlock(save, id, now);
  const wasDue = c.due <= now;
  if (ok) {
    c.ok++;
    // 還沒到期就答對：不升級（避免一直刷同一張），但墨色回滿
    if (wasDue || c.box <= 1) { c.box = Math.min(INTERVALS.length - 1, c.box + 1); c.due = now + INTERVALS[c.box] * DAY; return { levelUp: true }; }
    return { levelUp: false };
  }
  c.lapses++;
  const lapse = c.box > 1;
  c.box = 1;
  c.due = now + DAY;
  return { lapse };
}
export const stars = (c) => (c && c.unlocked ? clamp(c.box - 1, 0, 5) : 0);
/** 墨色濃度：1＝新鮮，到期越久越淡，最淡 0.2 */
export function ink(c, now = Date.now()) {
  if (!c || !c.unlocked || !c.due || now <= c.due) return 1;
  const over = (now - c.due) / DAY, span = INTERVALS[c.box] || 1;
  return clamp(1 - over / (span * 1.5 + 2), 0.2, 1);
}
export function dueCards(save, now = Date.now()) {
  return CONCEPTS.filter((k) => save.cards[k.id]?.unlocked && save.cards[k.id].due <= now)
    .sort((a, b) => save.cards[a.id].due - save.cards[b.id].due).map((k) => k.id);
}
export const unlockedIds = (save) => CONCEPTS.filter((k) => save.cards[k.id]?.unlocked).map((k) => k.id);
/** 這張卡最近表現：給「弱點」挑題用 */
export function weakness(save, id) {
  const c = save.cards[id];
  if (!c || !c.seen) return 0.5;
  return (c.lapses + 1) / (c.ok + 2);
}

/* ---------- XP／等級 ---------- */
export const levelOf = (xp) => Math.floor(Math.sqrt(xp / 60)) + 1;
export const xpFor = (lv) => (lv - 1) * (lv - 1) * 60;

/* ---------- 每日任務 ---------- */
const MISSIONS = [
  { id: 'review', text: (g) => `完成今天到期的 ${g} 張卡複習`, goal: (s) => Math.min(8, Math.max(3, s.day.dueStart)) },
  { id: 'answer', text: (g) => `答對 ${g} 題`, goal: (_s, r) => r.pick([15, 20, 25]) },
  { id: 'pick', text: (g) => `點圖題答對 ${g} 題`, goal: (_s, r) => r.pick([5, 6, 8]) },
  { id: 'combo', text: (g) => `連續答對 ${g} 題`, goal: (_s, r) => r.pick([6, 8, 10]) },
  { id: 'spot', text: (g) => `找錯題答對 ${g} 題`, goal: () => 2 },
  { id: 'rogue', text: (g) => `闖關打到第 ${g} 層`, goal: (_s, r) => r.pick([3, 4, 5]) },
  { id: 'ranked', text: () => '排位賽贏 1 場', goal: () => 1 },
  { id: 'story', text: () => '過 1 個劇情關卡', goal: () => 1 },
];
const seedOf = (date) => [...date].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** 換日：重算今天的任務、檢查連續天數有沒有斷 */
export function rollDay(save, now = Date.now()) {
  const today = todayKey(now);
  if (save.day.date === today) return false;
  const r = makeRng(seedOf(today));
  const dueN = dueCards(save, now).length;
  save.day = { date: today, ok: 0, answered: 0, missions: [], chest: false, dueStart: dueN };
  const pool = MISSIONS.filter((m) => m.id !== 'review' || dueN > 0);
  const picks = [];
  if (dueN > 0) picks.push(MISSIONS[0]);
  for (const m of r.shuffle(pool)) { if (picks.length >= 3) break; if (!picks.includes(m)) picks.push(m); }
  save.day.missions = picks.map((m) => { const g = m.goal(save, r); return { id: m.id, text: m.text(g), goal: g, prog: 0, done: false }; });
  // 連續天數：昨天沒練就斷（有免斷符自動用掉一張）
  const st = save.streak;
  if (st.last && st.count > 0) {
    const gap = dayDiff(st.last, today);
    if (gap === 2 && st.freeze > 0) { st.freeze--; st.last = todayKey(now - DAY); st.saved = today; }
    else if (gap >= 2) st.count = 0;
  }
  return true;
}

/** 任務進度事件。回傳這次剛完成的任務清單 */
export function track(save, ev, val = 1, now = Date.now()) {
  rollDay(save, now);
  const done = [];
  for (const m of save.day.missions) {
    if (m.done) continue;
    let hit = 0;
    if (ev === m.id) hit = val;
    if (m.id === 'combo' && ev === 'combo') { m.prog = Math.max(m.prog, val); hit = 0; }
    if (m.id === 'rogue' && ev === 'rogue') { m.prog = Math.max(m.prog, val); hit = 0; }
    if (hit) m.prog += hit;
    if (m.prog >= m.goal) { m.prog = m.goal; m.done = true; done.push(m); }
  }
  return done;
}

/** 答完一題的全部記帳：卡牌、XP、今日、連續天數、任務。回傳畫面要提示的事 */
export function recordAnswer(save, q, ok, { combo = 0, review: isReview = false, now = Date.now() } = {}) {
  rollDay(save, now);
  const res = review(save, q.concept, ok, now);
  save.stats.answered++;
  save.day.answered++;
  const out = { ...res, xp: 0, missions: [], streakUp: false };
  if (ok) {
    save.stats.ok++;
    save.day.ok++;
    const xp = Math.round(10 * (1 + 0.25 * ((q.diff || 1) - 1)) * (q.kind === 'pick' || q.spot ? 1.4 : 1));
    out.xp = xp;
    const lv0 = levelOf(save.xp);
    save.xp += xp;
    out.lvUp = levelOf(save.xp) > lv0 ? levelOf(save.xp) : 0;
    out.missions.push(...track(save, 'answer', 1, now));
    if (q.kind === 'pick') out.missions.push(...track(save, 'pick', 1, now));
    if (q.spot) out.missions.push(...track(save, 'spot', 1, now));
    if (isReview) out.missions.push(...track(save, 'review', 1, now));
    if (save.day.ok === DAILY_GOAL) out.streakUp = markPracticed(save, now);
  }
  if (combo) { save.stats.bestCombo = Math.max(save.stats.bestCombo, combo); out.missions.push(...track(save, 'combo', combo, now)); }
  return out;
}

export function markPracticed(save, now = Date.now()) {
  const today = todayKey(now), st = save.streak;
  if (st.last === today) return false;
  st.count = st.last && dayDiff(st.last, today) === 1 ? st.count + 1 : 1;
  st.last = today;
  st.best = Math.max(st.best, st.count);
  return true;
}

/** 每日寶箱：三個任務都完成才能開。給一張還沒拿到的卡（照章節順序優先）＋銅錢 */
export function openChest(save, rng, now = Date.now()) {
  if (save.day.chest || !save.day.missions.every((m) => m.done)) return null;
  save.day.chest = true;
  return drawPack(save, rng, now, 60);
}
export function drawPack(save, rng, now = Date.now(), coins = 30) {
  const locked = CONCEPTS.filter((k) => !save.cards[k.id]?.unlocked);
  const out = { coins, card: null };
  save.coins += coins;
  if (locked.length) {
    // 稀有度越高越難抽到
    const w = locked.map((k) => 1 / k.rarity);
    let x = rng() * w.reduce((a, b) => a + b, 0), pick = locked[0];
    for (let i = 0; i < locked.length; i++) { x -= w[i]; if (x <= 0) { pick = locked[i]; break; } }
    unlock(save, pick.id, now);
    out.card = pick.id;
  } else {
    out.coins += 40;
    save.coins += 40;
  }
  return out;
}

/** 練習選題：到期的 > 弱的 > 已解鎖隨機 */
export function pickConcepts(save, n, rng, now = Date.now(), pool = null) {
  const ids = pool || unlockedIds(save);
  if (!ids.length) return [];
  const due = dueCards(save, now).filter((x) => ids.includes(x));
  const out = due.slice(0, n);
  const rest = rng.shuffle(ids.filter((x) => !out.includes(x))).sort((a, b) => weakness(save, b) - weakness(save, a));
  while (out.length < n && rest.length) out.push(rest.shift());
  while (out.length < n) out.push(rng.pick(ids));
  return rng.shuffle(out);
}

/* ---------- 排位 ---------- */
export const TIERS = [
  { name: '青銅', lp: 0, ai: '散戶阿明', skill: 0.25, color: '#B0805A' },
  { name: '白銀', lp: 100, ai: '均線小王', skill: 0.4, color: '#B8C2D6' },
  { name: '黃金', lp: 250, ai: '型態老張', skill: 0.55, color: '#D8B24A' },
  { name: '白金', lp: 450, ai: '結構控 Mia', skill: 0.68, color: '#7FD1C3' },
  { name: '鑽石', lp: 700, ai: '流動性獵人', skill: 0.78, color: '#6FA8FF' },
  { name: '大師', lp: 1000, ai: '機構交易員', skill: 0.86, color: '#B07CE8' },
  { name: '傳說', lp: 1400, ai: '莊家', skill: 0.92, color: '#E2483D' },
];
export const tierOf = (lp) => { let t = 0; TIERS.forEach((x, i) => { if (lp >= x.lp) t = i; }); return t; };

/* ---------- 劇情進度 ---------- */
export const storyKey = (ch, st) => `${ch}-${st}`;
export function chapterUnlocked(save, n) { return n === 1 || !!save.story.done[storyKey(n - 1, 3)]; }
export function chapterCards(n) { return CHAPTERS.find((c) => c.n === n)?.cards ?? []; }
export { CONCEPT };
