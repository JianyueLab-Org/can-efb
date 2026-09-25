import { describe, expect, test } from "bun:test";
import {
  decidePaddingTransition,
  paddingSettled,
} from "@/components/map/camera";
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
