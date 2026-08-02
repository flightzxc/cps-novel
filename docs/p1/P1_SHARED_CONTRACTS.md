# 海外阅读 P1 · 共享契约

> 跨所有权边界的接口定义。**只定义形状与语义，不写实现。**
> 冻结级别：`FROZEN`（不得改）/ `STABLE`（改动走契约流程）/ `DRAFT`（P1 内可议）

---

## 0. 契约为什么必须先行

Claude 拿前台、Codex 拿后台与渠道层，两侧真正的交汇点只有几个：**数据模型、locale 映射、URL 构造、公开短码、SEO 收录信号、Feature Flag**。这几处一旦口径不一致，症状不是编译错误，而是线上 URL 对不上、语种落错、页面收录不了——全是难查的问题。

所以本文件的每一条都要回答同一个问题：**边界两侧各自负责什么，交出去的东西保证什么。**

---

## 1. 数据读契约（Codex 写 → Claude 读）

**级别：`STABLE`**

前台只读，不写业务表（埋点除外）。约定：

| 项 | 约定 |
| --- | --- |
| 读取方式 | 前台经 `lib/site/**` 的查询层读，**不直接拼 Prisma 查询散落在页面里** |
| 可见性判定 | 前台只读"可公开"的行：`Article.status = published` 且 `Novel.status` 不在 `takedown/unpublished` 且章节 `status = preview` |
| 详情页查询 | **不得带正文**（正文在 `NovelChapterContent` 独立表） |
| 章节查询 | 必须带 `take` 上限，禁止无界 `findMany` |
| 请求级去重 | 详情页查询用 React `cache()` 做请求级去重（CPS R12 的教训） |
| 软删 | 所有查询默认排除 `deleted_at IS NOT NULL` |

**Codex 保证**：任何进入"可公开"状态的行，其必需字段（title / slug / locale / promoLink 公开码）非空。前台不做兜底渲染——缺字段就是数据层的 bug，应该暴露而非掩盖。

---

## 2. Locale 契约 🔴

**级别：`FROZEN`**（硬前置 2）

| 项 | 约定 |
| --- | --- |
| 唯一真源 | `src/lib/locale-canonical.ts`，Owner = Claude |
| 职责 | 上游语种码（数值/名称）→ 站点 locale 的**唯一**映射 |
| 映射失败 | 返回 `unknown`，**不得猜测、不得用上游原值当 locale** |
| `unknown` 的后果 | SourceItem 可建，**Novel 不建**，进人工队列 |
| 发布白名单 | 独立于映射：映射成功 ≠ 可发布；白名单 fail-closed |
| 禁止 | 🔴 **全仓第二处语种映射硬编码**。lint 规则卡住新增映射表 |

**双方接口**：

```
resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?) → SiteLocale | "unknown"
isPublishableLocale(locale) → boolean            // 读发布白名单
listPublishableLocales() → SiteLocale[]          // sitemap 分片、语言聚合用
```

Codex 在归一化阶段调 `resolveSiteLocale`；Claude 在前台路由与 sitemap 分片调后两个。**两侧都不得自己维护语种表。**

---

## 3. URL 构造契约

**级别：`STABLE`**（`D-8` 定案后升 `FROZEN`）

| 页面 | 构造函数（Owner = Claude） | 备注 |
| --- | --- | --- |
| 小说详情 | `buildNovelPath({ locale, publicPageId, slug })` | locale 段形态待 **D-8** |
| 试读目录 | `buildNovelCatalogPath(...)` | 承载形式待 **D-12**（独立路由 or 嵌入详情页） |
| 试读章节 | `buildChapterPath({ ..., chapterNumber })` | 每页独立可索引、self-canonical |
| 语言聚合 | `buildLocaleHomePath(locale)` | |
| 题材聚合 | `buildTagPath({ locale, tagSlug })` | Post-V1 才有公开标签 |
| 跳转 | `buildGoPath(publicRedirectCode)` | **只接受公开短码** |

**规则**：
- 🔴 **任何地方拼 URL 都必须走这些函数**——sitemap、IndexNow、CTA、后台预览链接、结构化数据全部一致；
- Codex 侧（sitemap 生成、IndexNow outbox、后台"查看前台"按钮）**调用** Claude 提供的构造函数，不自己拼；
- **canonical 一律 self-canonical**（详情页、目录页、章节页各自指向自身）；
- **V1 不生成跨 Novel hreflang**。

