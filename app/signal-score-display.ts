/**
 * signal-score-display — 主幣交易訊號的雙軌分數與進場閘門
 *
 * 對應交接規格第五節「分數與 PEPE 問題」。
 *
 * 舊行為：畫面顯示單一「94 分」，使用者理解成勝率或可進場，
 *         但那 94 只是 15m/1H/4H 同向、BOS、RSI、MACD 的方向條件累積，
 *         實際等級是 WATCH、entryReady=false、量能只有 0.773 倍。
 *
 * 本模組做兩件事：
 *   1. 保留既有的可見分數校正（A 保留原始分、B ≤ 79、WATCH ≤ 67、NONE ≤ 55）。
 *      交接規格明文要求「不要移除此校正」。
 *   2. 把單一分數拆成兩軌：方向分（多確信）與就緒度（幾道進場閘門過了），
 *      並輸出中文阻擋原因。勾選清單比數字難誤讀。
 *
 * 注意：本檔只處理「主幣訊號」。早期快噴幣是另一套獨立功能，
 *       見 app/moonshot-entry-gates.ts，兩者不共用門檻。
 */

import {
  atLeast,
  atMost,
  evaluateGates,
  fmt,
  inRange,
  isTrue,
  type GateEvaluation,
  type GateResult,
  type GateSpec,
} from './gate-kit.ts';

export type SignalGrade = 'A' | 'B' | 'WATCH' | 'NONE';

export type SignalSide = 'long' | 'short';

/**
 * 可見分數上限（交接規格第五節）。
 * A 級保留原始分數；其餘等級壓到各自天花板，
 * 避免再次出現「94 分卻不能進場」。
 */
export const GRADE_DISPLAY_CAP: Readonly<Record<SignalGrade, number>> = Object.freeze({
  A: 100,
  B: 79,
  WATCH: 67,
  NONE: 55,
});

/**
 * 主幣訊號的量能門檻。
 * 刻意與快噴掃描的 1.1 倍分開命名：兩套系統獨立，
 * 任何一邊調整都不該無聲地牽動另一邊。
 */
export const MAIN_SIGNAL_MIN_VOLUME_MULTIPLE = 1.05;

/** 資料超過這個分鐘數就不再視為可進場 */
export const MAIN_SIGNAL_MAX_DATA_AGE_MINUTES = 20;

export interface MainSignalInput {
  symbol: string;
  side: SignalSide;
  /** 方向條件累積的原始分數（同向、結構、BOS、RSI、MACD…） */
  directionScore: number;
  grade: SignalGrade;
  /** 是否在自動交易白名單內 */
  whitelisted: boolean;
  /** Entry 價位計算有效且仍在有效區間 */
  entryValid: boolean;
  /** 依目前帳戶與交易所限制，TP／SL 可以掛得上去 */
  protectionPlannable: boolean;
  /** 近期量能相對基準的放大倍率 */
  volumeMultiple: number;
  /** 價格已進入支撐／壓力進場區 */
  inEntryZone: boolean;
  /** 訊號資料年齡（分鐘） */
  dataAgeMinutes: number;
  /** 風控標記；非空即擋 */
  riskFlags?: readonly string[];
}

export interface DualTrackSignalView {
  symbol: string;
  side: SignalSide;
  grade: SignalGrade;
  /** 方向確信度：原始分數，畫面上要標明這不是勝率 */
  directionScore: number;
  /** 經等級校正後、實際顯示在卡片上的分數 */
  displayScore: number;
  /** 就緒度：畫面顯示成 2/7 這種形式 */
  readiness: { passed: number; total: number };
  /** 全部 blocking 閘門通過才為 true。由結構推導，呼叫端不得覆寫 */
  entryReady: boolean;
  /** 是否允許自動下單：需 entryReady 且 A 級且在白名單 */
  autoTradeEligible: boolean;
  gates: GateResult[];
  blockingReasons: string[];
  /** 給畫面用的提示文案，明確說明分數的意義 */
  scoreCaption: string;
}

/**
 * 套用等級上限。原始分數低於上限時不會被拉高。
 */
export function toDisplayScore(directionScore: number, grade: SignalGrade): number {
  const cap = GRADE_DISPLAY_CAP[grade];
  if (!Number.isFinite(directionScore)) return 0;
  const clamped = Math.max(0, Math.min(100, directionScore));
  return Math.min(clamped, cap ?? 0);
}

