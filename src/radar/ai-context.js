/**
 * 給「問 AI」的市場快照：把幣種雷達頁面當下的資料（全週期報告、大戶動向、合約數據）壓成一份精簡 JSON，
 * 放進使用者訊息的 <snapshot> 標籤裡。純函式（網頁跟測試共用）。
 *
 * 價格保留 6 位有效數字、百分比 2 位小數，各清單只取前幾筆，控制在約 1 萬 token 以內。
 */

const sig = (v, n = 6) => (Number.isFinite(v) ? +Number(v).toPrecision(n) : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const tw = (ms) => {
  if (!ms) return null;
  const d = new Date(ms + 8 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

function tfBrief(t) {
  const s = t.setup;
  return {
    tf: t.interval,
    bias: t.bias.score,
    htfBias: t.htfBias?.score ?? null,
    swing: t.swingTrend,
    internal: t.internalTrend,
    events: t.events.slice(0, 2).map((e) => `${e.scope === 'swing' ? '大' : '小'}${e.type}${e.dir === 'bull' ? '多' : '空'}@${sig(e.price)}（${e.barsAgo}根前）`),
    liqAbove: t.liquidity.above.slice(0, 3).map((p) => [sig(p.price), p.touches]),
    liqBelow: t.liquidity.below.slice(0, 3).map((p) => [sig(p.price), p.touches]),
    sweeps: t.liquidity.sweeps.slice(0, 2).map((x) => `${x.side === 'buyside' ? '掃上方' : '掃下方'}${sig(x.level)}→${sig(x.extreme)}（${tw(x.time)}）`),
    idm: t.liquidity.inducement ? { price: sig(t.liquidity.inducement.price), taken: t.liquidity.inducement.taken } : null,
    pd: t.pd ? { zone: t.pd.zone, pct: t.pd.pct, low: sig(t.pd.low), high: sig(t.pd.high) } : null,
    vp: t.vp ? { poc: sig(t.vp.poc), vah: sig(t.vp.vah), val: sig(t.vp.val) } : null,
    ema: { e20: sig(t.ema.e20), e50: sig(t.ema.e50), e200: sig(t.ema.e200) },
    rsi: t.rsi,
    atrPct: t.atrPct,
    pois: t.pois.slice(0, 3).map((z) => `${z.type}${z.dir === 'bull' ? '需求' : '供給'} ${sig(z.bottom)}～${sig(z.top)}`),
    plan: s.none ? { none: s.reasonZh } : {
      dir: s.dir, entry: sig(s.entry), stop: sig(s.stop), entryType: s.entryType, grade: s.grade, score: s.score, valid: s.valid,
      targets: s.targets.map((x) => [x.name, sig(x.price), x.rr]),
    },
    trend: t.trend ? {
      supertrend: t.trend.supertrend, ema20Above50: t.trend.emaFastAbove, aboveEma200: t.trend.aboveEma200, macdAbove0: t.trend.macdAboveZero, sma50Above200: t.trend.sma50Above200,
      last: Object.fromEntries(Object.entries(t.trend.last).filter(([, v]) => v).map(([k, v]) => [k, `${v.dir === 'long' ? '多' : '空'}（${v.barsAgo}根前）`])),
    } : null,
  };
}

/**
 * @param {object} p
 * @param {string} p.symbol
 * @param {'live'|'closed'} p.mode
 * @param {number} p.price
 * @param {object} p.report       buildCoinReport() 的結果
 * @param {object} [p.ticker]     { change, high, low, quoteVolume }
 * @param {object} [p.deriv]      fetchDerivatives() 的結果
 * @param {Array}  [p.ls]         Bybit 帳戶多空比 [{ buy, sell }]
 * @param {object} [p.whales]     { walls, stats: tradeStats(), threshold, ratio: whaleVsCrowd() }
 * @param {Array}  [p.changes]    最近變化 [{ time, items: [{ zh }] }]
 * @param {boolean} [p.full=true] false＝只給摘要（追問時用，省 token）
 */
export function buildAiSnapshot({ symbol, mode, price, report, ticker, deriv, ls, whales, changes = [], full = true, now = Date.now() }) {
  const pct = (p) => (Number.isFinite(p) && price ? r2(((p - price) / price) * 100) : null);
  const snap = {
    symbol,
    time: tw(now),
    mode,
    price: sig(price),
    change24hPct: r2(ticker?.change),
    high24h: sig(ticker?.high),
    low24h: sig(ticker?.low),
    summary: {
      overall: `${report.agg.labelZh}（${report.agg.score}），${report.agg.alignment}% 週期同向`,
      htf: report.htf ? `日線＋週線${report.htf.labelZh}（${report.htf.score}）` : null,
      biasByTf: Object.fromEntries(report.tfs.map((t) => [t.interval, t.bias.score])),
      best: report.best ? { tf: report.best.tf, dir: report.best.dir, entry: sig(report.best.entry), distPct: pct(report.best.entry), stop: sig(report.best.stop), targets: report.best.targets.map((x) => [sig(x.price), x.rr]), grade: report.best.grade, score: report.best.score, againstHtf: report.best.againstHtf } : null,
      conflicts: (report.conflicts ?? []).map((c) => `${sig(c.low)}～${sig(c.high)}：${c.longs.join('/')}多、${c.shorts.join('/')}空`),
      liqAbove: report.liqAbove.slice(0, 4).map((x) => `${sig(x.price)}（${pct(x.price)}%，${x.tfs.join('/')}，${x.touches}次）`),
      liqBelow: report.liqBelow.slice(0, 4).map((x) => `${sig(x.price)}（${pct(x.price)}%，${x.tfs.join('/')}，${x.touches}次）`),
      keyLevels: Object.fromEntries((report.levels ?? []).map((l) => [l.zh, sig(l.price)])),
      liquidationEst: report.liquidation ? {
        longsBelow: report.liquidation.longs.map((x) => `${sig(x.price)}（強度${x.strength}）`),
        shortsAbove: report.liquidation.shorts.map((x) => `${sig(x.price)}（強度${x.strength}）`),
      } : null,
      recentChanges: changes.slice(0, 5).map((c) => `${tw(c.time)} ${c.items.map((i) => i.zh).join('；')}`),
    },
  };
  if (deriv && Number.isFinite(deriv.fundingRate)) {
    const s = deriv.oiSeries ?? [];
    const oiChg = s.length > 1 && s[0].value > 0 ? r2(((s[s.length - 1].value - s[0].value) / s[0].value) * 100) : null;
    snap.derivatives = { fundingPct8h: +(deriv.fundingRate * 100).toFixed(4), oiChange24hPct: oiChg, source: deriv.provider };
  }
  if (ls?.length) { const r = ls[ls.length - 1]; snap.bybitAccountLongPct = r2(r.buy * 100); }
  if (whales) {
    const w = whales.stats?.windows ?? [];
    snap.whales = {
      bigTradeThresholdUsdt: whales.threshold,
      walls: (whales.walls ?? []).slice().sort((a, b) => b.notional - a.notional).slice(0, 6)
        .map((x) => `${x.side === 'bid' ? '買牆' : '賣牆'} ${sig(x.price)}（${pct(x.price)}%）${Math.round(x.notional / 1000)}K ${x.ex}，比附近大${x.times}倍，${x.seenCount > 1 ? `已掛${Math.round((now - x.firstSeen) / 60000)}分鐘` : '剛出現'}`),
      bigTrades: w.map((x) => `近${x.minutes}分 大單買${Math.round(x.bigBuy / 1000)}K／賣${Math.round(x.bigSell / 1000)}K（${x.bigCount}筆）`),
      topTraderVsCrowd: whales.ratio ? `${whales.ratio.zh}（大戶多${r2(whales.ratio.top.long * 100)}%${whales.ratio.global ? `、全部帳戶多${r2(whales.ratio.global.long * 100)}%` : ''}）` : null,
    };
  }
  if (full) snap.timeframes = report.tfs.map(tfBrief);
  else snap.note = '追問：只附最新摘要，各週期細節見對話前面的快照（價格可能已經變了）';
  return snap;
}

/** 組成使用者訊息：快照放在 <snapshot> 標籤裡，問題放後面 */
export function aiUserMessage(snapshot, question) {
  return `<snapshot>\n${JSON.stringify(snapshot)}\n</snapshot>\n\n${String(question).trim()}`;
}
