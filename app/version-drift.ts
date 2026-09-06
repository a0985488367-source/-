/**
 * version-drift — Worker 版本漂移偵測、心跳守衛與告警節流
 *
 * 對應交接規格第七、八節。
 *
 * 交接時的實際狀況：網站已是 Sites v34 且程式含 Guardian v10，
 * 但真正運行中的 Cloudflare Worker 仍可能是 9.0。
 * 網站雖然會拒絕顯示 v9 的舊百倍幣結果，但那是「默默不顯示」，
 * 使用者看到的是空白區塊，分不清是沒有候選還是版本沒升級。
 *
 * 本模組把這個落差變成明確可見的狀態：
 *   1. 版本漂移產生具體橫幅，並指名要按的按鈕。
 *   2. Discord watchdog 也對版本漂移告警，而不是只看心跳年齡。
 *   3. watchdog 自己的心跳也被監控（dead-man switch），避免守衛死了沒人知道。
 *   4. 告警加上遲滯與節流，避免單次 cron 漏跑就洗版。
 *
 * 本模組不碰交易開關，也不修改任何風險參數。
 */

export const EXPECTED_GUARDIAN_MAJOR = 10;

export type TradeMode = 'demo' | 'live';

export interface WorkerStatus {
  /** /api/status 回傳的版本字串，例如 "Crypto Radar Guardian 10.0" */
  versionLabel: string | null;
  healthy: boolean;
  /** 最近一次心跳時間 ISO 字串 */
  heartbeatAt: string | null;
  tradeMode: TradeMode | null;
  moonshotProvider: string | null;
  cronScheduleMinutes: number | null;
}

export type VersionState = 'ok' | 'drift' | 'unknown';
export type HeartbeatState = 'ok' | 'stale' | 'missing';