const MAIN_SIGNAL_GATES: readonly GateSpec<MainSignalInput>[] = [
  {
    id: 'grade-a',
    label: '訊號等級',
    requirement: '正式 A 級',
    read: (s) => s.grade,
    test: (v) => v === 'A',
    format: (v) => (typeof v === 'string' ? `${v} 級` : '無資料'),
  },
  {
    id: 'whitelisted',
    label: '白名單',
    requirement: '在自動交易白名單內',
    read: (s) => s.whitelisted === true,
    test: isTrue,
    format: fmt.yesNo,
  },
  {
    id: 'entry-valid',
    label: 'Entry 有效',
    requirement: 'Entry 價位有效',
    read: (s) => s.entryValid === true,
    test: isTrue,
    format: fmt.yesNo,
  },
  {
    id: 'protection-plannable',
    label: 'TP／SL 可掛',
    requirement: '能掛妥 TP 與 SL',
    read: (s) => s.protectionPlannable === true,
    test: isTrue,
    format: fmt.yesNo,
  },
  {
    id: 'volume-multiple',
    label: '量能',
    requirement: `≥ ${MAIN_SIGNAL_MIN_VOLUME_MULTIPLE} 倍`,
    read: (s) => s.volumeMultiple,
    test: atLeast(MAIN_SIGNAL_MIN_VOLUME_MULTIPLE),
    format: fmt.multiple,
  },
  {
    id: 'entry-zone',
    label: '進場區',
    requirement: '已進入支撐／壓力進場區',
    read: (s) => s.inEntryZone === true,
    test: isTrue,
    format: fmt.yesNo,
  },
  {
    id: 'no-risk-flags',
    label: '風險標記',
    requirement: '無風險標記',
    read: (s) => (s.riskFlags ?? []).length,
    test: (v) => v === 0,
    format: (v) => (v === 0 ? '無' : `${String(v)} 項`),
  },
  {
    id: 'data-fresh',
    label: '資料年齡',
    requirement: `≤ ${MAIN_SIGNAL_MAX_DATA_AGE_MINUTES} 分鐘`,
    read: (s) => s.dataAgeMinutes,
    test: atMost(MAIN_SIGNAL_MAX_DATA_AGE_MINUTES),
    format: fmt.minutes,
  },
];

/**
 * 主幣訊號的唯一建構入口。
 *
 * 刻意不接受外部傳入的 entryReady／autoTradeEligible：
 * 兩者只能由閘門結果推導，杜絕「高分直接放行」這條路徑。
 */
export function buildSignalView(input: MainSignalInput): DualTrackSignalView {
  const evaluation: GateEvaluation = evaluateGates(MAIN_SIGNAL_GATES, input);
  const displayScore = toDisplayScore(input.directionScore, input.grade);
  const entryReady = evaluation.ready;

  return {
    symbol: input.symbol,
    side: input.side,
    grade: input.grade,
    directionScore: Math.max(0, Math.min(100, Math.round(input.directionScore))),
    displayScore,
    readiness: evaluation.readiness,
    entryReady,
    autoTradeEligible: entryReady && input.grade === 'A' && input.whitelisted === true,
    gates: evaluation.gates,
    blockingReasons: evaluation.reasons,
    scoreCaption: buildScoreCaption(input.grade, entryReady),
  };
}

/**
 * 分數說明文案。重點是講清楚「這不是勝率」。
 * 不承諾任何勝率或報酬。
 */
export function buildScoreCaption(grade: SignalGrade, entryReady: boolean): string {
  const base = '方向分只代表多空條件累積程度，不是勝率、也不是報酬預期。';
  if (entryReady) return `${base}目前進場條件已全部通過。`;
  if (grade === 'A') return `${base}尚有進場條件未通過，暫不進場。`;
  return `${base}目前為 ${grade} 級觀察，不進場。`;
}

/* ------------------------------------------------------------------ */
/* 不變量自檢 —— 給測試與執行期斷言用                                   */
/* ------------------------------------------------------------------ */

/**
 * 回傳違反的不變量清單；正常情況為空陣列。
 * 這些條件若被破壞，就是 PEPE 那類誤導重新出現的徵兆。
 */
export function checkSignalInvariants(view: DualTrackSignalView): string[] {
  const violations: string[] = [];
  const cap = GRADE_DISPLAY_CAP[view.grade];

  if (view.displayScore > cap) {
    violations.push(`${view.grade} 級顯示分數 ${view.displayScore} 超過上限 ${cap}`);
  }
  if (view.entryReady && view.blockingReasons.length > 0) {
    violations.push('entryReady 為 true 但仍有阻擋原因');
  }
  if (view.entryReady && view.gates.some((g) => g.severity === 'blocking' && !g.passed)) {
    violations.push('entryReady 為 true 但有 blocking 閘門未通過');
  }
  if (!view.entryReady && view.autoTradeEligible) {
    violations.push('未就緒卻標記為可自動交易');
  }
  if (view.autoTradeEligible && view.grade !== 'A') {
    violations.push('非 A 級卻標記為可自動交易');
  }
  return violations;
}
