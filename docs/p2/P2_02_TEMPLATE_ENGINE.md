# P2-02 · 小说 Template Engine

> 基线：`BASE 892c1a8`（分支 `feature/p2-02-template-engine`，由 `origin/main` 建出）
> CPS 参照基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（只读参考，见 `CLAUDE.md` §2）
> 状态：待 Codex 审查
> 变更级别：🟡 `STABLE`（字段登记表与错误码表的变更需同步本文档；`ArticleTemplate` 的两列语义分配一旦有消费方即升 `FROZEN`）
> 输入依据：`src/contracts/publish-gate.ts:65-73` 与 `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md:118`
> （P2-01 把 `Article.body` 的生成明文划给 P2-02）；`src/lib/seo/README.md` 特别纪律；
> `docs/p1/P1_CPS_PARITY_MATRIX.md:195`（模板引擎已预判为 `CPS_PARITY_ADAPTED`）

---

## 1. 本轮冻结口径

1. **模板语言照搬 CPS，不重造**：`{field}` 变量替换 + `{if field}…{endif}` 条件块，变量名匹配 `\w+`；没有 else、没有循环、没有 `a.b.c` 嵌套路径、没有 filter、没有转义语法。
2. **渲染两步且顺序固定**：先消解条件块，再一次性替换变量。因此取值里出现的 `{x}` 或 `{if x}` 都不会被二次解释。
3. **全槽位 fail-closed**：未登记字段、已登记字段缺值、`{if}` 不配对、`url` 类取值非法、产物违反输出合同——五类全部抛错，绝不 fail-open 成空串或半成品。依据是 `src/lib/seo/README.md`：「渲染期缺值 fail-closed（抛错），不 fail-open 成空字符串」。
4. **白名单即语言边界**：不登记 = 模板作者根本写不出来。`{author}` 在保存期被 `analyzeTemplate` 报出，在渲染期被 `ERR_TEMPLATE_FIELD_NOT_REGISTERED` 拒绝，两道都不放行。
5. **引擎是插值器，不是内容生成器**：六个登记字段里只有 `novel_description` 是实质散文。一篇 SEO 文章的正文实质来自运营手写在 `ArticleTemplate.bodyTemplate` 里的静态文案。**验收「该语种模板已用真实内容跑通渲染」时，「内容」指的是模板里的运营文案，不是引擎凭空产出的段落。**
6. **`Article.body` 是 HTML 片段**：schema 只写 `body String @db.Text`，内容类型在此定死。`bodyTemplate` 是运营手写的 HTML 片段，插值进去的取值做 HTML 实体转义，消费方按可信 HTML 渲染。`title` / `metaTitle` / `metaDescription` 是纯文本，不转义。
7. **引擎不构造 URL、不生成 slug、不做发布判定**：URL 由调用方走共享契约登记的构造函数解析好后作为取值传入；slug 归 P2-03/P2-06；发布准入归 P2-07。引擎对这三处**零 import 边**。

### 1.1 `ArticleTemplate` 的两个存储列承载四个渲染槽

`ArticleTemplate` 只有两列能放模板文本：`bodyTemplate`（Text）与 `seoTemplate`（JsonB）。**没有 `titleTemplate` 列**，而 `prisma/` 是 Codex 独占、本轮不改 schema。冻结分配：

| 渲染槽 | 存储位置 | 目标 | 必需 | 转义 |
| --- | --- | --- | --- | --- |
| `body` | `bodyTemplate` 列 | `Article.body` | 是 | HTML 实体转义 |
| `title` | `seoTemplate.title` | `Article.title` | 是 | 否 |
| `metaTitle` | `seoTemplate.metaTitle` | `Article.seoMetadata` | 否 | 否 |
| `metaDescription` | `seoTemplate.metaDescription` | `Article.seoMetadata` | 否 | 否 |

即 `seo_template` 这一列的语义比「SEO」略宽——它承载 `bodyTemplate` 装不下的全部其余槽位。

`title` / `body` 两个槽位名逐字取自 `PUBLISH_REQUIRED_METADATA_FIELDS`（`src/contracts/publish-gate.ts:72`），于是 P2-07 把渲染失败映射成 `required_metadata_missing.missingFields` 时不需要翻译表。

`ArticleTemplate.schemaVersion` 是模板结构版本旋钮（既有列，不新造第二个）。本引擎只认 `TEMPLATE_SEO_SCHEMA_VERSION = 1`，**未知版本 `narrowArticleTemplateSource` 一律返回 `null`**，不做 best-effort 解析。产物回吐 `seoSchemaVersion`，让写进 `Article.seoMetadata` 的快照自描述。

