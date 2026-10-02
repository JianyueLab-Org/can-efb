import { describe, expect, test } from "bun:test";
import type { ChartEntry, ChartsState } from "@/lib/charts";
import {
  airportChip,
  chipRetries,
  PINBOARD_GAP_PX,
  pinboardGroups,
  pinboardReserve,
  pinboardView,
  STRIP_COLOUR,
  toolbarIndex,
  viewerBottom,
  withPinboard,
  type PinboardGroup,
  type PinSource,
} from "@/lib/pinboard";

function chart(
  id: number,
  category: ChartEntry["category"],
  name: string,
): ChartEntry {
  return { id, category, name, page: null, kind: "", isSup: false, bytes: 1 };
}

function data(charts: ChartEntry[]): ChartsState {
  return { kind: "data", data: { icao: "ZBTJ", airac: "2610", charts } };
}

const MAIN = chart(1, "TAXI", "机场图");
const SID = chart(2, "SID", "RNAVRWY16(PIKAS)");
const APP = chart(3, "APP", "ILSDMEyRWY16L");

describe("airportChip", () => {
  test("有数据不挂牌子", () => {
    expect(airportChip(data([MAIN]), "none", "noCharts")).toBeNull();
    expect(airportChip(data([]), "none", "noCharts")).toBeNull();
  });

  test("读取中", () => {
    expect(airportChip({ kind: "loading" }, "none", "noCharts")).toBe(
      "loading",
    );
  });

  test("没取到、存储没接上：两种都能重试", () => {
    expect(
      airportChip({ kind: "error", status: 500 }, "none", "noCharts"),
    ).toBe("failed");
    expect(airportChip({ kind: "unconfigured" }, "none", "noCharts")).toBe(
      "unconfigured",
    );
    expect(chipRetries("failed")).toBe(true);
    expect(chipRetries("unconfigured")).toBe(true);
  });

  test("没权限是权限，不是故障，也不重试", () => {
    expect(
      airportChip({ kind: "forbidden", status: 403 }, "none", "noCharts"),
    ).toBe("denied");
    expect(chipRetries("denied")).toBe(false);
  });

  test("空：「不使用受限汇编」藏起来的说已隐藏", () => {
    expect(airportChip({ kind: "empty" }, "hidden", "noCharts")).toBe("hidden");
  });

  test("空：3 级以下说要权限，3 级起说没有", () => {
    expect(airportChip({ kind: "empty" }, "none", "needsAccess")).toBe(
      "needsAccess",
    );
    expect(airportChip({ kind: "empty" }, "none", "noCharts")).toBe("empty");
  });

  test("其余牌子不带重试", () => {
    for (const chip of [
      "loading",
      "hidden",
      "needsAccess",
      "empty",
      null,
    ] as const) {
      expect(chipRetries(chip)).toBe(false);
    }
  });
});

describe("pinboardGroups", () => {
  const sources: PinSource[] = [
    {
      role: "departure",
      icao: "ZBTJ",
      state: data([MAIN, SID]),
      auto: new Set([1]),
      pinned: [MAIN, SID],
    },
    {
      role: "arrival",
      icao: "ZSNB",
      state: data([APP]),
      auto: new Set(),
      pinned: [APP],
    },
    {
      role: "alternate",
      icao: "ZSPD",
      state: { kind: "error", status: 0 },
      auto: new Set(),
      pinned: [],
    },
  ];

  test("计划顺序：起飞、落地、备降", () => {
    const groups = pinboardGroups(sources, "none", "noCharts");
    expect(groups.map((g) => [g.role, g.icao])).toEqual([
      ["departure", "ZBTJ"],
      ["arrival", "ZSNB"],
      ["alternate", "ZSPD"],
    ]);
  });

  test("每个机场只有钉住的那几张，带自动标记", () => {
    const [dep, arr] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.tabs.map((t) => [t.chart.id, t.auto])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(arr.tabs.map((t) => t.chart.id)).toEqual([3]);
  });

  test("类别颜色：STAR 绿、APP 橙、TAXI 蓝、SID 粉、REF 紫", () => {
    expect(STRIP_COLOUR).toEqual({
      STAR: "green",
      APP: "orange",
      TAXI: "blue",
      SID: "pink",
      REF: "violet",
    });
    const [dep, arr] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.tabs.map((t) => t.colour)).toEqual(["blue", "pink"]);
    expect(arr.tabs[0].colour).toBe("orange");
  });

  test("没取到的机场挂牌子、没有标签，别的机场照常", () => {
    const groups = pinboardGroups(sources, "none", "noCharts");
    expect(groups[2].chip).toBe("failed");
    expect(groups[2].tabs).toEqual([]);
    expect(groups[0].chip).toBeNull();
  });

  test("不是 data 的状态不出标签，哪怕传进来了钉住的", () => {
    const [g] = pinboardGroups(
      [
        {
          role: "departure",
          icao: "ZBTJ",
          state: { kind: "loading" },
          auto: new Set([1]),
          pinned: [MAIN],
        },
      ],
      "none",
      "noCharts",
    );
    expect(g.chip).toBe("loading");
    expect(g.tabs).toEqual([]);
  });

  test("auto 原样带出，取消钉住要用", () => {
    const [dep] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.auto.has(1)).toBe(true);
  });
});

