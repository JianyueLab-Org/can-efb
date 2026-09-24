/**
 * 自己的航迹。接错的样子是一条从旧位置直通新位置的线 —— 看起来像飞过，其实是重新
 * 连线或者瞬移。
 */
import { expect, test, describe } from "bun:test";
import { appendTrack, toTrackLine, type OwnTrack } from "@/lib/ownTrack";

const T0 = 1_700_000_000_000;
const fix = (lat: number, lon: number, sec: number, callsign = "CES123") => ({
  callsign,
  lat,
  lon,
  at: T0 + sec * 1000,
});

function run(...fixes: ReturnType<typeof fix>[]): OwnTrack | null {
  let t: OwnTrack | null = null;
  for (const f of fixes) t = appendTrack(t, f);
  return t;
}

describe("航迹累积", () => {
  test("30 秒一个点，连成一条线", () => {
    // 0.05° 纬度约 3 海里，30 秒 → 360 节。
    const t = run(fix(30, 120, 0), fix(30.05, 120, 30), fix(30.1, 120, 60));
    expect(t?.coords).toEqual([
      [120, 30],
      [120, 30.05],
      [120, 30.1],
    ]);
    const line = toTrackLine(t);
    expect(line.features[0].geometry.type).toBe("LineString");
  });

  test("停着不动不加点", () => {
    const t = run(fix(30, 120, 0), fix(30, 120, 30), fix(30, 120, 60));
    expect(t?.coords.length).toBe(1);
    expect(toTrackLine(t).features).toEqual([]);
  });

  test("换呼号重新开始", () => {
    const t = run(fix(30, 120, 0), fix(30.05, 120, 30, "CSN456"));
    expect(t?.callsign).toBe("CSN456");
    expect(t?.coords.length).toBe(1);
  });

  test("断得太久重新开始", () => {
    const t = run(fix(30, 120, 0), fix(30.05, 120, 600));
    expect(t?.coords.length).toBe(1);
  });

  test("瞬移重新开始", () => {
    // 30 秒挪 10 度，远超任何飞机。
    const t = run(fix(30, 120, 0), fix(40, 120, 30));
    expect(t?.coords).toEqual([[120, 40]]);
  });

  test("点数有上限，丢最旧的", () => {
    let t: OwnTrack | null = null;
    const limits = { maxPoints: 3, maxGapMs: 60_000, maxSpeedKt: 1200 };
    for (let i = 0; i < 5; i++) {
      t = appendTrack(t, fix(30 + i * 0.05, 120, i * 30), limits);
    }
    expect(t?.coords.length).toBe(3);
    expect(t?.coords[0][1]).toBeCloseTo(30.1);
  });

  test("不改传进来的那份", () => {
    const first = appendTrack(null, fix(30, 120, 0));
    const second = appendTrack(first, fix(30.05, 120, 30));
    expect(first.coords.length).toBe(1);
    expect(second).not.toBe(first);
  });
});
