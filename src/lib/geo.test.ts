import { describe, expect, test } from "bun:test";
import { arc } from "@/lib/geo";

/**
 * 跨 ±180° 的一段，端点经度要展开到同一侧，不然地图会把它画成横穿整张图的一条线。
 * 长航段走 `greatCircle`，一直是展开的；短航段不插值，曾经把两个端点原样返回。
 */
describe("arc 跨日界线", () => {
  test("短航段也展开经度", () => {
    const path = arc([50, 179.5], [50, -179.5]);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual([50, 179.5]);
    expect(path[1][0]).toBe(50);
    expect(path[1][1]).toBeCloseTo(180.5);
  });

  test("反方向同样", () => {
    const path = arc([50, -179.5], [50, 179.5]);
    expect(path[1][1]).toBeCloseTo(-180.5);
  });

  test("不跨的短航段原样", () => {
    expect(arc([39, 116], [39.2, 116.3])).toEqual([
      [39, 116],
      [39.2, 116.3],
    ]);
  });

  test("长航段相邻两点经度差不超过 180", () => {
    const path = arc([35, 140], [35, -120]);
    for (let i = 1; i < path.length; i++) {
      expect(Math.abs(path[i][1] - path[i - 1][1])).toBeLessThan(180);
    }
  });
});
