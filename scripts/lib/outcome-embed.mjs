/**
 * 模擬單「狀態變化」→ Discord embed 的純函式版本。
 *
 * 抽成獨立模組是因為這裡曾經崩潰過整支推播腳本：
 * tracker.mjs 在打到第一個目標時會多推一個 'breakeven' 事件（移動停損到成本價），
 * 但這個事件發生時交易「還沒結束」——trade.r 這個欄位根本還不存在。
 * 舊版程式碼沒有針對 'breakeven'（或任何未知事件類型）明確處理，
 * 全部落到「已結束」的預設分支去讀 trade.r.toFixed()，因而丟出例外，
 * 讓當次執行後面所有「新交易計畫」的推播都沒有送出。
 *
 * 修法有兩層：
 *   1) 這裡把每種事件都明確列出，'breakeven' 與任何未知類型一律回傳 null（不推播）
 *   2) 呼叫端（discord-notify.mjs）用 try/catch 隔離每一則訊息，
 *      就算未來又冒出新的例外，也只會漏一則通知，不會拖垮整批
 */

export const COLORS = { bull: 0x26a69a, bear: 0xef5350, info: 0x3aa0ff, warn: 0xe2b13c };

const fmt = (v, d = 2) =>
  v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** 依價格量級決定小數位 */
export function digitsFor(p) {
  const a = Math.abs(p);
  if (a >= 10000) return 1;
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 7;
}

export const price = (v) => fmt(v, digitsFor(v));

/** 安全的 R 值格式化：非有限數字時顯示 '—'，絕不因缺欄位而讓整批推播崩潰 */
export function fmtR(v, { sign = true } = {}) {
  if (!Number.isFinite(v)) return '—';
  return `${sign && v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

/**
 * @param {object} trade 模擬單（來自 tracker.mjs 的 advanceTrade 結果）
 * @param {object} event 這次要處理的單一事件
 * @param {object} stats computeStats() 的輸出，用於頁尾累計戰績
 * @param {object} cfg 需要 cfg.siteUrl、cfg.tracking.entryWindowBars
 * @returns {object|null} Discord embed，或 null（代表這個事件不需要獨立推播）
 */
export function buildOutcomeEmbed(trade, event, stats, cfg) {
  const base = trade.symbol.replace(/USDT$/, '');
  const dirText = trade.dir === 'long' ? '做多' : '做空';
  const statLine = stats.count
    ? `累計 ${stats.count} 筆 · 勝率 ${stats.winRate.toFixed(0)}% · 期望值 ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}R · 總計 ${stats.totalR >= 0 ? '+' : ''}${stats.totalR.toFixed(1)}R`
    : '尚無已結束的交易';
  const common = {
    url: cfg.siteUrl || undefined,
    footer: { text: statLine },
    timestamp: new Date(event.time).toISOString(),
  };
  const held = trade.filledTime && event.time
    ? `持有 ${Math.round((event.time - trade.filledTime) / 3600000 * 10) / 10} 小時`
    : '';

  if (event.type === 'filled') {
    return {
      ...common,
      title: `⏳ ${base} ${dirText} · 已進場`,
      color: COLORS.info,
      description: `價格回到 **${price(trade.entry)}**，模擬單成交。\n停損 ${price(trade.stop)}｜第一目標 ${price(trade.targets[0]?.price)}`,
    };
  }
  if (event.type === 'target') {
    const final = trade.status === 'target';
    return {
      ...common,
      title: `${final ? '🎉' : '✅'} ${base} ${dirText} · ${event.name} 達成 ${fmtR(event.rr, { sign: false })}`,
      color: COLORS.bull,
      description: final
        ? `**全部目標達成**，模擬單以 ${price(event.price)} 結算。${held}`
        : `價格觸及 ${price(event.price)}。停損已移到成本價 ${price(trade.entry)}，這筆單之後最差是平手。`,
    };
  }
  if (event.type === 'breakeven') {
    // 'target' 事件的說明已經提到「停損移到成本價」，這裡不需要重複推播。
    // 而且此時交易還沒結束，trade.r 尚未存在 —— 這正是原本崩潰的地方。
    return null;
  }
  if (event.type === 'stop') {
    const saved = trade.hitTargets.length > 0;
    return {
      ...common,
      title: `${saved ? '🟡' : '❌'} ${base} ${dirText} · ${saved ? '回到成本價出場' : '停損'} ${fmtR(trade.r)}`,
      color: saved ? COLORS.warn : COLORS.bear,
      description: saved
        ? `已達成 ${trade.hitTargets.join('、')} 後回落，於成本價出場。${held}`
        : `價格觸及停損 ${price(trade.stop)}。${held}\n最大有利幅度曾達 ${fmtR(trade.maxFavorableR, { sign: false })}。`,
    };
  }
  if (event.type === 'expired') {
    return {
      ...common,
      title: `⌛ ${base} ${dirText} · ${!trade.filledTime ? '未進場作廢' : '逾時出場'}`,
      color: COLORS.info,
      description: trade.filledTime
        ? `持有超過上限，以 ${price(trade.exitPrice)} 結算 ${fmtR(trade.r)}。`
        : `等了 ${cfg.tracking.entryWindowBars} 根 K 棒價格都沒回到進場區，這則訊號作廢（不計入勝率）。`,
    };
  }
  // 未知的事件類型：不要用「已結束」的訊息模板去讀還不存在的欄位，安靜略過即可。
  return null;
}
