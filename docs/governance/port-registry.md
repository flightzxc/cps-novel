# 搬运符号登记表（Port Registry）

本表登记所有从 CPS 只读参考仓库搬运到本项目的符号（函数、类型、常量、表结构片段、组件等）。

🔴 **纪律：每个从 CPS 搬入的符号都必须在此登记，未登记即视为违规。** P1-14（最终代码和架构审计）将逐条核对本表与实际代码，任何搬运但未登记的符号视为不符合项。

## 基线

- `baseline_commit` 统一为 CPS 只读参考仓库的固定基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- X10 依 Owner 指定的短剧 tag `v8.2.18` 取证；登记时使用 peeled commit `0ec20c4ee08b4b007e773feab811703a59ac3048`，不使用 annotated tag object ID。
- CPS 只读参考路径：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`（详见仓库根 `CLAUDE.md`）

### X 系列上线加固参考基线（2026-08-26）

X1–X4/X6/X7/X9/X10 如需核对已上线的 CPS 运维流程，只从另一只读工作区
`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin` 执行 `git show v8.2.18:<path>`。
annotated tag `v8.2.18` 的 peeled commit 固定登记为
`0ec20c4ee08b4b007e773feab811703a59ac3048`；X 系列新增条目必须在 `baseline_commit` 列写该 peeled commit，
不得写 tag 名或 tag object。旧条目仍保留当时的 `d77c3b...` 证据链，不批量改写。
标签多语资产、北斗与飞书专属逻辑仍明确禁止搬运。

### RC-1 v8.3.6 生产 tag 参考基线（2026-09-03）

RC-1（后台推广链接领取入口）对齐的是同一只读工作区
`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin` 上更新的生产 tag `v8.3.6`
（`submitChangduPromoClaim` 的 CPS v8.3.6 版本）；执行的是 `git show v8.3.6:<path>` /
`git grep <pat> v8.3.6 -- <path>`，工作树本身不可读、不 checkout/stash。annotated tag `v8.3.6`
的 peeled commit 固定登记为 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`
（`git rev-parse 'v8.3.6^{commit}'` 实测）；RC-1 新增条目在 `baseline_commit` 列写该 peeled commit，
不写 tag 名或 tag object。与 v8.2.18 一样，这只是同一只读路径上的另一个已冻结生产快照，不影响
上方 X 系列条目仍固定在 v8.2.18。

### RC-3 上游请求纪律参考基线（2026-09-03）

