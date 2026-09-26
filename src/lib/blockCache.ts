/**
 * 按块取、取过留着的一份清单。航路网、导航台、禁区限制区危险区和 Grid MORA 用它。航路
 * 网的条目是整块的图（`useChartLayers` 再用 `unionAirwayGraphs` 并成一张）。
 *
 * can-db 装的是全球数据，不带 `bbox` 取一次是全世界：导航台一万一千多个，禁区、限制
 * 区、危险区一万三千多块。屏幕上看得见的只是其中一片，所以只取视野压到的块，块是
 * `size` 度见方、对齐整数倍的格子（`lib/mora.ts` 的 `blocksFor`）。同一块的 URL 每次
 * 都一样，浏览器缓存认得出来。
 *
 * 跨块边界的条目两块都会给，按 `key` 只留一份。`reset()` 之后，之前发出去还没回来的
 * 请求一律作废 —— 「不使用受限汇编」变了，旧那份不许混进新的。`evict()` 扔掉离视野太远
 * 的块（MORA 用），再看到那里时重取。`maxBlocks` 给了的话，攒过这个数时丢视野外最早取
 * 的块（航路网用）。
 */
import { blocksFor } from "@/lib/mora";

/**
 * 导航台、禁区限制区危险区的块边长（度）。z5 一屏约 28 × 17 度，落在 2–3 × 1–2 块
 * 里。能整除 360，块边界折回日界线之后仍然对齐。航路网用自己的 `AIRWAY_BLOCK`。
 */
export const CHART_BLOCK = 20;

/** 一块的 `bbox` 参数，`minLat,minLon,maxLat,maxLon`，纬度夹在 ±90 之内。 */
export function blockBox(lat: number, lon: number, size = CHART_BLOCK): string {
  const minLat = Math.max(lat, -90);
  const maxLat = Math.min(lat + size, 90);
  return `${minLat},${lon},${maxLat},${Math.min(lon + size, 180)}`;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface BlockCache<T> {
  /**
   * 补齐覆盖 `v` 的块。返回 `true` 表示清单变了（有新条目，或按 `maxBlocks` 丢了块），
   * 调用方该重画；`false` 是
   * 没有要取的块、取回来没有新东西、或者途中被 `reset()` / `evict()` 作废了。
   *
   * 失败抛出，失败的块放回去，下次再取。
   */
  load(v: Bounds): Promise<boolean>;
  /**
   * 扔掉 `v` 四边各外扩 `margin` 度之外的块，连同只属于它们的条目；途中的请求回来也不
   * 收。再看到那里时重取。返回 `true` 表示清单变了。
   */
  evict(v: Bounds, margin: number): boolean;
  /** 至今取到的全部条目。 */
  values(): T[];
  /** 取过至少一块（不论有没有条目）。 */
  loaded(): boolean;
  reset(): void;
}

export function createBlockCache<T>(options: {
  size: number;
  key: (item: T) => string;
  fetch: (lat: number, lon: number) => Promise<T[]>;
  /** 视野 → 覆盖它的块的左下角。默认 `lib/mora.ts` 的 `blocksFor`（按 `size`）。 */
  blocks?: (
    south: number,
    west: number,
    north: number,
    east: number,
  ) => { lat: number; lon: number }[];
  /** 取完的块攒过这个数时，丢视野外最早取的那些。不给就不丢。 */
  maxBlocks?: number;
}): BlockCache<T> {
  /* 取到或正在取的块 → 这次请求的凭据。回来时凭据对不上（`reset` 清过、`evict` 扔过
   * 又重新发了），这一块就不收。 */
  let blocks = new Map<string, object>();
  /** 每块带来的条目键，`evict` 按它扔。 */
  const keysOf = new Map<string, string[]>();
  /** 条目和引用它的块数：跨块的条目要等最后一块扔掉才走。 */
  let items = new Map<string, { item: T; refs: number }>();
  let list: T[] = [];
  let done = 0;

  const id = (b: { lat: number; lon: number }) => `${b.lat},${b.lon}`;
  const cover = (v: Bounds) =>
    options.blocks
      ? options.blocks(v.south, v.west, v.north, v.east)
      : blocksFor(v.south, v.west, v.north, v.east, options.size);

  /** 扔掉一块和只属于它的条目。有条目走了返回 `true`。 */
  function drop(b: string): boolean {
    let removed = false;
    blocks.delete(b);
    for (const k of keysOf.get(b) ?? []) {
      const held = items.get(k);
      if (!held || --held.refs > 0) continue;
      items.delete(k);
      removed = true;
    }
    keysOf.delete(b);
    return removed;
  }

  return {
    async load(v) {
      const inView = cover(v);
      const wanted = inView.filter((b) => !blocks.has(id(b)));
      if (!wanted.length) return false;
      const ticket = {};
      for (const b of wanted) blocks.set(id(b), ticket);

      let batches: T[][];
      try {
        batches = await Promise.all(
          wanted.map((b) => options.fetch(b.lat, b.lon)),
        );
      } catch (error) {
        for (const b of wanted) {
          if (blocks.get(id(b)) === ticket) blocks.delete(id(b));
        }
        throw error;
      }

      let added = false;
      wanted.forEach((b, i) => {
        if (blocks.get(id(b)) !== ticket) return;
        done++;
        const keys = new Set<string>();
        for (const item of batches[i]) {
          const k = options.key(item);
          if (keys.has(k)) continue;
          keys.add(k);
          const held = items.get(k);
          if (held) {
            held.refs++;
            continue;
          }
          items.set(k, { item, refs: 1 });
          added = true;
        }
        keysOf.set(id(b), [...keys]);
      });
      // 攒多了：按取回顺序丢视野外的块，只动取完的（还在路上的没有 `keysOf`）。
      let removed = false;
      if (options.maxBlocks !== undefined) {
        const keep = new Set(inView.map(id));
        for (const b of [...keysOf.keys()]) {
          if (keysOf.size <= options.maxBlocks) break;
          if (!keep.has(b) && drop(b)) removed = true;
        }
      }
      // 新数组：调用方按引用判断变没变。
      if (added || removed) list = [...items.values()].map((x) => x.item);
      return added || removed;
    },
    evict(v, margin) {
      const keep = new Set(
        cover({
          south: v.south - margin,
          west: v.west - margin,
          north: v.north + margin,
          east: v.east + margin,
        }).map(id),
      );
      let removed = false;
      for (const b of [...blocks.keys()]) {
        if (!keep.has(b) && drop(b)) removed = true;
      }
      if (removed) list = [...items.values()].map((x) => x.item);
      return removed;
    },
    values: () => list,
    loaded: () => done > 0,
    reset() {
      blocks = new Map();
      keysOf.clear();
      items = new Map();
      list = [];
      done = 0;
    },
  };
}