/** 從 "Crypto Radar Guardian 9.0" 取出主版本號 */
export function parseGuardianMajor(versionLabel: string | null | undefined): number | null {
  if (!versionLabel) return null;
  const match = /(\d+)(?:\.(\d+))?\s*$/.exec(versionLabel.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

export function minutesSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 60000;
}

/* ------------------------------------------------------------------ */
/* 橫幅主題 —— 沿用既有深色賽博配色                                      */
/* ------------------------------------------------------------------ */

/**
 * 主面板色 #081321（交接規格三.9）。
 * 一律用描邊與微光呈現狀態，不新增白色卡片或突兀新色。
 */
export const BANNER_THEME = Object.freeze({
  surface: '#081321',
  critical: Object.freeze({ border: '#ff4d6d', text: '#ffd6de', glow: 'rgba(255, 77, 109, 0.25)' }),
  warning: Object.freeze({ border: '#ffb020', text: '#ffe9c2', glow: 'rgba(255, 176, 32, 0.22)' }),
  ok: Object.freeze({ border: '#22d3ee', text: '#c8f7ff', glow: 'rgba(34, 211, 238, 0.20)' }),
});

export type BannerTone = 'critical' | 'warning' | 'ok';

export interface Banner {
  tone: BannerTone;
  title: string;
  detail: string;
  /** 要使用者按的按鈕文字；沒有動作時為 null */
  actionLabel: string | null;
  style: { surface: string; border: string; text: string; glow: string };
}

/** 網站上實際的更新按鈕文字，必須與畫面一致 */
export const UPDATE_ACTION_LABEL = '更新快噴掃描與迷因幣風控';

function banner(tone: BannerTone, title: string, detail: string, actionLabel: string | null): Banner {
  const palette = BANNER_THEME[tone];
  return {
    tone,
    title,
    detail,
    actionLabel,
    style: { surface: BANNER_THEME.surface, border: palette.border, text: palette.text, glow: palette.glow },
  };
}

/* ------------------------------------------------------------------ */
/* 部署狀態評估                                                         */
/* ------------------------------------------------------------------ */

export interface DeploymentAssessment {
  versionState: VersionState;
  actualMajor: number | null;
  expectedMajor: number;
  heartbeatState: HeartbeatState;
  heartbeatAgeMinutes: number | null;
  /** 是否允許顯示快噴掃描結果 */
  showMoonshot: boolean;
  /** 交接規格：不得聲稱網站發布完成就等於 Worker 已升級 */
  deploymentComplete: boolean;
  banners: Banner[];
  /** 要送到 Discord 的告警原因 */
  alertReasons: string[];
  checklist: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

export interface AssessOptions {
  status: WorkerStatus;
  now: Date;
  expectedMajor?: number;
  /** 心跳超過此分鐘數視為過期 */
  staleAfterMinutes?: number;
  /** 使用者選擇的交易模式，用來偵測未經確認的切換 */
  expectedTradeMode?: TradeMode | null;
}

/**
 * 綜合評估目前部署狀態，產出橫幅、告警與自檢清單。
 *
 * 重點：版本不符時 showMoonshot 為 false —— 沿用既有「拒絕顯示 v9 舊結果」
 * 的保護，但同時給出明確橫幅，讓使用者知道是版本問題而非沒有候選。
 */
export function assessDeployment(options: AssessOptions): DeploymentAssessment {
  const { status, now } = options;
  const expectedMajor = options.expectedMajor ?? EXPECTED_GUARDIAN_MAJOR;
  const staleAfter = options.staleAfterMinutes ?? 15;

  const actualMajor = parseGuardianMajor(status.versionLabel);
  const versionState: VersionState =
    actualMajor === null ? 'unknown' : actualMajor === expectedMajor ? 'ok' : 'drift';

  const heartbeatAgeMinutes = minutesSince(status.heartbeatAt, now);
  const heartbeatState: HeartbeatState =
    heartbeatAgeMinutes === null ? 'missing' : heartbeatAgeMinutes > staleAfter ? 'stale' : 'ok';

  const banners: Banner[] = [];
  const alertReasons: string[] = [];

  if (versionState === 'drift') {
    banners.push(banner(
      'critical',
      `Guardian Worker 仍在 ${actualMajor}.0，網站需要 ${expectedMajor}.0`,
      `快噴掃描結果已暫停顯示，避免把舊版已噴候選當成新版資料。請按下方按鈕並完成一次 Cloudflare 授權。`,
      UPDATE_ACTION_LABEL,
    ));
    alertReasons.push(`Worker 版本漂移：運行中 ${actualMajor}.0，期望 ${expectedMajor}.0`);
  } else if (versionState === 'unknown') {
    banners.push(banner(
      'warning',
      '無法讀取 Guardian Worker 版本',
      '請確認 /api/status 是否可連線。版本確認前，快噴掃描結果暫停顯示。',
      null,
    ));
    alertReasons.push('無法讀取 Worker 版本');
  }

  if (heartbeatState === 'stale') {
    banners.push(banner(
      'warning',
      `Guardian 心跳已 ${Math.round(heartbeatAgeMinutes as number)} 分鐘未更新`,
      'Cron 可能未依五分鐘排程執行，畫面資料可能不是最新的。',
      null,
    ));
    alertReasons.push(`心跳過期 ${Math.round(heartbeatAgeMinutes as number)} 分鐘`);
  } else if (heartbeatState === 'missing') {
    banners.push(banner('warning', '讀不到 Guardian 心跳', '無法確認 Worker 是否正在執行排程。', null));
    alertReasons.push('讀不到心跳時間');
  }

  if (!status.healthy) {
    alertReasons.push('Worker 狀態非 healthy');
  }

  // 交易模式若與使用者選擇不符，是最高優先的警示。
  // 交接規格三.5、十：自動交易不得因程式更新而自行切換成正式資金。
  const expectedMode = options.expectedTradeMode ?? null;
  if (expectedMode !== null && status.tradeMode !== null && status.tradeMode !== expectedMode) {
    banners.unshift(banner(
      'critical',
      `交易模式為 ${status.tradeMode.toUpperCase()}，與你選擇的 ${expectedMode.toUpperCase()} 不符`,
      '請立即確認。自動交易不應該因為程式更新而改變資金模式。',
      null,
    ));
    alertReasons.unshift(`交易模式不符：實際 ${status.tradeMode}，預期 ${expectedMode}`);
  }

  const providerOk = status.moonshotProvider === 'Bybit Pre-Breakout';
  const cronOk = status.cronScheduleMinutes === 5;

  const checklist = [
    {
      id: 'worker-version',
      label: 'Worker 版本',
      passed: versionState === 'ok',
      detail: actualMajor === null ? '讀取失敗' : `${actualMajor}.0（期望 ${expectedMajor}.0）`,
    },
    {
      id: 'worker-health',
      label: 'Worker 狀態',
      passed: status.healthy === true,
      detail: status.healthy ? 'healthy' : '非 healthy',
    },
    {
      id: 'heartbeat',
      label: '心跳年齡',
      passed: heartbeatState === 'ok',
      detail: heartbeatAgeMinutes === null ? '無資料' : `${Math.round(heartbeatAgeMinutes)} 分鐘`,
    },
    {
      id: 'cron',
      label: 'Guardian Cron',
      passed: cronOk,
      detail: status.cronScheduleMinutes === null ? '無資料' : `每 ${status.cronScheduleMinutes} 分鐘`,
    },
    {
      id: 'moonshot-provider',
      label: '快噴資料來源',
      passed: providerOk,
      detail: status.moonshotProvider ?? '無資料',
    },
    {
      id: 'trade-mode',
      label: '交易模式',
      passed: expectedMode === null ? true : status.tradeMode === expectedMode,
      detail: status.tradeMode ? status.tradeMode.toUpperCase() : '無資料',
    },
  ];

  const showMoonshot = versionState === 'ok' && providerOk;

  return {
    versionState,
    actualMajor,
    expectedMajor,
    heartbeatState,
    heartbeatAgeMinutes,
    showMoonshot,
    deploymentComplete: checklist.every((c) => c.passed),
    banners,
    alertReasons,
    checklist,
  };
}

/* ------------------------------------------------------------------ */
/* Discord 心跳守衛：遲滯、節流與 dead-man switch                        */
/* ------------------------------------------------------------------ */

/** 連續幾次偵測不到才告警，避免單次 cron 漏跑就叫 */
export const ALERT_AFTER_CONSECUTIVE_MISSES = 2;

/** 告警重送間隔（分鐘），逐步拉長避免長時間斷線洗版 */
export const REALERT_INTERVAL_MINUTES: readonly number[] = Object.freeze([0, 60, 360]);

export interface WatchdogState {
  consecutiveMisses: number;
  lastAlertAt: string | null;
  alertCount: number;
  /** 上一輪是否處於告警狀態，用來判斷是否要送恢復通知 */
  alerting: boolean;
  /** watchdog 自己的心跳，供 dead-man switch 使用 */
  watchdogHeartbeatAt: string | null;
}

export function initialWatchdogState(): WatchdogState {
  return { consecutiveMisses: 0, lastAlertAt: null, alertCount: 0, alerting: false, watchdogHeartbeatAt: null };
}

export interface WatchdogInput {
  state: WatchdogState;
  now: Date;
  /** Guardian /health 是否可連線且狀態正常 */
  guardianReachable: boolean;
  guardianHealthy: boolean;
  guardianHeartbeatAt: string | null;
  /** 版本漂移等額外告警原因 */
  extraAlertReasons?: readonly string[];
  staleAfterMinutes?: number;
}

export interface WatchdogDecision {
  state: WatchdogState;
  /** 是否要送 Discord 通知 */
  notify: boolean;
  kind: 'alert' | 'recovery' | 'none';
  message: string | null;
  reasons: string[];
}

/**
 * 判斷這一輪 watchdog 要不要發 Discord。
 *
 * 只監控與通知，不開啟交易、不修改風險（交接規格八）。
 */
export function evaluateWatchdog(input: WatchdogInput): WatchdogDecision {
  const staleAfter = input.staleAfterMinutes ?? 10;
  const age = minutesSince(input.guardianHeartbeatAt, input.now);

  const reasons: string[] = [];
  if (!input.guardianReachable) reasons.push('Guardian /health 無法連線');
  else if (!input.guardianHealthy) reasons.push('Guardian 狀態異常');
  if (age === null) reasons.push('讀不到 Guardian 心跳時間');
  else if (age > staleAfter) reasons.push(`Guardian 心跳已 ${Math.round(age)} 分鐘未更新`);
  reasons.push(...(input.extraAlertReasons ?? []));

  const problem = reasons.length > 0;
  const prev = input.state;
  const consecutiveMisses = problem ? prev.consecutiveMisses + 1 : 0;
  const nowIso = input.now.toISOString();

  // 恢復通知
  if (!problem && prev.alerting) {
    return {
      state: { consecutiveMisses: 0, lastAlertAt: prev.lastAlertAt, alertCount: 0, alerting: false, watchdogHeartbeatAt: nowIso },
      notify: true,
      kind: 'recovery',
      message: 'Guardian 已恢復正常，心跳與狀態均正常。',
      reasons: [],
    };
  }

  if (!problem) {
    return {
      state: { ...prev, consecutiveMisses: 0, alerting: false, watchdogHeartbeatAt: nowIso },
      notify: false,
      kind: 'none',
      message: null,
      reasons: [],
    };
  }

  // 遲滯：連續兩次才告警
  if (consecutiveMisses < ALERT_AFTER_CONSECUTIVE_MISSES) {
    return {
      state: { ...prev, consecutiveMisses, watchdogHeartbeatAt: nowIso },
      notify: false,
      kind: 'none',
      message: null,
      reasons,
    };
  }

  // 節流：依 alertCount 決定重送間隔
  const sinceLastAlert = minutesSince(prev.lastAlertAt, input.now);
  const intervalIndex = Math.min(prev.alertCount, REALERT_INTERVAL_MINUTES.length - 1);
  const requiredGap = REALERT_INTERVAL_MINUTES[intervalIndex] ?? 360;

  if (prev.alerting && sinceLastAlert !== null && sinceLastAlert < requiredGap) {
    return {
      state: { ...prev, consecutiveMisses, watchdogHeartbeatAt: nowIso },
      notify: false,
      kind: 'none',
      message: null,
      reasons,
    };
  }

  return {
    state: {
      consecutiveMisses,
      lastAlertAt: nowIso,
      alertCount: prev.alertCount + 1,
      alerting: true,
      watchdogHeartbeatAt: nowIso,
    },
    notify: true,
    kind: 'alert',
    message: `Guardian 異常：${reasons.join('；')}`,
    reasons,
  };
}

/**
 * Dead-man switch：檢查 watchdog 自己是否還活著。
 *
 * watchdog 每十分鐘執行一次並寫入自己的心跳。
 * 由 Guardian 或網站載入時反查這個時間，避免「守衛死了卻沒人知道」。
 */
export function checkWatchdogAlive(
  watchdogHeartbeatAt: string | null,
  now: Date,
  staleAfterMinutes = 25,
): { alive: boolean; ageMinutes: number | null; detail: string } {
  const age = minutesSince(watchdogHeartbeatAt, now);
  if (age === null) {
    return { alive: false, ageMinutes: null, detail: 'Discord 心跳守衛沒有回報時間，可能未部署或已停止' };
  }
  if (age > staleAfterMinutes) {
    return { alive: false, ageMinutes: age, detail: `Discord 心跳守衛已 ${Math.round(age)} 分鐘未執行` };
  }
  return { alive: true, ageMinutes: age, detail: `Discord 心跳守衛正常，${Math.round(age)} 分鐘前執行` };
}
