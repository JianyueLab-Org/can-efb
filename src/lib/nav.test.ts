import { describe, expect, test } from "bun:test";
import { buildCrossLinks } from "@/lib/nav";

/**
 * 轨底的跨站链接从前是手抄的三条（主站、雷达、开发者中心）。现在来自 can-ui 的
 * `visibleSites`，所以这里验的是「接得对不对」：本站不列、每条都是外链、评级门
 * 槛真的传过去了。`isCurrentPath` 的测试跟着函数一起搬去了 can-ui 的
 * `src/nav.test.ts`。
 */

const t = (key: string) => key;
const hrefs = (rating?: number, signedIn = true) =>
  buildCrossLinks(t, { locale: "zh-cn", rating, signedIn }).items.map(
    (item) => item.href,
  );

describe("buildCrossLinks", () => {
  test("不列 EFB 自己，每一条都是外链", () => {
    const links = buildCrossLinks(t, { locale: "zh-cn", signedIn: true });
    expect(links.items.some((item) => item.href.includes("efb."))).toBe(false);
    expect(links.items.every((item) => item.external === true)).toBe(true);
  });

  test("门户只画给教员", () => {
    expect(hrefs(undefined).some((h) => h.includes("portal."))).toBe(false);
    expect(hrefs(8).some((h) => h.includes("portal."))).toBe(true);
  });

  test("标题来自本站词典，站名来自 can-ui", () => {
    const links = buildCrossLinks(t, { locale: "zh-cn", signedIn: true });
    expect(links.label).toBe("links.label");
    expect(links.items.map((item) => item.name)).toContain("在线雷达");
  });
});
