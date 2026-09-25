import { describe, expect, test } from "bun:test";
import {
  effectiveRail,
  mapPaddingFor,
  MIN_VISIBLE_PX,
  PANEL_GAP_PX,
  parseShellMode,
  railChangeAnnouncesImmediately,
} from "@/lib/panelLayout";

/**
 * 地图铺满视口、面板压在上面。内边距算错不会报错：镜头照样居中，只是中心落在面
 * 板底下 —— 屏幕上看起来像「航路没框进来」，不像一个 bug。
 */
describe("mapPaddingFor", () => {
  test("桌面：左边让出轨和面板，再加一道留白", () => {
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
 * `data-rail` 有三个值。`auto` 表示成员从没选过，由 CSS 按宽度决定：平板上收起，
 * 桌面上展开。判错的后果是轨的箭头朝向和实际宽度对不上。
 */
describe("effectiveRail", () => {
  test("成员选过的值原样生效", () => {
    expect(effectiveRail("collapsed", "expanded")).toBe("collapsed");
    expect(effectiveRail("expanded", "collapsed")).toBe("expanded");
  });

  test("auto 跟着 CSS 给的 --rail-auto 走", () => {
    expect(effectiveRail("auto", " collapsed")).toBe("collapsed");
    expect(effectiveRail("auto", "expanded")).toBe("expanded");
    expect(effectiveRail(undefined, "")).toBe("expanded");
  });
});

/**
 * 折叠/展开轨会不会让面板的 `left` 跑一次过渡，决定观察器是自己直接报
 * （panel:layout），还是等 transitionend / transitioncancel 报。判错的后果是
 * 地图在过渡跑到一半时就把镜头往中间态 easeTo 一次，过渡结束时终值又报一次，
 * 表现成 padding 跳两下。
 */
describe("railChangeAnnouncesImmediately", () => {
  test("桌面/平板：left 有 200ms 过渡，交给 transitionend", () => {
    expect(
      railChangeAnnouncesImmediately(false, "width, left", "240ms, 200ms"),
    ).toBe(false);
  });

  test("手机：这一排布的 transition 里根本没有 left，直接报", () => {
    expect(railChangeAnnouncesImmediately(false, "transform", "320ms")).toBe(
      true,
    );
  });

  test("减少动态效果：不管 CSS 算出来的时长，直接报", () => {
    expect(
      railChangeAnnouncesImmediately(true, "width, left", "240ms, 200ms"),
    ).toBe(true);
  });

  test("减少动态效果的 CSS 把 transition 折成 all/0s，同样直接报", () => {
    expect(railChangeAnnouncesImmediately(false, "all", "0s")).toBe(true);
  });

  test("浏览器有时用秒而不是毫秒报时长", () => {
    expect(
      railChangeAnnouncesImmediately(false, "width, left", "0.24s, 0.2s"),
    ).toBe(false);
  });

  test("left 的时长本来就是 0：不用等一个不会来的事件", () => {
    expect(
      railChangeAnnouncesImmediately(false, "width, left", "240ms, 0ms"),
    ).toBe(true);
  });
});
