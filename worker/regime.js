/**
 * BTC 大方向（2026-10-25 使用者決定：「現在趨勢在哪就用哪一邊」）。
 *
 *   - 大方向＝BTC 4h 超級趨勢（ATR14、3 倍，src/strategies/trend-extra.js 的 supertrendDir，跟回測 --btc-filters=st4h 同一套）
 *   - 套用的策略（DIRECTION_FILTER_STRATEGIES，預設 6 個順勢＋RSI 回歸＋HMA 翻轉）只開跟大方向同邊的新單
 *   - DIRECTION_FLIP_CLOSE=true：手上跟大方向相反的這些策略的單直接市價平掉（使用者選的；這部分回測沒驗證過）
 *   - 唐奇安組合不套用（只做多、本身看日線）
 *
 * 回測（alt-strategies --btc-filters，2026-10-22）：只過濾新單時每筆平均 R 大多變好，但帳戶一組 11 倍→2 倍、一組 3 倍→17 倍，不穩定；
 * 使用者看完數字仍決定上線。
 */

import { atr } from '../src/core/indicators.js';
import { supertrendDir } from '../src/strategies/trend-extra.js';

const H4 = 4 * 3_600_000;
export const REGIME_KEY = 'regime:btc4h';
export const REGIME_DEFAULTS = {
  DIRECTION_FILTER: 'off',        // btc-st4h＝用 BTC 4h 超級趨勢；off＝不過濾
  DIRECTION_FILTER_STRATEGIES: 'breakout,ema,macd,vol,st,gc,rsi,hma,fakeout',
  DIRECTION_FLIP_CLOSE: 'false',  // true＝跟大方向相反的單直接平掉
};
const rcfg = (env, k) => env[k] ?? REGIME_DEFAULTS[k];
const strategiesOf = (env) => String(rcfg(env, 'DIRECTION_FILTER_STRATEGIES')).split(',').map((s) => s.trim()).filter(Boolean);
export const regimeOn = (env) => rcfg(env, 'DIRECTION_FILTER') === 'btc-st4h';
export const dirLabel = (d) => (d === 1 ? '多' : d === -1 ? '空' : '不明');

/** 剛收盤那根 4h 的 BTC 超級趨勢方向（1／-1）；同一根只算一次（KV 快取）。抓不到資料就沿用 8 小時內的舊結果 */
export async function btcRegime(env, { fetchKlines, now = Date.now() }) {
  if (!regimeOn(env)) return null;
  const bar = Math.floor(now / H4) * H4 - H4;
  const cached = env.SMC_KV ? JSON.parse((await env.SMC_KV.get(REGIME_KEY)) ?? 'null') : null;
  if (cached?.bar === bar) return cached;
  try {
    const candles = await fetchKlines(env, 'BTCUSDT', '4h', 300);
    const closed = candles.filter((c) => c.time + H4 <= now);
    if (closed.at(-1)?.time !== bar) throw new Error('BTC 4h 還沒更新到剛收盤那根');
    const dir = supertrendDir(closed, atr(closed, 14), 3).at(-1);
    if (dir !== 1 && dir !== -1) throw new Error('算不出方向');
    const rec = { bar, dir, at: now, prevDir: cached?.dir ?? null, changedAt: cached && cached.dir !== dir ? now : (cached?.changedAt ?? null) };
    if (env.SMC_KV) await env.SMC_KV.put(REGIME_KEY, JSON.stringify(rec));
    return { ...rec, fresh: true }; // fresh：這次排程才算出來的（翻轉通知只在這時候推一次）
  } catch (e) {
    if (cached && now - cached.at < 2 * H4) return { ...cached, stale: e.message };
    return null;
  }
}

/** 這個訊號可不可以開：沒開過濾、不在名單裡的策略照舊；在名單裡的要跟大方向同邊（大方向不明就不開） */
export function regimeAllows(env, regime, sig) {
  if (!regimeOn(env) || !strategiesOf(env).includes(sig.strategy)) return true;
  return !!regime && regime.dir === (sig.dir === 'long' ? 1 : -1);
}

/**
 * 平掉跟大方向相反的單（DIRECTION_FLIP_CLOSE=true 時）。每個幣在同一根 4h 只試一次，失敗下一根再試。
 * 大方向剛翻轉（跟上一根不同）時推 Discord，列出平掉的單；平倉後的結果照原本的平倉偵測推播。
 * deps：trackedPositions、executorCall、postDiscord
 */
export async function enforceRegime(env, regime, deps) {
  if (!regimeOn(env) || !regime || regime.stale) return null;
  const flipped = !!regime.fresh && regime.prevDir != null && regime.prevDir !== regime.dir;
  const first = !!regime.fresh && regime.prevDir == null;
  const want = regime.dir === 1 ? 'long' : 'short';
  const names = strategiesOf(env);
  const closed = [], failed = [];
  if (rcfg(env, 'DIRECTION_FLIP_CLOSE') === 'true') {
    const tracked = await deps.trackedPositions(env);
    for (const p of tracked.filter((x) => names.includes(x.strategy) && x.dir && x.dir !== want)) {
      const key = `regime:close:${p.symbol}:${regime.bar}`;
      if (env.SMC_KV && await env.SMC_KV.get(key)) continue;
      if (env.SMC_KV) await env.SMC_KV.put(key, '1', { expirationTtl: 86400 });
      const r = await deps.executorCall(env, 'POST', '/close', { body: { symbol: p.symbol, quiet: true } }).catch((e) => ({ error: e.message }));
      (r?.error ? failed : closed).push({ symbol: p.symbol, dir: p.dir, strategy: p.strategy, error: r?.error });
    }
  }
  if (flipped || first || closed.length || failed.length) {
    const base = (s) => s.replace(/USDT$/, '');
    const lines = [];
    if (flipped) lines.push(`BTC 4h 超級趨勢翻${dirLabel(regime.dir)}：之後 ${names.length} 個策略只開${dirLabel(regime.dir)}單`);
    if (first) lines.push(`開始照 BTC 4h 超級趨勢的方向開單，現在是${dirLabel(regime.dir)}：${names.length} 個策略只開${dirLabel(regime.dir)}單`);
    if (closed.length) lines.push(`平掉反方向的單：${closed.map((c) => `${base(c.symbol)} ${c.dir === 'long' ? '多' : '空'}`).join('、')}`);
    if (failed.length) lines.push(`⚠️ 沒平成（下一根 4h 再試）：${failed.map((c) => `${base(c.symbol)}（${String(c.error).slice(0, 60)}）`).join('、')}`);
    await deps.postDiscord(env, { urgent: failed.length > 0, embeds: [{ title: `🧭 大方向：${dirLabel(regime.dir)}`, color: regime.dir === 1 ? 0x0a7a3b : 0xc0392b, description: lines.join('\n').slice(0, 3800) }] }).catch(() => {});
  }
  return { dir: regime.dir, flipped, closed: closed.length, failed: failed.length };
}
