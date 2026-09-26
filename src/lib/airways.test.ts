import { expect, test, describe } from "bun:test";
import type { FeatureCollection } from "geojson";

import {
  airwayBlocksFor,
  isRnavDesignator,
  markNavaidFixes,
  legKey,
  routeLegKeys,
  markRouteOnAirways,
  mergeAirwayLevels,
  routeLegs,
  unionAirwayGraphs,
  toAirwayFixes,
  toAirwayLines,
  airwayGapNm,
  AIRWAY_FIX_GAP_NM,
  type AirwayGraph,
  type AirwaySegment,
} from "@/lib/airways";
import { distanceNm } from "@/lib/geo";

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

describe("RNAV 按代号猜", () => {
  test.each(["L888", "M503", "N892", "P901", "Q1", "T1", "Y1", "Z3"])(
    "%s 是 RNAV",
    (d) => expect(isRnavDesignator(d)).toBe(true),
  );
  test.each(["W66", "V67", "X41"])("中国的 %s 按 RNAV", (d) =>
    expect(isRnavDesignator(d)).toBe(true),
  );
  test.each(["A461", "B330", "G212", "R343", "H1", "J1"])("%s 是常规", (d) =>
    expect(isRnavDesignator(d)).toBe(false),
  );

  /** 前缀 `U` / `K` / `S` 后面跟字母才算前缀：`UL888` 看 `L`，`UA1` 看 `A`。 */
  test("去掉一个 ICAO 前缀再看", () => {
    expect(isRnavDesignator("UL888")).toBe(true);
    expect(isRnavDesignator("UA1")).toBe(false);
    expect(isRnavDesignator("KB1")).toBe(false);
    expect(isRnavDesignator("ul888")).toBe(true);
    expect(isRnavDesignator("")).toBe(false);
  });

  test("线要素带 rnav", () => {
    const lines = toAirwayLines({
      fixes: { AAAAA: [30, 120], BBBBB: [31, 121] },
      airways: {},
      segments: [
        {
          airway: "Y1",
          from: "AAAAA",
          to: "BBBBB",
          dir: "both",
          minAlt: null,
          maxAlt: null,
        },
        {
          airway: "A1",
          from: "AAAAA",
          to: "BBBBB",
          dir: "both",
          minAlt: null,
          maxAlt: null,
        },
      ],
    });
    const rnav = (a: string) =>
      lines.features.find((f) => f.properties?.airway === a)?.properties?.rnav;
    expect(rnav("Y1")).toBe(1);
    expect(rnav("A1")).toBe(0);
  });
});

describe("和导航台重合的航路点", () => {
  const point = (ident: string, lon: number, lat: number, tier?: string) => ({
    type: "Feature" as const,
    properties: tier ? { ident, tier } : { ident, level: "high", navaid: "" },
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
  });
  const fc = (...features: ReturnType<typeof point>[]): FeatureCollection => ({
    type: "FeatureCollection",
    features,
  });
  const fixes = fc(
    point("SJD", 119.7, 32.5),
    point("VYK", 116.6, 40.0),
    point("ABCDE", 120.0, 31.0),
    point("FAR", 110.0, 30.0),
  );
  const navaids = fc(
    point("SJD", 119.705, 32.495, "vor"),
    point("VYK", 116.6, 40.0, "minor"),
    // 同名不同地（ident 不唯一）：差 0.5°，不算。
    point("FAR", 110.5, 30.0, "vor"),
  );
  const tagOf = (out: FeatureCollection | null, ident: string) =>
    out?.features.find((f) => f.properties?.ident === ident)?.properties
      ?.navaid;

  test("ident 相同、位置在 0.01° 内才算，打上那个台的档", () => {
    const out = markNavaidFixes(fixes, navaids);
    expect(tagOf(out, "SJD")).toBe("vor");
    expect(tagOf(out, "VYK")).toBe("minor");
    expect(tagOf(out, "ABCDE")).toBe("");
    expect(tagOf(out, "FAR")).toBe("");
    expect(out?.features.length).toBe(4);
  });

  test("导航台图层关着时原样返回", () => {
    expect(markNavaidFixes(fixes, null)).toBe(fixes);
    expect(markNavaidFixes(null, navaids)).toBeNull();
  });

  test("不改输入", () => {
    markNavaidFixes(fixes, navaids);
    expect(tagOf(fixes, "SJD")).toBe("");
  });
});

/**
 * 航段两端各让 1 NM 给定位点：实线停在点外，让出来的那截单独一条虚线接进去。坐标是
 * 合成的。
 */
