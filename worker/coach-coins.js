/**
 * SMC 教練要看哪些幣（2026-10-15 使用者要的）：
 *   Bybit 永續 24 小時成交額前 COACH_TOP 名（預設 50，不含穩定幣、黃金代幣），每天更新一次（KV coach:top）
 *   ＋原本的 SMC_SYMBOLS（主流 15 檔，一定在）
 *   ＋使用者在 App 搜尋後自己加的（KV coach:extra，最多 20 個）
 * App 掃描板、Discord 教練提醒、教練自動下單都用同一份名單。
 */
const TOP_KEY = 'coach:top';
const EXTRA_KEY = 'coach:extra';
export const EXTRA_MAX = 20;
const SKIP = new Set(['USDC', 'USDE', 'FDUSD', 'DAI', 'TUSD', 'USDD', 'PYUSD', 'BUSD', 'USD1', 'RLUSD', 'USDT0', 'XAUT', 'PAXG', 'EUR', 'USTC']);

async function kvJson(env, key, dflt) {
  if (!env.SMC_KV) return dflt;
  try { const v = await env.SMC_KV.get(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}

/** Bybit 永續 USDT 合約，照 24 小時成交額排（大到小） */
export async function bybitUniverse(fetchImpl = fetch) {
  const res = await fetchImpl('https://api.bybit.com/v5/market/tickers?category=linear');
  if (!res.ok) throw new Error(`Bybit tickers HTTP ${res.status}`);
  const j = await res.json();
  if (j.retCode !== 0 || !Array.isArray(j.result?.list)) throw new Error(j.retMsg || 'Bybit tickers 格式不對');
  return j.result.list
    .filter((r) => /^[A-Z0-9]+USDT$/.test(r.symbol) && !SKIP.has(r.symbol.replace(/USDT$/, '')))
    .map((r) => ({ s: r.symbol, v: Number(r.turnover24h) || 0 }))
    .sort((a, b) => b.v - a.v);
}

/** 今天的名單（KV 有今天的就用，沒有就跟 Bybit 拿；拿不到就用舊的，再不行就只有 base） */
export async function coachCoins(env, { base = [], topN = 50, fetchImpl = fetch, now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  let top = await kvJson(env, TOP_KEY, null);
  if (!top || top.day !== day || top.n !== topN) {
    try {
      const all = await bybitUniverse(fetchImpl);
      top = { day, n: topN, list: all.slice(0, topN).map((x) => x.s), all: all.map((x) => x.s) };
      if (env.SMC_KV) await env.SMC_KV.put(TOP_KEY, JSON.stringify(top), { expirationTtl: 7 * 86400 });
    } catch { top = top || { day: null, list: [], all: [] }; }
  }
  const extra = await kvJson(env, EXTRA_KEY, []);
  const coins = [...new Set([...base, ...top.list, ...extra])];
  return { coins, base, top: top.list, extra, all: top.all || [], day: top.day };
}

/** GET（公開）回傳名單＋全部可以搜的幣；POST { add } / { remove }（要 App 密碼，index.js 先檢查） */
export async function handleCoachCoins(request, env, opts = {}) {
  const info = await coachCoins(env, opts);
  if (request.method !== 'POST') return { status: 200, body: info };
  let b; try { b = await request.json(); } catch { return { status: 400, body: { error: '格式不對' } }; }
  const norm = (x) => { const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.endsWith('USDT') ? s : s + 'USDT'; };
  let extra = [...info.extra];
  if (b.add) {
    const s = norm(b.add);
    if (info.all.length && !info.all.includes(s)) return { status: 400, body: { error: `Bybit 沒有 ${s} 永續合約` } };
    if (!extra.includes(s) && !info.coins.includes(s)) {
      if (extra.length >= EXTRA_MAX) return { status: 400, body: { error: `自己加的最多 ${EXTRA_MAX} 個，先移掉幾個` } };
      extra.push(s);
    }
  }
  if (b.remove) { const s = norm(b.remove); extra = extra.filter((x) => x !== s); }
  if (env.SMC_KV) await env.SMC_KV.put(EXTRA_KEY, JSON.stringify(extra));
  return { status: 200, body: { ok: true, ...(await coachCoins(env, opts)) } };
}
