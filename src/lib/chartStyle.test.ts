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
  rampCase,
  themedProperties,
  ZOOM,
  type ChartLayer,
  type Theme,
} from "@/lib/chartStyle";
import { registeredImageIds } from "@/lib/chartIcons";

const layersOf = (theme: Theme) =>
  (buildStyle(theme) as unknown as { layers: ChartLayer[] }).layers;

const layer = (id: string, theme: Theme = "light") => {
  const found = layersOf(theme).find((l) => l.id === id);
  if (!found) throw new Error(`没有图层 ${id}`);
  return found;
};

/** 用 MapLibre 自己的过滤器求值：这个要素在这一级缩放上画不画。 */
function shows(id: string, zoom: number, properties: Record<string, unknown>) {
  const l = layer(id);
  if (l.minzoom !== undefined && zoom < l.minzoom) return false;
  if (l.maxzoom !== undefined && zoom >= l.maxzoom) return false;
  const f = featureFilter(l.filter as never, `layers[${id}].filter`);
  return f.filter({ zoom } as never, { type: 1, properties } as never);
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
      "ground-lines",
      "runways",
      "atc-area-fill",
      "airspace-hatch",
      "fir-line",
      "airspace-line",
      "atc-area-line",
      "airways-low",
      "airways",
      "route-casing",
      "route",
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
    const low = { level: "low", onRoute: 0 };
    const lowOnRoute = { level: "low", onRoute: 1 };
    const both = { level: "both", onRoute: 0 };
    const high = { level: "high", onRoute: 0 };
    expect(shows("airways", ZOOM.airwaysHigh, high)).toBe(true);
    expect(shows("airways", ZOOM.airwaysHigh, both)).toBe(true);
    // 同一段不在两层里各画一遍。
    expect(shows("airways-low", ZOOM.airwaysLow, both)).toBe(false);
    expect(shows("airways", ZOOM.airwaysHigh, low)).toBe(false);
    expect(shows("airways-low", ZOOM.airwaysHigh, low)).toBe(false);
    expect(shows("airways-low", ZOOM.airwaysLow, low)).toBe(true);
    expect(shows("airways", ZOOM.airwaysHigh, lowOnRoute)).toBe(true);
    // 同一段不在两层里各画一遍。
    expect(shows("airways-low", ZOOM.airwaysLow, lowOnRoute)).toBe(false);
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

  test("缩小到 z4.5 就有整张高空航路网，z6 加上低空", () => {
    expect(ZOOM.airwaysHigh).toBe(4.5);
    expect(ZOOM.airwaysLow).toBe(6);
    expect(shows("airways", 4.5, { level: "high", onRoute: 0 })).toBe(true);
    expect(shows("airways", 4.4, { level: "high", onRoute: 0 })).toBe(false);
    expect(shows("airways-low", 6, { level: "low", onRoute: 0 })).toBe(true);
    expect(shows("airway-labels", 5, { level: "high", onRoute: 0 })).toBe(true);
    expect(shows("airway-labels", 5, { level: "low", onRoute: 0 })).toBe(false);
  });

  test("航路点和点名 z5.5 出现，低空的等低空航路", () => {
    const high = { level: "high", navaid: "" };
    const low = { level: "low", navaid: "" };
    for (const id of ["waypoint-symbols", "waypoint-labels"]) {
      expect(shows(id, 5.4, high)).toBe(false);
      expect(shows(id, 5.5, high)).toBe(true);
      expect(shows(id, 5.5, low)).toBe(false);
      expect(shows(id, 6, low)).toBe(true);
    }
  });

  /** 导航台赢：和 VOR 重合的航路点不画；和 NDB/DME 重合的，等那个台出来再让位。 */
  test("和导航台重合的航路点让位", () => {
    const onVor = { level: "high", navaid: "vor" };
    const onNdb = { level: "high", navaid: "minor" };
    expect(shows("waypoint-symbols", 5.5, onVor)).toBe(false);
    expect(shows("waypoint-labels", 8, onVor)).toBe(false);
    expect(shows("waypoint-symbols", 5.5, onNdb)).toBe(true);
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