RC-3（MoboReader 上游请求节流与 429/503 退避）与 RC-1 引用同一个冻结快照，
`baseline_commit` 规则完全照上一节执行：peeled commit `16f2e4cfca51f46af0dede899ecf6242a770bbd0`，
只走 `git show v8.3.6:<path>`，不读该仓工作树。补充两条**不得**写进 `baseline_commit` 的 ID，
以免后来者取错：annotated tag object 本身
（`4d8841234a2ae8385f78d6f7da3f068605e7e19d`，即 `git rev-parse v8.3.6` 的输出），
以及取证当时该只读仓工作树的 HEAD（`5096765a7d53ba704bc8d07322864c366cb41895`）——
两者都不是 tag 指向的提交。

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
| `formatDateTime`（源 `formatDate`） | `src/lib/utils.ts` | `10-20` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `zh-CN` 年月日时分与空值 `-` 的口径（运营与 CPS 并排看表，改格式会直接读错）；入参收窄为 ISO 字符串，非法日期同样回落 `-`；容器无 TZ，故显式 `timeZone: Asia/Shanghai`（落 `src/features/admin-ui/datetime.ts`），时区由 `AdminTimeZoneNote` 每页声明一次而不写进值里——表格逐行重复会撑宽列且读成噪声 | Claude |
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
| `Pagination` | `src/components/site/pagination.tsx` | `10-59` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 去掉 next-intl / `@/i18n/navigation`；token 换成 novel-*；文案改走前台 messages catalog（无英语 default merge） | Cursor |
| `common.viewAll` → `home.viewAll` | `src/messages/en.json` | `24` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 只借 UI 语气；`View All` → `View all`；drama 口吻不搬 | Claude |
| `common.featured` → `home.featuredEyebrow` | `src/messages/en.json` | `21` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 只借 Featured 眉标语义 | Claude |
| `common.pageOf` → `pagination.pageOf` | `src/messages/en.json` | `30` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 原样 `{current} / {total}` | Claude |
| `common.episodes` → `novel.chapterCount` / `home.chapterCount` | `src/messages/en.json` | `31` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `{count} Episodes` → `{count} chapters` | Claude |
| `error.title` → `unavailable.unpublishedTitle` | `src/messages/en.json` | `64` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `This drama is unavailable` → `This book is temporarily unavailable`；另写 takedown 永久性撤回（短剧站无对等句） | Claude |
| `error.home` → `unavailable.returnHome` | `src/messages/en.json` | `66` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `Return Home Now` → `Back to home`，去掉促销口吻 | Claude |
| tag/drama `coverAlt` → `novel.coverAlt` | `src/messages/en.json` | `91,97` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `{name} cover` → `Cover of {title}`；不用《》 | Claude |
| `generateWebSiteJsonLd` | `src/lib/seo-utils.ts` | `14-22` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | origin 改走 `_shared.getSiteUrl`，无 PulseDrama 默认域 | Cursor |
| `generateCreativeWorkJsonLd` | `src/lib/seo-utils.ts` | `38-57` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `@type` 改 Book；`/drama/${slug}` 改为调用方传入 url；`episodeCount`→`chapterCount`；删 platform/provider | Cursor |
| `generateBreadcrumbJsonLd` | `src/lib/seo-utils.ts` | `66-77` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制（origin 经 getSiteUrl） | Cursor |
| `generateItemListJsonLd` | `src/lib/seo-utils.ts` | `88-103` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `canonicalUrl` | `src/lib/seo-utils.ts` | `107-109` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `buildHreflangAlternates` | `src/lib/seo-utils.ts` | `127-135` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `SUPPORTED_SITE_LOCALES` 换成 `SITE_LOCALES`；仍是同路径 locale 前缀 map，不是跨 Novel 兄弟页 | Cursor |
| `shouldNoIndex` | `src/lib/seo-utils.ts` | `139-141` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| `normalizeMetadataTitle` | `src/lib/seo-meta-generator.ts` | `82-94` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制 | Cursor |
| 生产 `.env.example` 分节模板形态 | `.env.example` | `1-120` | `0ec20c4ee08b4b007e773feab811703a59ac3048` | `PATTERN_ONLY` | 只借鉴“按配置域分节 + secret 留空 + 运维注释”形态；重写为 PostgreSQL 多角色 URL、7 个 Docker password file、独立加密/fingerprint key、compose 构建元数据、五组双闸与分阶段 Worker allowlist；不搬 SQLite 路径、短剧域名、NextAuth/Turnstile、北斗或飞书配置 | Codex |
| `bootstrap-admin-identity.ts` 运维 CLI 纪律形态 | `scripts/reset-password.ts` | `1-40` | `0ec20c4ee08b4b007e773feab811703a59ac3048` | `PATTERN_ONLY` | 只借鉴“独立运维脚本 + 复用正式密码 hash + 明确失败退出”的形态；改为仅冷启动首个 `super_admin`、密码只走 env 且至少 12 位、默认 dry-run/`--apply`、稳定 request-id、advisory lock、scrypt 和同事务 `OperationAudit`；不搬短剧 argv 明文密码、无审计 update 或既有用户重置语义 | Codex |
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
| `chunkIndexNowDeliveries`/`summarizeIndexNowValue`/`parseRetryAfter`/`computeRetryDelayMs` → `src/lib/indexnow/delivery-primitives.ts` | `src/lib/indexnow-delivery-service.ts` | `23-56` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制：批量切分、脱敏正则、`Retry-After` 解析、指数退避 5min×2^n 封顶 6h+20% jitter 全部零依赖纯函数，逻辑未改 | Claude |
| `classifyIndexNowResult` → `src/lib/indexnow/delivery-primitives.ts` | `src/lib/indexnow-delivery-service.ts` | `58-67` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 200/202→accepted、400/403/422→永久失败、429/5xx/网络错误→重试的分类规则；返回值从 CPS 的 delivery-row 状态常量（`INDEXNOW_DELIVERY_STATUS`）改为 attempt 粒度的 `IndexNowAttemptOutcome`（`accepted/permanent_failed/retryable_failed`），行级状态转换单独放进新写的 `resolveOutboxDeliveryStatus`（无 CPS 对应，见下一条） | Claude |
| `applyAttemptResult` 的状态决策部分 → `resolveOutboxDeliveryStatus` | `src/lib/indexnow-delivery-service.ts` | `83-94` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「attempt outcome + attemptNo/maxAttempts → row 级 status/nextAttemptAt」的判定规则（含 dead_letter 阈值）；写入部分不搬（CPS 原函数读写合一，小说侧拆成纯判定函数供 handler 与 recovery 两处复用） | Claude |
| `INDEXNOW_ENDPOINT`/`INDEXNOW_HTTP_BATCH_SIZE`/`INDEXNOW_HTTP_TIMEOUT_MS` | `src/lib/indexnow-delivery-service.ts` | `16-19` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制：endpoint URL、500 批量上限（本轮 handler 未消费该常量，见下方 worker handler 条目的"未采用"说明）、10s 超时 | Claude |
| `INDEXNOW_DELIVERY_TASK_TYPE`/`SITEMAP_REFRESH_TASK_TYPE`/`INDEXNOW_SITEMAP_STALE_MS` → `src/lib/indexnow/outbox-contract.ts` | `src/lib/indexnow-outbox-contract.ts` | `1-5` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制三个任务类型/阈值常量；`SITEMAP_REFRESH_TASK_TYPE`/`INDEXNOW_SITEMAP_STALE_MS` 是 P2-10 共用候选，本任务主导实现（`P2-11.md` §9） | Claude |
| `INDEXNOW_DEFER_REASON`/`resolveIndexNowReviewMaxWaitMs` 两阶段审核延迟状态机 → 单一通用 defer/release 字段读写 | `src/lib/indexnow-outbox-contract.ts` | `7-38` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只借「`deferReason`/`releasedAt`/`releaseReason` 字段承担手动延迟提交」这个形态；**不搬** CPS 绑定 AI 生成审核流程的两阶段编码（`await_review_schedule`/`await_review`）与自动 watchdog 释放——小说仓无对应生成审核环节，`deferReason` 改为自由文本，`releaseDeferredIndexNowOutbox` 只做人工释放 | Claude |
| `normalizeCanonicalUrl`/`buildIndexNowIdempotencyKey` → `src/lib/indexnow/eligibility.ts` | `src/lib/indexnow-outbox.ts` | `22-45` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | `normalizeCanonicalUrl` 逻辑原样保留（https 强制、host 小写、默认端口剥离、query/fragment 拒绝、双重编码检测）；`buildIndexNowIdempotencyKey` **不搬**——小说仓幂等目标是 `@@unique([url, revision])` 复合键，不再需要单列哈希键（`DECISION-CHECK.md` 核查1a） | Claude |
| `isIndexNowPageEligible`/`loadEligibleIndexNowPages` → `isNovelIndexNowEligible`/`loadIndexNowCandidateArticle` | `src/lib/indexnow-outbox.ts` | `47-87` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「locale 白名单 + 谓词族 + 路径可解析」三条件结构；drama 四表联查/`rightsStatus`/`articleType` 分支全删（小说仓无对应多态），改为组合 `visibility.ts` 的 `isIndexNowEligible` + `isPublishableLocale` | Claude |
| `enqueueIndexNowFirstPublish` → `src/lib/indexnow/outbox.ts` | `src/lib/indexnow-outbox.ts` | `136-216` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「查候选→判定资格→`create()`+`catch(P2002)`→按需派发投递」整体流程骨架；输入从 `articleIds: number[]` 收窄为单篇 `articleId: string`（冻结的 dispatcher 契约只传一篇）；冲突目标从 `idempotencyKey` 单列改 `(url, revision)` 复合键；派发目标从 `ensureIndexNowDeliveryTask`/`BatchTask` 改为 `GenericTask`/`GenericTaskItem`（见下方 worker handler 条目） | Claude |
| `findPublishedWithoutIndexNowDelivery` → `src/lib/indexnow/outbox.ts` | `src/lib/indexnow-outbox.ts` | `327-350` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留差集查询骨架（已发布 Article 减去已有 outbox 记录）；`publishTime` 字段改 cps-novel 的 `status='published'`（无独立 publishTime 列）；候选逐条重新过 `isNovelIndexNowEligible` | Claude |
| `recoverStaleIndexNowDeliveries` → `src/lib/indexnow/recovery.ts` | `src/lib/indexnow-delivery-service.ts` | `109-169` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「processing 超时 + 最新 attempt 的 started/completed 分支」崩溃恢复算法；`attemptState` 枚举取值不变（`started/completed/unknown_outcome`，地基已冻结在 `INDEXNOW_ATTEMPT_RECOVERY_STATES`）；`completed` 分支改用新写的 `resolveOutboxDeliveryStatus`（见上）而非内联重复判定 | Claude |
| `deliverDueIndexNow` 的手写逐行 CAS 认领循环 | `src/lib/indexnow-delivery-service.ts` | `249-268` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY`（**不搬代码，只借问题域**） | 不搬 CPS 手写的 `updateMany` CAS 认领；改用小说仓既有 `GenericTaskItem` 的 `executionToken`/`leaseEpoch` 租约机制（`src/lib/tasks/store.ts`，P1-07 已验证），详见 `worker/handlers/indexnow-delivery.ts` | Claude |
| `deliverDueIndexNow` 的 HTTP 投递主体 → `worker/handlers/indexnow-delivery.ts` | `src/lib/indexnow-delivery-service.ts` | `270-368` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留请求构造（`AbortController` 10s 超时）、`urlList` payload 结构、响应分类与 attempt/outbox 两段写入顺序；**改**：CPS 单次投递最多 500 URL 批量，小说仓 V1 改为一个 `GenericTaskItem` = 一次投递 = 一个 URL（`INDEXNOW_HTTP_BATCH_SIZE` 未被 handler 消费，理由见 `delivery-primitives.ts` 头部注释）；`cancelEligibilityDrift` 的"投递前复核资格漂移"思路保留但内联到单行处理里，不再是独立批量函数 | Claude |
| `site-url.ts`（`getSiteUrl`/`toAbsoluteUrl`）→ `internal-site-url.ts`（`toAbsoluteSiteUrl`） | `src/lib/site-url.ts` | `1-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 env 覆盖 + 默认站点 URL + 末尾斜杠归一化；因 P2-09/Stream C 尚未落地共享 `site-url.ts`，本任务改为 `src/lib/indexnow/` 私有副本，明确标注等 Stream C 落地后废弃合并（该文件头部注释） | Claude |
| `manifestHashPayload`/`computeManifestSha256`/`verifyManifestSha256` | `src/lib/indexnow-backfill-manifest.ts` | `1-41` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制并收敛至 Codex 独占的 `src/lib/indexnow/backfill-manifest.ts`；`IndexNowBackfillEntry.drama_id` 改名 `novel_id`，删除 `source_app`/`batch_task_id`（CPS AI 生成任务专属，无对应） | Codex |
| `assertBackfillWriteGates`/`assertBackfillStopConditions` | `scripts/indexnow-backfill-apply.ts` | `26-61` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制两道双闸判定（`--confirm`+`ALLOW_WRITE`、403 硬停/422>3 次停/终态失败率>5% 停/worker 任务失败停）；`prisma.batchTask.count` 换 `prisma.genericTask.count` | Claude |
| `scripts/indexnow-backfill-apply.ts` 主流程（`main`） | `scripts/indexnow-backfill-apply.ts` | `63-124` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 manifest 读取+SHA-256 校验+commit 匹配+`--limit`/`--offset` 分页+双重写保护的主流程；候选核实与派发调用换成 `loadIndexNowCandidateArticle`/`isNovelIndexNowEligible`/`buildIndexNowCanonicalUrl`/`enqueueIndexNowFirstPublish` | Claude |
| `scripts/indexnow-backfill-manifest.ts` 输出结构与 CLI 骨架 | `scripts/indexnow-backfill-manifest.ts` | `1-236`（保留约 40%：输出 schema、`--article-ids` 校验、`fs.writeFile({flag:"wx"})` 防覆盖） | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 候选来源查询（约 55 行，`prisma.batchTaskItem.findMany`）整体不搬，改用 `findPublishedWithoutIndexNowDelivery` 差集查询（`P2-11.md` §5） | Claude |
| `src/app/indexnow-key.txt/route.ts` | `src/app/indexnow-key.txt/route.ts` | `1-24` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `text/plain`+`no-store`+缺 key 404 行为；`prisma.siteSetting.findFirst` 改走地基 `getIndexNowDeliveryConfig` accessor（`V020_FOUNDATION_INTERFACES.md` §6 强制约定） | Claude |
| `getStaticSitemapRoot`/`readStaticSitemapFile`/静态响应头 | `src/lib/static-sitemap-cache.ts` | `1-54` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 原样保留 current 目录读取、路径穿越防御、缓存头和缺失返回 null；仅移动到 `src/lib/seo/` | Codex |
| `generateStaticSitemaps`/release 校验与原子 symlink 切换 | `src/lib/static-sitemap-generator.ts` | `1-271` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 release 写入、自检、manifest 和 current.tmp→current 原子切换；类型缩为 mainpage/novelpage，locale 改读冻结白名单，PR1 要求显式注入 family builder | Codex |
| Sitemap 文件锁、状态机与错误脱敏 | `src/lib/sitemap-refresh-state.ts` | `1-333` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 wx 排他锁、running/success/failed 状态、失败保留旧版本与敏感值脱敏；移动到 `src/lib/seo/` 并显式透传 family builder | Codex |
| `renderUrlSetXml`/`renderSitemapIndexXml`/`parseSitemapFileName` | `src/lib/sitemap.ts` | `30-69,96-99,139-155,699-743` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 提取无 DB 纯核心；类型缩为 mainpage/novelpage，文件名解析只认 `listPublishableLocales()`，不提供 fixture HTTP 白名单 | Codex |
| `GET /sitemap.xml` 静态只读路由 | `src/app/sitemap.xml/route.ts` | `1-23` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 Node runtime、force-dynamic、静态命中 200 与缺失 503；仅调整 import 落点，禁止动态查库兜底 | Codex |
| `GET /sitemap/[fileName]` 静态只读路由 | `src/app/sitemap/[fileName]/route.ts` | `1-35` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留文件名先验校验、非法 404、静态缺失 503；仅调整 import 落点，fixture 验收不经过 HTTP | Codex |
| `robots` metadata 路由 | `src/app/robots.ts` | `1-17` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 allow 全站、私有前缀 disallow 与 sitemap 声明；后台路径换为小说仓路由，站点 origin 改为必填且严格校验的 SITE_URL | Codex |
| `normalizeRedirectUrl` | `src/app/go/[code]/route.ts` | `160-168` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制：`new URL()` 解析，仅放行 http/https，失败返回空串 | Codex |
| `hashSensitive` | `src/lib/cps-tracking.ts` | `282-285` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `sha256(salt:value)`；去掉 `"cps-tracking"` 默认盐与 `AUTH_SECRET` 回退，盐只读 `TRACKING_HASH_SALT` | Codex |
| `getRequestIp` | `src/lib/cps-tracking.ts` | `306-313` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制：x-forwarded-for 首段 / x-real-ip / cf-connecting-ip | Codex |
| `getSiteUrl`/`toAbsoluteUrl` | `src/lib/site-url.ts` | `1-26` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留单一绝对 URL 接缝与相对路径拼接；删除 CPS 硬编码域名和 NEXT_PUBLIC 回退，SITE_URL 缺失或非纯 origin 时 fail-closed | Codex |
| `buildDramaPageEntries`/`buildMainPageEntries`/`buildSitemapFamily` → `createSitemapFamilyBuilder` | `src/lib/sitemap.ts` | `157-205,260-310,420-444,476-484,640-696` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 仅保留首页与 Article 详情页集合、10,000 分片和 PG Date lastmod；DB 层 PromoLink 非空只做预过滤，每行仍调用冻结的 `isPromoReady`/发布状态谓词；URL 直接复用冻结 `buildArticlePath`，删除 blog/Category/Tag/北斗分支 | Codex |
| `enqueueSitemapRefresh` | `src/lib/sitemap-refresh-enqueue.ts` | `1-57` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 pending/processing coalesce 意图；CPS BatchTask 改接 GenericTask 单一 global scope，并用 PostgreSQL advisory transaction lock 消除并发重复；关闭 feature flag 时不建任务，不搬旧 stale-recovery | Codex |
| `handleSitemapRefresh` → `createSitemapRefreshHandler` | `worker/handlers/sitemap-refresh.ts` | `1-70` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留有效文件锁 coalesced success、35 分钟陈旧锁按 runId 释放后仅重试一次、失败保留旧版本；改为 GenericTask `TaskHandler` outcome 并复用 runtime lease/heartbeat/fencing/过期回收 | Codex |
| `emitWorkerTaskFailure` / `createWorkerFailureWebhookReporter` 旁路失败隔离模式 | `scripts/cps-daily-backup.sh` | `25-53,139-152` | `0ec20c4ee08b4b007e773feab811703a59ac3048` | `PATTERN_ONLY` | 只借“耐久事实先成立，可观测旁路失败不改写主流程结论”的事故验证模式，没有复制 shell 代码；小说仓改为 finalize/recovery commit 后的脱敏 JSON stderr + 可选 HTTP webhook。冻结 tag 中不存在 `cps-health-alert.sh`，故 30 分钟冷却、仅 2xx 推进和超时重试均依本次 Owner 合同原创实现，不虚假登记为该 tag 搬运；不搬标签多语、北斗或飞书逻辑 | Codex |
| `isLocalBaseUrl` / smoke 参数、报告与公开 URL 检查骨架 → `scripts/admin-e2e-smoke.ts` | `scripts/changdu-admin-e2e-smoke.ts` | `65-129,156-190,358-449` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 localhost 安全闸、独立 CLI、JSON 报告/失败证据与公开 URL HTTP 断言；删除 Changdu 登录/同步/批量生成语义，改为用户显式传入小说公开路径；为不破坏仓库既有“无浏览器截图依赖”契约，Puppeteer 驱动改为 Node 原生 `fetch`，证据路径收紧到 `/tmp` | Codex |
| `pollTask` → `scripts/admin-e2e-smoke.ts` | `scripts/changdu-admin-e2e-smoke.ts` | `275-294` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 3 秒轮询、有界超时与同源 credential fetch；端点改为仓库现有 `/api/admin/credential-tasks/status`，终态改为小说任务 `completed/completed_with_errors/failed/disabled`，驱动改为可注入的 Node `fetch`，不虚构尚不存在的通用 GenericTask 路由 | Codex |
| `assertNoForbiddenFlags` / `/tmp` 路径闸 / `DATABASE_URL` 交叉校验 / `scrub` → `scripts/lib/acceptance-safety.ts` | `scripts/changdu-preview-catalog-acceptance-cli.ts` | `77-179,204-232` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 allowlist 参数、凭证类 flag 拒绝、输出脱敏和 DB 目标交叉校验模式；SQLite 文件路径匹配改为 PostgreSQL `DATABASE_URL` SHA-256 指纹定时比较，原始 URL 不进 argv/报告；补 symlink escape 拒绝 | Codex |
| P2-12 只读验收 CLI 编排 → `scripts/acceptance/p2-12-acceptance-cli.ts` | `scripts/changdu-preview-catalog-acceptance-cli.ts` | `234-275` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留独立 CLI、先安全闸后执行、脱敏 JSON 结果的编排形状；删除 Changdu preview catalog 写入闭包，改为只读调用 Vitest 纵向验收用例 | Codex |
| `textToSlug`（设计思路） → `src/lib/slug/text-to-slug.ts` | `src/lib/slug-utils.ts` | `143-207` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只借「Latin 文字按词切分、符号统一视作分隔符、其余脚本原样保留为独立 Unicode 段而非丢弃」的设计思路，以及数字后缀感知的最短长度健康度判定（`isUnhealthyArticleSlug` → `isHealthySlug`）；**不搬** `pinyin-pro` 中文转拼音分支（`shouldTransliterateChinese`/`pushChineseTokens`）——`SiteLocale` 今天只登记 `"en"` 一个成员且上游语种登记表为空，本轮没有会把 CJK 文本经由中文族 `SiteLocale` 传入的调用点，零新依赖；若日后登记中文族 `SiteLocale`，那才是评估转写库的时点 | Claude |
| `PUBLIC_PAGE_SHORT_ID_ALPHABET`/`createArticlePublicPageShortId`/`isArticlePublicPageShortIdUniqueConflict`/`createWithArticlePublicPageShortIdRetry` → `src/lib/slug/short-id.ts` | `src/lib/article-public-page-id.ts` | `8-16,33-79` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留字母表（小写字母+数字）、固定长度、强制含至少一位数字、P2002 冲突有界重试（默认 5 次）的算法形状；改名去掉 CPS 的 Article/Drama 专属命名，泛化为本项目的 `publicPageShortId` 字段；`isPublicPageShortIdConflict` 改为叠加在 `src/lib/db/db-retry.ts` 的 `isUniqueConstraintViolation` 之上而非另起一份 `P2002` 判定 | Claude |
| `createArticlePublicPageShortId`/`createWithArticlePublicPageShortIdRetry`/`isArticlePublicPageShortIdUniqueConflict` → `createPublicRedirectCode`/`createWithPublicRedirectCodeRetry`/`isPublicRedirectCodeUniqueConflict` | `src/lib/article-public-page-id.ts` | `7-16,36-85` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留字母表+强制含数字生成、P2002 有界重试（默认 5 次）与冲突目标名判定的整体形状；改：目标列/约束名换成 `promo_link.public_redirect_code`/`promo_link_public_redirect_code_key`；长度从 CPS 的 8 位加到 10 位（本字段永久不回收、生命周期比 CPS 的单 Article 短码更长，需要更大的冲突余量）；**不搬** CPS 该文件里 `createArticlePublicPageId`（前缀+随机字节的另一种独立标识符，本项目无对应用途） | Codex |
| CPS nginx 安全头、gzip、静态缓存、API no-store 与反代头模式 → X8 production-like nginx | `nginx/cps-admin.conf` | `17-48,126-164` | `0ec20c4ee08b4b007e773feab811703a59ac3048` | `ADAPT` | 保留安全头、gzip、hash 静态资源长缓存、API/后台 no-store 和反代头的生产形状；改为 `novel.test` 本地 TLS、Docker upstream `web:3000`、stdout JSON 日志、2 MiB 请求体，并将 `X-Forwarded-For` 强制覆盖为直连 `$remote_addr`。冻结 tag 的 Cloudflare real-IP snippet 不搬：本地无可信 CDN 边界，信任客户端 CF/XFF 反而会伪造来源。未搬短剧主页面 proxy cache，也未使用 `proxy_ignore_headers` | Codex |

