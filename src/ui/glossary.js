/**
 * 教學辭典 + 實戰流程：把 SMC 術語講清楚，並說明本程式「怎麼算」。
 * 這是本專案刻意強化的部分 —— 工具要專業，也要看得懂。
 */

export const GLOSSARY = [
  {
    id: 'structure',
    tag: '結構',
    term: 'Market Structure 市場結構',
    zh: '由一連串擺動高低點（Swing High / Low）構成的框架。多頭＝HH+HL；空頭＝LH+LL。結構是所有 SMC 判斷的地基。',
    en: 'The sequence of swing highs and lows. Bullish = higher highs + higher lows; bearish = lower highs + lower lows.',
    how: '本程式以「n 根對稱分形」找擺動點（內部 n=2、擺動 n=7 可調），並強制高低交替後再判斷突破。',
    trade: '先看結構定方向，再找進場。逆結構交易需要 CHoCH 作為前提。',
  },
  {
    id: 'bos',
    tag: '結構',
    term: 'BOS（Break of Structure）結構突破',
    zh: '順著原有趨勢方向突破前一個擺動點，代表趨勢延續。',
    en: 'A break in the direction of the prevailing trend — continuation.',
    how: '以收盤價（預設）突破「最近一個已確認且未被突破的擺動點」時判定；可切換成影線判定。',
    trade: 'BOS 之後回測造成突破的 OB / FVG，是順勢進場的標準劇本。',
  },
  {
    id: 'choch',
    tag: '結構',
    term: 'CHoCH（Change of Character）性質轉變',
    zh: '逆著原趨勢方向突破前一個擺動點，是趨勢可能反轉的第一個訊號。',
    en: 'A break against the prevailing trend — the first sign of reversal.',
    how: '同 BOS 的判定，但方向與當前趨勢相反時標記為 CHoCH（圖上為金色）。',
    trade: 'CHoCH 只是「警訊」不是「訊號」。標準做法：CHoCH → 等回測 OB/FVG → 低週期再出現 CHoCH 才進場。',
  },
  {
    id: 'ob',
    tag: '區塊',
    term: 'Order Block 訂單塊',
    zh: '造成結構突破前的「最後一根反向 K 棒」，代表機構掛單區。價格回來時常出現反應。',
    en: 'The last opposing candle before an impulsive move that breaks structure.',
    how: '以每個 BOS/CHoCH 往回找最後一根反向 K 棒，並要求推動腿位移 ≥ 1 ATR（可調）。品質分數綜合位移、量能、是否含 FVG、是否先掃流動性、新鮮度。',
    trade: '優先選「新鮮（未被回測）＋內含 FVG＋形成前掃過流動性」的 OB，停損放在 OB 另一側。',
  },
  {
    id: 'breaker',
    tag: '區塊',
    term: 'Breaker Block 破壞塊',
    zh: 'OB 失效後（價格收盤穿越），角色反轉：原本的支撐變壓力，反之亦然。',
    en: 'A failed order block that flips polarity after price closes through it.',
    how: '追蹤每個 OB，一旦收盤穿越即標記為 Breaker 並反轉方向（圖上為虛線框）。',
    trade: '常見於反轉結構中：掃流動性 → CHoCH → 回測 Breaker 進場。',
  },
  {
    id: 'fvg',
    tag: '區塊',
    term: 'FVG（Fair Value Gap）公允價值缺口',
    zh: '三根 K 棒之間留下的未成交區（第 1 根高點與第 3 根低點沒有重疊）。市場傾向回來填補。',
    en: 'A three-candle imbalance where candle 1 and candle 3 do not overlap.',
    how: '偵測 low[i] > high[i-2]（多方）或 high[i] < low[i-2]（空方），並以 ATR 過濾雜訊；持續追蹤填補百分比。',
    trade: 'CE（Consequent Encroachment，缺口 50%）是常用的精準進場價。',
  },
  {
    id: 'ifvg',
    tag: '區塊',
    term: 'IFVG（Inversion FVG）反轉缺口',
    zh: 'FVG 被完全穿越並收盤於另一側後，該區反而成為反向的支撐／壓力。',
    en: 'An FVG that has been closed through and now acts in the opposite direction.',
    how: '當價格收盤越過缺口另一側時狀態轉為 inverted，圖上以虛線顯示並反轉顏色。',
    trade: '是判斷「缺口失效 → 趨勢確立」的重要線索。',
  },
  {
    id: 'liquidity',
    tag: '流動性',
    term: 'Liquidity 流動性（BSL / SSL）',
    zh: '前高之上的買單停損＝買方流動性（BSL）；前低之下＝賣方流動性（SSL）。價格往往先去拿流動性，再走真正的方向。',
    en: 'Resting stop orders above highs (buy-side) and below lows (sell-side).',
    how: '把容差內的擺動點群聚成「流動性池」，記錄觸及次數、是否等高等低、是否已被掃除，並計算上下方吸引力。',
    trade: '把未被掃除的流動性當作「目標」而不是「壓力／支撐」。',
  },
  {
    id: 'sweep',
    tag: '流動性',
    term: 'Liquidity Sweep / Stop Hunt 掃流動性',
    zh: '影線穿越前高／前低但收盤收回，代表流動性被吃掉，常是反轉的起點。',
    en: 'A wick through a prior high/low that closes back inside — a stop hunt.',
    how: '逐一檢查擺動點，若後續 K 棒最高／最低穿越但收盤收回，即標記掃除並計算深度（ATR 倍數）。',
    trade: '「掃 + CHoCH + 回測 OB」是勝率最高的反轉三部曲。',
  },
  {
    id: 'idm',
    tag: '流動性',
    term: 'Inducement（IDM）誘導',
    zh: '進入真正 POI 之前的假回調，用來誘出散戶單、製造流動性。',
    en: 'A minor pullback engineered to trap traders before the real POI is reached.',
    how: '取最近一次結構事件推動腿中的最後一個次級反向擺動點，並追蹤是否已被取走。',
    trade: 'IDM 未被取走前，別急著在 OB 進場；IDM 被取走後才是高機率時機。',
  },
  {
    id: 'pd',
    tag: '定價',
    term: 'Premium / Discount 溢價與折價',
    zh: '把交易區間分成上下半部：上半＝溢價（適合賣），下半＝折價（適合買），50% 稱為均衡（EQ）。',
    en: 'Upper half of the dealing range is premium (sell), lower half is discount (buy).',
    how: '以最近一組已確認的擺動高／低構成交易區間，計算現價在區間中的百分位。',
    trade: '只在折價做多、溢價做空，可大幅改善進場品質與風報比。',
  },
  {
    id: 'ote',
    tag: '定價',
    term: 'OTE（Optimal Trade Entry）最佳進場區',
    zh: '回撤 0.618–0.79 的黃金區（0.705 為甜蜜點），兼顧勝率與風報比。',
    en: 'The 0.618–0.79 retracement band, with 0.705 as the sweet spot.',
    how: '依交易區間方向自動計算，並在圖上以紫色帶狀顯示。',
    trade: 'OTE 與 OB / FVG 重疊時，是所謂的「A+ 匯流」。',
  },
  {
    id: 'killzone',
    tag: '時間',
    term: 'Killzone 殺區（交易時段）',
    zh: 'ICT 定義的高波動時段：倫敦 07:00–10:00、紐約早盤 12:00–15:00、紐約午盤 17:30–20:00（UTC）。',
    en: 'High-probability windows: London 07:00–10:00, NY AM 12:00–15:00, NY PM 17:30–20:00 UTC.',
    how: '圖表以背景色標示各時段，並計算各時段高低點作為流動性目標。',
    trade: '加密貨幣 24 小時交易，但機構資金仍集中在這些時段，行情更乾淨。',
  },
  {
    id: 'keylevels',
    tag: '時間',
    term: 'PDH / PDL / PWH / PWL 關鍵時間價位',
    zh: '前日高低、前週高低、前月高低，是最明顯的流動性所在。',
    en: 'Previous day/week/month highs and lows — obvious liquidity pools.',
    how: '由現有 K 線重新彙整成日／週／月 K 後取值，自動畫在圖上。',
    trade: '常見劇本：掃 PDH → 回落；或突破 PDH 後回測成為支撐。',
  },
  {
    id: 'displacement',
    tag: '動能',
    term: 'Displacement 位移',
    zh: '大實體、強勢、留下缺口的 K 棒，代表機構強勢介入。',
    en: 'A large-bodied, gap-leaving candle showing institutional intent.',
    how: '以 K 棒實體 / ATR 衡量；OB 必須伴隨足夠位移才會被採用（預設 ≥ 1 ATR）。',
    trade: '沒有位移的突破多半是假突破。',
  },
  {
    id: 'mtf',
    tag: '流程',
    term: 'Top-Down Analysis 由上而下分析',
    zh: '高週期定敘事 → 中週期定結構與 POI → 低週期找進場確認。',
    en: 'HTF narrative → MTF structure & POI → LTF entry confirmation.',
    how: '多週期矩陣同時計算 4 個週期的偏向、結構、區間位置與計畫，並加權出總偏向與一致性。',
    trade: '一致性 < 50% 時建議降低部位或觀望。',
  },
];

