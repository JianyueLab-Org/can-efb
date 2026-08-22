import { expect, test, describe } from "bun:test";

import { toGroundDrawing, type Ground } from "@/lib/ground";
import { airportsInView, type AirportPin } from "@/lib/airports";

function ground(over: Partial<Ground>): Ground {
  return {
    icao: "ZBAA",
    features: [],
    lines: [],
    accuracyM: 0,
    runways: 0,
    ...over,
  };
}

describe("画哪一份", () => {
  /**
   * 有分好类的要素就不画航图线画。
   *
   * 两份并排画看着"信息更多"，实际是把同一条滑行道画两遍、位置差十几米，而读图的
   * 人无法判断该信哪条。can-db 在合并 `ground_feature` 的两个来源时拒绝过同一件
   * 事，画在图上是同一个道理。
   */
  test("有 features 时 lines 一条都不画", () => {
    const d = toGroundDrawing([
      ground({
        features: [
          {
            kind: "taxiway",
            source: "sector",
            points: [
              [40, 116],
              [40.1, 116.1],
            ],
          },
        ],
        lines: [
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [40, 116],
              [40.1, 116.1],
            ],
          },
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [41, 117],
              [41.1, 117.1],
            ],
          },
        ],
        accuracyM: 20,
      }),
    ]);

    expect(d.kind).toBe("features");
    expect(d.collection.features).toHaveLength(1);
    // 精度只在画 lines 时才说 —— features 是米级的，标一句「约 20 米」是误导。
    expect(d.worstAccuracyM).toBe(0);
  });

  test("没有 features 时退到 lines，并带出精度", () => {
    const d = toGroundDrawing([
      ground({
        lines: [
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [40, 116],
              [40.1, 116.1],
            ],
          },
        ],
        accuracyM: 20,
      }),
    ]);

    expect(d.kind).toBe("lines");
    expect(d.collection.features).toHaveLength(1);
    expect(d.worstAccuracyM).toBe(20);
  });

  /** 逐个机场决定，不是整批二选一 —— 视野里两个场可以各画各的那一份。 */
  test("一个场有要素、另一个只有线画时，两个都画得出来", () => {
    const d = toGroundDrawing([
      ground({
        icao: "ZBAA",
        features: [
          {
            kind: "runway",
            source: "sector",
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
      }),
      ground({
        icao: "ZBAD",
        lines: [
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [39, 116],
              [39.1, 116],
            ],
          },
        ],
        accuracyM: 20,
      }),
    ]);

    expect(d.icaos).toEqual(["ZBAA", "ZBAD"]);
    expect(d.collection.features).toHaveLength(2);
  });
});

