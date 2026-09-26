/**
 * `lib/chartStyle.ts` 的测试。钉的是**错了屏幕不会说**的那几件：整层不画（表达式
 * 非法）、切主题漏掉一层（两套结构不一致）、符号引用了没注册的图（那一层只剩字）、
 * 某一级缩放上该出现的要素被过滤掉。
 */
import { expect, test, describe } from "bun:test";
import {
  featureFilter,
  validateStyleMin,
} from "@maplibre/maplibre-gl-style-spec";
import {
  allImageIds,
  buildStyle,
  COLORS,
  graticule,
  gridLabel,
  ICON,
  ramp,
  rampCase,
  themedProperties,
  WIDTH,
  ZOOM,
  type ChartLayer,
  type Theme,
} from "@/lib/chartStyle";
import {
  HOLD_ARROW,
  holdArrowImage,
  registeredImageIds,
} from "@/lib/chartIcons";

/** 计划点亮的航段键（`onRouteOf`）：`ON` 在计划上，`OFF` 不在。 */
const ON = "W1|AAAAA|BBBBB";
const OFF = "W9|BBBBB|CCCCC";

const layersOf = (theme: Theme, legs: readonly string[] = [ON]) =>
  (buildStyle(theme, legs) as unknown as { layers: ChartLayer[] }).layers;

const layer = (id: string, theme: Theme = "light") => {
  const found = layersOf(theme).find((l) => l.id === id);
  if (!found) throw new Error(`没有图层 ${id}`);
  return found;
};

/** 用 MapLibre 自己的过滤器求值：这个要素在这一级缩放上画不画。`type`：1 点、2 线、3 面。 */
function shows(
  id: string,
  zoom: number,
  properties: Record<string, unknown>,
  type: 1 | 2 | 3 = 1,
) {
  const l = layer(id);
  if (l.minzoom !== undefined && zoom < l.minzoom) return false;
  if (l.maxzoom !== undefined && zoom >= l.maxzoom) return false;
  const f = featureFilter(l.filter as never, `layers[${id}].filter`);
  return f.filter({ zoom } as never, { type, properties } as never);
}

describe("样式合法", () => {
  test.each(["light", "dark"] as const)("%s 过 MapLibre 校验", (theme) => {
    expect(validateStyleMin(buildStyle(theme)).map((e) => e.message)).toEqual(
      [],
    );
  });

  test("rampCase 两组锚点缩放不一致时直接报错", () => {
    expect(() =>
      rampCase(true, [[6, 1]], [[7, 1]] as unknown as [number, number][]),
    ).toThrow();
  });
});

describe("主题切换覆盖每一个属性", () => {
  /**
   * `RouteMap` 切主题时按 `themedProperties` 逐个设。两套主题的图层和属性名必须一
   * 模一样，否则某一层切过去之后留着上一套的值。
   */
  test("两套主题的图层顺序和属性名一致", () => {
    const shape = (t: Theme) =>
      themedProperties(t).map((p) => `${p.layer}.${p.kind}.${p.name}`);
    expect(shape("dark")).toEqual(shape("light"));
    expect(layersOf("dark").map((l) => l.id)).toEqual(
      layersOf("light").map((l) => l.id),
    );
  });

  test("计划高亮只改 filter 和 paint：换一组航段，图层和属性名不变", () => {
    const shape = (legs: string[]) =>
      themedProperties("light", legs).map(
        (p) => `${p.layer}.${p.kind}.${p.name}`,
      );
    expect(shape([ON])).toEqual(shape([]));
    const airways = (legs: string[]) =>
      themedProperties("light", legs).find(
        (p) => p.layer === "airways" && p.kind === "filter",
      )?.value;
    expect(airways([ON])).not.toEqual(airways([]));
  });

  test.each(["light", "dark"] as const)(
    "%s 带计划航段时过 MapLibre 校验",
    (theme) => {
      expect(
        validateStyleMin(buildStyle(theme, [ON, OFF])).map((e) => e.message),
      ).toEqual([]);
    },
  );

  test("底图颜色确实随主题变", () => {
    const bg = (t: Theme) => layer("ocean", t).paint?.["background-color"];
    expect(bg("dark")).not.toBe(bg("light"));
  });
});

