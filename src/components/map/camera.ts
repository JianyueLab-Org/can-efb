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
  /**
   * 面板盖住了哪一块。地图还没起来，或者上一次没能真的落地（见下面
   * `decidePaddingTransition` 的注释），都先记着 —— 真正落地要么在这次调用里
   * （镜头闲着，直接跟一个 easeTo），要么在下一次挪镜头（对焦、框选）开头，要么
   * 在镜头忙着的时候改走瞬间落地。
   */
  setPadding(padding: MapPadding): void;
}

function paddingKey(padding: MapPadding): string {
  return `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
}

/**
 * 内边距该怎么落地：跟动效，还是直接跳过去。纯函数，不碰 MapLibre —— 覆盖它的
 * 测试见 camera.test.ts。
 *
 * - 目标没变（`!changed`）：什么都不用做。
 * - 还没成功落地过，或者镜头这会儿正忙着别的动作（对焦、框选、用户手势）：直接
 *   跳过去（`instant`）。第一次没有「从哪儿滑过来」可言；镜头忙着的时候跟一个
 *   `easeTo` 会被那个动作的 `_stop()` 取消 —— MapLibre 6 的 `easeTo`/`flyTo`/
 *   `fitBounds` 都以 `_stop()` 开场，冻结在挪了一半的地方，而不是回到起点或者滑
 *   到终点。
 * - 其余情况（已经落地过、镜头闲着）：跟一个 `easeTo`，面板开合看起来是滑过去
 *   的。
 */
export function decidePaddingTransition(state: {
  changed: boolean;
  appliedBefore: boolean;
  mapIsMoving: boolean;
}): "skip" | "instant" | "eased" {
  if (!state.changed) return "skip";
  if (!state.appliedBefore || state.mapIsMoving) return "instant";
  return "eased";
}

/**
 * `easeTo` 收尾之后，内边距是不是真的滑到了目标 —— 决定要不要把这次落地记进
 * `lastPadding`。
 *
 * **不能只看这次 `easeTo` 有没有触发 `moveend`。** 它可能被中途插进来的另一次
 * 对焦或框选取消：MapLibre 的 `_afterEase` 对被打断的动画一样会开火
 * （`node_modules/maplibre-gl/src/ui/camera.ts` 的 `_stop` → `onEaseEnd` →
 * `_afterEase` → `fire('moveend')`），只是这时候内边距冻结在挪了一半的地方。用
 * 「镜头此刻的内边距是不是恰好等于目标」当判据，而不是「有没有收到 moveend」。
 */
export function paddingSettled(
  current: MapPadding,
  target: MapPadding,
): boolean {
  return (
    current.top === target.top &&
    current.right === target.right &&
    current.bottom === target.bottom &&
    current.left === target.left
  );
}

/**
 * 焦点从有到无：该不该把「上一次框过哪批点」作废。
 *
 * 要作废。对焦期间 `fitPoints` 不跑，`lastFitted` 还是对焦之前那批点的签名；焦点
 * 撤掉之后要框的往往正是那一批（`map:plan` 把地图拉回同一份计划），签名一样就被
 * 挡掉，镜头停在刚才对焦的地方。
 */
export function focusReleased(
  previous: MapFocus | null,
  next: MapFocus | null,
): boolean {
  return previous !== null && next === null;
}

export function createCamera(getMap: () => MapLibreMap | null): Camera {
  let lastFocus: MapFocus | null = null;
  let lastFitted = "";
  /** 上一次**确认落地**的内边距的键。空串＝从没确认落地过，见 decidePaddingTransition。 */
  let lastPadding = "";
  /**
   * 面板此刻该盖住的那一块。**镜头还没来得及坐实时也要记着** —— 地图还没起来、
   * 或者上一次跟着 `easeTo` 走的那次被取消了，都得等下一次真正挪镜头之前重新
   * 坐实一遍，见 `settlePadding`。
   */
  let targetPadding: MapPadding | null = null;

  /** 内边距真落地：跳着设，不经过 `easeTo`，所以这一下永远不会被取消。 */
  function commitPadding(map: MapLibreMap, padding: MapPadding): void {
    map.setPadding(padding);
    lastPadding = paddingKey(padding);
  }

  /**
   * 镜头要挪地方之前，先把目标内边距坐实。
   *
   * **不看 `lastPadding` 是不是已经等于目标就跳过** —— 上一次 `setPadding` 如果
   * 是跟着 `easeTo` 走的，它有没有真的滑到目标本来就不确定（可能被更早一次挪动
   * 取消过，`lastPadding` 因此仍是旧值，但也可能确实滑到了）。这里无条件重设一
   * 遍，换来的是这一下（对焦、框选）永远正确；代价很小 —— 已经在目标上时这只是
   * 一次读值不变的 `jumpTo`。
   */
  function settlePadding(map: MapLibreMap): void {
    if (targetPadding) commitPadding(map, targetPadding);
  }

  function applyFocus(focus: MapFocus | null): boolean {
    const map = getMap();
    if (!map) return false;
    if (!focus) {
      if (focusReleased(lastFocus, focus)) lastFitted = "";
      lastFocus = null;
      return false;
    }
    if (focus === lastFocus) return true;
    lastFocus = focus;
    settlePadding(map);
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

    settlePadding(map);
    const bounds = new LngLatBounds();
    for (const p of points) bounds.extend([p.lon, p.lat]);
    map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
  }

  function setPadding(padding: MapPadding): void {
    // 地图还没起来也要记着：等它起来，下一次挪镜头（applyFocus / fitPoints 开头
    // 的 settlePadding）会把这个目标坐实。
    targetPadding = padding;
    const map = getMap();
    if (!map) return;

    const key = paddingKey(padding);
    const mode = decidePaddingTransition({
      changed: key !== lastPadding,
      appliedBefore: lastPadding !== "",
      mapIsMoving: map.isMoving(),
    });
    if (mode === "skip") return;
    if (mode === "instant") {
      commitPadding(map, padding);
      return;
    }

    /* **先挂监听，再起 easeTo。** `duration: 0`（减少动态效果）时 easeTo 会同步
       跑完并同步触发 moveend —— 监听晚挂一步就会错过它。 */
    map.once("moveend", () => {
      const current = map.getPadding();
      const reached: MapPadding = {
        top: current.top ?? 0,
        right: current.right ?? 0,
        bottom: current.bottom ?? 0,
        left: current.left ?? 0,
      };
      // 只有真的滑到目标才记账，见 paddingSettled 上面的注释：这次 easeTo 可能
      // 被下一次对焦或框选打断，那时不能把它当成「设上了」——真正的补救靠上面
      // settlePadding 那一下，不靠这里。
      if (paddingSettled(reached, padding)) lastPadding = key;
    });
    // 面板开合、抽屉拖动时内容跟着滑到新的中心，而不是跳过去。减少动态效果时直接到位。
    map.easeTo({ padding, duration: prefersReducedMotion() ? 0 : 240 });
  }

  return { applyFocus, fitPoints, setPadding };
}
