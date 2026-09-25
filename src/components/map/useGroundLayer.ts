/**
 * 机场地面。**没有开关，由缩放决定** —— 放大本身就是「我要看这个机场」的意思。
 *
 * 从 MapSurface.vue 搬来。它有自己的序号闸（groundSeq），和别的层不共享任何状态
 * （除了「不使用受限汇编」那一个代号），所以单独一个文件。
 */
import { ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  fetchGround,
  GROUND_MAX_AIRPORTS,
  GROUND_MIN_ZOOM,
  toGroundDrawing,
  type Ground,
} from "@/lib/ground";
import { airportsInView, fetchAirportPins } from "@/lib/airports";
import type { LayerNotice } from "@/components/map/useLayerNotice";
import type { AipGeneration, Viewport } from "@/components/map/useChartLayers";

export function useGroundLayer(options: {
  notice: LayerNotice;
  /** 见 useChartLayers 的 `AipGeneration`。 */
  aip: AipGeneration;
  text: { groundAccuracy: string };
}) {
  const { notice, aip, text } = options;

  /**
   * 机场地面。**没有开关**，由缩放决定 —— 见 `loadGroundFor`。
   *
   * 三个 ref 是一组：几何、署名、精度。后两个不是装饰 ——
   *
   *   - `groundAttribution` 是 **ODbL 的许可条款**。OSM 那份数据用了就必须署名，而
   *     它由数据决定（只有真用了 OSM 的机场才有值），所以不能写死一句挂在图上。
   *   - `groundAccuracyM` 只在画**航图线画**那份时有值。那一份位置只能信到 5–20
   *     米；分好类的那份是米级的，给它标精度反而误导。
   */
  const ground = ref<FeatureCollection | null>(null);
  const groundAttribution = ref<string[]>([]);
  const groundAccuracyM = ref(0);

  /* 已经取回来的机场地面，按 ICAO。**留着不清**：平移出去再回来是最常见的动作，
     而每个机场是兆级的几何 —— 清掉等于每次来回都重下一遍。 */
  const groundCache = new Map<string, Ground>();
  /** 这一轮画的是哪几个场，用来判断要不要重新拼 GeoJSON。 */
  let groundShown = "";
  /* 每次 `loadGroundFor` 进来就领一个号，await 回来时号不是最新的就什么都不写。
   *
   * 没有这道闸时是**最后回来的赢**，而不是最新的视野赢：慢的 A 场请求可以在之后
   * 命中缓存的 B 场之后回来，把 B 盖掉；缩到门槛以下清空之后，前一次放大时发出的
   * 请求再回来，又把地面和那句精度提示一起放回去。视野每变一次都会再调一次这里（缩
   * 回去那一支也领号），所以「号还是最新的」就等于「缩放和视野还是它看到的那个」。 */
  let groundSeq = 0;

  /**
   * 放大到门槛以上时，把视野里的机场地面补上。
   *
   * **没有图层开关，这是刻意的。** 地面只在放大之后出现，而放大本身就是"我要看这个
   * 机场"的意思 —— 再要求点一次开关，等于让人先猜到有这么个开关。缩回去它自己消
   * 失，不留状态。
   */
  async function loadGroundFor(v: Viewport) {
    const seq = ++groundSeq;
    if (v.zoom < GROUND_MIN_ZOOM) {
      // 缩回去就清空。留着不画只是省一次拼装，却会让下次放大到别处时先闪一下上一
      // 个机场的地面。
      if (ground.value) {
        ground.value = null;
        groundAttribution.value = [];
        groundAccuracyM.value = 0;
        groundShown = "";
        notice.clearNotice("ground");
      }
      return;
    }

    const gen = aip.gen;
    const pins = await fetchAirportPins();
    if (seq !== groundSeq || !pins.length) return;

    const wanted = airportsInView(pins, v).slice(0, GROUND_MAX_AIRPORTS);
    if (!wanted.length) {
      if (ground.value) {
        ground.value = null;
        groundAttribution.value = [];
        groundAccuracyM.value = 0;
        groundShown = "";
        notice.clearNotice("ground");
      }
      return;
    }

    await Promise.all(
      wanted
        .filter((p) => !groundCache.has(p.icao))
        .map(async (p) => {
          const g = await fetchGround(p.icao);
          // null = 这个场没有地面数据。`fetchGround` 自己记住了，这里不必再记 ——
          // 它不进 groundCache，所以下面拼装时自然跳过。
          if (g && gen === aip.gen) groundCache.set(p.icao, g);
        }),
    );
    // 过期的请求照样把取回来的场放进缓存（上面那行），只是不许再碰显示状态。
    if (seq !== groundSeq) return;

    const have = wanted
      .map((p) => groundCache.get(p.icao))
      .filter((g): g is Ground => !!g);

    const key = have.map((g) => g.icao).join(",");
    if (key === groundShown) return;
    groundShown = key;

    if (!have.length) {
      ground.value = null;
      groundAttribution.value = [];
      groundAccuracyM.value = 0;
      notice.clearNotice("ground");
      return;
    }

    const drawing = toGroundDrawing(have);
    ground.value = drawing.collection;
    /* 署名**必须**显示 —— OSM 那份是 ODbL，署名是许可条款不是礼貌。由数据决定而不
       是写死：只有真的用了 OSM 的机场才有值，写死会让纯扇区包的机场挂一个错误的出
       处。汇编那份的规矩正好相反（来源不能外露），所以画 lines 时这里是空的。
       这里传的是**纯文本**，转义在 RouteMap 挂署名控件那一步做（它按 HTML 渲染）。 */
    groundAttribution.value = drawing.attributions;
    /* 画的是航图线画时才说精度：那一份位置只能信到 5–20 米，而分好类的那份是米级
       的，给它标一个精度反而是误导。 */
    groundAccuracyM.value =
      drawing.kind === "lines" ? drawing.worstAccuracyM : 0;

    /* 只有画**航图线画**时才说精度。
     *
     * 分好类的那份是米级的，给它标一句「约 20 米」反而是误导。而航图那份非说不
     * 可：它画出来和图纸一样利落，看不出位置只能信到 5–20 米 —— 正是那种"看起来
     * 完全正常"的错，这个网络的文档里反复记的就是这一类。 */
    if (groundAccuracyM.value > 0) {
      notice.setNotice(
        "ground",
        text.groundAccuracy.replace(
          "{m}",
          String(Math.round(groundAccuracyM.value)),
        ),
      );
    } else {
      notice.clearNotice("ground");
    }
  }

  /**
   * 「不使用受限汇编」变了。已取回的地面是按旧值取的，全部作废；视野在门槛以上就按
   * 新值重取。代号 `aip.gen` 已经由 MapStage 加过一，路上那几次回来不会再进缓存。
   */
  function reloadAip(v: Viewport | null) {
    groundCache.clear();
    groundShown = "";
    if (v) void loadGroundFor(v);
  }

  return {
    ground,
    groundAttribution,
    loadGroundFor,
    reloadAip,
  };
}