P2-02 是首批 `owner = Claude` 的搬运条目。全部落在 `src/lib/seo/template/`，逐符号登记如下。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `WILDCARD_FIELDS` → `REGISTERED_TEMPLATE_FIELDS` | `src/lib/template-engine.ts` | `13-35` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「同一份 `as const` 数组既做渲染期判定又驱动后台变量面板」的形态；18 个短剧键整表重写为 6 个小说键，增列 `kind`（url 类做 scheme 校验）与 `required`（可空列裸引用告警）；`author`/`country`/`completion_status` 等禁止字段不登记 | Claude |
| `WildcardField` → `TemplateFieldKey` | `src/lib/template-engine.ts` | `35` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `(typeof ARRAY)[number]["key"]` 的键联合类型推导写法，数组换成小说登记表 | Claude |
| `ERR_TEMPLATE_VAR_EMPTY` | `src/lib/template-engine.ts` | `37` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `COPY` | 原样复制码值与命名 | Claude |
| `TemplateVarEmptyError` → `TemplateRenderError` | `src/lib/template-engine.ts` | `39-62` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「Error 子类 + 只读 `code` + 结构化 `k=v` 消息、不回带取值」的形态；由单一码扩为五码，定位字段换成 `slot`/`field`/`constraint`/`templateKey`/`novelId` | Claude |
| `isTemplateVarEmptyError` → `isTemplateRenderError` | `src/lib/template-engine.ts` | `64-74` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 `instanceof` + `code` 属性双判定的跨 realm 写法（Worker 与 Web 不同模块 realm）；判定集合换成五码注册表 | Claude |
| `renderTemplateInternal` → `renderTemplateSlot` | `src/lib/template-engine.ts` | `166-221` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 模板语言逐字保留：两条正则 `\{if\s+(\w+)\}` 与 `\{(\w+)\}`、先条件后变量的两步顺序、替换不二次扫描、`"0"` 为假。三处改造：① 严格模式由 slug 专用扩为全槽位唯一模式，未登记字段由 `return match` 改为抛错；② `{if}` 判真前 trim（消除 CPS `:189` 与 `:201` 的口径不一致）；③ **正则不动点重扫改为 token 深度配对扫描**——CPS 实现在外层条件为假时会把字面 `{endif}` 泄漏进产物，可复现证据见 `docs/p2/P2_02_TEMPLATE_ENGINE.md` §2.1 | Claude |
| `buildWildcardMap` → `buildNovelTemplateValues` | `src/lib/template-engine.ts` | `85-137` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「扁平、预字符串化、恒含全部登记键、`null` 折成空串」的取值表形态；字段整表换成小说字段；容器由普通对象改 `Map`（模板变量名匹配 `\w+`，普通对象上 `constructor`/`__proto__` 会取到原型链） | Claude |
| `buildArticleSnapshot` → `renderArticleDraft` | `src/lib/article-generation.ts` | `204-272` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「一次调用产出多个槽位」的装配形态；六槽位降为四槽位（slug 归 P2-03/P2-06，metaKeywords 无对应列）；**去掉全部 fallback 链**——CPS 把同一装配逻辑复制成四份且 fallback 各不相同，fallback 属发布链路策略，归调用方 / P2-07 | Claude |
| `findUnsupportedVariables` → `analyzeTemplate` | `src/components/templates/template-form.tsx` | `99-115` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「保存期扫描模板文本、报出未登记变量、`endif` 不算字段」的思路；由 React 组件内的告警函数改为零依赖纯函数（可硬拦截，CPS 侧仅弹黄条仍允许保存）；扫描器与渲染器共用同一套 token 正则，并附带 `{if}`/`{endif}` 配对校验与可空字段裸引用告警 | Claude |

