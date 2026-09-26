import { describe, expect, test } from "bun:test";
import {
  composeRoutePoints,
  joinIdent,
  joinsRoute,
  pickProcedures,
  procedureLabel,
  procedureRunways,
  procedureToMapPoints,
  procedureTrack,
  procedureTransitions,
  rewriteRoute,
  runwayIdents,
  runwayMatches,
  runwayTrueBearing,
  servesAllRunways,
  servesRunway,
  type Procedure,
  type ProcedureLeg,
} from "@/lib/procedures";

/**
 * 这几条测的都是**错了不会被屏幕出卖**的判断 —— 这个站的判据（见 CLAUDE.md）。
 *
 * 一条筛错跑道的程序、一段接不上的航路、一个被当成程序删掉的航路点，画在图上都
 * 是一条看起来完全正常的线。
 */

function leg(ident: string, lat: number | null = 0, lon: number | null = 0) {
  return {
    ident,
    lat,
    lon,
    path: null,
    transition: null,
    routeType: null,
    alt: null,
    speedKt: null,
    speedKind: null,
    turn: null,
    courseMag: null,
    vpaDeg: null,
    flyover: null,
    isMap: null,
    part: null,
  } satisfies ProcedureLeg;
}

function proc(over: Partial<Procedure> = {}): Procedure {
  return {
    kind: "sid",
    name: "BOTP2G",
    runway: null,
    runways: null,
    chart: null,
    variant: null,
    points: [],
    path: [],
    ...over,
  };
}

describe("跑道解析", () => {
  // 分隔符在这个仓库里查不到 —— 三种拼法都必须解析成同一批跑道，
  // 赌错一种的后果是这条程序在每一条跑道下都不出现。
  test.each([
    ["01L,01R,02", "逗号"],
    ["01L/01R/02", "斜杠"],
    ["01L 01R 02", "空格"],
    ["01L, 01R, 02", "逗号加空格"],
    // 导入器那一头源数据是个**数组**，中间那步用什么拼的在这个仓库里查不到 ——
    // 连「原样序列化成 JSON」这种最坏情况也得解对，而它确实解得对：括号和引号
    // 都不是字母数字。这一行就是那个未知的证明。
    ['["01L","01R","02"]', "JSON 数组原样"],
  ])("%s（%s）解析成同一批", (raw) => {
    expect(procedureRunways(proc({ runways: raw }))).toEqual([
      "01L",
      "01R",
      "02",
    ]);
  });

  test("ALL 等同于没说，不变成一条名叫 ALL 的跑道", () => {
    expect(procedureRunways(proc({ runways: "ALL" }))).toEqual([]);
    expect(servesAllRunways(proc({ runways: "ALL" }))).toBe(true);
  });

  test("没写跑道的程序对每条跑道都算数", () => {
    // 反过来（当成不匹配）会让选了跑道之后列表整个空掉，看起来像这个机场没有程序。
    const p = proc();
    expect(servesRunway(p, "01L")).toBe(true);
    expect(servesAllRunways(p)).toBe(true);
  });

  test("写了跑道的按写的来", () => {
    const p = proc({ runways: "01L,01R" });
    expect(servesRunway(p, "01L")).toBe(true);
    expect(servesRunway(p, "19R")).toBe(false);
    expect(servesAllRunways(p)).toBe(false);
  });

  test("没选跑道时不筛", () => {
    expect(servesRunway(proc({ runways: "01L" }), "")).toBe(true);
  });

  test("老数据源只有 runway 单数那一列时也认", () => {
    expect(procedureRunways(proc({ runway: "36" }))).toEqual(["36"]);
  });
});

describe("跑道端排序", () => {
  test("按数字排，不按字典序", () => {
    const rw = ["19L", "02", "01L", "1R", "36"].map((id) => ({
      id,
      opposite: null,
      hdg: null,
      lat: 0,
      lon: 0,
      endLat: 0,
      endLon: 0,
    }));
    // 字典序会得到 01L 02 19L 1R 36 —— `1R` 掉到 19L 后面，而它是 01 那条。
    expect(runwayIdents(rw)).toEqual(["01L", "1R", "02", "19L", "36"]);
  });
});