---

## 4. 公开短码契约 🔴

**级别：`FROZEN`**

| 项 | 约定 |
| --- | --- |
| 唯一生成入口 | `src/lib/public-redirect-code.ts`，Owner = Codex |
| 字段 | `PromoLink.public_redirect_code`，DB `UNIQUE`（部分索引排除软删） |
| 生成算法 | 改造 CPS `article-public-page-id.ts:32-44` 模式：字母表 + **强制含数字** + 冲突重试 + DB 唯一约束兜底 |
| 不可变 | 🔴 创建后**永不重新生成**：重跑同步、换执行体、换代理、上游真实码变化，公开码与公开 URL 均不变 |
| 单 active | 同一 PromoLink 只有一个 active 公开码 |
| 禁止 | 🔴 任何 Adapter / 业务模块 / 前台自行生成短码 |
| 公开面 | `/go/{public_redirect_code}` **只按公开码查**；用渠道真实码访问得 404 |
| 内部值 | `upstream_code` 只存内部，**绝不进公开 URL**、绝不进埋点表 |

**这条契约的存在理由**：不同模型或提示词可能为同一内容重复发明短码或多套生成算法。防线是三层——**唯一入口 + DB 唯一约束 + 不可变**。任何绕过都会在数据库层撞墙，而不是悄悄产生第二套码。

前台接口：`getPublicRedirectCode(novelId) → string | null`；为 null 时 CTA 不渲染（发布门禁已保证已发布内容必有公开码）。

---

## 5. SEO 收录信号契约

**级别：`STABLE`**

Claude 定义"什么页面可索引"，Codex 负责把它变成 sitemap 与 IndexNow 推送。

```
// Owner = Claude，单一真源枚举
isIndexablePage(target: { kind: "novel_detail" | "novel_catalog" | "chapter" | "tag" | "locale_home",
                          novelStatus, chapterStatus, locale, indexAuthorized }) → boolean
```

| 页面类 | 默认 | 翻转条件 |
| --- | --- | --- |
| 小说详情 | ✅ 可索引，self-canonical | `unpublished` / `takedown` → 否 |
| 试读目录 | ✅ 可索引 | 同上 |
| 试读章节（全部物化章节） | ✅ 可索引，self-canonical | 章节 `stale` / `withdrawn` → 否 |
| 语言聚合 / 题材聚合 | ✅ | locale 不在白名单 → 否 |

🔴 **判定必须是代码级枚举 + 单一真源，不能是模板里的 `if`。** "全部可索引"不等于不需要判定——`stale`/下架/撤回随时把单页翻转。

**Codex 侧义务**：状态变化时写 IndexNow outbox（含**移除**信号）；sitemap 生成时调 `isIndexablePage` 过滤，不自己判断。

---

## 6. Feature Flag 契约

**级别：`STABLE`**

| 项 | 约定 |
| --- | --- |
| 定义处 | `src/lib/feature-flags.ts`，Owner = Codex |
| 形态 | 一 flag 一函数、读 env、`=== "true"` 显式判定、**默认关** |
| 双闸 | 有写入的能力必须 `FEATURE_X` + `X_ALLOW_WRITE` 两把钥匙 |
| 前台消费 | Claude 通过 flag 函数读，**不直接读 `process.env`** |
| 新增 flag | 任一侧新增都要在 `docs/governance/` 登记（名称、默认值、影响面、谁读） |

---

## 7. 任务入队契约（前台/后台 → Worker）

**级别：`STABLE`**

| 项 | 约定 |
| --- | --- |
| 入队入口 | 单一带校验的工厂函数，Owner = Codex。**不允许各处散着建任务** |
| dry-run 语义 | 🔴 统一定义：**零上游副作用 + 零正式业务资产写入；允许写 Task / Audit / ProbeResult** |
| 目录扫描互斥 | `(channel_account_id, channel_app_id, project_type)` 同时只允许一个 active |
| 其他任务互斥 | `(task_type, channel_account_id, channel_app_id, operation_scope_hash)` |
| 状态派生 | 🔴 由 item 计数派生，**禁止内存累加器** |
| attempt 计数 | 🔴 **领取时** +1，不是失败时 |

---

## 8. 埋点契约（Claude 触发 → Codex 写入）

**级别：`STABLE`**