### 1.2 输出合同只对齐数据库真的会拒的东西

| 槽位 | 约束 | 依据 |
| --- | --- | --- |
| `title` / `body` / 任一存在的 meta 槽位 | trim 后非空 | `article_published_body_check` 等三条 CHECK 是 `btrim(...) <> ''` |
| `title` | ≤ 500 字符 | `Article.title` 是 `VarChar(500)` |

违反抛 `ERR_TEMPLATE_OUTPUT_INVALID`，`constraint` 取 `empty` / `too_long`。

**不实现 SEO 软上限截断**（metaTitle ~60 / metaDescription ~155）：截断是内容策略，静默截断更是 fail-open，留给 metadata 层显式决定。CPS 的 `truncateDescription` 属于另一套并行的 SEO 系统，模板路径本来也不调用它。

---

## 2. CPS parity matrix

判定级别沿用 `docs/p1/P1_CPS_PARITY_MATRIX.md` §判定级别的完整四级定义：

| 级别 | 含义 |
| --- | --- |
| `CPS_PARITY` | 形态与语义都照搬 |
| `CPS_PARITY_ADAPTED` | 形态照搬，数据/命名/协议换小说语义 |
| `ORIGINAL_REQUIRED` | CPS 无对应物，或 CPS 现状本身是反例——**必须说明原因** |
| `DROP` | CPS 有但明确不搬 |

CPS 文件路径均相对其仓库根，基线 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

