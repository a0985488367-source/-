/**
 * 5/5（到位）劇本的即時追蹤（2026-10-15 使用者要的）：Discord 推了「到位」之後，不用等下一根 15 分鐘收盤，
 * Worker 每分鐘看一次最近幾根 1 分鐘 K 的高低點：
 *   碰到目標 → ✅ 推「到目標」、打到停損 → ⛔ 推「打到停損」（這兩個推完就結束追蹤）
 *   往獲利方向跑超過 0.5R → 推一次「跑掉了，不追」；跑掉之後又回到進場點 0.15R 內 → 推「回到進場點，又來得及」（最多 2 次）
 *   往停損方向超過 0.5R（還沒打到）→ 推一次「靠近停損，先別進」
 *   放了 48 根（那個週期）都沒結果 → 不再追蹤
 * KV coach:live5（最多 40 筆）
 */
const KEY = 'coach:live5';
const MAX = 40;
const MAX_BARS = 48;

async function kvJson(env, key, dflt) {
  if (!env.SMC_KV) return dflt;
  try { const v = await env.SMC_KV.get(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}
const coin = (s) => s.replace(/USDT$/, '');
const fmtP = (p) => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(3) : p >= 1 ? p.toFixed(4) : p.toPrecision(5));

/** runCoach 推了「到位」的劇本，加進追蹤清單 */
export async function addReady(env, items, now = Date.now()) {
  if (!env.SMC_KV || !items.length) return;
  const list = await kvJson(env, KEY, []);
  for (const a of items) {
    if (list.some((x) => x.id === a.id)) continue;
    list.unshift({ ...a, state: 'near', backs: 0, since: now, until: now + MAX_BARS * a.ms });
  }
  await env.SMC_KV.put(KEY, JSON.stringify(list.slice(0, MAX)));
}

/**
 * 每分鐘：用 1 分鐘 K（從上次檢查到現在）看有沒有碰到目標／停損，再用最新價看離進場點幾 R。
 * deps: fetchKlines(env, sym, '1m', n)、postDiscord、now
 */
export async function checkReady(env, { fetchKlines, postDiscord, now = Date.now() }) {
  if (!env.SMC_KV) return { skipped: 'no-kv' };
  let list = await kvJson(env, KEY, []);
  if (!list.length) return { tracking: 0 };
  const sent = [];
  const say = async (a, msg) => { sent.push(`${a.sym} ${msg}`); await postDiscord(env, { content: `⚡ ${coin(a.sym)} ${a.iv} ${a.side === 'L' ? '多' : '空'}單劇本（即時）：${msg}` }).catch(() => {}); };
  for (const a of list) {
    if (a.done) continue;
    if (now > a.until) { a.done = 'timeout'; continue; }
    let rows;
    try { rows = await fetchKlines(env, a.sym, '1m', 15); } catch { continue; }
    const from = (a.checked || a.since) - 60e3;
    const seg = rows.filter((k) => k.time + 60e3 > from);
    if (!seg.length) continue;
    const d = a.side === 'L' ? 1 : -1, risk = d * (a.en - a.sl);
    if (!(risk > 0)) { a.done = 'bad'; continue; }
    const hi = Math.max(...seg.map((k) => +k.high)), lo = Math.min(...seg.map((k) => +k.low)), px = +seg[seg.length - 1].close;
    a.checked = now;
    // 同一段裡停損跟目標都碰到：保守當作先打到停損
    if (d > 0 ? lo <= a.sl : hi >= a.sl) { a.done = 'sl'; await say(a, `⛔ 打到停損 ${fmtP(a.sl)}（-1R），劇本結束`); continue; }
    if (a.tp != null && (d > 0 ? hi >= a.tp : lo <= a.tp)) { a.done = 'tp'; await say(a, `✅ 到目標 ${fmtP(a.tp)}（+${a.rr}R），劇本結束`); continue; }
    const cur = d * (px - a.en) / risk;
    if (a.state === 'near' && cur > 0.5) { a.state = 'ran'; await say(a, `跑掉了（現價 ${fmtP(px)}，+${cur.toFixed(1)}R），沒進場的不追，等回到 ${fmtP(a.en)}`); }
    else if (a.state === 'ran' && Math.abs(cur) <= 0.15 && a.backs < 2) { a.state = 'near'; a.backs++; await say(a, `回到進場點附近（現價 ${fmtP(px)}，進場 ${fmtP(a.en)}・停損 ${fmtP(a.sl)}・目標 ${fmtP(a.tp)}），又來得及`); }
    else if (a.state !== 'deep' && cur < -0.5) { a.state = 'deep'; await say(a, `往停損方向走了 ${cur.toFixed(1)}R（現價 ${fmtP(px)}，停損 ${fmtP(a.sl)}），沒進場的先別進`); }
    else if (a.state === 'deep' && cur > -0.15) a.state = 'near';
  }
  list = list.filter((a) => !a.done || now - (a.checked || a.since) < 6 * 3600e3);
  await env.SMC_KV.put(KEY, JSON.stringify(list.slice(0, MAX)));
  return { tracking: list.filter((a) => !a.done).length, sent };
}
