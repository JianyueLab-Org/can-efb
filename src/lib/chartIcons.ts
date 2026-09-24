/**
 * 航图符号和斜线图块，**运行时用 canvas 画出来注册**，不引 sprite 文件。
 *
 * 名字和颜色都来自 `lib/chartStyle.ts`：这里只管形状。两套主题各画一份，颜色画进
 * 图里（细线走 SDF 会被吃掉抗锯齿的那半边）；每个符号先用底色描一圈宽边再画本体，
 * 压在航路线上也读得出来。飞机例外，按 SDF 注册，颜色由 `icon-color` 给。
 *
 * 只能在浏览器里跑（要 `document`）。注册了哪些名字由 `chartStyle.test.ts` 对着
 * `allImageIds()` 钉住。
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  AIRSPACE,
  AIRCRAFT_ICON,
  COLORS,
  PATTERNS,
  themedImage,
  type Pattern,
  type Theme,
  type ThemedIcon,
} from "@/lib/chartStyle";

/** 符号画布边长。pixelRatio 2，所以是 16 CSS px。 */
const SIZE = 32;
const C = SIZE / 2;
/** 底色描边比本体宽多少（画布像素）。 */
const HALO = 3;

type Pass = { color: string; grow: number };
type Draw = (ctx: CanvasRenderingContext2D, pass: Pass) => void;

function canvas(size: number): CanvasRenderingContext2D | null {
  const el = document.createElement("canvas");
  el.width = el.height = size;
  return el.getContext("2d");
}

/** 先画一遍加宽的底色，再画本体。 */
function render(draw: Draw, color: string, halo: string): ImageData | null {
  const ctx = canvas(SIZE);
  if (!ctx) return null;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  draw(ctx, { color: halo, grow: HALO });
  draw(ctx, { color, grow: 0 });
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

function strokePath(ctx: CanvasRenderingContext2D, p: Pass, width: number) {
  ctx.strokeStyle = p.color;
  ctx.lineWidth = width + p.grow;
  ctx.stroke();
}

/** 填充；底色那一遍额外描一圈，让填充的形状也有边。 */
function fillPath(ctx: CanvasRenderingContext2D, p: Pass) {
  ctx.fillStyle = p.color;
  ctx.fill();
  if (p.grow) strokePath(ctx, p, 0);
}

function dot(
  ctx: CanvasRenderingContext2D,
  p: Pass,
  x: number,
  y: number,
  r: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  fillPath(ctx, p);
}

/** 正六边形的顶点，平顶（VOR 的画法）。 */
function hexagon(r: number): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  });
}

function polygon(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** TACAN 的三块"耳朵"：隔一条边向外伸出一块。 */
function tacanLobes(ctx: CanvasRenderingContext2D, p: Pass, r: number) {
  const hex = hexagon(r);
  for (const i of [0, 2, 4]) {
    const [x1, y1] = hex[i];
    const [x2, y2] = hex[(i + 1) % 6];
    const mx = (x1 + x2) / 2 - C;
    const my = (y1 + y2) / 2 - C;
    const len = Math.hypot(mx, my);
    const ox = (mx / len) * 4;
    const oy = (my / len) * 4;
    polygon(ctx, [
      [x1, y1],
      [x2, y2],
      [x2 + ox, y2 + oy],
      [x1 + ox, y1 + oy],
    ]);
    fillPath(ctx, p);
  }
}

const SHAPES: Record<ThemedIcon, Draw> = {
  // RNAV / 航路点：四角星。
  waypoint: (ctx, p) => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i - Math.PI / 2;
      const r = i % 2 ? 3.4 : 11;
      pts.push([C + r * Math.cos(a), C + r * Math.sin(a)]);
    }
    polygon(ctx, pts);
    fillPath(ctx, p);
  },
  // VOR：六边形加中心点。
  vor: (ctx, p) => {
    polygon(ctx, hexagon(10));
    strokePath(ctx, p, 2.2);
    dot(ctx, p, C, C, 1.8);
  },
  // VOR/DME：六边形套在方框里。
  vordme: (ctx, p) => {
    ctx.beginPath();
    ctx.rect(C - 11, C - 11, 22, 22);
    strokePath(ctx, p, 2);
    polygon(ctx, hexagon(8.5));
    strokePath(ctx, p, 2);
    dot(ctx, p, C, C, 1.6);
  },
  // 单独的 DME：方框加中心点。
  dme: (ctx, p) => {
    ctx.beginPath();
    ctx.rect(C - 9, C - 9, 18, 18);
    strokePath(ctx, p, 2.2);
    dot(ctx, p, C, C, 1.8);
  },
  // TACAN：三块耳朵加中心点，不画六边形的其余三条边。
  tacan: (ctx, p) => {
    tacanLobes(ctx, p, 8);
    dot(ctx, p, C, C, 1.8);
  },
  // VORTAC：完整六边形加三块耳朵。
  vortac: (ctx, p) => {
    polygon(ctx, hexagon(8));
    strokePath(ctx, p, 2);
    tacanLobes(ctx, p, 8);
    dot(ctx, p, C, C, 1.6);
  },
  // NDB：中心一个点，外面两圈小点。
  ndb: (ctx, p) => {
    dot(ctx, p, C, C, 2.4);
    for (const [ring, count, r] of [
      [7, 10, 1.15],
      [11.5, 16, 1.1],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const a = ((Math.PI * 2) / count) * i;
        dot(ctx, p, C + ring * Math.cos(a), C + ring * Math.sin(a), r);
      }
    }
  },
  // 认不出台型的：一个圈加中心点，不冒充任何一种。
  navaid: (ctx, p) => {
    ctx.beginPath();
    ctx.arc(C, C, 7, 0, Math.PI * 2);
    strokePath(ctx, p, 2);
    dot(ctx, p, C, C, 1.6);
  },
  /* 机场：圆圈加一根跑道杠，杠朝北画，`icon-rotate` 转到最长跑道的方位。杠伸出圆
   * 外，缩小时仍看得出朝向。 */
  "apt-rwy": (ctx, p) => {
    ctx.beginPath();
    ctx.arc(C, C, 9.5, 0, Math.PI * 2);
    strokePath(ctx, p, 2.4);
    ctx.beginPath();
    ctx.rect(C - 2, 2, 4, SIZE - 4);
    fillPath(ctx, p);
  },
  // 没有跑道数据的机场：只画圆圈。
  "apt-circle": (ctx, p) => {
    ctx.beginPath();
    ctx.arc(C, C, 8, 0, Math.PI * 2);
    strokePath(ctx, p, 2.4);
  },
};