| 维度 | CPS 机制（file:line） | 小说侧承接 | 结论 |
| --- | --- | --- | --- |
| 变量语法 `{field}` | `src/lib/template-engine.ts:199` `/\{(\w+)\}/g` | 逐字照搬 | `CPS_PARITY` |
| 条件语法 `{if f}…{endif}` | `src/lib/template-engine.ts:180` `/\{if\s+(\w+)\}([\s\S]*?)\{endif\}/g` | 语法逐字照搬 | `CPS_PARITY` |
| 两步顺序：先条件后替换、替换不二次扫描 | `src/lib/template-engine.ts:178-218` | 照搬 | `CPS_PARITY` |
| 无 else / 无循环 / 无嵌套路径 / 无 filter / 无转义语法 | 全部 NOT FOUND IN CPS | 一律不加 | `CPS_PARITY` |
| 扁平预字符串化取值表 | `src/lib/template-engine.ts:85-137` `buildWildcardMap` | 照搬形态，字段整表换，容器由普通对象改 `Map` | `CPS_PARITY_ADAPTED` |
| 字段白名单 `as const` 数组（同一份数组既判定又驱动后台变量面板） | `src/lib/template-engine.ts:13-35`（18 个短剧键） | 整表重写为 6 个小说键，增列 `kind` / `required` | `CPS_PARITY_ADAPTED` |
| 错误码 + Error 子类 + 鸭子类型 guard | `src/lib/template-engine.ts:37-74` `TemplateVarEmptyError` | 形态照搬（含跨 realm 的 `code` 判定），`ERR_TEMPLATE_VAR_EMPTY` 同名同值，扩为五码 | `CPS_PARITY_ADAPTED` |
| 已登记字段缺值 → 抛错 | `src/lib/template-engine.ts:151-164,201-216`（`requireNonEmptyVariables`，含 `.trim()`），仅 slug 槽位启用 | 从 slug 专用扩为**全槽位唯一模式** | `CPS_PARITY_ADAPTED` |
| **未登记**字段 → 抛错 | `src/lib/template-engine.ts:217` `return match` —— 变量位原样透出、条件位静默删块 | 变量位与条件位都拒绝 | `ORIGINAL_REQUIRED`（理由：CPS 现状是反例——`{author}` 会原样上线；且这是架构验收项「模板中写 `{author}` 保存时即报错」的运行期兜底） |
| `{if}` 真值判定：`"0"` 为假 | `src/lib/template-engine.ts:189` | 照搬。`Novel.totalChapterCount` 默认 0 表示未知，恰好需要该语义 | `CPS_PARITY` |
| `{if}` 真值判定前 trim | `:189` 不 trim，而同文件 `:201` 的严格分支 trim | 统一为 trim | `CPS_PARITY_ADAPTED`（理由：消除 CPS 自身两处口径不一致，并对齐 `btrim(body) <> ''`） |
| 嵌套条件消解算法 | `src/lib/template-engine.ts:180-194` 非贪婪正则 + 不动点重扫 | 改为按 token 顺序的深度配对扫描；**语言表层逐字不变** | `ORIGINAL_REQUIRED`（理由：CPS 现状是反例，见 §2.1 可复现证据） |
| `{if}` / `{endif}` 不配对 | 不报错，原样泄漏成字面文本 | 抛 `ERR_TEMPLATE_SYNTAX` | `ORIGINAL_REQUIRED`（理由：CPS 现状是反例，半成品文案会直接上线） |
| 正文插值转义 | `src/lib/template-engine.ts:241-254` **零转义**，取值直接拼进 `<h2>` / `<p>` / `<img src="…">` | body 槽位对插值做 HTML 实体转义（含单双引号，属性上下文亦安全） | `ORIGINAL_REQUIRED`（理由：CPS 现状是已确认的注入缺陷） |
| `url` 类取值 scheme 校验 | 无（`:249` 对 `<img src>` 零校验） | 只认 `^https?://` 且不含空白/引号/尖括号/反引号 | `ORIGINAL_REQUIRED`（理由：CPS 无对应物） |
| title/meta 槽位不转义（纯文本） | `src/lib/article-generation.ts:239-264` 同样不做 HTML 包裹 | 照搬 | `CPS_PARITY` |
| 多槽位装配器 | `src/lib/article-generation.ts:204-272`，另有 3 处分叉副本（Server Action / Worker / 预览），fallback 链各不相同 | **单一实现**，且一条 fallback 都不做 | `CPS_PARITY_ADAPTED`（理由：CPS 四份副本对同一输入产出不同 meta，是反例；fallback 属发布链路策略，归调用方 / P2-07） |
| 保存期未登记变量检测 | `src/components/templates/template-form.tsx:99-115` 仅弹黄条告警，**仍允许保存** | `analyzeTemplate` 纯函数，可硬拦截 | `CPS_PARITY_ADAPTED` |
| 模板存储形态 | `ArticleTemplate.contentTemplate` TEXT 存 JSON 区块数组 | 小说 schema 是 `bodyTemplate` TEXT 单模板 | `CPS_PARITY_ADAPTED`（schema 已由 Codex 冻结，本轮不改） |
| `ContentBlock` / `renderContentBlocks` 区块包裹 | `src/lib/template-engine.ts:223-261` | 不搬 | `DROP`（小说侧不存在 `contentTemplate` 列，无区块概念） |
| `metaKeywordsTemplate` | `src/lib/article-generation.ts:265-271` | 不搬 | `DROP`（`Article` 无对应列；不凭空发明 `seoMetadata` 字段） |
| `SYS_DEFAULT_EMPTY` 兜底模板 | `src/lib/article-generation.ts:18,221-239` | 不搬 | `DROP`（自动建空模板是 fail-open 路径，产出 `articleContent: ""`，与本项目纪律直接冲突） |
| `resolveTemplateEpisodeCount` | `src/lib/template-engine.ts:76-83`（`episodeCount` 为 0 时静默用 `freeEpisodeCount` 顶替） | 不搬 | `DROP`（正是「替调用方猜」，与 locale 唯一真源同一条纪律） |
| `previewTemplate` | `src/lib/template-engine.ts:263-294` | 不搬 | `DROP`（CPS 侧为死代码，全仓零调用点） |
| `truncateDescription` 155 字截断 | `src/lib/seo-templates/_shared.ts:7-15`（另一套并行 SEO 系统，模板路径不调用） | 不搬 | `DROP`（截断是内容策略，静默截断是 fail-open，留给 metadata 层） |
| `renderAltTemplate` 封面 alt 迷你引擎 | `src/lib/article-v2-service.ts:121-128`（缺值 → 空串，与主引擎口径相反） | 不搬 | `DROP`（第二套模板语言；且其缺值口径与本项目 fail-closed 冲突） |

### 2.1 嵌套条件：CPS 现状的可复现证据

模板 `A{if a}B{if b}C{endif}D{endif}E`，用 CPS 的非贪婪正则 + 不动点重扫：

| a | b | CPS 产物 |
| --- | --- | --- |
| 真 | 真 | `ABCDE` ✅ |
| 真 | 假 | `ABE` ✅ |
| **假** | 真 | `AD{endif}E` ❌ |
| **假** | 假 | `AD{endif}E` ❌ |

