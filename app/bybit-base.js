/**
 * Bybit API 基底位址。
 * 獨立成一個模組，讓公開行情與唯讀私有端點共用同一個常數，
 * 避免內嵌成單一作用域時重複宣告。
 */
export const BYBIT_BASE = 'https://api.bybit.com';