describe("航段在定位点前让出 1 NM", () => {
  const graph = (to: [number, number]): AirwayGraph => ({
    fixes: { AAAAA: [30, 120], BBBBB: to },
    airways: {},
    segments: [
      {
        airway: "W11",
        from: "AAAAA",
        to: "BBBBB",
        dir: "both",
        minAlt: null,
        maxAlt: null,
      },
    ],
  });
  // GeoJSON 是 [lon, lat]，distanceNm 要 [lat, lon]。
  const ll = (c: number[]): [number, number] => [c[1], c[0]];
  const coords = (f: { geometry: unknown }) =>
    (f.geometry as { coordinates: number[][] }).coordinates;

  test("一条实线加两截虚线，实线两端离点正好 1 NM，虚线接到点上", () => {
    const lines = toAirwayLines(graph([30.5, 120.4]));
    const parts = lines.features.map((f) => f.properties?.part);
    expect(parts).toEqual(["line", "stub", "stub"]);
    const [line, s1, s2] = lines.features;
    const [a, b] = coords(line).map(ll);
    expect(distanceNm([30, 120], a)).toBeCloseTo(1, 3);
    expect(distanceNm([30.5, 120.4], b)).toBeCloseTo(1, 3);
    // 虚线从实线端点接到定位点，不留缝也不重叠。
    expect(coords(s1)).toEqual([coords(line)[0], [120, 30]]);
    expect(coords(s2)).toEqual([coords(line)[1], [120.4, 30.5]]);
    // 让出的点在大圆上：三段长度加起来就是整段。
    const whole = distanceNm([30, 120], [30.5, 120.4]);
    expect(distanceNm(a, b) + 2).toBeCloseTo(whole, 3);
  });

  test("三段带同一组航段属性，高亮照样点得亮整段", () => {
    const lines = toAirwayLines(graph([30.5, 120.4]));
    for (const f of lines.features) {
      expect(f.properties?.airway).toBe("W11");
      expect(f.properties?.from).toBe("AAAAA");
      expect(f.properties?.to).toBe("BBBBB");
    }
    const marked = markRouteOnAirways(
      lines,
      new Set([legKey("W11", "BBBBB", "AAAAA")]),
    );
    expect(marked.size).toBe(1);
    expect(lines.features.every((f) => f.properties?.onRoute === 1)).toBe(true);
  });

  test("短航段按比例让：min(1, 0.4 × 长度)，2.5 NM 处接上", () => {
    expect(airwayGapNm(60)).toBe(AIRWAY_FIX_GAP_NM);
    expect(airwayGapNm(2.5)).toBeCloseTo(1, 9);
    expect(airwayGapNm(2)).toBeCloseTo(0.8, 9);
    expect(airwayGapNm(0)).toBe(0);
    // 一条 2 NM 的航段：两端各让 0.8，中间留 0.4 实线。
    const to = [30 + 2 / 60, 120] as [number, number];
    const [line] = toAirwayLines(graph(to)).features;
    const [a, b] = coords(line).map(ll);
    expect(distanceNm(a, b)).toBeCloseTo(0.4, 2);
  });

  test("两端重合的航段不切，也不出零长的虚线", () => {
    const lines = toAirwayLines(graph([30, 120]));
    expect(lines.features.map((f) => f.properties?.part)).toEqual(["line"]);
  });
});

/** 每段航段一条实线（part = "line"），两端的虚线另算。 */
const mainLines = (fc: ReturnType<typeof toAirwayLines>) =>
  fc.features.filter((f) => f.properties?.part === "line");

