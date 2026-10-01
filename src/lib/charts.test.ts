import { describe, expect, test } from "bun:test";
import type { PanelLayout, ShellMode } from "@/lib/panelLayout";
import {
  anchoredScroll,
  AIP_RESTRICTED_CALL,
  CHART_FILE_PATTERN,
  CHART_INDEX_PATTERN,
  chartsEmptyBody,
  viewerShortcut,
  wrapFocusIndex,
  chartChips,
  chartFilePath,
  chartIndexPath,
  chartsEmptyReason,
  chartsState,
  errorCodeOf,
  clampPage,
  clampZoom,
  defaultChip,
  fileFailure,
  filterCharts,
  MAX_CANVAS_PIXELS,
  nextRotation,
  parseChartIndex,
  pinchZoom,
  renderScale,
  stepZoom,
  viewerPlacement,
  wheelZoom,
  type ChartEntry,
} from "@/lib/charts";

function chart(
  id: number,
  category: ChartEntry["category"],
  name: string,
  page: string | null = null,
): ChartEntry {
  return { id, category, name, page, kind: "", isSup: false, bytes: 1 };
}

const ZSSS: ChartEntry[] = [
  chart(1, "STAR", "数据库编码", "0C-01"),
  chart(2, "STAR", "数据库编码", "0C-02"),
  chart(3, "APP", "ILS/DME RWY36L", "6A-01"),
  chart(4, "TAXI", "停机位置坐标", "0P-1"),
  chart(5, "REF", "上海虹桥"),
];

describe("parseChartIndex", () => {
  const row = {
    id: 7,
    category: "STAR",
    name: "数据库编码",
    page: "0C-01",
    kind: "标准仪表进场图",
    isSup: false,
    bytes: 171599,
  };

  test("拆 can-db 的信封", () => {
    const body = {
      status: "success",
      licence: null,
      data: { icao: "ZSSS", airac: "2610", charts: [row] },
    };
    expect(parseChartIndex(body)).toEqual({
      icao: "ZSSS",
      airac: "2610",
      charts: [row as ChartEntry],
    });
  });

  test("不带信封也收", () => {
    expect(
      parseChartIndex({ icao: "ZSSS", airac: "2610", charts: [row] })?.charts,
    ).toHaveLength(1);
  });

  test("airac 是数字时转成字符串", () => {
    expect(
      parseChartIndex({ icao: "ZSSS", airac: 2610, charts: [] })?.airac,
    ).toBe("2610");
  });

  test("Go 的空切片编码成 null，当成没有航图", () => {
    expect(
      parseChartIndex({ data: { icao: "ZSSS", airac: "2610", charts: null } })
        ?.charts,
    ).toEqual([]);
  });

  test("没有 charts 字段是读不懂，不是没有", () => {
    expect(parseChartIndex({ data: { icao: "ZSSS" } })).toBeNull();
    expect(parseChartIndex(null)).toBeNull();
    expect(parseChartIndex("x")).toBeNull();
  });

  test("丢掉形状不对的行", () => {
    const index = parseChartIndex({
      icao: "ZSSS",
      airac: "2610",
      charts: [
        { id: 1, category: "STAR", name: "a" },
        { id: "2", category: "STAR", name: "b" },
        { id: 3, category: "IFR", name: "c" },
        { id: 4, category: "SID" },
        { id: 0, category: "SID", name: "d" },
        null,
      ],
    });
    expect(index?.charts.map((c) => c.id)).toEqual([1]);
  });

  test("缺省字段补成确定的值", () => {
    expect(
      parseChartIndex({
        icao: "ZSSS",
        airac: "2610",
        charts: [{ id: 1, category: "REF", name: "a", page: "" }],
      })?.charts[0],
    ).toEqual({
      id: 1,
      category: "REF",
      name: "a",
      page: null,
      kind: "",
      isSup: false,
      bytes: 0,
    });
  });
});

