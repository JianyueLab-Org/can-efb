import { expect, test, describe } from "bun:test";

import {
  airportRunwaySummary,
  toRunwayFeatures,
  type NetworkRunway,
} from "@/lib/runways";

// 一条南北向跑道的两头，形状和 can-db 的 /aip/runways 一致：**按端给**，
// 每一行带着自己那一头的入口，外加对端。
const ZAAA: NetworkRunway[] = [
  {
    icao: "ZAAA",
    ident: "18",
    lat: 40.1,
    lon: 116,
    endLat: 40.0,
    endLon: 116,
    hdg: 180,
  },
  {
    icao: "ZAAA",
    ident: "36",
    lat: 40.0,
    lon: 116,
    endLat: 40.1,
    endLon: 116,
    hdg: 360,
  },
];

const ends = (fc: ReturnType<typeof toRunwayFeatures>) =>
  fc.features.filter((f) => f.properties?.kind === "runway_end");

describe("跑道", () => {
  /**
   * **跑道号标在它自己那一头，而那个位置来自权威数据。**
   *
   * 这是这一层存在的理由。从前是拿地面要素的名字（`18L/36R`）加几何推的 —— 取相距
   * 最远的两个顶点、按方位角分配 —— 而那套推算有它自己的一类错：同一条跑道在源数据
   * 里可能是好几个同名要素，每个都被标了两头。
   *
   * 标错头在图上看不出来（两个号都在跑道上，只是调了个个），而照着它对跑道的人会滑
   * 到错误的一端。
   */
  test("跑道号落在自己那一头的入口上", () => {
    const e = ends(toRunwayFeatures(ZAAA));
    const at = (ident: string) =>
      (
        e.find((f) => f.properties?.ident === ident)?.geometry as {
          coordinates: number[];
        }
      ).coordinates;
    expect(at("18")[1]).toBeCloseTo(40.1, 4); // 北头
    expect(at("36")[1]).toBeCloseTo(40.0, 4); // 南头
  });

  /** 一行就够画出整条跑道：入口到对端。 */
  test("一行画出整条跑道", () => {
    const line = toRunwayFeatures([ZAAA[0]]).features.find(
      (f) => f.properties?.kind === "runway",
    );
    const coords = (line?.geometry as { coordinates: number[][] }).coordinates;
    expect(coords).toHaveLength(2);
    expect(coords[0][1]).toBeCloseTo(40.1, 4);
    expect(coords[1][1]).toBeCloseTo(40.0, 4);
  });

  /**
   * 同一条跑道的线**画两遍**（两端各一行），这是有意的。
   *
   * 去重要按「哪两行是一对」判断，而 `opposite` 未必总是填的；两条完全重合的线在图
   * 上和一条没有区别，代价只是 966 条而不是 483 条 —— 远小于一次判断错。
   */
  test("两端各出一条线，重合但不去重", () => {
    const fc = toRunwayFeatures(ZAAA);
    expect(
      fc.features.filter((f) => f.properties?.kind === "runway"),
    ).toHaveLength(2);
    expect(ends(fc)).toHaveLength(2);
  });

  test("空输入不炸", () => {
    expect(toRunwayFeatures([]).features).toEqual([]);
  });
});

describe("主要机场按最长跑道判", () => {
  // ZAAA 那条南北向跑道长 0.1° 纬度，约 11.1 公里。另配一个短跑道机场。
  const short: NetworkRunway = {
    icao: "ZBBB",
    ident: "09",
    lat: 30,
    lon: 120,
    endLat: 30,
    endLon: 120.02,
    hdg: 90,
  };

  test("门槛以上是主要机场，以下不是", () => {
    const m = airportRunwaySummary([...ZAAA, short], 2500);
    expect(m.get("ZAAA")?.major).toBe(true);
    // 0.02° 经度在北纬 30° 约 1.9 公里。
    expect(m.get("ZBBB")?.major).toBe(false);
    expect(m.get("ZBBB")?.lengthM).toBeGreaterThan(1800);
    expect(m.get("ZBBB")?.lengthM).toBeLessThan(2000);
  });

  test("门槛是参数，不是写死的", () => {
    expect(airportRunwaySummary([short], 1500).get("ZBBB")?.major).toBe(true);
  });

  /** 跑道杠两头一样，方位折进 0–180°；按坐标算真方位，不用磁航向 `hdg`。 */
  test("方位取最长那条，按坐标算", () => {
    expect(airportRunwaySummary(ZAAA, 2500).get("ZAAA")?.bearing).toBeCloseTo(
      0,
      0,
    );
    expect(
      airportRunwaySummary([short], 2500).get("ZBBB")?.bearing,
    ).toBeCloseTo(90, 0);
  });
});
