/**
 * 「問 AI」的對話紀錄（2026-10-09 使用者要的：關掉網頁再開，聊天紀錄不要消失）。
 * 每個幣各存一段對話在瀏覽器的 IndexedDB（AI 回覆含搜尋結果，可能很大，localStorage 放不下）。
 * 這裡是純函式（網頁跟測試共用）；真正讀寫 IndexedDB 的在 coin/app.js。
 *
 * 存的格式：{ symbol, messages, view, updated, lastFullAt }
 *   messages   送給 API 的整段對話（原封不動，追問時整段送回）
 *   view       畫面上的泡泡 [{ k: 'user'|'ai', text, meta? }]
 *   lastFullAt 上一次附「完整快照」（各週期細節）的時間
 */

export const CHAT_KEEP_DAYS = 14;
export const CHAT_KEEP_COUNT = 12;
/** 上次附完整快照超過這麼久，追問時再附一次完整的（避免 AI 拿幾小時前的各週期細節回答） */
export const FULL_SNAPSHOT_EVERY_MS = 30 * 60_000;

/** 這次提問要不要附完整快照：新對話、或上次完整快照太舊 */
export function needFullSnapshot(chat, now = Date.now()) {
  if (!chat?.messages?.length) return true;
  return !(chat.lastFullAt > 0) || now - chat.lastFullAt > FULL_SNAPSHOT_EVERY_MS;
}

/** 從瀏覽器讀出來的紀錄是不是能用（格式壞掉就當沒有） */
export function validChat(chat) {
  return !!chat && typeof chat.symbol === 'string' && Array.isArray(chat.messages) && Array.isArray(chat.view)
    && chat.view.every((v) => v && (v.k === 'user' || v.k === 'ai') && typeof v.text === 'string');
}

/**
 * 要刪掉哪些幣的紀錄：超過 keepDays 沒動的、以及超過 keepCount 個時最舊的
 * @param {Array<{ symbol: string, updated: number }>} chats
 * @returns {string[]} 要刪的 symbol
 */
export function chatsToPrune(chats, now = Date.now(), { keepDays = CHAT_KEEP_DAYS, keepCount = CHAT_KEEP_COUNT } = {}) {
  const sorted = chats.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return sorted.filter((c, i) => i >= keepCount || !(c.updated > 0) || now - c.updated > keepDays * 864e5).map((c) => c.symbol);
}

/** 多久以前（給「接續 x 小時前的對話」用） */
export function agoZh(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}
