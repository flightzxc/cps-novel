# Novel 入库与 Article 生成：协议纠正

本文只记录**创建链路偏差纠正**和**本轮新增的生成推广前置**。不把 v0.2.1 回写成「从来没有分叉过」。

## 偏差纠正

旧耦合协议把「纳入书目」和「创建文章」绑在同一条 `content.create.v1` / 父 `content_create` 上，并且在纳入时查询/选择/渲染 ArticleTemplate。

纠正后：

- `linked` = SourceItem 合法挂到有效 Novel。没有 Article 是正常阶段。
- 纳入书目只走 `novel.materialize.v1` / 父 `novel_materialize`。禁止模板查询、默认模板初始化、渲染、Article.slug / 短 ID 规划。
- 旧 `content.create.v1` 与父 `content_create`：**识别、可读、拒绝执行**。不改义、不自动转 Novel-only、不无穷重试。handler 返回终端 `failed`，allowlist 暂时保留旧 type 以便消费并失败。

## 本轮新增：生成硬卡推广

显式「创建文章」走 `article.generate.v1`，输入是当前 Novel 事实，不是 SourceItem 快照。
「按当前筛选全选」走父任务 `article.generate.batch.v1`：Action 只保存 filter snapshot，Worker 分页枚举并创建每片 ≤200 的 leaf `article.generate.v1`。禁止在 Web 里枚举全库。

推广前置复用 `isPromoReady` + `pickReadyPromoLink`（`fetched` + 非软删，`fetchedAt desc, id asc`）。这是工单收紧策略，相对「有则绑定、无则草稿、发布再拦」的更松变体。不要把它回写成历史冻结事实。

软删 Article 仍占 `(novel_id, locale)`：返回 `article_soft_deleted`，不复活、不新建。已有活文章返回 `already_exists`，不走 regenerate。
