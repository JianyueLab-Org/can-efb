import { describe, expect, test } from "bun:test";
import { viewForPlanRequest } from "@/components/map/planRequest";
import type { MapFocus, MapPoint } from "@/lib/mapBus";

const A: MapPoint = { ident: "ZSPD", lat: 31.1, lon: 121.8, kind: 0 };
const B: MapPoint = { ident: "ZBAA", lat: 40.1, lon: 116.6, kind: 0 };
const focus: MapFocus = { kind: "point", lat: 31.1, lon: 121.8 };

/**
 * `map:plan`：「地图，回到我已提交的那份计划」。别的页面推过的东西（机场页的标注、
 * 对焦、面板的航路和角标）不能留下来 —— 留着的焦点会让镜头一直停在那个机场，留着的
 * 点会在计划读不到时冒充计划。
 */
describe("viewForPlanRequest", () => {
  test("图上画的是计划：焦点和标注清掉，计划线和角标留着等重读", () => {
    const next = viewForPlanRequest(
      {
        points: [A, B],
        markers: [A],
        focus,
        label: "已提交的飞行计划",
        planShown: true,
      },
      "默认",
    );
    expect(next).toEqual({
      points: [A, B],
      markers: [],
      focus: null,
      label: "已提交的飞行计划",
      pointsChanged: false,
    });
  });

  test("图上是面板推来的：点、标注、焦点全清，角标回到默认", () => {
    const next = viewForPlanRequest(
      {
        points: [A, B],
        markers: [B],
        focus,
        label: "航路预览",
        planShown: false,
      },
      "默认",
    );
    expect(next).toEqual({
      points: [],
      markers: [],
      focus: null,
      label: "默认",
      pointsChanged: true,
    });
  });

  test("本来就是空的：点没变", () => {
    const next = viewForPlanRequest(
      { points: [], markers: [], focus: null, label: "默认", planShown: false },
      "默认",
    );
    expect(next.pointsChanged).toBe(false);
  });
});
