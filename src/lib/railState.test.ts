import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setRail } from "@/lib/railState";

/*
 * Bun 没有 DOM。setRail 只碰 `document.documentElement.dataset` 和
 * `localStorage`，各给一个最小的替身，用完删掉。
 */
const globals = globalThis as {
  document?: unknown;
  localStorage?: unknown;
};
let dataset: Record<string, string>;
let stored: Map<string, string>;

beforeEach(() => {
  dataset = {};
  stored = new Map();
  globals.document = { documentElement: { dataset } };
  globals.localStorage = {
    setItem: (k: string, v: string) => stored.set(k, v),
  };
});
afterEach(() => {
  delete globals.document;
  delete globals.localStorage;
});

/** AppRail 的箭头和设置页的开关走同一个写入口：data-rail 和存下来的偏好一起写。 */
describe("setRail", () => {
  test("写 data-rail，并存成偏好", () => {
    setRail("collapsed");
    expect(dataset.rail).toBe("collapsed");
    expect(stored.get("efb.rail")).toBe("collapsed");
    setRail("expanded");
    expect(dataset.rail).toBe("expanded");
    expect(stored.get("efb.rail")).toBe("expanded");
  });

  test("localStorage 抛错（隐私模式）：data-rail 照写，不往外抛", () => {
    globals.localStorage = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => setRail("collapsed")).not.toThrow();
    expect(dataset.rail).toBe("collapsed");
  });
});
