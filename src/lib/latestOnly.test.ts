import { describe, expect, test } from "bun:test";
import { latestOnly } from "@/lib/latestOnly";

/**
 * 边打字边画的请求只认最后一个。旧的不撤掉，它晚到的回答会把一条已经不是框里那条
 * 的线画上地图 —— 不报错，只是图和表对不上。
 */
describe("latestOnly", () => {
  test("发新的就撤掉旧的", () => {
    const latest = latestOnly();
    const first = latest.next();
    const second = latest.next();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  test("cancel 撤掉正在路上的那个，之后不再有「当前」", () => {
    const latest = latestOnly();
    const signal = latest.next();
    latest.cancel();
    expect(signal.aborted).toBe(true);
    const next = latest.next();
    expect(next.aborted).toBe(false);
  });

  test("没有请求时 cancel 不出错", () => {
    expect(() => latestOnly().cancel()).not.toThrow();
  });
});