describe("chartsState", () => {
  const index = { icao: "ZSSS", airac: "2610", charts: ZSSS };

  test("有航图是 data", () => {
    expect(chartsState(true, 200, index)).toEqual({
      kind: "data",
      data: index,
    });
  });

  test("空列表是 empty", () => {
    expect(chartsState(true, 200, { ...index, charts: [] })).toEqual({
      kind: "empty",
    });
  });

  test("200 但读不懂是错误，不是没有", () => {
    expect(chartsState(true, 200, null)).toEqual({
      kind: "error",
      status: 200,
    });
  });

  test("401 和 403 是没权限", () => {
    expect(chartsState(false, 401, null)).toEqual({
      kind: "forbidden",
      status: 401,
    });
    expect(chartsState(false, 403, null)).toEqual({
      kind: "forbidden",
      status: 403,
    });
  });

  test("503 且 error 是 charts_unavailable 是存储没配置", () => {
    expect(chartsState(false, 503, null, "charts_unavailable")).toEqual({
      kind: "unconfigured",
    });
  });

  test("别的 503（upstream_unavailable）是错误，可以重试", () => {
    expect(chartsState(false, 503, null, "upstream_unavailable")).toEqual({
      kind: "error",
      status: 503,
    });
    expect(chartsState(false, 503, null)).toEqual({
      kind: "error",
      status: 503,
    });
  });

  test("别的失败是错误", () => {
    expect(chartsState(false, 502, null)).toEqual({
      kind: "error",
      status: 502,
    });
  });
});

describe("chartChips / defaultChip", () => {
  test("五个类别按固定顺序，带计数，空的禁用", () => {
    expect(chartChips(ZSSS)).toEqual([
      { category: "STAR", count: 2, disabled: false },
      { category: "APP", count: 1, disabled: false },
      { category: "TAXI", count: 1, disabled: false },
      { category: "SID", count: 0, disabled: true },
      { category: "REF", count: 1, disabled: false },
    ]);
  });

  test("默认是第一个非空的", () => {
    expect(defaultChip(chartChips(ZSSS))).toBe("STAR");
    expect(
      defaultChip(chartChips([chart(9, "REF", "x"), chart(8, "TAXI", "y")])),
    ).toBe("TAXI");
  });

  test("全空没有默认", () => {
    expect(defaultChip(chartChips([]))).toBeNull();
  });
});

describe("filterCharts", () => {
  test("不搜索时按类别，保留服务端顺序", () => {
    expect(filterCharts(ZSSS, "STAR", "").map((c) => c.id)).toEqual([1, 2]);
  });

  test("只有空白等于没搜索", () => {
    expect(filterCharts(ZSSS, "APP", "   ").map((c) => c.id)).toEqual([3]);
  });

  test("没有类别也没搜索时是空", () => {
    expect(filterCharts(ZSSS, null, "")).toEqual([]);
  });

  test("搜索跨类别，不看选中的类别", () => {
    expect(filterCharts(ZSSS, "STAR", "停机").map((c) => c.id)).toEqual([4]);
  });

  test("搜页码，不分大小写", () => {
    expect(filterCharts(ZSSS, null, "0c-02").map((c) => c.id)).toEqual([2]);
  });

  test("搜名称，不分大小写", () => {
    expect(filterCharts(ZSSS, null, "ils").map((c) => c.id)).toEqual([3]);
  });

  test("搜索结果按类别的显示顺序排", () => {
    const mixed = [chart(9, "REF", "X 图"), chart(8, "STAR", "X 进场")];
    expect(filterCharts(mixed, null, "x").map((c) => c.id)).toEqual([8, 9]);
  });
});

describe("paths", () => {
  test("索引路径转大写、去空白", () => {
    expect(chartIndexPath(" zsss ")).toBe("aip/airports/ZSSS/charts");
  });

  test("文件路径", () => {
    expect(chartFilePath(42)).toBe("aip/charts/42/file");
  });
});

describe("chartsEmptyReason", () => {
  test("3 级起开着隐藏开关，空是被隐藏了", () => {
    expect(chartsEmptyReason(true, 3)).toBe("hidden");
  });

  test("3 级以下开关是空转，空就是没有", () => {
    expect(chartsEmptyReason(true, 2)).toBe("none");
  });

  test("开关关着，空就是没有", () => {
    expect(chartsEmptyReason(false, 4)).toBe("none");
  });
});