describe("挑程序", () => {
  const list = [
    proc({ kind: "sid", name: "MIKIP9", runways: "01L,01R" }),
    proc({ kind: "sid", name: "BOTP2G", runways: "19L,19R" }),
    proc({ kind: "star", name: "ENVIP9", runways: "01L" }),
    proc({ kind: "approach", name: "R01L", variant: "y", runways: "01L" }),
    proc({ kind: "approach", name: "R01L", variant: "z", runways: "01L" }),
  ];

  test("按类别和跑道筛", () => {
    expect(pickProcedures(list, "sid", "01L").map((p) => p.name)).toEqual([
      "MIKIP9",
    ]);
    expect(pickProcedures(list, "star", "01L").map((p) => p.name)).toEqual([
      "ENVIP9",
    ]);
  });

  test("同名的变体排在一起", () => {
    const got = pickProcedures(list, "approach", "01L").map(procedureLabel);
    expect(got).toEqual(["R01L-Y", "R01L-Z"]);
  });
});

describe("画线", () => {
  test("没有坐标的腿跳过，但列表里还在", () => {
    // CA / VI 那类腿终止在高度或航向上，本来就没有定位点 —— 跳过不是丢数据。
    const p = proc({
      path: [leg("A", 30, 120), leg("", null, null), leg("B", 31, 121)],
    });
    const points = procedureToMapPoints(p);
    expect(points.map((x) => x.ident)).toEqual(["A", "B"]);
    expect(p.path).toHaveLength(3);
  });

  test("via 一律是程序名，地图据此沿线标注", () => {
    const p = proc({ name: "IDKE5Y", path: [leg("A", 30, 120)] });
    expect(procedureToMapPoints(p)[0].via).toBe("IDKE5Y");
    expect(procedureToMapPoints(p)[0].kind).toBe("sid");
  });
});

describe("衔接", () => {
  const sid = proc({
    kind: "sid",
    name: "BOTP2G",
    path: [leg("RW01L"), leg("GYA"), leg("BOTPO")],
  });
  const star = proc({
    kind: "star",
    name: "ENVIP9",
    path: [leg("ENVIP"), leg("GYA"), leg("RW19R")],
  });

  test("SID 看最后一个点，STAR 看第一个", () => {
    expect(joinsRoute(sid, "BOTPO")).toBe(true);
    expect(joinsRoute(sid, "GYA")).toBe(false);
    expect(joinsRoute(star, "ENVIP")).toBe(true);
    expect(joinsRoute(star, "RW19R")).toBe(false);
    expect(joinIdent(sid)).toBe("BOTPO");
    expect(joinIdent(star)).toBe("ENVIP");
  });

  test("判不了要回 null，不能回 false", () => {
    // 「不知道」和「不对」是两回事：报成 false 会让界面对一条其实没问题的航路
    // 喊「接不上」，而人只能照着它去改一条本来就对的计划。
    expect(joinsRoute(null, "BOTPO")).toBeNull();
    expect(joinsRoute(sid, "")).toBeNull();
    expect(joinsRoute(proc({ path: [] }), "BOTPO")).toBeNull();
  });
});

