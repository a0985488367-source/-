import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignalId, isManualExit } from '../scripts/demo-rcheck.mjs';

test('parseSignalId：從 signal_id 拿週期跟訊號 K 棒開盤時間', () => {
  assert.deepEqual(parseSignalId('st:KSM:s:4h:ao5c'), { interval: '4h', barOpen: parseInt('ao5c', 36) * 3_600_000 });
  assert.equal(parseSignalId('cc:WLD:1h:S:1792314000'), null);
  assert.equal(parseSignalId(''), null);
});

test('isManualExit：只有市價＋時間（沒有停損／止盈類型、沒有編號）才算手動平', () => {
  assert.equal(isManualExit('Market/13:59:10'), true);
  assert.equal(isManualExit('StopLoss/Market/20:32:15'), false);
  assert.equal(isManualExit('Limit/bo:ZIL:s:6h:ao50:leg:0/10:00:00'), false);
  assert.equal(isManualExit('TrailingStop/Market/01:00:00'), false);
});
