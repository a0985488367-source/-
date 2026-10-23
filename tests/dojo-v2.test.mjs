import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setFetcher, makeRng } from '../dojo/js/core.js';
import { makeQuestion, ALL_IDS } from '../dojo/js/gen.js';
import { CONCEPTS, CHAPTERS } from '../dojo/js/concepts.js';
import { freshSave, review, rollDay, recordAnswer, markPracticed, ink, dueCards, unlock, openChest, track, INTERVALS, DAY } from '../dojo/js/srs.js';

setFetcher(async (url) => JSON.parse(fs.readFileSync(new URL(`../dojo/${url}`, import.meta.url))));

test('道場出題：每個概念都出得來，選擇題剛好一個正確答案，點圖題正確位置判對、遠處判錯', async () => {
  const rng = makeRng(7);
  for (const id of ALL_IDS) {
    for (const diff of [1, 3, 5]) {
      for (let k = 0; k < 3; k++) {
        const q = await makeQuestion(id, { rng, diff, explainRate: 0 });
        assert.ok(q.prompt, `${id} 沒有題目`);
        if (q.kind === 'choice') assert.equal(q.options.filter((o) => o.ok).length, 1, `${id}：${q.prompt}`);
        else {
          assert.ok(q.answer, `${id} 點圖題要有答案`);
          assert.ok(q.pick.test(q.answer.i, q.answer.p), `${id} 正確位置要判對`);
          const W = q.chart.W, far = q.answer.p * (q.pick.mode === 'price' ? 1.5 : 1);
          const fi = q.pick.mode === 'price' ? q.answer.i : (q.answer.i > q.chart.from + 30 ? q.chart.from : q.chart.to);
          assert.equal(q.pick.test(fi, q.pick.mode === 'price' ? far : W[fi].c * 3), false, `${id} 很遠的位置要判錯`);
        }
        if (q.chart) {
          // 圖上只畫得到決策那根為止（不偷看未來）
          assert.equal(q.chart.to, q.chart.W.length - 1);
          for (const o of [...q.chart.ov, ...q.chart.reveal]) for (const key of ['i', 'i1', 'i2']) if (o[key] != null) assert.ok(o[key] <= q.chart.to, `${id} 標記超出圖`);
        }
      }
    }
  }
});

test('說法題：每張卡都有，而且第一個選項是正確的', async () => {
  const rng = makeRng(3);
  for (const c of CONCEPTS) {
    assert.ok(c.explain.length >= 1, c.id);
    for (const it of c.explain) assert.equal(it.opts.length, 4, `${c.id}：${it.q}`);
    const q = await makeQuestion(c.id, { rng, explainRate: 1 });
    assert.equal(q.options.filter((o) => o.ok).length, 1);
  }
  assert.deepEqual(CHAPTERS.flatMap((x) => x.cards).sort(), CONCEPTS.map((c) => c.id).sort(), '每張卡都屬於某一章');
});

test('間隔重考：答對往後排、答錯掉回第 1 格隔天再考；到期沒複習墨會變淡', () => {
  const s = freshSave(), t0 = Date.UTC(2026, 9, 1, 4);
  unlock(s, 'fvg', t0);
  assert.equal(s.cards.fvg.box, 1);
  assert.deepEqual(dueCards(s, t0), []);
  let t = t0 + DAY;
  assert.deepEqual(dueCards(s, t), ['fvg']);
  review(s, 'fvg', true, t);
  assert.equal(s.cards.fvg.box, 2);
  assert.equal(s.cards.fvg.due, t + INTERVALS[2] * DAY);
  review(s, 'fvg', true, t + 1000); // 還沒到期再答對：不升級
  assert.equal(s.cards.fvg.box, 2);
  t = s.cards.fvg.due;
  review(s, 'fvg', true, t);
  assert.equal(s.cards.fvg.box, 3);
  const r = review(s, 'fvg', false, t + 10);
  assert.ok(r.lapse);
  assert.equal(s.cards.fvg.box, 1);
  assert.equal(ink(s.cards.fvg, s.cards.fvg.due - 1), 1);
  assert.ok(ink(s.cards.fvg, s.cards.fvg.due + 3 * DAY) < 0.5);
  assert.ok(ink(s.cards.fvg, s.cards.fvg.due + 300 * DAY) >= 0.2);
});

test('每日任務、連續天數、免斷符、每日寶箱', () => {
  const s = freshSave();
  const d1 = Date.UTC(2026, 9, 1, 4); // 台灣 12 點
  rollDay(s, d1);
  assert.equal(s.day.missions.length, 3);
  const q = { concept: 'swing', kind: 'choice', diff: 2 };
  let up = false;
  for (let i = 0; i < 10; i++) up = recordAnswer(s, q, true, { now: d1 }).streakUp || up;
  assert.ok(up);
  assert.equal(s.streak.count, 1);
  // 隔天練：+1
  const d2 = d1 + DAY; rollDay(s, d2); markPracticed(s, d2);
  assert.equal(s.streak.count, 2);
  // 斷一天：用掉免斷符
  const d4 = d2 + 2 * DAY; rollDay(s, d4);
  assert.equal(s.streak.freeze, 0);
  markPracticed(s, d4);
  assert.equal(s.streak.count, 3);
  // 再斷兩天：歸零
  const d7 = d4 + 3 * DAY; rollDay(s, d7);
  assert.equal(s.streak.count, 0);
  markPracticed(s, d7);
  assert.equal(s.streak.count, 1);
  // 任務全完成才開得了寶箱
  assert.equal(openChest(s, makeRng(1), d7), null);
  for (const m of s.day.missions) { m.prog = m.goal; m.done = true; }
  const c = openChest(s, makeRng(1), d7);
  assert.ok(c && c.card);
  assert.ok(s.cards[c.card].unlocked);
  assert.equal(openChest(s, makeRng(1), d7), null, '一天只能開一次');
  assert.deepEqual(track(s, 'answer', 1, d7), []);
});