describe("改写航路串", () => {
  test("首尾本来是程序名就替换", () => {
    expect(
      rewriteRoute(
        "BOTP2G BOTPO W47 ENVIP ENVIP9",
        { sid: "BOTP2G", star: "ENVIP9" },
        { sid: "MIKIP9", star: "IDKE5Y" },
      ),
    ).toBe("MIKIP9 BOTPO W47 ENVIP IDKE5Y");
  });

  test("本来没有程序就插入", () => {
    expect(
      rewriteRoute("BOTPO W47 ENVIP", {}, { sid: "MIKIP9", star: "IDKE5Y" }),
    ).toBe("MIKIP9 BOTPO W47 ENVIP IDKE5Y");
  });

  test("null 是删掉，空串是不动这一头", () => {
    // 两者必须分开：否则「不改进场」和「去掉进场」会是同一件事。
    expect(
      rewriteRoute(
        "BOTP2G BOTPO W47 ENVIP ENVIP9",
        { sid: "BOTP2G", star: "ENVIP9" },
        { sid: null, star: "" },
      ),
    ).toBe("BOTPO W47 ENVIP ENVIP9");
  });

  test("不去猜某个记号像不像程序", () => {
    // BOTP2G 和 BOTPO 在字符层面分不开。旧名字对不上就只插入，绝不删。
    expect(
      rewriteRoute("BOTPO W47 ENVIP", { sid: "BOTP2G" }, { sid: "MIKIP9" }),
    ).toBe("MIKIP9 BOTPO W47 ENVIP");
  });
});

describe("合成", () => {
  const dep = { ident: "ZGGG", lat: 23, lon: 113, kind: "airport" };
  const arr = { ident: "ZBAA", lat: 40, lon: 116, kind: "airport" };
  const sid = proc({
    kind: "sid",
    name: "BOTP2G",
    path: [leg("RW01L", 23.1, 113.1), leg("BOTPO", 24, 114)],
  });
  const star = proc({
    kind: "star",
    name: "ENVIP9",
    path: [leg("ENVIP", 39, 116), leg("VYK", 39.5, 116.2)],
  });

  test("接起来，且相邻重复点收掉", () => {
    // BOTPO 既是 SID 的出口又是航路的第一个点 —— 那正是「衔接上了」的意思。
    // 照抄会得到一条零长度的腿，沿线标注挤在一个点上抢位置。
    const points = composeRoutePoints({
      departure: dep,
      sid,
      enroute: [
        { ident: "BOTPO", lat: 24, lon: 114, kind: "fix" },
        { ident: "ENVIP", lat: 39, lon: 116, kind: "fix" },
      ],
      star,
      arrival: arr,
    });
    expect(points.map((p) => p.ident)).toEqual([
      "ZGGG",
      "RW01L",
      "BOTPO",
      "ENVIP",
      "VYK",
      "ZBAA",
    ]);
  });

  test("只收相邻的，不全局去重", () => {
    // 一条航路合法地两次经过同一个点（等待、折返），全局去重会把中间那一段吃掉。
    const points = composeRoutePoints({
      enroute: [
        { ident: "A", lat: 1, lon: 1, kind: "fix" },
        { ident: "B", lat: 2, lon: 2, kind: "fix" },
        { ident: "A", lat: 1, lon: 1, kind: "fix" },
      ],
    });
    expect(points.map((p) => p.ident)).toEqual(["A", "B", "A"]);
  });

  test("两条无名腿不会被当成同一个点收掉", () => {
    const p = proc({
      path: [leg("", 1, 1), leg("", 2, 2)],
    });
    expect(composeRoutePoints({ sid: p })).toHaveLength(2);
  });

  test("什么都没有就是空的，不是一条假线", () => {
    expect(composeRoutePoints({})).toEqual([]);
  });
});

/**
 * 一条程序的点列**不是一条航迹**。
 *
 * NAIP 把一条 SID 的几个跑道转换和公共段全塞进同一串腿里 —— ZBAD 的 `ELKU4K` 就是
 * 这样：`AD4xx`/`AD5xx` 是各条跑道各自的转换，后面才接上公共段出到 ELKUR。整串连成
 * 一条折线画出来，是一团来回穿插的线，`ELKU4K` 这个标签沿线重复三次，而每一段本身
 * 画得都很漂亮 —— 所以看不出错。346 条 SID 和 47 条 STAR 是这样，一行最多 11 组。
 *
 * 飞行计划要画的是**实际飞的那一条**：所选跑道的转换 → 公共段 → 接得上航路的那个航路
 * 转换。不是所有转换。
 */
