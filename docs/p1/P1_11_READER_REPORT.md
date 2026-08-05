# P1-11 · 阅读器功能交付报告

> 主责：Claude　|　Reviewer：Codex（复核数据契约）
> 分支：`feature/v0.1.0-p1-reader`（自 `36abce8` 切出）
> 前置：P1-10（页面壳与阅读器控件）、P1-05（章节数据模型）

---

## 1. 本轮交付了什么

P1-10 交付了阅读器的**外观与控件**——设置真实可切换，但刷新即回默认值。
本轮补齐使其成为一个真正可用的阅读器的三件事：

| # | 交付物 | 落点 |
| --- | --- | --- |
| ① | 主题三态手动覆盖（`system` 默认 / `light` / `dark`） | P1-10 已有控件，本轮补持久化与首帧不闪 |
| ② | 偏好 `localStorage` 持久化 | `chapter/reader-storage.ts` + `chapter/ReaderSettingsProvider.tsx` |
| ③ | 字号 / 行高 / 页宽可调且持久化 | 同上 |
| ④ | 阅读位置记忆与恢复（`novel + chapter` 粒度） | `chapter/useReadingPosition.ts` |
| ⑤ | 🔴 章节切换无整页刷新 | `[chapterNumber]` 动态路由 + `ChapterPager` 客户端导航 |

至此 `CLAUDE.md` §5 修正 6 列出的**七项阅读器能力全部落地**。

---

## 2. 🔴 与任务卡的一处口径差异（Owner 已裁决）

`P1_IMPLEMENTATION_ASSIGNMENT.md:213` 的验收项 ⑤ 原文是：

> 切换后 canonical / SEO metadata 仍正确（self-canonical）

**Owner 本轮明确修正**：新增的 `/dev-preview/chapter/[chapterNumber]` **仍属 DEV_PREVIEW**，
不是正式生产章节 URL。因此本轮：

1. `robots = noindex, nofollow`；
2. **不设 self-canonical**；
3. 不进 sitemap；
4. 不进 IndexNow；
5. 不写入正式 SEO URL 契约（`src/lib/seo/` 保持空）；
6. **不借本轮冻结 D-8**（前台 URL 是否带语种段，仍是未决项）；
7. 页面与阅读器组件保持 route-agnostic；
8. URL 构造集中在 `fixtures/preview-paths.ts` 单一 helper；
9. D-8 定案后只替换正式路由层，不重构阅读器组件。

**验收项 ⑤ 因此本轮不验，转为遗留项**（见 §6）。

不过该验收项**可测试的那部分意图**——「元数据不会因为不整页刷新而变陈旧」——本轮是满足的：
`generateMetadata` 给出逐章标题，客户端切章时重新求值。实测见 §4。

---

## 3. 关键设计决策

### 3.1 设置状态挂在 layout，不挂在页面

App Router 切换同一布局下的兄弟路由时**不重挂 layout**（依据：`layout-router.js` 用
`createRouterCacheKey` 生成的 stateKey 作为 React key，静态段 `chapter` 的 key 不随
`[chapterNumber]` 变化）。因此 `ReaderSettingsProvider` 挂在 `chapter/layout.tsx`，
切章时页面重挂而设置原样保留。

`ChapterScreen` 相应改成**「有 Provider 就受控，没有就自持」**双模：受控模式让状态活在
页面之上；自持模式保留 P1-10 的行为，使组件仍能被独立渲染与测试（现有 24 个用例
一行未改继续通过）。这样也绕开了 `initialSettings` 只在惰性初始化里读一次、而 Provider
在首帧之后才补水所导致的陈旧初值问题——不需要 `key=` 强制重挂那种会打断滚动的 hack。

### 3.2 章节导航必须关掉 App Router 的滚动接管

App Router 在 `ScrollAndFocusHandler` 的 `componentDidMount` / `componentDidUpdate` 里
滚动（`next/dist/client/components/layout-router.js:93-99,169`），而那一层是章节页的
**祖先**——祖先的 commit 回调晚于后代的 effect，会**盖掉**阅读位置的恢复。
因此上下章链接带 `scroll={false}`，滚动完全由 `useReadingPosition` 负责。

代价必须记住：**没有存过位置的章节要由我们显式滚到顶**，否则会停在上一章的滚动量上。

### 3.3 阅读位置存段落锚点，不存像素

存 `{ paragraphIndex, ratio }` 而不是 `scrollY`。理由：这个阅读器的卖点就是字号 / 行高 /
页宽可调，而裸像素值只在排版参数一个字都没变时才有意义。实测见 §4 第 5 条。

### 3.4 首帧不闪由三段拼成

`chapter/layout.tsx` 的阻塞式内联脚本（补水前把偏好写到 `<html>`：主题走属性、排版三项走
CSS 变量）→ `globals.css` 的 `--reader-pref-*` 兜底层与主题回放规则 → 阅读区在补水前
**不写**内联排版变量（否则会盖掉前两段）。

