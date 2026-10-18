import { describe, expect, test } from "bun:test";
import { pageTitle } from "@/lib/pageTitle";

describe("pageTitle", () => {
  test("首页只有站名", () => {
    expect(pageTitle(undefined, "zh-cn")).toBe("电子飞行包");
    expect(pageTitle(undefined, "en-us")).toBe("Flight Bag");
  });
  test("其余页面是 <页面> · <站名>", () => {
    expect(pageTitle("航路", "zh-cn")).toBe("航路 · 电子飞行包");
    expect(pageTitle("Route", "en-us")).toBe("Route · Flight Bag");
  });
});
