import { describe, expect, test } from "bun:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  buildCoverage,
  indexBoundaries,
  indexTracons,
  MAX_RANGE_NM,
  wantsAirportCoords,
  wantsTracons,
} from "./atcCoverage";
import { useAirportCodes } from "./airportCodes";
import type { DatafeedController } from "./datafeed";
import { useFirTable } from "./firTable";

/** 一个以 (lon, lat) 为左下角、边长 1° 的方块。 */
function square(
  props: Record<string, unknown>,
  lon: number,
  lat: number,
): Feature {
  return {
    type: "Feature",
    properties: props,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon, lat],
          [lon + 1, lat],
          [lon + 1, lat + 1],
          [lon, lat + 1],
          [lon, lat],
        ],
      ],
    },
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

useFirTable({
  version: "test",
  firs: [
    { prefix: "ZSHA", boundary: "ZSHA", name: "Shanghai" },
    { prefix: "ZGZU", boundary: "ZGZU", name: "Guangzhou" },
    { prefix: "RJTG", boundary: "RJTG", name: "Tokyo" },
    { prefix: "RJTG_T30", boundary: "RJTG-T30", name: "Tokyo T30" },
    { prefix: "KZNY", boundary: "KZNY", name: "New York" },
  ],
  uirs: [{ prefix: "PRC", name: "China", boundaries: ["ZSHA", "ZGZU"] }],
});

const boundaries = indexBoundaries(
  collection([
    square({ id: "ZSHA", oceanic: "0" }, 120, 30),
    square({ id: "ZGZU", oceanic: "0" }, 113, 22),
    square({ id: "RJTG", oceanic: "0" }, 139, 35),
    square({ id: "RJTG-T30", oceanic: "0" }, 140, 36),
    square({ id: "KZNY", oceanic: "0" }, -74, 40),
    square({ id: "KZNY", oceanic: "1" }, -60, 38),
  ]),
);

const tracons = indexTracons(
  collection([
    square({ id: "ZBAA", prefix: ["ZBAA"] }, 116, 39),
    square({ id: "ZBAA_S", prefix: ["ZBAA_S"] }, 116, 38),
  ]),
);

function station(
  callsign: string,
  facility: number,
  extra: Partial<DatafeedController> = {},
): DatafeedController {
  return {
    callsign,
    cid: "1",
    facility,
    frequency: "125.950",
    latitude: "31.2",
    longitude: "121.4",
    logon_time: "2026-09-26 00:00:00",
    name: "",
    rating: 5,
    text_atis: [],
    ...extra,
  };
}

const kinds = (fc: FeatureCollection) =>
  fc.features.map((f) => `${f.properties?.kind}:${f.properties?.callsign}`);