export const PLAYBOOK = [
  {
    step: 1,
    zh: '定方向：看 4H/1D 的擺動結構與偏向分數，確認站在哪一邊。',
    en: 'Direction: read 4H/1D swing structure and bias score.',
  },
  {
    step: 2,
    zh: '找目標：標出未被掃除的流動性（BSL/SSL）與關鍵價位（PDH/PDL），那是價格要去的地方。',
    en: 'Draw: mark untapped liquidity and key levels — these are the magnets.',
  },
  {
    step: 3,
    zh: '等位置：價格必須位於正確的折價／溢價側，最好落在 OTE 或高分 POI。',
    en: 'Location: wait for price in the correct premium/discount half, ideally at OTE or a high-score POI.',
  },
  {
    step: 4,
    zh: '等訊號：先看到掃流動性，再看到低週期 CHoCH，最後回測 OB/FVG。',
    en: 'Trigger: sweep → LTF CHoCH → retest of OB/FVG.',
  },
  {
    step: 5,
    zh: '管風險：停損放結構失效點外，單筆風險 ≤ 1%，第一目標至少 2R。',
    en: 'Risk: stop beyond invalidation, ≤1% per trade, first target ≥ 2R.',
  },
  {
    step: 6,
    zh: '記錄與檢討：用回測頁驗證訊號品質，用日誌檢討執行品質。',
    en: 'Review: validate signal quality with the backtest tab; review execution in a journal.',
  },
];