CPS 侧的 `renderContentBlocks`（`src/lib/template-engine.ts:223-261`）、`previewTemplate`（`:263-294`）、`resolveTemplateEpisodeCount`（`:76-83`）、`renderAltTemplate`（`src/lib/article-v2-service.ts:121-128`）、`truncateDescription`（`src/lib/seo-templates/_shared.ts:7-15`）判为 `DROP`，未搬入任何字节，理由逐条见 `docs/p2/P2_02_TEMPLATE_ENGINE.md` §2。

`src/lib/seo/template/html.ts`（正文插值的窄上下文扫描器 `analyzeHtmlInterpolation`）与
`escapeHtmlText`、`ABSOLUTE_HTTP_URL` / `PUBLIC_REDIRECT_PATH` 两条取值形态校验**无 CPS 来源**：
CPS 对变量落在什么 HTML 位置完全不判定，也不对 `<img src>` 做任何 scheme 校验，判为
`ORIGINAL_REQUIRED`，故不在本表登记（本表只登记有 CPS 来源的符号）。

RC-1 是首批 `owner = Claude` 引用 v8.3.6 基线的搬运条目（见上方"RC-1 v8.3.6 生产 tag 参考基线"）。
逐符号登记如下。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `submitChangduPromoClaim` → `enqueuePromoLinkClaimAction` | `src/app/(admin)/sync/actions.ts` | `724-766` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 保留"只接受调用方显式枚举的 `sourceItemIds`，硬拒绝任何筛选描述符"这条纪律（CPS 端靠运行时判 `data.selection` 真值即拒绝；本仓在类型层面就不给这个字段留位置——`PromoLinkClaimTriggerInput` 只有 `novelSourceItemIds: string[]`，没有筛选形状可传）；CPS 单函数内联 `requireAdminSession()` + 直接落 `BatchTask`，本仓拆成 `requireAdminActionAccess` → `requireFreshAdminServiceMutation` 两段式新鲜校验（`promo:claim`，dry_run/apply 同一能力位，见 `_actions.ts` 内文档），且把返回值从 `{success,taskId,...}` 改造成与既有 `CatalogScanActionResult` 同形的 `{ok,data:{outcome,...}}` 判别式联合；`channelAppKey`（字符串业务键）换成本仓的 `channelAppId`（UUID FK）；新增本仓特有的 `ChannelCapability`（按渠道应用维度的 `claimPromo` 能力位）前置检查与 `capability_disabled` 结果分支——CPS 没有这一层，是本仓 P0-S6 引入的能力位模型的必然要求，不是从 CPS 搬来的 | Claude |
| dry_run/apply 双模式表单交互（复选 + 账户/模式选择 + 提交前不可逆警示） | `src/app/(admin)/sync/_components/changdu-sync-panel.tsx` | `598-966`（`submitPromoClaim`/`canSubmitClaim`/勾选与提交区块） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 只借鉴"显式勾选 + dry_run 优先 + apply 前置不可逆警示"的交互形态，不搬代码：CPS 面板把领取塞进一个已有 2000+ 行的畅读综合面板（同页还有来源同步、链接同步等其它职责）；本仓新建独立的 `PromoLinkClaimDialog`，触发入口挂在 `/catalog-sync` 的来源条目表格上，不复用/不魔改任何既有畅读面板结构 | Claude |

