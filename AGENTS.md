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

**目前只有框架**：外壳、导航、主题、多语言已经落地，十个路由全部指向同一个
「这一页还没有内容」的占位组件。它**没有接 can-api**，因此也还没有会话 —— 见
下面「还没做的事」。

和 can-dev / can-radar 一样，这个站**一行数据库凭据都不该有**。它要的数据全部
来自 can-api，理由和那两个卫星站逐字相同（见根目录 `../CLAUDE.md`）。

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

后两个文件都按「上游部分在前、本站部分在末尾单独一节」切开，就是为了同步时可以
整段替换上半截。

**这个站自己的**：`AppRail.vue`、`SidebarNav.vue`、`RailScript.astro`、
`PageHeader.astro`、`Placeholder.astro`、`lib/nav.ts`、`lib/session.ts`、
两个 layout、`language/*.json`。

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

## 还没做的事（按该做的顺序）

1. **会话 / can-api**。`src/lib/session.ts` 是那个接缝，现在恒返回 null，外壳因
   此渲染「未登录」。接的时候照抄 `can-dev/src/lib/session.ts`，并把
   `signInHref` / `signOutHref` 传给 `AppRail` —— 现在两个都不传，是因为地址要
   等那一头接好才知道，**一颗指向 404 的登录按钮比没有按钮更糟**。
2. **`security.checkOrigin: false` 的另一半**。`astro.config.mjs` 里已经关掉了
   （理由见那里），但配套的 `PUBLIC_ORIGIN` 校验还没写 —— 第一个写操作落地之
   前，照抄 `can-dev/src/lib/guard.ts`。
3. **品牌资源**。`public/` 里现在只有 Astro 模板的 favicon。兄弟站的
   `BaseLayout` 还引用 `favicon-32.png` / `apple-touch-icon.png` /
   `icon-512.png`，本站暂时只留了 `favicon.svg`；图标到位后一起补上。轨里的品
   牌块现在是一个写着 `EFB` 的方块，不是 logo。
4. **404 页面**。故意没写：它需要四本词典各加两条文案，而未翻译的字符串比缺页
   更糟。
5. **部署**。还没有 `k8s/` 和 CI。抄 `llm-web/k8s/app.yaml` 的形状，
   `ingressClassName: cloudflare-tunnel`，集群 `jyl-tyo`；两个卫星站都是 CI 用
   `deployer` 服务账号部署的，不是手跑 `kubectl`。
6. **仓库本身还没有 remote**，也还没作为 submodule 挂进上级 monorepo。挂之前先
   建 GitHub 仓库并推上去 —— 根仓库只记录 submodule 的 commit 指针，指向一个没
   推过的 SHA 会让别人克隆出一个坏掉的树。

## 命令

```bash
bun install
bun run dev          # :4324；后台跑用 bunx astro dev --background
bun run lint         # format:check + astro check + vue-tsc，CI 的门就是这个
bun run build
```

`astro check` **只看 .astro 和 .ts**，Vue SFC 里写什么它都报 0 错误 —— 而这个站
的外壳整个是 Vue。所以 `typecheck` 是两步：`astro check` 加
`scripts/typecheck-vue.mjs`（vue-tsc）。别只跑前者。

后台开发服务器用 `astro dev stop` / `status` / `logs` 管理。
