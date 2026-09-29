/**
 * 署名控件。VATSpy 是 CC BY-SA 4.0，**署名是许可条款不是装饰**；机场地面数据是
 * ODbL，同样。从 RouteMap.vue 472–517 搬来，注释原样。
 */
import { AttributionControl, type Map as MapLibreMap } from "maplibre-gl";
import { escapeHtml } from "@/lib/mapText";
import { WEATHER_ATTRIBUTION } from "@/lib/weather";

export function createAttribution(
  getMap: () => MapLibreMap | null,
  source: () => { firsLabel: string; extra: string[]; weather: boolean },
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
  }

  return { apply };
}
