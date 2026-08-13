# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在这个仓库里工作时提供指引。

## 这是什么

**can-efb** —— Cerulean Aviation Network 的**电子飞行包**（Electronic Flight
Bag），给飞行员在飞行前和飞行途中用的那一套东西：飞行计划、航路、航图、机场、
气象、性能配载、检查单、日志。

它是这个网络里**第四个** Astro 站，形状和前三个（can-web / can-dev /
can-radar）刻意保持一致 —— Astro SSR（standalone Node 适配器）+ Vue 岛屿 +
Tailwind v4，Bun 装包。开发端口 **4324**（4321 can-web、4322 can-dev、
4323 can-radar）。

**已经接上 can-api**：会话、飞行计划（读/交/撤 + SimBrief 导入）、飞行日志、
METAR、航路展开、航图都是真数据。还有三个页面仍是占位 —— 机场、性能、检查
单 —— 它们不是没写，是**没有数据源**，占位组件会把缺的那一样说出来。

和 can-dev / can-radar 一样，这个站**一行数据库凭据都不该有**，而且比它们更进
一步：**一个 Secret 都没有**。can-dev 要注册 OAuth 应用、要 client secret 和
session secret；这个站不参与 OAuth，会话由 can-api 签在父域上，它只负责把
cookie 转发回去。哪天有人要在这里加 Secret，先确认那件事不能靠转发 cookie 完成。

## 这个站没有站头，这是整个布局的前提

**不要加回顶栏。** 凡是会被放进顶栏的东西 —— 品牌、⌘K 快速跳转、主题、语言、
账户 —— 都在左侧那条轨里（`src/components/ui/AppRail.vue`）。

理由：EFB 是在飞行途中看的，屏幕多半是横放的平板或者副屏，**竖直方向是最紧张
的资源**。一条 64px 的顶栏在 1280×800 上吃掉 8% 的高度，而它装的每一样东西在
侧栏里都放得下 —— 侧栏紧张的是水平方向，而那正是这条轨可以收成一列图标的原因。

由此带来三个后果，都在 AppRail 里解决了，改动之前先读那里的注释：

1. **手机上没有地方挂汉堡按钮**，所以左下角有一颗浮动按钮拉开抽屉。放左下是因
   为没有顶栏时那里离拇指最近，右下留给将来的页面级动作。
2. **⌘K 快速跳转**不能跟着顶栏一起消失，它现在是轨里品牌下面的第一件东西，折
   叠态退化成一个放大镜方块。
3. **主题 / 语言 / 账户在轨脚**，靠 `mt-auto` 撑下去而不是绝对定位 —— 导航长到
   要滚动时它得跟着滚走，而不是盖住最后一个链接。

页面自己的标题、说明和动作按钮走 `src/components/PageHeader.astro`。它渲染的
`<header>` 是**页面级**的标题区，不是站头，两者不要混为一谈。

### 折叠状态为什么不在组件的 state 里

轨可以在 17rem 和 4.75rem 之间折叠。折叠要同时改两个东西：轨自己的宽度，和正
文那一列的左内边距。而正文是 Astro 渲染的静态 HTML，和 AppRail 这个 Vue 岛屿之
间**没有响应式通道** —— 用 props 传就得把整页塞进岛屿，那样每个页面都要为外壳
付一次水合代价。

所以状态存在 `<html data-rail>` 上，两边都从同一个 CSS 变量取值：

- `src/components/RailScript.astro` —— 首屏绘制**之前**从 localStorage 读出来写
  好。晚一步就是布局跳动：正文会横向平移 12rem，和主题闪烁是同一类毛病。
- `src/styles/globals.css` 末尾的 `can-efb only` 一节 —— `--rail-current`、
  `.app-rail`、`.app-main-offset`、以及折叠态下的 `.rail-item` / `.rail-label`。
- `AppRail` 挂载时把 `data-rail` **读回来**当作初始值，而不是第二次去读
  localStorage：两处各判断一次就会有两个可能不一致的答案。

那两条折叠规则的选择器里 `.app-rail` 是必须的：手机抽屉渲染的是同一批组件、带
着同一批 `.rail-*` 类，少了这层限定，桌面收起轨之后抽屉里的导航也会跟着只剩图
标，而抽屉是全宽的。

## 数据：全部经由 can-api，浏览器只打同源

三层，各管一件事：

| 文件                            | 谁用         | 干什么                                 |
| ------------------------------- | ------------ | -------------------------------------- |
| `src/server/canApi.ts`          | SSR / 中间件 | 直连 can-api，**转发进来的 Cookie 头** |
| `src/pages/api/v1/[...path].ts` | 浏览器       | 走**白名单**的同源反代                 |
| `src/lib/canApi.ts`             | 岛屿         | 打上面那个反代，拆信封，把失败变成值   |