describe("pinboardView", () => {
  const quiet: PinboardGroup = {
    role: "departure",
    icao: "ZBTJ",
    chip: null,
    auto: new Set(),
    tabs: [],
  };

  test("计划的三种非正常状态", () => {
    expect(pinboardView("loading", [])).toEqual({ kind: "loading" });
    expect(pinboardView("error", [])).toEqual({ kind: "planFailed" });
    expect(pinboardView("none", [])).toEqual({ kind: "noPlan" });
  });

  test("每个机场都读到了、都没钉：说没有钉住的航图", () => {
    expect(
      pinboardView("plan", [quiet, { ...quiet, role: "arrival" }]),
    ).toEqual({ kind: "noPins" });
  });

  test("有一个机场挂着牌子，就按机场画，让牌子说话", () => {
    const failed = {
      ...quiet,
      role: "arrival" as const,
      chip: "failed" as const,
    };
    expect(pinboardView("plan", [quiet, failed])).toEqual({
      kind: "groups",
      groups: [quiet, failed],
    });
  });

  test("有标签就按机场画", () => {
    const withTab: PinboardGroup = {
      ...quiet,
      tabs: [{ chart: MAIN, auto: true, colour: "blue" }],
    };
    expect(pinboardView("plan", [withTab]).kind).toBe("groups");
  });
});

describe("toolbarIndex", () => {
  test("左右方向键循环", () => {
    expect(toolbarIndex("ArrowRight", 0, 3)).toBe(1);
    expect(toolbarIndex("ArrowRight", 2, 3)).toBe(0);
    expect(toolbarIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(toolbarIndex("ArrowLeft", 2, 3)).toBe(1);
  });

  test("Home、End", () => {
    expect(toolbarIndex("Home", 2, 3)).toBe(0);
    expect(toolbarIndex("End", 0, 3)).toBe(2);
  });

  test("焦点不在栏里时从头或尾进", () => {
    expect(toolbarIndex("ArrowRight", -1, 3)).toBe(0);
    expect(toolbarIndex("ArrowLeft", -1, 3)).toBe(2);
  });

  test("别的键、空栏不管", () => {
    expect(toolbarIndex("Enter", 0, 3)).toBeNull();
    expect(toolbarIndex("ArrowDown", 0, 3)).toBeNull();
    expect(toolbarIndex("ArrowRight", -1, 0)).toBeNull();
  });
});

describe("钉板让出的高度", () => {
  const padding = { top: 12, right: 12, bottom: 12, left: 440 };

  test("栏高加一道间隙；没有栏是 0", () => {
    expect(pinboardReserve(52)).toBe(52 + PINBOARD_GAP_PX);
    expect(pinboardReserve(51.4)).toBe(52 + PINBOARD_GAP_PX);
    expect(pinboardReserve(0)).toBe(0);
  });

  test("地图底边内边距加上让出的高度，其余三边不动", () => {
    expect(withPinboard(padding, 60)).toEqual({ ...padding, bottom: 72 });
    expect(withPinboard(padding, 0)).toBe(padding);
  });

  test("查看器底边在栏上面再隔一道；没有栏时交回 CSS 默认值", () => {
    expect(viewerBottom(padding, 60)).toBe(12 + 60 + PINBOARD_GAP_PX);
    expect(viewerBottom(padding, 0)).toBeNull();
  });
});
