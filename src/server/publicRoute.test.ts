import { describe, expect, test } from "bun:test";
import { isPublicRoute } from "@/server/publicRoute";

describe("isPublicRoute", () => {
  test("404 页是公开的", () => {
    expect(isPublicRoute("/404", "/404")).toBe(true);
    expect(isPublicRoute("/no-such-page", "/404")).toBe(true);
    expect(isPublicRoute("/404", undefined)).toBe(true);
  });
  test("别的页面都要登录", () => {
    for (const [path, pattern] of [
      ["/", "/"],
      ["/route", "/route"],
      ["/flightplan", "/flightplan"],
      ["/airports", "/airports"],
      ["/settings", "/settings"],
    ]) {
      expect(isPublicRoute(path, pattern)).toBe(false);
    }
    expect(isPublicRoute("/route", undefined)).toBe(false);
  });
});