**为什么浏览器不直连 api.airwaysn.org。** can-web 是直连的，因为
`airwaysn.org` 写在 can-api 的 `ALLOWED_ORIGINS` 里。EFB 这个域没写，加进去要
改 can-api 的部署环境变量并重启 —— 同源反代让这个站今天就能跑，一行 can-api 都
不用动，顺带也不需要 CORS。can-radar 代理 `/track` 和 `/metar` 是同一个理由。

**白名单是重点，不是修饰。** 通配转发等于在这里重建当年拆掉的网关。每一条都写
了谁在用；`/api/v1/atis` 和 `/api/v1/track` 被**特意排除**并写明了原因，加回来
之前先读那两句。

**会话这个站不验证，只转发。** token 的格式、密钥和有效期都是 can-api 的。
中间件 (`src/middleware.ts`) 每个请求问一次 `/api/v1/auth/session`，答案放进
`Astro.locals.user`。

**整站要登录，没有 PROTECTED_PREFIXES 那样一份清单** —— 清单的意义在于区分公开
页和受保护页，而 EFB 一页公开的都没有。例外只有两条，写在 `isUnguarded()` 里：
`/api/*`（自己有白名单，而且调用方要状态码不要 302）和 `/healthz`（探活必须能
在 can-api 挂掉时照样回 200，否则上游一抖 kubelet 就把这边的 Pod 一起滚掉）。

**没登录就跳 can-web 的登录页，而且不带 callbackUrl。** can-web 的 `/signin`
只接受站内绝对路径，那是一道防开放重定向的检查，传一个 `https://efb…` 过去只会
被丢掉、回落到 `/pilots`。要让成员登录完回到 EFB，得先在 can-web 那边显式放行这
个域 —— 那是对钓鱼很敏感的改动，属于 can-web 的评审范围，不该在这里绕过去。

**校验规则不在前端重写。** 飞行计划的 422 带着逐字段的 `fields`，界面只负责把
它落到对应输入框下面。抄一份正则过来，两边迟早分叉，而分叉的方向一定是前端放行
了后端拒绝的东西。同理 409 `tracked`（雷达标牌被管制员占着，计划归他改）要整个
锁上表单并说清是谁。

## 哪些文件是从兄弟站抄来的，不要在这里另开一版

下面这些和 can-web / can-dev / can-radar **逐字相同**。要改共有的行为，改在
can-web 再同步过来 —— 四个站各改各的，正是当初统一掉的那个毛病：

