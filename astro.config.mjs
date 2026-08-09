// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * 电子飞行包（EFB）。和 can-web / can-dev / can-radar 同一套形状：Astro SSR
 * （standalone Node 适配器）+ Vue 岛屿 + Tailwind v4。第四个站不要自己再发明
 * 一套构建。
 *
 * `output: "server"` 现在还看不出必要 —— 眼下每个页面都是静态的外壳。它先写在
 * 这里，是因为这个站的下一步一定是「你是谁」：航图、飞行计划、检查单都是**这
 * 名飞行员自己的**东西，而会话只存在于服务端 cookie 里，预渲染的页面拿不到。
 * 等到那时才改 output，意味着连带改适配器、改部署、改 CI，而不是加一个 fetch。
 *
 * `security.checkOrigin: false` 的理由和 can-dev 逐字相同：Astro 从 `Host` 头
 * 推导本站 origin 再和浏览器的 `Origin` 比对，而这个站跑在 TLS 终止的反代后面，
 * 推出来的是 `http://…`、浏览器发的是 `https://…`，**永远对不上**，于是每一个
 * POST 都是 403。关掉不等于不检查：写操作的 Origin 要比对显式的
 * `PUBLIC_ORIGIN`（照抄 can-dev/src/lib/guard.ts），那个值反代动不了。
 */
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [vue()],
  security: { checkOrigin: false },
  vite: { plugins: [tailwindcss()] },
});
