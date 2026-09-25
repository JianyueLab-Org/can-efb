/**
 * 镜头：对焦、框选、内边距。
 *
 * 从 RouteMap.vue 543–546、644–687 搬来，再加上 `setPadding`。三件事共享一个前
 * 提 —— **只在输入真的变了的时候动镜头**：render() 被实时数据每 30 秒触发一次，
 * 每次都动镜头的话，正在平移或放大看机场的人会被一次次拽回去，以为地图坏了。
 */
import { LngLatBounds, type Map as MapLibreMap } from "maplibre-gl";
import { prefersReducedMotion } from "@jianyuelab-org/can-ui/motion";
import type { MapFocus } from "@/lib/mapBus";
import type { MapPadding } from "@/lib/panelLayout";
import type { RoutePoint } from "@/lib/routeGeometry";

export interface Camera {
  /** 有焦点就对过去（只在焦点对象换了的时候），并返回 true，调用方据此不再框选。 */
  applyFocus(focus: MapFocus | null): boolean;
  /** 把这批点框进可见区（只在这批点换了的时候）。 */
  fitPoints(points: RoutePoint[]): void;
  /** 面板盖住了哪一块。地图还没起来时先记着，起来之后由调用方再给一次。 */
  setPadding(padding: MapPadding): void;
}

export function createCamera(getMap: () => MapLibreMap | null): Camera {
  let lastFocus: MapFocus | null = null;
  let lastFitted = "";
  let lastPadding = "";

  function applyFocus(focus: MapFocus | null): boolean {
    const map = getMap();
    if (!map) return false;
    if (!focus) {
      lastFocus = null;
      return false;
    }
    if (focus === lastFocus) return true;
    lastFocus = focus;
    if (focus.kind === "point") {
      map.easeTo({
        center: [focus.lon, focus.lat],
        zoom: Math.max(map.getZoom(), focus.zoom ?? 7),
      });
    } else {
      map.fitBounds(
        [
          [focus.west, focus.south],
          [focus.east, focus.north],
        ],
        { padding: 48, maxZoom: 10 },
      );
    }
    return true;
  }

  function fitPoints(points: RoutePoint[]) {
    const map = getMap();
    if (!map) return;

    // **航路网不参与框选**：它是全国的图，把它算进去等于每次都缩到最小。视野
    // 该跟着你正在看的东西走，而不是跟着背景参考走。
    if (!points.length) {
      lastFitted = "";
      return;
    }

    /* **只在这批点真的换了的时候框选一次。**
     *
     * 和上面 `focus` 那道防护是同一件事，只是当时没有人踩到：`render()` 会被实时
     * 图层每 30 秒触发一次，而 `points` 从前只在用户主动做了什么之后才有值 —— 于是
     * 「每次 render 都 fitBounds」看起来没问题。
     *
     * 地图开始默认画已提交的飞行计划之后它就不成立了：概览页上那条航路一直在，于是
     * **每半分钟把镜头拽回航路**，正在平移或放大看机场的人会以为地图坏了。放大看地
     * 面的时候尤其明显 —— 刚凑近跑道就被拉回去。
     *
     * 签名用代号加坐标：同一条航路重新解析一次（对象换了、内容没变）不该重新框选。 */
    const signature = points
      .map((p) => `${p.ident}:${p.lat},${p.lon}`)
      .join("|");
    if (signature === lastFitted) return;
    lastFitted = signature;

    const bounds = new LngLatBounds();
    for (const p of points) bounds.extend([p.lon, p.lat]);
    map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
  }

  function setPadding(padding: MapPadding) {
    const map = getMap();
    if (!map) return;
    const key = `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
    if (key === lastPadding) return;
    lastPadding = key;
    // 面板开合、抽屉拖动时内容跟着滑到新的中心，而不是跳过去。减少动态效果时直接到位。
    map.easeTo({ padding, duration: prefersReducedMotion() ? 0 : 240 });
  }

  return { applyFocus, fitPoints, setPadding };
}
