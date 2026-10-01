import { describe, expect, test } from "bun:test";
import {
  chartChips,
  chartFilePath,
  chartIndexPath,
  chartsEmptyReason,
  chartsState,
  errorCodeOf,
  defaultChip,
  filterCharts,
  parseChartIndex,
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