describe("图片", () => {
  /** 样式里 `icon-image` / `fill-pattern` 引用到的图片名。 */
  function referenced(theme: Theme): Set<string> {
    const out = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string" && /-(light|dark)$|^aircraft$/.test(v)) {
        out.add(v);
      } else if (Array.isArray(v)) v.forEach(walk);
    };
    for (const l of layersOf(theme)) {
      walk(l.layout?.["icon-image"]);
      walk(l.paint?.["fill-pattern"]);
    }
    return out;
  }

  test.each(["light", "dark"] as const)(
    "%s 引用的图都有人注册，而且只引用本主题那份",
    (theme) => {
      const all = new Set(allImageIds());
      const other = theme === "light" ? "-dark" : "-light";
      for (const id of referenced(theme)) {
        expect(all.has(id)).toBe(true);
        expect(id.endsWith(other)).toBe(false);
      }
    },
  );

  test("chartIcons 注册的正好是 allImageIds", () => {
    expect([...registeredImageIds()].sort()).toEqual([...allImageIds()].sort());
  });
});

describe("图层顺序", () => {
  /** 自下而上：底图 → 地面 → 空域填充 → 边界 → 航路 → 计划 → 符号 → 标注 → 机组 → 自己。 */
  test("分组的先后", () => {
    const ids = layersOf("light").map((l) => l.id);
    const order = [
      "ocean",
      "grid",
      "ground-shoulders",
      "ground-terminals",
      "ground-taxiways",
      "runways",
      "ground-runway-markings",
      "atc-area-fill",
      "airspace-hatch",
      "fir-line",
      "airspace-line",
      "atc-area-line",
      "atc-range-line",
      "airways-low",
      "airway-stubs",
      "airways",
      "route-casing",
      "route",
      "route-missed",
      "hold-arrows",
      "waypoint-symbols",
      "navaid-symbols",
      "airport-symbols",
      "markers",
      "grid-labels",
      "mora-labels",
      "waypoint-labels",
      "airway-labels",
      "navaid-labels",
      "airport-labels",
      "hold-courses",
      "route-labels",
      "traffic",
      "own-track",
      "own",
    ];
    const at = order.map((id) => ids.indexOf(id));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  /** 除了自己那架和计划航线的点名，任何标注都不许压着别的标注画。 */
  test("只有 own 和 route-labels 不参与避让", () => {
    const loose = layersOf("light")
      .filter(
        (l) =>
          l.layout?.["text-allow-overlap"] === true ||
          l.layout?.["text-ignore-placement"] === true,
      )
      .map((l) => l.id)
      .sort();
    expect(loose).toEqual(["own", "route-labels"]);
  });

  test("航路代号每段一个，放在段中间，套在随字拉伸的牌子里", () => {
    const l = layer("airway-labels").layout;
    expect(l?.["symbol-placement"]).toBe("line-center");
    expect(l?.["icon-text-fit"]).toBe("both");
    expect(JSON.stringify(l?.["icon-image"])).toContain("shield-rnav-light");
    expect(JSON.stringify(l?.["icon-image"])).toContain("shield-conv-light");
  });
});

describe("地面", () => {
  const z = ZOOM.ground;

  test("道肩按面填，和机坪同色", () => {
    const shoulder = { kind: "shoulder", name: "" };
    expect(shows("ground-shoulders", z + 1, shoulder, 3)).toBe(true);
    expect(shows("ground-shoulders", z + 1, shoulder, 2)).toBe(false);
    expect(shows("ground-terminals", z + 1, shoulder, 3)).toBe(false);
    expect(layer("ground-shoulders").paint?.["fill-color"]).toBe("#d3d9dd");
  });

  test("跑道标志白色，和机位号同一级才出", () => {
    const marking = { kind: "runway_marking", name: "" };
    expect(shows("ground-runway-markings", z + 3, marking, 3)).toBe(false);
    expect(shows("ground-runway-markings", z + 4, marking, 3)).toBe(true);
    expect(layer("ground-runway-markings").minzoom).toBe(
      layer("ground-labels-spot").minzoom,
    );
    expect(layer("ground-runway-markings").paint?.["fill-color"]).toBe(
      "#ffffff",
    );
  });

  test("滑行道代号点按点放字，不画圆点", () => {
    const label = { kind: "taxiway_label", name: "A3" };
    expect(shows("ground-labels-way-point", z + 2, label, 1)).toBe(true);
    expect(
      shows("ground-labels-way-point", z + 2, { ...label, name: "" }, 1),
    ).toBe(false);
    expect(shows("ground-points", z + 2, label, 1)).toBe(false);
    expect(
      layer("ground-labels-way-point").layout?.["symbol-placement"],
    ).toBeUndefined();
    const text = (id: string) => {
      const l = layer(id);
      return [
        l.layout?.["text-size"],
        l.layout?.["text-font"],
        l.layout?.["text-letter-spacing"],
        l.paint?.["text-color"],
      ];
    };
    expect(text("ground-labels-way-point")).toEqual(text("ground-labels-way"));
  });
});

describe("按缩放挑要素", () => {
  test("主要机场先出现，其余晚一档；跑道线出来后跑道杠让位", () => {
    const major = { major: 1, hasRwy: 1 };
    const minor = { major: 0, hasRwy: 1 };
    const bare = { major: 0, hasRwy: 0 };
    expect(shows("airport-symbols", ZOOM.airportMajor, major)).toBe(true);
    expect(shows("airport-symbols", ZOOM.airportMajor, minor)).toBe(false);
    expect(shows("airport-symbols", ZOOM.airportAll, minor)).toBe(true);
    expect(shows("airport-symbols", ZOOM.runwayLines, major)).toBe(false);
    // 没有跑道数据的机场没有跑道线可以接替，圆圈一直画。
    expect(shows("airport-symbols", ZOOM.runwayLines + 3, bare)).toBe(true);
  });

  test("低空航段放大才画，但计划走过的在高空那层里一直在", () => {
    const low = { level: "low", leg: OFF };
    const lowOnRoute = { level: "low", leg: ON };
    const both = { level: "both", leg: OFF };
    const high = { level: "high", leg: OFF };
    expect(shows("airways", ZOOM.airwaysHigh, high)).toBe(true);
    expect(shows("airways", ZOOM.airwaysHigh, both)).toBe(true);
    // 同一段不在两层里各画一遍。
    expect(shows("airways-low", ZOOM.airwaysLow, both)).toBe(false);
    expect(shows("airways", ZOOM.airwaysHigh, low)).toBe(false);
    expect(shows("airways-low", ZOOM.airwaysLow - 0.1, low)).toBe(false);
    expect(shows("airways-low", ZOOM.airwaysLow, low)).toBe(true);
    expect(shows("airways", ZOOM.airwaysHigh, lowOnRoute)).toBe(true);
    // 同一段不在两层里各画一遍。
    expect(shows("airways-low", ZOOM.airwaysLow, lowOnRoute)).toBe(false);
  });

  test("航段两端那 1 NM 画虚线，计划走过的收回实线，代号牌不放在虚线上", () => {
    const stub = { level: "high", leg: OFF, part: "stub" };
    const stubOnRoute = { level: "high", leg: ON, part: "stub" };
    const lowStub = { level: "low", leg: OFF, part: "stub" };
    const line = { level: "high", leg: OFF, part: "line", rnav: 0 };
    expect(shows("airway-stubs", ZOOM.airwaysHigh, stub, 2)).toBe(true);
    expect(shows("airways", ZOOM.airwaysHigh, stub, 2)).toBe(false);
    expect(shows("airway-stubs", ZOOM.airwaysHigh, stubOnRoute, 2)).toBe(false);
    expect(shows("airways", ZOOM.airwaysHigh, stubOnRoute, 2)).toBe(true);
    expect(shows("airway-stubs", ZOOM.airwaysLow, lowStub, 2)).toBe(true);
    expect(shows("airways-low", ZOOM.airwaysLow, lowStub, 2)).toBe(false);
    expect(shows("airway-labels", ZOOM.airwayLabels, stub, 2)).toBe(false);
    expect(shows("airway-labels", ZOOM.airwayLabels, line, 2)).toBe(true);
    expect(layer("airway-stubs").paint?.["line-dasharray"]).toBeDefined();
  });

  /**
   * filter 里的 `["zoom"]` 按瓦片整数级求值，小数门槛在那里永远晚半级。门槛只许
   * 小数出现在 minzoom 和 paint 里。
   */
  test("写进 filter 的缩放门槛都是整数", () => {
    const used = new Set<number>();
    const walk = (v: unknown) => {
      if (!Array.isArray(v)) return;
      if (
        [">=", "<", ">", "<="].includes(v[0] as string) &&
        JSON.stringify(v[1]) === '["zoom"]'
      ) {
        used.add(v[2] as number);
      }
      v.forEach(walk);
    };
    for (const l of layersOf("light")) walk(l.filter);
    expect(used.size).toBeGreaterThan(0);
    for (const z of used) expect(Number.isInteger(z)).toBe(true);
  });

  test("z5 起有整张航路网（高空和低空）和代号牌", () => {
    expect(ZOOM.airwaysHigh).toBe(5);
    expect(ZOOM.airwaysLow).toBe(5);
    expect(shows("airways", 5, { level: "high", leg: OFF })).toBe(true);
    expect(shows("airways", 4.9, { level: "high", leg: OFF })).toBe(false);
    expect(shows("airways-low", 5, { level: "low", leg: OFF })).toBe(true);
    expect(shows("airway-labels", 5, { level: "high", leg: OFF })).toBe(true);
    expect(shows("airway-labels", 5, { level: "low", leg: OFF })).toBe(true);
    expect(shows("airway-labels", 4.9, { level: "high", leg: OFF })).toBe(
      false,
    );
  });

  test("航路点和点名 z5 出现", () => {
    const high = { level: "high", navaid: "" };
    const low = { level: "low", navaid: "" };
    for (const id of ["waypoint-symbols", "waypoint-labels"]) {
      expect(shows(id, 4.9, high)).toBe(false);
      expect(shows(id, 5, high)).toBe(true);
      expect(shows(id, 5, low)).toBe(true);
    }
  });

  test("禁区、限制区、危险区 z5 起画，CTR 不受限", () => {
    for (const cls of ["prohibited", "restricted"]) {
      expect(shows("airspace-hatch", 4, { cls })).toBe(false);
      expect(shows("airspace-hatch", 5, { cls })).toBe(true);
      expect(shows("airspace-line", 5, { cls })).toBe(true);
    }
    expect(shows("airspace-line-danger", 4, { cls: "danger" })).toBe(false);
    expect(shows("airspace-line-danger", 5, { cls: "danger" })).toBe(true);
    expect(shows("airspace-fill", 4, { cls: "danger" })).toBe(false);
    expect(shows("airspace-fill", 3, { cls: "ctr" })).toBe(true);
    expect(shows("airspace-line", 3, { cls: "ctr" })).toBe(true);
  });

  /** 导航台赢：和 VOR 重合的航路点不画；和 NDB/DME 重合的，等那个台出来再让位。 */
  test("和导航台重合的航路点让位", () => {
    const onVor = { level: "high", navaid: "vor" };
    const onNdb = { level: "high", navaid: "minor" };
    expect(shows("waypoint-symbols", 5, onVor)).toBe(false);
    expect(shows("waypoint-labels", 8, onVor)).toBe(false);
    expect(shows("waypoint-symbols", 5, onNdb)).toBe(true);
    expect(shows("waypoint-symbols", ZOOM.minorNavaids, onNdb)).toBe(false);
    expect(shows("navaid-symbols", ZOOM.minorNavaids, { tier: "minor" })).toBe(
      true,
    );
  });

  test("经纬网 10° 一直画，5° 和 1° 放大后加上", () => {
    for (const id of ["grid", "grid-labels"]) {
      expect(shows(id, 2, { step: 10 })).toBe(true);
      expect(shows(id, 3, { step: 5 })).toBe(false);
      expect(shows(id, ZOOM.grid5, { step: 5 })).toBe(true);
      expect(shows(id, ZOOM.grid5, { step: 1 })).toBe(false);
      expect(shows(id, ZOOM.grid1, { step: 1 })).toBe(true);
    }
  });

  test("VOR 比 NDB 早出现", () => {
    expect(shows("navaid-symbols", ZOOM.vor, { tier: "vor" })).toBe(true);
    expect(shows("navaid-symbols", ZOOM.vor, { tier: "minor" })).toBe(false);
    expect(shows("navaid-symbols", ZOOM.minorNavaids, { tier: "minor" })).toBe(
      true,
    );
  });

  /**
   * 计划航线把航段交给航路网的那一级，必须正好是航路网出现的那一级 —— 早了中间几级
   * 谁都不画，晚了两条线叠着。
   */
  test("计划航线的交接点对得上航路网的 minzoom", () => {
    const step = layer("route").paint?.["line-opacity"] as unknown[];
    expect(step[3]).toBe(layer("airways").minzoom);
    const text = layer("route-airways").paint?.["text-opacity"] as unknown[];
    expect(text[3]).toBe(layer("airway-labels").minzoom);
  });
});

describe("经纬网", () => {
  test("度数标注", () => {
    expect(gridLabel("lat", 35)).toBe("N35°");
    expect(gridLabel("lat", -10)).toBe("S10°");
    expect(gridLabel("lon", 120)).toBe("E120°");
    expect(gridLabel("lon", -75)).toBe("W75°");
    expect(gridLabel("lon", 0)).toBe("0°");
    expect(gridLabel("lon", 180)).toBe("180°");
  });

  test("每条线带它落在的最粗一档", () => {
    const at = (label: string) =>
      graticule().features.find((f) => f.properties?.label === label)
        ?.properties?.step;
    expect(at("E120°")).toBe(10);
    expect(at("N35°")).toBe(5);
    expect(at("E121°")).toBe(1);
  });
});

/**
 * 计划航线用航电里的品红：PFD / ND 上现用航路就是这个颜色，飞行员不用学新图例。
 * 以前是紫色（色相约 291°）。这里只钉色相落在品红那一段（305–325°），两套主题
 * 各验一次；和别的图层分不分得开，靠浏览器里看，不靠这个测试。
 */
describe("计划航线是品红", () => {
  function hue(hex: string): number {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  test.each(["light", "dark"] as const)("%s 主题色相在 305–325°", (theme) => {
    const h = hue(COLORS[theme].route);
    expect(h).toBeGreaterThanOrEqual(305);
    expect(h).toBeLessThanOrEqual(325);
  });
});

/**
 * 等待的方向箭头。第一版画了一个 16 像素的实心形状标成 SDF，地图上只剩三四个像素的一
 * 点：尺寸和距离场的刻度都钉在这里。
 */
describe("等待箭头", () => {
  const { width, height, data } = holdArrowImage();
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] / 255;
  const xs = HOLD_ARROW.polygon.map(([x]) => x);
  const ys = HOLD_ARROW.polygon.map(([, y]) => y);
  const css = (px: number) => px / HOLD_ARROW.pixelRatio;
  const at = (stops: readonly (readonly [number, number])[], z: number) =>
    stops.find(([s]) => s === z)?.[1];

  test("z11 上长 12–14 CSS 像素、宽约线宽的三倍，居中压在线上", () => {
    expect(width).toBe(HOLD_ARROW.size);
    expect(height).toBe(HOLD_ARROW.size);
    const scale = at(ICON.holdArrow, 11) ?? 0;
    const length = css(Math.max(...ys) - Math.min(...ys)) * scale;
    const breadth = css(Math.max(...xs) - Math.min(...xs)) * scale;
    expect(length).toBeGreaterThanOrEqual(12);
    expect(length).toBeLessThanOrEqual(14);
    // 等待线用 `routeMissed` 的线宽（`rampCase(isHold, …)`），最后一个锚点就是 z11 的值。
    const line = WIDTH.routeMissed[WIDTH.routeMissed.length - 1][1];
    expect(breadth / line).toBeGreaterThanOrEqual(2.5);
    expect(breadth / line).toBeLessThanOrEqual(4);
    // 图的中心就是三角形长宽的中心：锚点落在线上。
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBe(width / 2);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBe(width / 2);
    // 四周留够描边：最外的点离图边至少 3 CSS 像素。
    expect(css(Math.min(...xs, ...ys))).toBeGreaterThanOrEqual(3);
    expect(css(width - Math.max(...xs, ...ys))).toBeGreaterThanOrEqual(3);
  });

  test("是距离场：边上 0.75，往外每个 CSS 像素少 1/8", () => {
    const mid = width / 2;
    expect(alpha(mid, mid + 4)).toBeGreaterThan(0.85);
    // 尖正上方 1 CSS 像素：在描边带里（< 0.75），没掉到零。
    const tip = Math.min(...ys);
    const above = alpha(mid, tip - 1 - HOLD_ARROW.pixelRatio);
    expect(above).toBeGreaterThan(0.5);
    expect(above).toBeLessThan(0.75);
    expect(alpha(0, 0)).toBeLessThan(0.1);
  });

  test("样式里的尺寸、门槛和描边对得上", () => {
    expect(HOLD_ARROW.pixelRatio).toBe(2);
    const l = layer("hold-arrows");
    expect(l.minzoom).toBe(ZOOM.holdArrows);
    expect(JSON.stringify(l.layout?.["icon-size"])).toBe(
      JSON.stringify(ramp(ICON.holdArrow)),
    );
    expect(l.paint?.["icon-halo-width"]).toBeLessThanOrEqual(1);
  });

  test("航向只有一个、写在正中、不随边转", () => {
    const l = layer("hold-courses");
    expect(l.layout?.["text-size"]).toBe(14);
    expect(l.layout?.["text-rotate"]).toBeUndefined();
    expect(l.layout?.["text-rotation-alignment"]).toBeUndefined();
    expect(l.minzoom).toBe(ZOOM.holdCourses);
  });
});
