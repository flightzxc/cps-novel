# 海外阅读 v0.2.1 · CPS 短剧同构性只读复核

> 文档性质：**只读代码核实报告**，为 candidate-v0.2 / v0.2.1 的修订提供 CPS 现状证据。
> CPS 代码基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（工作区 `cps-admin-v811-search-ux`，v8.1.1，`git status --porcelain` 为空，核实前后均为 0 行）。
> 全部结论来自本轮实读代码，**未根据记忆作答**。未修改 CPS 任何文件。
> 复核日期：2026-08-02（复核所得的 CPS 事实本身未变；**v0.2.1 仅更新 §4/§5 的下游裁决状态**：D-11 已由 Owner 定为 `CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION`；D-10 已冻结为「响应可信度前置 + 旧章立即 stale + 自动恢复」，取代 v0.2 的 K 次推荐）

---

## 0. 五项结论速览

| # | 复核项 | CPS 当前真实行为（一句话） | 对 Owner 判断的裁定 |
| ---: | --- | --- | --- |
| 1 | 跨语种作品关联与 hreflang | **没有**跨源语种 Drama 关联；hreflang 只连接同一 Drama、同一 slug 的**自产翻译 Article** | `CPS_PARITY_CONFIRMED` |
| 2 | 文章逐条人工审核 | **不存在**审核状态；机器门禁 + 批量生成 + 批量发布 | `CPS_PARITY_CONFIRMED` |
| 3 | `/go` 公开码 | ⚠️ **CPS 把渠道真实推广码直接放进公开 URL**，无独立公开码、无唯一约束 | **Owner 的"拆分两码"是对 CPS 的修正，不是复用**——但 CPS 有可改造的短码生成机制 |
| 4 | 推广值存储分布 | 真实值受控存在于 4 处；后台明文可见；写路径锁定；审计脱敏 | `CPS_CURRENT_STORAGE_BEHAVIOR` 见 §4；**v0.2.1 已定 `CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION`** |
| 5 | 缺失内容下架 | **纯 upsert 状态标记，无删除路径**；`stale` 枚举保留但从不写入 | 支持「标记不删」方向；**v0.2.1 规则已冻结**，见 §5 |

---

## 1. 多语种 Drama / Article 关联与 hreflang

| 项目 | CPS 当前真实行为 | 文件:行号 | 海外阅读是否复用 | 差异原因 |
| --- | --- | --- | :---: | --- |
| hreflang 兄弟集合的构成 | 同一 `slug`、`status=published`、locale ∈ 站点 locales 的 **Article 集合**——即同一 Drama 的**自产翻译文章**互指 | `src/lib/drama-hreflang.ts:16-32`（`buildDramaHreflangArticleWhere` 按 slug + locale in locales 查）；`src/app/[locale]/(site)/drama/[slug]/page.tsx:171-173`（`alternates.languages` 注入） | ❌ V1 不复用 | 小说 V1 每个源语种版本 = 独立 Novel，**不生产翻译文章**，因此不存在翻译兄弟集合，hreflang 无对象 |
| 跨**源语种**内容实体关联 | **不存在**。`DramaSourceItem` 唯一键含 `sourceLanguageCode`（不同语种 = 不同来源行），没有任何机制把"同一 seriesId 的 en 行和 fr 行"关联成一个作品 | `prisma/schema.prisma:279`（`@@unique([channelAppId, sourceKey, sourceLanguageCode])`） | ✅ 同构 | Owner 判断与 CPS 现状一致 |
| 一个 Drama 被多个来源条目共享 | 被当作**不合格态**而非设计目标：领链资格检查中 `SOURCE_ITEM_DRAMA_SHARED` 直接拒绝 | `src/lib/changdu-promo-claim-eligibility.ts:6` | ✅ 同构 | CPS 自己都把"多来源共享一个实体"视为归属不清 |
| 同剧不同 locale 的 canonical 合并 | **不合并**。每个 locale 的 Article 有自己的 canonical（`(locale, slug)` 唯一），hreflang 互指但 canonical 各自独立 | `prisma/schema.prisma:577`（`@@unique([locale, slug])`）；`drama/[slug]/page.tsx:164`（canonical 取自身） | ✅ 同构 | 与 v0.1 已定的"每语种独立 canonical"一致 |

**裁定：`CPS_PARITY_CONFIRMED`。** CPS 没有自动建立同一剧不同源语种之间的作品关系；它的 hreflang 是另一个概念（自产翻译文章互指），在小说 V1 的"一源语种版本 = 一 Novel"模型下没有对应物。Owner 的 V1 裁决（不关联、不生成跨 Novel hreflang、独立 canonical）与 CPS 现状同构，照准执行。`NovelWork / TranslationGroup` 进 Post-V1。

---