describe("图键和代号", () => {
  /**
   * can-db 的 Navigraph 数据里 `from` / `to` 是图键（`ident@region/kind`），代号在
   * `fromIdent` / `toIdent`。同一个航路代号加同一对点名在两个地区各有一段。
   */
  const graph: AirwayGraph = {
    fixes: {
      "AKAGI@RJ/waypoint": [36.5, 139.0],
      "BUNGO@RJ/waypoint": [37.5, 140.0],
      "AKAGI@RK/waypoint": [36.5, 128.0],
      "BUNGO@RK/waypoint": [37.5, 129.0],
      NAIPX: [30.0, 120.0],
    },
    airways: {},
    segments: [
      {
        airway: "A1",
        from: "AKAGI@RJ/waypoint",
        to: "BUNGO@RJ/waypoint",
        fromIdent: "AKAGI",
        toIdent: "BUNGO",
        dir: "both",
        minAlt: null,
        maxAlt: null,
      },
      {
        airway: "A1",
        from: "AKAGI@RK/waypoint",
        to: "BUNGO@RK/waypoint",
        fromIdent: "AKAGI",
        toIdent: "BUNGO",
        dir: "both",
        minAlt: null,
        maxAlt: null,
      },
      {
        // 旧版 can-db / 没匹配上的 NAIP 点：裸代号，没有 fromIdent。
        airway: "W1",
        from: "NAIPX",
        to: "AKAGI@RJ/waypoint",
        toIdent: "AKAGI",
        dir: "both",
        minAlt: null,
        maxAlt: null,
      },
    ],
  };

  test("航路点标注用代号，同名的两个点各是一个要素", () => {
    const pts = toAirwayFixes(graph);
    const akagi = pts.features.filter((f) => f.properties?.ident === "AKAGI");
    expect(akagi.length).toBe(2);
    expect(akagi.map((f) => f.properties?.key).sort()).toEqual([
      "AKAGI@RJ/waypoint",
      "AKAGI@RK/waypoint",
    ]);
    // 没有 fromIdent 时退回图键（那时图键就是代号）。
    expect(pts.features.some((f) => f.properties?.ident === "NAIPX")).toBe(
      true,
    );
    expect(pts.features.some((f) => f.properties?.ident?.includes("@"))).toBe(
      false,
    );
  });

  test("线要素带代号，图键留着认航段", () => {
    const lines = mainLines(toAirwayLines(graph));
    expect(lines.length).toBe(3);
    const first = lines[0].properties;
    expect(first?.from).toBe("AKAGI@RJ/waypoint");
    expect(first?.fromIdent).toBe("AKAGI");
    expect(lines[2].properties?.fromIdent).toBe("NAIPX");
  });

  test("计划按代号点亮，同名两段只亮离计划近的那一段", () => {
    const fc = toAirwayLines(graph);
    const marked = markRouteOnAirways(
      fc,
      routeLegs([
        { ident: "BUNGO", lat: 37.5, lon: 129.0 },
        { ident: "AKAGI", lat: 36.5, lon: 128.0, via: "A1" },
      ]),
    );
    expect(marked.has(legKey("A1", "AKAGI", "BUNGO"))).toBe(true);
    const on = mainLines(fc).map((f) => f.properties?.onRoute);
    expect(on).toEqual([0, 1, 0]);
  });

  test("不带位置时同名的都点亮", () => {
    const fc = toAirwayLines(graph);
    markRouteOnAirways(
      fc,
      routeLegKeys([{ ident: "AKAGI" }, { ident: "BUNGO", via: "A1" }]),
    );
    expect(mainLines(fc).map((f) => f.properties?.onRoute)).toEqual([1, 1, 0]);
  });

  test("旧版航段（没有 fromIdent）照样按代号点亮", () => {
    const fc = toAirwayLines(graph);
    const marked = markRouteOnAirways(
      fc,
      routeLegs([
        { ident: "NAIPX", lat: 30, lon: 120 },
        { ident: "AKAGI", lat: 36.5, lon: 139, via: "W1" },
      ]),
    );
    expect(marked.has(legKey("W1", "NAIPX", "AKAGI"))).toBe(true);
    expect(mainLines(fc)[2].properties?.onRoute).toBe(1);
  });

  test("跨 180° 的航段走短的那一边", () => {
    const lines = toAirwayLines({
      fixes: { "E@X/w": [50, 179], "W@X/w": [50, -179] },
      airways: {},
      segments: [
        {
          airway: "R1",
          from: "E@X/w",
          to: "W@X/w",
          dir: "both",
          minAlt: null,
          maxAlt: null,
        },
      ],
    });
    // 实线在点前让 1 NM；接到终点的那截虚线落在 181，不是 -179。
    const all = lines.features.flatMap((f) =>
      f.geometry.type === "LineString" ? f.geometry.coordinates : [],
    );
    expect(all.every(([lon]) => lon >= 179 && lon <= 181)).toBe(true);
    expect(all.some(([lon]) => lon === 181)).toBe(true);
  });

  test("按块取回来的图按图键去重", () => {
    const tagged = mergeAirwayLevels(graph, graph);
    const union = unionAirwayGraphs([tagged, tagged]);
    expect(union.segments.length).toBe(3);
  });
});

describe("航路网按视野分块", () => {
  test("普通视野", () => {
    const blocks = airwayBlocksFor(25, 115, 42, 128);
    // 纬度 20/30/40 × 经度 110/120。
    expect(blocks.length).toBe(3 * 2);
    expect(blocks).toContainEqual({ lat: 20, lon: 110 });
    expect(blocks).toContainEqual({ lat: 40, lon: 120 });
  });

  test("跨 180° 的视野拆成两侧的块", () => {
    const lons = new Set(airwayBlocksFor(40, 172, 45, 188).map((b) => b.lon));
    expect([...lons].sort((a, b) => a - b)).toEqual([-180, 170]);
  });

  test("整圈只数一遍，纬度不出界", () => {
    const blocks = airwayBlocksFor(-95, -400, 95, 400);
    expect(blocks.length).toBe(36 * 18);
    expect(Math.max(...blocks.map((b) => b.lat))).toBe(80);
    expect(Math.min(...blocks.map((b) => b.lat))).toBe(-90);
  });
});
