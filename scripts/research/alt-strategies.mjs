#!/usr/bin/env node
/**
 * 別種做法的回測：幾個簡單、常見的順勢／回檔策略，跟 SMC 用同一套精準回測比較。
 *
 * 所有策略都在 K 棒收盤時判斷，下一根開盤用市價進場（沒有限價單「成交那根」的問題），
 * 停損用 ATR；出場規則另外組合（固定止盈、追蹤停損、目前 SMC 的保本＋追蹤）。
 *
 * 兩種算法都印：
 *   原週期  用 5000 根 K 棒的完整歷史（前後半段）
 *   5M     最近 --sub-days 天改用 5 分鐘 K 棒逐根跑（最準，前後半段）
 *
 * 用法：node scripts/research/alt-strategies.mjs --symbols=BTCUSDT,ETHUSDT --intervals=1h,4h --limit=5000 --sub=5m --sub-days=150
 */

import { opt as optFrom, klines, runSignals, r2, pct, printTable, simulatePortfolio, simulateProp } from './lib.mjs';
import { ema, atr, rsi } from '../../src/core/indicators.js';
import { breakoutSignal } from '../../src/strategies/breakout.js';
import { fakeoutEvents, FAKEOUT_DEFAULTS } from '../../src/strategies/fakeout.js';
import { prepare, ZOO } from './strategy-zoo.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT').split(',');
const INTERVALS = opt('intervals', '1h,4h').split(',');
const LIMIT = Number(opt('limit', 5000));
const SUB = opt('sub', '5m');
const SUB_DAYS = Number(opt('sub-days', 150));
const FEE = Number(opt('fee', 0.0011));
// --fee-model=split：手續費依「掛單（maker）／吃單（taker）」分開算，取代固定的 --fee
//   進場：市價＝taker、限價掛單＝maker；出場：止盈限價單＝maker，停損／追蹤停損＝taker
const FEE_MODEL = opt('fee-model', 'flat');
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
// --entries=market,L0:1,L0.25:2 進場方式：market＝下一根開盤市價；
//   L<幾倍 ATR>:<等幾根>＝在訊號收盤價往有利方向退幾倍 ATR 掛限價單，等這麼多根沒成交就放棄
//   R<等幾根>[:<停損幾倍 ATR>]＝突破回踩：在被突破的那條線掛限價單（只適用有 level 的突破策略）
const ENTRIES = opt('entries', 'market').split(',').filter(Boolean).map((e) => {
  if (e === 'market') return { name: 'market' };
  if (e.startsWith('R')) {
    const [bars, stopAtr] = e.slice(1).split(':').map(Number);
    return { name: e, retest: true, bars: bars || 3, stopAtr: stopAtr || null };
  }
  const [off, bars] = e.slice(1).split(':').map(Number);
  return { name: e, offsetAtr: off, bars: bars || 1 };
});
const WARMUP = 210;
const log = (...a) => console.log(...a);

/** 策略：在第 i 根收盤判斷，回傳 { dir, stopAtr } 或 null（只用第 i 根以前的資料） */
const STRATEGIES = {
  // 唐奇安通道突破：收盤突破前 N 根最高（低）點，而且在 EMA200 同一側；只取剛突破的第一根
  DONCH20: (x, i) => donchian(x, i, 20),
  DONCH55: (x, i) => donchian(x, i, 55),
  // 順勢回檔：EMA50 在 EMA200 之上（下），這根碰到 EMA20 又收回、收陽（陰）
  EMA_PB: (x, i) => {
    const { c, e20, e50, e200 } = x;
    const k = c[i];
    if (e200[i] == null || e20[i] == null) return null;
    if (e50[i] > e200[i] && k.close > e200[i] && k.low <= e20[i] && k.close > e20[i] && k.close > k.open) return { dir: 'long', stopAtr: 1.5 };
    if (e50[i] < e200[i] && k.close < e200[i] && k.high >= e20[i] && k.close < e20[i] && k.close < k.open) return { dir: 'short', stopAtr: 1.5 };
    return null;
  },
  // 順勢短線超跌／超漲：EMA200 之上 RSI(2) < 10 做多，之下 > 90 做空
  RSI2: (x, i) => {
    const { c, e200, r2v } = x;
    if (e200[i] == null || r2v[i] == null) return null;
    if (c[i].close > e200[i] && r2v[i] < 10 && !(r2v[i - 1] < 10)) return { dir: 'long', stopAtr: 2 };
    if (c[i].close < e200[i] && r2v[i] > 90 && !(r2v[i - 1] > 90)) return { dir: 'short', stopAtr: 2 };
    return null;
  },
};