成因：正则从**外层** `{if a}` 起匹配，惰性量词吃到的是**内层**的 `{endif}`，外层块被误判成 `{if a}B{if b}C{endif}`，剩下 `D{endif}` 原地留下。CPS 侧这条路径零测试覆盖（全仓测试搜不到 `{if `），线上没炸只是因为没人写过嵌套模板。

照搬这个实现会把字面量 `{endif}` 写进 `Article.body`。因此改用按 token 顺序的深度配对扫描——**模板作者能写的东西一个字没变**，变的只是消解算法。回归锁在 `tests/ui/template-engine.test.ts`「嵌套条件四种组合都正确」。

---

## 3. 字段登记表

`src/lib/seo/template/fields.ts`。每项带 `key` / `kind` / `required` / `label` / `description`，同一份数组既是渲染期判定依据，也是后台变量面板取值来源（CPS 同款形态），因此白名单与 UI 面板不可能漂移。

| key | kind | required | 数据来源 | 登记依据 |
| --- | --- | --- | --- | --- |
| `novel_title` | text | 是 | `Novel.title`（非空列） | `NovelDetailView.title` |
| `novel_description` | text | 是 | `Novel.description`（非空列） | `NovelDetailView.description` |
| `cover_url` | url | 否 | `Novel.coverUrl`（可空列） | `NovelDetailView.coverUrl?` |
| `total_chapter_count` | text | 否 | `Novel.totalChapterCount`（默认 0 = 未知） | `src/features/public-ui/types.ts` 明文放行为「客观标量，可展示」；🔴 绝不据此生成章节行 |
| `preview_chapter_count` | text | 否 | 口径对应 `NovelPreviewPolicy.materializedChapterCount`，**由调用方传入** | `PreviewPosition.total`（「试读 1 / 3」的分母）。该表读写归 P2-05，引擎不自读 |
| `promo_redirect_url` | url | 是 | 调用方按 `PromoLink.publicRedirectCode` 预先解析好的地址 | `docs/p1/P1_10_VISUAL_DIRECTION.md` §9 允许「公开跳转码对应的正式阅读按钮」；发布门禁本就要求 PromoLink 就绪 |

`required: false` 的字段被裸引用时，`analyzeTemplate` 报 `unguardedOptionalFields`——模板合法但「缺该值的那些小说」会在渲染期失败，这一档告警把代价提前给模板作者看到，而不是等批量生成时逐条失败。

### 3.1 不登记清单

**由 `src/lib/seo/README.md` 点名**：`author`、`country`、`completion_status`。上游分销接口不返回这三项；`Novel` 表里虽有同名可空列，但恒为空。

**由 `src/features/public-ui/types.ts` 字段禁令与 `docs/p1/P1_10_VISUAL_DIRECTION.md` §9 点名**：`rating`、`views`、`release_date`、`same_author`、`full_catalog`、`full_book_progress`、`split_ratio`、`upstream_code`、原始来源标签。

**渠道版权正文**：`NovelChapterContent.body` 是渠道试读正文，与 `Article.body` 是两件事（数据字典明文区分），不登记。

**本轮实读 schema 后主动删掉的两个候选**：

- `site_tags` —— `prisma/schema.prisma` 全库搜 `tag` **零命中**，根本没有站点标签表。唯一存在的标签数据是 `SourceLabel` / `NovelSourceItemLabel`，即原始上游来源标签，而「原始来源标签不得直接进前台」是硬纪律。登记它只有两种下场：造一个谁也填不了的变量，或者把 `externalLabelValue` 引进 SEO 正文。
- `novel_locale` —— `ArticleTemplate.locale` 已经按语种切分模板，模板文本自己就是那个语种；把裸 locale 码插进正文既不是可用文案，也会成为语种串在内容里的第二处物化点，蹭到 `CLAUDE.md` §3.2.1 的语种唯一真源纪律。

---

## 4. 错误码表

全部为阻断级：任一出现即该条生成失败，不产出半成品文章。`TemplateRenderError` 携带 `code` / `slot` / `field?` / `constraint?` / `templateKey?` / `novelId?`，**消息只拼结构化定位，不回带任何取值内容**。`isTemplateRenderError` 同时接受 `instanceof` 与 `code` 属性判定——Worker 与 Web 是不同模块 realm，只写 `instanceof` 不可靠（CPS `worker/handlers/batch-generate.ts:63-71` 正是靠 `code` 判定把模板错误归类为不可重试）。

