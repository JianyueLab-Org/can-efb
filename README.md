# can-efb

Cerulean Aviation Network 的**电子飞行包**（Electronic Flight Bag）—— 给飞行员
在飞行前和飞行途中用的那一套：飞行计划、航路、航图、机场、气象、性能配载、检查
单、日志。

Astro SSR + Vue 岛屿 + Tailwind v4，和 can-web / can-dev / can-radar 同一套形状。

已经接上 can-api：**概览、飞行计划（含 SimBrief 导入）、气象、飞行日志、航路展
开、设置**都是真数据。**航图、机场、性能、检查单**还是占位 —— 它们没有数据源，
页面上会写清楚缺的是什么。

> **本地跑起来会看到 302。** 整站要登录，而登录态是 can-api 签在
> `.airwaysn.org` 上的 cookie，`localhost` 上拿不到，所以每个页面都会跳到主站
> 登录页。那是正确行为。不登录也能验证的两处：`/healthz` 和
> `/api/v1/metar?icao=ZBAA`。详见 [`AGENTS.md`](./AGENTS.md)。

## 快速开始

```bash
bun install
bun run dev        # http://localhost:4324
```

| 命令              | 作用                           |
| ----------------- | ------------------------------ |
| `bun run dev`     | 开发服务器（:4324）            |
| `bun run build`   | 构建到 `./dist/`               |
| `bun run preview` | 本地预览构建产物               |
| `bun run lint`    | 格式检查 + 类型检查（CI 的门） |
| `bun run format`  | prettier 格式化                |

类型检查是两步：`astro check` 看 `.astro`/`.ts`，`scripts/typecheck-vue.mjs`
（vue-tsc）看 Vue 岛屿。前者对 SFC 里的类型错误一律报 0 错误，所以两步都要跑。

## 布局：一条侧栏，没有站头

这是这个站最需要先知道的一件事 —— **它没有顶栏**。品牌、⌘K 快速跳转、主题、语
言、账户全部在左侧那条轨里；轨可以折叠成一列图标，手机上收成抽屉，由左下角的浮
动按钮拉开。

为什么这么设计、以及折叠状态为什么存在 `<html data-rail>` 上而不是组件里，写在
[`AGENTS.md`](./AGENTS.md) 和 `src/components/ui/AppRail.vue` 的注释里。**不要加
回顶栏。**

## 目录

```
deploy/k8s.yaml      jyl-tyo 上的部署（无 Secret）
language/            四本词典 zh-cn / zh-tw / en-us / ja-jp
src/
├── components/
│   ├── ui/          AppRail（外壳）、SidebarNav、Icon、ThemeLangControls
│   ├── Dashboard    概览 · FlightPlan 飞行计划 · Weather 气象
│   ├── Logbook      飞行日志 · RoutePlanner 航路 · Settings 设置
│   ├── PageHeader   页面标题区（不是站头）
│   ├── Placeholder  没有数据源的四个页面，并说明缺什么
│   └── *Script      无闪烁的主题 / 侧栏初始化
├── layouts/
│   ├── BaseLayout   <head> + 两个首屏脚本，不带外壳
│   └── AppLayout    轨 + 正文，页面都用这个
├── lib/             canApi（浏览器）、config、i18n、nav、session
├── server/canApi    SSR 调 can-api，转发 Cookie
├── middleware.ts    整站登录门
├── pages/
│   ├── api/v1/      走白名单的 can-api 同源反代
│   └── *.astro      十个页面 + 404 + healthz
└── styles/          globals.css（前 957 行同步自 can-radar）
```

加一个页面：`src/lib/nav.ts` 加一行，四本词典各加标题和说明，`src/pages/` 加一
个文件。侧栏和快速跳转会一起长出来。

更深的约定、哪些文件是从兄弟站同步来的、以及还没做的事，见
[`AGENTS.md`](./AGENTS.md)。