describe("procedureTrack", () => {
  const leg = (ident: string, transition: string | null): ProcedureLeg =>
    ({
      ident,
      lat: 39 + ident.length / 100,
      lon: 116 + ident.length / 100,
      path: "TF",
      transition,
      routeType: null,
      alt: null,
      speedKt: null,
      speedKind: null,
      turn: null,
      courseMag: null,
      vpaDeg: null,
      flyover: false,
      isMap: false,
      part: null,
    }) as ProcedureLeg;

  const elku4k: Procedure = {
    kind: "sid",
    name: "ELKU4K",
    runway: "01L",
    runways: "01L,01R,11L",
    chart: null,
    variant: null,
    points: [],
    path: [
      leg("AD551", "RW01L"),
      leg("AD557", "RW01L"),
      leg("AD531", "RW01R"),
      leg("AD532", "RW01R"),
      leg("AD430", "RW11L"),
      leg("AD456", "RW11L"),
      leg("AD535", "ALL"),
      leg("AD539", "ALL"),
      leg("ELKUR", "ALL"),
    ],
  };

  test("只画所选跑道的转换加公共段，不画别的跑道的", () => {
    const idents = procedureTrack(elku4k, { runway: "01L" }).map(
      (l) => l.ident,
    );
    expect(idents).toEqual(["AD551", "AD557", "AD535", "AD539", "ELKUR"]);
  });

  test("换一条跑道就换一组转换", () => {
    const idents = procedureTrack(elku4k, { runway: "11L" }).map(
      (l) => l.ident,
    );
    expect(idents).toEqual(["AD430", "AD456", "AD535", "AD539", "ELKUR"]);
  });

  // 没指定跑道时只画公共段 —— 随便挑一条跑道转换会画出一条这架飞机不飞的线，
  // 而它看起来和真的一模一样。
  test("没给跑道就只画公共段", () => {
    const idents = procedureTrack(elku4k, {}).map((l) => l.ident);
    expect(idents).toEqual(["AD535", "AD539", "ELKUR"]);
  });

  // navigraph 的程序一个转换都没有（33574 个点里 0 个带转换），不能因为多了分组就退化。
  test("没有转换的程序原样返回", () => {
    const plain: Procedure = {
      ...elku4k,
      path: [leg("RW01L", null), leg("GG101", null), leg("ELKUR", null)],
    };
    expect(
      procedureTrack(plain, { runway: "01L" }).map((l) => l.ident),
    ).toEqual(["RW01L", "GG101", "ELKUR"]);
  });

  // 航路转换按「接得上航路」挑。挑错等于画一条飞机不飞的线。
  test("航路转换按衔接点挑", () => {
    const withEnroute: Procedure = {
      ...elku4k,
      path: [
        leg("AD551", "RW01L"),
        leg("AD535", "ALL"),
        leg("ELKUR", "ALL"),
        leg("ELKUR", "SOTMU"),
        leg("SOTMU", "SOTMU"),
        leg("ELKUR", "AVBOX"),
        leg("AVBOX", "AVBOX"),
      ],
    };
    const idents = procedureTrack(withEnroute, {
      runway: "01L",
      enrouteFix: "SOTMU",
    }).map((l) => l.ident);
    expect(idents).toEqual(["AD551", "AD535", "ELKUR", "SOTMU"]);
  });

  // ARINC 424 的 `RW19B` 是 19L/19R 共用的那条转换。不认 B 的话它掉进航路转换那一
  // 支，选哪条 19 都画不出来，而少了的那一截看起来只像程序本来就短。
  test("RW##B 对这个号码的每一条平行跑道都算", () => {
    const both: Procedure = {
      ...elku4k,
      path: [
        leg("AD191", "RW19B"),
        leg("AD011", "RW01L"),
        leg("AD535", "ALL"),
        leg("ELKUR", "ALL"),
      ],
    };
    for (const runway of ["19L", "19R", "19C"]) {
      expect(procedureTrack(both, { runway }).map((l) => l.ident)).toEqual([
        "AD191",
        "AD535",
        "ELKUR",
      ]);
    }
    // 别的号码、以及别的跑道的转换，都不能被它带进来。
    expect(procedureTrack(both, { runway: "01R" }).map((l) => l.ident)).toEqual(
      ["AD535", "ELKUR"],
    );
    // 也不能被当成航路转换，按名字去接 `enrouteFix`。
    expect(
      procedureTrack(both, { enrouteFix: "RW19B" }).map((l) => l.ident),
    ).toEqual(["AD535", "ELKUR"]);
  });

  // STAR 反过来：航路转换在前，跑道转换在后。
  test("STAR 的顺序是反的", () => {
    const star: Procedure = {
      kind: "star",
      name: "AVBO4A",
      runway: "01L",
      runways: "01L",
      chart: null,
      variant: null,
      points: [],
      path: [
        leg("AVBOX", "AVBOX"),
        leg("GG201", "AVBOX"),
        leg("GG202", "ALL"),
        leg("GG203", "RW01L"),
      ],
    };
    const idents = procedureTrack(star, {
      runway: "01L",
      enrouteFix: "AVBOX",
    }).map((l) => l.ident);
    expect(idents).toEqual(["AVBOX", "GG201", "GG202", "GG203"]);
  });
});