## 2. 短剧文章是否逐条人工审核

| 项目 | CPS 当前真实行为 | 文件:行号 | 海外阅读是否复用 | 差异原因 |
| --- | --- | --- | :---: | --- |
| Article 状态机 | `draft / pending / published / offline` **四态，没有任何 review/approval 态** | `src/lib/constants.ts:6-11` | ✅ 复用 | — |
| 生成即发布 | `resolveAutoArticlePublication`：`publishType=now` → 直接 `published`；`scheduled` → `pending`（定时）；无人工审核环节 | `src/lib/article-generation.ts:63-90` | ✅ 复用 | — |
| 机器门禁 ①：分类缺失 | `categoryId === null` → **自动降级 draft**（`downgradedToDraft: true`），不发布但也不打断批次 | `src/lib/article-generation.ts:68-74` | ✅ 复用（换小说门禁项） | — |
| 机器门禁 ②：推广链接缺失 | `promo_url` 为空 → **拒绝生成公开文章**，硬门禁、渠道无关 | `src/actions/article-actions.ts:563-567`（注释直书 "Hard gate"） | ✅ 复用 | — |
| 机器门禁 ③：locale 不匹配 | 模板 locale 与剧集 locale 不匹配 → 拒绝 | `src/actions/article-actions.ts:569-576` | ✅ 复用 | — |
| 批量入口默认值 | 批量向导 `publishType` 默认 `draft`，运营可显式选 `now` 批量直发 | `src/components/articles/batch-wizard.tsx:212` | ✅ 复用 | 默认保守、显式放开，是好形态 |
| 发布后自动化 | 发布后自动入队：review 生成、preview catalog、IndexNow——全机器，无人工卡点 | `worker/handlers/batch-generate.ts:117-170` | ✅ 复用（换成小说的后置任务） | — |

**裁定：`CPS_PARITY_CONFIRMED`。** CPS 从未要求逐条人工审核；质量由机器门禁（分类、推广链接、locale、模板渲染）+ 运营发起批次 + 异常处理承担。**candidate-v0.1 的"内容审核（人工）→ 未审核不得发布"流程超出了 CPS 实践，v0.2 撤销**，改为"机器校验通过 → 可批量生成发布；异常 → 人工处理队列"。

---

## 3. `/go` 公开码的生成、唯一性与不可变性

这是五项中**唯一一处 CPS 现状与 Owner 认知不符**的地方，必须如实报告。

| 项目 | CPS 当前真实行为 | 文件:行号 | 海外阅读是否复用 | 差异原因 |
| --- | --- | --- | :---: | --- |
| `/go/:code` 的 code 是什么 | **渠道真实推广码**。路由按 `dramas.promo_code` 查找（fallback 再查 `settlement_orders.code`）——公开 URL 直接暴露上游真实码 | `src/app/go/[code]/route.ts:94-98`（`promoCode: code` 查询）、`:119-130`（settlement fallback） | ❌ **不复用** | Owner 裁决拆分两码；CPS 现状恰是反例 |
| 前端 CTA 如何构造 `/go` | 直接把 `drama.promoCode` 编码进 URL | `src/lib/drama-cta.ts:48-55`（`buildGoTrackingUrl`）；`src/lib/blog-internal-drama-cta.ts:99` | ❌ 不复用 | 同上 |
| code 全局唯一？ | **无约束**。`Drama.promoCode` 是 `String @default("")`，无 `@unique`、无索引；路由用 `findFirst` 匹配——重复时行为不确定 | `prisma/schema.prisma:32`；`route.ts:94`（`findFirst`） | ❌ 不复用 | 海外阅读要求数据库唯一约束 |
| 创建后不可变？ | 无保护。promoCode 随渠道数据可变（有 manual-promo-lock 锁**人工编辑**，但同步链路可更新） | `src/lib/manual-promo-lock.ts`（写保护，非不可变保证） | ❌ 不复用 | 渠道码变化时我方公开 URL 必须默认不变 |
| 短码生成函数有几个 | **一个文件**：`article-public-page-id.ts` 内 `createArticlePublicPageId`（长码）与 `createArticlePublicPageShortId`（短码，字母表 + **强制含数字** + 冲突重试 + 唯一约束配套）。全仓无第二处短码生成 | `src/lib/article-public-page-id.ts:32-44`；冲突检测 `:46+` | ✅ **改造复用** | 这是 CPS 已验证的短码生成机制，正好用作 `public_redirect_code` 的生成器蓝本 |
| Page Identity 与跳转码是否混用 | **未混用**。`public_page_short_id` 只用于页面 URL 身份，从未进入 `/go` | `src/lib/article-public-page-id.ts` 全文；`route.ts` 无引用 | ✅ 继承此边界 | 页面身份码与跳转码是两个概念，继续分开 |

