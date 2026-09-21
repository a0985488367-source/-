/**
 * 衍生品資料來源（資金費率 + 未平倉量）
 *
 * 這三家的永續合約 API 都是公開的、不需要金鑰。任何一家被擋或改版時
 * 自動換下一家 —— 跟 K 線的多交易所備援是同一個思路。
 *
 * 統一輸出格式：
 *   { provider, symbol, fundingRate, nextFundingTime, openInterest, oiSeries }
 *   fundingRate 一律換算成「每 8 小時」的比例（0.0001 = 0.01%）
 *   oiSeries 由舊到新：[{ time, value }]
 */

const J = async (url, { timeout = 10000 } = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
};

/** BTCUSDT → BTC-USDT-SWAP（OKX 用的格式） */
const toOkx = (symbol) => {
  const m = /^(.+?)(USDT|USDC)$/.exec(symbol);
  return m ? `${m[1]}-${m[2]}-SWAP` : symbol;
};
/** BTCUSDT → BTC */
const baseOf = (symbol) => symbol.replace(/(USDT|USDC|USD)$/, '');

export const DERIV_PROVIDERS = {
  binance: {
    id: 'binance',
    label: 'Binance 永續',
    async fetch(symbol, { limit = 24, period = '1h' } = {}) {
      const [prem, oiHist] = await Promise.all([
        J(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
        J(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`).catch(() => []),
      ]);
      const series = (Array.isArray(oiHist) ? oiHist : []).map((r) => ({
        time: Number(r.timestamp),
        value: Number(r.sumOpenInterest),
        notional: Number(r.sumOpenInterestValue),
      }));
      return {
        provider: 'binance',
        symbol,
        fundingRate: Number(prem.lastFundingRate),
        nextFundingTime: Number(prem.nextFundingTime),
        markPrice: Number(prem.markPrice),
        openInterest: series.length ? series[series.length - 1].value : null,
        openInterestValue: series.length ? series[series.length - 1].notional : null,
        oiUnit: 'base',   // 以標的幣計價（例如幾顆 BTC）
        oiSeries: series,
      };
    },
  },

  bybit: {
    id: 'bybit',
    label: 'Bybit 永續',
    async fetch(symbol, { limit = 24, period = '1h' } = {}) {
      const iv = period === '5m' ? '5min' : period === '15m' ? '15min' : period === '4h' ? '4h' : '1h';
      const [tick, oi] = await Promise.all([
        J(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`),
        J(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${iv}&limit=${limit}`).catch(() => null),
      ]);
      const t = tick?.result?.list?.[0];
      if (!t) throw new Error('Bybit 沒有這個永續合約');
      // Bybit 回傳由新到舊，翻過來統一成由舊到新
      const series = (oi?.result?.list ?? [])
        .map((r) => ({ time: Number(r.timestamp), value: Number(r.openInterest) }))
        .reverse();
      return {
        provider: 'bybit',
        symbol,
        fundingRate: Number(t.fundingRate),
        nextFundingTime: Number(t.nextFundingTime),
        markPrice: Number(t.markPrice),
        openInterest: Number(t.openInterest),
        openInterestValue: Number(t.openInterestValue),
        oiUnit: 'base',
        oiSeries: series,
      };
    },
  },

  okx: {
    id: 'okx',
    label: 'OKX 永續',
    async fetch(symbol, { period = '1h' } = {}) {
      const inst = toOkx(symbol);
      const bar = period === '4h' ? '4H' : period === '5m' ? '5m' : '1H';
      const [fr, oi] = await Promise.all([
        J(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`),
        J(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${baseOf(symbol)}&period=${bar}`).catch(() => null),
      ]);
      const f = fr?.data?.[0];
      if (!f) throw new Error('OKX 沒有這個永續合約');
      const series = (oi?.data ?? [])
        .map((r) => ({ time: Number(r[0]), value: Number(r[1]) }))
        .sort((a, b) => a.time - b.time);
      return {
        provider: 'okx',
        symbol,
        // OKX 的 fundingRate 週期可能不是 8 小時，換算成每 8 小時以便比較
        fundingRate: normalizeOkxFunding(f),
        nextFundingTime: Number(f.nextFundingTime ?? f.fundingTime),
        markPrice: null,
        openInterest: series.length ? series[series.length - 1].value : null,
        // 注意：OKX 這支是「整個幣種」的未平倉量（含所有合約），不是單一永續，
        // 而且以美元計價。拿來看「增減趨勢」沒問題，但絕對值不能跟其他家比大小。
        oiUnit: 'usd',
        oiScope: 'currency',
        oiSeries: series,
      };
    },
  },
};

/** OKX 少數合約是 4 小時收一次，統一折算成 8 小時基準才能跟其他家比較 */
function normalizeOkxFunding(f) {
  const rate = Number(f.fundingRate);
  const cycleMs = Number(f.nextFundingTime) - Number(f.fundingTime);
  if (!Number.isFinite(rate)) return null;
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return rate;
  return rate * (8 * 3600000 / cycleMs);
}

/**
 * 依序嘗試各交易所，第一個成功的就用。
 * @param {string} symbol 例如 'BTCUSDT'
 */
/**
 * 上次成功的來源。實測發現 Binance 永續（fapi）對美國 IP 回 451、
 * Bybit 回 403，而 GitHub Actions 的機器就在美國 —— 所以推播那條
 * 管線實際上只有 OKX 能用。記住上次成功的來源，就不用每次都先白試兩家、
 * 白等兩次逾時。瀏覽器端（台灣）三家都通，一樣會自己挑到最快的那家。
 */
let lastGood = null;

export function resetDerivProviderCache() { lastGood = null; }

export async function fetchDerivatives(symbol, opts = {}, providers = ['binance', 'bybit', 'okx']) {
  const order = lastGood && providers.includes(lastGood)
    ? [lastGood, ...providers.filter((p) => p !== lastGood)]
    : providers;
  let err;
  for (const id of order) {
    const p = DERIV_PROVIDERS[id];
    if (!p) continue;
    try {
      const r = await p.fetch(symbol, opts);
      if (Number.isFinite(r.fundingRate)) { lastGood = id; return r; }
    } catch (e) { err = e; }
  }
  throw err || new Error('沒有可用的衍生品資料來源');
}

/* ---------------------------------------------- 全市場未平倉量快照 */

/**
 * 一次抓回 OKX 所有永續合約的未平倉量。
 *
 * 為什麼需要這個：OKX 的「未平倉量歷史」端點（rubik）只涵蓋主流幣，
 * 實測 13 檔進榜幣種裡只有 2 檔拿得到序列，等於未平倉量這半邊形同虛設。
 * 而「目前未平倉量」端點涵蓋所有永續、而且一次呼叫就能全部拿回來。
 *
 * 搭配 snapshotChange()：把上一次掃描存下來的數值當基準算變化率，
 * 就不再依賴交易所提供歷史。掃描本來就每 15 分鐘到 2 小時跑一次，
 * 這個間隔拿來看「持倉在增還是在減」剛剛好。
 *
 * @returns {Promise<Map<string, {value:number, time:number}>>} key 為 BTCUSDT 這種格式
 */
export async function fetchAllOpenInterest() {
  const r = await J('https://www.okx.com/api/v5/public/open-interest?instType=SWAP');
  const map = new Map();
  for (const row of r?.data ?? []) {
    // BTC-USDT-SWAP → BTCUSDT，非 USDT 本位的合約跳過
    const m = /^(.+?)-(USDT)-SWAP$/.exec(row.instId ?? '');
    if (!m) continue;
    const value = Number(row.oiCcy ?? row.oi);
    if (!(value > 0)) continue;
    map.set(`${m[1]}${m[2]}`, { value, time: Number(row.ts) || Date.now() });
  }
  return map;
}

/**
 * 以上一次的快照算未平倉量變化率。
 * @param {{value:number,time:number}|null} now
 * @param {{value:number,time:number}|null} prev
 * @returns {{pct:number, hours:number}|null} 間隔太短或太長都回 null（沒有參考價值）
 */
export function snapshotChange(now, prev, { minHours = 0.2, maxHours = 12 } = {}) {
  if (!now?.value || !prev?.value) return null;
  const hours = Math.abs(now.time - prev.time) / 3600000;
  if (!(hours >= minHours && hours <= maxHours)) return null;
  return { pct: ((now.value - prev.value) / prev.value) * 100, hours };
}
