import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  announcePanelLayout,
  focusMap,
  isMapFocus,
  showPlanOnMap,
  subscribeMapFocus,
  subscribePanelLayout,
  subscribePlanRequest,
  type MapFocus,
} from "@/lib/mapBus";
import type { PanelLayout } from "@/lib/panelLayout";

/*
 * mapBus 挂在 window 上。Bun 没有 DOM，这里给它一个 EventTarget 顶着 —— 用完删
 * 掉，别的测试文件里 `typeof window` 仍然是 undefined。
 */
const globals = globalThis as { window?: unknown };
beforeAll(() => {
  globals.window = new EventTarget();
});
afterAll(() => {
  delete globals.window;
});

const layout = (right: number): PanelLayout => ({
  mode: "desktop",
  collapsed: false,
  rect: { left: 100, top: 12, right, bottom: 788 },
});

/**
 * 地图是 `client:load` 的岛屿，面板脚本在 `astro:page-load` 上跑，谁先谁后不一定。
 * 地图晚到一步就收不到面板第一次的位置，内边距一直是 0 —— 航路被面板压住，没有
 * 任何报错。所以订阅时要把最后一次的位置补发一遍。
 */
describe("panel:layout", () => {
  test("订阅之后收得到", () => {
    const seen: number[] = [];
    const stop = subscribePanelLayout((l) => seen.push(l.rect.right));
    announcePanelLayout(layout(500));
    stop();
    announcePanelLayout(layout(600));
    expect(seen).toEqual([500]);
  });

  test("晚到的订阅者先拿到最后一次的位置", () => {
    announcePanelLayout(layout(700));
    const seen: number[] = [];
    const stop = subscribePanelLayout((l) => seen.push(l.rect.right));
    stop();
    expect(seen).toEqual([700]);
  });
});

/**
 * 飞过去的目标必须是个真坐标。datafeed 里刚连上的飞机没有经纬度，从前那种点被传
 * 下去，地图飞去 NaN，整张图不动，看起来像按钮坏了（formerly MapSurface.vue 踩过
 * 的坑）。
 */
describe("map:focus", () => {
  test("合法的点和框都认", () => {
    expect(isMapFocus({ kind: "point", lat: 31.2, lon: 121.3 })).toBe(true);
    expect(isMapFocus({ kind: "point", lat: 31.2, lon: 121.3, zoom: 10 })).toBe(
      true,
    );
    expect(
      isMapFocus({
        kind: "bounds",
        south: 30,
        west: 120,
        north: 32,
        east: 122,
      }),
    ).toBe(true);
  });

  test("NaN、缺字段、南北颠倒一律不认", () => {
    expect(isMapFocus({ kind: "point", lat: Number.NaN, lon: 121 })).toBe(
      false,
    );
    expect(isMapFocus({ kind: "point", lat: 31 })).toBe(false);
    expect(
      isMapFocus({
        kind: "bounds",
        south: 32,
        west: 120,
        north: 30,
        east: 122,
      }),
    ).toBe(false);
    expect(isMapFocus(null)).toBe(false);
  });

  test("发出去的合法目标原样收到，不合法的根本不发", () => {
    const seen: MapFocus[] = [];
    const stop = subscribeMapFocus((f) => seen.push(f));
    focusMap({ kind: "point", lat: 31.2, lon: 121.3 });
    focusMap({ kind: "point", lat: Number.NaN, lon: 121.3 });
    stop();
    expect(seen).toEqual([{ kind: "point", lat: 31.2, lon: 121.3 }]);
  });
});

describe("map:plan", () => {
  test("请求地图回到已提交的计划", () => {
    let count = 0;
    const stop = subscribePlanRequest(() => count++);
    showPlanOnMap();
    stop();
    showPlanOnMap();
    expect(count).toBe(1);
  });
});
