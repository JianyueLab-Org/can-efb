import { describe, expect, test } from "bun:test";
import {
  mapPaddingFor,
  MIN_VISIBLE_PX,
  PANEL_GAP_PX,
  parseShellMode,
  stagePaddingFor,
} from "@/lib/panelLayout";

/**
 * 地图铺满视口、面板压在上面。内边距算错不会报错：镜头照样居中，只是中心落在面
 * 板底下 —— 屏幕上看起来像「航路没框进来」，不像一个 bug。
 */
describe("mapPaddingFor", () => {
  test("桌面：左边让出图标轨和面板，再加一道留白", () => {
    expect(
      mapPaddingFor(
        {
          mode: "desktop",
          collapsed: false,
          rect: { left: 284, top: 12, right: 700, bottom: 788 },
        },
        { width: 1440, height: 800 },
      ),
    ).toEqual({ top: 12, right: 12, bottom: 12, left: 712 });
  });

  test("折叠成一条之后按那一条算，不按原来的宽度", () => {
    expect(
      mapPaddingFor(
        {
          mode: "tablet",
          collapsed: true,
          rect: { left: 88, top: 12, right: 140, bottom: 788 },
        },
        { width: 1024, height: 800 },
      ).left,
    ).toBe(140 + PANEL_GAP_PX);
  });

  test("可见区至少留 160px，窗口再窄也不给负宽度", () => {
    expect(
      mapPaddingFor(
        {
          mode: "desktop",
          collapsed: false,
          rect: { left: 284, top: 12, right: 760, bottom: 788 },
        },
        { width: 800, height: 800 },
      ).left,
    ).toBe(800 - PANEL_GAP_PX - MIN_VISIBLE_PX);
  });

  test("手机：底部让出抽屉盖住的那一截", () => {
    expect(
      mapPaddingFor(
        {
          mode: "phone",
          collapsed: false,
          rect: { left: 0, top: 400, right: 390, bottom: 780 },
        },
        { width: 390, height: 844 },
      ),
    ).toEqual({ top: 12, right: 12, bottom: 456, left: 12 });
  });

  test("手机抽屉拉满时，底部内边距同样夹住", () => {
    expect(
      mapPaddingFor(
        {
          mode: "phone",
          collapsed: false,
          rect: { left: 0, top: 8, right: 390, bottom: 780 },
        },
        { width: 390, height: 844 },
      ).bottom,
    ).toBe(844 - MIN_VISIBLE_PX);
  });
});

/** `--shell-mode` 读出来带空格，CSS 还没到时是空串。 */
describe("parseShellMode", () => {
  test("认得三个值，两头的空白不算", () => {
    expect(parseShellMode(" desktop ")).toBe("desktop");
    expect(parseShellMode("tablet")).toBe("tablet");
    expect(parseShellMode("phone")).toBe("phone");
  });

  test("认不得的一律当手机 —— 那是样式表里的起点", () => {
    expect(parseShellMode("")).toBe("phone");
    expect(parseShellMode("columns")).toBe("phone");
  });
});

/**
 * 地图从顶栏下沿开始，面板矩形是视口坐标。换算错了，手机上「至少留多少」会按视
 * 口高度算，多留出一个顶栏高；桌面上左边让位会差出一个容器偏移。
 */
describe("stagePaddingFor", () => {
  const stage = { left: 0, top: 57, right: 1440, bottom: 800 };

  test("桌面：按容器坐标让出面板，结果和视口坐标一致（左边重合）", () => {
    expect(
      stagePaddingFor(
        {
          mode: "desktop",
          collapsed: false,
          rect: { left: 68, top: 69, right: 484, bottom: 788 },
        },
        stage,
      ),
    ).toEqual({ top: 12, right: 12, bottom: 12, left: 496 });
  });

  test("手机：盖住多少按底边算，两套坐标一样", () => {
    expect(
      stagePaddingFor(
        {
          mode: "phone",
          collapsed: false,
          rect: { left: 0, top: 500, right: 390, bottom: 844 },
        },
        { left: 0, top: 57, right: 390, bottom: 844 },
      ),
    ).toEqual({ top: 12, right: 12, bottom: 356, left: 12 });
  });

  test("手机：抽屉拉满时按地图自己的高度留出可见区", () => {
    const phone = { left: 0, top: 57, right: 390, bottom: 844 };
    const padding = stagePaddingFor(
      {
        mode: "phone",
        collapsed: false,
        rect: { left: 0, top: 69, right: 390, bottom: 844 },
      },
      phone,
    );
    expect(phone.bottom - phone.top - padding.bottom).toBe(MIN_VISIBLE_PX);
  });
});