RC-3（MoboReader 上游请求节流与 429/503 退避）同样 `owner = Claude`，与 RC-1 共用上方 v8.3.6 基线，来源集中在 CPS 的
`src/lib/adapters/changdu-rate-limit.ts`、`src/lib/adapters/changdu.ts` 与 `worker/handlers/changdu-source-sync.ts`。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `CHANGDU_MIN_REQUEST_INTERVAL_MS` → `MOBOREADER_MIN_REQUEST_INTERVAL_MS` | `src/lib/adapters/changdu-rate-limit.ts` | `27` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 1100ms 原样保留（上游按请求数限流约 60 次/窗口，1100ms ≈ 55 次/分钟留 8% 余量）；仅前缀改名。该常量在本仓的消费方式与 CPS 不同，见下方节流门条目 | Claude |
| `CHANGDU_MAX_RATE_LIMIT_RETRIES` → `MOBOREADER_MAX_RATE_LIMIT_RETRIES` | `src/lib/adapters/changdu-rate-limit.ts` | `30` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 4 原样保留；仅前缀改名 | Claude |
| `CHANGDU_BACKOFF_BASE_MS` → `MOBOREADER_BACKOFF_BASE_MS` | `src/lib/adapters/changdu-rate-limit.ts` | `33` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 2000ms 原样保留；仅前缀改名 | Claude |
| `CHANGDU_BACKOFF_CAP_MS` → `MOBOREADER_BACKOFF_CAP_MS` | `src/lib/adapters/changdu-rate-limit.ts` | `36` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 60000ms 原样保留；仅前缀改名 | Claude |
| `CHANGDU_RETRY_AFTER_CAP_MS` → `MOBOREADER_RETRY_AFTER_CAP_MS` | `src/lib/adapters/changdu-rate-limit.ts` | `39` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 120000ms 原样保留；仅前缀改名。注意本仓 `moboreader.ts` 原有的 `MAX_RETRY_AFTER_MS = 30_000` 只作用于未启用本策略的 legacy 路径，两者并存不冲突 | Claude |
| `CHANGDU_RATE_LIMIT_TOTAL_BUDGET_MS` → `MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS` | `src/lib/adapters/changdu-rate-limit.ts` | `59` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 数值 90000ms 原样保留；仅前缀改名。CPS 的 90 秒是按其 30 分钟任务看门狗与约 585 页节流算出的余量，本仓任务租约模型不同（一页一 item、30 秒租约 + 心跳续租），沿用同值属保守取值而非同口径推导 | Claude |
| `CHANGDU_RETRYABLE_STATUSES` → `MOBOREADER_RATE_LIMITED_STATUSES` | `src/lib/adapters/changdu-rate-limit.ts` | `62` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 集合 `{429, 503}` 原样保留；改名以区分「触发限流退避的状态码」与本仓 `moboreader.ts` 既有的 `shouldRetryStatus`（408/429/≥500）——后者范围更宽且不属本次搬运 | Claude |
| `ChangduRateLimitGiveUpReason` → `MoboreaderRateLimitGiveUpReason` | `src/lib/adapters/changdu-rate-limit.ts` | `65-69` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY` | `"max_attempts"` \| `"budget_exhausted"` 两态原样复制，仅改类型名 | Claude |
| `ChangduRateLimitedError` → `MoboreaderRateLimitedError` | `src/lib/adapters/changdu-rate-limit.ts` | `71-99` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 保留「重试耗尽后抛出带续跑坐标的专用错误类」形态与 `status`/`retryAfterMs`/`attempts`/`reason` 字段；`lastPage`（CPS 的页号）改为 `pageIndex`（非分页端点为 `null`），并新增 `endpoint` 与 `elapsedMs`——本仓一个适配器服务三类端点（getlistpc/getbydataid/getchapterinfo），只有页号不足以定位。消息文案由中文改英文以与本仓其余适配器一致 | Claude |
| `parseRetryAfter` | `src/lib/adapters/changdu-rate-limit.ts` | `111-138` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | RFC 9110 双格式解析逻辑逐字保留，含「先 `/[A-Za-z]/` 卡形状再 `Date.parse`」这一承重护栏（否则 `Retry-After: -5` 被当年份解析成负 delta、clamp 成 0，等于限流时立刻重试）；唯一改造是把上限由闭包常量改为第三个可选参数 `capMs`，默认仍是 120000ms。已独立验证：`"-5"`→null、`"abcxyz"`→null、`"0"`→0、`"9999"`→120000、HTTP-date +30s→30000、过期 HTTP-date→0 | Claude |
| `computeRetryDelayMs` | `src/lib/adapters/changdu-rate-limit.ts` | `149-163` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 「Retry-After 权威值 +10% 抖动，否则指数退避 + full jitter `[cap/2, cap]`」公式逐字保留；改造为把 base/cap 由闭包常量改成可选入参（默认等于上面两个常量）。已独立验证 attempt 1..6 在 random=0/0.5/1 下分别落在 [1000,2000)/[2000,4000)/…/[30000,60000) | Claude |
| `canAffordRetry` | `src/lib/adapters/changdu-rate-limit.ts` | `171-178` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 「睡下去之前先判预算，不够就立刻带坐标停下」的语义与 `elapsedMs + delayMs <= budget` 边界逐字保留；仅改默认预算常量名 | Claude |
| CPS 分页循环页间节流 `await sleep(CHANGDU_MIN_REQUEST_INTERVAL_MS)` → `createMoboreaderRateGate` / `moboreaderUpstreamRateGate` | `worker/handlers/changdu-source-sync.ts` | `686-691` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 🔴 形态改变最大的一条。CPS 靠「串行分页循环里的一句 sleep」实现页间间隔，成立前提是那个循环是该主机的唯一调用方。本仓上游被三条互不相干的 worker 路径调用（catalog scan / Preview 物化 / 推广链接 claim 与回读），无法靠任一循环自己 sleep 保证全局间隔，故改写为进程级 FIFO 互斥节流门：每次 dispatch 前 `await gate.wait()`，队列串行化并发调用者，避免两个调用者读到同一个 `lastDispatchAt` 后同时发车。已独立验证 5 个并发 `wait()` 依次落在 0/1100/2200/3300/4400ms。承重限制：单例仅在进程内有效，多副本 worker 不共享（见本条 `changed_what` 末与运维说明） | Claude |
| `createChangduListAdapter` 的两层超时重试循环 → `createMoboreaderReadAdapter` 内的 `rateLimitAwarePost` | `src/lib/adapters/changdu.ts` | `244-321` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 保留 v8.3.1 事故修复的承重结构：每次 HTTP 尝试各自新建超时、重试等待另受总预算约束、两者绝不共用时钟；以及「预算不足提前停」「耗尽后抛带坐标的限流错误」。三处改造：① 改为 **opt-in**——省略 `upstreamRateLimitPolicy` 时走原有 `legacyPost`，本仓既有测试与 scripts 的默认构造行为不变；② CPS 对非 `{429,503}` 状态一律立即失败，本仓保留既有的 408/5xx 可重试语义并纳入同一预算与退避表（是行为变更，已在函数 docstring 写明）；③ 抛出坐标由 `lastPage` 改 `pageIndex` + `endpoint` | Claude |
| catalog `pageSize` 硬上限 20 → `MOBOREADER_CATALOG_LIMITS.maxPageSize` | `worker/handlers/changdu-source-sync.ts` | `814` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | CPS 为 `Math.min(positiveInteger(params.pageSize, 20), 20)`，即默认 20、硬顶 20。本仓原为 100（从未对该主机探测过的值）。RC-3 fixup 将硬顶落到 20，并把 `tests/backend/tasks/moboreader.test.ts` 的 happy-path fixture 由 100 改 20、边界用例由 101 改 21。一处刻意分歧：CPS 静默 clamp，本仓 `validateMoboreaderCatalogScanInput` 抛 `page_size_exceeded` 拒绝——更严格，且与本仓 fail-fast 校验风格一致 | Claude |
| catalog `pageSize` 默认 20 → `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE` | `worker/handlers/changdu-source-sync.ts` | `814` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 同一行的 `positiveInteger(params.pageSize, 20)` 默认值。拆成独立常量（可 env 覆盖）以便调小单次扫描而不动硬顶；与上一条同为 20 | Claude |

RC-3 中**无 CPS 来源、判为 `ORIGINAL_REQUIRED` 故不登记**的部分：

- `MOBOREADER_UPSTREAM_RATE_LIMIT_ENV` / `resolveMoboreaderUpstreamRateLimitConfig` / `MoboreaderRateLimitConfigError`
  这一整层 env 覆盖——CPS 的 `changdu-rate-limit.ts` 把六个值全部硬编码，没有 env 层。本仓沿用自己既有的
  `resolveMoboreaderPreviewRuntimeConfig` 形态新写，默认值等于上表 CPS 值，非法覆盖 fail fast。
- `NOOP_MOBOREADER_RATE_GATE` 与 `upstreamRateLimitPolicy` 的 opt-in 开关：CPS 无对应概念（其修复是无条件生效的），
  本仓为保持既有测试与 scripts 默认构造的字节级行为不变而新增。
- `worker/handlers/moboreader.ts` 中 `upstream_rate_limited` 这一任务错误码与其运维文案：CPS 的失败落点是
  `batchTask.errorLog`，与本仓 `GenericTaskItem` 的 `{code, message}` 结构不同，无可搬字节。

RC-6（`/go` 公开跳转追踪写闸与爬虫过滤）同样引用 v8.3.6 基线。逐符号登记如下。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `getTrackingWriteStatus`/`isPublicTrackingWriteDisabled`（写闸判定） → `isPublicTrackingWriteDisabled` | `src/lib/cps-tracking.ts` | `42-56` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 保留"一个显式 env 开关即可整体关闭公开追踪写入"的语义；CPS 用 `isTruthyEnv`（`trim()` + 正则 `/^(1\|true\|yes\|on)$/i`，`src/lib/cps-tracking.ts:585-587`）对两个 env（`CPS_PUBLIC_TRACKING_WRITE_DISABLED` 或 `CPS_TRACKING_DISABLED`）取 OR，本仓合并为单一 flag `PUBLIC_TRACKING_WRITE_DISABLED`（`/go` 只有一种事件类型，一把开关足够），但**取值解析逐字照搬 `isTruthyEnv`**（同 `trim()`、同正则、同大小写不敏感），刻意不套用本文件其它 flag 的 `=== "true"` 精确匹配——那些都是"能力开关"，认不出的值→能力保持关闭=安全；本 flag 是"停写安全阀"，认不出的值→写入保持开启，即阀门在最需要时静默失灵，运维按 CPS 习惯写 `on`/`yes` 或在 Compose `environment:` 留尾空格都会踩中；**默认值反转**——CPS 生产默认关闭写入（`.env.example:160`/`docker-compose.yml:92` 均默认 `1`），本仓默认开启（未设置=写），因为 `/go` 是本项目唯一归因信号而 CPS 有其它信号来源，此差异属故意改造非疏漏 | Claude |
| `isObviousBotUserAgent` | `src/lib/cps-tracking.ts` | `287-291` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY` | 原样复制正则 `/bot\|crawler\|spider\|slurp\|bingpreview\|facebookexternalhit\|whatsapp\|telegrambot\|curl\|wget/i` 与判定函数，仅改函数落点（`src/app/go/_lib/tracking-guard.ts`） | Claude |
| `safeRecordTrackingEvent` 写闸检查顺序（写闸 → bot UA → 写入） → `shouldRecordGoRedirect` | `src/lib/cps-tracking.ts` | `108-127` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 保留"先判写闸、再判 bot UA、通过才写"的判定顺序与"写失败不阻塞主流程"的纪律；**不搬**该函数里 accepted event types 白名单、限流（`isRateLimited`）与 `visitorId`/`sessionId`/cookie 身份模型——本仓 `/go` 只有一种事件类型（`go_redirect`）、无限流、无访客身份，这些是 R+1 Tracking 全链范围，本轮显式排除；`route.ts` 里原有的 `try { await prisma.trackingEvent.create(...) } catch {}` 同步 await + 吞错模式保持不变，未改为 CPS 的 `void ...catch()` fire-and-forget 形态 | Claude |