describe("buildCoverage — 区域", () => {
  test("呼号按前缀表对上边界", () => {
    const { areas, points } = buildCoverage(
      [station("ZSHA_CTR", 6)],
      boundaries,
      null,
    );
    expect(kinds(areas)).toEqual(["fir:ZSHA_CTR"]);
    expect(points).toEqual([]);
  });

  test("UIR 一对多：PRC_FSS 画两块", () => {
    const { areas } = buildCoverage([station("PRC_FSS", 1)], boundaries, null);
    expect(areas.features).toHaveLength(2);
  });

  test("最长前缀赢：RJTG_T30_CTR 只画 T30，不画整个东京", () => {
    const { areas } = buildCoverage(
      [station("RJTG_T30_CTR", 6)],
      boundaries,
      null,
    );
    expect(areas.features).toHaveLength(1);
    expect(areas.features[0].geometry).toEqual(
      boundaries.get("RJTG-T30")![0].geometry,
    );
  });

  test("Covering 行收窄到扇区", () => {
    const { areas } = buildCoverage(
      [station("RJTG_CTR", 6, { text_atis: ["Covering sector - T30"] })],
      boundaries,
      null,
    );
    expect(areas.features[0].geometry).toEqual(
      boundaries.get("RJTG-T30")![0].geometry,
    );
  });

  test("Extending 按同一个席位后缀加一块，并在那块标上扩出去的呼号", () => {
    const { areas, labels } = buildCoverage(
      [station("ZSHA_CTR", 6, { text_atis: ["Extending - ZGGG"] })],
      indexBoundaries(
        collection([
          square({ id: "ZSHA", oceanic: "0" }, 120, 30),
          square({ id: "ZGZU", oceanic: "0" }, 113, 22),
        ]),
      ),
      null,
    );
    // ZGGG_CTR 在表里没有前缀 → 扩不出去；换一个表里有的。
    expect(areas.features).toHaveLength(1);
    expect(labels.features.map((f) => f.properties?.label)).toEqual([
      "ZSHA_CTR 125.950",
    ]);

    const extended = buildCoverage(
      [station("ZSHA_CTR", 6, { text_atis: ["Extending - ZGZU"] })],
      boundaries,
      null,
    );
    expect(extended.areas.features).toHaveLength(2);
    expect(extended.labels.features.map((f) => f.properties?.label)).toEqual([
      "ZSHA_CTR 125.950",
      "ZGZU_CTR 125.950",
    ]);
  });

  test("扩出去的那个呼号本人在线时，不再替他标", () => {
    const { labels } = buildCoverage(
      [
        station("ZSHA_CTR", 6, { text_atis: ["Extending - ZGZU"] }),
        station("ZGZU_CTR", 6, { frequency: "124.100" }),
      ],
      boundaries,
      null,
    );
    expect(labels.features.map((f) => f.properties?.label)).toEqual([
      "ZSHA_CTR 125.950",
      "ZGZU_CTR 124.100",
    ]);
  });

  test("FSS 不扩", () => {
    const { areas } = buildCoverage(
      [station("ZSHA_FSS", 1, { text_atis: ["Extending - ZGZU"] })],
      boundaries,
      null,
    );
    expect(areas.features).toHaveLength(1);
  });

  test("一个 id 两块时：_FSS 取洋区，别的取陆上", () => {
    const land = buildCoverage([station("KZNY_CTR", 6)], boundaries, null);
    const ocean = buildCoverage([station("KZNY_FSS", 1)], boundaries, null);
    const [landShape, oceanShape] = boundaries.get("KZNY")!;
    expect(land.areas.features[0].geometry).toEqual(landShape.geometry);
    expect(ocean.areas.features[0].geometry).toEqual(oceanShape.geometry);
  });

  test("标注在第一块的外接框中心", () => {
    const { labels } = buildCoverage(
      [station("ZSHA_CTR", 6)],
      boundaries,
      null,
    );
    expect(labels.features[0].geometry).toEqual({
      type: "Point",
      coordinates: [120.5, 30.5],
    });
  });

  test("对不上边界的不吞掉，退回画点，也不画圈", () => {
    const { areas, points } = buildCoverage(
      [station("XXXX_CTR", 6, { visual_range: 300 })],
      boundaries,
      null,
    );
    expect(areas.features).toEqual([]);
    expect(points.map((c) => c.callsign)).toEqual(["XXXX_CTR"]);
  });

  test("边界还没取到时同样退回画点", () => {
    const { points } = buildCoverage([station("ZSHA_CTR", 6)], null, null);
    expect(points.map((c) => c.callsign)).toEqual(["ZSHA_CTR"]);
  });
});

describe("buildCoverage — 进近", () => {
  test("先找去掉席位后缀的整串，再找机场", () => {
    const south = buildCoverage([station("ZBAA_S_APP", 5)], null, tracons);
    expect(south.areas.features[0].geometry).toEqual(
      tracons.get("ZBAA_S")![0].geometry,
    );
    const whole = buildCoverage([station("ZBAA_APP", 5)], null, tracons);
    expect(whole.areas.features[0].geometry).toEqual(
      tracons.get("ZBAA")![0].geometry,
    );
    expect(kinds(whole.areas)).toEqual(["tracon:ZBAA_APP"]);
    expect(whole.points).toEqual([]);
  });

  test("标在最北的顶点（同纬度取先遇到的那个）", () => {
    const { labels } = buildCoverage([station("ZBAA_APP", 5)], null, tracons);
    expect(labels.features[0].geometry).toEqual({
      type: "Point",
      coordinates: [117, 40],
    });
  });

  test("没有进近多边形的进近：点加一个视野圈，封顶 400 海里", () => {
    const { areas, points } = buildCoverage(
      [station("ZSSS_APP", 5, { visual_range: 1500 })],
      null,
      tracons,
    );
    expect(points.map((c) => c.callsign)).toEqual(["ZSSS_APP"]);
    expect(kinds(areas)).toEqual(["ring:ZSSS_APP"]);
    // 圈上最北那一点离圆心 400 海里 ≈ 6.67°。
    const ring = (areas.features[0].geometry as { coordinates: number[][][] })
      .coordinates[0];
    const north = Math.max(...ring.map((p) => p[1]));
    expect(north - 31.2).toBeCloseTo(MAX_RANGE_NM / 60, 1);
  });

  test("视野为 0 或缺席时不画圈", () => {
    const { areas } = buildCoverage([station("ZSSS_APP", 5)], null, null);
    expect(areas.features).toEqual([]);
  });
});

describe("buildCoverage — 场面席位", () => {
  test("放行 / 地面 / 塔台画点，不画圈", () => {
    const { areas, points } = buildCoverage(
      [
        station("ZSSS_DEL", 2, { visual_range: 20 }),
        station("ZSSS_GND", 3, { visual_range: 20 }),
        station("ZSSS_TWR", 4, { visual_range: 50 }),
      ],
      boundaries,
      tracons,
    );
    expect(areas.features).toEqual([]);
    expect(points).toHaveLength(3);
  });
});