/**
 * 衔接判断也不能拿整串的首末。
 *
 * `joinIdent` 回答「这条程序在哪儿接上航路」。整串的最后一个代号可能落在**跑道转换**
 * 那一组上（NAIP 里 28 条 SID 就是这样），于是界面会说「接不上」，而实际上接得上 ——
 * 一个假警报会让人手改航路串，把本来对的改错。
 */
describe("joinIdent 按转换取", () => {
  const leg = (ident: string, transition: string | null): ProcedureLeg =>
    ({
      ident,
      lat: 39,
      lon: 116,
      path: "TF",
      transition,
      routeType: null,
      alt: null,
      speedKt: null,
      speedKind: null,
      turn: null,
      courseMag: null,
      vpaDeg: null,
      flyover: false,
      isMap: false,
      part: null,
    }) as ProcedureLeg;

  test("跑道转换存在最后时，接点仍是公共段的末点", () => {
    const p: Procedure = {
      kind: "sid",
      name: "ELKU4K",
      runway: "01L",
      runways: "01L",
      chart: null,
      variant: null,
      points: [],
      path: [
        leg("AD535", "ALL"),
        leg("ELKUR", "ALL"),
        leg("AD551", "RW01L"), // 跑道转换排在后面
        leg("AD557", "RW01L"),
      ],
    };
    expect(joinIdent(p)).toBe("ELKUR");
  });

  test("STAR 取公共段的首点", () => {
    const p: Procedure = {
      kind: "star",
      name: "AVBO4A",
      runway: "01L",
      runways: "01L",
      chart: null,
      variant: null,
      points: [],
      path: [
        leg("GG203", "RW01L"), // 跑道转换排在前面
        leg("AVBOX", "ALL"),
        leg("GG202", "ALL"),
      ],
    };
    expect(joinIdent(p)).toBe("AVBOX");
  });

  // `joinsRoute` 和 `joinIdent` 必须取同一端：界面拿后者摆出「两头各是什么」，前者却
  // 按整串首末判，就会一边写着 ELKUR = ELKUR，一边喊接不上。
  test("joinsRoute 也按公共段判：SID", () => {
    const p: Procedure = {
      kind: "sid",
      name: "ELKU4K",
      runway: "01L",
      runways: "01L",
      chart: null,
      variant: null,
      points: [],
      path: [
        leg("AD535", "ALL"),
        leg("ELKUR", "ALL"),
        leg("AD551", "RW01L"),
        leg("AD557", "RW01L"),
      ],
    };
    expect(joinsRoute(p, "ELKUR")).toBe(true);
    expect(joinsRoute(p, "AD557")).toBe(false);
  });

  test("joinsRoute 也按公共段判：STAR", () => {
    const p: Procedure = {
      kind: "star",
      name: "AVBO4A",
      runway: "01L",
      runways: "01L",
      chart: null,
      variant: null,
      points: [],
      path: [leg("GG203", "RW01L"), leg("AVBOX", "ALL"), leg("GG202", "ALL")],
    };
    expect(joinsRoute(p, "avbox")).toBe(true);
    expect(joinsRoute(p, "GG203")).toBe(false);
  });
});

