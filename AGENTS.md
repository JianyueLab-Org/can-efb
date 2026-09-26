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

**没有航图页面**，因为那是有版权的数据，网络里没有任何一处提供它；性能和检查单
两页也删了，不是占着。详见〈没有占位页面〉。

和 can-dev / can-radar 一样，这个站**一行数据库凭据都不该有**，而且比它们更进
一步：**一个 Secret 都没有**。can-dev 要注册 OAuth 应用、要 client secret 和
session secret；这个站不参与 OAuth，会话由 can-api 签在父域上，它只负责把
cookie 转发回去。哪天有人要在这里加 Secret，先确认那件事不能靠转发 cookie 完成。

## 外壳：地图铺满，面板浮在上面

外壳是**一张铺满窗口的地图**，轨和面板都是浮在它上面的玻璃（`.glass`，材质取
can-ui 的 `--material-regular` / `--material-blur-regular`）。以前是**轨 | 面板 |
地图**三栏，地图只拿剩下的宽度 —— 1280 上四成，1024 上比轨还窄。现在地图永远是整
个窗口，面板挡住的那一块用**内边距**让出来：

- 面板每次改变位置或大小，`lib/panelController.ts` 发一条 `panel:layout`（`mapBus`
  上，新订阅者会收到上一条）。`MapStage` 用 `lib/panelLayout.ts` 的 `mapPaddingFor`
  算出内边距交给 MapLibre，所以「居中」「框住航路」都是对**没被挡住的那一块**说的。
- 面板宽度由页面声明：`standard`（26rem，列表和短表单）或 `wide`（44rem，飞行计划、
  设置）。平板上 wide 退回 standard。
- 面板可以收起成一条（`inert` 挡住里面的 Tab），地图跟着把内边距收回去。

### mapBus：只有面板 → 地图，没有反向

面板和地图是两个独立岛屿，中间没有父组件，通道是 `window` 上的 CustomEvent
（`lib/mapBus.ts`）。**方向只有一种**：地图从不向面板发消息，防止两个岛屿互相
改对方的状态。

- `efb:map`（`publishToMap`）—— 要连成线的点（`points`）、只标点不连线的标注
  （`markers`）、地图角上的说明。
- `panel:layout`（`efb:panel-layout`，`announcePanelLayout`）—— 面板此刻盖住哪一
  块，见上；新订阅者会收到上一条。
- `map:focus`（`efb:map-focus`，`focusMap`）—— 把镜头对到一个点或一个框；非有限
  数的目标被 `isMapFocus` 挡在发送之前，不会让地图飞去 NaN。
- `map:plan`（`efb:map-plan`，`showPlanOnMap`）—— 「地图，回到我已提交的那份计
  划」，地图自己向 can-api 读，不吃面板带的内容；Dashboard 打开时、FlightPlan 都
  用它把地图拉回自己这份计划。收到时清掉别处留下的焦点和标注；图上不是计划时，
  面板推来的点和角标也清掉。
- `efb:plan-changed`（`announcePlanChanged`）—— 「成员的计划交了或撤了」，不带内
  容。飞行计划页交、撤都不导航，地图收到后自己重读计划。

### 三种排布，断点只写在 CSS 里

| 宽度       | `--shell-mode` | 轨                 | 面板                              |
| ---------- | -------------- | ------------------ | --------------------------------- |
| ≥1152px    | `desktop`      | 展开（或按偏好）   | 左侧浮卡，standard / wide         |
| 768–1151px | `tablet`       | 默认收起（`auto`） | 左侧浮卡，恒为 standard           |
| <768px     | `phone`        | 没有，换底部标签栏 | 底部抽屉：收起 72px / 半屏 / 全屏 |

768 和 1152 **只写在 `globals.css` 的媒体查询里**。JS 要知道当前排布就读
`--shell-mode`（`parseShellMode`），要知道轨的默认就读 `--rail-auto`
（`effectiveRail`）—— 不写 `matchMedia`。以前 RouteMap 自己写过一份
`matchMedia("(min-width: 1024px)")`，改断点时两份分叉，那是没人查得到的毛病。

手机的抽屉按 can-ui 的 `projectToDetent` 吸附到三档之一，拖动时越界有阻尼
（`rubberbandClamp`），焦点进入抽屉时展开到全屏，免得输入框被键盘和地图夹住。

### 面板里的多列排布按容器判，不按视口判

面板声明成 `container-type: inline-size`（容器名 `efb-panel`），里面的网格用
`@sm:` / `@md:` 这种容器前缀，表单用 `FieldGrid`（面板 ≥36rem 才分两列）。用视口
前缀的话，1440 的屏上 standard 面板也会被排成两列，每列不到 200px。

## 这个站没有站头，这是整个布局的前提

**不要加回顶栏。** 凡是会被放进顶栏的东西 —— 品牌、⌘K 快速跳转、主题、语言、
账户 —— 都在左侧那条轨里（`src/components/AppRail.vue`）。

理由：EFB 是在飞行途中看的，屏幕多半是横放的平板或者副屏，**竖直方向是最紧张
的资源**。一条 64px 的顶栏在 1280×800 上吃掉 8% 的高度，而它装的每一样东西在
侧栏里都放得下 —— 侧栏紧张的是水平方向，而那正是这条轨可以收成一列图标的原因。

由此带来三个后果，都在 AppRail 里解决了，改动之前先读那里的注释：

1. **手机上没有轨**，换成底部标签栏：五个导航项一行，拇指够得着。主题、语言、账
   户和跨站链接在设置页最底下（`.phone-only`），那是它们在手机上唯一的家。
2. **⌘K 快速跳转**不能跟着顶栏一起消失，它现在是轨里品牌下面的第一件东西，折
   叠态退化成一个放大镜方块。
3. **主题 / 语言 / 账户在轨脚**，靠 `mt-auto` 撑下去而不是绝对定位 —— 导航长到
   要滚动时它得跟着滚走，而不是盖住最后一个链接。