只修主题是不够的：**排版闪一下是整页回流**，比配色闪一下明显得多，而且会让阅读位置按
错误的字号被测量。

主题回放规则只作用于 `[data-reader-theme="system"]`，与补水后的 `light`/`dark` 匹配集
互斥——这是整套双机制安全的根据，不是靠优先级碰巧压住。

### 3.5 设置的收敛语义：三处必须逐条相同（Codex 复核后修）

首轮实现里，收敛规则有**三个各自为政的执行点**，其中补水前脚本用「档位表下标是否
存在」代替规范化，与 `normalizeReaderSettings` 在三处分歧：

| 存储值 | 旧脚本（补水前） | normalize（补水后） | 读者看到 |
| --- | --- | --- | --- |
| `"2"`（字符串） | 20px（隐式转换） | 18px（默认档） | 20px → 18px 跳变 |
| `99` | 18px（下标不存在，回默认） | 22px（夹到最大档） | 18px → 22px 跳变 |
| `-99` | 18px（同上） | 16px（夹到最小档） | 18px → 16px 跳变 |

**每一处分歧都是一次整页回流**——而补水前脚本存在的全部意义就是消除它。

现在收敛规则冻结为一条，三处共用：

- `Number.isInteger` 一次覆盖「是 number / 有限 / 整数」三条；
- **合法整数**越界才夹到最近边界（读者确实选过，只是档位表变短了）；
- 小数 / NaN / Infinity / 字符串数字 / null / undefined / 数组 / 对象 → **该字段默认档**；
- 非法主题 → `system`；malformed JSON / 非对象 / 数组 → 全部默认值。

🔴 **字符串数字不做隐式转换**：存储里出现 `"2"` 说明写入方不是本模块，值不可信。

补水前脚本不再手写，改由 `chapter/reader-bootstrap.ts` 的 `buildReaderBootstrapScript()`
生成——档位表、默认值、主题清单、存储键全部从 `reader-settings.ts` 注入，脚本里没有
任何手抄字面量。它是纯字符串构造，不引入 Node-only 运行时，产物由章节布局内联进
HTML，不进客户端 bundle。

**写入路径也收敛为一条**：

```
partial → 与当前设置合并 → normalizeReaderSettings
  → React state → localStorage → onSettingsChange
```

规范化发生在**分流之前**，三个出口拿到同一个对象。此前 `applySettings` 直接把调用方
传来的值分发出去：受控分支会被 Provider 纠正、自持分支不会、回调两种情形都拿原始值
——同一次点击在三个出口得到三种结果。存储层 `writeReaderSettings` 另加一道冗余的
规范化，让「localStorage 里不可能存在非法值」成为存储层自己的不变量，而不是一条
依赖调用方守规矩的约定。

补水时还会**就地修复历史脏值**（仅在存储内容与其规范化结果不同时写一次）：否则
`"2"` 会长期躺在 localStorage 里，语义上没问题但字面上与内存状态不一致，排查的人
看到两个值分不清哪个算数。

### 3.6 顺带修正的一处 P1-10 缺陷

`normalizeReaderSettings` 的 `clampIndex` 对**非整数**回落到中间档
（`Math.floor(length/2)`）。字号有 4 档，中间档是 2（20px），而默认档是 1（18px）——
存储被损坏时会落到一个谁也没选过的档位。改为回落到对应的 `DEFAULT_READER_SETTINGS`。
越界**整数**仍夹回两端（读者确实选过、只是档位表变短了）。

---

## 4. 验证

`npm run typecheck` / `npm run lint` / `npm run test` 全绿；**256 passed, 8 skipped**
（P1-10 时为 216 + 8，本轮净增 40 条）。生产构建通过，三章全部 SSG 预渲染。

本地 `next start` 起真实服务后的浏览器实测：

