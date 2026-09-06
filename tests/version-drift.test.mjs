import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_AFTER_CONSECUTIVE_MISSES,
  BANNER_THEME,
  EXPECTED_GUARDIAN_MAJOR,
  UPDATE_ACTION_LABEL,
  assessDeployment,
  checkWatchdogAlive,
  evaluateWatchdog,
  initialWatchdogState,
  minutesSince,
  parseGuardianMajor,
} from '../app/version-drift.ts';

const NOW = new Date('2026-09-06T00:00:00.000Z');

const HEALTHY_V10 = Object.freeze({
  versionLabel: 'Crypto Radar Guardian 10.0',
  healthy: true,
  heartbeatAt: '2026-09-05T23:57:00.000Z',
  tradeMode: 'demo',
  moonshotProvider: 'Bybit Pre-Breakout',
  cronScheduleMinutes: 5,
});

test('版本字串解析', () => {
  assert.equal(parseGuardianMajor('Crypto Radar Guardian 9.0'), 9);
  assert.equal(parseGuardianMajor('Crypto Radar Guardian 10.0'), 10);
  assert.equal(parseGuardianMajor('Crypto Radar Guardian 10'), 10);
  assert.equal(parseGuardianMajor(null), null);
  assert.equal(parseGuardianMajor('no version here'), null);
});

test('交接時的實際狀態：Worker 仍是 9.0 時判定為版本漂移', () => {
  const a = assessDeployment({
    now: NOW,
    expectedTradeMode: 'demo',
    status: { ...HEALTHY_V10, versionLabel: 'Crypto Radar Guardian 9.0' },
  });
  assert.equal(a.versionState, 'drift');
  assert.equal(a.actualMajor, 9);
  assert.equal(a.expectedMajor, EXPECTED_GUARDIAN_MAJOR);
  assert.equal(a.deploymentComplete, false, '網站發布完成不等於 Worker 已升級');
});

test('版本漂移時停止顯示快噴結果，並給出明確橫幅與按鈕名稱', () => {
  const a = assessDeployment({
    now: NOW,
    status: { ...HEALTHY_V10, versionLabel: 'Crypto Radar Guardian 9.0' },
  });
  assert.equal(a.showMoonshot, false, '不得把 v9 的舊結果當成新版快噴資料');
  const critical = a.banners.find((b) => b.tone === 'critical');
  assert.ok(critical, '必須有明確橫幅，而不是默默空白');
  assert.equal(critical.actionLabel, UPDATE_ACTION_LABEL);
  assert.match(critical.title, /9\.0/);
  assert.match(critical.title, /10\.0/);
});

test('版本漂移也要進 Discord 告警，不能只看心跳', () => {
  const a = assessDeployment({
    now: NOW,
    status: { ...HEALTHY_V10, versionLabel: 'Crypto Radar Guardian 9.0' },
  });
  assert.ok(a.alertReasons.some((r) => r.includes('版本漂移')));
});

test('版本相符且各項正常時視為完成', () => {
  const a = assessDeployment({ now: NOW, expectedTradeMode: 'demo', status: HEALTHY_V10 });
  assert.equal(a.versionState, 'ok');
  assert.equal(a.showMoonshot, true);
  assert.equal(a.deploymentComplete, true);
  assert.equal(a.banners.length, 0);
  assert.deepEqual(a.alertReasons, []);
});

test('快噴資料來源不是 Bybit Pre-Breakout 就不顯示', () => {
  const a = assessDeployment({
    now: NOW,
    status: { ...HEALTHY_V10, moonshotProvider: 'DEX Screener' },
  });
  assert.equal(a.showMoonshot, false, '非 Bybit 來源絕不顯示');
  assert.equal(a.deploymentComplete, false);
});

test('交易模式與使用者選擇不符時，是最優先的紅色警示', () => {
  const a = assessDeployment({
    now: NOW,
    expectedTradeMode: 'demo',
    status: { ...HEALTHY_V10, tradeMode: 'live' },
  });
  assert.equal(a.banners[0].tone, 'critical');
  assert.match(a.banners[0].title, /LIVE/);
  assert.match(a.alertReasons[0], /交易模式不符/);
  assert.equal(a.deploymentComplete, false);
});

test('心跳過期會產生警示', () => {
  const a = assessDeployment({
    now: NOW,
    status: { ...HEALTHY_V10, heartbeatAt: '2026-09-05T23:20:00.000Z' },
  });
  assert.equal(a.heartbeatState, 'stale');
  assert.equal(Math.round(a.heartbeatAgeMinutes), 40);
  assert.ok(a.alertReasons.some((r) => r.includes('心跳過期')));
});

test('讀不到版本時不顯示快噴結果', () => {
  const a = assessDeployment({ now: NOW, status: { ...HEALTHY_V10, versionLabel: null } });
  assert.equal(a.versionState, 'unknown');
  assert.equal(a.showMoonshot, false);
});

test('自檢清單涵蓋交接規格第七節要求的每一項', () => {
  const a = assessDeployment({ now: NOW, expectedTradeMode: 'demo', status: HEALTHY_V10 });
  const ids = a.checklist.map((c) => c.id);
  for (const id of ['worker-version', 'worker-health', 'heartbeat', 'cron', 'moonshot-provider', 'trade-mode']) {
    assert.ok(ids.includes(id), `缺少檢查項 ${id}`);
  }
});

