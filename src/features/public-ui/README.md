# src/features/public-ui/

**Owner: Claude（独占写入）**

## 用途

用户端（读者）的屏幕与功能模块。

## 与路由无关

🔴 **正式 URL 结构尚未冻结**（语种段的取舍仍是待决项），因此这里的屏幕全部实现为
与路由无关的功能组件：**所有地址由调用方注入**，组件不自行拼装、不自行决定任何永久路由。

本轮由 `src/app/dev-preview/**` 下一组临时预览路由承载，那组路由整体不可索引、
不进 sitemap、不进 SEO 契约。章节页虽然已经有了动态段 `[chapterNumber]`，
但**仍属 DEV_PREVIEW**：`noindex, nofollow`、不设 self-canonical。
正式章节 URL（每章独立、self-canonical、可被收录）要等 D-8 裁定语种段之后单独建。

dev-preview 的地址一律出自 `fixtures/preview-paths.ts` 这一个 helper，
页面与假数据都从那里取，组件里不出现任何硬编码路径。

## 目录

| 目录 | 内容 |
| --- | --- |
| `types.ts` | 视图模型。**字段边界的第一道防线**——页面上能出现什么，取决于这里有什么字段 |
| `layout/` | 页头、页脚、移动端导航、页面壳 |
| `book/` | 书籍卡片与卡片网格（首页与聚合页共用，不做第二套形态） |
| `home/` | 首页与主推位 |
| `novel/` | 小说详情页与嵌入其中的可试读章节区块 |
| `collection/` | 语言 / 题材聚合的共用屏幕 |
| `chapter/` | 章节阅读页、阅读设置、书籍归属条、章节导航 |
| `status/` | 下架 / 撤回状态页 |
| `fixtures/` | **MOCK_ONLY** 假数据。不来自任何接口、数据库或上游内容 |

## 数据边界

只允许渲染分销接口确实返回的字段。作者、评分、阅读量、完结状态、国家、章节发布日期、
同作者作品、全书进度百分比等**在上游官网上存在但分销接口不提供**，一律不渲染，
**也不预留固定槽位**。

完整清单见 `docs/p1/P1_10_VISUAL_DIRECTION.md` 第九节；
由 `tests/ui/forbidden-fields.test.tsx` 全屏幕扫描守住。

## 阅读器分期

- **P1-10（已完成）**：浅深两套阅读视觉、主题三态控件、字号 / 行高 / 页宽控件、
  移动端设置面板、正文排版、章末行动区与章节导航。设置真实可切换但不持久化。
- **P1-11（已完成）**：偏好持久化、阅读位置恢复、章节切换不整页刷新。
  `CLAUDE.md` §5 修正 6 的七项阅读器能力至此全部落地。

### P1-11 的模块分工

| 文件 | 职责 |
| --- | --- |
| `chapter/reader-settings.ts` | 设置的形状、默认值、合法性收敛、翻译成 CSS 变量。**纯函数，不碰存储** |
| `chapter/reader-storage.ts` | localStorage 读写。永不抛异常、读回一律过收敛层、SSR 安全 |
| `chapter/ReaderSettingsProvider.tsx` | 设置状态的跨章存活容器；镜像偏好到 `<html>`；接管 `history.scrollRestoration` |
| `chapter/useReadingPosition.ts` | 阅读位置的记录与恢复，粒度 `novel + chapter` |

### 三条容易被「顺手简化」掉的设计

1. **Provider 必须挂在 `chapter/layout.tsx`，不能挂进页面。**
   App Router 切换同一布局下的兄弟路由时不重挂 layout，设置因此才能跨章存活。

2. **`ChapterScreen` 是「有 Provider 就受控，没有就自持」的双模组件。**
   受控模式让状态活在页面之上；自持模式让组件能被独立渲染与测试。
   两种模式都要保留——去掉自持会让所有单测都必须包一层 Provider。

3. **章节导航的 `<Link>` 带 `scroll={false}`，滚动完全由阅读器自己负责。**
   App Router 的滚动重置发生在章节页**祖先**的 commit 回调里，晚于章节页自己的
   effect，不关掉就会盖掉位置恢复。代价是没有存过位置的章节必须由我们显式滚到顶。

### 首帧不闪由三段拼成，缺一不可

`chapter/layout.tsx` 的阻塞式内联脚本（补水前把偏好写到 `<html>`）→
`src/styles/globals.css` 的 `--reader-pref-*` 兜底层与主题回放规则（消费脚本写下的值）→
阅读区在补水前**不写**内联排版变量（否则会盖掉前两段的成果）。
由 `tests/ui/reader-no-flash.test.tsx` 三段各钉一遍。
