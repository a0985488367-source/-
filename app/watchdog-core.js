/**
 * watchdog-core — 獨立 Discord 心跳守衛的判斷邏輯
 *
 * 這支 Worker 只做一件事：定時去看 Guardian 的 /health，
 * 有問題就通知 Discord，恢復了也通知一次。
 *
 * 它不碰交易、不碰風險參數、不會替任何人下單。
 *
 * 兩個刻意的設計：
 *   遲滯 —— 連續兩次偵測不到才告警。Guardian 每 5 分鐘跑一次、
 *           守衛每 10 分鐘看一次，單次漏跑很正常，不該立刻叫。
 *   節流 —— 重送間隔逐步拉長，長時間斷線不會洗版。
 */

export const ALERT_AFTER_CONSECUTIVE_MISSES = 2;

/** 重送間隔（分鐘），依已告警次數遞增 */
export const REALERT_INTERVAL_MINUTES = Object.freeze([0, 60, 360]);

export function initialState() {
  return { consecutiveMisses: 0, lastAlertAt: null, alertCount: 0, alerting: false, checkedAt: null };
}

/**
 * 依這一輪的探測結果決定要不要發通知。
 *
 * @param {{state: object, now: number, reachable: boolean, health: object|null, httpStatus: number|null}} input
 */
export function evaluate(input) {
  const prev = input.state ?? initialState();
  const now = input.now;
  const reasons = [];

  if (!input.reachable) {
    reasons.push('Guardian /health 無法連線');
  } else {
    const health = input.health;
    if (!health || typeof health !== 'object') {
      reasons.push('Guardian /health 回應格式不正確');
    } else {
      if (health.ok !== true) {
        reasons.push(`Guardian 狀態異常：${health.status ?? '未知'}`);
      }
      if (Number.isFinite(health.ageSeconds) && health.ageSeconds > 900) {
        reasons.push(`Guardian 心跳已 ${Math.round(health.ageSeconds / 60)} 分鐘未更新`);
      }
      if (health.heartbeatAt === null || health.heartbeatAt === undefined) {
        reasons.push('Guardian 沒有回報心跳時間');
      }
    }
  }

  const problem = reasons.length > 0;
  const base = { ...prev, checkedAt: now };

  // 恢復通知
  if (!problem && prev.alerting) {
    return {
      state: { consecutiveMisses: 0, lastAlertAt: prev.lastAlertAt, alertCount: 0, alerting: false, checkedAt: now },
      notify: true,
      kind: 'recovery',
      message: 'Guardian 已恢復正常。心跳與狀態均正常。',
      reasons: [],
    };
  }

  if (!problem) {
    return {
      state: { ...base, consecutiveMisses: 0, alerting: false },
      notify: false, kind: 'none', message: null, reasons: [],
    };
  }

  const consecutiveMisses = prev.consecutiveMisses + 1;

  // 遲滯：連續兩次才告警
  if (consecutiveMisses < ALERT_AFTER_CONSECUTIVE_MISSES) {
    return {
      state: { ...base, consecutiveMisses },
      notify: false, kind: 'none', message: null, reasons,
    };
  }

  // 節流
  const sinceLast = Number.isFinite(prev.lastAlertAt) ? (now - prev.lastAlertAt) / 60000 : null;
  const idx = Math.min(prev.alertCount, REALERT_INTERVAL_MINUTES.length - 1);
  const requiredGap = REALERT_INTERVAL_MINUTES[idx];

  if (prev.alerting && sinceLast !== null && sinceLast < requiredGap) {
    return {
      state: { ...base, consecutiveMisses },
      notify: false, kind: 'none', message: null, reasons,
    };
  }

  return {
    state: {
      consecutiveMisses,
      lastAlertAt: now,
      alertCount: prev.alertCount + 1,
      alerting: true,
      checkedAt: now,
    },
    notify: true,
    kind: 'alert',
    message: `**Guardian 異常**\n${reasons.map((r) => `· ${r}`).join('\n')}\n\n這是監控通知，守衛不會改動任何交易或風險設定。`,
    reasons,
  };
}

/**
 * Dead-man switch：守衛自己是否還活著。
 * 由 Guardian 或人工反查，避免「守衛死了卻沒人知道」。
 */
export function watchdogAlive(checkedAt, now, staleAfterMinutes = 25) {
  if (!Number.isFinite(checkedAt)) {
    return { alive: false, ageMinutes: null, detail: '守衛沒有回報時間，可能未部署或已停止' };
  }
  const ageMinutes = (now - checkedAt) / 60000;
  if (ageMinutes > staleAfterMinutes) {
    return { alive: false, ageMinutes, detail: `守衛已 ${Math.round(ageMinutes)} 分鐘未執行` };
  }
  return { alive: true, ageMinutes, detail: `守衛正常，${Math.round(ageMinutes)} 分鐘前執行` };
}
