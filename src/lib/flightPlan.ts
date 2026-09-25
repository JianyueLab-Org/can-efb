/**
 * 飞行计划的形状和两三个纯函数。从 FlightPlan.vue 搬出来：表单拆成了几个组件，它们
 * 共用这一份类型；而 `formatUtc` 错了不会被屏幕出卖（东八区差八小时，看起来仍然是
 * 一个像样的时刻）。
 */

/** 和 can-api 的 `flightplan.Plan` 逐字段对应。全是字符串，那边也是。 */
export interface Plan {
  callsign: string;
  flightRules: string;
  aircraft: string;
  cruiseTas: string;
  departure: string;
  departureTime: string;
  cruisingAltitude: string;
  arrival: string;
  alternate: string;
  hoursEnroute: string;
  minutesEnroute: string;
  fuelHours: string;
  fuelMinutes: string;
  remarks: string;
  route: string;
}

export interface StoredPlan extends Plan {
  filedFromClient: boolean;
  updatedAt: string;
}

/** 飞行规则的四个值，顺序就是下拉框里的顺序。文案在 `flightplan.rules.*`。 */
export const FLIGHT_RULES = ["I", "V", "S", "D"] as const;

/**
 * `updatedAt` 是 can-api 给的 RFC 3339（`plan.UpdatedAt.UTC().Format(...)`）。
 * 原样显示是一串带 `T` 和秒的机器格式；按本地时区显示又和航空上一切时刻都用
 * UTC 的约定冲突 —— 管制员、ATIS、飞行计划里的 EOBT 都是 Z 时。所以固定按 UTC
 * 排成 `YYYY-MM-DD HH:MMZ`。解析不了就原样返回，至少不比以前差。
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`
  );
}

export function blankPlan(): Plan {
  return {
    callsign: "",
    flightRules: "I",
    aircraft: "",
    cruiseTas: "",
    departure: "",
    departureTime: "",
    cruisingAltitude: "",
    arrival: "",
    alternate: "",
    hoursEnroute: "",
    minutesEnroute: "",
    fuelHours: "",
    fuelMinutes: "",
    remarks: "",
    route: "",
  };
}

/**
 * 把一份（可能来自 can-api、SimBrief 或草稿的）计划抄进表单：只抄表单认识的字段，
 * 只抄字符串。FlightPlan.vue 132–137 原来的 `fill`。
 */
export function fillPlan(target: Plan, source: Partial<Plan>): void {
  for (const key of Object.keys(target) as (keyof Plan)[]) {
    const value = source[key];
    if (typeof value === "string") target[key] = value;
  }
}
