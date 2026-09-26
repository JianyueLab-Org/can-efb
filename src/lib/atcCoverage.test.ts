import { describe, expect, test } from "bun:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  buildCoverage,
  indexBoundaries,
  indexTracons,
  MAX_RANGE_NM,
  wantsTracons,
} from "./atcCoverage";
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
