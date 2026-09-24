import { describe, expect, test } from "bun:test";
import { airportsInView, toAirportPin, type AirportPin } from "@/lib/airports";

/**
 * `Number(null)` 是 0，而 0 是有限数 —— 没坐标的机场会变成 (0°, 0°) 的一个齿轮，
 * 看起来和正常机场一样。
 */
describe("toAirportPin", () => {
  test("缺坐标的行不要", () => {
    for (const bad of [null, undefined, "", "  ", "abc", true]) {
      expect(toAirportPin({ icao: "ZBAA", lat: bad, lon: 116.6 })).toBeNull();
      expect(toAirportPin({ icao: "ZBAA", lat: 40.1, lon: bad })).toBeNull();
    }
  });

  test("数字和数字字符串都认，0 是合法坐标", () => {
    expect(
      toAirportPin({ icao: "zbaa", name: "首都", lat: "40.08", lon: 116.6 }),
    ).toEqual({ icao: "ZBAA", name: "首都", lat: 40.08, lon: 116.6 });
    expect(toAirportPin({ icao: "XXXX", lat: 0, lon: 0 })?.lat).toBe(0);
  });
});

/**
 * 视野经度是展开值（过日界线是 `170..190`），机场经度在 [-180, 180)。直接比的话
 * 西经那一侧的机场永远不在框里。
 */
describe("airportsInView 跨日界线", () => {
  const pin = (icao: string, lat: number, lon: number): AirportPin => ({
    icao,
    name: null,
    lat,
    lon,
  });
  const pins = [
    pin("NFFN", -17.76, 177.44),
    pin("NSFA", -13.83, -172.01),
    pin("ZBAA", 40.08, 116.6),
  ];

  test("往东展开的视野里认得西经那一侧", () => {
    const v = { south: -25, west: 170, north: -10, east: 190 };
    // 视野中心在 180°：斐济离中心 2.6°，萨摩亚 8°（按展开后的经度算，不是 350°）。
    expect(airportsInView(pins, v).map((p) => p.icao)).toEqual([
      "NFFN",
      "NSFA",
    ]);
  });

  test("往西展开的视野里认得东经那一侧", () => {
    const v = { south: -25, west: -190, north: -10, east: -170 };
    expect(airportsInView(pins, v).map((p) => p.icao)).toEqual([
      "NFFN",
      "NSFA",
    ]);
  });

  test("返回的仍是原来的经度", () => {
    const v = { south: -25, west: 170, north: -10, east: 190 };
    const nsfa = airportsInView(pins, v).find((p) => p.icao === "NSFA");
    expect(nsfa?.lon).toBe(-172.01);
  });

  test("不跨的视野照旧", () => {
    const v = { south: 39, west: 115, north: 41, east: 118 };
    expect(airportsInView(pins, v).map((p) => p.icao)).toEqual(["ZBAA"]);
  });
});
