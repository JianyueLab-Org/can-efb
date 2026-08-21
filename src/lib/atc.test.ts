/**
 * `lib/atc.ts` 的测试。**这个文件是本仓库第一个测试，它值得破例**。
 *
 * 这个站的门禁一向是 lint + build（`AGENTS.md` 里写着），不跑测试 —— 大部分代码
 * 要么是外壳、要么错了当场看得见，测试买不到什么。这一份不一样，理由是它盯的那几
 * 条**错了看不出来**：
 *
 * - `parseFeedTime` 把时间读偏一个时区，算出来仍然是一个像模像样的时长（在中国是
 *   多八小时）。屏幕上没有任何异样。can-radar 就是这么踩过来的。
 * - 席位顺序错了只是"排得有点怪"，而它其实是联系顺序。
 * - `atisLetter` 认错一个字母，就是让人按着上一份天气做决定。
 *
 * 而且这几条都是**纯函数、不需要浏览器也不需要网络**，所以测它们的成本接近零：
 * `bun test` 自带，没引入任何依赖。
 *
 * 跑法：`bun test`。CI 目前**不跑它**（那个工作流的门是 lint + build），要接进去
 * 是另一处改动 —— 在那之前它至少能在本地一句话跑完。
 */
import { expect, test, describe } from "bun:test";
import {
  atisLetter,
  atisText,
  boundaryCodesFor,
  facilityColor,
  facilityRank,
  groupControllers,
  onlineFor,
  ownsAirspace,
  parseFeedTime,
  stationAirport,
} from "@/lib/atc";
import type { DatafeedController } from "@/lib/datafeed";

function station(
  callsign: string,
  facility: number,
  extra: Partial<DatafeedController> = {},
): DatafeedController {
  return {
    callsign,
    cid: "1",
    facility,
    frequency: "118.000",
    latitude: "30",
    longitude: "120",
    logon_time: "2026-08-21 00:00:00",
    name: "Someone",
    rating: 3,
    text_atis: [],
    ...extra,
  };
}

describe("parseFeedTime", () => {
  test("不带时区标记的时间戳按 UTC 读，不是本地时间", () => {
    // 这是整个文件最要紧的一条断言。datafeed 给的是 `2026-08-21 12:34:55` 这个形
    // 状 —— UTC 的墙钟，没有任何东西说它是 UTC。`new Date()` 会当本地时间读。
    const parsed = parseFeedTime("2026-08-21 12:34:55");
    expect(parsed?.toISOString()).toBe("2026-08-21T12:34:55.000Z");
  });

  test("秒可以省略", () => {
    expect(parseFeedTime("2026-08-21 12:34")?.toISOString()).toBe(
      "2026-08-21T12:34:00.000Z",
    );
  });

  test("本来就带时区的交给平台", () => {
    expect(parseFeedTime("2026-08-21T12:34:55Z")?.toISOString()).toBe(
      "2026-08-21T12:34:55.000Z",
    );
    // +09:00 的 12:34 是 UTC 的 03:34
    expect(parseFeedTime("2026-08-21T12:34:55+09:00")?.toISOString()).toBe(
      "2026-08-21T03:34:55.000Z",
    );
  });

  test("空的和读不出来的返回 null，不返回 Invalid Date", () => {
    expect(parseFeedTime("")).toBeNull();
    expect(parseFeedTime(null)).toBeNull();
    expect(parseFeedTime(undefined)).toBeNull();
    expect(parseFeedTime("不是时间")).toBeNull();
  });
});

