/**
 * 單檔打包器（零依賴）
 *
 * 把所有 ES Module、CSS 與 HTML 合併成一個 .html 檔，
 * 用 classic script（非 module）輸出 → 可以直接用 file:// 開啟，
 * 也就是「把一個檔案傳到手機就能跑」。
 *
 *   node scripts/build-single.mjs [輸出路徑] [--artifact]
 *
 * --artifact：輸出 Claude Artifact 版（去掉 html/head/body 外框、強制離線示範資料），
 *             因為 Artifact 的安全政策不允許頁面連線交易所 API。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';

const root = process.cwd();
const ENTRY = resolve(root, 'src/app.js');
const args = process.argv.slice(2);
const ARTIFACT = args.includes('--artifact');
const OUT = resolve(root, args.find((a) => !a.startsWith('--')) || 'standalone/smc-terminal.html');

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

if (ARTIFACT) {
  // Artifact 由平台包上 <!doctype>/<head>/<body>，這裡只輸出內容本身
  // Artifact 的標題就是它在資料庫中的名字，取乾淨的產品名即可
  const title = 'SMC 加密貨幣分析終端';
  const style = /<style>[\s\S]*?<\/style>/.exec(html)?.[0] ?? '';
  let body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
  // 預覽版不顯示「加入主畫面」提示（會加到包裹頁而不是這個 App）
  body = body.replace(/<div id="installHint"[\s\S]*?<\/div>\s*(?=<script)/, '');

  const forceDemo = `<script>
// Artifact 的安全政策封鎖跨來源請求，交易所 API 無法連線 → 直接使用內建示範資料
try {
  const KEY = 'smc-terminal:v1';
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  saved.provider = 'demo';
  saved.live = false;
  localStorage.setItem(KEY, JSON.stringify(saved));
} catch (e) {}
</script>`;

  // Artifact 檢視器不允許頁面提供檔案下載，隱藏那兩個按鈕以免按了沒反應
  const hideDownloads = '<style>#snapBtn, #exportBtn { display: none !important; }</style>';

  const note = `<div id="previewNote" style="position:fixed;left:10px;right:10px;bottom:10px;z-index:200;display:flex;gap:10px;align-items:center;background:#111722;border:1px solid #3aa0ff;border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.5;color:#d5deeb;box-shadow:0 8px 28px rgba(0,0,0,.45)">
  <span><b style="color:#3aa0ff">預覽版</b>：此頁面無法連線交易所，顯示的是內建的<b>模擬行情</b>；所有功能與正式版相同。要接真實行情請用 GitHub Pages 部署。</span>
  <button onclick="this.parentElement.remove()" style="margin-left:auto;flex-shrink:0;background:#161d2b;border:1px solid #1e2635;color:inherit;border-radius:5px;width:30px;height:30px;cursor:pointer">✕</button>
</div>`;

  html = `<title>${title}</title>\n${style}\n${hideDownloads}\n${body.replace('<script>', `${note}\n${forceDemo}\n<script>`)}`;
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✓ 已輸出${ARTIFACT ? ' Artifact 預覽版' : '單檔版'}：${relative(root, OUT)}（${modules.length} 個模組，${kb} KB）`);
