import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTML_PATH = new URL('../public/crypto-radar-guardian.html', import.meta.url).pathname;
const html = readFileSync(HTML_PATH, 'utf8');

function extractModuleScript(source) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(source);
  assert.ok(m, '找不到 module script 區塊');
  return m[1];
}

test('產出檔存在且為完整 HTML 文件', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /<\/html>\s*$/);
});

test('內嵌的 JavaScript 語法正確', () => {
  const script = extractModuleScript(html);
  const dir = mkdtempSync(join(tmpdir(), 'crg-'));
  const file = join(dir, 'inlined.mjs');
  writeFileSync(file, script, 'utf8');
  // node --check 會做完整解析；語法錯誤會以非零結束碼丟出
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});

test('內嵌時已去除 export 關鍵字，不會在單一作用域炸掉', () => {
  const script = extractModuleScript(html);
  assert.doesNotMatch(script, /^export\s/m, '內嵌後不應殘留 export 宣告');
  assert.match(script, /function buildCandidate\(/, '引擎函式必須被內嵌');
  assert.match(script, /function evaluateEntryGates\(/);
});

test('手機視窗與 iPhone 安全區設定齊全', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /-webkit-text-size-adjust/);
});

test('沿用既有深色賽博配色，主面板為 #081321', () => {
  assert.match(html, /--panel:\s*#081321/);
  assert.match(html, /color-scheme:\s*dark/);
  // 不得出現白色卡片底
  assert.doesNotMatch(html, /background:\s*#fff(f{3})?\b/i);
  assert.doesNotMatch(html, /background:\s*white\b/i);
});

test('資料來源標示為 Bybit，且沒有任何 DEX 來源', () => {
  assert.match(html, /Bybit \/v5\/market/);
  assert.match(html, /api\.bybit\.com/);
  assert.doesNotMatch(html, /dexscreener|dextools|birdeye|pump\.fun/i);
});

test('只呼叫 Bybit 公開行情端點', () => {
  const script = extractModuleScript(html);
  const paths = [...script.matchAll(/bybit\('(\/v5\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 5, `應呼叫多個端點，實際 ${paths.length}`);
  for (const p of paths) {
    assert.match(p, /^\/v5\/market\//, `${p} 不是公開行情端點`);
  }
  // 私有端點一律不得出現
  for (const forbidden of ['/v5/order', '/v5/position', '/v5/account', '/v5/asset', '/v5/user']) {
    assert.ok(!script.includes(forbidden), `不得呼叫私有端點 ${forbidden}`);
  }
});

test('不含任何金鑰、簽章或憑證邏輯', () => {
  for (const pattern of [/api[-_]?key/i, /hmac/i, /createSignature/i, /X-BAPI/i, /apiSecret/i]) {
    assert.doesNotMatch(html, pattern, `不得包含 ${pattern}`);
  }
});

test('沒有任何下單路徑', () => {
  const script = extractModuleScript(html);
  for (const forbidden of ['placeOrder', 'create-order', 'submitOrder', 'autoTrade(']) {
    assert.ok(!script.includes(forbidden), `不得包含 ${forbidden}`);
  }
  assert.match(script, /autoTradeEligible: false/, '候選必須固定為不可自動下單');
});

test('畫面明確聲明不下單、不連接帳戶', () => {
  assert.match(html, /不自動下單/);
  assert.match(html, /不連接任何帳戶/);
  assert.match(html, /永遠不會下單/);
});

test('分數說明清楚表示不是勝率', () => {
  assert.match(html, /不是勝率/);
});

test('不承諾獲利、勝率或不斷線', () => {
  for (const pattern of [/保證獲利/, /穩賺/, /勝率\s*\d/, /百倍報酬/, /365\s*天.*不斷線/]) {
    assert.doesNotMatch(html, pattern, `不得出現 ${pattern}`);
  }
  assert.match(html, /可能損失全部本金/, '必須有風險揭露');
});

test('產生器是唯一真實來源：重新執行會得到相同輸出', () => {
  const before = readFileSync(HTML_PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-standalone-app.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  const after = readFileSync(HTML_PATH, 'utf8');
  assert.equal(after, before, '產生器輸出必須是決定性的');
});