| # | 验收项 | 实测结果 |
| --- | --- | --- |
| 1 | 偏好跨会话保持 | 设深色 + 22px + 76ch → 刷新后 `data-reader-theme="dark"`、内联变量 22px/76ch 全部还在 |
| 2 | 🔴 切章无整页刷新 | 切章前在 `window` 上打的标记切章后**仍存活**；`performance.getEntriesByType('navigation').length` 恒为 1；URL 由 `/1` 变 `/2`，标题同步变为「第 2 章 …」 |
| 3 | 切章保持阅读设置 | 切章后主题仍 `dark`、排版仍 22px/76ch |
| 4 | 阅读位置刷新后恢复 | 滚到 900 → 刷新 → 回到 **900，误差 0px**（`freshDocument` 已确认是全新文档） |
| 5 | 换字号后位置仍对得上 | 22px 下记录位置 → 改 16px → 刷新 → 锚点段落仍在视口顶部（偏离 58px < 段高）。裸像素方案在这一步必错 |
| 6 | 新章节回到顶部 | 切到没存过位置的第 2 章，`scrollY = 0` |
| 7 | 补水前配色与排版已正确 | 模拟补水前的 DOM（`system` 态 + 无内联样式）：`pref-theme=dark` → 深色底 + 22px + 60ch；`=light` → 浅色底；无 pref → 回落到媒体查询 + 18px/68ch |
| 7b | 补水前后收敛结果一致（Codex 复核后补） | 从**构建产物 HTML 里抽出真正被内联的那段脚本**在浏览器中执行：`"2"`→18px、`99`→22px/2/76ch、`-99`→16px/1.6/60ch、`1.5`→18px、非法主题→无属性、malformed→全默认，逐条与 `normalizeReaderSettings` 相同。再以 `"2"` 实际刷新页面，`--reader-pref-font-size` 与正文实际渲染字号同为 18px，无跳变（旧实现是 20px→18px） |
| 8 | noindex 且无 canonical | `<meta name="robots" content="noindex, nofollow">`，全页**无** `rel="canonical"` |
| 9 | 章号越界与非规范写法 404 | `/chapter/99` → 404；`/chapter/01` → 404（避免同一章有多个可访问地址） |

视觉基线已重出。`chapter-desktop.png` / `chapter-mobile.png` **与 P1-10 逐字节相同**
（第 1 章新增的段落都在首屏之下），只有 `chapter-last-desktop.png` 变了——第 3 章现在有
自己的正文，不再与第 1 章共用。

CPS 只读参考工作区交付前核验：`git status --porcelain` = **0 行**，
`HEAD` = `d77c3b968285698529cf97c7f0f97b286d7a2a9c`，未被写入。

### 未能在自动化里验证的部分

- **像素级的位置恢复**：jsdom 没有真实布局，`getBoundingClientRect` 恒为 0。
  `tests/ui/reader-position.test.tsx` 因此只钉键的粒度、存储层收敛与淘汰、以及
  「有没有存过位置」决定的滚动分支；像素正确性由上表第 4/5 条的浏览器实测覆盖。
- **视觉基线不是自动回归门禁**：仓库没有截图对比机制（见
  `tests/ui/baselines/README.md`），基线图只供人工前后对照。

---

## 5. 搬运登记

P1-11 的 CPS 复刻分类是 **`ORIGINAL_REQUIRED`**——CPS 没有正文托管、分章渲染、阅读版式
资产，试看是视频跳转，语义不可平移。**本轮无任何从 CPS 搬入的符号**，
`docs/governance/port-registry.md` 相应无新增条目。

本轮**无数据库改动**，因此不涉及 `docs/governance/database-governance.md` 的同步。

---

## 6. 遗留项

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 验收项 ⑤（self-canonical） | 本轮按 Owner 裁决不验。正式章节页仍必须：每章独立 URL、self-canonical、可进 sitemap / IndexNow |
| 2 | D-8（语种段） | 仍未决。定案后只替换正式路由层，阅读器组件不动；dev-preview 地址集中在 `fixtures/preview-paths.ts` 一处 |
| 3 | 切章后的焦点落点 | 关掉 App Router 滚动接管的同时，它的 `domNode.focus()` 也不再执行，切章后焦点落到 `<body>`。与 P1-10 的整页跳转行为**相当**（整页加载后焦点同样在 body），因此不算回归；逐章标题已能驱动路由播报。若要做到更好（切章后把焦点移到 `<h1>`），建议随正式路由一并处理 |
| 4 | 跨标签页同步 | 明确不做。改一个标签页的设置不会实时同步到另一个已打开的标签页；不在验收范围内，且会显著增加复杂度 |
| 5 | `react-hooks/set-state-in-effect` 抑制 | `ReaderSettingsProvider` 有一处 `eslint-disable-next-line`。从 localStorage 读初值只能在挂载后做（渲染期读会破坏 hydration），是该规则覆盖不到的正当情形；已在代码里写明为何不改用 `useSyncExternalStore`（写入失败时仍需内存兜底，而模块级可变状态会在测试之间泄漏） |

---

## 7. 给 Reviewer（Codex）的复核建议

数据契约方面本轮只动了一处：`ChapterNovelRef` 新增 `id: string`。

- 语义与 `NovelCardView.id` / `NovelDetailView.id` 一致（将来对应 `Novel.businessId`），
  沿用 `id` 而不另起 `novelKey`，避免同一概念两种叫法；
- 用途是把阅读位置按 `novel + chapter` 分键；**永不渲染**；
- 不能用书名代替：书名会改，改了读者的阅读位置就全丢；
- 不承载任何上游元信息，因此不触碰 `types.ts` 顶部的字段禁令——它是当下就需要的功能
  字段，不是「将来可能有」的预留位。

其余改动集中在 `src/features/public-ui/`、`src/components/`、`src/app/`、`src/styles/`、
`tests/ui/`，均为 Claude 独占写入目录；未新增任何 npm 依赖。
