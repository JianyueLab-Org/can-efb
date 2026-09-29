/**
 * 降水图层：OpenWeather 的降水瓦片，经 can-api、再经本站同源反代。
 *
 * 和别的 `use*Layer` 不同，这一层不取数：瓦片由 MapLibre 按视野自己取（source 在
 * `lib/chartStyle.ts`），这里只管开关、偏好和失败。RouteMap 收 `weather` 这个布尔值
 * 去切 `visibility`，瓦片取失败时经 `weatherError` 事件报回来。
 *
 * 失败（503：can-api 没配 key 或额度用完；502：连不上）照图层的规矩办：退回关、挂
 * 一条带「重试」的提示（`useLayerNotice` 的 `failure`）。偏好不改，下次打开页面还会再
 * 试 —— 和空域那几层失败时一样。
 */
import { ref } from "vue";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import type { LayerNotice } from "@/components/map/useLayerNotice";

export interface WeatherLayerOptions {
  /** MapStage 持有的那一份偏好。 */
  prefs: LayerPrefs;
  notice: LayerNotice;
}

export function useWeatherLayer(options: WeatherLayerOptions) {
  const { prefs, notice } = options;
  const showWeather = ref(false);

  function toggleWeather(on = !showWeather.value) {
    prefs.weather = on;
    writePrefs(prefs);
    showWeather.value = on;
    if (!on) notice.clearFailure("weather");
  }

  /**
   * 瓦片没取到。一次就够：503 意味着这一屏每一张都会失败，等它们一张张报完只会刷一
   * 屏控制台。已经关着就不再报（关掉之前在路上的那几张）。
   */
  function fail() {
    if (!showWeather.value) return;
    showWeather.value = false;
    notice.noteFailure("weather");
  }

  function retry() {
    notice.clearFailure("weather");
    showWeather.value = true;
  }

  function restore(saved: LayerPrefs) {
    if (saved.weather) showWeather.value = true;
  }

  return { showWeather, toggleWeather, fail, retry, restore };
}