// 策略庫（strategy-zoo.mjs）的常見策略一起測；--strategies=A,B 只測這幾個
Object.assign(STRATEGIES, ZOO);
// 工作流程的「variants」欄位會變成 --only：裡面是出場名稱的當出場篩選，其他的當策略篩選
const ONLY = opt('only', '').split(',').map((x) => x.trim()).filter(Boolean);
const ONLY_STRATS = [...opt('strategies', '').split(',').filter(Boolean), ...ONLY.filter((x) => x in STRATEGIES)];
if (ONLY_STRATS.length) for (const k of Object.keys(STRATEGIES)) if (!ONLY_STRATS.includes(k)) delete STRATEGIES[k];

/** 唐奇安突破：跟線上自動下單共用 src/strategies/breakout.js 的判斷 */
function donchian(x, i, n) {
  const s = breakoutSignal(x.c, { lookback: n }, i, { ema: x.e200, atr: x.a });
  return s ? { dir: s.dir, stopAtr: 2, level: s.level } : null;
}

/*
 * 假突破過濾（2026-09）：都是在突破那根收盤當下就看得到的條件，符合才進場。
 *   F1 突破幅度：收盤超過突破線至少 0.25 ATR
 *   F2 收在高點附近：做多收在整根 K 棒上面 1/4（做空下面 1/4）
 *   F3 成交量放大：突破那根的量 ≥ 前 20 根平均的 1.5 倍
 *   F4 趨勢強度：ADX(14) > 20
 *   F5 大盤同方向：做多時 BTC 收在 EMA200 之上（做空相反）
 *   F6 大週期同方向：收在「日線 EMA50」同一側（用本週期換算長度的 EMA 近似）
 *   F7 不追太遠：收盤離 EMA20 不超過 3 ATR
 *   F8 下一根確認：突破後下一根收盤還站在突破線外面才進場（再下一根開盤進）
 */