| 文件                                      | 说明                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/lib/i18n.ts`                         | 除了只加载一个 `efb` 命名空间，其余逐字相同                                                   |
| `src/lib/useOverlay.ts`                   | 焦点陷阱 / 滚动锁 / Esc                                                                       |
| `src/components/ui/Icon.vue`              |                                                                                               |
| `src/components/ui/ThemeLangControls.vue` | 含视图过渡的圆形擦除                                                                          |
| `src/components/ThemeScript.astro`        | 无闪烁主题初始化                                                                              |
| `src/components/icons.ts`                 | **前 47 个键**逐字相同；本站新增的在末尾 `can-efb only` 一段                                  |
| `src/styles/globals.css`                  | **前 957 行**逐字等于 can-radar（Leaflet 那两百行没抄）；本站新增的在末尾 `can-efb only` 一节 |
| `src/lib/geo.ts`                          | `distanceNm` / `greatCircle` / `arc` 逐字取自 can-radar 的 `radar.ts` 与 `RadarMap.vue`       |

前两个文件都按「上游部分在前、本站部分在末尾单独一节」切开，就是为了同步时可以
整段替换上半截。

`geo.ts` 是**复制**，不是共享包：两个站分属不同仓库、不同 CI，为三个纯函数拉一
条发布通道不划算。这三个函数是封闭的数学，没有产品需求会推着它们变；唯一会变的
是发现算错了，而那时两边都得改，跨仓库的包也拦不住。改之前先看 can-radar 那份。

**这个站自己的**：外壳（`AppRail.vue`、`SidebarNav.vue`、`RailScript.astro`、
两个 layout、`PageHeader.astro`、`Placeholder.astro`）、数据层
（`lib/canApi.ts`、`server/canApi.ts`、`lib/config.ts`、`lib/session.ts`、
`middleware.ts`、`pages/api/v1/[...path].ts`）、七个功能岛屿
（`Dashboard`、`FlightPlan`、`Weather`、`Logbook`、`RoutePlanner`、`Charts`、
`Settings`）、两个懒加载组件（航路地图 `RouteMap.vue`、航图阅读器
`ChartViewer.vue`）、`lib/nav.ts`、`language/*.json`。

**`RouteMap.vue` 和 `ChartViewer.vue` 是这个站仅有的两个不能被服务端渲染的组
件**，两个都用 `defineAsyncComponent` 引入，静态 import 或者给它们加
`client:load` 都会让对应的页面直接 500。

`RouteMap.vue`：Leaflet 在模块顶层就摸 `window`。它由 `RoutePlanner` 引入，并且
只在真的解出航路之后才渲染 —— 于是那 152 KB 的 chunk 只在用了这个功能的人身上
产生流量（15 KB 的 leaflet.css 仍然随页面走，Vite 会把异步 chunk 的样式提到
`<head>`）。`ChartViewer.vue` 是同一件事，理由更硬 —— 见下面「航图」一节。

`SidebarNav.vue` 虽然形状来自 can-web，但把可折叠的 `children` 换成了**扁平分
节** —— 理由见 `src/lib/nav.ts`：轨能收成图标态，而手风琴在图标态下没有讲得通
的交互（点一个图标是展开还是跳转？）。

## 导航是一份数据

加一个页面 = 在 `src/lib/nav.ts` 里加一行 + 在四本词典里加两条文案 +
`src/pages/` 下加一个文件。侧栏和 ⌘K 一起长，不需要分别改。

`nav.ts` 里写的是 i18n 的**键**，文案在 `buildNav(t)` 里解析 —— 岛屿拿到的必须
是已经翻好的字符串。

## i18n

四种语言：`zh-cn`（默认）、`zh-tw`、`en-us`、`ja-jp`，词典在根目录 `language/`。
cookie 名是 **`NEXT_LOCALE`**，Next.js 时代留下来的；四个站共用一个父域，所以在
主站上选的语言到这里仍然有效 —— 那正是它值得保留原名的原因。

只有一个命名空间 `efb`：这个站不共享站头页脚（它根本没有），所以从 can-web 镜
像 `header`/`footer` 的规矩在这里不适用。

传进岛屿的是 `getMessages(locale, "efb")` 这一本，不是整本词典 —— 岛屿的 props
会原样序列化进每个页面的 HTML。

## 航图

图放在 can-api 的 R2 桶里，这个站三条路由都走反代：
`charts/airports`（有图的机场）、`charts?icao=`（一个机场的图册）、
`charts/{id}/file`（图的字节）。

**这三条在 can-api 那边都要会话，而且都不带 scope**，所以没有任何 OAuth 应用能
拿到整个图库。

但**那是这三条路由的性质，不是那批对象的性质**：航图和题库配图共用一个挂了
`cdn.airwaysn.org` 的桶，而航图的键是 `charts/<AIRAC>/<ICAO>/<CATEGORY>/…` 这种
推得出来的形状 —— 知道规则的人不经过 can-api 也能取到图。这是那边刻意选的部署
方式，前因后果写在 can-api 的 `config.Config.Charts` 上。在这里记一笔只为一件
事：**别在「反正要会话」这个前提上做判断。**

这个页面上没有「下载全部」「导出」这类入口，也不该加 —— 那和上面那条无关，是因
为这个界面不该主动帮人把一整份 AIP 打包带走。

**字节是转发的，不是预签名 URL。** 预签名 URL 就是塞在 query 里的一个 bearer
token，会留在历史记录和截图里、过期前收不回来。转发多一跳，换来这个站自己这条
路每个请求都验一次会话。

三件这边特有的事：

1. **`ChartViewer.vue` 是这个站第二个不能被服务端渲染的组件**，理由和
   `RouteMap.vue` 一样但更硬：pdf.js 在模块顶层就摸 `window` 和 `Worker`。它由
   `Charts.vue` 用 `defineAsyncComponent` 引入 —— 页面本身 7.9 KB，阅读器那
   431 KB 和 worker 那 1.26 MB 只落在真的点开了某张图的人身上。静态 import 它
   会让 `/charts` 直接 500。
2. **反代白名单多了一条正则**（`ALLOW_PATTERNS`）。取图的地址里有一个 id，精确
   匹配放不下。**没有**把它放宽成 `charts/` 前缀匹配：那会把 can-api 将来任何
   `/charts/...` 的路由一起放出去，包括还没写的那些。加第二条之前先想清楚同样
   的问题。
3. **取图那一条的超时是单独的**（`DOWNLOAD_TIMEOUT`，180 秒，默认那条是 15
   秒）。默认值对一个回 JSON 的接口是宽裕的上限，对一份三兆的进近图是一把铡
   刀 —— 而且铡的是成员那边：字节是流着走的，浏览器读得慢，背压一路顶回上游，
   机场 wifi 上一份大图会在 15 秒整被切断，看起来像图坏了。

上传是把文件放进桶，然后在 can-api 跑一次 `go run ./cmd/sync-charts --apply`。
键的约定（`charts/<AIRAC>/<ICAO>/<CATEGORY>/<NN>-<title>.<ext>`）就是全部
schema，桶是事实，那张表只是索引。

**周期要显示出来。** 每份图册都带着 AIRAC，界面上必须看得见 —— 一张不知道是哪
一期的进近图比没有图更危险。

## 三个还是占位的页面，以及为什么

不是没写，是**没有数据源**。`Placeholder.astro` 会把缺的那一样显示出来，文案在
`efb.placeholder.reasons.*`：

- **机场** —— 没有一份带跑道、频率、滑行道的机场库可读。`Sector/` 和 `Ground/`
  里有一部分，但那是 EuroScope 的格式，要先有接口把它喂出来。
- **性能** —— 要机型手册的数据。不在 can-api 里，也不该由这个站凭空编。
- **检查单** —— 要按机型逐条录入，数据本身还不存在。

**别用假数据把它们填上。** 一个摆着占位数字的仪表盘会被当成坏掉的真页面，而不
是还没做的页面 —— 飞行员会照着它做决定。

航图原本也在这份名单上，理由是「有版权的数据，网络里没有任何一处提供它」。它是
怎么毕业的值得记一笔：**缺的从来不是代码，是一个我们有权提供的图源。** 上面三
条也一样。

## 还没做的事（按该做的顺序）

1. **仓库还没有 remote**，也还没作为 submodule 挂进上级 monorepo。挂之前先建
   GitHub 仓库（`JianyueLab-Org/can-efb`）并推上去 —— 根仓库只记录 submodule 的
   commit 指针，指向一个没推过的 SHA 会让别人克隆出一个坏掉的树。CI 和
   `deploy/k8s.yaml` 里的镜像地址都已经按这个名字写好了。
2. **上线前的两件外部事项**：把 `efb.airwaysn.org` 接进 Cloudflare 隧道，确认
   can-api 的会话 cookie 域覆盖 `.airwaysn.org`。**不需要**动 can-api 的
   `ALLOWED_ORIGINS`（浏览器从不直连它）。
3. **品牌资源**。`public/favicon.svg` 现在是一块写着 EFB 的品牌色方牌，占位而
   已；轨里那块也是。正式标识到位后连同 `apple-touch-icon.png` /
   `icon-512.png` 一起补进 `BaseLayout.astro`。正式 logo 不能用
   `logo-full.png` —— 那张图上写的是旧名字。
4. **登录后跳回 EFB**。见上面 can-web `callbackUrl` 那一段：要动 can-web，且是
   一处对开放重定向敏感的改动。
5. **METAR 解码**。现在只显示原文，那是刻意的（`Weather.vue` 顶上有说明）。真
   要做，它该是一个带测试的独立模块，不是组件里的一段正则。

## 命令

```bash
bun install
bun run dev          # :4324；后台跑用 bunx astro dev --background
bun run lint         # format:check + astro check + vue-tsc，CI 的门就是这个
bun run build
PUBLIC_ORIGIN=http://localhost:4324 bun run preview   # 预览构建产物，前缀别省
```

**预览构建产物时 `PUBLIC_ORIGIN` 不能省。** 写操作要比对 Origin 头，比对的
对象是 `lib/config.ts` 里的 `origin()`，它兜底成 `https://efb.airwaysn.org` ——
在 localhost 上预览而不覆盖它，浏览器发出的每一个 POST / DELETE 都会被本站的反
代挡成 **403**：交计划、撤计划、退出登录、绑定 SimBrief 全都不动，而且失败得毫
无线索（curl 不带 Origin 头，所以命令行试是通的，只有浏览器会中招）。`bun run
dev` 用的是同一个 `origin()`，同样的坑，同样的加法。

**本地开发有一件事要先知道：整站要登录，而登录态来自 can-api 签在
`.airwaysn.org` 上的 cookie。** 所以在 `localhost` 上打开任何页面都会 302 到
`https://airwaysn.org/signin` —— 那是**正确行为**，不是配置坏了。要真正看到页
面，得让浏览器带着一个 can-api 认的会话 cookie 访问这个实例（例如把本地实例挂
在一个 `*.airwaysn.org` 的名字下，或者本地起一套 can-api）。

**不要为此加一个「开发模式假登录」开关。** 整个网络有一条明写的规矩：任何地方
都不设绕过账号（`../CLAUDE.md`，can-api 那边还有测试盯着这件事）。

不需要登录也能验证的两处：`/healthz` 回 200，`/api/v1/metar?icao=ZBAA` 会经由
本站反代拿到真实报文。

`astro check` **只看 .astro 和 .ts**，Vue SFC 里写什么它都报 0 错误 —— 而这个站
的外壳整个是 Vue。所以 `typecheck` 是两步：`astro check` 加
`scripts/typecheck-vue.mjs`（vue-tsc）。别只跑前者。

后台开发服务器用 `astro dev stop` / `status` / `logs` 管理；`astro preview` 也
会自己转到后台，对应 `astro preview stop` / `status` / `logs`。
