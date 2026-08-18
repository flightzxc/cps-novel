# src/lib/seo/

**Owner: Claude（独占写入）**

## 用途

SEO 口径的实现：页面 metadata 生成、canonical 规则、可索引判定、模板引擎的变量白名单。

## 本轮范围

P2-08 PR·公共 helper 已落地纯函数：breadcrumb、TOC、FAQ 抽取、seo-utils、seo-meta-generator。不碰数据库。`getSiteUrl` 暂留 `seo-templates/_shared.ts`，语义对齐 Stream D 的 `src/lib/seo/site-url.ts`（仅 `SITE_URL`、绝对 origin）；D 合入后由整合方收口为委托该文件。章节路径由 `chapter-path.ts` 组合地基 `buildArticleRoutePath`，不改 `article-path.ts`。

## 特别纪律

🔴 **可索引判定必须是代码级枚举 + 单一真源，不能是模板里的 `if`。**

- 详情页、试读目录、**全部实际物化的试读章节页**均可索引，各自 **self-canonical**；
- **不把章节页 canonical 指向详情页**；
- 「全部可索引」不等于不需要判定——`stale` / 下架 / 撤回状态随时把单页翻转为不可索引；
- V1 **不生成跨 Novel 的 hreflang**（每个来源语种版本是独立作品页，没有翻译兄弟集合）；
- 模板变量白名单中**不登记** `author` / `country` / `completion_status`——上游这三个字段不存在，登记了就会有人去引用；
- 渲染期缺值 fail-closed（抛错），不 fail-open 成空字符串。
