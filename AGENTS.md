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

仓库是 `JianyueLab-Org/can-efb`，已作为 submodule 挂在 monorepo
`CeruleanAviationNetwork` 里；CI 和 `deploy/k8s.yaml` 的镜像地址都按这个名字
写好了。改动照常在本仓库提交并推到自己的 upstream，**推完再**去根仓库移动那个
commit 指针 —— 根仓库只记录指针，指向一个没推过的 SHA 会让别人克隆出坏掉的树。

**已经接上 can-api**（会话、飞行计划读/交/撤 + SimBrief 导入、飞行统计、METAR、
航路展开）**和 can-db**（机场、航路网、导航台、空域、Grid MORA），加上 can-fsd 的
实时 datafeed（在线管制、在线航班、自己那架飞机）。

**只剩航图一页是占位**，因为那是有版权的数据，网络里没有任何一处提供它 —— 性能和
检查单两页已经删掉而不是占着。详见〈还在占位的页面〉。

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

**为什么浏览器不直连 api.ceruleanavi.net。** can-web 是直连的，因为
`ceruleanavi.net` 写在 can-api 的 `ALLOWED_ORIGINS` 里。EFB 这个域没写，加进去要
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

| 文件                                      | 说明                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/i18n.ts`                         | 除了只加载一个 `efb` 命名空间，其余逐字相同                                                                                                                                  |
| `src/lib/useOverlay.ts`                   | 焦点陷阱 / 滚动锁 / Esc                                                                                                                                                      |
| `src/components/ui/Icon.vue`              |                                                                                                                                                                              |
| `src/components/ui/ThemeLangControls.vue` | 含视图过渡的圆形擦除                                                                                                                                                         |
| `src/components/ThemeScript.astro`        | 无闪烁主题初始化                                                                                                                                                             |
| `src/components/icons.ts`                 | **前 47 个键**逐字相同；本站新增的在末尾 `can-efb only` 一段                                                                                                                 |
| `src/styles/globals.css`                  | **前 957 行**逐字等于 can-radar（Leaflet 那两百行没抄）；本站新增的在末尾 `can-efb only` 一节                                                                                |
| `src/lib/geo.ts`                          | `distanceNm` / `greatCircle` / `arc` 逐字取自 can-radar 的 `radar.ts` 与 `RadarMap.vue`                                                                                      |
| `src/lib/atc.ts`                          | `FACILITY_COLORS` / `facilityRank` / `stationAirport` / `parseFeedTime` 逐字取自 can-radar 的 `radar.ts`；`groupControllers` 是它 `RadarMap.vue` 里 `groupStations` 的列表版 |

前两个文件都按「上游部分在前、本站部分在末尾单独一节」切开，就是为了同步时可以
整段替换上半截。

`geo.ts` 是**复制**，不是共享包：两个站分属不同仓库、不同 CI，为三个纯函数拉一
条发布通道不划算。这三个函数是封闭的数学，没有产品需求会推着它们变；唯一会变的
是发现算错了，而那时两边都得改，跨仓库的包也拦不住。改之前先看 can-radar 那份。

`atc.ts` 同一个判断，但**多了一条测试兜底**（见下面〈命令〉那节）：它移过来的东
西里有一件错了看不出来 —— `logon_time` 是**没有时区标记的 UTC 墙钟**，`new Date()`
会当本地时间读，于是每个"上席多久"都偏掉观看者的时区。can-radar 那边是踩出来的，
这边靠测试钉住。

移过来时**有意没搬两样**，因为这个站的用途不同：`facilityLetter`（地图标牌上四个
字母并排用的缩写，而这里是带频率的列表，位置够写全 `GND`/`TWR`），以及
`groupStations` 里那一半地图专属的活（标牌锚点、重叠堆叠、把进近挪到它管的空域边
界上）。

**这个站自己的**：外壳（`AppRail.vue`、`SidebarNav.vue`、`RailScript.astro`、
两个 layout、`PageHeader.astro`、`Placeholder.astro`）、数据层
（`lib/canApi.ts`、`server/canApi.ts`、`lib/config.ts`、`lib/session.ts`、
`middleware.ts`、`pages/api/v1/[...path].ts`、`pages/api/db/[...path].ts`）、功能
岛屿（`Dashboard`、`FlightPlan`、`Weather`、`RoutePlanner`、`RouteGenerator`、
`Airports`、`Settings`）、地图那两件（`MapSurface.vue` 是外壳侧的常驻显示面，
`RouteMap.vue` 是画布）、以及 `lib/nav.ts`、`language/*.json`。

（这份清单里以前有 `Logbook`。那一页删掉时**词典里的 `logbook` 命名空间跟着一起
删了，模板却没有** —— 概览页底下那两块统计还在调 `t("logbook.stats.flights")`，于
是翻译器回退成把键名本身画到屏幕上。这是删一页时最容易漏的那一半：页面没了，别处
引用它的文案还在，而 i18n 的回退让它**看起来像一个真的标签**。

现在那两块统计也撤了，`/api/v1/pilot/flights` 因此没有调用方，白名单那条一并删掉
——那份文件自己的规矩是每条都要写清楚谁在用。要重新做飞行统计，连同 `logbook.*`
那批词条一起加回来。）

**`RouteMap.vue` 是这个站唯一一个不能被服务端渲染的组件**：**MapLibre GL** 在模块
顶层就摸 `window`。规矩没变，但它周围的两件事都变了，这段以前写的是旧的：

- **库是 MapLibre，不是 Leaflet。** 换库是为了标签避让和 GPU 渲染 —— 这块地图要
  把航路线、五字码、导航台、空域边界和它们的标注全叠在一起，而 Leaflet 把每个标
  注渲染成 DOM 节点、且没有碰撞检测。理由写在 `RouteMap.vue` 顶上。
- **引它的是 `MapSurface.vue`，不是 `RoutePlanner`，而且地图挂在外壳上、每一页都
  在。** 所以"解出航路才下载"那条已经不成立了：那个 chunk 现在每页都要加载，这是
  为"地图是主体"付的钱。真要把它省回来，正确的做法是让画不出东西的页面根本不渲染
  那一列，而不是把底图换成一段文字（那正是上一版被推翻的做法）。

守法仍然是同一条：`MapSurface` 用 `defineAsyncComponent` 加一个 `mounted` 守着。
静态 import 它、或者去掉那个 `v-if`，**每一个**页面都会 500 —— 不再只是 `/route`。

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

## 还在占位的页面，以及为什么

**这一节以前写的是"四个"，现在只剩一个。** 变化本身值得记下来，因为三条各有各的
结局：

- **航图 `/charts`** —— **仍然是占位**（`Placeholder.astro`，文案在
  `efb.placeholder.reasons.charts`）。有版权的数据，网络里没有任何一处提供它。
  要么授权，要么自建图源。

  注意它现在**不是一块空白**：地图挂在外壳上、每一页都在，所以打开这一页看到的是
  左边一条占位说明、右边一张真的航路图。占位说的是"没有航图 PDF"，不是"这一页什
  么都没有"。

- **机场 `/airports`** —— **已经做了**，数据来自 can-db（`Airports.vue` +
  `pages/api/db/[...path].ts`）。当初写的理由是"没有一份带跑道、频率、滑行道的机
  场库可读"，而 can-db 就是后来长出来的那一份。
- **性能 / 检查单** —— **两页删掉了**，不是还占着。理由没变（要机型手册数据、要
  按机型逐条录入，两样都不存在），但摆一个永远打不开的入口本身就是噪音：删掉比留
  一个占位诚实。想做的时候按〈导航是一份数据〉那节重新加回来即可。

**别用假数据把剩下这一个填上。** 一个摆着占位数字的仪表盘会被当成坏掉的真页面，
而不是还没做的页面 —— 飞行员会照着它做决定。同一条规矩也是**图层为空要说话**的由
来，见下。

## 图层没有数据的时候必须说出来

这是踩过的一个坑，而且它会再来。一个按需图层有三种"没东西"，以前只有一种会说话：

1. 请求失败 —— 会说（`console.error` + 退回关）
2. 权限不够（没有 `aipAccess`，每层都 401）—— **不说**，被 `deniedThisSession` 咽掉
3. **取回来是空的** —— **不说**，因为它根本不是错误：200 加一个空数组，
   `toAirwayLines` 得到 0 个要素，一路顺畅地画出一张空图

第 3 种正是线上真实发生过的：can-db 的航段 `level` 一列全是默认值，高空视图因此返
回 0 条（那个仓库的 TODO 里有整节）。而这个站的航路图层**默认就开在高空**
（`MapSurface.vue` 的 `DEFAULT_PREFS`）—— 于是打开航图，一条航路都没有，控制台一
个字都没有，看起来像**地图坏了**而不是**这一层没有数据**。

现在三种都会说话，走 `MapSurface.vue` 里的 `notice`（文案在 `map.emptyLayer.*` 和
`map.denied`）。两条规矩：

- **"空"不是"错"，所以不退回关。** 人确实点了那一层，开关就该留在那儿；退回关会
  让人以为自己没点上。失败才退回关。
- **权限那条压过按层的提示**：它一旦成立，每一层都会因为同一个原因空着，而把"这一
  层没有数据"摆在最前面会让人以为换一层就好了。

## 还没做的事（按该做的顺序）

1. ~~**上线**~~ —— **已经上线了。** `efb.ceruleanavi.net` 解析、`/healthz` 回
   200、根路径按预期 302 去主站登录页。这一条以前写着"至今不解析"，是旧的。
2. **品牌资源**。`public/favicon.svg` 现在是一块写着 EFB 的品牌色方牌，占位而
   已；轨里那块也是。正式标识到位后连同 `apple-touch-icon.png` /
   `icon-512.png` 一起补进 `BaseLayout.astro`。正式 logo 不能用
   `logo-full.png` —— 那张图上写的是旧名字。
3. **登录后跳回 EFB**。见上面 can-web `callbackUrl` 那一段：要动 can-web，且是
   一处对开放重定向敏感的改动。
4. **METAR 解码**。现在只显示原文，那是刻意的（`Weather.vue` 顶上有说明）。真
   要做，它该是一个带测试的独立模块，不是组件里的一段正则。

## 命令

```bash
bun install
bun run dev          # :4324；后台跑用 bunx astro dev --background
bun run lint         # format:check + astro check + vue-tsc + check:i18n + bun test，CI 的门就是这个
bun run test         # 只跑测试
bun run check:i18n   # 只查 t("…") 引用的键在不在词典里
bun run build
PUBLIC_ORIGIN=http://localhost:4324 bun run preview   # 预览构建产物，前缀别省
```

**这个站现在有测试了，一个文件，而且刻意只有一个。** `src/lib/atc.test.ts`
（`bun test`，零新依赖，只多一个 `@types/bun` 让 `astro check` 认得
`bun:test`）。

从前这里写着"没有测试"，那句话对**大部分**代码仍然成立：外壳和页面错了当场看得
见，给它们写测试买不到什么。破例的是 `lib/atc.ts` 里那几条 —— 它们**错了看不出
来**：

- `parseFeedTime` 把时间读偏一个时区，算出来仍然是一个像模像样的时长（在东八区
  多八小时）。屏幕上没有任何异样，can-radar 就是这么踩过来的。
- 席位顺序错了只是"排得有点怪"，而它其实是一架飞机依次要联系的顺序。
- `atisLetter` 认错一个字母，就是让人按着上一份天气做决定。

判据因此不是"重要的代码要测"，而是**"错了会不会被屏幕出卖"**：不会的那些才值得
钉一颗钉子。护栏本身验过 —— 把 `parseFeedTime` 换成 `new Date()` 那种天真写法，
这组测试当场变红（东京时区下 `12:34` 被读成 `03:34Z`）。

**留意 Bun 的模块缓存**：紧接着改完源码就跑 `bun test`，有时会拿到上一份已转译的
模块，于是"改坏了却仍然全绿"。要确认一次改动的效果，隔一次命令再跑，或者直接
`bun -e 'import("./src/lib/atc.ts").then(…)'` 把值打出来看。

### `check:i18n`：删一页时最容易漏的那一半

`scripts/check-i18n-keys.mjs` 查每个 `t("…")` 的键在 `language/zh-cn.json` 里是不
是真的存在。

**它守的是一个不报错的故障。** 翻译器查不到键时**回退成显示键名本身** —— 那个回
退本身没问题，但屏幕上会出现 `logbook.stats.flights` 这样一串东西，而它**看起来像
一个真的标签**：排版正常、旁边还有一个真的数字，四种语言下都是同一串英文。类型检
查看不见（键是字符串），构建看不见，只有人打开那一页才看得见。

概览页底下那两块统计就是这么来的：删飞行日志那一页时，词典里的 `logbook` 命名空间
跟着删了，**模板却没有**。

它只认**字面量**的键，拼出来的（`t(\`nav.${key}\`)`）查不了 —— 强行查会逼着大家把
动态键写成一长串 if。所以它的承诺是"写死的键不会挂"，不是"所有键都不会挂"。也只对
zh-cn 那本查：别的语言缺键会回退到中文，是另一回事，不该混进同一个检查。

**预览构建产物时 `PUBLIC_ORIGIN` 不能省。** 写操作要比对 Origin 头，比对的
对象是 `lib/config.ts` 里的 `origin()`，它兜底成 `https://efb.ceruleanavi.net` ——
在 localhost 上预览而不覆盖它，浏览器发出的每一个 POST / DELETE 都会被本站的反
代挡成 **403**：交计划、撤计划、退出登录、绑定 SimBrief 全都不动，而且失败得毫
无线索（curl 不带 Origin 头，所以命令行试是通的，只有浏览器会中招）。`bun run
dev` 用的是同一个 `origin()`，同样的坑，同样的加法。

**本地开发有一件事要先知道：整站要登录，而登录态来自 can-api 签在
`.ceruleanavi.net` 上的 cookie。** 所以在 `localhost` 上打开任何页面都会 302 到
`https://ceruleanavi.net/signin` —— 那是**正确行为**，不是配置坏了。要真正看到页
面，得让浏览器带着一个 can-api 认的会话 cookie 访问这个实例（例如把本地实例挂
在一个 `*.ceruleanavi.net` 的名字下，或者本地起一套 can-api）。

**不要为此加一个「开发模式假登录」开关。** 整个网络有一条明写的规矩：任何地方
都不设绕过账号（`../CLAUDE.md`，can-api 那边还有测试盯着这件事）。

不需要登录也能验证的两处：`/healthz` 回 200，`/api/v1/metar?icao=ZBAA` 会经由
本站反代拿到真实报文。

`astro check` **只看 .astro 和 .ts**，Vue SFC 里写什么它都报 0 错误 —— 而这个站
的外壳整个是 Vue。所以 `typecheck` 是两步：`astro check` 加
`scripts/typecheck-vue.mjs`（vue-tsc）。别只跑前者。

后台开发服务器用 `astro dev stop` / `status` / `logs` 管理；`astro preview` 也
会自己转到后台，对应 `astro preview stop` / `status` / `logs`。
