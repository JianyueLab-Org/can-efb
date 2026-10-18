# can-efb

Cerulean Aviation Network 的**电子飞行包**（Electronic Flight Bag）—— 给飞行员
在飞行前和飞行途中用的那一套：飞行计划、航路、航图、机场、气象、性能配载、检查
单、日志。

Astro SSR + Vue 岛屿 + Tailwind v4，和 can-web / can-dev / can-radar 同一套形状。

已经接上 can-api 和 can-db：**概览、飞行计划（含 SimBrief 导入）、气象、航路
展开、设置、机场**都是真数据。**没有占位页面**：航图没有页面也没有入口 ——
有版权的数据，网络里没有一处提供；性能、检查单两页删掉了，不是占着。

> **本地跑起来会看到 302。** 整站要登录，而登录态是 can-api 签在
> `.ceruleanavi.net` 上的 cookie，`localhost` 上拿不到，所以每个页面都会跳到主站
> 登录页。那是正确行为。不登录也能验证的两处：`/healthz` 和
> `/api/v1/metar?icao=ZBAA`。详见 [`AGENTS.md`](./AGENTS.md)。

## 快速开始

```bash
bun install
bun run dev        # http://localhost:4324
```

| 命令                  | 作用                                     |
| --------------------- | ---------------------------------------- |
| `bun run dev`         | 开发服务器（:4324）                      |
| `bun run build`       | 构建到 `./dist/`                         |
| `bun run preview`     | 本地预览构建产物（:4324）                |
| `bun run lint`        | 格式检查 + 类型检查 + 测试（CI 的门）    |
| `bun run check:pages` | can-ui 登记的本站路由都在 `src/pages` 下 |
| `bun run format`      | prettier 格式化                          |

本地跑 `dev` / `preview` 时把 origin 一起给上，否则浏览器发出的写请求一律 403：

```bash
PUBLIC_ORIGIN=http://localhost:4324 bun run preview
```

原因见 [`AGENTS.md`](./AGENTS.md) 的「命令」一节 —— 写操作要比对 Origin 头，而
它兜底成生产域名。

类型检查是两步：`astro check` 看 `.astro`/`.ts`，`scripts/typecheck-vue.mjs`
（vue-tsc）看 Vue 岛屿。前者对 SFC 里的类型错误一律报 0 错误，所以两步都要跑。

## 布局：顶栏、图标轨、地图

外壳是 can-ui 的 `CanFrame`（`layout="map" rail`），由 `src/components/Frame.vue` 接入。
56px 顶栏上是品牌、跨站菜单、⌘K、通知、主题、语言、账户。
≥768px 本站导航在左边的图标轨上。
手机（<768px）没有轨，也没有标签栏；顶栏的汉堡菜单打开抽屉，里面是本站导航。
顶栏之下是铺满的地图，页面内容是浮在地图上的面板，手机上是三档底部抽屉。
详见 [`AGENTS.md`](./AGENTS.md)。

## 目录

外壳是顶栏之下一张铺满的地图，面板浮在上面。

```
deploy/k8s.yaml        jyl-tyo 上的部署（无 Secret）
language/              四本词典 zh-cn / zh-tw / en-us / ja-jp
scripts/               类型检查、词典检查、地图样式检查、底图生成
src/
├── basemap/           随站发的底图和情报区边界
├── components/
│   ├── Frame          can-ui 的 CanFrame（map + rail）：顶栏、图标轨、手机抽屉、⌘K、账户
│   ├── FloatingPanel  浮在地图上的面板；手机上是三档底部抽屉
│   ├── map/           常驻地图：MapStage、RouteMap（MapLibre，从不 SSR）、MapModeBar、MapToolbar、MapPinboard、各 use*Layer
│   ├── ui/            StateCard、PanelSection、Field、FieldGrid
│   ├── flightplan/    飞行计划页
│   ├── Dashboard      概览 · RouteTabs 航路 · Airports 机场 · Settings 设置
│   ├── PageHeader     面板里的页面标题区（不是站头）
│   └── PersistHtmlState 客户端导航时保住 <html> 上的主题
├── layouts/
│   ├── BaseLayout     <head> 和首屏脚本，不带外壳
│   └── AppLayout      Frame（面板在插槽里）+ 地图，页面都用这个；`bare` 不要面板和地图（404）
├── lib/               纯逻辑和它们的测试；mapBus 是面板到地图的通道
├── server/            SSR 调 can-api，转发 Cookie
├── middleware.ts      整站登录门
├── pages/
│   ├── api/v1/        走白名单的 can-api 同源反代
│   ├── api/db/        走白名单的 can-db 同源反代
│   └── *.astro        五个页面 + 404 + healthz
└── styles/globals.css 设计系统来自 can-ui；本站规则在 import 之后
```

加一个页面：`src/lib/nav.ts` 加一行，四本词典各加标题和说明，`src/pages/` 加一
个文件。图标轨、手机抽屉和 ⌘K 会一起长出来。

更深的约定、哪些文件是从兄弟站同步来的、以及还没做的事，见
[`AGENTS.md`](./AGENTS.md)。