### 无搬运的任务（显式登记，避免被当成漏登）

| 任务 | CPS 复刻分类 | 原因 |
| --- | --- | --- |
| P1-11 阅读器功能 | `ORIGINAL_REQUIRED` | CPS 零可复用的正文托管、分章渲染、阅读版式资产——CPS 的试看是视频跳转，语义不可平移。**本轮无任何从 CPS 搬入的符号。** |
| P2-08 PR2 公开接库 | `ORIGINAL_REQUIRED` | 公开路由、`src/lib/site` mapper、轮播空桩均为小说仓地基上的新接线。takedown/withdrawn V1 走页面层 `notFound()`（404），不搬 CPS proxy 410。明确不搬 `home-carousel-queries.ts`（Owner 裁决空数组）、`drama-hreflang.ts`、`site-queries.ts`、跨 Novel hreflang、`/go` handler。 |
| `PUBLIC_LIST_CAP=240` 内存分页硬顶 | `ORIGINAL_REQUIRED` | 公开列表 `findMany({ take: 240 })` 后再 `isPromoReady` 过滤、内存分页。超限后 browse 的 `totalCount`/`totalPages` 失真，且 sitemap 可能收录 cap 之外的 URL 而 `/browse` 列不出（内链缺口）。V1 接受该限制，本轮不改实现。 |
| P2-11 `src/lib/indexnow/sweep.ts`（`sweepDueIndexNowDeliveries`/`createIndexNowDeliveryTaskItem`） | `ORIGINAL_REQUIRED` | CPS 的 `deliverDueIndexNow` 是单一长函数（查due→CAS 认领→HTTP 投递一体化），没有"把到期行拆成独立可租用工作单元"这一步——小说仓因为改用 `GenericTaskItem` 租约模型（见上方 PATTERN_ONLY 条目），必须新写一层"扫描到期行 + 为每行创建任务项"的调度逻辑，CPS 无对应函数可搬。 |
| P0-S4 `src/server/content-creation/service.ts`（`createContentFromSourceItem` 编排本体：guard 状态机、dry-run、并发冲突关闭、审计写入）与 `src/server/content-creation/business-id.ts`（`Novel.businessId` 生成器） | `ORIGINAL_REQUIRED` | CPS 的 `Drama` 行只靠上游同步任务写入，没有一个独立的"从 SourceItem 创建 canonical 内容"服务可搬；`business_id` 概念在 CPS 里对应上游直传的 `dramaId`，不是自生成短码，无算法可搬。整条创建编排（guard 读+条件 `updateMany` 关闭并发竞态+同事务审计）是本仓自建，只在两处局部借用了本表已登记的既有基建（`src/lib/db/db-retry.ts` 的 `isUniqueConstraintViolation`/`withDbRetry`，以及本表另两条 `slug/short-id` 条目登记的 shortId 算法）。 |
| X8 `bootstrap.conf.template`、AI crawler `limit_req`、`/novel`/`/go`/`/browse` `limit_conn` 与本地 mkcert 三步法 | `ORIGINAL_REQUIRED` | 冻结的 CPS `v8.2.18` tag 中不存在 bootstrap 与 AI snippet，也不含 2026-08-13/14 两份生产止血补丁，不能从短剧当前工作树越界补读。X8 依据 Owner 验收合同与两份止血文档重写小说路径、阈值和本地 TLS 编排；只登记上方 tag 内真实存在的 nginx 基线，不虚构 tag 来源。 |

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