describe("wantsTracons", () => {
  test("有进近在线才取", () => {
    expect(wantsTracons([station("ZSHA_CTR", 6)])).toBe(false);
    expect(wantsTracons([station("ZBAA_APP", 5)])).toBe(true);
  });

  test("Covering 名字在情报区表里解不出来时也取", () => {
    expect(
      wantsTracons([
        station("ZBPE_CTR", 6, { text_atis: ["Covering sector - ZBAA"] }),
      ]),
    ).toBe(true);
    expect(
      wantsTracons([
        station("RJTG_CTR", 6, { text_atis: ["Covering sector - T30"] }),
      ]),
    ).toBe(false);
  });
});

describe("buildCoverage — 场面席位的 Extending", () => {
  const coords: Record<string, [number, number]> = {
    ZSSS: [31.198, 121.336],
    ZSPD: [31.143, 121.805],
    KMEM: [35.042, -89.977],
  };
  const airportAt = (icao: string) => coords[icao] ?? null;
  const extendedOf = (list: DatafeedController[]) =>
    buildCoverage(list, boundaries, null, airportAt).extended.features.map(
      (f) => [f.properties?.callsign, f.geometry],
    );

  test("塔台扩到别的场：在那个场再标一个同席位呼号", () => {
    expect(
      extendedOf([station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] })]),
    ).toEqual([
      ["ZSSS_TWR", { type: "Point", coordinates: [121.336, 31.198] }],
    ]);
  });

  test("原席位照旧画点", () => {
    const { points } = buildCoverage(
      [station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] })],
      boundaries,
      null,
      airportAt,
    );
    expect(points.map((c) => c.callsign)).toEqual(["ZSPD_TWR"]);
  });

  test("那个场已经有人登着同一个席位，不标", () => {
    expect(
      extendedOf([
        station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] }),
        station("ZSSS_TWR", 4),
      ]),
    ).toEqual([]);
  });

  test("另一个席位在线不算：ZSSS_GND 挡不住 ZSSS_TWR", () => {
    expect(
      extendedOf([
        station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] }),
        station("ZSSS_GND", 3),
      ]).map(([callsign]) => callsign),
    ).toEqual(["ZSSS_TWR"]);
  });

  test("自己那一场、重复的、查不到坐标的都跳过", () => {
    expect(
      extendedOf([
        station("ZSPD_TWR", 4, {
          text_atis: ["Extending - ZSPD, ZSSS ZSSS", "Extending - ZXXX"],
        }),
      ]).map(([callsign]) => callsign),
    ).toEqual(["ZSSS_TWR"]);
  });

  test("三字码按机场表落到 ICAO，标牌写 ICAO（和 can-radar 一样）", () => {
    useAirportCodes({ version: "test", real: { MEM: "KMEM" }, pseudo: {} });
    try {
      expect(
        extendedOf([
          station("ZSPD_TWR", 4, { text_atis: ["Extending - MEM"] }),
        ]).map(([callsign]) => callsign),
      ).toEqual(["KMEM_TWR"]);
    } finally {
      useAirportCodes(null);
    }
  });

  test("按呼号后缀认：facility 标错的 _TWR 也扩", () => {
    expect(
      extendedOf([
        station("ZSPD_TWR", 5, { text_atis: ["Extending - ZSSS"] }),
      ]).map(([callsign]) => callsign),
    ).toEqual(["ZSSS_TWR"]);
  });

  test("区域不走这一条：它的 Extending 画边界", () => {
    expect(
      extendedOf([station("ZSHA_CTR", 6, { text_atis: ["Extending - ZSSS"] })]),
    ).toEqual([]);
  });

  test("进近也标：没有多边形时原席位照旧画点", () => {
    const { points, extended } = buildCoverage(
      [station("ZSPD_APP", 5, { text_atis: ["Extending - ZSSS"] })],
      boundaries,
      null,
      airportAt,
    );
    expect(points.map((c) => c.callsign)).toEqual(["ZSPD_APP"]);
    expect(
      extended.features.map((f) => [f.properties?.callsign, f.geometry]),
    ).toEqual([
      ["ZSSS_APP", { type: "Point", coordinates: [121.336, 31.198] }],
    ]);
  });

  test("进近扩到有多边形的场：多边形、机场上的标牌都有", () => {
    const { areas, extended } = buildCoverage(
      [station("ZSPD_APP", 5, { text_atis: ["Extending - ZBAA"] })],
      boundaries,
      tracons,
      () => [40.08, 116.58],
    );
    expect(kinds(areas)).toEqual(["tracon:ZSPD_APP"]);
    expect(extended.features.map((f) => f.properties?.callsign)).toEqual([
      "ZBAA_APP",
    ]);
  });

  test("进近不认三字码的备用写法：SCT 不落到 KLAX", () => {
    useAirportCodes({ version: "test", real: {}, pseudo: { SCT: "KLAX" } });
    try {
      const fields = (callsign: string, facility: number) =>
        buildCoverage(
          [station(callsign, facility, { text_atis: ["Extending - SCT"] })],
          null,
          null,
          (icao) => (icao === "KLAX" || icao === "SCT" ? [33.9, -118.4] : null),
        ).extended.features.map((f) => f.properties?.callsign);
      expect(fields("ZSPD_APP", 5)).toEqual(["SCT_APP"]);
      expect(fields("ZSPD_TWR", 4)).toEqual(["KLAX_TWR"]);
    } finally {
      useAirportCodes(null);
    }
  });

  test("那个场已经有同席位进近在线，不标", () => {
    expect(
      extendedOf([
        station("ZSPD_APP", 5, { text_atis: ["Extending - ZSSS"] }),
        station("ZSSS_APP", 5),
      ]),
    ).toEqual([]);
  });

  test("扩到有进近多边形的场：多边形画，塔台的点和标牌留在机场", () => {
    const { areas, labels, points, extended } = buildCoverage(
      [station("ZSPD_TWR", 4, { text_atis: ["Extending - ZBAA"] })],
      boundaries,
      tracons,
      () => [40.08, 116.58],
    );
    expect(kinds(areas)).toEqual(["tracon:ZSPD_TWR"]);
    expect(labels.features).toEqual([]);
    expect(points.map((c) => c.callsign)).toEqual(["ZSPD_TWR"]);
    expect(extended.features.map((f) => f.properties?.callsign)).toEqual([
      "ZBAA_TWR",
    ]);
  });

  test("区域 / FSS 以外的席位写了 Extending 才取机场表", () => {
    expect(wantsAirportCoords([station("ZSPD_TWR", 4)])).toBe(false);
    expect(
      wantsAirportCoords([
        station("ZSHA_CTR", 6, { text_atis: ["Extending - ZGZU"] }),
      ]),
    ).toBe(false);
    expect(
      wantsAirportCoords([
        station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] }),
      ]),
    ).toBe(true);
    expect(
      wantsAirportCoords([
        station("ZSPD_APP", 5, { text_atis: ["Extending - ZSSS"] }),
      ]),
    ).toBe(true);
  });
});

