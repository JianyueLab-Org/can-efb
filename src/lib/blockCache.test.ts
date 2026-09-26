import { describe, expect, test } from "bun:test";
import { blockBox, createBlockCache } from "@/lib/blockCache";

/** 一块一条：块的左下角当条目，另给一条横跨所有块的，看它只留一份。 */
function cache(fail = new Set<string>()) {
  const calls: string[] = [];
  const c = createBlockCache<{ id: string }>({
    size: 20,
    key: (x) => x.id,
    fetch: async (lat, lon) => {
      calls.push(`${lat},${lon}`);
      if (fail.has(`${lat},${lon}`)) throw new Error("boom");
      return [{ id: `${lat},${lon}` }, { id: "shared" }];
    },
  });
  return { c, calls };
}

const view = { south: 23, west: 98, north: 39, east: 126 };

describe("按块取", () => {
  test("取视野压到的块，跨块的条目只留一份", async () => {
    const { c, calls } = cache();
    expect(await c.load(view)).toBe(true);
    expect(calls).toEqual(["20,80", "20,100", "20,120"]);
    expect(
      c
        .values()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["20,100", "20,120", "20,80", "shared"]);
  });

  test("取过的块不再取，清单引用不变", async () => {
    const { c, calls } = cache();
    await c.load(view);
    const before = c.values();
    expect(await c.load(view)).toBe(false);
    expect(calls).toHaveLength(3);
    expect(c.values()).toBe(before);
  });

  test("失败的块放回去，下次再取", async () => {
    const fail = new Set(["20,100"]);
    const { c, calls } = cache(fail);
    await expect(c.load(view)).rejects.toThrow("boom");
    fail.clear();
    await c.load(view);
    expect(calls.filter((k) => k === "20,100")).toHaveLength(2);
  });

  test("reset 之后，途中的请求作废", async () => {
    const { c } = cache();
    const pending = c.load(view);
    c.reset();
    expect(await pending).toBe(false);
    expect(c.values()).toEqual([]);
    expect(c.loaded()).toBe(false);
  });
});

describe("扔掉远处的块", () => {
  const near = { south: 23, west: 125, north: 39, east: 135 };
  const far = { south: 23, west: 162, north: 39, east: 175 };

  test("视野外扩一圈之外的块和条目扔掉，跨块的留到最后一块走", async () => {
    const { c } = cache();
    await c.load(view);
    // 20,80 离视野两块远；20,100 在外扩的那一圈里。
    expect(c.evict(near, 20)).toBe(true);
    expect(
      c
        .values()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["20,100", "20,120", "shared"]);
    expect(c.evict(near, 20)).toBe(false);
  });

  test("扔掉的块再看到时重取", async () => {
    const { c, calls } = cache();
    await c.load(view);
    c.evict(far, 0);
    expect(c.values()).toEqual([]);
    expect(await c.load(view)).toBe(true);
    expect(calls.filter((k) => k === "20,80")).toHaveLength(2);
  });

  test("途中被扔掉的块回来不收", async () => {
    const { c } = cache();
    const pending = c.load(view);
    c.evict(far, 0);
    expect(await pending).toBe(false);
    expect(c.values()).toEqual([]);
  });
});

describe("块的 bbox", () => {
  test("纬度在前，夹在 ±90 之内", () => {
    expect(blockBox(20, 100)).toBe("20,100,40,120");
    expect(blockBox(80, 160)).toBe("80,160,90,180");
    expect(blockBox(-100, -180)).toBe("-90,-180,-80,-160");
  });
});

describe("自定块和上限", () => {
  test("blocks 给了就按它分块", async () => {
    const calls: string[] = [];
    const c = createBlockCache<{ id: string }>({
      size: 10,
      key: (x) => x.id,
      blocks: () => [{ lat: 0, lon: 170 }],
      fetch: async (lat, lon) => {
        calls.push(`${lat},${lon}`);
        return [{ id: `${lat},${lon}` }];
      },
    });
    await c.load(view);
    expect(calls).toEqual(["0,170"]);
  });

  test("攒过 maxBlocks 时丢视野外最早取的块", async () => {
    let at = 0;
    const c = createBlockCache<{ id: string }>({
      size: 10,
      key: (x) => x.id,
      blocks: () => [{ lat: 0, lon: at }],
      maxBlocks: 2,
      fetch: async (lat, lon) => [{ id: `${lat},${lon}` }],
    });
    for (at = 0; at < 40; at += 10) await c.load(view);
    expect(
      c
        .values()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["0,20", "0,30"]);
  });
});