**裁定：Owner 要求的"渠道真实码 ≠ 站内公开码"在 CPS 里并没有实现——CPS 把真实码直接放公开 URL，且无唯一约束。** 所以海外阅读的 `public_redirect_code` 是**对 CPS 的修正**而非复用；但"优先复用 CPS 已验证机制"仍然成立：短码**生成算法与冲突处理**直接改造 `article-public-page-id.ts` 的模式（字母表、强制含数字、冲突重试、DB 唯一约束兜底），不发明新算法。

v0.2 据此规定（写入架构字典）：

1. 全项目**唯一**公开跳转码生成入口：`public-redirect-code.ts`（单文件单函数，改造自 CPS `article-public-page-id.ts:37-44` 模式）；
2. 唯一字段：`PromoLink.public_redirect_code`，数据库 `UNIQUE`，部分索引排除软删；
3. 创建后**不可变**：任何同步、重跑、换模型、换代理都不得重新生成；渠道真实码（`upstream_code`）变化时公开 URL 默认不变；
4. 同一 PromoLink 只能有一个 active 公开码；
5. `/go/{public_redirect_code}` 只按公开码查，**绝不**按渠道真实码查；
6. 禁止任何 Adapter 或业务模块自行生成短码。

---

## 4. 推广码、URL、raw payload 与 PromoLink 的存储分布

### CPS_CURRENT_STORAGE_BEHAVIOR

| 位置 | 存什么 | 文件:行号 | 读可见性 | 写保护 |
| --- | --- | --- | --- | --- |
| `drama_source_item.raw_payload` | **上游整行 JSON 原文**，含推广 URL 字段（`publicUrl` / `homeLink` / `onlineUrl` / `moboTreeUrl` / `deepLink` 等；index signature 全透传） | `src/lib/adapters/changdu.ts:131`（`rawPayload: JSON.stringify(raw)`）；字段清单 `:11-37`（`ChangduRawDrama`） | 后台/DB 可见 | 同步链路写 |
| `drama_promo_link` | 真实 `code` / `webUrl` / `appUrl` / `rawLinksJson` —— 推广资产真身 | `prisma/schema.prisma:292-326` | 后台明文展示 | idempotencyKey upsert |
| `dramas.promo_url / promo_code / app_download_url` | canonical 投影，`/go` 与前端 CTA 的直接数据源 | `prisma/schema.prisma:31-33`；消费 `route.ts:94-110`、`drama-cta.ts` | 后台明文 | manual-promo-lock 锁人工编辑（`stripProtectedPromoFields`），canonical 回写走第三把钥匙 |
| `settlement_orders.code` | 结算行携带的推广码（北斗侧） | `route.ts:119-130` 消费 | 后台报表 | 同步写 |
| `changdu_promo_claim_audit` | **只有掩码**：`[redacted_code:length=N]` + hostname | `src/lib/changdu-promo-claim.ts:371-384,568-570` | 可安全外流 | append-only |
| 后台 UI（畅读链接页） | `code` 与 `webUrl` **明文直接展示**给登录 admin，无角色掩码 | `src/app/(admin)/changdu-links/page.tsx:168-169` | 登录即可见 | 只读展示 |

一句话概括：**真实值在 4 处受控存在（raw 镜像、资产表、canonical 投影、结算表）；读 = 登录后台明文可见；写 = 锁定 + 能力位 + 三把钥匙；审计 = 强制掩码。** 灰产审计（2026-06）暴露并已修复的风险全部在**写路径**（人工编辑注入、token 换绑），不在读可见性。

### 两档方案

**方案 A · 严格复用 CPS 形态（推荐）**

- `NovelSourceItem.raw_payload` 保留上游整行原文（含推广字段）——上游镜像不做选择性删除；
- `PromoLink` 存真实 `upstream_code` / `web_url` + 新增 `public_redirect_code`；
- canonical 投影可选（第三把钥匙，只补空不覆盖）；
- 后台对登录 admin 明文展示；写路径继承 manual-promo-lock + 能力位；
- 审计强制掩码（不可协商）。

优点：成熟、与 CPS 运维认知一致、改造最少；灰产教训已经以"写保护"的形式内化，无需再叠加读掩码。

**方案 B · 进一步收紧读权限**

推广值只进 `PromoLink`，`raw_payload` 写入时掩码推广字段；普通后台角色读 `PromoLink` 只见掩码，明文需能力位。

不推荐的理由：① CPS 生产两年未发生读侧泄露事故，灰产事故的根因是写路径且已修复；② raw 镜像被选择性改写后就不再是"上游说了什么"的忠实镜像，排查上游合同变更时会缺证据；③ 增加一套角色-掩码机制的复杂度，收益无事实支撑——这正是 Owner 明令避免的"为了看起来干净另造结构"。