test('橫幅一律使用既有深色賽博配色，不引入白色卡片', () => {
  const a = assessDeployment({
    now: NOW,
    status: { ...HEALTHY_V10, versionLabel: 'Crypto Radar Guardian 9.0' },
  });
  for (const b of a.banners) {
    assert.equal(b.style.surface, '#081321', '主面板色必須是 #081321');
    assert.doesNotMatch(b.style.border, /^#f{3,6}$/i, '不得使用白色');
    assert.doesNotMatch(b.style.surface, /^#f{3,6}$/i);
  }
  assert.equal(BANNER_THEME.surface, '#081321');
});

test('watchdog 遲滯：單次漏跑不告警，連續兩次才告警', () => {
  let state = initialWatchdogState();
  const fail = (minutesLater) => evaluateWatchdog({
    state,
    now: new Date(NOW.getTime() + minutesLater * 60_000),
    guardianReachable: false,
    guardianHealthy: false,
    guardianHeartbeatAt: null,
  });

  const first = fail(0);
  assert.equal(first.notify, false, '第一次不告警');
  assert.equal(first.state.consecutiveMisses, 1);
  state = first.state;

  const second = fail(10);
  assert.equal(second.notify, true, `連續 ${ALERT_AFTER_CONSECUTIVE_MISSES} 次才告警`);
  assert.equal(second.kind, 'alert');
  state = second.state;
});

test('watchdog 節流：告警後短時間內不重送', () => {
  let state = initialWatchdogState();
  const run = (minutesLater) => evaluateWatchdog({
    state,
    now: new Date(NOW.getTime() + minutesLater * 60_000),
    guardianReachable: false,
    guardianHealthy: false,
    guardianHeartbeatAt: null,
  });
  state = run(0).state;
  const alert = run(10);
  assert.equal(alert.notify, true);
  state = alert.state;

  const soon = run(20);
  assert.equal(soon.notify, false, '20 分鐘後仍在節流窗內');
  state = soon.state;

  const later = run(80);
  assert.equal(later.notify, true, '超過 60 分鐘後才重送');
});

test('watchdog 恢復時送出恢復通知，且只送一次', () => {
  let state = initialWatchdogState();
  const down = (m) => evaluateWatchdog({
    state, now: new Date(NOW.getTime() + m * 60_000),
    guardianReachable: false, guardianHealthy: false, guardianHeartbeatAt: null,
  });
  const up = (m) => evaluateWatchdog({
    state, now: new Date(NOW.getTime() + m * 60_000),
    guardianReachable: true, guardianHealthy: true,
    guardianHeartbeatAt: new Date(NOW.getTime() + (m - 2) * 60_000).toISOString(),
  });

  state = down(0).state;
  state = down(10).state;

  const recovered = up(20);
  assert.equal(recovered.notify, true);
  assert.equal(recovered.kind, 'recovery');
  state = recovered.state;

  const quiet = up(30);
  assert.equal(quiet.notify, false, '恢復通知只送一次');
  assert.equal(quiet.kind, 'none');
});

test('watchdog 也對版本漂移告警', () => {
  let state = initialWatchdogState();
  const run = (m) => evaluateWatchdog({
    state, now: new Date(NOW.getTime() + m * 60_000),
    guardianReachable: true, guardianHealthy: true,
    guardianHeartbeatAt: new Date(NOW.getTime() + (m - 1) * 60_000).toISOString(),
    extraAlertReasons: ['Worker 版本漂移：運行中 9.0，期望 10.0'],
  });
  state = run(0).state;
  const alert = run(10);
  assert.equal(alert.notify, true);
  assert.match(alert.message, /版本漂移/);
});

test('watchdog 只監控與通知，決策物件不含任何交易或風險欄位', () => {
  const d = evaluateWatchdog({
    state: initialWatchdogState(), now: NOW,
    guardianReachable: false, guardianHealthy: false, guardianHeartbeatAt: null,
  });
  const keys = new Set(Object.keys(d));
  for (const forbidden of ['tradeMode', 'riskPercent', 'enableTrading', 'whitelist', 'maxPositions']) {
    assert.equal(keys.has(forbidden), false, `watchdog 不得涉及 ${forbidden}`);
  }
});

test('dead-man switch：watchdog 自己停擺時要被偵測到', () => {
  assert.equal(checkWatchdogAlive(null, NOW).alive, false);
  assert.equal(checkWatchdogAlive('2026-09-05T23:55:00.000Z', NOW).alive, true);
  const dead = checkWatchdogAlive('2026-09-05T23:00:00.000Z', NOW);
  assert.equal(dead.alive, false);
  assert.match(dead.detail, /60 分鐘未執行/);
});

test('minutesSince 對無效輸入回傳 null', () => {
  assert.equal(minutesSince(null, NOW), null);
  assert.equal(minutesSince('not-a-date', NOW), null);
  assert.equal(minutesSince('2026-09-05T23:30:00.000Z', NOW), 30);
});
