# 搬运符号登记表（Port Registry）

本表登记所有从 CPS 只读参考仓库搬运到本项目的符号（函数、类型、常量、表结构片段、组件等）。

🔴 **纪律：每个从 CPS 搬入的符号都必须在此登记，未登记即视为违规。** P1-14（最终代码和架构审计）将逐条核对本表与实际代码，任何搬运但未登记的符号视为不符合项。

## 基线

- `baseline_commit` 统一为 CPS 只读参考仓库的固定基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- CPS 只读参考路径：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`（详见仓库根 `CLAUDE.md`）

## `port_kind` 取值说明

| 取值 | 含义 |
| --- | --- |
| `COPY` | 原样复制，未做实质性改动 |
| `ADAPT` | 复制后做了改造（如泛化、参数化、重命名） |
| `PG_REIMPLEMENT` | 语义/思路保留，但因 SQLite → PostgreSQL 差异而重新实现 |
| `PATTERN_ONLY` | 只借鉴设计模式/组织形态，不搬运具体代码 |

## 登记表

P1-05A 只登记从 CPS 提取的数据库**模式证据**；没有字节复制。所有条目均经过 PostgreSQL、多账户、Novel 领域和 Owner 契约改造。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `Channel` schema pattern | `prisma/schema.prisma` | `100-113` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留渠道注册身份；改 UUID、PostgreSQL 类型、具名状态 CHECK 计划和 RESTRICT 删除策略 | Codex |
| `ChannelApp` schema pattern | `prisma/schema.prisma` | `222-246` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 Channel×SourceApp 绑定；`project_type` 参数化并移除模块硬编码 | Codex |
| `ChannelAccount` schema pattern | `prisma/schema.prisma` | `118-148` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留账户实体；冻结 Day 0 多账户，删除任何 Channel 1:1 假设 | Codex |
| Credential encrypted metadata pattern | `prisma/schema.prisma` | `150-168` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 密文改 `bytea`，Web/Scheduler 禁读密文，只保留后台可见 S1 指纹前缀元数据 | Codex |
| Credential fingerprint mutex latch | `prisma/schema.prisma` | `1236-1258` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | 保留 fingerprint/credential 双唯一互斥模式；以 PostgreSQL 唯一约束消除 TOCTOU，不复制 SQLite 锁语法 | Codex |
| SourceItem/canonical separation | `prisma/schema.prisma` | `251-287` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | DramaSourceItem 改 NovelSourceItem；上游镜像与 canonical Novel 分离，普通同步只补 canonical 空值 | Codex |
| PromoLink independent asset | `prisma/schema.prisma` | `292-326` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | DramaPromoLink 改 Novel 推广资产；拆 upstream/public 两码，增加永久公开码与 Article 同 Novel 复合 FK | Codex |
| IndexNow outbox | `prisma/schema.prisma` | `1460-1497` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | 保留 durable outbox 状态形态；幂等身份冻结为 `(url, revision)` 并规划 PostgreSQL claim 索引 | Codex |
| IndexNow outbox attempt | `prisma/schema.prisma` | `1499-1519` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留独立 attempt；真实状态列冻结为 `attempt_state`，删除幽灵 `status` 约束 | Codex |
| `home_carousel_manual_slot` pattern | `prisma/schema.prisma` | `740-757` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | Drama→Novel/Article；enabled 部分唯一谓词改 PostgreSQL boolean 并排除软删 | Codex |
| `home_carousel_auto_batch` pattern | `prisma/schema.prisma` | `762-780` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留批次身份与状态；JSON 文本改版本化 jsonb、时间改 timestamptz | Codex |
| `home_carousel_auto_candidate` pattern | `prisma/schema.prisma` | `786-803` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | Drama→Novel/Article；分数改 numeric，保留 batch/locale/rank 唯一模式 | Codex |
| `home_carousel_serving` pattern | `prisma/schema.prisma` | `808-826` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 冻结为仅当前快照，`(locale, position)` 绝对唯一；删除时间有效期历史职责 | Codex |
| `home_carousel_change_log` pattern | `prisma/schema.prisma` | `831-843` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 保留 append-only 历史模式；移除 Drama 引用并承担 serving 历史变更 | Codex |
| `ADMIN_IDLE_TIMEOUT_MS` / `ADMIN_SESSION_TOUCH_INTERVAL_MS` / `ADMIN_ABSOLUTE_TIMEOUT_MS` | `src/lib/session-timeout.ts` | `3-5` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 2h idle、15min touch、24h absolute 参数；由 JWT token 改为显式 Session record | Codex |
| `validateAdminSession` | `src/lib/session-timeout.ts` | `17-69` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留绝对超时 fail-closed；增加 idle、撤销、identity 状态、session version 与时间序验证 | Codex |
| `requireAdminSession` | `src/lib/admin-session.ts` | `40-88` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 从 NextAuth/Prisma 闭包切成 token hash + `AdminIdentityStore`/`SessionStore` 端口，保留 sessionVersion 拒绝语义 | Codex |
| `AdminCapability` / `ADMIN_CAPABILITY_CONFIG` | `src/lib/admin-capabilities.ts` | `3-29` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 能力名改为 Novel 管理四项；promo/revenue 无默认角色，四项均登记 2FA 风险属性 | Codex |
| `hasAdminCapability` | `src/lib/admin-capabilities.ts` | `45-66` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 role/user env allowlist；输入改为端口化 `AdminAuthContext` | Codex |
| `requireAdminCapability` | `src/lib/admin-capabilities.ts` | `68-80` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 统一为 `admin_capability_denied` 403，并与 2FA 检查保持分层 | Codex |
| TOTP secret/URI/verification primitives | `src/lib/totp.ts` | `3-60` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 SHA1/6 位/30s/±1；移除 otpauth/qrcode 依赖，以 Node crypto 实现 RFC 6238，issuer 改 cps-novel | Codex |
| `encryptTotpSecret` / `decryptTotpSecret` | `src/lib/totp-crypto.ts` | `1-118` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 AES-256-GCM v1 载荷与严格 key/payload 校验；改为显式可注入 key，仍只用于 TOTP | Codex |
| Recovery Code primitives | `src/lib/recovery-codes.ts` | `4-63` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 10 个一次性格式和掩码；因禁止新增 bcryptjs 改为 Node scrypt + 独立盐 | Codex |
| Login failure dual-key limiter | `src/lib/auth-utils.ts` | `5-208` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 username/IP 双维度、5 次/15min；identifier 改 SHA-256 且持久化切为 `LoginAttemptStore` | Codex |
| 2FA pending setup lifecycle | `src/lib/two-factor-settings.ts` | `4-239` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 10min pending、确认后启用、恢复码轮换与 sessionVersion 前进；切断 Prisma/QR UI 闭包 | Codex |
| 2FA login challenge lifecycle | `src/lib/two-factor-login.ts` | `263-529` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 hash token、5min、5 次、TOTP/恢复码和单次消费；改为存储端口 | Codex |
| `ADMIN_PAGE_ROOTS` / segment-safe match | `src/proxy.ts` | `20-45` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 路由清单换为 Novel 后台 14 根路径，并新增未登记页面/API/Action 默认 404 | Codex |
| Credential capability boundary pattern | `src/app/(admin)/channel-accounts/actions.ts` | `49-200` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只保留六操作命名与入口先鉴权模式；本轮不搬 Credential 写入、解密、渠道校验或 Action 实现 | Codex |
| `validateCredentialJwtLocally` | `src/lib/channel-account/jwt.ts` | `66-109` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留三段 JWT、base64url payload 与 exp 秒/毫秒解析；输出映射为 active/expired/invalid，不声明验签且不访问网络 | Codex |
| Worker Credential AES-GCM envelope | `src/lib/channel-account/credential-crypto.ts` | `31-131` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 AES-256-GCM 严格 key/envelope 校验；改为 Worker-only versioned key、bytea envelope，并用 account/credential UUID AAD 隔离 | Codex |
| Worker Credential fingerprint HMAC | `src/lib/channel-account/credential-crypto.ts` | `133-148` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 HMAC-SHA256 指纹；拆分独立稳定 fingerprint key，完整值仅 Worker/DB 内部，DTO 只给 12 字符 prefix | Codex |
| insert-before-delete fingerprint reservation | `src/lib/changdu-total-revenue/credential-service.ts` | `299-301,385-389` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 保留唯一占位先预留再释放旧值的并发原则；小说使用 PostgreSQL UNIQUE 最终裁决并纳入 P1-07 fenced transaction | Codex |
| `formatDateTime`（源 `formatDate`） | `src/lib/utils.ts` | `10-20` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `zh-CN` 年月日时分与空值 `-` 的口径（运营与 CPS 并排看表，改格式会直接读错）；入参收窄为 ISO 字符串，并对非法日期同样回落 `-` | Claude |
| `COMMON_STATUS_MAP` 形态 | `src/lib/constants.ts` | `26-44` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只借 `{ label, color }` 按状态值查表的形态；取值全部重写为 novel/chapter/exception 三张表，依据 `DATABASE_STATUS_SEMANTICS` 而非 CPS 文案 | Claude |
| 后台列表表格外观（表头/分隔/行悬停/两行身份单元格） | `src/components/dramas/dramas-list-client.tsx` | `199-360` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只保留 `bg-gray-50` 表头、`divide-y divide-gray-100`、`px-4 py-3`、名称over ID 的两行单元格与右对齐操作列；**不搬**勾选列、批量工具条、编辑/删除图标——本期无写操作 | Claude |
| 后台筛选栏（GET 表单，字段名即查询参数） | `src/app/(admin)/dramas/page.tsx` | `93-160` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 保留纯 `method="GET"`、URL 可分享、不引入客户端状态；选项来源换成 `NOVEL_STATUSES` 与 `SITE_LOCALES` | Claude |
| 后台分页页脚 | `src/app/(admin)/dramas/page.tsx` | `166-196` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「第 x / y 页，共 n 条」+ 上/下一页、单页时整块不渲染；改用 `URLSearchParams` 克隆当前参数，修掉 CPS 手工字符串拼接会拼坏含 `&` 搜索词的问题 | Claude |
| 标签字典列表的列组织（P2-06） | `src/app/(admin)/tags/_components/tag-rule-list.tsx` | `222-335` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只借「主标识 mono + 维度彩色胶囊 + 关联计数裸数字」的列组织与信息密度；内容从 TagRule 规则换成上游原始标签，**不搬**新建/编辑/删除按钮、`confirm()` 删除流与整个操作列——本期严格只读。页面外框改走本仓 `/novels` 既有形态（卡片化筛选栏 + GET 表单 + 卡片化分页），不采用 CPS 该页的裸 div + CSR 即时筛选 | Claude |
| 「查看关联小说」行内链接（P2-06） | `src/app/(admin)/tags/_components/tag-rule-list.tsx` | `299-307` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「标签行直接跳到被该标签标注的内容列表」这一交互形态；CPS 原链接指向 `/dramas?tagId=`，而 `/dramas` 的 searchParams 根本不含 `tagId`（参数被静默忽略，是条失效链接）——小说侧改为 `?labelId=<source_label.id>` 并在 `novelFilters()` 里以 `EXISTS` 谓词真正接通 | Claude |
| `withDbRetry`/`isTransientDbError`/`summarizeDbError` | `src/lib/db-retry.ts` | `1-122` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留退避重试循环与结构化日志形状；transient 判定从 SQLite 消息正则改为 PostgreSQL 错误码（P1008/P2034 transient，P2002/P2003 non-transient），并新增 `isUniqueConstraintViolation`/`isSerializationFailure`/`isForeignKeyViolation` 独立导出供 `credentials/service.ts` 复用（消灭该文件原有的第二套内联判定） | Claude |
| IndexNowOutbox 8 新字段（`lastRequestAt`/`lastResponseAt`/`deferReason`/`releasedAt`/`releaseReason`/`releaseCommit`/`payloadHost`/`deliveryTaskId`） | `prisma/schema.prisma`（`IndexNowDelivery`） | `1460-1497` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留生命周期时间戳、review-defer 三件套与审计字段语义；`deliveryTaskId` 从 SQLite `Int`（指向 `BatchTask.id`）改为 `String? @db.Uuid`（指向 `GenericTask.id`），且不建 Prisma relation/FK（对称既有 `sourceTaskId`，规避 GenericTask 365 天保留期冲突） | Claude |
| IndexNowOutboxAttempt `outcome`/新 `attemptState`/`workerTaskId` | `prisma/schema.prisma`（`IndexNowDeliveryAttempt`） | `1499-1519` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | CPS 单一 `attemptState` 字段承担 HTTP 结果分类语义；小说侧原 `attemptState`（0 消费方）更名为 `outcome`（取值不变），腾出的名字改承接本条目移植的 CPS 崩溃恢复语义（`started/completed/unknown_outcome`）；`workerTaskId` 同 `deliveryTaskId` 改型且不建 FK | Claude |
| `SiteSetting` 单例表（仅站点 SEO/IndexNow 字段） | `prisma/schema.prisma` | `1524-1556` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | 保留单例配置表形态与站点 SEO/IndexNow 字段语义；新增 `site_setting_singleton_check` CHECK 在数据库层强制单例（CPS 仅靠应用纪律）；`friendLinks` 由 JSON 序列化 `String` 改 `jsonb`；**不搬**北斗/飞书渠道专属字段与轮播 JSON 配置字段（CPS 无对应集成，轮播已有按批次规范化参数表） | Claude |
| `checkDramaSlugAccess` → `checkNovelArticlePublicAccess` | `src/proxy.ts` | `74-138` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「published article + 关联记录权利态」的判定骨架；返回值从 `NextResponse \| null` 改为框架无关的判别式结果（`published/unavailable/takedown/not_found`，本轮无可挂载的公开路由/中间件）；**新增** promo readiness 复核（CPS 原版从不读 `promoUrl`，Owner 裁决新增该 invariant）；不搬 CPS 的 slug-alias 解析前置步骤（小说仓暂无 slug-alias 表） | Claude |
| `PRIMARY_DRAMA_RECORD`/`buildXxxWhere` 组合子形态 | `src/lib/drama-query-helpers.ts` | `1-45` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只借「基础谓词常量 + `buildXxxWhere(extra)` 用 `AND` 组合」的形态；Drama 换 Novel/Article 两组独立谓词，且**不搬** CPS `promoUrl: { not: "" }` 不 trim 的 DB 层判定——小说侧 DB 预过滤只做粗粒度状态筛选，应用层 `isPromoReady` 才是权威（`DECISION-CHECK.md` 核查3 实证的 CPS 已确认缺陷，本轮明令不得复刻） | Claude |
| `dispatchFirstPublicPublication` | `src/lib/publication-dispatcher.ts` | `1-46` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「按 IndexNow/Sitemap 两条独立 side effect 各自 try/catch、失败互不阻塞」的编排骨架与错误收集形状；CPS 静态 import 两个 enqueue 函数并各自查 feature flag，小说侧两个 enqueue 函数均不存在（IndexNow/Sitemap 业务是 Stream E/D 范围），改为可选 `handlers` 参数注入，今天零 handler 即安全 no-op | Claude |
| `buildDramaArticlePath`/`buildDramaArticleRoutePath`/`parseDramaArticleSlugParam` → Article path builder | `src/lib/drama-article-path.ts` | `1-55` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 locale 前缀 + short-id 后缀 URL 构造与其反解析；**删除** `flagOn`/可选 `shortId` 分支（`Article.publicPageShortId` 恒非空，无历史灰度可迁就）；路由段从 `/drama/` 改 `/novel/`；`parseArticleSlugParam` 不假设 CPS 固定 8 位长度 | Claude |
| `resolveArticlePublishTimeForWrite` | `src/lib/article-publish-time.ts` | `1-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制：published 且无显式/既有 publishTime → now，否则取 submitted/existing 首个非空值；零依赖纯函数，字段名与业务语义均未改动 | Claude |
| `offlineDrama`/`takedownDrama`/`restoreDrama` 编排骨架 → `applyNovelRightsTransition`(withdraw/takedown/restore) | `src/actions/drama-publish-actions.ts` | `294-486` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「查询受影响 article → 更新 status → 下游任务」顺序与三态划分；**改**：`rightsStatus` 独立轴改读同一 `NovelStatus`/`ArticleStatus` 枚举；`offline`纯 404 改 `unpublished` 的 noindex 保留页语义（本 PR 只落状态，不做渲染层）；`takedown` 新增 `NovelChapterContent` 删除工作流（CPS 无对应代码）；`restoreDrama` 可能直接回到之前状态（含 published）在小说侧明确**不搬**——改为恒回 `draft`，再次发布必须重过 evaluator（P2_01 §0 决策4 无 MANUAL_EXCEPTION）；revalidate 步骤delegate 给 Stream C，本 PR 不实现 | Claude |
| `publishDrama` 编排骨架（刨去 article-generation 部分）→ `applyPublishTransition` | `src/actions/drama-publish-actions.ts` | `93-288`（刨去 `buildArticleSnapshot`/`getPreferredAutoTemplate` 约 60 行后的骨架） | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「查找已有 article → 切换 status → 下游任务」骨架；**新增**（CPS 无对应）：发布前必须调用 evaluator（P2-07 核心交付）、Novel 与其 Article 同事务共同发布；**不搬** `buildArticleSnapshot`/`getPreferredAutoTemplate` 模板自动渲染正文逻辑（小说侧 Article.body 由已授权内容生产路径填充，非本任务范围） | Claude |
| `getHomeName` | `src/lib/breadcrumb-i18n.ts` | `31-34` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制；多语词条保留 | Cursor |
| `addHeadingIds` | `src/lib/blog-content-utils.ts` | `17-28` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `extractTocItems` | `src/lib/blog-content-utils.ts` | `34-61` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `extractFaqItemsFromContent` | `src/lib/blog-seo.ts` | `191-213` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制；不搬 blog 路径 / hreflang / BlogPosting | Cursor |
| `extractFaqItemsFromJsonBlocks` | `src/lib/blog-seo.ts` | `164-189` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `buildFaqJsonLd`（源 `buildBlogFaqJsonLd`） | `src/lib/blog-seo.ts` | `215-231` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 去 Blog 前缀；JSON-LD 形状不变 | Cursor |
| `Pagination` | `src/components/site/pagination.tsx` | `10-59` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 去掉 next-intl / `@/i18n/navigation`；英文 label props；token 换成 novel-* | Cursor |
| `generateWebSiteJsonLd` | `src/lib/seo-utils.ts` | `14-22` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | origin 改走 `_shared.getSiteUrl`，无 PulseDrama 默认域 | Cursor |
| `generateCreativeWorkJsonLd` | `src/lib/seo-utils.ts` | `38-57` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `@type` 改 Book；`/drama/${slug}` 改为调用方传入 url；`episodeCount`→`chapterCount`；删 platform/provider | Cursor |
| `generateBreadcrumbJsonLd` | `src/lib/seo-utils.ts` | `66-77` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制（origin 经 getSiteUrl） | Cursor |
| `generateItemListJsonLd` | `src/lib/seo-utils.ts` | `88-103` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `canonicalUrl` | `src/lib/seo-utils.ts` | `107-109` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `buildHreflangAlternates` | `src/lib/seo-utils.ts` | `127-135` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `SUPPORTED_SITE_LOCALES` 换成 `SITE_LOCALES`；仍是同路径 locale 前缀 map，不是跨 Novel 兄弟页 | Cursor |
| `shouldNoIndex` | `src/lib/seo-utils.ts` | `139-141` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `normalizeMetadataTitle` | `src/lib/seo-meta-generator.ts` | `82-94` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `generateSeoMeta` | `src/lib/seo-meta-generator.ts` | `103-126` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | entity 从 drama/tag/category 收成 novel/home/collection；删 Short Dramas 默认文案 | Cursor |
| `truncateDescription` | `src/lib/seo-templates/_shared.ts` | `7-15` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `buildCanonical` | `src/lib/seo-templates/_shared.ts` | `21-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | origin 经 getSiteUrl，无 PulseDrama 默认域 | Cursor |
| `buildLocaleCanonical` | `src/lib/seo-templates/_shared.ts` | `31-37` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制（en 无前缀） | Cursor |
| `resolveOgImage` | `src/lib/seo-templates/_shared.ts` | `40-44` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 去掉 pulsedrama 默认图；缺图 fail-closed | Cursor |
| `paginatedRobots` | `src/lib/seo-templates/_shared.ts` | `47-50` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `getSiteUrl` | `src/lib/site-url.ts` | `3-9` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 先内联进 `_shared.ts`；PR4 改为与 Stream D `site-url.ts` 同语义（仅 `SITE_URL`、校验绝对 HTTP(S) origin、无 `NEXT_PUBLIC_SITE_URL` 回退）。D 的文件尚未合入整合分支，本实现留 TODO 指向 `src/lib/seo/site-url.ts` 收敛点 | Cursor |
| `toAbsoluteUrl` | `src/lib/site-url.ts` | `11-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制到 `_shared.ts` | Cursor |
| `openGraphLocaleTag`（源 `toOgLocale`） | `src/lib/i18n/og-locale.ts` | `31-33` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 改名以免触发「第二份 locale 映射」守卫；表内容保留 | Cursor |
| `buildNovelSeoMeta`（源 `buildDramaSeoMeta`） | `src/lib/seo-templates/drama.ts` | `36-123` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 文案与 JSON-LD 从 TVSeries/VideoObject 改成 Book；删预告片分支 | Cursor |
| `getStaticSitemapRoot`/`readStaticSitemapFile`/静态响应头 | `src/lib/static-sitemap-cache.ts` | `1-54` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 原样保留 current 目录读取、路径穿越防御、缓存头和缺失返回 null；仅移动到 `src/lib/seo/` | Codex |
| `generateStaticSitemaps`/release 校验与原子 symlink 切换 | `src/lib/static-sitemap-generator.ts` | `1-271` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 release 写入、自检、manifest 和 current.tmp→current 原子切换；类型缩为 mainpage/novelpage，locale 改读冻结白名单，PR1 要求显式注入 family builder | Codex |
| Sitemap 文件锁、状态机与错误脱敏 | `src/lib/sitemap-refresh-state.ts` | `1-333` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 wx 排他锁、running/success/failed 状态、失败保留旧版本与敏感值脱敏；移动到 `src/lib/seo/` 并显式透传 family builder | Codex |
| `renderUrlSetXml`/`renderSitemapIndexXml`/`parseSitemapFileName` | `src/lib/sitemap.ts` | `30-69,96-99,139-155,699-743` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 提取无 DB 纯核心；类型缩为 mainpage/novelpage，文件名解析只认 `listPublishableLocales()`，不提供 fixture HTTP 白名单 | Codex |
| `GET /sitemap.xml` 静态只读路由 | `src/app/sitemap.xml/route.ts` | `1-23` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 Node runtime、force-dynamic、静态命中 200 与缺失 503；仅调整 import 落点，禁止动态查库兜底 | Codex |
| `GET /sitemap/[fileName]` 静态只读路由 | `src/app/sitemap/[fileName]/route.ts` | `1-35` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留文件名先验校验、非法 404、静态缺失 503；仅调整 import 落点，fixture 验收不经过 HTTP | Codex |
| `robots` metadata 路由 | `src/app/robots.ts` | `1-17` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 allow 全站、私有前缀 disallow 与 sitemap 声明；后台路径换为小说仓路由，站点 origin 改为必填且严格校验的 SITE_URL | Codex |
| `getSiteUrl`/`toAbsoluteUrl` | `src/lib/site-url.ts` | `1-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留单一绝对 URL 接缝与相对路径拼接；删除 CPS 硬编码域名和 NEXT_PUBLIC 回退，SITE_URL 缺失或非纯 origin 时 fail-closed | Codex |
| `buildDramaPageEntries`/`buildMainPageEntries`/`buildSitemapFamily` → `createSitemapFamilyBuilder` | `src/lib/sitemap.ts` | `157-205,260-310,420-444,476-484,640-696` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 仅保留首页与 Article 详情页集合、10,000 分片和 PG Date lastmod；DB 层 PromoLink 非空只做预过滤，每行仍调用冻结的 `isPromoReady`/发布状态谓词；URL 直接复用冻结 `buildArticlePath`，删除 blog/Category/Tag/北斗分支 | Codex |
| `enqueueSitemapRefresh` | `src/lib/sitemap-refresh-enqueue.ts` | `1-57` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 pending/processing coalesce 意图；CPS BatchTask 改接 GenericTask 单一 global scope，并用 PostgreSQL advisory transaction lock 消除并发重复；关闭 feature flag 时不建任务，不搬旧 stale-recovery | Codex |
| `handleSitemapRefresh` → `createSitemapRefreshHandler` | `worker/handlers/sitemap-refresh.ts` | `1-70` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留有效文件锁 coalesced success、35 分钟陈旧锁按 runId 释放后仅重试一次、失败保留旧版本；改为 GenericTask `TaskHandler` outcome 并复用 runtime lease/heartbeat/fencing/过期回收 | Codex |

### 无搬运的任务（显式登记，避免被当成漏登）

| 任务 | CPS 复刻分类 | 原因 |
| --- | --- | --- |
| P1-11 阅读器功能 | `ORIGINAL_REQUIRED` | CPS 零可复用的正文托管、分章渲染、阅读版式资产——CPS 的试看是视频跳转，语义不可平移。**本轮无任何从 CPS 搬入的符号。** |
| P2-08 PR2 公开接库 | `ORIGINAL_REQUIRED` | 公开路由、`src/lib/site` mapper、轮播空桩均为小说仓地基上的新接线。takedown/withdrawn V1 走页面层 `notFound()`（404），不搬 CPS proxy 410。明确不搬 `home-carousel-queries.ts`（Owner 裁决空数组）、`drama-hreflang.ts`、`site-queries.ts`、跨 Novel hreflang、`/go` handler。 |
| `PUBLIC_LIST_CAP=240` 内存分页硬顶 | `ORIGINAL_REQUIRED` | 公开列表 `findMany({ take: 240 })` 后再 `isPromoReady` 过滤、内存分页。超限后 browse 的 `totalCount`/`totalPages` 失真，且 sitemap 可能收录 cap 之外的 URL 而 `/browse` 列不出（内链缺口）。V1 接受该限制，本轮不改实现。 |

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