describe("errorCodeOf", () => {
  test("取响应体里的 error 字段", () => {
    expect(errorCodeOf({ error: "charts_unavailable" })).toBe(
      "charts_unavailable",
    );
  });

  test("不是对象或没有字符串 error 时是 null", () => {
    expect(errorCodeOf(null)).toBeNull();
    expect(errorCodeOf("x")).toBeNull();
    expect(errorCodeOf({ error: 1 })).toBeNull();
    expect(errorCodeOf({})).toBeNull();
  });
});

function layout(mode: ShellMode, right: number): PanelLayout {
  return {
    mode,
    collapsed: false,
    rect: { left: 64, top: 12, right, bottom: 800 },
  };
}

describe("viewerPlacement", () => {
  test("还不知道面板在哪时盖满", () => {
    expect(viewerPlacement(null, 1440)).toEqual({ mode: "overlay" });
  });

  test("手机上盖满", () => {
    expect(viewerPlacement(layout("phone", 390), 390)).toEqual({
      mode: "overlay",
    });
  });

  test("桌面上贴在面板右边，隔一道留白", () => {
    expect(viewerPlacement(layout("desktop", 476), 1440)).toEqual({
      mode: "beside",
      left: 488,
    });
  });

  test("面板折叠时跟着往左", () => {
    expect(viewerPlacement(layout("desktop", 116), 1280)).toEqual({
      mode: "beside",
      left: 128,
    });
  });

  test("旁边放不下就盖满", () => {
    expect(viewerPlacement(layout("tablet", 470), 900)).toEqual({
      mode: "overlay",
    });
  });
});

describe("zoom", () => {
  test("clampZoom 夹在范围里，非数字回 1", () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(20)).toBe(8);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  test("stepZoom 一档乘除 1.25，到顶不动", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(stepZoom(8, 1)).toBe(8);
  });

  test("wheelZoom 往上滚放大，往下滚缩小，不滚不变", () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(1, 0)).toBe(1);
    expect(wheelZoom(8, -1000)).toBe(8);
  });

  test("pinchZoom 按两指距离之比", () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 0, 50)).toBe(2);
  });

  test("anchoredScroll 让锚点下的内容不动", () => {
    expect(anchoredScroll(100, 50, 2)).toBe(250);
    expect(anchoredScroll(0, 0, 3)).toBe(0);
  });
});

describe("nextRotation", () => {
  test("每次 90°，转满一圈回 0", () => {
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(90)).toBe(180);
    expect(nextRotation(180)).toBe(270);
    expect(nextRotation(270)).toBe(0);
  });
});

describe("renderScale", () => {
  test("像素数够用时是 CSS 倍率乘设备像素比", () => {
    expect(renderScale(1.5, 2, 600, 800)).toBe(3);
  });

  test("超过画布上限时压到上限以内", () => {
    const scale = renderScale(4, 3, 600, 800);
    expect(scale).toBeCloseTo(Math.sqrt(MAX_CANVAS_PIXELS / 480_000), 6);
    expect(600 * scale * 800 * scale).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS + 1,
    );
  });
});

describe("clampPage", () => {
  test("夹在 1..total", () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(5, 3)).toBe(3);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(1, 0)).toBe(1);
  });
});

describe("fileFailure", () => {
  test("按状态码分类", () => {
    expect(fileFailure(401)).toBe("forbidden");
    expect(fileFailure(403)).toBe("forbidden");
    expect(fileFailure(404)).toBe("notFound");
    expect(fileFailure(503, "charts_unavailable")).toBe("unconfigured");
    expect(fileFailure(503, "upstream_unavailable")).toBe("error");
    expect(fileFailure(503)).toBe("error");
    expect(fileFailure(500)).toBe("error");
    expect(fileFailure(0)).toBe("error");
  });
});