describe("buildCoverage — ATIS", () => {
  const coords: Record<string, [number, number]> = {
    ZSSS: [31.198, 121.336],
  };
  const airportAt = (icao: string) => coords[icao] ?? null;

  test("画成点，facility 一律记成 7，不画范围也不画圈", () => {
    const { areas, points } = buildCoverage(
      [],
      boundaries,
      tracons,
      airportAt,
      [station("ZBAA_ATIS", 4, { visual_range: 50 })],
    );
    expect(areas.features).toEqual([]);
    expect(points.map((c) => [c.callsign, c.facility])).toEqual([
      ["ZBAA_ATIS", 7],
    ]);
  });

  test("Extending 在那个场再标一个 ATIS", () => {
    const { extended } = buildCoverage([], null, null, airportAt, [
      station("ZSPD_ATIS", 7, { text_atis: ["Extending - ZSSS"] }),
    ]);
    expect(
      extended.features.map((f) => [
        f.properties?.callsign,
        f.properties?.facility,
      ]),
    ).toEqual([["ZSSS_ATIS", 7]]);
  });

  test("那个场自己的 ATIS 在线时不标", () => {
    const { extended } = buildCoverage([], null, null, airportAt, [
      station("ZSPD_ATIS", 7, { text_atis: ["Extending - ZSSS"] }),
      station("ZSSS_ATIS", 7),
    ]);
    expect(extended.features).toEqual([]);
  });

  test("塔台扩到的场有同后缀的席位才挡：ATIS 挡不住塔台", () => {
    const { extended } = buildCoverage(
      [station("ZSPD_TWR", 4, { text_atis: ["Extending - ZSSS"] })],
      null,
      null,
      airportAt,
      [station("ZSSS_ATIS", 7)],
    );
    expect(extended.features.map((f) => f.properties?.callsign)).toEqual([
      "ZSSS_TWR",
    ]);
  });

  test("ATIS 写了 Extending 也要取机场表", () => {
    expect(
      wantsAirportCoords(
        [],
        [station("ZSPD_ATIS", 7, { text_atis: ["Extending - ZSSS"] })],
      ),
    ).toBe(true);
    expect(wantsAirportCoords([], [station("ZSPD_ATIS", 7)])).toBe(false);
  });
});
