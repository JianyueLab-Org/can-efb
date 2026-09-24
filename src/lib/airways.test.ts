import { expect, test, describe } from "bun:test";
import type { FeatureCollection } from "geojson";

import {
  legKey,
  routeLegKeys,
  markRouteOnAirways,
  mergeAirwayLevels,
  toAirwayFixes,
  toAirwayLines,
  type AirwayGraph,
  type AirwaySegment,
} from "@/lib/airways";

const seg = (airway: string, from: string, to: string) => ({
  type: "Feature" as const,
  properties: { airway, from, to, onRoute: 0 },
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [116, 40],
      [117, 41],
    ],
  },
});

const collection = (
  ...features: ReturnType<typeof seg>[]
): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

describe("航段键与方向无关", () => {
  /**
   * 航段在库里存成哪个朝向，是导入时那一段碰巧的存法。
   *
   * **一条计划可能反着飞过去** —— 认朝向的话，那半条航路点不亮，而图上看不出来：线
   * 还在，只是没高亮。can-db 的航路限制匹配踩过同一个坑，那边的结论也是不看朝向。
   */
  test("两个方向给出同一个键", () => {
    expect(legKey("W1", "AAAAA", "BBBBB")).toBe(legKey("W1", "BBBBB", "AAAAA"));
  });

  test("反着飞的航段照样点亮", () => {
    const fc = collection(seg("W1", "AAAAA", "BBBBB"));
    // 计划是 BBBBB → AAAAA，和库里存的方向相反
    const marked = markRouteOnAirways(
      fc,
      routeLegKeys([{ ident: "BBBBB" }, { ident: "AAAAA", via: "W1" }]),
    );
    expect(marked.size).toBe(1);
    expect(fc.features[0].properties?.onRoute).toBe(1);
  });
});

describe("哪些腿算在航路上", () => {
  test("DCT 和没有 via 的腿不算", () => {
    const keys = routeLegKeys([
      { ident: "ZSPD" },
      { ident: "AAAAA", via: "DCT" },
      { ident: "BBBBB" },
      { ident: "CCCCC", via: "W1" },
    ]);
    expect([...keys]).toEqual([legKey("W1", "BBBBB", "CCCCC")]);
  });
});

describe("返回的是真正标到的", () => {
  /**
   * **这个区别是这一层存在的意义。**
   *
   * 不是每条腿都点得亮：图层可能关着、航段可能被高低空过滤掉、端点可能解析不出坐
   * 标。调用方拿这个结果决定哪几条腿仍然得自己画线 —— 假设「有 via 就一定被点亮」
   * 的话，没点上的腿会从图上消失，而**航路断在中间看不出来**：剩下的线本身都对。
   */
  test("计划里有、但航路网里没有的那一段不算标到", () => {
    const fc = collection(seg("W1", "AAAAA", "BBBBB"));
    const marked = markRouteOnAirways(
      fc,
      routeLegKeys([
        { ident: "AAAAA" },
        { ident: "BBBBB", via: "W1" },
        // W9 那一段不在这份集合里（比如被高低空过滤掉了）
        { ident: "CCCCC", via: "W9" },
      ]),
    );
    expect(marked.has(legKey("W1", "AAAAA", "BBBBB"))).toBe(true);
    expect(marked.has(legKey("W9", "BBBBB", "CCCCC"))).toBe(false);
  });

  /**
   * 每次都重写 `onRoute`，不是只加不清。
   *
   * 航路集合是按 level 缓存的，同一份对象反复使用 —— 只加不清的话，换一条计划之后
   * 图上会同时亮着两条。
   */
  test("换一条航路，旧的高亮要撤掉", () => {
    const fc = collection(
      seg("W1", "AAAAA", "BBBBB"),
      seg("W9", "BBBBB", "CCCCC"),
    );
    markRouteOnAirways(
      fc,
      routeLegKeys([{ ident: "AAAAA" }, { ident: "BBBBB", via: "W1" }]),
    );
    expect(fc.features[0].properties?.onRoute).toBe(1);

    markRouteOnAirways(
      fc,
      routeLegKeys([{ ident: "BBBBB" }, { ident: "CCCCC", via: "W9" }]),
    );
    expect(fc.features[0].properties?.onRoute).toBe(0);
    expect(fc.features[1].properties?.onRoute).toBe(1);
  });

  test("空航路把所有高亮清掉", () => {
    const fc = collection(seg("W1", "AAAAA", "BBBBB"));
    markRouteOnAirways(
      fc,
      routeLegKeys([{ ident: "AAAAA" }, { ident: "BBBBB", via: "W1" }]),
    );
    const marked = markRouteOnAirways(fc, new Set());
    expect(marked.size).toBe(0);
    expect(fc.features[0].properties?.onRoute).toBe(0);
  });
});

describe("高低空合成一张图", () => {
  const leg = (airway: string, from: string, to: string): AirwaySegment => ({
    airway,
    from,
    to,
    dir: "both",
    minAlt: null,
    maxAlt: null,
  });
  const fixes: AirwayGraph["fixes"] = {
    AAAAA: [30, 120],
    BBBBB: [31, 121],
    CCCCC: [32, 122],
    DDDDD: [33, 123],
  };
  const graph = (...segments: AirwaySegment[]): AirwayGraph => ({
    fixes,
    airways: {},
    segments,
  });

  /**
   * can-db 的 `?level=high` 给 high + both + NULL，`low` 给 low + both + NULL，响应
   * 里不带层级。两边都有的就是 `both`，而且只画一条。
   */
  const merged = mergeAirwayLevels(
    graph(leg("J1", "AAAAA", "BBBBB"), leg("W1", "BBBBB", "CCCCC")),
    graph(leg("V1", "CCCCC", "DDDDD"), leg("W1", "BBBBB", "CCCCC")),
  );
  const levelOf = (airway: string) =>
    merged.segments.find((s) => s.airway === airway)?.level;

  test("按出现在哪一边打标记", () => {
    expect(levelOf("J1")).toBe("high");
    expect(levelOf("V1")).toBe("low");
    expect(levelOf("W1")).toBe("both");
  });

  test("两边都有的只留一条", () => {
    expect(merged.segments.filter((s) => s.airway === "W1").length).toBe(1);
    expect(merged.segments.length).toBe(3);
  });

  test("线要素带层级", () => {
    const lines = toAirwayLines(merged);
    const v1 = lines.features.find((f) => f.properties?.airway === "V1");
    expect(v1?.properties?.level).toBe("low");
  });

  /** 只被低空航段用到的点，只在低空那层出现时才画；有高空航段连着就是高空的点。 */
  test("航路点跟着连它的航段分层", () => {
    const pts = toAirwayFixes(merged);
    const levelAt = (ident: string) =>
      pts.features.find((f) => f.properties?.ident === ident)?.properties
        ?.level;
    expect(levelAt("AAAAA")).toBe("high");
    expect(levelAt("DDDDD")).toBe("low");
    // CCCCC 同时连着 W1（both）和 V1（low）。
    expect(levelAt("CCCCC")).toBe("both");
  });
});
