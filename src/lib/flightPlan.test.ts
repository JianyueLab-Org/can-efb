import { describe, expect, test } from "bun:test";
import { blankPlan, fillPlan, formatUtc } from "@/lib/flightPlan";

/**
 * 时刻按 UTC 显示：管制员、ATIS、计划里的 EOBT 都是 Z 时。按本地时区显示不会报错，
 * 只是在东八区差八小时。
 */
describe("formatUtc", () => {
  test("RFC 3339 排成 YYYY-MM-DD HH:MMZ", () => {
    expect(formatUtc("2026-09-25T13:05:09Z")).toBe("2026-09-25 13:05Z");
  });

  test("带时区偏移的也折回 UTC", () => {
    expect(formatUtc("2026-09-25T08:05:00+08:00")).toBe("2026-09-25 00:05Z");
  });

  test("解析不了就原样返回", () => {
    expect(formatUtc("yesterday")).toBe("yesterday");
  });
});

describe("fillPlan", () => {
  test("只抄已知字段里的字符串，别的不碰", () => {
    const plan = blankPlan();
    fillPlan(plan, {
      callsign: "CCA1501",
      route: "ELKUR A461 SASAN",
      // @ts-expect-error —— can-api 回来的对象里有表单不认识的字段
      updatedAt: "2026-09-25T13:05:09Z",
    });
    expect(plan.callsign).toBe("CCA1501");
    expect(plan.route).toBe("ELKUR A461 SASAN");
    expect("updatedAt" in plan).toBe(false);
    expect(plan.flightRules).toBe("I");
  });

  test("非字符串的值跳过，不把字段写成 undefined", () => {
    const plan = blankPlan();
    fillPlan(plan, { callsign: undefined });
    expect(plan.callsign).toBe("");
  });
});
