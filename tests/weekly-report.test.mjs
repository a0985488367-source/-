import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyReport, matchesLiveRules, netR, RULES_SINCE } from '../scripts/lib/weekly-report.mjs';

const NOW = RULES_SINCE + 30 * 24 * 3600 * 1000;
const trade = (over = {}) => ({
  dir: 'long', poiType: 'FVG', score: 70, entry: 100, initialStop: 98, r: 1,
  filledTime: NOW - 2 * 86400000, closedTime: NOW - 86400000, ...over,
});
const status = { wallet: { totalWalletBalance: 1100 }, trackedOpenPositions: 2, openRiskPct: 3.5, maxOpenRiskPct: 6 };
const field = (embed, name) => embed.fields.find((f) => f.name.startsWith(name));

test('只算符合目前下單規則的訊號：做空、Order Block、低分、停損太近都排除', () => {
  assert.ok(matchesLiveRules(trade()));
  assert.ok(!matchesLiveRules(trade({ dir: 'short' })));
  assert.ok(!matchesLiveRules(trade({ poiType: 'Order Block' })));
  assert.ok(!matchesLiveRules(trade({ score: 60 })));
  assert.ok(!matchesLiveRules(trade({ initialStop: 99.5 })));
});

test('扣手續費：停損 2% 時一進一出 0.11% 約吃掉 0.055R', () => {
  assert.ok(Math.abs(netR(trade({ r: 1 })) - (1 - 0.055)) < 1e-9);
});

test('淨值跟上週、跟第一週比，並回傳這週要存的快照', () => {
  const history = [{ time: NOW - 14 * 86400000, balance: 1000 }, { time: NOW - 7 * 86400000, balance: 1050 }];
  const { embed, snapshot } = buildWeeklyReport({ status, closed: [], history, now: NOW });
  assert.deepEqual(snapshot, { time: NOW, balance: 1100 });
  const v = field(embed, 'Demo 帳戶淨值').value;
  assert.match(v, /1100\.00 USDT/);
  assert.match(v, /比上週：\+4\.76%/);
  assert.match(v, /起：\+10\.00%/);
  assert.match(field(embed, '目前持倉').value, /風險佔用 3\.5%（上限 6%）/);
});

test('讀不到 Worker 狀態：照樣推報告，但不存快照', () => {
  const { embed, snapshot } = buildWeeklyReport({ status: null, closed: [trade()], history: [], now: NOW });
  assert.equal(snapshot, null);
  assert.match(field(embed, 'Demo 帳戶淨值').value, /讀不到/);
});

test('新規則上線前的紀錄不算進門檻進度', () => {
  const old = trade({ closedTime: RULES_SINCE - 1000, filledTime: RULES_SINCE - 5000 });
  const { embed } = buildWeeklyReport({ status, closed: [old, trade()], history: [], now: NOW });
  assert.match(field(embed, '新規則上線以來').value, /^1 筆/);
});

test('四個上真錢門檻全部達到才顯示可以考慮上真錢', () => {
  const closed = Array.from({ length: 200 }, (_, i) => trade({ r: i % 3 === 0 ? -1 : 1, closedTime: NOW - 86400000 - i }));
  const history = [0, 1, 2].map((w) => ({ time: NOW - (3 - w) * 7 * 86400000, balance: 1000 }));
  const { embed } = buildWeeklyReport({ status, closed, history, now: NOW });
  assert.match(field(embed, '上真錢門檻').name, /4\/4/);
  assert.match(embed.description, /可以考慮小額上真錢/);

  const { embed: early } = buildWeeklyReport({ status, closed: closed.slice(0, 50), history, now: NOW });
  assert.match(field(early, '上真錢門檻').value, /⬜ 交易筆數 50 \/ 200/);
  assert.match(early.description, /維持 Demo/);
});
