/**
 * 產生器共用：把 ES 模組原始碼內嵌進單一作用域。
 *
 * 去掉 export 關鍵字與 import 敘述，讓多個模組可以直接串接在
 * 同一個 script 作用域裡執行（瀏覽器的 module script、或 Scriptable）。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inlineModule(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8')
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .trimEnd();
}

export function readText(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8').trimEnd();
}

export function engineVersion(source) {
  return /ENGINE_VERSION = '([^']+)'/.exec(source)?.[1] ?? 'unknown';
}
