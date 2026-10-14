/**
 * SMC 教練 App（coach/）的基本檢查：離線快取清單裡的檔案都存在、app.js 用到的規則函式真的有匯出。
 * App 直接 import src/smc/coach.js 和 src/smc/sessions.js（GitHub Pages 部署整個倉庫），
 * 所以規則只有一份，跟 Discord 教練提醒一定一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as coach from '../src/smc/coach.js';
import * as sessions from '../src/smc/sessions.js';

const ROOT = new URL('../coach/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, ROOT), 'utf8');

test('coach App：Service Worker 快取清單的檔案都存在', () => {
  const sw = read('sw.js');
  const core = JSON.parse(sw.match(/const CORE = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const f of core) {
    if (f === './') continue;
    assert.ok(fs.existsSync(new URL(f, ROOT)), `缺少 ${f}`);
  }
});

test('coach App：import 的規則函式都存在', () => {
  const app = read('app.js');
  const mods = { '../src/smc/coach.js': coach, '../src/smc/sessions.js': sessions };
  const imports = [...app.matchAll(/import \{([^}]+)\} from '([^']+)'/g)];
  assert.ok(imports.length >= 2);
  for (const [, names, from] of imports) {
    assert.ok(mods[from], `沒預期的 import：${from}`);
    for (const n of names.split(',').map((x) => x.trim())) assert.equal(typeof mods[from][n], 'function', `${from} 沒有匯出 ${n}`);
  }
  assert.match(read('index.html'), /<script type="module" src="app.js">/);
  const mf = JSON.parse(read('manifest.webmanifest'));
  assert.equal(mf.start_url, './');
});
