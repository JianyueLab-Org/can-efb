/**
 * 署名控件。VATSpy 是 CC BY-SA 4.0，**署名是许可条款不是装饰**；机场地面数据是
 * ODbL，同样。从 RouteMap.vue 472–517 搬来，注释原样。
 */
import { AttributionControl, type Map as MapLibreMap } from "maplibre-gl";
import { escapeHtml } from "@/lib/mapText";
import { WEATHER_ATTRIBUTION } from "@/lib/weather";

/**
 * 可见区窄于这个宽度时署名收成「i」按钮。
 *
 * 署名在地图容器的右上角，模式条在可见区的左上角。可见区窄（手机、平板、桌面上的
 * wide 面板）时两者在同一行，展开的署名压在模式条底下，一半字读不到。收起后点「i」
 * 仍是全文，许可要求的署名没有少。
 */
const EXPANDED_MIN_PX = 768;

export function createAttribution(
  getMap: () => MapLibreMap | null,
  source: () => { firsLabel: string; extra: string[]; weather: boolean },
  /** 地图可见区的宽度（容器减去左右内边距）。还不知道时是 null。 */
  visibleWidth: () => number | null,
) {
  let control: AttributionControl | null = null;

  function baseAttribution(firsLabel: string): string {
    return (
      `${escapeHtml(firsLabel)} ` +
      '<a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
      'target="_blank" rel="noreferrer">VATSpy</a> (CC BY-SA 4.0) · ' +
      // 在线进近的范围来自 SimAware（`lib/atcCoverage.ts`），can-radar 同样署名。
      '<a href="https://github.com/vatsimnetwork/simaware-tracon-project" ' +
      'target="_blank" rel="noreferrer">SimAware</a> · ' +
      "Natural Earth"
    );
  }

  function apply() {
    const map = getMap();
    if (!map) return;
    if (control) {
      map.removeControl(control);
      control = null;
    }
    const { firsLabel, extra, weather } = source();
    /* 随数据来的那几行**当纯文本**：`customAttribution` 按 HTML 渲染，而这些串来自
       can-db 的地面数据，不是我们写的 —— 原样拼进去等于让数据往页面里插标签。 */
    const lines = extra.filter(Boolean).map(escapeHtml);
    // OpenWeather 那一行只在降水层开着时挂。它是我们写的串，按 HTML 进。
    const head = weather
      ? [baseAttribution(firsLabel), WEATHER_ATTRIBUTION]
      : [baseAttribution(firsLabel)];
    control = new AttributionControl({
      compact: true,
      customAttribution: [...head, ...lines].join(" · "),
    });
    map.addControl(control, "top-right");
    // 右上角是署名在上、缩放和指北针在下。MapLibre 把上方两个角的新控件接在末尾，
    // 署名每次重挂都会掉到缩放下面，所以挂完挪回第一个。
    const corner = map
      .getContainer()
      .querySelector(".maplibregl-ctrl-top-right");
    const attrib = corner?.querySelector(".maplibregl-ctrl-attrib");
    if (corner && attrib && corner.firstElementChild !== attrib) {
      corner.prepend(attrib);
    }
    fit();
  }

  /**
   * 按可见区宽度展开或收起。MapLibre 的 `compact` 挂上时总是展开、拖一下地图才收，
   * 它自己的判据是整个容器宽，不知道面板盖住了多少。内边距变了要再调一次。
   */
  function fit() {
    const map = getMap();
    const width = visibleWidth();
    if (!map || width === null) return;
    map
      .getContainer()
      .querySelector(".maplibregl-ctrl-attrib.maplibregl-compact")
      ?.classList.toggle("maplibregl-compact-show", width >= EXPANDED_MIN_PX);
  }

  return { apply, fit };
}