页面的标题和说明由 `FloatingPanel.astro` 用 `PageHeader.astro` 渲染，页面只传
`title` / `description`。它渲染的 `<header>` 是**页面级**的标题区，不是站头，两者
不要混为一谈。

### 折叠状态为什么不在组件的 state 里

轨可以在 17rem 和 4.75rem 之间折叠。`data-rail` 有三个值：`expanded`、`collapsed`、
`auto`。`auto` 是**没存过偏好**：桌面展开、平板（768–1151px）收起，由 CSS 在媒体
查询里给 `--rail-auto` 赋值。JS 要知道此刻实际是哪一种，用 `lib/panelLayout.ts`
的 `effectiveRail(data-rail, --rail-auto)`，不自己写断点。手机上没有轨，换成底部
标签栏。

折叠要同时改两个东西：轨自己的宽度，和正文那一列的左内边距。而正文是 Astro 渲
染的静态 HTML，和 AppRail 这个 Vue 岛屿之间**没有响应式通道** —— 用 props 传就
得把整页塞进岛屿，那样每个页面都要为外壳付一次水合代价。

所以状态存在 `<html data-rail>` 上，两边都从同一个 CSS 变量取值：

- `src/components/RailScript.astro` —— 首屏绘制**之前**从 localStorage 读出来写
  好，没存过就写 `auto`。晚一步就是布局跳动：正文会横向平移 12rem，和主题闪烁是
  同一类毛病。
- `src/styles/globals.css` 末尾的 `can-efb only` 一节 —— `--rail-current`、
  `.app-rail`，以及折叠态下的 `.rail-item` / `.rail-label`。给轨让位的是
  `.floating-panel` 自己按 `--rail-current` 让开，不是一个专门的外壳类。（这里
  以前还列着 `.app-main-offset`，那是**第一版外壳**的类，三栏外壳上线后就没有
  使用者了，已经删掉；全仓没有任何 `.vue` / `.astro` 还在用它。）
- `AppRail` 挂载时把 `data-rail` **读回来**当作初始值，而不是第二次去读
  localStorage：两处各判断一次就会有两个可能不一致的答案。
- 之后它用 `MutationObserver` **一直跟着** `data-rail`，设置页那个开关也一样。
  两处都只写 `data-rail`，不互相改对方的 state —— `data-rail` 是唯一的来源。

那两条折叠规则的选择器里保留 `.app-rail` 限定：`data-rail` 挂在 `<html>` 上，这一层
让规则只作用于轨本身，别处出现的 `.rail-*` 不受折叠态影响。

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

**can-db 那个代理还负责补缓存头**（`pages/api/db/[...path].ts`）。can-db 自己一个
`Cache-Control` 都不发，所以浏览器对那几百 KB 的航路网没有任何缓存依据，每次整页刷
新都重下一遍。补的是 `private, max-age=600`，两个词都别改：

- **`private`** —— 这些是按 `aipAccess` 分级的资料，里面有受限的官方 AIP 材料。少
  了它，路上任何一层共享缓存都可能把高级别成员的响应发给低级别的人，等于把权限判断
  绕过去。
- **十分钟而不是一天** —— 数据一个 AIRAC 周期才变，按内容算能缓存很久，但**重导是
  随时可能发生的**（此刻正好欠着一次）。缓存久了，修好之后成员还会继续看那张旧图。

只给成功的响应加：给 401 或 502 加缓存，等于让一次权限变更或一次上游抖动被记住十分
钟。这和 can-radar 给 METAR 补五分钟是同一条思路 —— 上游没说，而我们知道它多久变。

**浏览器打 `/api/db/*` 一律走 `lib/naip.ts` 的 `dbFetch`。** 设置页「不使用受限汇编」
（3 级起才显示）是全站一个开关，**默认开**，存 localStorage，只有明确存了 `"0"` 才
显示 NAIP；开着时 `dbFetch` 给每个请求加
`unrestricted=1`，can-db 把级别压到 2。新加的调用直接 `fetch` 就会漏掉它。按模块缓存
的数据用 `aipScope()` 当键，地图 `watch(hideNaip)` 作废并重取开着的图层。

**会话这个站不验证，只转发。** token 的格式、密钥和有效期都是 can-api 的。
中间件 (`src/middleware.ts`) 每个请求问一次 `/api/v1/auth/session`，答案放进
`Astro.locals.user`。

**整站要登录，没有 PROTECTED_PREFIXES 那样一份清单** —— 清单的意义在于区分公开
页和受保护页，而 EFB 一页公开的都没有。例外只有两条，写在 `isUnguarded()` 里：
`/api/*`（自己有白名单，而且调用方要状态码不要 302）和 `/healthz`（探活必须能
在 can-api 挂掉时照样回 200，否则上游一抖 kubelet 就把这边的 Pod 一起滚掉）。

**没登录就跳 can-web 的登录页，现在会带上 callbackUrl。** 这一段以前写的是「不
带」，理由是 can-web 的 `/signin` 只接受站内绝对路径（一道防开放重定向的检查），
跨站地址传过去只会被丢掉、回落 `/pilots`。**那个前提已经不成立**：can-web 现在有
一份显式白名单（`src/lib/callbackUrl.ts`），这个域在名单上。

线上验得到：`https://efb.ceruleanavi.net/` 未登录时 302 去
`…/signin?callbackUrl=https%3A%2F%2Fefb.ceruleanavi.net%2F`。

`signInUrl(returnTo)` 里有一条不能省：**回跳地址用 `origin()` 拼，不用
`returnTo.origin`** —— 这个站跑在 TLS 终止的反代后面，从请求 URL 推出来的 origin
是 `http://`，那既配不上白名单里的 `https://`（于是被拒、回落 `/pilots`，白做一
场），也会把成员从 https 降到 http。

**校验规则不在前端重写。** 飞行计划的 422 带着逐字段的 `fields`，界面只负责把
它落到对应输入框下面。抄一份正则过来，两边迟早分叉，而分叉的方向一定是前端放行
了后端拒绝的东西。同理 409 `tracked`（雷达标牌被管制员占着，计划归他改）要整个
锁上表单并说清是谁。