**v0.2.1 · Owner 已裁决 `CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION`（`OWNER_DECIDED`）**：采用方案 A，唯一偏离是公开 URL 用 `public_redirect_code` 而非 `upstream_code`。D-11 关闭。 candidate-v0.1 中"普通角色只见掩码"的表述**撤回**（超出 CPS 实践且无事故依据）。

---

## 5. 预览内容刷新时，缺失内容如何下架

| 项目 | CPS 当前真实行为 | 文件:行号 | 海外阅读是否复用 | 差异原因 |
| --- | --- | --- | :---: | --- |
| 刷新写入方式 | **纯 upsert**：`INSERT ... ON CONFLICT(provider, app_id, serial_id, episode_order) DO UPDATE`，逐集覆盖状态与 URL | `worker/handlers/preview-sync.ts:379-409` | ✅ 复用语义（换 Prisma/PG 写法） | — |
| 缺失/不可用的表达 | 状态标记：`ok / unavailable / provider_unsupported / retry_pending / error / stale` 六态；探测失败写 `unavailable` 或 `error`，**行保留** | `preview-sync.ts:25-30` | ✅ 复用 | — |
| 是否存在删除路径 | **没有**。全文件无 `deleteMany`/`DELETE`；本轮响应中未出现的集数，其旧行原样保留（旧状态直到下次被重查才变） | `preview-sync.ts` 全文（写入仅 `:379-409` 一处） | ✅ 复用 | — |
| `stale` 状态 | 枚举中保留但**当前所有写入点显式排除**（类型层 `Exclude<PreviewSyncStatus, "stale">`）——预留态，从未写入 | `preview-sync.ts:81,92,427` | 参考 | CPS 把"陈旧"预留成状态而不是删除，方向一致 |
| 前台消费 | 按状态过滤展示（非 ok 不出现） | `@@index([dramaId, status, episodeOrder, updatedAt])`，`prisma/schema.prisma:447+` | ✅ 复用 | — |

### 四个候选策略的比较（v0.2 分析）

| 策略 | v0.2 评估 |
| --- | --- |
| ① 一次缺失立即下架 | ❌ 当时判"不推荐"：上游一次抖动（超时、部分返回）就撤掉在售页面 |
| ② 连续多次缺失后下架 | ✅ 当时的推荐主体：连续 K 次（建议 K=3）→ `stale` |
| ③ 标记 stale，人工处理 | ✅ 推荐并入：`stale` 是"停止展示"，不是删除 |
| ④ 明确上游状态出现后才下架 | ❌ **不可行**：上游 `getchapterinfo` 无删除/下架字段（探测已证），无状态可等 |

### ⛔ v0.2.1 · Owner 已冻结的规则（取代上面的推荐）

D-10 已由 Owner 关闭，最终规则**不是 ②+③**，而是把"抗抖动"从计数器移到了**响应可信度判定**：

```
第一步 · 响应可信度
  请求失败 / 结构异常 / 异常空列表 → 不改变任何现有可见状态，本轮结束
  成功 + 结构完整 + chapterList 非空 → 该列表即当前权威试读集合

第二步 · 与权威集合比对
  同章 hash 未变 → 不重写
  同章 hash 变化 → 更新正文
  新章          → 新增
  旧章缺席      → 立即 stale（停展、退出 sitemap）——不再等 K 次
  stale 章重现  → 自动恢复 preview（写审计，无需人工确认）
任何情况下：
  不自动硬删除 NovelChapterContent（硬删只发生在人工发起的版权撤回）
```

**与 v0.2 推荐的差异**：删除 K 次阈值（`consecutive_miss_count` 字段一并从数据模型删除）、删除人工确认必选（人工队列降为可选运维视图）、新增"自动恢复"。

**为什么策略 ① 的风险不再成立**：v0.2 判它"太脆"，是因为当时把"缺失"与"响应失败"混为一谈。冻结后的规则先拦掉不可信响应——抖动表现为失败/异常/空列表，这些根本不进入比对；能进比对的是结构完整且非空的成功响应，此时"该章不在列表里"就是一个可信事实，立即 stale 是正确反应，且因为可自动恢复、正文不删，代价可逆。

**仍与 CPS 同构**：状态标记而非删除、前台按状态过滤（`preview-sync.ts:379-409` 纯 upsert 无删除路径，`stale` 在其枚举中预留）。数据模型侧只保留 `last_seen_at`（可观测字段），**不再需要 `consecutive_miss_count`**。

---

## 6. 本报告的引用完整性声明

- 全部 `文件:行号` 为本轮在 `d77c3b9` 工作区实读所得；
- 核实全程只用 `grep / sed / ls / wc / cat`（只读），未执行任何写命令；
- 核实结束后 CPS 工作区 `git status --porcelain` 仍为 0 行。
