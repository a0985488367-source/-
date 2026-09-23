import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = path.join(__dirname, '..', 'data', 'processed-signals.json');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天沒用到的紀錄清掉，檔案不會無限長大

/**
 * signal_id → 已經處理過的結果，寫進磁碟才能撐過重啟；用單一 JSON 檔
 * 而不是資料庫，這個服務的交易量很低（一天頂多幾十筆），不需要真的上
 * SQLite/Postgres 這種重量級方案，用檔案最容易看、最容易備份、也不用
 * 在 VPS 上多裝任何東西。
 *
 * 寫入用「先寫暫存檔、成功了再 rename 蓋過去」的方式，任何時間點程序
 * 被砍掉，正式檔案本身都不會壞掉、頂多丟失最後這一次還沒寫完的更新。
 */
export class IdempotencyStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.map = new Map();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const [id, entry] of Object.entries(obj)) {
        if (now - (entry.processedAt || 0) < MAX_AGE_MS) this.map.set(id, entry);
      }
      logger.info(`載入 ${this.map.size} 筆已處理過的 signal_id`);
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn('讀取 idempotency 紀錄失敗，當作空的重新開始', { error: e.message });
    }
  }

  persist() {
    const obj = Object.fromEntries(this.map.entries());
    const tmp = this.storePath + '.tmp';
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, this.storePath);
  }

  /** 已經處理過就回傳當初的結果，沒有就回傳 undefined */
  get(signalId) {
    return this.map.get(signalId)?.result;
  }

  has(signalId) {
    return this.map.has(signalId);
  }

  /** 記住這個 signal_id 的處理結果（不管成功或失敗都要記，避免失敗的訊號被無限重試成一堆重複單） */
  set(signalId, result) {
    this.map.set(signalId, { result, processedAt: Date.now() });
    this.persist();
  }
}

export const idempotencyStore = new IdempotencyStore();