describe("onlineFor", () => {
  const logon = "2026-08-21 00:00:00";
  const at = (iso: string) => Date.parse(iso);

  test("不足一小时只报分钟", () => {
    expect(onlineFor(logon, at("2026-08-21T00:42:00Z"))).toBe("42m");
  });

  test("超过一小时报时和分", () => {
    expect(onlineFor(logon, at("2026-08-21T03:12:00Z"))).toBe("3h 12m");
  });

  test("**同一个时刻算出来是 0m，不是 8h**", () => {
    // 时区读错的那个 bug 正是在这里现形：把 logon 当本地时间读的话，在 UTC+8 上
    // 这一句会得到 8h 而不是 0m。
    expect(onlineFor(logon, at("2026-08-21T00:00:00Z"))).toBe("0m");
  });

  test("时间戳读不出来时返回 null，让调用方决定显示什么", () => {
    expect(onlineFor("")).toBeNull();
  });
});

describe("stationAirport", () => {
  test("取第一个下划线之前的部分", () => {
    expect(stationAirport("ZSSS_TWR")).toBe("ZSSS");
    expect(stationAirport("ZSSS_I_TWR")).toBe("ZSSS");
    expect(stationAirport("ZSSS_ATIS")).toBe("ZSSS");
  });

  test("没有下划线就是它自己", () => {
    expect(stationAirport("ZGZU")).toBe("ZGZU");
  });
});

describe("facilityRank", () => {
  test("是联系顺序，不是字母序", () => {
    // DEL(2) → GND(3) → TWR(4) → APP(5)
    expect(facilityRank(2)).toBeLessThan(facilityRank(3));
    expect(facilityRank(3)).toBeLessThan(facilityRank(4));
    expect(facilityRank(4)).toBeLessThan(facilityRank(5));
  });

  test("没见过的席位排在最后而不是最前", () => {
    expect(facilityRank(99)).toBeGreaterThan(facilityRank(0));
  });
});