## 哪些文件是从兄弟站抄来的，不要在这里另开一版

下面这些和 can-web / can-dev / can-radar **逐字相同**。要改共有的行为，改在
can-web 再同步过来 —— 四个站各改各的，正是当初统一掉的那个毛病：

| 文件                       | 说明                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/i18n.ts`          | 除了只加载一个 `efb` 命名空间，其余逐字相同                                                                                                                                  |
| `src/styles/globals.css`   | 设计系统来自 `@jianyuelab-org/can-ui/styles`（一行 import）；本站新增的在其后 `can-efb only` 一节                                                                            |
| `src/lib/geo.ts`           | `distanceNm` / `greatCircle` / `arc` 逐字取自 can-radar 的 `radar.ts` 与 `RadarMap.vue`                                                                                      |
| `src/lib/atc.ts`           | `FACILITY_COLORS` / `facilityRank` / `stationAirport` / `parseFeedTime` 逐字取自 can-radar 的 `radar.ts`；`groupControllers` 是它 `RadarMap.vue` 里 `groupStations` 的列表版 |
| `src/lib/firTable.ts`      | can-radar 的 `lib/firs.ts`，对照表改成 `?url` 引入，多一个测试用的 `useFirTable`                                                                                             |
| `src/lib/atisSectors.ts`   | 逐字取自 can-radar，测试一起                                                                                                                                                 |
| `src/lib/airportCodes.ts`  | can-radar 的同名文件，对照表 `?url` 引入，多一个测试用的 `useAirportCodes`，没搬 `fieldCandidates`                                                                           |
| `src/lib/airportCoords.ts` | can-radar 的 `lib/airports.ts`，改名避开本站的 `lib/airports.ts`                                                                                                             |
| `src/lib/traffic.ts`       | 高度色带 / `altitudeBand` / `isOnGround` / `flightLevel` 逐字取自 can-radar 的 `radar.ts`（它又源自 vatsim-radar）                                                           |

`Icon`、`ThemeLangControls`、`ThemeScript`、`useOverlay` 不在这张表里：本地那几份拷贝
（`components/ui/Icon.vue`、`components/ui/ThemeLangControls.vue`、
`components/ThemeScript.astro`、`lib/useOverlay.ts`）已经删掉，四个都改成从
`@jianyuelab-org/can-ui` 引入，`icons.ts` 那份键表也随 `Icon` 一起删了。

`globals.css` 按「上游部分在前、本站部分在末尾单独一节」切开，就是为了同步时可以
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

### 管制范围照 can-radar 画（`lib/atcCoverage.ts`）

判据和 can-radar 的 `RadarMap.vue` 一致，改先改那边再同步。

| 席位                                     | 画法                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| 区域 / FSS / controllers 里的 facility 7 | VATSpy 边界，呼号按 `lib/firTable.ts` 最长前缀对上；UIR 一对多 |
| 进近                                     | SimAware 进近多边形，`ZBAA_S_APP` 先找 `ZBAA_S` 再找 `ZBAA`    |
| 没有进近多边形的进近                     | 点 + 视野半径虚线圈，封顶 400 NM                               |
| 放行 / 地面 / 塔台                       | 点                                                             |
| 对不上任何范围的                         | 点，不吞掉                                                     |

- ATC info 的 `Covering sector - T30` 只画那几个扇区；`Extending - ZGZU` 按同一席位后缀再对一次，FSS 不扩（`lib/atisSectors.ts`）。
- 一个 id 有陆上、洋区两块时，`_FSS` 取洋区，其余取陆上。
- 标注「呼号 频率」：区域在第一块边界外接框中心，进近在多边形最北顶点，扩出去的那块标扩出去的呼号（本人在线时不标）。
- 放行 / 地面 / 塔台 / 进近写了 `Extending - ZSSS`：在那个场再标一个同席位呼号的点（`ZSPD_TWR` → `ZSSS_TWR`，`ZSPD_APP` → `ZSSS_APP`），坐标取机场表；进近另外画那个场的进近多边形。三字码经 `lib/airportCodes.ts` 落到 ICAO，标牌写 ICAO；备用写法（`IsPseudo=1`）只给场面席位认。那个场已有人登着同一席位时不标。
- ATIS（`feed.atis`，按数组认，不按 facility）画成琥珀色的点，不画范围不画圈；Extending 同上（`ZSPD_ATIS` → `ZSSS_ATIS`）。不算进管制按钮的角标数。

数据在 `src/basemap/atc/`：`boundaries.geojson`、`firs.json`（VATSpy，含扇区划分）、`tracon.geojson`（SimAware）、`airports.json`（机场坐标）、`airport-codes.json`（三字码 → ICAO）。五份是 can-radar `public/` 下同名文件的拷贝，由它的 `scripts/build-vatspy.mjs` 生成，在那边刷新再拷过来。情报区图层用的 `src/basemap/firs.json` 是另一份，筛掉了扇区划分，不用于这一层。进近多边形 2.7 MB，只在有进近在线或 Covering 名字需要时取；两张机场表只在区域 / FSS 以外的席位或 ATIS 写了 Extending 时取。

点地图上的席位（点、标注、区域或进近范围；范围圈不接点击）弹出详情卡 `components/map/AtcDetails.vue`，内容照 can-radar 的 `RadarDetails.vue`：管制区 / 覆盖扇区 / 延伸席位 / 频率 / 成员 / 等级 / 在线时长，加 ATC info 或 ATIS 原文。点空处收起，席位下线时跟着消失。卡片是地图岛屿自己的浮层，不经 mapBus。每个要素带 `station`（原席位呼号），Extending 出去的点也指回原席位。

这一层不依赖边界图层的开关。测试在 `lib/atcCoverage.test.ts`。

### 概览的起降天气：本网 ATIS 优先

起降机场有本网 ATIS 在线（`feed.atis`，按呼号第一段对机场，`lib/atc.ts` 的 `atisForAirport`），天气卡显示 ATIS，不取 METAR。没有才取 `/api/v1/metar`。METAR 等 datafeed 回来再决定取不取；datafeed 失败时照常取。

### 在线机组按高度分色（`lib/traffic.ts`）

`ALTITUDE_STEPS`、两套 viridis 色带、`altitudeBand`、`isOnGround`、`flightLevel`
同样逐字取自 can-radar（它又是从 vatsim-radar 移的）。**颜色承载高度**：一屏几十架
同色三角只看得出"有人在"，分色之后一眼分得出谁在爬升、谁在巡航。两个站用同一套色
带，也就是同一份读图习惯。

**这套色带跟主题走，席位色不跟。** viridis 有深浅两条，切主题要一起换；而席位色是
身份编码，两套主题下必须是同一个红。两者都由 `buildStyle(theme)` 给出：色带按主题
取，席位色两套相同。

三处判断有测试钉着：

- **`altitudeBand` 里的 `-100` 不是笔误。** 真实巡航高度大量正好压在档位线上
  （25000 / 30000 / 35000），少了它，几十英尺的抖动就让一架巡航中的飞机反复换色 ——
  而屏幕上看起来只是"闪"，不像 bug。
- **`isOnGround` 缺地速时当作在地面**，不是在飞。判错的方向有讲究：当成在地面只是画
  小一号，当成在飞会让一架不知道状态的飞机在巡航层里显眼地标出来。
- **`flightLevel` 一千英尺以下写整数英尺**，`FL003` 不是任何人读高度的方式，而进离
  场阶段的低高度恰恰最值得标。

地面上的飞机画小一号、压淡到 0.45，**不是隐藏**：一个大机场停着几十架全叠在一个点
上会把周围的航路糊掉，但它们仍然在，只是让位。航班标注（呼号 + 高度层）**7 级以上才
出现且不标地面的** —— 原来完全不标，理由是"满屏呼号会把航图盖掉"，那句话在全国视野
下对，放大到看一个机场时就不对了，而 MapLibre 自带碰撞检测。

### 实时那两层是**两个**开关

`traffic`（机组）和 `atcLive`（管制）各一个，**共用一次取数和一个定时器** —— datafeed
是一份文档，两层都从它来。两个都关才停轮询。

这里原来是一个「实时」开关管三层，注释的理由是「拆开也省不下任何请求」。**那句话只
算了请求，没算屏幕**：省不省请求确实一样，但一屏几十架飞机和几块铺满的管制区是两种
不同的噪音，想看航路时要关掉的往往只是其中一样。

**自己那架跟着机组走**（它是机组的一员），所以关掉机组时「定位到我」那颗按钮也跟着
消失 —— 按下去没反应比没有按钮更让人怀疑。

偏好键叫 `atcLive` 而不是 `atc`，是为了不和空域那三个开关里的 `ctr`/`app` 混：那三
个画的是**空域划分**（静态资料），这一个画的是**谁在线**（实时）。

**这个站自己的**：外壳（`AppRail.vue`、`SidebarNav.vue`、`RailScript.astro`、
`FloatingPanel.astro` + `lib/panelController.ts`、两个 layout、`PageHeader.astro`）、
数据层（`lib/canApi.ts`、`server/canApi.ts`、`lib/config.ts`、`lib/session.ts`、
`middleware.ts`、`pages/api/v1/[...path].ts`、`pages/api/db/[...path].ts`）、页面
岛屿（每页一个：`Dashboard`、`flightplan/FlightPlan`、`RouteTabs`、`Airports`、
`Settings`）、共用的状态与表单件（`components/ui/`：`StateCard`、`PanelSection`、
`Field`、`FieldGrid`）、地图（`components/map/`：`MapStage.vue` 是外壳侧的常驻显示
面，四个 `use*Layer` 各管一类图层，`RouteMap.vue` 是画布），以及 `lib/nav.ts`、
`language/*.json`。

（这份清单里以前有 `Logbook`。那一页删掉时**词典里的 `logbook` 命名空间跟着一起
删了，模板却没有** —— 概览页底下那两块统计还在调 `t("logbook.stats.flights")`，于
是翻译器回退成把键名本身画到屏幕上。这是删一页时最容易漏的那一半：页面没了，别处
引用它的文案还在，而 i18n 的回退让它**看起来像一个真的标签**。

现在那两块统计也撤了，`/api/v1/pilot/flights` 因此没有调用方，白名单那条一并删掉
——那份文件自己的规矩是每条都要写清楚谁在用。要重新做飞行统计，连同 `logbook.*`
那批词条一起加回来。）

**`RouteMap.vue` 是这个站唯一一个不能被服务端渲染的组件**：**MapLibre GL** 在模块
顶层就摸 `window`。引它的是 `MapStage.vue`，不是 `RoutePlanner`，而且地图挂在外壳
上、每一页都在。所以"解出航路才下载"那条已经不成立了：那个 chunk 现在每页都要加
载，这是为"地图是主体"付的钱。真要把它省回来，正确的做法是让画不出东西的页面根本
不渲染那一列，而不是把底图换成一段文字（那正是上一版被推翻的做法）。

守法仍然是同一条：`MapStage` 用 `defineAsyncComponent` 加一个 `mounted` 守着。
静态 import 它、或者去掉那个 `v-if`，**每一个**页面都会 500 —— 不再只是 `/route`。

`SidebarNav.vue` 虽然形状来自 can-web，但把可折叠的 `children` 换成了**扁平分
节** —— 理由见 `src/lib/nav.ts`：轨能收成图标态，而手风琴在图标态下没有讲得通
的交互（点一个图标是展开还是跳转？）。

## 航图样式（`lib/chartStyle.ts`）

地图的外观全部在 `src/lib/chartStyle.ts`。`RouteMap.vue` 只读它，不写颜色、线宽、门槛。

| 常量 / 函数                  | 内容                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `COLORS`                     | 浅色、夜间两套颜色，各自写全，不做反色。语义色同色相，只调明度          |
| `ZOOM`                       | 每类要素从哪一级出现。`useChartLayers` 的取数门槛也读它                 |
| `WIDTH` / `OPACITY`          | 线宽、透明度，`[缩放, 值]` 锚点                                         |
| `TEXT` / `ICON`              | 字号、图标尺寸                                                          |
| `SHIELD`                     | 航路代号牌的字外留白                                                    |
| `AIRSPACE`                   | 空域平涂透明度、斜线图块参数、危险区虚线                                |
| `MAJOR_AIRPORT_MIN_RUNWAY_M` | 主要机场门槛（最长跑道，米），默认 2500                                 |
| `buildStyle(theme)`          | 整份 MapLibre 样式                                                      |
| `themedProperties(theme)`    | 每个图层的每个 paint / layout 属性；`RouteMap` 切主题时比对后设，无清单 |

席位色（`lib/atc.ts`）和高度色带（`lib/traffic.ts`）不在 `COLORS` 里。

外观照 Jeppesen 高低空航路图：浅色是白陆地、浅蓝海、低饱和的蓝灰航路、绿色虚线情报区
边界；夜间同结构，深灰底、浅灰线和字，语义色同色相调明度。

**图层顺序**，自下而上：底图 → 机场地面 → 空域填充 → 空域和情报区边界 → 航路 →
计划航线 → 航路点 / 导航台 / 机场符号 → 标注 → 在线机组 → 自己的航迹 → 自己。

**标注优先级**靠图层顺序（MapLibre 先放上面的）：机场 > 导航台 > 航路代号牌 > 航
路点 > 经纬网度数；同层内用 `symbol-sort-key`。除 `own` 和 `route-labels` 外所有标注
参与避让。标注层带一份透明的同款图标，下面的标注绕开符号。密度由避让决定，门槛不为
防挤往后推。

**默认缩放门槛**（z5–6 约等于 50 NM 比例尺）：

| 要素                   | 符号      | 标注                                 |
| ---------------------- | --------- | ------------------------------------ |
| 经纬网 10° / 5° / 1°   | 0 / 4 / 6 | 同线                                 |
| 主要机场               | 4         | 5                                    |
| 其余机场               | 6         | 6                                    |
| 跑道线（接替机场符号） | 9         | 11                                   |
| 高空航路（high、both） | 5         | 代号牌 5                             |
| 低空航路（low）        | 5         | 5                                    |
| VOR 一族               | 5         | 5 识别码；7 起「台名 D 频率 识别码」 |
| NDB、DME、未知台型     | 6         | 6                                    |
| 航路点                 | 5         | 5                                    |
| 禁区、限制区、危险区   | 5         | 5                                    |

禁区、限制区、危险区图层默认开（`mapPrefs.ts`），门槛是 `ZOOM.specialUse`，写在
`specialUseVisible` 里；CTR / APP 仍默认关，开了就画，不设门槛。

**写进 `filter` 的门槛必须是整数**：filter 里的 `["zoom"]` 按瓦片整数级求值。小数只
用在 `minzoom` 和 paint 里。测试钉着。

**航路代号牌**：`airway-labels` 每段一个（`line-center`），段比牌短就不放。圆角矩形
可拉伸图（`addImage` 的 `stretchX/stretchY/content`）配 `icon-text-fit: both`，顺线
转、保持正向。RNAV 蓝底白字，常规深底白字（夜间浅灰底深字）。

**RNAV 判定是启发式**（`lib/airways.ts` 的 `isRnavDesignator`）：can-db 没有 RNAV 标
记。去掉一个 ICAO 前缀（`U` / `K` / `S`，后面跟字母才算），首字母在 `RNAV_LETTERS`
（`L M N P Q T Y Z`，加中国的 `W V X`）里就是 RNAV。`W V X` 和 ICAO 的分类不一致，
是产品决定。

**航路点和导航台去重**（`markNavaidFixes`）：ident 相同且经纬度差都 ≤ 0.01° 的航路点
打上那个台的 `tier`，样式在那个台画出来的缩放上把航路点藏掉。导航台图层关着时不打。

**情报区标注**是「代号 名字」（`RKRR INCHEON`），照 Jeppesen 沿边界线写在自己那一
侧，共用边界上两边的名字并排：`lib/firs.ts` 的 `firLabelEdges` 把每条边在别的环的顶
点处切开，按「两侧各是谁」连成朝东走的段，每段一个标注。两侧都有区时是两行、骑在线
上（`inside: both`），只有一侧时按 `inside` 上下偏移；沿线每 400 px 重复。两边拆成两
个要素会错开：`line` 放置的第一个锚点按字长算。图层关着 `text-keep-upright`，地图转
过去时字会倒，但不会写进邻区。名字是
`scripts/build-firs.mjs` 从 VATSpy `[FIRs]` 取的 `name`（最后一段，去掉 `FIR`/`ACC`），
拼接出来的 `RJJJ` 写死 `Fukuoka`。没有名字只写代号。

**符号**在 `lib/chartIcons.ts` 用 canvas 画，两套主题各一份，颜色画进图里。画布按
符号实际大小裁，`icon-size` 留在 1 附近。航路点空心三角；VOR 六边形、VOR/DME 方框套
六边形、DME 方框、NDB 点环；机场蓝色小圆，主要机场实心、其余空心。飞机是 SDF
（`icon-color` 着色）。注册的图片名由 `chartStyle.test.ts` 对照 `allImageIds()`。

**分类映射**在 `lib/aip.ts`：`navaidClass`（can-db 的 `kind`：`VOR/DME`、`VOR`、
`DME`、`NDB`；`TACAN`、`VORTAC` 预留）和 `airspaceClass`（`restricted` 族的 `P` 禁
区 / `R` 限制区 / `D` 危险区）。禁区、限制区画斜线；危险区画虚线边加淡平涂。

**航路只有一个开关。** 高低空一起取（`fetchAirwayNetwork`）：can-db 的响应不带层
级，按 `?level=high` 和 `?level=low` 各取一次，两边都有的记为 `both`。`high`、`both` 和 `low` 都从 z5 起画（`ZOOM.airwaysHigh` / `ZOOM.airwaysLow`）。航路点取连着它的航段里最高的一级。旧偏好
`airway: "off" | "high" | "low"` 在 `readPrefs` 里折算成 `airways: boolean`。

**机场地面**在 `lib/ground.ts`。z9 起按机场取 can-db 的
`/aip/airports/{ICAO}/ground`，视野里只取最近的 4 个场。数据只有一份：扇区包手工
做的要素，源自 OSM，由 Ground 仓库维护。按 `kind` 分层画：道肩（`shoulder`，面，
机坪色）、航站楼与机坪、机位、滑行道与等待位置；跑道标志（`runway_marking`，面，白
色）在跑道之上，和机位号同一级才出；单点要素画圆点。`taxiway_label` 是挂不上滑行道
线的代号，一个点，只出字（`ground-labels-way-point`）。`shoulder` 和
`runway_marking` 在 `geometryFor` 里出 Polygon，其余多点要素出 LineString。画了地面就在署名控件里显示
`© OpenStreetMap contributors (ODbL)`，can-db 没给 `attribution` 时用
`GROUND_ATTRIBUTION`。

**主要机场**由 `/aip/runways` 算（`airportRunwaySummary`），所以机场和跑道在
`ZOOM.airportMajor` 一起取。

**自己的航迹**在 `lib/ownTrack.ts`，从 30 秒轮询攒，只活在本次会话；换呼号、断开超
过 3 分钟、平均地速超过 1200 kt 时重新开始，最多 720 个点。不走 `/api/v1/track`。

**校验**：`check:style` import `buildStyle`，两套主题各验一次。`chartStyle.test.ts`
钉图层顺序、两套主题结构一致、引用的图片都已注册、按缩放的过滤结果、filter 门槛为整
数。

## 跑道与进离场程序（`lib/procedures.ts` + `ProcedurePicker.vue`）

规划器（can-db）已经替你挑了一条 SID 和一条 STAR，依据是**航路从哪个点接进网
络**。它挑不了跑道 —— 跑道由管制员按风向定，不在飞行计划里。选择器补的正是那一
半：先选跑道，再在这条跑道服务的程序里挑，然后画出来。

**没有为此新开接口。** 走的是 can-db 已有的机场详情 `/api/v1/aip/airports/{ICAO}`
—— 它本来就带 `runways` 和 `procedures`，而 `procedures[].path` 里每条腿自带坐标
和约束，正好是「选跑道 → 筛程序 → 画出来」三步全部需要的东西。顺带被带来的机
位、通信、ILS 是多付的，认了：为省那点另开一条 `/procedures`，代价是 can-db 一次
改动、一次部署、一次 pin 移动，换来同一批数据的第二种形状。真嫌大的那天，正确的
做法是给现有这条加 `?include=`，不是新开一条。

浏览器那条路因此在 can-db 反代的白名单里多了一条正则
（`^aip/airports/[A-Za-z]{4}$`），形状和 `/ground` 那条收得一样死。

### 用在哪里、存在哪里

选择器在两页：航路生成（`RouteGenerator`，它自己把合成的航线推给地图）和飞行计划
（`FlightPlan`，改 SID/STAR 时改写表单里的航路串）。
概览页的计划卡片只读，列出本机为这对起降机场存的选择，并标明它不在提交的计划里。

选择按起降机场对存在 localStorage（`lib/procedureSelection.ts`）：起降跑道、SID、
STAR、进近，各自的转换。can-api 的计划里没有这几项。换设备就没有了。

地图上的已提交计划（`useRouteLayer`）和飞行计划页的预览都经 `lib/planProcedures.ts`
的 `applySelection`：选了哪一项就替换 `aip/resolve` 展开的那一段，没选的保持原样。
选择变了发 `PROCEDURES_CHANGED_EVENT`，两处都重画。

- 选了跑道：离场从跑道头沿跑道画到另一头再接 SID；进场终止在跑道头。
- 转换：没选时按航路接入点猜（SID/STAR 按 `enrouteFix`，进近按 STAR 终点）。选了只
  认名字。
- 进近的腿带 `part` 时按 part 分段：`transition` 是可选的转换，`missed` 是复飞段。
  复飞段接在复飞点之后，`kind: "missed"`，画成进近色细虚线（`route-missed` 层），腿
  表里标 `MA`。没选落地跑道时，机场点打 `offPath`：只留标注，线不回到基准点。
- 打开时航路串里写着的程序名压过本机存的。只有人改选择时才改写航路串。

跑道列表显示长宽、真方位和风分量。风来自 `/api/v1/metar`，只解风组
（`lib/wind.ts`，带测试）；跑道方向用真方位（详情的 `trueBrg`，没有就用两端坐标），
不用磁航向 `hdg`。`VRB` 不算分量。

### 转弯是合成的（`lib/procedureGeometry.ts`）

can-db 没有 RF 弧心、半径、θ/ρ。程序点上的弧按固定半径 1.4 NM 合成，是示意，不是
公布航迹。

- 旁切（默认）：弧与前后两段相切，角点打 `offPath`，线不经过它，只留标注。
- 飞越点，或规定转弯方向与最短方向相反：过点后按规定方向转，再切向直飞下一点。
- 弧上插的点打 `shape`：无代号，不出标注，`routeLegKeys` 和 `routeLines` 判航段时
  越过它们。

航路段的角不画弧。

### 等待航线（`lib/holds.ts`）

等待挂在航线的定位点上（`MapPoint.hold`），`routeLines` 画成闭合的跑道形，要素带
`hold: 1`，按那个点所在的段取色，线比航线细一号。复飞段上的等待走 `route-missed`，是
虚线。

- 程序里的等待腿（`HM`/`HA`/`HF`）：入航航向取腿的 `courseMag`，挂到同一个定位点上，
  不另起一个点。合成时被收掉的重复点把等待并给留下的那个。
- 终端等待：can-db `/aip/holdings`（反代白名单里一条），只认两端机场、带入航航向的。
  选了跑道时优先那条跑道的，写着别的跑道的不用。程序里已有等待的点不换。航路等待
  （CSV）没有入航航向，不画。
- 入航航向是磁的，按机场磁差换成真方位：can-db 的 `variation`（**西为正**），没有就
  用跑道磁航向与两端坐标真方位之差的中位数。机场详情没取到的那一端不挂终端等待。
- 形状是标准等待：出航 1 分钟 / 230 kt，14000 ft 以上 1.5 分钟 / 240 kt，发布了就用发
  布的；半径按标准转弯率。是示意，不是保护区。

### 四件错了不会被屏幕出卖的事

这一整块的测试（`lib/procedures.test.ts`）挑的都是这一类，判据和 `lib/atc.ts`
那组一样 —— **错了会不会被屏幕出卖**：

1. **衔接。** 换一条 SID 之后，如果它的出口不是航路的第一个点，填出来的航路串是
   **断的**。而它在图上完全正常（两段线都在，中间连一条直线），在腿表里也正常
   （一串合法的代号）—— 只有管制员那边会发现。所以 `joinsRoute` 和界面上那句提
   示是一起的，而且必须把**两头各是什么**都说出来，否则人没法查。

   它的第三种返回值是 `null`（判不了），**不能塌进 `false`**：对一条其实没问题
   的航路喊「接不上」，人只能照着去改一条本来就对的计划。

2. **没写跑道的程序算「都能」，不是「都不能」。** 一部分程序压根没有跑道信息；
   按不匹配处理的话，选了跑道之后列表**整个空掉**，看起来像这个机场没有程序 ——
   又一次把「不知道」画成「没有」。界面要把这一类标出来（`servesAllRunways`），
   否则人会以为那是按今天这条跑道筛出来的。

3. **`runways` 的分隔符不做假设。** 这一列是导入器从解析出来的 JSON 原样搬过来
   的字符串，而源头那边是个**数组** —— 中间那步用逗号、斜杠还是空格拼的，在这
   个仓库里查不到（写它的导出脚本不在 can-nav 里）。跑道代号恒是字母数字，所以
   按**非字母数字**切分对每一种拼法都对，连「原样序列化成 JSON」这种最坏情况也
   解得对。赌错一种的后果是这条程序在每一条跑道下都不出现。

4. **合成时收掉相邻的重复点。** SID 的最后一个点常常就是航路的第一个点（那正是
   「衔接上了」的意思）。照抄会得到一条零长度的腿 —— 不报错，但沿线标注挤在一个
   点上抢位置，MapLibre 的碰撞检测会随缩放随机藏掉一个，表现是标注忽隐忽现。
   收的是**相邻**重复，不是全局去重：一条航路合法地两次经过同一个点。

### 高度限制**原样显示，不解码**

`alt` 是 ARINC 424 的编码字符串（`02960` / `00500A` / `05910B03940A` / `MAP`）。
can-db 存原文，它那条迁移写明了理由：解码要判 A/B/+/- 那套语义，而**一个解错的
高度限制比没有更危险**。

同一条在这里更硬 —— can-db 是库，这里是给飞行员看的屏幕。所以这一整块**一个字都
不解释**，只摆原文并说明它是原文。想显示「5900 以上」的那天，那该是一个带测试的
独立解码器，和 METAR 解码同一条规矩（见〈还没做的事〉），不是组件里的一段三元表
达式。

### 进近只画，不进航路串

进近不是填报航路的一部分（管制员给的），所以选了它只影响图上画什么和腿表里列什
么，不动那串字符。把进近写进航路串会得到一份管制员读起来莫名其妙的计划。

图上按段分色：航路段品红（`route`），SID 紫（`routeSid`），STAR 绿
（`routeStar`），进近橙（`routeApproach`），深浅两套各一份，都是实线；复飞段是进近
色虚线。段由
`routeGeometry.ts` 的 `legSegment` 定：取到达点的类别，到达机场的那条取出发点的。

### 改写航路串时**不猜哪个记号是程序**

`rewriteRoute` 判断「首尾那个记号本来是不是程序名」，靠的是传进来的**旧名字**，
不是去看某个记号长得像不像程序 —— `BOTP2G` 和 `BOTPO` 在字符层面分不开，猜错就
会把一个航路点当成程序删掉。

旧名字由选择器给：首尾记号是这个机场**真有**的 SID/STAR 名字才算。所以改写以当前
那串为底，重复改写不会留下上一次插进去的程序。`RouteGenerator` 仍把改写后的串存在
另一个 ref，`plan` 保持规划器的原样。

「填入飞行计划」交的是改写后那串 —— 换了跑道和程序却填进去一条旧的，是这个功能
最容易犯的错，而它一路到管制员那边才看得出来。

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

## 没有占位页面

**这一节以前列着四个，现在一个都没有。** `Placeholder.astro` 连同 `efb.placeholder.*`
一起删了。三条各有各的结局，记下来：

- **航图 `/charts`** —— 没有页面、没有入口。有版权的数据，网络里没有任何一处提供
  它；要么授权，要么自建图源，那之前不摆一个打不开的入口。
- **机场 `/airports`** —— 做了，数据来自 can-db。
- **性能 / 检查单** —— 删了。要机型手册数据、要按机型逐条录入，两样都不存在。

**别用假数据填页面。** 摆着占位数字的仪表盘会被当成坏掉的真页面 —— 飞行员会照着它
做决定。同一条规矩也是**图层为空要说话**的由来，见下。

## 图层没有数据的时候必须说出来

这是踩过的一个坑，而且它会再来。一个按需图层有三种"没东西"，以前只有一种会说话：

1. 请求失败 —— 会说（`console.error` + 退回关）
2. 权限不够（没有 `aipAccess`，每层都 401）—— **不说**，被 `deniedThisSession` 咽掉
3. **取回来是空的** —— **不说**，因为它根本不是错误：200 加一个空数组，
   `toAirwayLines` 得到 0 个要素，一路顺畅地画出一张空图
4. **请求失败** 现在除了退回关，还会在地图上留一条带「重试」的提示（`useLayerNotice`
   的 `failure`，`MapControls.vue` 画它）。退回关的规矩不变 —— 开关要说真话；提示
   是为了让人知道**为什么**关了，而不是只在控制台里留一行。

第 3 种正是线上真实发生过的：can-db 的航段 `level` 一列全是默认值，高空视图因此返
回 0 条（那个仓库的 TODO 里有整节）。而这个站的航路图层**默认是开的**
（`lib/mapPrefs.ts` 的 `DEFAULT_PREFS`）—— 于是打开航图，一条航路都没有，控制台一
个字都没有，看起来像**地图坏了**而不是**这一层没有数据**。（现在高低空一起取，见
〈航图样式〉。）

现在四种都会说话，走 `components/map/useLayerNotice.ts` 里的 `notice`（文案在
`map.emptyLayer.*` 和 `map.denied`），由 `MapControls.vue` 渲染。两条规矩：

- **"空"不是"错"，所以不退回关。** 人确实点了那一层，开关就该留在那儿；退回关会
  让人以为自己没点上。失败才退回关。
- **权限那条压过按层的提示**：它一旦成立，每一层都会因为同一个原因空着，而把"这一
  层没有数据"摆在最前面会让人以为换一层就好了。

### 一条通用判据：**别把「失败」画成「没有」**

上面那条不是地图特有的，它在这个站里已经出现过四次，每次都长得不一样：

| 地方            | 失败时显示的           | 为什么是假话                                                     |
| --------------- | ---------------------- | ---------------------------------------------------------------- |
| 地图图层        | 一张空图，不作声       | 看起来像这一带没有航路                                           |
| 概览的飞行计划  | 「还没有提交飞行计划」 | 他可能交了，只是没读上 —— 而按钮还写着「去提交」，在劝他再交一份 |
| 设置的 SimBrief | 「未绑定」加一个输入框 | 他可能绑着，会以为掉了、再绑一次                                 |
| 概览的 METAR    | 「暂无报文」           | 可能只是没读上；现在说「没能读取」并给重试                       |

第二、三、四条比第一条**更贵**：图上少一层线是看得出来的，而「你没有计划」是一句
读起来完全正常的话，人会照着它做决定。

判据：**一个「什么都没有」的界面，必须能回答"是真的没有，还是没问到"。** 两种情形
要么各说一句话，要么至少别用只对其中一种成立的措辞。写 `if (!result.ok) return;`
之前，先看一眼它落进哪个分支去。

**这条判据在岛屿里落到一个类型上。** 每个岛屿的请求都收进 `lib/requestState.ts` 的
`RequestState<T>`：`loading` / `data` / `empty` / `error`（可带 `failure`）/
`forbidden`，用 `fromApiResult`（can-api）或 `fromDbResponse`（can-db）归类，渲
染统一交给 `StateCard`。can-api 的失败一律是 `error`；can-db 的 401/403 是
`forbidden` —— 说的是没有权限，不是故障，判定只有一处：`isForbiddenStatus`。
`empty` 只在读到了、确实没有时用，读失败落进这里就是上面那句假话。Dashboard、
FlightPlan、Airports、AirportDetail、ProcedurePicker、RouteGenerator、
`routePreview` 都走这条路，没有第二种画法。

## 还没做的事（按该做的顺序）

1. ~~**上线**~~ —— **已经上线了。** `efb.ceruleanavi.net` 解析、`/healthz` 回
   200、根路径按预期 302 去主站登录页。这一条以前写着"至今不解析"，是旧的。
2. **品牌资源**。`public/favicon.svg` 现在是一块写着 EFB 的品牌色方牌，占位而
   已；轨里那块也是。正式标识到位后连同 `apple-touch-icon.png` /
   `icon-512.png` 一起补进 `BaseLayout.astro`。正式 logo 不能用
   `logo-full.png` —— 那张图上写的是旧名字。
3. ~~**登录后跳回 EFB**~~ —— **做完了。** can-web 那边加了显式白名单，这个域在
   名单上；`signInUrl(returnTo)` 会带上 callbackUrl。线上未登录访问根路径已经能
   看到它。见上面那一段。
4. **METAR 解码**。现在只显示原文，那是刻意的（`Dashboard.vue` 的天气卡片只摆原
   文）。真要做，它该是一个带测试的独立模块，不是组件里的一段正则。

## 命令

```bash
bun install
bun run dev          # :4324；后台跑用 bunx astro dev --background
bun run lint         # format:check + astro check + vue-tsc + check:i18n + check:style + bun test，CI 的门就是这个
bun run test         # 只跑测试
bun run check:i18n   # 查 t("…") 的键在不在词典里，以及四本词典对不对得齐
bun run check:style  # 两套主题的地图样式过 MapLibre 校验器
bun run build
PUBLIC_ORIGIN=http://localhost:4324 bun run preview   # 预览构建产物，前缀别省
```

**这个站有测试，都在 `src/lib/*.test.ts` 和 `src/server/*.test.ts`**（`bun test`，
零新依赖，只多一个 `@types/bun` 让 `astro check` 认得 `bun:test`）。第一个是
`src/lib/atc.test.ts`，下面拿它说明判据。

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
动态键写成一长串 if。所以它的承诺是"写死的键不会挂"，不是"所有键都不会挂"。

**它还查四本词典的键对不对得齐，而这一半守的是另外三种语言。** 一开始以为"别的语
言缺键会回退到中文"，**那是错的** —— `useTranslations` 里是
`typeof value === "string" ? … : key`，**没有任何跨语言回退**。所以一个键只加进
zh-cn，英文、繁体、日文三个站当场开始把键名画到屏幕上，和上面那种坏法一模一样，
只是**中文用户永远看不到**，于是没人会报。

也就是说「先加中文，翻译以后再补」不是欠一笔债，是当场就坏。四本今天是齐的（各
275 个键），这道闸让它保持齐。多出来的键也报：那多半是改键名时漏改了一本，只查
"缺"会看到一边缺一边多却只报一半。

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
