/**
 * gate-kit — 共用閘門原語
 *
 * 為什麼存在：
 *   舊版把「方向確信度」與「現在能不能進場」壓成同一個數字，
 *   於是出現 PEPE 顯示 94 分、實際卻是 WATCH 且 entryReady=false 的誤導。
 *   本模組把「進場資格」變成一組具名閘門：每道閘門有實際值、門檻、
 *   以及未通過時的中文原因。entryReady 只能由閘門結構推導，不能手動指定。
 *
 * 主幣訊號與早期快噴幣是兩套獨立功能（交接規格三.2），
 * 兩者各自定義自己的閘門集合，只共用這個原語。
 */

export type GateSeverity = 'blocking' | 'warning';

export type GateValue = number | string | boolean | null;

export interface GateResult {
  /** 穩定識別碼，供測試與遙測使用，不要在地化 */
  id: string;
  /** 手機畫面上顯示的中文短標籤 */
  label: string;
  passed: boolean;
  severity: GateSeverity;
  /** 這道閘門實際讀到的值；讀不到時為 null */
  actual: GateValue;
  /** 門檻的人類可讀描述，例如「≥ 1.05 倍」 */
  requirement: string;
  /** 未通過時組合好的完整原因，例如「量能 0.77 倍（需 ≥ 1.05 倍）」 */
  reason: string | null;
}

export interface GateSpec<Ctx> {
  id: string;
  label: string;
  requirement: string;
  severity?: GateSeverity;
  /** 從情境讀出這道閘門要檢查的值 */
  read: (ctx: Ctx) => GateValue;
  /** 判定是否通過。讀不到值時務必回傳 false（fail-safe） */
  test: (value: GateValue, ctx: Ctx) => boolean;
  /** 把值格式化進原因字串；預設直接字串化 */
  format?: (value: GateValue) => string;
}

export interface GateEvaluation {
  gates: GateResult[];
  /** 未通過的 blocking 閘門 */
  blocking: GateResult[];
  /** 未通過的 warning 閘門（不擋進場，但要顯示） */
  warnings: GateResult[];
  /** 沒有任何 blocking 閘門失敗 */
  ready: boolean;
  /** 就緒度：畫面上顯示成 3/7 這種形式，比單一分數難誤讀 */
  readiness: { passed: number; total: number };
  /** 中文阻擋原因，依閘門宣告順序 */
  reasons: string[];
}

function defaultFormat(value: GateValue): string {
  if (value === null || value === undefined) return '無資料';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '無資料';
    return String(Math.round(value * 10000) / 10000);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

/**
 * 評估一組閘門。
 *
 * 設計重點：任何一道閘門讀不到值就算失敗，永遠不會因為缺資料而「放行」。
 */
export function evaluateGates<Ctx>(specs: readonly GateSpec<Ctx>[], ctx: Ctx): GateEvaluation {
  const gates: GateResult[] = specs.map((spec) => {
    const severity: GateSeverity = spec.severity ?? 'blocking';
    let actual: GateValue = null;
    let passed = false;
    try {
      actual = spec.read(ctx);
      passed = spec.test(actual, ctx) === true;
    } catch {
      // 讀取或判定丟出例外一律視為未通過，維持 fail-safe
      actual = null;
      passed = false;
    }
    const fmt = spec.format ?? defaultFormat;
    return {
      id: spec.id,
      label: spec.label,
      passed,
      severity,
      actual,
      requirement: spec.requirement,
      reason: passed ? null : `${spec.label} ${fmt(actual)}（需 ${spec.requirement}）`,
    };
  });

  const blocking = gates.filter((g) => !g.passed && g.severity === 'blocking');
  const warnings = gates.filter((g) => !g.passed && g.severity === 'warning');
  const blockingGates = gates.filter((g) => g.severity === 'blocking');

  return {
    gates,
    blocking,
    warnings,
    ready: blocking.length === 0,
    readiness: {
      passed: blockingGates.filter((g) => g.passed).length,
      total: blockingGates.length,
    },
    reasons: blocking.map((g) => g.reason as string),
  };
}

/* ------------------------------------------------------------------ */
/* 判定輔助 —— 全部對非有限數字回傳 false                              */
/* ------------------------------------------------------------------ */

export function isFiniteNumber(value: GateValue): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 閉區間 [min, max] */
export function inRange(min: number, max: number) {
  return (value: GateValue): boolean => isFiniteNumber(value) && value >= min && value <= max;
}

export function atLeast(min: number) {
  return (value: GateValue): boolean => isFiniteNumber(value) && value >= min;
}

export function atMost(max: number) {
  return (value: GateValue): boolean => isFiniteNumber(value) && value <= max;
}

/** 絕對值上限，用於資金費率這種雙向極端值 */
export function absAtMost(max: number) {
  return (value: GateValue): boolean => isFiniteNumber(value) && Math.abs(value) <= max;
}

export function isTrue(value: GateValue): boolean {
  return value === true;
}

/** 常用格式化器 */
export const fmt = {
  pct: (value: GateValue): string =>
    isFiniteNumber(value) ? `${(Math.round(value * 100) / 100).toFixed(2)}%` : '無資料',
  multiple: (value: GateValue): string =>
    isFiniteNumber(value) ? `${(Math.round(value * 1000) / 1000).toFixed(3)} 倍` : '無資料',
  minutes: (value: GateValue): string =>
    isFiniteNumber(value) ? `${Math.round(value)} 分鐘` : '無資料',
  score: (value: GateValue): string => (isFiniteNumber(value) ? `${Math.round(value)} 分` : '無資料'),
  yesNo: (value: GateValue): string => (value === true ? '是' : value === false ? '否' : '無資料'),
};
