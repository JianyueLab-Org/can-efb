/**
 * 降水图层：OpenWeather 的降水瓦片，经 can-api、再经本站同源反代。
 *
 * 和别的 `use*Layer` 不同，这一层不取数：瓦片由 MapLibre 按视野自己取（source 在
 * `lib/chartStyle.ts`），这里只管开关、偏好、刷新和失败。RouteMap 收 `weather` 这个
 * 布尔值去切 `visibility`，收 `weatherBucket` 去换瓦片地址；每张瓦片的结果经
 * `weatherTile` 事件报回来。
 *
 * 失败：单张瓦片失败只让那一张空着。整层挂了（`lib/weather.ts` 的
 * `noteWeatherTile`：`not_configured`，或一阵加载里失败 ≥ 3 张且没有成功）才照图层
 * 的规矩办：退回关、挂一条带「重试」的提示（`useLayerNotice` 的 `failure`）。偏好
 * 不改，下次打开页面还会再试 —— 和空域那几层失败时一样。
 *
 * 刷新：开着且页面可见时，每到墙上时钟的十分钟边界把 `weatherBucket` 换成新桶。页面
 * 隐藏时不走计时器；重新可见时如果跨过了边界，立刻换。关着时不刷新。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import {
  msUntilNextBucket,
  noteWeatherTile,
  weatherBucket as bucketAt,
  type WeatherBurst,
  type WeatherTileOutcome,
} from "@/lib/weather";
import type { LayerNotice } from "@/components/map/useLayerNotice";

export interface WeatherLayerOptions {
  /** MapStage 持有的那一份偏好。 */
  prefs: LayerPrefs;
  notice: LayerNotice;
}

export function useWeatherLayer(options: WeatherLayerOptions) {
  const { prefs, notice } = options;
  const showWeather = ref(false);
  /** 当前时间桶，RouteMap 据此换瓦片地址。 */
  const weatherBucket = ref(bucketAt(Date.now()));

  let burst: WeatherBurst | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function visible(): boolean {
    return typeof document === "undefined" || !document.hidden;
  }

  function stopTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  /** 换到此刻的桶（变了才换），再排到下一个边界。关着或隐藏时只停表。 */
  function sync() {
    stopTimer();
    if (!showWeather.value || !visible()) return;
    const now = Date.now();
    const bucket = bucketAt(now);
    if (bucket !== weatherBucket.value) {
      weatherBucket.value = bucket;
      burst = null;
    }
    timer = setTimeout(sync, msUntilNextBucket(now));
  }

  function turnOn() {
    burst = null;
    showWeather.value = true;
    sync();
  }

  function turnOff() {
    showWeather.value = false;
    stopTimer();
  }

  function toggleWeather(on = !showWeather.value) {
    prefs.weather = on;
    writePrefs(prefs);
    if (on) {
      turnOn();
    } else {
      turnOff();
      notice.clearFailure("weather");
    }
  }

  /** 一张瓦片的结果。整层挂了才关。已经关着就不再记（关掉之前在路上的那几张）。 */
  function noteTile(outcome: WeatherTileOutcome) {
    if (!showWeather.value) return;
    const next = noteWeatherTile(burst, outcome, Date.now());
    burst = next.burst;
    if (!next.down) return;
    turnOff();
    notice.noteFailure("weather");
  }

  function retry() {
    notice.clearFailure("weather");
    turnOn();
  }

  function restore(saved: LayerPrefs) {
    if (saved.weather) turnOn();
  }

  onMounted(() => document.addEventListener("visibilitychange", sync));
  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", sync);
    stopTimer();
  });

  return {
    showWeather,
    weatherBucket,
    toggleWeather,
    noteTile,
    retry,
    restore,
  };
}