describe("runwayMatches", () => {
  test("B 指这个号码的所有平行跑道", () => {
    expect(runwayMatches("19B", "19L")).toBe(true);
    expect(runwayMatches("19B", "19R")).toBe(true);
    expect(runwayMatches("19B", "19C")).toBe(true);
    expect(runwayMatches("19B", "01L")).toBe(false);
    expect(runwayMatches("19B", "19")).toBe(false);
  });

  test("其余按字面比", () => {
    expect(runwayMatches("19L", "19L")).toBe(true);
    expect(runwayMatches("19L", "19R")).toBe(false);
    expect(runwayMatches("36", "36")).toBe(true);
  });

  test("servesRunway 同样认 B", () => {
    const p = { runways: "16B", runway: null } as unknown as Procedure;
    expect(servesRunway(p, "16L")).toBe(true);
    expect(servesRunway(p, "16R")).toBe(true);
    expect(servesRunway(p, "34L")).toBe(false);
  });
});

describe("转换与进近分段", () => {
  const tleg = (
    ident: string,
    transition: string | null,
    part: string | null = null,
  ) => ({ ...leg(ident, 1, 1), transition, part });

  const sid = proc({
    name: "ASUKA4",
    path: [
      tleg("RW32L", "RW32L"),
      tleg("ITE", "RW32L"),
      tleg("ASUKA", "ALL"),
      tleg("SHTLE", "SHTLE"),
      tleg("ASUKA", "ASUKA"),
      tleg("KAMEO", "ASUKA"),
    ],
  });

  test("可选的转换不含跑道转换和公共段", () => {
    expect(procedureTransitions(sid)).toEqual(["ASUKA", "SHTLE"]);
  });

  test("选定的转换压过按接入点猜的那条", () => {
    expect(
      procedureTrack(sid, {
        runway: "32L",
        enrouteFix: "KAMEO",
        transition: "SHTLE",
      }).map((l) => l.ident),
    ).toEqual(["RW32L", "ITE", "ASUKA", "SHTLE"]);
  });

  const lda = proc({
    kind: "approach",
    name: "L22",
    path: [
      tleg("BACON", "BACON", "transition"),
      tleg("BEAST", "BACON", "transition"),
      tleg("XAC", "XAC", "transition"),
      tleg("BONDO", "", "final"),
      tleg("RW22", "", "final"),
      tleg("MISSD", "", "missed"),
    ],
  });

  test("进近：转换按 part 取，复飞可去掉", () => {
    expect(procedureTransitions(lda)).toEqual(["BACON", "XAC"]);
    expect(
      procedureTrack(lda, { transition: "BACON", missed: false }).map(
        (l) => l.ident,
      ),
    ).toEqual(["BACON", "BEAST", "BONDO", "RW22"]);
    // 没选时按 STAR 终点猜。
    expect(
      procedureTrack(lda, { enrouteFix: "XAC" }).map((l) => l.ident),
    ).toEqual(["XAC", "BONDO", "RW22", "MISSD"]);
  });

  test("选了跑道就从跑道头起、到跑道头止", () => {
    const rwy = (id: string, lat: number) => ({
      id,
      opposite: null,
      hdg: null,
      lat,
      lon: 0,
      endLat: lat + 0.1,
      endLon: 0,
    });
    const points = composeRoutePoints({
      departure: { ident: "RJOO", lat: 5, lon: 5, kind: "airport" },
      departureRunway: rwy("32L", 0),
      enroute: [{ ident: "ASUKA", lat: 3, lon: 3, kind: "fix" }],
      arrivalRunway: rwy("22", 9),
      arrival: { ident: "RJTT", lat: 9, lon: 9, kind: "airport" },
    });
    expect(points.map((p) => p.ident)).toEqual(["RW32L", "", "ASUKA", "RW22"]);
    expect(points[1].shape).toBe(true);
  });
});