```
trackEvent({ eventType, publicRedirectCode?, novelId?, articleId?, context }) → void  // 永不抛出
```

| 项 | 约定 |
| --- | --- |
| 失败处理 | 🔴 **静默降级**。埋点失败绝不影响页面渲染或 `/go` 跳转 |
| 写入策略 | 批量写 + 独立 flush（**不是**每事件一次 `create`） |
| 敏感数据 | IP / User-Agent **盐哈希后存**，不存原值 |
| 记录的码 | **公开短码 + `promo_link_id`**；渠道真实码不进埋点表 |
| 总开关 | 可整体关停（CPS 生产就是关着的） |
| 保留期 | 原始事件建议 90 天，日汇总长期 |

---

## 9. 内容状态契约

**级别：`STABLE`**

Codex 维护状态，Claude 按状态渲染。

| 实体 | 状态 | 前台行为 |
| --- | --- | --- |
| `Novel` | `draft` / `ready` | 不可见（404） |
| | `published` | 正常渲染 |
| | `unpublished` | 稳定下架提示页 |
| | `takedown` | **410 Gone** |
| `NovelChapter` | `preview` | 正常渲染、可索引 |
| | `stale` | 停止展示、退出 sitemap（**正文行仍在**） |
| | `withdrawn` | 404（正文已删） |
| | `locked` | V1 不物化，不渲染 |

**`stale` 的产生与恢复（v0.2.1 冻结）**：可信响应（成功 + 结构完整 + 非空）中该章缺席 → 立即 `stale`；重新出现 → 自动恢复 `preview`。响应不可信（失败/结构异常/异常空列表）时**不改变任何状态**。前台不需要知道这套逻辑，只按当前状态渲染。

---

## 10. 渠道无关性契约

**级别：`FROZEN`**

🔴 **前台对"来源渠道"零感知。**

前台只认 `Novel` / `Article` / `NovelChapter` / `PromoLink.public_redirect_code`，不查 `Channel` / `ChannelApp` / `ChannelAccount`，不因渠道不同而分支渲染。

**这条为二期北斗预留**：Owner 已明确北斗接口尚未调研、表与流程先参照 CPS 短剧占位、二期再开启。渠道无关性保证北斗接入时**前台零改动**——只要新渠道的内容能归一化成 `Novel`，前台就能渲染。

同理，Codex 侧的 `projectType`、`agencyId`、`language` 一律从 `ChannelApp` / `ChannelAccount` 配置解析，**不出现模块级常量**（CPS 有 5 处 `projectType=2` 硬钉，是明确的反面教材）。

---

## 11. 契约变更流程

```
提出方写变更条目（改什么、为什么、影响哪侧）
   ↓
双方 review（架构总工程师终裁）
   ↓
FROZEN 级契约变更 → 需 Owner 确认
   ↓
更新本文件 + docs/governance/development-log.md 留痕
   ↓
两侧同步实施
```

**`FROZEN` 契约清单**（变更需 Owner 确认）：§2 Locale、§4 公开短码、§10 渠道无关性。

---

## 12. 契约速查

| # | 契约 | 级别 | Owner | 一句话 |
| ---: | --- | --- | --- | --- |
| 1 | 数据读 | STABLE | Codex 写 / Claude 读 | 可公开的行必需字段非空，前台不兜底 |
| 2 | Locale | **FROZEN** | Claude | 唯一映射真源，映射不到落 `unknown` 不发布 |
| 3 | URL 构造 | STABLE | Claude | 所有 URL 走构造函数，self-canonical |
| 4 | 公开短码 | **FROZEN** | Codex | 唯一入口 + DB 唯一 + 不可变 |
| 5 | SEO 收录 | STABLE | Claude 判定 / Codex 执行 | 单一真源枚举，含移除信号 |
| 6 | Feature Flag | STABLE | Codex | 一 flag 一函数、默认关、双闸 |
| 7 | 任务入队 | STABLE | Codex | 单一工厂、dry-run 统一定义 |
| 8 | 埋点 | STABLE | Claude 触发 / Codex 写 | 永不抛出、批量写、哈希敏感值 |
| 9 | 内容状态 | STABLE | Codex 维护 / Claude 渲染 | 按状态渲染，不重算业务逻辑 |
| 10 | 渠道无关性 | **FROZEN** | 双方 | 前台零感知渠道；二期北斗接入前台零改动 |