describe("代号", () => {
  const nameOf = (kind: string, name?: string) => {
    const d = toGroundDrawing([
      ground({
        features: [
          {
            kind,
            source: "sector",
            name,
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
      }),
    ]);
    return d.collection.features[0].properties?.name;
  };

  /** 有代号就带出去 —— 标注层靠这个字段渲染跑道号、滑行道代号和机位号。 */
  test("代号原样带到要素属性上", () => {
    expect(nameOf("taxiway", "W9")).toBe("W9");
    expect(nameOf("runway", "18L/36R")).toBe("18L/36R");
    expect(nameOf("parking_position", "N103")).toBe("N103");
  });

  /**
   * 没代号的要素给空串，**不是省略**。
   *
   * 标注层的过滤是 `has(name)` 加 `name != ""`：两条都要。库里多数要素本来就没有
   * 代号（滑行道 26421 条里 6927 条有），空串让它们被第二条挡掉；而航图线画那一份
   * 一个 `name` 字段都没有，被第一条整份挡掉 —— 少了 `has` 那一条，`get("name")`
   * 对它求值是 null，而 `!= ""` 对 null 成立，满图会是空标签占着避让位。
   */
  test("没代号的给空串", () => {
    expect(nameOf("taxiway")).toBe("");
  });

  test("航图线画根本没有 name 这个字段", () => {
    const d = toGroundDrawing([
      ground({
        lines: [
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
        accuracyM: 20,
      }),
    ]);
    expect(d.collection.features[0].properties).not.toHaveProperty("name");
  });
});

describe("线宽", () => {
  const widthOf = (kind: string, widthM?: number) => {
    const d = toGroundDrawing([
      ground({
        features: [
          {
            kind,
            source: "sector",
            widthM,
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
      }),
    ]);
    return d.collection.features[0].properties?.widthM as number;
  };

  /**
   * 缺席的宽度**不能当成 0**。
   *
   * 线宽是按真实米数换算成像素画的，0 米出来就是一条画不出来的线 —— 而手工那份里
   * 多数机位和等待位置本来就没有宽度。这一条踩过：地面「没有显示」的真实原因就是
   * 线细到看不见，不报错、不缺数据。
   */
  test("没有宽度的要素按类别兜底，不落到 0", () => {
    expect(widthOf("taxiway")).toBeGreaterThan(0);
    expect(widthOf("parking_position")).toBeGreaterThan(0);
    expect(widthOf("holding_position")).toBeGreaterThan(0);
    expect(widthOf("something_new_from_the_source")).toBeGreaterThan(0);
  });

  test("跑道比滑行道宽", () => {
    expect(widthOf("runway")).toBeGreaterThan(widthOf("taxiway"));
  });

  /** 真实宽度只要有就一定优先 —— 兜底只是缺席时的排版数字，不是航行数据。 */
  test("源数据给了宽度就用它", () => {
    expect(widthOf("taxiway", 42)).toBe(42);
    // 0 是「没有」而不是「零米宽」，所以仍然走兜底。
    expect(widthOf("taxiway", 0)).toBeGreaterThan(0);
  });
});

describe("署名", () => {
  /**
   * OSM 那份是 ODbL，**署名是许可条款不是礼貌**。它由数据决定 —— 写死一句会让纯
   * 扇区包的机场挂一个错误的出处，不写则是违反许可。
   */
  test("用了 OSM 的机场把署名带出来", () => {
    const d = toGroundDrawing([
      ground({
        features: [
          {
            kind: "taxiway",
            source: "osm",
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
        attribution: "© OpenStreetMap contributors",
      }),
    ]);
    expect(d.attributions).toEqual(["© OpenStreetMap contributors"]);
  });

  test("两个机场同一句署名只出现一次", () => {
    const d = toGroundDrawing([
      ground({
        icao: "ZBAA",
        features: [
          {
            kind: "taxiway",
            source: "osm",
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
        attribution: "© OpenStreetMap contributors",
      }),
      ground({
        icao: "ZBAD",
        features: [
          {
            kind: "taxiway",
            source: "osm",
            points: [
              [39, 116],
              [39.1, 116],
            ],
          },
        ],
        attribution: "© OpenStreetMap contributors",
      }),
    ]);
    expect(d.attributions).toHaveLength(1);
  });

  /** 汇编那份的规矩正好相反：**来源不能外露**，所以画 lines 时一个字都不提。 */
  test("画航图线画时不带任何署名", () => {
    const d = toGroundDrawing([
      ground({
        lines: [
          {
            rgb: "#4d4d4d",
            widthM: 2,
            points: [
              [40, 116],
              [40.1, 116],
            ],
          },
        ],
        accuracyM: 20,
      }),
    ]);
    expect(d.attributions).toEqual([]);
  });
});

describe("几何", () => {
  /**
   * 单点要素是真实存在的，不是退化的线：扇区包那份里有 733 个等待位置本来就只有
   * 一个点。按两点起收会把它们整批丢掉，而等待位置恰恰是地面上最该看见的之一。
   */
  test("一个点的要素出 Point 而不是被丢掉", () => {
    const d = toGroundDrawing([
      ground({
        features: [
          { kind: "holding_position", source: "sector", points: [[40, 116]] },
        ],
      }),
    ]);
    expect(d.collection.features).toHaveLength(1);
    expect(d.collection.features[0].geometry.type).toBe("Point");
  });

  /** GeoJSON 是 [经, 纬]，反了不报错，只会把机场画到地球另一边。 */
  test("坐标顺序翻成 [经, 纬]", () => {
    const d = toGroundDrawing([
      ground({
        features: [
          {
            kind: "runway",
            source: "sector",
            points: [
              [40, 116],
              [41, 117],
            ],
          },
        ],
      }),
    ]);
    const geom = d.collection.features[0].geometry;
    expect(geom.type).toBe("LineString");
    expect((geom as { coordinates: number[][] }).coordinates[0]).toEqual([
      116, 40,
    ]);
  });

  test("空点串的要素跳过，不产生坏几何", () => {
    const d = toGroundDrawing([
      ground({ features: [{ kind: "taxiway", source: "sector", points: [] }] }),
    ]);
    expect(d.collection.features).toHaveLength(0);
  });
});

describe("视野里的机场", () => {
  const pins: AirportPin[] = [
    { icao: "ZBAA", name: "首都", lat: 40.08, lon: 116.58 },
    { icao: "ZBAD", name: "大兴", lat: 39.51, lon: 116.41 },
    { icao: "ZBTJ", name: "滨海", lat: 39.12, lon: 117.34 },
    { icao: "ZSPD", name: "浦东", lat: 31.14, lon: 121.8 },
  ];
  const view = { south: 39.0, west: 116.0, north: 40.5, east: 117.5 };

  test("框外的场不算数", () => {
    const got = airportsInView(pins, view).map((p) => p.icao);
    expect(got).not.toContain("ZSPD");
    expect(got).toHaveLength(3);
  });

  /**
   * 排序是给取数配额用的：视野里四个场而只取三个时，该放弃的是最边上那个，不是
   * 碰巧排在数组后面那个。
   */
  test("按离视野中心由近及远排", () => {
    const got = airportsInView(pins, view).map((p) => p.icao);
    /* 中心是 (39.75, 116.75)。按经纬度平方算：首都 0.138、大兴 0.173、滨海
       0.745 —— 所以首都最近，滨海最远。（这几个数是照着代码里那个判据算的，写
       测试时先按直觉写成"大兴最近"，跑出来才发现直觉错了。） */
    expect(got).toEqual(["ZBAA", "ZBAD", "ZBTJ"]);
  });
});
