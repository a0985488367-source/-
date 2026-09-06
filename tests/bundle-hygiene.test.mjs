import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEB = readFileSync(new URL('../public/crypto-radar-guardian.html', import.meta.url).pathname, 'utf8');
const IOS = readFileSync(new URL('../public/crypto-radar-guardian.scriptable.js', import.meta.url).pathname, 'utf8');

/**
 * 抓出頂層宣告。模組被串接成單一作用域後，同名宣告會直接讓整份腳本無法執行，
 * 而且只有在真的跑起來才會發現。這道測試把它擋在建置階段。
 */
function topLevelDeclarations(source) {
  const names = [];
  const re = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

function duplicates(names) {
  const seen = new Set();
  const dupes = new Set();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
}

test('iPhone 版沒有重複的頂層宣告', () => {
  assert.deepEqual(duplicates(topLevelDeclarations(IOS)), []);
});

test('瀏覽器版沒有重複的頂層宣告', () => {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(WEB)[1];
  assert.deepEqual(duplicates(topLevelDeclarations(script)), []);
});

test('瀏覽器版不含任何簽章或私有端點邏輯', () => {
  // 憑證放進瀏覽器儲存空間並不安全，這個版本刻意只做公開行情
  // 檢查實際的程式呼叫，而不是說明文字裡提到的名詞
  for (const pattern of [/hmacSha256\(/, /X-BAPI/, /Keychain\.(get|set|contains)/, /signGetRequest\(/]) {
    assert.doesNotMatch(WEB, pattern, `瀏覽器版不得包含 ${pattern}`);
  }
  const paths = [...WEB.matchAll(/'(\/v5\/[^']+)'/g)].map((m) => m[1]);
  for (const p of paths) assert.match(p, /^\/v5\/market\//, `${p} 不是公開端點`);
});

test('內嵌樣式沒有語法錯誤的簡寫屬性', () => {
  // margin-top 只接受一個值；寫成四個值整條宣告會被瀏覽器丟掉
  for (const [name, src] of [['瀏覽器版', WEB], ['iPhone 版', IOS]]) {
    // 冒號後出現兩個以上的值才算錯誤
    const singleValueProps = /(?:margin|padding)-(?:top|right|bottom|left)\s*:\s*[^;"'}\s]+\s+[^;"'}\s]+/g;
    const bad = [...src.matchAll(singleValueProps)]
      .map((m) => m[0])
      .filter((decl) => !/var\(|calc\(|env\(|!important/.test(decl));
    assert.deepEqual(bad, [], `${name} 有無效的簡寫宣告`);
  }
});

test('多行診斷訊息會轉成 HTML 換行', () => {
  for (const [name, src] of [['瀏覽器版', WEB], ['iPhone 版', IOS]]) {
    assert.match(src, /escMultiline/, `${name} 應有多行逸出函式`);
  }
  // 逸出必須先做，再換 <br>，否則會被自己逸出掉
  const fn = /escMultiline = \(s\) => esc\(s\)\.replace\(\/\\r\?\\n\/g, '<br>'\)/;
  assert.match(IOS, fn, '順序必須是先逸出再轉換行');
});
