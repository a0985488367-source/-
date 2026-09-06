import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDepth,
  checkPositionAgainstDepth,
  maxTolerablePositionUsd,
  parseBybitOrderbook,
} from '../app/orderbook-depth.ts';

const BOOK = parseBybitOrderbook({
  b: [['99.9', '50'], ['99.7', '80'], ['99.0', '500']],
  a: [['100.1', '40'], ['100.3', '70'], ['101.0', '900']],
});

test('解析 Bybit 盤口並依價格排序', () => {
  assert.equal(BOOK.bids[0].price, 99.9, '買盤由高到低');
  assert.equal(BOOK.asks[0].price, 100.1, '賣盤由低到高');
});

test('過濾掉無效的價量列', () => {
  const book = parseBybitOrderbook({ b: [['abc', '1'], ['100', '0'], ['99', '5']], a: [] });
  assert.equal(book.bids.length, 1);
  assert.equal(book.bids[0].price, 99);
});

test('中價與價差計算', () => {
  const d = assessDepth(BOOK, 0.3);
  assert.equal(d.mid, 100);
  assert.ok(Math.abs(d.spreadPct - 0.2) < 1e-9);
});

test('只計入帶內的檔位', () => {
  const d = assessDepth(BOOK, 0.3);
  // 帶寬 99.7 ~ 100.3，99.0 與 101.0 應被排除
  assert.equal(d.bidUsd, 99.9 * 50 + 99.7 * 80);
  assert.equal(d.askUsd, 100.1 * 40 + 100.3 * 70);
  assert.equal(d.thinnerSideUsd, d.askUsd, '較薄一側為賣方');
});

test('盤口缺一側時回傳零深度', () => {
  const d = assessDepth(parseBybitOrderbook({ b: [['100', '10']], a: [] }));
  assert.equal(d.mid, null);
  assert.equal(d.thinnerSideUsd, 0);
});

test('可承受倉位為較薄一側的參與比例', () => {
  assert.equal(maxTolerablePositionUsd(10_000, 10), 1000);
  assert.equal(maxTolerablePositionUsd(10_000, 5), 500);
  assert.equal(maxTolerablePositionUsd(0), 0);
  assert.equal(maxTolerablePositionUsd(Number.NaN), 0);
});

test('深度不明時一律判定為過薄，不放行', () => {
  const d = assessDepth(parseBybitOrderbook({ b: [], a: [] }));
  const check = checkPositionAgainstDepth(100, d);
  assert.equal(check.verdict, 'too-thin');
  assert.equal(check.maxPositionUsd, 0);
});

test('計畫倉位超過帶內深度時擋下並說明數字', () => {
  const d = assessDepth(BOOK, 0.3);
  const check = checkPositionAgainstDepth(5000, d);
  assert.equal(check.verdict, 'too-thin');
  assert.match(check.message, /5000/);
  assert.match(check.message, /超過/);
});

test('倉位佔比偏高時給出 tight 警示', () => {
  const d = assessDepth(BOOK, 0.3);
  const max = maxTolerablePositionUsd(d.thinnerSideUsd);
  assert.equal(checkPositionAgainstDepth(max * 0.8, d).verdict, 'tight');
  assert.equal(checkPositionAgainstDepth(max * 0.3, d).verdict, 'ok');
});

test('薄盤口的可承受倉位遠小於 10 萬 OI 門檻給人的印象', () => {
  const thin = parseBybitOrderbook({ b: [['1.0', '2000']], a: [['1.002', '1500']] });
  const d = assessDepth(thin, 0.3);
  const check = checkPositionAgainstDepth(500, d);
  assert.ok(check.maxPositionUsd < 500, `可承受僅 ${check.maxPositionUsd} USDT`);
  assert.equal(check.verdict, 'too-thin');
});

test('價格剛好落在帶緣的檔位必須被計入（浮點邊界）', () => {
  // mid = 100，0.3% 帶寬的上緣正好是 100.3，
  // 而 100 * 1.003 在二進位下是 100.29999...，沒有容差就會漏掉這一檔。
  const book = parseBybitOrderbook({ b: [['99.7', '10']], a: [['100.3', '10']] });
  const d = assessDepth(book, 0.3);
  assert.equal(d.mid, 100);
  assert.ok(d.askUsd > 0, '上緣檔位不得被漏算');
  assert.ok(d.bidUsd > 0, '下緣檔位不得被漏算');
});