| 码 | 触发条件 | 与 CPS 的关系 |
| --- | --- | --- |
| `ERR_TEMPLATE_SYNTAX` | `{if}` 与 `{endif}` 不配对（`constraint` = `unclosed_if` / `unexpected_endif`） | CPS 无此码，泄漏成字面文本 |
| `ERR_TEMPLATE_FIELD_NOT_REGISTERED` | 模板引用了白名单之外的名字（变量位或条件位皆然） | CPS 无此码，原样透出或静默删块 |
| `ERR_TEMPLATE_VAR_EMPTY` | 已登记字段在渲染期无取值（空串/纯空白同论） | **同名同值照搬** CPS `ERR_TEMPLATE_VAR_EMPTY` |
| `ERR_TEMPLATE_VALUE_INVALID` | `url` 类字段取值不是干净的 http/https 绝对地址 | CPS 无此码 |
| `ERR_TEMPLATE_OUTPUT_INVALID` | 渲染产物违反槽位输出合同（`constraint` = `empty` / `too_long`） | CPS 无此码 |

**不新增任何发布门禁理由码。** 渲染失败由 P2-07 映射到既有的 `required_metadata_missing`；`PUBLISH_GATE_REASONS` 的九元素与 `publish-gate.ts` 的八个导出名都被现有测试精确锁死，本轮一个符号都没动。

---

## 5. 本轮明确不实现清单

- **slug 模板渲染**——归 P2-03 / P2-06。⚠️ 注意它不是 `DROP`：这个能力**要建**，只是不归本轮。本轮对 `src/lib/slug/**`、`src/lib/seo/url/**`、`src/lib/seo/public-url*` 零改动、零 import。
- **`site_tags` / `novel_locale` 两个字段**——理由见 §3.1。将来若出现真实的站点标签表，需走本文档变更再登记。
- **`preview_first_chapter_title`**——`NovelChapter.title` 确实已通过 `PreviewChapterRef.title` 公开，但「取哪一章的标题」是一条排序策略，属试读物化（P2-05）与页面组装（P2-06）的口径。本轮不替它们决定，也不留槽位。
- **Admin 模板管理 UI、模板 CRUD、模板选择/查询**。
- **模板与 Article 落库**——引擎不写库，产物里没有 `slug` / `status` / `novelId`。
- **发布 Worker、批量生成、任务入队**。
- **发布准入 evaluator**（P2-07）、**试读章节物化与 `NovelPreviewPolicy` 读写**（P2-05）。
- **Sitemap、IndexNow/outbox、canonical、hreflang、可索引判定**——后两者另有单一真源纪律（`src/lib/seo/README.md`），且 V1 不生成跨 Novel hreflang。
- **正式公共路由**。
- **meta 长度的 SEO 软上限截断**——理由见 §1.2。
- **`Article.seoMetadata` 整体信封形状**——本轮只定义真正渲染出来的两个键，canonical / OG / JSON-LD 属后续任务，不猜未来字段。

---

## 6. 与相邻任务的边界

| 相邻任务 | 边界 |
| --- | --- |
| **P2-01**（已冻结） | 只读引用其口径。`title` / `body` 槽位名与 `PUBLISH_REQUIRED_METADATA_FIELDS` 同名以便零翻译映射；**不新增理由码、不动其八个导出、不返回 `PublishGateResult`、不做门禁判定** |
| **P2-03**（并行） | 目录零重叠。引擎**不构造 URL**，`promo_redirect_url` 是调用方预解析好的字符串输入；对 `src/lib/slug/**` / `src/lib/seo/url/**` 零 import 边（有源码级守卫测试）。🔴 双方都**不创建 `src/lib/seo/index.ts`**，每个子模块各自出 barrel；`src/lib/seo/README.md` 的「本轮只建目录」表述由 integration 统一收口，本轮不改 |
| **P2-05** | 纯数据依赖：`preview_chapter_count` 的口径对应 `NovelPreviewPolicy.materializedChapterCount`，但引擎取参数、不读表。试读物化 cap 不在本模块出现 |
| **P2-06** | 引擎只是「纯的那一半」（四槽位渲染）。slug 生成、唯一性检查、持久化都不在这里——**不要出现第二个 `renderArticleDraft` 式装配器** |
| **P2-07** | evaluator 逐项执行发布检查并产出 reasons；引擎只返回产物或抛错。`TemplateRenderError.slot` 可直接填进 `RequiredMetadataMissingDetail.missingFields` |