export function renderGlossary(lang, filter = '') {
  const f = filter.trim().toLowerCase();
  const items = GLOSSARY.filter(
    (g) => !f || g.term.toLowerCase().includes(f) || g.zh.includes(filter) || g.en.toLowerCase().includes(f),
  );
  const cards = items.map((g) => `
    <details class="gloss">
      <summary><span class="gloss__tag">${g.tag}</span>${g.term}</summary>
      <p>${lang === 'zh' ? g.zh : g.en}</p>
      <p class="gloss__how"><b>${lang === 'zh' ? '本程式如何計算' : 'How this app computes it'}：</b>${g.how}</p>
      <p class="gloss__trade"><b>${lang === 'zh' ? '實戰用法' : 'How to trade it'}：</b>${g.trade}</p>
    </details>`).join('');
  const steps = PLAYBOOK.map((p) => `<li><b>${p.step}</b>${lang === 'zh' ? p.zh : p.en}</li>`).join('');
  return `
    <div class="playbook">
      <h3>${lang === 'zh' ? 'SMC 實戰流程（六步驟）' : 'The 6-step SMC workflow'}</h3>
      <ol>${steps}</ol>
    </div>
    <div class="gloss-list">${cards || `<p class="dim">${lang === 'zh' ? '找不到相符的詞彙。' : 'No matching term.'}</p>`}</div>`;
}