describe("groupControllers", () => {
  test("场面席位并进同一个机场，堆内按联系顺序排", () => {
    const groups = groupControllers([
      station("ZSSS_TWR", 4),
      station("ZSSS_DEL", 2),
      station("ZSSS_GND", 3),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe("ZSSS");
    expect(groups[0].local).toBe(true);
    // 送进去是 TWR/DEL/GND，排出来必须是 DEL/GND/TWR
    expect(groups[0].stations.map((s) => s.callsign)).toEqual([
      "ZSSS_DEL",
      "ZSSS_GND",
      "ZSSS_TWR",
    ]);
  });

  test("进近和区域各自成堆，不并进机场", () => {
    // 进近常常一个人管好几个场，归进某一个机场的堆里会说错话。
    const groups = groupControllers([
      station("ZSSS_TWR", 4),
      station("ZSSS_APP", 5),
      station("ZSHA_CTR", 6),
    ]);
    expect(groups.map((g) => g.code).sort()).toEqual([
      "ZSHA_CTR",
      "ZSSS",
      "ZSSS_APP",
    ]);
    const app = groups.find((g) => g.code === "ZSSS_APP");
    expect(app?.local).toBe(false);
    expect(app?.stations).toHaveLength(1);
  });

  test("同一档里按呼号排，刷新之间顺序稳定", () => {
    // 没有这一条，ZSSS_TWR 和 ZSSS_I_TWR 会在两次刷新之间互换位置，
    // 看起来像有人上下线。
    const once = groupControllers([
      station("ZSSS_I_TWR", 4),
      station("ZSSS_TWR", 4),
    ]);
    const twice = groupControllers([
      station("ZSSS_TWR", 4),
      station("ZSSS_I_TWR", 4),
    ]);
    expect(once[0].stations.map((s) => s.callsign)).toEqual(
      twice[0].stations.map((s) => s.callsign),
    );
  });

  test("空列表给空数组，不抛", () => {
    expect(groupControllers([])).toEqual([]);
  });
});

describe("atisText / atisLetter", () => {
  test("多行拼成一段，空行丢掉", () => {
    const a = station("ZSSS_ATIS", 7, {
      text_atis: ["ZSSS INFORMATION C", "  ", "RWY 36L IN USE"],
    });
    expect(atisText(a)).toBe("ZSSS INFORMATION C RWY 36L IN USE");
  });

  test("认出通播代号", () => {
    expect(
      atisLetter(station("A", 7, { text_atis: ["ZSSS INFORMATION C 1200Z"] })),
    ).toBe("C");
    expect(atisLetter(station("A", 7, { text_atis: ["INFO D"] }))).toBe("D");
    expect(atisLetter(station("A", 7, { text_atis: ["ATIS B"] }))).toBe("B");
  });

  test("**认不出来返回 null，不猜**", () => {
    // 通播代号错一个字母，就是让人按着上一份天气做决定。
    expect(atisLetter(station("A", 7, { text_atis: ["RWY 36L IN USE"] }))).toBe(
      null,
    );
    expect(atisLetter(station("A", 7, { text_atis: [] }))).toBe(null);
    // INFORMATION 后面跟的不是孤立的单字母，不认
    expect(
      atisLetter(station("A", 7, { text_atis: ["INFORMATION CHARLIE"] })),
    ).toBe(null);
  });
});

describe("facilityColor", () => {
  test("每一类席位一个颜色", () => {
    expect(facilityColor(4)).toBe("#d32c00"); // TWR
    expect(facilityColor(3)).toBe("#4a9c25"); // GND
  });

  test("没见过的席位退回 OBS 的灰，不是 undefined", () => {
    // 表达式里塞进 undefined 会让整条 MapLibre 表达式失效，把这一层弄没。
    expect(facilityColor(99)).toBe(facilityColor(0));
  });
});

describe("ownsAirspace", () => {
  test("区域 / 进近 / FSS 管的是一片范围", () => {
    expect(ownsAirspace(6)).toBe(true); // CTR
    expect(ownsAirspace(5)).toBe(true); // APP
    expect(ownsAirspace(1)).toBe(true); // FSS
  });

  test("放行 / 地面 / 塔台管的是这一个机场，画点是对的", () => {
    expect(ownsAirspace(2)).toBe(false); // DEL
    expect(ownsAirspace(3)).toBe(false); // GND
    expect(ownsAirspace(4)).toBe(false); // TWR
  });
});

describe("boundaryCodesFor", () => {
  test("默认按呼号前缀，区域和进近同一条规则", () => {
    expect(boundaryCodesFor("ZSHA_CTR")).toEqual(["ZSHA"]);
    expect(boundaryCodesFor("ZBAA_APP")).toEqual(["ZBAA"]);
    // 中间段（席位编号）要被忽略，否则 ZSSS_1_APP 会取到 ZSSS_1
    expect(boundaryCodesFor("ZSSS_1_APP")).toEqual(["ZSSS"]);
  });

  test("**习惯短码要翻译**，否则香港台北的区域会画成一个点", () => {
    // 拿真 datafeed 跑过：HKG_W_CTR 当时在线，按前缀取到 HKG、边界表里没有，
    // 于是退回画点 —— 而那正是这次要修的毛病。
    expect(boundaryCodesFor("HKG_W_CTR")).toEqual(["VHHK"]);
    expect(boundaryCodesFor("TPE_CTR")).toEqual(["RCAA"]);
  });

  test("**PRC_FSS 是一对多**，九个情报区一个都不能少", () => {
    const codes = boundaryCodesFor("PRC_FSS");
    expect(codes).toHaveLength(9);
    // 排过序的，比对整份而不是抽查 —— 少一个就是有一片空域没被画出来。
    expect([...codes].sort()).toEqual([
      "ZBPE",
      "ZGZU",
      "ZHWH",
      "ZJSA",
      "ZLHW",
      "ZPKM",
      "ZSHA",
      "ZWUQ",
      "ZYSH",
    ]);
  });

  test("认不出来的原样返回，让调用方去退回画点", () => {
    // 返回空数组会让调用方以为"这个席位不用画"，而正确行为是退回画点。
    expect(boundaryCodesFor("XXXX_CTR")).toEqual(["XXXX"]);
  });
});