契约落点：`src/contracts/template.ts`，**全部是 `export type`，一个值都不导出**（契约层零运行时依赖规则）。它**不进 `src/contracts/index.ts`**——那个 barrel 的自述是「浏览器唯一可以收到的形状」，模板渲染产物不是浏览器载荷；消费方直接 `import type … from "@/contracts/template"`。

---

## 7. 测试清单

对应 `tests/ui/template-engine.test.ts`，vitest `ui` project，66 条。

🔴 放在 `src/` 下的测试**一条都不会被收集**（两个 project 的 include 都不覆盖 `src/`），且 `passWithNoTests: true` 会让空跑判 PASS——落点写错不会有任何提示。

| 分组 | 覆盖点 |
| --- | --- |
| 字段白名单 | 六个键精确等于冻结列表且冻结；禁止字段模式逐键扫描；未登记名（含 `constructor` / `__proto__` / `toString` / 大小写变体）一律不认 |
| 合法变量渲染 | 六个字段各自替换；模板自带文本保留；变量可重复、可相邻；无变量模板原样返回 |
| 条件渲染 | 真保留、假移除；空串 / 纯空白 / `"0"` 三种假值；块被丢弃时块内空值字段不抛错；**嵌套四组合精确产物（钉死 CPS `{endif}` 泄漏）**；产物绝不残留 `{endif}` / `{if`；同层多块互不影响 |
| 缺字段显式失败 | `ERR_TEMPLATE_VAR_EMPTY` 带 `field` / `slot`；空串与纯空白同论；**错误消息不回带取值**；`templateKey` / `novelId` 进消息且未提供时不留空占位；跨 realm 鸭子类型 guard；错误码表精确五项且冻结 |
| 未登记字段拒绝 | 13 个禁止名逐个：保存期 `analyzeTemplate` 报出 **且** 渲染期抛码；条件位同样拒绝；藏在永不渲染的块里也拒绝；原型链属性名拒绝；CPS 没有的语法（`{a.b}` / `{a\|upper}` / `{else}`）不被悄悄支持 |
| 语法错误 | `unclosed_if` / `unexpected_endif`；配对数相同但顺序错乱也抓；语法错误优先于未登记字段；合法配对时 `endif` 不被当成字段 |
| HTML 转义 | 正文槽位实体转义；模板自带标签原样保留；属性上下文无法逃逸；纯文本槽位不转义；条件块内模板文本不转义而取值转义；**取值里的 `{x}` / `{if x}` 不被二次展开** |
| url scheme 校验 | http/https 通过；`javascript:` / `data:` / 相对路径 / 协议相对 / 含引号或空白 / `ftp:` 拒绝；text 类字段不做该校验 |
| 可空字段裸引用告警 | 裸引用报出；同名条件块包住（含嵌套层）不报；别的字段的条件块不算包住；非空列字段不报 |
| 取值表构建 | 恒含全部登记键且值恒为字符串；计数字段 0 保留而负数/小数/NaN/null 折空；文本两端裁空白；**`Map` 承载，原型链属性名取不到东西** |
| 模板记录归一 | 合法输入归一；meta 缺省时产物无该键；**未知 `schemaVersion` fail-closed 返回 `null`**；14 种非法形态返回 `null` 而不抛 |
| 四槽位装配与输出合同 | 槽位名精确且冻结；产物形状精确；无 fallback；trim 为空拒绝（`constraint=empty`）；title 超 500 拒绝（`constraint=too_long`）且恰好 500 通过；任一槽位失败即整体抛；定位信息随错误返回 |
| 产物无占位字面串 | 四种缺值组合下产物均不含 `undefined` / `null` / `NaN` / `[object` / `{if` / `endif` |
| 确定性 | 同输入 50 次逐字节相等；取值表键序不影响产物；`analyzeTemplate` 恒等；全局正则 `lastIndex` 残留不影响连续调用 |
| 🔴 纯度与边界源码守卫 | 引擎源码无 `new Date` / `Date.now` / `Math.random` / 环境变量读取 / `toLocale*` / `Intl` / `performance.now`；import 不触数据库/服务端/路由/React/Node 内建，也不进 P2-03 目录；源码无 CPS 仓库目录名（项目隔离检查会逐文件 grep） |

---

```text
NEXT_GATE=CODEX_P2_02_REVIEW
```
