/**
 * 單檔打包器（零依賴）
 *
 * 把所有 ES Module、CSS 與 HTML 合併成一個 .html 檔，
 * 用 classic script（非 module）輸出 → 可以直接用 file:// 開啟，
 * 也就是「把一個檔案傳到手機就能跑」。
 *
 *   node scripts/build-single.mjs [輸出路徑]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';

const root = process.cwd();
const ENTRY = resolve(root, 'src/app.js');
const OUT = resolve(root, process.argv[2] || 'standalone/smc-terminal.html');

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"];?\s*$/gm;
const NAMESPACE_IMPORT_RE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
const EXPORT_NAME_RE = /^\s*export\s+(?:const|let|var|function|async function|class)\s+(\w+)/gm;

/** 取得模組對外公開的名稱（供 `import * as NS` 重建命名空間物件） */
function exportedNames(code) {
  const names = [];
  EXPORT_NAME_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_NAME_RE.exec(code))) names.push(m[1]);
  return names;
}

/** 依相依關係做深度優先拓撲排序，確保被依賴的模組先輸出 */
async function collect(file, seen = new Set(), order = []) {
  if (seen.has(file)) return order;
  seen.add(file);
  const code = await readFile(file, 'utf8');
  const deps = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (!spec.startsWith('.')) throw new Error(`不支援外部相依：${spec}（於 ${file}）`);
      deps.push(resolve(dirname(file), spec));
    }
  }
  for (const d of deps) await collect(d, seen, order);
  order.push({ file, code });
  return order;
}

/**
 * 移除 import / export 關鍵字：所有模組合併後共用同一個作用域。
 * `import * as NS from '...'` 會改寫成以該模組公開名稱組成的物件。
 */
function stripModuleSyntax(code, file, exportsByFile) {
  const namespaces = [];
  NAMESPACE_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = NAMESPACE_IMPORT_RE.exec(code))) {
    const target = resolve(dirname(file), m[2]);
    const names = exportsByFile.get(target) || [];
    if (!names.length) throw new Error(`命名空間匯入找不到公開名稱：${m[2]}`);
    namespaces.push(`const ${m[1]} = { ${names.join(', ')} };`);
  }
  const prefix = namespaces.length ? namespaces.join('\n') + '\n' : '';
  return prefix + code
    .replace(IMPORT_RE, '')
    .replace(SIDE_EFFECT_IMPORT_RE, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|async function|class))/gm, '')
    .replace(/new URL\('\.\.\/sw\.js', import\.meta\.url\)/g, "'sw.js'");
}

const modules = await collect(ENTRY);
const exportsByFile = new Map(modules.map(({ file, code }) => [file, exportedNames(code)]));
const bundleParts = modules.map(
  ({ file, code }) => `\n/* ===== ${relative(root, file)} ===== */\n${stripModuleSyntax(code, file, exportsByFile)}`,
);

const css = await readFile(resolve(root, 'assets/styles/main.css'), 'utf8');
let html = await readFile(resolve(root, 'index.html'), 'utf8');

// 圖示轉成 data URI，讓單檔完全自足
const appleIcon = await readFile(resolve(root, 'assets/icons/apple-touch-icon.png'));
const iconUri = `data:image/png;base64,${appleIcon.toString('base64')}`;

// 以函式作為取代值：避免程式碼中的 $$ / $& 被當成 replace 的特殊符號
const sub = (haystack, needle, value) => haystack.replace(needle, () => value);

html = sub(html, '<link rel="stylesheet" href="assets/styles/main.css" />', `<style>\n${css}\n</style>`);
html = sub(html, '<link rel="manifest" href="manifest.webmanifest" />', '');
html = sub(html, '<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png" />', `<link rel="apple-touch-icon" href="${iconUri}" />`);
html = sub(
  html,
  '<script type="module" src="src/app.js"></script>',
  `<script>\n(function () {\n'use strict';\n${bundleParts.join('\n')}\n})();\n</script>`,
);
html = sub(html, '<title>', '<!-- 單檔離線版：由 scripts/build-single.mjs 產生，請勿手動編輯 -->\n<title>');

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✓ 已輸出單檔版：${relative(root, OUT)}（${modules.length} 個模組，${kb} KB）`);