describe("runwayTrueBearing", () => {
  const r = {
    id: "36",
    opposite: "18",
    hdg: 5,
    lat: 0,
    lon: 0,
    endLat: 1,
    endLon: 0,
  };
  test("由坐标算，不用磁航向", () => {
    expect(runwayTrueBearing(r)).toBeCloseTo(0, 5);
    expect(runwayTrueBearing({ ...r, endLat: 0, endLon: 1 })).toBeCloseTo(
      90,
      5,
    );
  });
  test("详情里的真方位优先", () => {
    expect(
      runwayTrueBearing(r, {
        ident: "36",
        lengthM: null,
        widthM: null,
        trueBrg: 2,
        surface: null,
      }),
    ).toBe(2);
  });
});

describe("复飞段", () => {
  const tleg = (ident: string, part: string, lat: number) => ({
    ...leg(ident, lat, 0),
    transition: "",
    part,
  });
  const app = proc({
    kind: "approach",
    name: "L22",
    path: [
      tleg("BONDO", "final", 1),
      tleg("RW22", "final", 2),
      tleg("MA1", "missed", 3),
      tleg("MA2", "missed", 4),
    ],
  });

  test("接在复飞点之后，自成一段", () => {
    const points = composeRoutePoints({
      approach: app,
      arrivalRunway: {
        id: "22",
        opposite: null,
        hdg: null,
        lat: 2,
        lon: 0,
        endLat: 1.9,
        endLon: 0,
      },
    });
    expect(points.map((p) => [p.ident, p.kind])).toEqual([
      ["BONDO", "approach"],
      ["RW22", "approach"],
      ["MA1", "missed"],
      ["MA2", "missed"],
    ]);
  });

  test("没选跑道时机场只留标注，线不回到基准点", () => {
    const points = composeRoutePoints({
      approach: app,
      arrival: { ident: "RJTT", lat: 9, lon: 9, kind: "airport" },
    });
    const airport = points.find((p) => p.ident === "RJTT");
    expect(airport?.offPath).toBe(true);
    expect(points[points.length - 1].ident).toBe("MA2");
  });

  test("没有复飞段时照旧终止在机场", () => {
    const plain = proc({
      kind: "approach",
      name: "L22",
      path: [tleg("BONDO", "final", 1)],
    });
    const points = composeRoutePoints({
      approach: plain,
      arrival: { ident: "RJTT", lat: 9, lon: 9, kind: "airport" },
    });
    expect(points[points.length - 1]).toEqual({
      ident: "RJTT",
      lat: 9,
      lon: 9,
      kind: "airport",
    });
  });
});

describe("等待腿", () => {
  test("挂到同一个定位点上，不另起一个点", () => {
    const p = proc({
      kind: "approach",
      name: "I01",
      path: [
        { ...leg("MA1", 1, 1), part: "missed" },
        {
          ...leg("MA1", 1, 1),
          part: "missed",
          path: "HM",
          courseMag: 10,
          turn: "L",
        },
      ],
    });
    const points = procedureToMapPoints(p, { variation: 5 });
    expect(points).toHaveLength(1);
    expect(points[0].hold?.inboundTrue).toBe(5);
    expect(points[0].hold?.turn).toBe("L");
  });

  test("合成时被收掉的重复点把等待并给留下的那个", () => {
    const star = proc({
      kind: "star",
      name: "XAC1B",
      path: [{ ...leg("BACON", 1, 1), path: "HM", courseMag: 0 }],
    });
    const app = proc({
      kind: "approach",
      name: "L22",
      path: [leg("BACON", 1, 1)],
    });
    const points = composeRoutePoints({ star, approach: app });
    expect(points).toHaveLength(1);
    expect(points[0].hold).toBeDefined();
  });
});
