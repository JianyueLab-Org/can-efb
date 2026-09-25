import { describe, expect, test } from "bun:test";
import {
  decidePaddingTransition,
  focusReleased,
  paddingSettled,
} from "@/components/map/camera";
import type { MapFocus } from "@/lib/mapBus";
import type { MapPadding } from "@/lib/panelLayout";

const P: MapPadding = { top: 12, right: 12, bottom: 12, left: 340 };
const Q: MapPadding = { top: 12, right: 12, bottom: 12, left: 12 };

/**
 * 内边距怎么落地的决定，是这个 bug 的核心：跟一个 `easeTo` 走的内边距可能被下
 * 一次镜头动作（对焦、框选）取消，冻结在挪了一半的地方，而如果那时把它当成
 * 「设上了」，同样的目标下次进来会被 dedup 拦住、永远不会再补。见
 * camera.ts 里 decidePaddingTransition 上面的注释。
 */
describe("decidePaddingTransition", () => {
  test("目标没变：跳过，不管镜头忙不忙、是不是第一次", () => {
    expect(
      decidePaddingTransition({
        changed: false,
        appliedBefore: true,
        mapIsMoving: false,
      }),
    ).toBe("skip");
    expect(
      decidePaddingTransition({
        changed: false,
        appliedBefore: false,
        mapIsMoving: true,
      }),
    ).toBe("skip");
  });

  test("第一次落地：直接跳过去，没有「从哪儿滑过来」可言", () => {
    expect(
      decidePaddingTransition({
        changed: true,
        appliedBefore: false,
        mapIsMoving: false,
      }),
    ).toBe("instant");
  });

  test("镜头正忙（对焦、框选、用户手势）：直接跳过去，不跟 easeTo", () => {
    expect(
      decidePaddingTransition({
        changed: true,
        appliedBefore: true,
        mapIsMoving: true,
      }),
    ).toBe("instant");
  });

  test("已经落地过、镜头闲着、目标变了：跟一个 easeTo", () => {
    expect(
      decidePaddingTransition({
        changed: true,
        appliedBefore: true,
        mapIsMoving: false,
      }),
    ).toBe("eased");
  });
});

/**
 * `easeTo` 的 `moveend` 不能直接当成「内边距到了」—— 它可能是被下一次镜头动作
 * 取消时触发的，那时内边距冻结在挪了一半的地方。判据因此是比较内边距本身。
 */
describe("paddingSettled", () => {
  test("四个边都一样才算落地", () => {
    expect(paddingSettled(P, { ...P })).toBe(true);
  });

  test("只要有一个边没到，就不算落地——包括被打断冻结在中途的那种情况", () => {
    expect(paddingSettled(Q, P)).toBe(false);
    expect(paddingSettled({ ...P, left: 170 }, P)).toBe(false);
  });
});

/**
 * 焦点从有到无：上一次框选的签名要作废。否则 `map:plan` 把地图拉回计划时，那条
 * 计划的点和上次框过的一样，`fitPoints` 被签名挡掉，镜头停在刚才对焦的机场上。
 */
describe("focusReleased", () => {
  const focus: MapFocus = { kind: "point", lat: 30, lon: 120 };

  test("有焦点 → 没焦点：作废", () => {
    expect(focusReleased(focus, null)).toBe(true);
  });

  test("一直没焦点、换焦点、从无到有：不作废", () => {
    expect(focusReleased(null, null)).toBe(false);
    expect(focusReleased(focus, { ...focus, lat: 31 })).toBe(false);
    expect(focusReleased(null, focus)).toBe(false);
  });
});