/** 45° 斜线图块，无缝平铺。 */
function hatch(color: string, spacing: number): ImageData | null {
  const { tile, lineWidth } = AIRSPACE.hatch;
  const ctx = canvas(tile);
  if (!ctx) return null;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "square";
  ctx.beginPath();
  for (let k = -tile; k <= tile * 2; k += spacing) {
    ctx.moveTo(k, tile);
    ctx.lineTo(k + tile, 0);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, tile, tile);
}

/** 飞机，机头朝上（航向 0）。SDF，所以画成白色实心。 */
function aircraft(): ImageData | null {
  const size = 22;
  const ctx = canvas(size);
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 1);
  ctx.lineTo(size - 3, size - 4);
  ctx.lineTo(size / 2, size - 8);
  ctx.lineTo(3, size - 4);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** 注册 `allImageIds()` 里的每一张图。重复调用无害。 */
export function registerChartIcons(map: MapLibreMap): void {
  const add = (id: string, data: ImageData | null, sdf = false) => {
    if (!data || map.hasImage(id)) return;
    map.addImage(id, data, { pixelRatio: 2, sdf });
  };

  add(AIRCRAFT_ICON, aircraft(), true);

  for (const theme of ["light", "dark"] as Theme[]) {
    const c = COLORS[theme];
    const colorOf: Record<ThemedIcon, string> = {
      waypoint: c.waypoint,
      vor: c.navaid,
      vordme: c.navaid,
      dme: c.navaid,
      tacan: c.navaid,
      vortac: c.navaid,
      ndb: c.ndb,
      navaid: c.navaid,
      "apt-rwy": c.airport,
      "apt-circle": c.airport,
    };
    for (const [key, draw] of Object.entries(SHAPES) as [ThemedIcon, Draw][]) {
      add(themedImage(key, theme), render(draw, colorOf[key], c.halo));
    }
    const patterns: Record<Pattern, ImageData | null> = {
      "hatch-restricted": hatch(c.restricted, AIRSPACE.hatch.spacing),
      "hatch-prohibited": hatch(c.prohibited, AIRSPACE.prohibitedSpacing),
    };
    for (const [key, data] of Object.entries(patterns) as [
      Pattern,
      ImageData | null,
    ][]) {
      add(themedImage(key, theme), data);
    }
  }
}

/** 这个模块会注册的全部图片名（给测试对照 `allImageIds()`）。 */
export function registeredImageIds(): string[] {
  const out: string[] = [AIRCRAFT_ICON];
  for (const theme of ["light", "dark"] as Theme[]) {
    for (const key of Object.keys(SHAPES) as ThemedIcon[]) {
      out.push(themedImage(key, theme));
    }
    for (const key of PATTERNS) out.push(themedImage(key, theme));
  }
  return out;
}