const BTC_TREND = new Map(); // 週期 → Map(K 棒時間 → 1 在 EMA200 之上／-1 之下)
const TF_MIN = { '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 };
const withFilter = (test) => (x, i) => {
  const s = donchian(x, i, 55);
  return s && test(x, i, s, s.dir === 'long' ? 1 : -1) ? s : null;
};
Object.assign(STRATEGIES, {
  DONCH55_F1: withFilter((x, i, s, d) => (x.close[i] - s.level) * d >= 0.25 * x.a[i]),
  DONCH55_F2: withFilter((x, i, s, d) => {
    const k = x.c[i];
    const range = k.high - k.low;
    if (!(range > 0)) return false;
    const pos = (k.close - k.low) / range;
    return d > 0 ? pos >= 0.75 : pos <= 0.25;
  }),
  DONCH55_F3: withFilter((x, i) => x.volS[i - 1] > 0 && x.vol[i] >= 1.5 * x.volS[i - 1]),
  DONCH55_F4: withFilter((x, i) => x.adx[i] > 20),
  DONCH55_F5: withFilter((x, i, s, d) => (BTC_TREND.get(x.interval)?.get(x.c[i].time) ?? 0) === d),
  DONCH55_F6: withFilter((x, i, s, d) => {
    if (!x.htf) x.htf = ema(x.close, Math.round((50 * 1440) / (TF_MIN[x.interval] ?? 240)));
    return x.htf[i] != null && (x.close[i] - x.htf[i]) * d > 0;
  }),
  DONCH55_F7: withFilter((x, i) => x.e20[i] != null && Math.abs(x.close[i] - x.e20[i]) <= 3 * x.a[i]),
  DONCH55_F8: (x, i) => {
    const s = donchian(x, i - 1, 55);
    if (!s) return null;
    const d = s.dir === 'long' ? 1 : -1;
    return (x.close[i] - s.level) * d > 0 ? s : null;
  },
});

// 假突破反手（src/strategies/fakeout.js 的 SW 模式，跟線上同一套判斷）：
// 停損是固定價格（假突破極值外 0.1 ATR），用 stopPrice 回傳；下一根開盤離停損不到 0.3 ATR 就不做
STRATEGIES.FAKEOUT = (x, i) => {
  if (!x.fo) {
    x.fo = new Map(fakeoutEvents(x.c, { from: WARMUP, lastBar: x.c.length - 2 }, { atr: x.a })
      .filter((e) => e.type === 'mss').map((e) => [e.index, e]));
  }
  const e = x.fo.get(i);
  return e ? { dir: e.rdir, stopPrice: e.stop } : null;
};

/** 出場規則（stepTrade 的設定＋止盈 R） */
const EXITS = {
  '固定 1R': { tpR: 1, cfg: { breakevenAtR: 0, trailFromR: 0 } },
  '固定 1.5R': { tpR: 1.5, cfg: { breakevenAtR: 0, trailFromR: 0 } },
  '固定 2R': { tpR: 2, cfg: { breakevenAtR: 0, trailFromR: 0 } },
  '1.5R 後追蹤 1.5R': { tpR: 20, cfg: { breakevenAtR: 0, trailFromR: 1.5, trailGapR: 1.5 } },
  // 想拉高勝率：先落袋一部分／提早保本，剩下的照樣追蹤
  '1R 先出一半＋追蹤': { tpR: 20, cfg: { scalpR: 1, scalpFraction: 0.5, breakevenAtR: 1, trailFromR: 1.5, trailGapR: 1.5 } },
  '1R 保本＋追蹤': { tpR: 20, cfg: { breakevenAtR: 1, trailFromR: 1.5, trailGapR: 1.5 } },
  '目前 SMC 保本＋追蹤': { tpR: 20, cfg: {} },
};
const EXITS_ALL = { ...EXITS };
// --exits=固定 1R,固定 2R 只測這幾種出場
const ONLY_EXITS = [...opt('exits', '').split(',').filter(Boolean), ...ONLY.filter((x) => x in EXITS)];
if (ONLY_EXITS.length) for (const k of Object.keys(EXITS)) if (!ONLY_EXITS.includes(k)) delete EXITS[k];
// 這些組合另外印詳細統計（勝率、連虧、多空、帳戶模擬）
const DETAIL = opt('detail', 'DONCH55,EMA_20_50,MACD_ZERO,ICHIMOKU,SUPERTREND').split(',').filter(Boolean);
const DETAIL_TF = opt('detail-tf', '4h');

const prepared = new Map();
function buildSignals(symbol, interval, c, name, en = ENTRIES[0] ?? { name: 'market' }) {
  const key = `${symbol}|${interval}`;
  if (!prepared.has(key)) prepared.set(key, Object.assign(prepare(c), { interval }));
  const x = prepared.get(key);
  const out = [];
  for (let i = WARMUP; i < c.length - 1; i++) {
    const s = STRATEGIES[name](x, i);
    if (!s || !(x.a[i] > 0)) continue;
    const market = en.name === 'market';
    const long = s.dir === 'long';
    if (en.retest && !(s.level > 0)) continue; // 沒有突破線的策略不能測回踩
    const entry = market ? c[i + 1].open : en.retest ? s.level : c[i].close + (long ? -1 : 1) * en.offsetAtr * x.a[i];
    let risk = x.a[i] * (en.retest && en.stopAtr ? en.stopAtr : s.stopAtr);
    let stop = long ? entry - risk : entry + risk;
    if (s.stopPrice) {
      // 固定價格的停損（假突破反手）：只支援市價進場
      if (!market) continue;
      risk = long ? entry - s.stopPrice : s.stopPrice - entry;
      if (!(risk > FAKEOUT_DEFAULTS.minRiskAtr * x.a[i])) continue;
      stop = s.stopPrice;
    }
    out.push({
      symbol, interval, index: i, time: c[i].time, dir: s.dir, entry, stop, entryType: market ? 'market' : 'limit',
      ...(market ? { filledTime: c[i + 1].time } : {}), stopPct: risk / entry, strategy: name,
      half: i < (WARMUP + c.length) / 2 ? 0 : 1,
    });
  }
  return out;
}

/**
 * 同一個幣同時只抱一張：上一張還沒平倉時出現的新訊號不算（實際下單也是這樣）。
 * 不過濾的話，突破行情裡同一個幣會連續加碼好幾張，統計跟帳戶模擬都會失真。
 */
function onePerSymbol(trades) {
  const lastClose = new Map();
  return [...trades].sort((a, b) => a.filledTime - b.filledTime).filter((t) => {
    const key = `${t.symbol}|${t.interval}`;
    if (t.filledTime < (lastClose.get(key) ?? -Infinity)) return false;
    lastClose.set(key, t.closedTime);
    return true;
  });
}

/** 詳細統計：勝率、平均賺賠、最長連虧、多空分開、帳戶模擬（每單 2／3／5%，同時持倉、複利） */
function printDetails(details, mid, netR) {
  if (!details.length) return;
  const rows = [];
  for (const [name, exitName, coarse, fine] of details) {
    const periods = [
      ['原週期 前半', coarse.filter((t) => t.half === 0)],
      ['原週期 後半', coarse.filter((t) => t.half === 1)],
      ['5M 前半', fine.filter((t) => t.filledTime < mid)],
      ['5M 後半', fine.filter((t) => t.filledTime >= mid)],
    ];
    for (const [period, list] of periods) {
      if (!list.length) continue;
      const sorted = [...list].sort((a, b) => a.closedTime - b.closedTime);
      const rs = sorted.map(netR);
      const wins = rs.filter((r) => r > 0);
      const losses = rs.filter((r) => r <= 0);
      let streak = 0, worst = 0;
      for (const r of rs) { if (r <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0; }
      const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const sim = sorted.map((t) => ({ ...t, r: netR(t), beTime: t.events.find((e) => e.type === 'breakeven')?.time ?? null }));
      const acct = (risk) => {
        const x = simulatePortfolio(sim, { riskPct: risk });
        return `${x.multiple.toFixed(2)}x／${x.maxDdPct.toFixed(0)}%`;
      };
      const acctCap = (risk, cap) => {
        const x = simulatePortfolio(sim, { riskPct: risk, maxAtRisk: cap });
        return `${x.multiple.toFixed(2)}x／${x.maxDdPct.toFixed(0)}%`;
      };
      rows.push([
        name, exitName, period, String(list.length), pct((wins.length / rs.length) * 100),
        r2(avg(wins)), r2(avg(losses)), r2(avg(rs)), String(worst),
        r2(avg(sorted.filter((t) => t.dir === 'long').map(netR))), r2(avg(sorted.filter((t) => t.dir === 'short').map(netR))),
        acct(1), acct(2), acct(3), acctCap(2, 5),
      ]);
    }
  }
  log(`\n■ 詳細統計（${DETAIL_TF}；每筆 R 已扣手續費；帳戶＝最後倍數／最大回撤，同時持倉、複利）`);
  printTable(log, ['策略', '出場', '期間', '筆數', '勝率', '平均賺', '平均虧', '每筆', '最長連虧', '多單', '空單', '帳戶 1%', '帳戶 2%', '帳戶 3%', '2%＋未保本最多5張'], rows);
}

/**
 * 組合風險模擬：--only（工作流程的 variants 欄位）放「策略:出場」，例如
 *   DONCH55:固定 1R,EMA_20_50:1R 保本＋追蹤
 * 會把這幾組的交易合在同一個帳戶裡跑（同一個幣同時只抱一張，跟線上一樣），
 * 列出每單風險 % × 最多同時幾張 × 同方向最多幾張 的最後倍數、最大回撤、每月成長。
 */
// 「策略@週期:出場」可以指定週期（例如 EMA_20_50@6h:1R 保本＋追蹤）；週期要包含在 --intervals 裡才會抓資料
const COMBO = ONLY.filter((x) => x.includes(':')).map((x) => {
  const [head, exitName] = x.split(':');
  const [name, iv] = head.split('@');
  if (!STRATEGIES[name] && !ZOO[name]) throw new Error(`沒有這個策略：${name}`);
  if (!EXITS_ALL[exitName]) throw new Error(`沒有這個出場：${exitName}`);
  return { name, exitName, interval: iv || INTERVALS[0] };
});

function runCombo(candlesBy, mid, netR) {
  const DAY = 86_400_000;
  const per = COMBO.map(({ name, exitName, interval }) => {
    const fn = STRATEGIES[name] ?? ZOO[name];
    STRATEGIES[name] = fn;
    const { tpR, cfg } = EXITS_ALL[exitName];
    const sigs = SYMBOLS.flatMap((sym) => {
      const c = candlesBy.get(`${sym}|${interval}`);
      return c ? buildSignals(sym, interval, c, name) : [];
    });
    const s = withTargets(sigs, tpR);
    // 上限算「所有還開著的單」（跟線上最多同時幾張一樣），所以不帶保本時間
    const label = `${name}${interval === INTERVALS[0] ? '' : `@${interval}`}／${exitName}`;
    const tag = (t) => ({ ...t, r: netR(t), beTime: null, label });
    const coarse = runSet(s, candlesBy, cfg).map(tag);
    const fine = SUB ? runSet(s, candlesBy, { ...cfg, subBars: true }).map(tag) : [];
    return { label, coarse, fine };
  });
  const groups = per.length > 1 ? [...per.map((p) => [p]), per] : [per];
  const list = (k, d) => opt(k, d).split(',').map((v) => (v === 'inf' ? Infinity : Number(v)));
  const RISKS = list('risks', '1,1.5,2,2.5,3,4');
  const CAPS = list('caps', '3,5,8,10,12,inf');
  const DIRS = list('dirs', 'inf,3,4,5,6');
  const [sRisk, sCap, sDir] = list('single', '3,5,3');
  const json = [];
  // 原週期用時間切前後半（不同週期的 K 棒涵蓋的天數不一樣），只取每一組都有資料的那段
  const cStart = Math.max(...per.map((p) => Math.min(...p.coarse.map((t) => t.filledTime))));
  const cEnd = Math.max(...per.flatMap((p) => p.coarse.map((t) => t.closedTime)));
  const cMid = (cStart + cEnd) / 2;
  for (const g of groups) {
    const all = (k) => g.flatMap((p) => p[k]);
    const coarseAll = all('coarse').filter((t) => t.filledTime >= cStart);
    const periods = [
      ['原週期 前半', coarseAll.filter((t) => t.filledTime < cMid)],
      ['原週期 後半', coarseAll.filter((t) => t.filledTime >= cMid)],
      ['5M 前半', all('fine').filter((t) => t.filledTime < mid)],
      ['5M 後半', all('fine').filter((t) => t.filledTime >= mid)],
      ['原週期 全段', coarseAll],
    ].map(([n, xs]) => {
      const sorted = [...xs].sort((a, b) => a.filledTime - b.filledTime);
      const days = sorted.length ? (Math.max(...sorted.map((t) => t.closedTime)) - sorted[0].filledTime) / DAY : 0;
      return { n, xs: sorted, days };
    });
    if (PROP) {
      if (g === groups.at(-1)) runPropSim(g.map((p) => p.label).join(' ＋ '), periods);
      continue;
    }
    const rows = [];
    for (const risk of RISKS) for (const cap of CAPS) for (const dir of DIRS) {
      if (dir !== Infinity && dir >= cap) continue;
      if (groups.length > 1 && g !== groups.at(-1) && !(risk === sRisk && cap === sCap && dir === sDir)) continue; // 單一策略只印一種設定當對照
      const res = periods.map((p) => {
        const x = simulatePortfolio(p.xs, { riskPct: risk, maxAtRisk: cap, maxSameDirAtRisk: dir, oneBySymbol: true });
        const monthly = p.days > 0 ? (x.multiple ** (30 / p.days) - 1) * 100 : 0;
        return { ...x, monthly };
      });
      json.push({ g: g.map((p) => p.label).join('+'), risk, cap: cap === Infinity ? 0 : cap, dir: dir === Infinity ? 0 : dir,
        m: res.map((x) => Math.round(x.multiple * 1000) / 1000), dd: res.map((x) => Math.round(x.maxDdPct)), mo: res.map((x) => Math.round(x.monthly * 10) / 10),
        days: periods.map((p) => Math.round(p.days)) });
      rows.push([
        `${risk}%`, cap === Infinity ? '不限' : String(cap), dir === Infinity ? '不限' : String(dir),
        ...res.map((x) => `${x.multiple.toFixed(2)}x／${x.maxDdPct.toFixed(0)}%`),
        `${Math.max(...res.map((x) => x.maxDdPct)).toFixed(0)}%`,
        `${Math.min(...res.slice(0, 4).map((x) => x.monthly)).toFixed(1)}%`,
        `${res[4].monthly.toFixed(1)}%`,
        // 照全段的每月成長，300U 滾到 3000U（10 倍）要幾個月
        res[4].monthly > 0 ? (Math.log(10) / Math.log(1 + res[4].monthly / 100)).toFixed(0) : '-',
      ]);
    }
    const names = g.map((p) => p.label).join(' ＋ ');
    log(`\n■ 組合：${names}（${INTERVALS.join('/')}；${SYMBOLS.length} 檔；筆數 ${periods.map((p) => `${p.n} ${p.xs.length}`).join('、')}；天數 ${periods.map((p) => p.days.toFixed(0)).join('／')}）`);
    log('  每格＝最後倍數／最大回撤；每月＝換算成每 30 天的複利成長；同一個幣同時只抱一張');
    printTable(log, ['每單風險', '最多同時', '同方向最多', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '原週期 全段', '最大回撤', '每月（最差段）', '每月（全段）', '滾 10 倍（月）'], rows);
  }
  log('\nCOMBO_JSON ' + JSON.stringify(json));
}

/**
 * --prop：自營商兩步挑戰模擬（規則見 lib.mjs simulateProp；預設是使用者的 10000 USDT 兩步挑戰）。
 * 每隔 --prop-step 天換一個開考日，照「考試守門員」的倉位規則接組合裡的交易，
 * 統計過關率、失敗率、要考幾天，以及平均要買幾次考試（報名費 --prop-fee）。
 */
const PROP = opt('prop', '') !== '';
function runPropSim(names, periods) {
  const DAY = 86_400_000;
  const list = (k, d) => opt(k, d).split(',').map(Number);
  const RISKS = list('prop-risks', '0.25,0.5,0.75,1,1.5,2');
  const CAPS = list('prop-caps', '3,5');
  const STEP = Number(opt('prop-step', 2));
  const FEE_USDT = Number(opt('prop-fee', 59.4));
  const rules = {
    account: Number(opt('prop-account', 10000)),
    targets: list('prop-targets', '500,1000'),
    dailyLoss: Number(opt('prop-daily', 500)),
    maxLoss: Number(opt('prop-max', 1000)),
    minDayProfit: Number(opt('prop-day-profit', 50)),
    minProfitDays: Number(opt('prop-days', 3)),
    maxLeverage: Number(opt('prop-leverage', 5)),
  };
  const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  const json = [];
  log(`\n■ 自營商兩步挑戰模擬：${names}`);
  log(`  規則：帳戶 ${rules.account}、目標 ${rules.targets.join('／')}、每日虧損 ${rules.dailyLoss}、最大損失 ${rules.maxLoss}、`
    + `獲利日 ${rules.minProfitDays} 天（每天 +${rules.minDayProfit}）、槓桿 ${rules.maxLeverage} 倍；每 ${STEP} 天換一個開考日`);
  log('  倉位照考試守門員：每筆 min(風險%、今天剩餘一半、總剩餘四分之一)；今天虧到每日上限一半就收工；只看平倉淨值（浮虧看不到）');
  for (const per of periods) {
    if (!per.xs.length) continue;
    const first = per.xs[0].filledTime;
    const last = Math.max(...per.xs.map((t) => t.closedTime));
    const rows = [];
    for (const risk of RISKS) for (const cap of CAPS) for (const lock of [false, true]) {
      const res = [];
      for (let st = first; st < last - 7 * DAY; st += STEP * DAY) {
        res.push(simulateProp(per.xs, { ...rules, startTime: st, riskPct: risk, maxOpen: cap, lockProfitDay: lock }));
      }
      const done = res.filter((r) => r.result !== 'open');
      const pass = done.filter((r) => r.result === 'pass');
      const failD = done.filter((r) => r.result === 'fail-daily').length;
      const failT = done.filter((r) => r.result === 'fail-total').length;
      const p1 = done.filter((r) => r.result === 'pass' || r.phase > 0).length;
      const passRate = done.length ? pass.length / done.length : NaN;
      const days = pass.map((r) => r.days);
      json.push({ per: per.n, risk, cap, lock, n: res.length, done: done.length, pass: pass.length, p1, failD, failT,
        med: Math.round(q(days, 0.5)), p80: Math.round(q(days, 0.8)) });
      rows.push([
        `${risk}%`, String(cap), lock ? '收工' : '繼續',
        `${res.length}／${done.length}`,
        done.length ? pct((p1 / done.length) * 100) : '-',
        done.length ? pct(passRate * 100) : '-',
        done.length ? `${pct((failD / done.length) * 100)}／${pct((failT / done.length) * 100)}` : '-',
        days.length ? `${q(days, 0.5).toFixed(0)}／${q(days, 0.8).toFixed(0)}` : '-',
        passRate > 0 ? `${(1 / passRate).toFixed(1)} 次（${(FEE_USDT / passRate).toFixed(0)}U）` : '-',
      ]);
    }
    log(`\n  ▸ ${per.n}（${per.days.toFixed(0)} 天、${per.xs.length} 筆交易）`);
    printTable(log, ['每筆風險', '最多同時', '當天賺到獲利日', '開考次數／有結果', '過階段一', '兩階段都過', '失敗（每日／總額）', '過關天數（中位／80%）', '平均要買幾次'], rows);
  }
  log('\nPROP_JSON ' + JSON.stringify(json));
}

/** 一進一出的手續費（占倉位價值） */
function feeOf(t) {
  if (FEE_MODEL !== 'split') return FEE;
  const entryFee = t.entryType === 'limit' ? MAKER : TAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}

/** 跑一組訊號：沒成交（限價單等太久）的不算；同一個幣同時只抱一張 */
function runSet(sigs, candlesBy, cfg, en) {
  const c = en && en.name !== 'market' ? { ...cfg, entryWindowBars: en.bars, fillBarPath: true } : cfg;
  return onePerSymbol(runSignals(sigs, candlesBy, c).filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout')));
}

const withTargets = (sigs, tpR) => sigs.map((s) => ({
  ...s,
  targets: [{ name: 'TP1', price: s.dir === 'long' ? s.entry + (s.entry - s.stop) * tpR : s.entry - (s.stop - s.entry) * tpR, rr: tpR }],
}));

(async () => {
  const candlesBy = new Map();
  let subStart = Infinity, subEnd = -Infinity;
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      try {
        candlesBy.set(`${symbol}|${interval}`, await klines(symbol, interval, LIMIT));
      } catch (e) { log(`  ${symbol} ${interval}: 取得資料失敗（${e.message}）`); }
    }
    if (SUB) {
      try {
        const s = await klines(symbol, SUB, Math.ceil((SUB_DAYS * 1440) / ({ '1m': 1, '5m': 5, '15m': 15 }[SUB] ?? 5)));
        candlesBy.set(`${symbol}|sub`, s);
        subStart = Math.min(subStart, s[0].time);
        subEnd = Math.max(subEnd, s[s.length - 1].time);
      } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
    log(`  ${symbol} 資料完成`);
  }
  // F5 要用 BTC 的趨勢：BTC 不在幣種清單裡就另外抓
  if (Object.keys(STRATEGIES).some((k) => k.endsWith('_F5'))) {
    for (const iv of INTERVALS) {
      const b = candlesBy.get(`BTCUSDT|${iv}`) ?? await klines('BTCUSDT', iv, LIMIT).catch(() => null);
      if (!b) { log(`  BTC ${iv} 抓不到，F5 不會有訊號`); continue; }
      const e = ema(b.map((k) => k.close), 200);
      BTC_TREND.set(iv, new Map(b.map((k, j) => [k.time, e[j] == null ? 0 : k.close > e[j] ? 1 : -1])));
    }
  }
  const mid = (subStart + subEnd) / 2;
  const netR = (t) => t.r - feeOf(t) / t.stopPct;
  const cell = (xs) => (xs.length ? `${r2(xs.reduce((a, t) => a + netR(t), 0) / xs.length)}（${xs.length}）` : '-');
  const weeks = SUB_DAYS / 7;

  if (COMBO.length) { runCombo(candlesBy, mid, netR); return; }

  const details = [];
  const summary = [];
  for (const interval of INTERVALS) {
    const rows = [];
    for (const name of Object.keys(STRATEGIES)) for (const en of ENTRIES) {
      const sigs = SYMBOLS.flatMap((sym) => {
        const c = candlesBy.get(`${sym}|${interval}`);
        return c ? buildSignals(sym, interval, c, name, en) : [];
      });
      for (const [exitName0, { tpR, cfg }] of Object.entries(EXITS)) {
        const exitName = en.name === 'market' ? exitName0 : `${exitName0}／${en.name}`;
        const s = withTargets(sigs, tpR);
        const coarse = runSet(s, candlesBy, cfg, en);
        const fine = SUB ? runSet(s, candlesBy, { ...cfg, subBars: true }, en) : [];
        const fineHalf = (h) => fine.filter((t) => (t.filledTime < mid ? 0 : 1) === h);
        rows.push([
          name, exitName,
          cell(coarse.filter((t) => t.half === 0)), cell(coarse.filter((t) => t.half === 1)),
          cell(fineHalf(0)), cell(fineHalf(1)),
          fine.length ? pct((fine.filter((t) => netR(t) > 0).length / fine.length) * 100) : '-',
          (fine.length / weeks).toFixed(1),
        ]);
        if (interval === DETAIL_TF && DETAIL.includes(name)) details.push([name, exitName, coarse, fine]);
        const avg = (xs) => (xs.length ? xs.reduce((a, t) => a + netR(t), 0) / xs.length : NaN);
        const four = [avg(coarse.filter((t) => t.half === 0)), avg(coarse.filter((t) => t.half === 1)), avg(fineHalf(0)), avg(fineHalf(1))];
        summary.push({ interval, name, exitName, four, min: Math.min(...four), win: fine.length ? fine.filter((t) => netR(t) > 0).length / fine.length : NaN, perWeek: fine.length / weeks, n: coarse.length });
      }
    }
    log(`\n■ ${interval}（扣手續費每筆 R，括號是筆數；5M＝最近 ${SUB_DAYS} 天用 5 分鐘 K 棒逐根跑）`);
    printTable(log, ['策略', '出場', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '5M 勝率', '5M 每週幾張'], rows);
  }
  printDetails(details, mid, netR);

  // 四格（原週期前後半、5M 前後半）都賺的組合，照最差那一格排序
  const robust = summary.filter((r) => r.four.every((v) => v > 0)).sort((a, b) => b.min - a.min);
  log(`\n■ 四格都賺的組合（共 ${robust.length} 個／${summary.length} 個，照最差那格排序；每筆 R 已扣手續費）`);
  printTable(log, ['週期', '策略', '出場', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '最差', '5M 勝率', '5M 每週幾張'],
    robust.map((r) => [r.interval, r.name, r.exitName, ...r.four.map(r2), r2(r.min), pct(r.win * 100), r.perWeek.toFixed(1)]));
  log('\nSUMMARY_JSON ' + JSON.stringify(summary.map((r) => ({ i: r.interval, s: r.name, e: r.exitName, f: r.four.map((v) => Math.round(v * 1000) / 1000), w: Math.round(r.win * 1000) / 1000, pw: Math.round(r.perWeek * 10) / 10 }))));
})();