describe("allowlist patterns", () => {
  test("索引：四个字母，大小写都收", () => {
    expect(CHART_INDEX_PATTERN.test("aip/airports/ZSSS/charts")).toBe(true);
    expect(CHART_INDEX_PATTERN.test("aip/airports/zsss/charts")).toBe(true);
  });

  test("索引：别的形状都不收", () => {
    for (const bad of [
      "aip/airports/ZSS/charts",
      "aip/airports/ZSSSS/charts",
      "aip/airports/ZSSS/charts/",
      "aip/airports/ZSSS/charts/x",
      "aip/airports/ZSSS/charts\n",
      "aip/airports/ZS1S/charts",
      "aip/airports/../charts",
      "aip/airports/ZSSS/chart",
      "xaip/airports/ZSSS/charts",
    ]) {
      expect(CHART_INDEX_PATTERN.test(bad)).toBe(false);
    }
  });

  test("文件：正整数 id", () => {
    expect(CHART_FILE_PATTERN.test("aip/charts/1/file")).toBe(true);
    expect(CHART_FILE_PATTERN.test("aip/charts/42/file")).toBe(true);
    expect(CHART_FILE_PATTERN.test("aip/charts/9223372036854775807/file")).toBe(
      true,
    );
  });

  test("文件：别的形状都不收", () => {
    for (const bad of [
      "aip/charts/abc/file",
      "aip/charts/0/file",
      "aip/charts/01/file",
      "aip/charts/-1/file",
      "aip/charts/1.5/file",
      "aip/charts/../file",
      "aip/charts/1/file/",
      "aip/charts/1/file/../..",
      "aip/charts/1/file\n",
      "aip/charts/1/",
      "aip/charts//file",
      "aip/charts/12345678901234567890/file",
      "aip/charts/١/file",
    ]) {
      expect(CHART_FILE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("边界输入", () => {
  test("wheelZoom 的 deltaY 不是有限数时保持当前缩放", () => {
    expect(wheelZoom(2, Number.NaN)).toBe(2);
    expect(wheelZoom(2, Number.POSITIVE_INFINITY)).toBe(2);
  });

  test("renderScale 的 dpr 不可用时按 1", () => {
    expect(renderScale(1.5, 0, 600, 800)).toBe(1.5);
    expect(renderScale(1.5, -2, 600, 800)).toBe(1.5);
    expect(renderScale(1.5, Number.NaN, 600, 800)).toBe(1.5);
  });
});

describe("chartsEmptyBody", () => {
  test("3 级以下说需要 3 级，3 级起说这个机场没有", () => {
    expect(chartsEmptyBody(0)).toBe("needsAccess");
    expect(chartsEmptyBody(AIP_RESTRICTED_CALL - 1)).toBe("needsAccess");
    expect(chartsEmptyBody(AIP_RESTRICTED_CALL)).toBe("noCharts");
    expect(chartsEmptyBody(4)).toBe("noCharts");
  });
});

describe("wrapFocusIndex", () => {
  test("最后一个再 Tab 回第一个，第一个再 Shift+Tab 到最后一个", () => {
    expect(wrapFocusIndex(2, 3, false)).toBe(0);
    expect(wrapFocusIndex(0, 3, true)).toBe(2);
  });

  test("中间的交给浏览器", () => {
    expect(wrapFocusIndex(1, 3, false)).toBeNull();
    expect(wrapFocusIndex(1, 3, true)).toBeNull();
  });

  test("焦点不在容器里时拉进来", () => {
    expect(wrapFocusIndex(-1, 3, false)).toBe(0);
    expect(wrapFocusIndex(-1, 3, true)).toBe(2);
  });

  test("没有可聚焦元素时交给浏览器", () => {
    expect(wrapFocusIndex(-1, 0, false)).toBeNull();
  });
});

describe("viewerShortcut", () => {
  const none = { ctrlKey: false, metaKey: false, altKey: false };

  test("+ = - 0 对应放大、缩小、整页", () => {
    expect(viewerShortcut("+", none)).toBe("zoomIn");
    expect(viewerShortcut("=", none)).toBe("zoomIn");
    expect(viewerShortcut("-", none)).toBe("zoomOut");
    expect(viewerShortcut("0", none)).toBe("fit");
    expect(viewerShortcut("a", none)).toBeNull();
  });

  test("带 Ctrl / Cmd / Alt 的不认，留给浏览器缩放", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(viewerShortcut("=", { ...none, [mod]: true })).toBeNull();
      expect(viewerShortcut("0", { ...none, [mod]: true })).toBeNull();
    }
  });
});
