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
上方 X 系列条目仍固定在 v8.2.18。RC-4（`/catalog-sync` 显式多选批量创建内容）沿用同一 v8.3.6 基线
与同一 peeled commit，见下方 RC-4 登记段落，不重复取证。

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
| `isIndexNowPageEligible`/`loadEligibleIndexNowPages` → `isNovelIndexNowEligible`/`loadIndexNowCandidateArticle` | `src/lib/indexnow-outbox.ts` | `47-87` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留「locale 白名单 + 谓词族 + 路径可解析」三条件结构；drama 四表联查/`rightsStatus`/`articleType` 分支全删（小说仓无对应多态），改为组合 `visibility.ts` 的 `isIndexNowEligible` + 静态层 `SITE_LOCALES` 成员判定（`isRegisteredSiteLocale`；P4 删除发布白名单层后，IndexNow 资格读的是两层口径中的静态层，见 `locale-canonical.ts` 模块头） | Claude |
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
| `renderUrlSetXml`/`renderSitemapIndexXml`/`parseSitemapFileName` | `src/lib/sitemap.ts` | `30-69,96-99,139-155,699-743` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 提取无 DB 纯核心；类型缩为 mainpage/novelpage，文件名解析只认静态层 `SITE_LOCALES` 成员（`listPublishableLocales()` 已随 P4 删除发布白名单层一并撤销），不提供 fixture HTTP 白名单 | Codex |
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

### RC-7b 备份/Worker 关键词健康端点（v8.3.6 基线，`ADAPT`）

RC-7b 补上 RC-7 runbook §1.1 点名缺失的两个端点。`/api/health/backup` 是对 CPS 同名端点的
逐项搬运（四态、状态文件优先、`exitCode !== 0` 不看 age、ENOENT 退回产物目录、
`ageMs >= thresholdMs` 判 stale、26h 阈值、2000ms 读超时、5000/500 双重扫描界限、
200/503 映射、`no-store`）。`/api/health/worker` **不在本表登记为搬运**：v8.3.6 树内
`src/app/api/health` 只有 `backup/ live/ ready/ route.ts` 四项（已 `ls-tree -r` 核实），
CPS 无等价端点；它只复用同一套 Keyword 载体形态，判据 SQL 逐字取自本仓
`docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2，属 `ORIGINAL_REQUIRED`。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `evaluateBackupStatus` / `evaluateFromArtifactDirectory` / `DEFAULT_STALE_THRESHOLD_HOURS` / `BACKUP_STATUS_READ_TIMEOUT_MS` / `MAX_ARTIFACT_DIR_ENTRIES` / `MAX_ARTIFACT_STAT_CANDIDATES` → `src/server/health/backup-status.ts` 同名符号 | `src/lib/health-backup-status.ts` | `58`、`63`、`72-73`、`263-331`（产物退路）、`333-420`（主判定） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 判定表与四个常量逐项照搬（含"`exitCode !== 0` 立即 failed、不看 age"与"年龄必须请求时现算"两条核心护栏）。改：①覆盖点由 CPS 的模块级可变量 + `setBackupStatusOverridesForTests` 改为显式 `BackupStatusOptions` 参数注入（本仓路由处理函数可传参，无需模块级污染）；②产物命名白名单由 CPS 的 `^cps-\d{8}\.db$` / `^cps-\d{14}-[0-9A-Za-z]+\.db$` 换成 `/\.(?:dump\|sql(?:\.[A-Za-z0-9]+)?)$/i`——本仓 `backup-timer.sh` 产出的是 `pg_dump -Fc` 的 `cps-novel-x8-<UTC 戳>.dump`，不是 SQLite `.db`；③**不搬** `reasonCode`、`artifactName`、`artifactBytes`、`lastRunExitCode` 四个响应字段（CPS 在响应体里回显备份文件名，本仓收敛为只输出 `{ backupStatus, checkedAt, ageHours, source }`，不泄漏任何路径/文件名）；④env 名由 `BACKUP_STATUS_PATH`/`BACKUP_ARTIFACT_DIR` 改为 `BACKUP_STATUS_FILE`/`BACKUP_OUTPUT_DIR`，且无编译期默认路径（CPS 硬编码 `/app/data/...`、`/app/backups`） | Claude |
| `HTTP_STATUS_BY_BACKUP_STATUS`（`ok`/`unconfigured`→200，`failed`/`stale`→503）+ `no-store` + "必须配 Keyword 类型监控"头注释论证 → `src/app/api/health/backup/route.ts` | `src/app/api/health/backup/route.ts` | `31-36`（映射表）、`1-30`（unconfigured 为何是 200 + Keyword 硬性要求）、`38-43`（`noStore`） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 映射表四态取值原样，`Cache-Control: no-store` 原样，头注释两段论证（unconfigured 返回 200 的理由；改成纯状态码监控会退化成"会骗人的监控点"）改写后保留。改：`NextResponse.json` → `Response.json`（与本仓 `/api/health` 一致），并显式声明 `runtime = "nodejs"`（CPS 只声明 `dynamic`）；响应体不再包 `ok`/`reasonCode`/`artifactName` 等字段，直接透传评估结果 | Claude |
| Keyword-monitor 原始字节断言 `assert.match(rawText, /"backupStatus":"ok"/)` → `tests/ui/health-backup-route-contract.test.ts` 与 `tests/ui/health-worker-route-contract.test.ts` 的同名用例 | `tests/health-backup-route.test.ts` | `53`、`65`、`78-86`、`103-111`、`124-130`、`146-153`、`183-188`（共 6 处 `rawText` 断言） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 搬的是 CPS 那条注释写明的合同：UptimeRobot Keyword 监控对**响应体原始字节**做子串匹配，所以紧凑 JSON 的确切渲染方式本身就是合同，必须用 `.text()` 而非 `.json()` 断言。**首轮交付漏搬此项**（全部断言走 `response.json()`，复核用"把 `Response.json` 换成 `JSON.stringify(result, null, 2)`"的变异验证：42 个用例全绿而线上关键词已失配），复核轮补齐。改：正反双向断言（ok 时逐字出现、任一非 ok 态一定不出现），并同形扩到 `/api/health/worker` 的 `"workerStatus":"ok"` | Claude |

### RC-7 最小告警链（v8.3.6 基线，`COPY_SEMANTICS_ONLY`）

RC-7 把短剧的"关键词告警"**判据**搬进 `infra/production-like/alerts/*`。这里新增一个
`port_kind = COPY_SEMANTICS_ONLY`：**判据逐条照搬、载体整体更换**——CPS 的载体是
「HTTP 端点吐带关键词的紧凑 JSON + 外部 UptimeRobot 免费版 Keyword 类型监控做判定与
推送」，而 X8 本地栈只监听 `127.0.0.1`，外部 SaaS 够不到，故改为「本地 shell 脚本按同一
判据自查 + 通用出站 webhook 占位推送」。**CPS 仓内不存在任何 curl-webhook 推送脚本**
（已在 v8.3.6 树内 `ls-tree -r` + 多轮关键词 grep 核实），故 `alert-lib.sh` 的推送/去抖/
计数器实现全部为本仓原创，不登记为搬运；本表只登记真正有 CPS 出处的判据。生产上复用
同一条通道的落法见 `docs/operations/ALERTS_RUNBOOK_2026-09-03.md` §1.1。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| Keyword-监控判据（关键词优先于 HTTP 状态码）→ `is_health_body_ok` / `check_health` | `src/app/api/health/backup/route.ts` | `25-30`（头注释"必须用 Keyword 类型"段）、`31-36`（`HTTP_STATUS_BY_BACKUP_STATUS`） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY_SEMANTICS_ONLY` | 保留"200 也可能是骗人的、必须在响应体里找成功关键词"这条判据（CPS 的 `unconfigured` 就是 200 却不健康的活证据，源自 `/api/health` 在 8-19 全站死透 103 分钟里一路返回 200）。改：判定方从 UptimeRobot 改为本地 `curl` + `grep`；关键词从 CPS 的 `"backupStatus":"ok"` 换成海阅 `/api/health` 自己的 `"ok":true`（本仓 `src/app/api/health/route.ts` 已 `report.ok ? 200 : 503`，`ok` 为响应体首字段）；**不搬**四态 `ok/failed/stale/unconfigured` 与状态码映射表本身——海阅 `/api/health` 是二态，没有 `unconfigured` 对应物 | Claude |
| `DEFAULT_STALE_THRESHOLD_HOURS = 26` → `ALERT_BACKUP_MAX_AGE_SECONDS` | `src/lib/health-backup-status.ts` | `55-58` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY_SEMANTICS_ONLY` | 阈值数值与理由逐字沿用（24h 周期 + 2h 余量，漏跑一整天之内必报），单位由小时改为秒（`93600`）以适配 shell。改：比较式为 `age > 阈值`，CPS 是 `ageMs >= thresholdMs`——边界上差 1 秒，量级无关，登记以免被当成漏抄 | Claude |
| 新鲜度必须请求时现算 + "状态文件优先／退回观察产物 mtime"双信息源 → `resolve_marker_mtime_epoch` / `check_backup_freshness` | `src/lib/health-backup-status.ts` | `9-30`（头注释判定优先级）、`263-331`（`evaluateFromArtifactDirectory`） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY_SEMANTICS_ONLY` | 保留核心护栏"年龄用当前时钟现算、绝不回显预算好的布尔值"，以及"死掉的 cron 伪造不了 mtime，产物比自我报告可信"这条来源选择理由。改：海阅 X8 侧**只有产物退路这一路**——`backup-timer.sh` 只 `touch /tmp/x8-backup-last-success`（且脚本 `set -e`，故仅成功时刷新），本仓没有 CPS 那样带 `exitCode` 的 `backup-status.json`，因此**不搬**状态文件分支，也就拿不到 CPS 的 `failed`（"上次跑失败了"）语义：一次失败的备份要等 26h 阈值才报，而不是像 CPS 那样立刻报。此限制已写进 runbook §7 | Claude |
| "看不懂／看不到 = 不可信"fail-closed 判定表 → `fail_closed_run` 及各 check 的探测失败分支 | `src/lib/health-backup-status.ts` | `32-36`（A 表第 1 条）、`344-359`（`read_timeout`/`read_error` → `failed`） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY_SEMANTICS_ONLY` | 保留"探测本身失败要当不健康报，绝不当静默健康"。改：CPS 的不可信来源是文件读不出／超时／JSON 坏；本仓扩到 `curl` 连不上、`psql` 不存在或连不上、`docker inspect` 失败、标记文件不可读四类，均走同一条 fail-closed 分支 | Claude |
| Keyword-翻转演练法（翻转监控期望看到的东西、确认告警触发，不碰生产）→ `drill.sh` | `DEVLOG.md` | `60-78`（2026-08-22 v8.2.16 备份状态端点条目） | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `COPY_SEMANTICS_ONLY` | 保留"没有信号到人才是根因"与 Keyword 监控法的结论；`tests/health-backup-route.test.ts:63-65` 的 `assert.match(rawText, /"backupStatus":"ok"/)` 是同一判据的测试侧表达。改：演练做成完全本地自包含形式（未监听端口 `127.0.0.1:1`、不存在的容器名、自建自删临时文件），断言本仓自建的文件计数器 `alert_fire_total()`；强制 `DRY_RUN=1` 且用独立 `mktemp -d` 状态目录，不碰真实去抖状态 | Claude |

### RC-4 显式多选批量创建内容（v8.3.6 基线，`PATTERN_ONLY`）

RC-4（`/catalog-sync` 显式多选批量创建内容）沿用 RC-1 已冻结的同一 v8.3.6 基线与同一只读工作区，
执行方式相同（`git show v8.3.6:<path>` / `git grep <pat> v8.3.6 -- <path>`，工作树不可读、不
checkout/stash）。**只搬运批量编排的语义（显式 id 集合、单次上限、逐条串行、结果台账），不搬运
CPS 的 BatchTask/SQLite 机制**——本仓 `applyContentCreationBatch`/`dryRunContentCreationBatch`
（`src/server/content-creation/batch.ts`）没有对应的批量任务行落库，是一次同步的 in-process 循环，
调用方（Server Action）原地等待其返回，不经由 `GenericTask`/worker 异步消费，这一点与 CPS 该函数
本身相同（CPS 的批量入口同样是同步 CLI 主流程内的循环，不是任务队列）。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `assertBatchApplyLimit` → `requireNonEmptyDedupedIds` / `ContentCreationBatchInputError` | `src/lib/changdu-promote-drama-batch.ts` | `174-199` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 只借"显式 id 列表 + 单次上限硬拒绝，且校验先于任何数据库读写"的思路；**不搬** CPS 的 `--max-apply`/`--expected-count` 双 CLI 输入及二者互相印证（`expectedCount !== sourceItemIds.length` 一类校验）——本仓上限是固定导出常量 `CONTENT_CREATION_BATCH_MAX_SELECTION = 50`（`src/server/content-creation/batch.ts`），调用方是 Server Action 而非 CLI，只传一份显式 id 数组，没有第二个数字需要互相校验 | Codex |
| 批量 apply 主循环（`for (const sample of eligibleSamples) { results.push(await runApply(...)) }` + `applySummary` 计数） → `runSequentialBudgetedBatch` + `applyContentCreationBatch`/`dryRunContentCreationBatch` | `src/lib/changdu-promote-drama-batch.ts` | `423-455` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 只借"严格串行 for 循环、每条独立调用既有单条处理函数（`runApply`/`createContentFromSourceItem`）、结果逐条推入数组、再按 status 汇总计数"的编排形态，未搬一行 CPS 代码；**不搬** CLI 专属的 `ChangduPromoteDramaBatchDeps`/`--source-item-ids-file`/dry-run 报告聚合。**新增**（CPS 无对应机制）：墙钟时间预算 `CONTENT_CREATION_BATCH_BUDGET_MS = 25_000`ms——源于本仓自身 v7.9.6 事故教训（同步多条写入端点在反代默认 60s 超时下会 504），预算耗尽即停止，剩余 id 原样标记 `not_processed`、不处理、不回滚已提交项；CPS 批量 apply 没有任何超时/中止机制，一次跑完全部 `eligibleSamples`（仅受 `maxApply ≤ 5000` 数量上限约束） | Codex |

RC-4 的 Server Action 接线（`dryRunContentCreationBatchAction`/`applyContentCreationBatchAction`，
`src/app/(admin)/catalog-sync/_actions.ts`）与登记表新增两条（`admin.content_creation.batch_dry_run`/
`admin.content_creation.batch_apply`，`src/app/api/admin/_lib/registry.ts`）复刻的是本仓 RC-1/P0-S13
自己已有的授权两段式与"dry_run/apply 拆成两个静态 action id"惯例，**不是从 CPS 搬运**——CPS 该批量
入口是 CLI 脚本，没有 Admin Action、能力位或 registry 概念可供搬运，故未在上表登记。

### 无搬运的任务（显式登记，避免被当成漏登）

| 任务 | CPS 复刻分类 | 原因 |
| --- | --- | --- |
| P1-11 阅读器功能 | `ORIGINAL_REQUIRED` | CPS 零可复用的正文托管、分章渲染、阅读版式资产——CPS 的试看是视频跳转，语义不可平移。**本轮无任何从 CPS 搬入的符号。** |
| P2-08 PR2 公开接库 | `ORIGINAL_REQUIRED` | 公开路由、`src/lib/site` mapper、轮播空桩均为小说仓地基上的新接线。takedown/withdrawn V1 走页面层 `notFound()`（404），不搬 CPS proxy 410。明确不搬 `home-carousel-queries.ts`（Owner 裁决空数组）、`drama-hreflang.ts`、`site-queries.ts`、跨 Novel hreflang、`/go` handler。 |
| `PUBLIC_LIST_CAP=240` 内存分页硬顶 | `ORIGINAL_REQUIRED` | 公开列表 `findMany({ take: 240 })` 后再 `isPromoReady` 过滤、内存分页。超限后 browse 的 `totalCount`/`totalPages` 失真，且 sitemap 可能收录 cap 之外的 URL 而 `/browse` 列不出（内链缺口）。V1 接受该限制，本轮不改实现。 |
| P2-11 `src/lib/indexnow/sweep.ts`（`sweepDueIndexNowDeliveries`/`createIndexNowDeliveryTaskItem`） | `ORIGINAL_REQUIRED` | CPS 的 `deliverDueIndexNow` 是单一长函数（查due→CAS 认领→HTTP 投递一体化），没有"把到期行拆成独立可租用工作单元"这一步——小说仓因为改用 `GenericTaskItem` 租约模型（见上方 PATTERN_ONLY 条目），必须新写一层"扫描到期行 + 为每行创建任务项"的调度逻辑，CPS 无对应函数可搬。 |
| P0-S4 `src/server/content-creation/service.ts`（`createContentFromSourceItem` 编排本体：guard 状态机、dry-run、并发冲突关闭、审计写入）与 `src/server/content-creation/business-id.ts`（`Novel.businessId` 生成器） | `ORIGINAL_REQUIRED` | CPS 的 `Drama` 行只靠上游同步任务写入，没有一个独立的"从 SourceItem 创建 canonical 内容"服务可搬；`business_id` 概念在 CPS 里对应上游直传的 `dramaId`，不是自生成短码，无算法可搬。整条创建编排（guard 读+条件 `updateMany` 关闭并发竞态+同事务审计）是本仓自建，只在两处局部借用了本表已登记的既有基建（`src/lib/db/db-retry.ts` 的 `isUniqueConstraintViolation`/`withDbRetry`，以及本表另两条 `slug/short-id` 条目登记的 shortId 算法）。 |
| X8 `bootstrap.conf.template`、AI crawler `limit_req`、`/novel`/`/go`/`/browse` `limit_conn` 与本地 mkcert 三步法 | `ORIGINAL_REQUIRED` | 冻结的 CPS `v8.2.18` tag 中不存在 bootstrap 与 AI snippet，也不含 2026-08-13/14 两份生产止血补丁，不能从短剧当前工作树越界补读。X8 依据 Owner 验收合同与两份止血文档重写小说路径、阈值和本地 TLS 编排；只登记上方 tag 内真实存在的 nginx 基线，不虚构 tag 来源。 |

### RC-11 本地管理员认证恢复（v8.3.6 基线）

RC-11 沿用 RC-1 已冻结的同一 v8.3.6 基线与同一只读工作区（`git show v8.3.6:<path>`，工作树不可读）。
背景：X8 复用旧 PostgreSQL volume 后，遗留管理员 `x8-owner` 已在 2026-08-26 完成 2FA 绑定，
Owner 没有验证器/恢复码，密码通过验证后被 `/two-factor/challenge` 卡死；`bootstrap-admin-identity.ts`
要求身份表为空，无法用于"只重置认证状态"。`scripts/reset-admin-auth-state.ts` 借鉴 CPS
`reset-2fa.ts` 的清理项清单，但审计/CLI 纪律改走本仓已有的 `bootstrap-admin-identity.ts` 形态
（默认 dry-run、`--apply`、稳定 request-id、advisory lock、同事务 `OperationAudit`），而非 CPS
的交互式确认字符串且不写审计。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `resetTwoFactorForUser` 清理项清单（撤销会话、清 2FA 绑定字段、删挑战、删恢复码、`sessionVersion++`） → `scripts/reset-admin-auth-state.ts` 的 `applyReset` | `scripts/reset-2fa.ts` | `139-165` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 只借"清哪些字段/哪些表"的清单本身；**不搬** CPS 的交互式 `readline` 确认字符串（`RESET-2FA-<username>`）、SQLite 路径解析与告警、也不搬"不写审计"这一点——本仓改为默认 dry-run/`--apply`、`RESET_ADMIN_OPERATOR` env、`OperationAudit` 同事务写入、生产 `--break-glass` 门禁（CPS 无此概念）；额外新增本仓才有的 `admin_login_attempt` 清理（CPS 无登录限流表）与 `--deactivate`/`--ip` 选项 | Codex |
| `createTotpQrCodeDataUrl`（`QRCode.toDataURL(uri,{errorCorrectionLevel:"M",margin:1,width:256})`） → `src/lib/auth/totp.ts` 同名函数 | `src/lib/totp.ts` | `63-68` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 三个渲染参数逐字照搬；**不搬** CPS 用 `otpauth` 包构造 URI/issuer/label 的方式——本仓 `createTotpUri`（既有，RC-11 未改）已用自实现 base32/HMAC-SHA1 独立构造 otpauth URI，`createTotpQrCodeDataUrl` 只接收现成 URI 字符串渲染成图，不改 TOTP 算法或 issuer/label 形态 | Claude |
| `admin.username` 单一 `super_admin` 种子形态 → `scripts/ensure-local-admin-identities.ts` | `scripts/seed-admin.ts` | `8,15,23` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 只借"env 注入密码、已存在则跳过、无 argv 明文"的形态；**不搬** CPS 单账户/无长度校验/bcrypt cost 12——本仓固定 `admin`+`admin2` 两账户、scrypt（复用既有 `hashAdminPassword`）、`ADMIN_LOCAL_IDENTITY_SEED=allow` 硬门禁下才允许 <12 位、写 `OperationAudit`、`--reset-password` 才更新既有账户 | Codex |

### 2026-09-05 · Launch parity operating surfaces（v8.3.6）

以下实现先记录 CPS 原始语义，再作 Drama/Episode→Novel/Chapter 与 PostgreSQL 必要适配；没有
越过冻结 tag 读取 CPS 工作树。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| Home carousel config/compute/merge/queries | `src/lib/home-carousel-config.ts`; `src/lib/home-carousel-compute.ts`; `src/lib/home-carousel-merge.ts`; `src/lib/home-carousel-queries.ts` | config 全文件；compute `357-425,586-639`; merge `126-204`; queries `78-236` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | slot/new/window/500 上限、去重、无封面过滤不变；Drama→Novel，收入分支恒禁用，SQLite 访问改 Prisma/PostgreSQL | Codex |
| Template CRUD/default selection | `src/lib/template-actions.ts`; `src/lib/article-generation.ts` | `1-183`; `168-250` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 复用本仓 fail-closed engine；fallback key 固定 system-default-v1；选择改 templateKey 并持久化 templateId | Codex |
| Article edit/regenerate/public SEO | `src/lib/article-actions.ts`; `src/app/drama/[slug]/page.tsx`; `src/lib/blog-seo.ts` | `296-416,535-770`; `126-197`; `215-231` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | Drama→Novel；保 slug/shortId；批量增加 50/25s 预算；公开只消费安全 Article 字段 | Codex |
| Category page/SEO/sitemap projection | `src/app/category/[slug]/page.tsx`; `src/lib/seo-templates/category.ts`; `src/lib/sitemap.ts` | `38-130`; 全文件；`295-367` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `PATTERN_ONLY` | 不搬 Category 表；投影 CanonicalTag manual/mapped，按 sortOrder，空分类 fail closed | Codex |
| Site settings 13 fields and consumers | `src/components/admin/settings-form.tsx`; `src/app/layout.tsx`; `src/components/site-footer.tsx` | `17-32`; `33-38,55-57,99`; `36-53` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 沿用 13 字段、GA4/GSC/footer 消费；friendLinks 改 jsonb，写入继续乐观锁/审计 | Codex |
| Security state and recovery regeneration | `src/app/settings/security/page.tsx`; `src/components/security-panel.tsx`; `src/lib/two-factor-settings.ts` | `1-21`; 状态/动作；`115-240` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | 四态、当前 TOTP、事务替换与 sessionVersion++ 不变；复用端口化 Auth store，无自助禁用 | Codex |
| **N-3（PR6 fix lane A 显式偏离）** `CarouselConfig.windowDays`/`tauDays`/`alpha`（收入评分算法的 W/τ/α 三参数） — Novel 侧 `HomeCarouselConfig` 类型不含这三个字段 | `src/lib/home-carousel-config.ts` | `41-43` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | **不搬**：三字段只服务于 `revenueEnabled=true` 时的收入加权候选算法；Novel 无收入来源，`revenueEnabled` 恒 `false`（见上表 Home carousel 行），该算法分支从未被调用，字段本身也一并从类型里删除而非"读了不用"——`normalizeHomeCarouselConfig` 因此没有这三个键，也没有对应的默认值/校验逻辑。规格 M5 行原文列了 `W30/τ7/α2` 但未随之登记删减，此处补登记 | Claude |
| **N-4（PR6 fix lane A 显式偏离）** `WRITABLE_CAROUSEL_CONFIG_KEYS`（5 字段：`revenueEnabled`/`revenueLocaleWhitelist`/`revenueSourceBeidouEnabled`/`revenueSourceChangduEnabled`/`cronEnabled`） → Novel `updateHomeCarouselConfig` 的可写字段（3 个：`cronSchedule`/`cronTimezone`/`cronEnabled`） | `src/lib/home-carousel-config-write.ts` | `9-15` | `16f2e4cfca51f46af0dede899ecf6242a770bbd0` | `ADAPT` | CPS 的 5 个可写字段里 4 个（`revenueEnabled`/`revenueLocaleWhitelist`/`revenueSourceBeidouEnabled`/`revenueSourceChangduEnabled`）在 Novel 无意义（同 N-3，无收入来源）；只有 `cronEnabled` 有对应语义。Novel 侧改为让管理员写 `cronSchedule`/`cronTimezone`/`cronEnabled` 三项（CPS 把前两者当固定运维值，不经 UI 可写）——这是本仓自己的选择，不是 CPS 语义的直接迁移，故单独登记而非归入上表 `ADAPT` 行的笼统描述 | Claude |

### 2026-09-05 · PR6 fix lane B（M6/M7 咬合测试 + N-7/N-8/N-9）

以下两条不是从 CPS 搬运的符号——CPS `article-actions.ts` 的 `updateArticle` 本身既无
`expectedUpdatedAt` 乐观锁、也不对正文做标签白名单，两条都是本仓在 CPS 之上主动加固，登记为
"与 CPS 同源风险"的接受/收口记录，而非 `ADAPT`/`COPY` 搬运。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| N-7 `Article` 编辑/单条再生成乐观锁（`expectedUpdatedAt` 往返校验 + `[expected, expected+1ms)` 窗口 `updateMany` CAS，同 `SiteSettingMutationConflictError` 的 409 语义） | `src/server/site-settings/service.ts`（`expectedTimestamp`/`updateAdminSiteSetting` 的 CAS 窗口）→ `src/server/articles/service.ts`（`expectedArticleTimestamp`/`updateArticleContent`/`regenerateCore` 的 `ArticleConflictError`） | 窗口 CAS 模式 `560-612` | （本仓内部模式复用，非 CPS 搬运；CPS 无 Article 级乐观锁） | `PATTERN_ONLY` | 只借"往返校验 + 窄窗口 `updateMany` 计数判冲突"的形状；不搬 settings 的幂等重放指纹（`requestFingerprint`/`findCommittedUpdate`）——Article 单条编辑/再生成不需要重放去重；批量再生成（`regenerateArticlesBatch`）不接 CAS，见 `service.ts` 该函数上方注释的理由。`article_conflict` 错误码已由 PR6 fix lane D 登记进 `src/contracts/errors.ts` 的 `AdminErrorCode` 与 `src/features/admin-ui/error-copy.ts` 的 `COPY`（`Readonly<Record<AdminErrorCode, string>>`，漏登即编译期报错），并由 `tests/ui/admin-error-copy.test.ts` 锁定 | Claude |
| N-8 `Article.body` 管理员编辑白名单清洗（`sanitizeArticleBody`：p/br/h2/h3/ul/ol/li/strong/em/a[href https-only]/img[src https-only,alt]/blockquote，`script`/`style`/`on*`/`javascript:` 剥除） | — | — | — | `ORIGINAL_REQUIRED` | CPS `article-actions.ts` 的 `updateArticle` 同样把管理员提交的正文原样落库、不做任何标签白名单——本条目登记的是"本仓比 CPS 更严格"的加固，不是搬运；零依赖手写白名单解析器（`src/server/articles/sanitize-body.ts`），只作用于管理员手工编辑路径（`updateArticleContent`），模板引擎生成/再生成路径（`regenerateCore`）不受影响 | Claude |

### C-17 v8.5.1 参照基线（2026-09-08）

C-17（`/novels`、`/catalog-sync`、`/articles` 三个多选列表补表头「全选本页」）依据 Owner 裁决
「CPS v8.5.1 是默认真身」的口径，引用了本表此前从未登记过的第三条只读参照路径：
`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v851-admin-host`，
该只读工作区当时 `git rev-parse HEAD` 实测为
`c37602c3933ca97adad0281deb6c75e71e550412`（工作区本身 `git status --porcelain` 为空、施工前后
未变）。该 sha **不是** tag `pulsedrama-v8.5.1-freeze-20260906` 的 peeled commit——tag 的 peeled
commit 是 `3a76877af27c6247ad94be946b44e9cc5c1cb9ce`（`chore(release): prepare v8.5.1`）；
`c37602c` 是该 tag 之上另外 2 个 docs-only commit 之后的只读工作区 HEAD（`057e0c1`
`docs(release): record v8.5.1 production rollout` → `c37602c`
`docs(release): sync v8.5.1 developer logs`）。下表 `baseline_commit` 列固定登记的正是这个
只读工作区 HEAD sha（`c37602c`），不是 tag 本身的 peeled commit——本节标题沿用 v8.5.1 冻结快照
基线的通称，但登记值指向的是「tag 之上 2 个 docs-only commit」这一精确坐标，行文不应混称为
"tag 的 peeled commit"。仓库 `CLAUDE.md` 第 23/34 行把只读参照冻结
在另外两条路径（`cps-admin-v811-search-ux`@`d77c3b9…` 与 `cps-admin`@`v8.2.18`/`v8.3.6`），第三条
路径与 `CLAUDE.md` 现状冲突；照本表既有先例（X 系列、RC-1 均以独立小节追加新的冻结基线，而不
回改上一条基线的登记），本节只新增基线记录，`CLAUDE.md` 的更新留给 Owner 另行处理。

C-17 只搬运 UI 交互形态（表头 checkbox 的 `checked`/`indeterminate`/`onChange` 接线与判满算法），
不搬任何数据库模式或服务端代码。`port_kind` 统一为 `ADAPT`：CPS 三处参照里，剧集列表
(`dramas-list-client.tsx`) 与换剧计划表 (`batch-drama-switch-client.tsx`) 是不分页的全量列表，
「全选」即选中 `dramas`/`items` 整个数组；本仓三个列表都是服务端分页（每页 20 条），故统一改为
「只管当前页」语义，判满算法从 `selected.size === dramas.length` 改成
`rows.length > 0 && rows.every((r) => selected.has(r.id))`（贴 `batch-drama-switch-client.tsx:227`
与`changdu-sync-panel.tsx:444-445` 的写法，而非 `dramas-list-client.tsx:65` 的 `size` 比较——分页
路由是 `<Link>` 导航，`size` 比较在 React 按位置复用组件、选择集残留其他页 id 时会误判）。

**不搬 CPS `changdu-sync-panel.tsx` 的 `selectionMode='filtered'` 提级机制**
（`canPromoteToFiltered`/"勾满一页后可再提级为『按当前筛选条件全选』"，`changdu-sync-panel.tsx:466-467`）：
这是"当前页已全选"之后的第二级动作，把选择语义从"这些显式 id"换成"这个筛选条件命中的全部行"，
需要选择集额外携带一个筛选描述符状态且改变提交时的语义。三个本仓列表里，`/catalog-sync` 的
两个消费方（批量创建内容、领取推广链接）都要求"调用方显式枚举 id，不接受筛选描述符"——工单
3.1/3.4②已引用的 `createPromoLinkClaimTask` 纪律与 CPS 自己的硬规则（"畅读推广码领取只支持显式
勾选剧目，不支持当前筛选全量领取"）同源；`/novels`、`/articles` 没有对应的筛选提级 UI 也没有
这层服务端契约。C-17 的范围是「表头全选本页」这一件事，不新增选择状态字段、不新增跨页/按筛选
的选择机制（工单 3.3「不新增机制」与三.5「不做」均已注明），故提级机制不在移植范围内。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| 表头全选 checkbox（`checked`/`ref` 回调设 `indeterminate`/`onChange`）→ `NovelsTable` 表头格 + `NovelsBatchPublish.toggleAll` | `src/components/dramas/dramas-list-client.tsx` | `202-211`（半选态 ref 回调形态）；`65-66,68-72`（`allSelected`/`partial`/`toggleAll` 判满写法，仅借鉴 `every`/`size` 取舍，未直接采用其 `size` 比较） | `c37602c3933ca97adad0281deb6c75e71e550412` | `ADAPT` | 保留 `ref={(el) => { if (el) el.indeterminate = ... }}` 的半选态设置手法与表头 `input[type=checkbox]` 位置；判满改用 `batch-drama-switch-client.tsx:227` 的 `every` 写法（见下一行），因为 `/novels` 是服务端分页，`toggleAll` 只增删当前页 `novels` 数组里的 id，不做跨页全选；新增 `disabled={selection.disabled?.(novels[0]) ?? false}` 复用既有行级 `disabled` 回调表达"提交中禁用整个表头"，CPS 该组件无提交中禁用语义 | Claude |
| 判满用 `every` 而非 `size` 比较 → `CatalogSyncClient` 的 `allSelected`/`someSelected` + `toggleAllVisible` | `src/components/articles/batch-drama-switch-client.tsx` | `227`（`allSelected = items.length > 0 && items.every(...)`）；`244-251`（表头 checkbox JSX）；`588-592`（`toggleAllOkItems`：`every` 判满则清空，否则全选） | `c37602c3933ca97adad0281deb6c75e71e550412` | `ADAPT` | 保留 `every` 判满与"满则清空/不满则全选"的 `toggle` 逻辑；`aria-label` 从 CPS 的 `"全选 ok 项"` 改为本仓统一措辞 `"选择当前页"`；可选行范围不按 `ok`/领取资格过滤——CPS 该组件的 `okItems` 子集在本仓没有对应概念，选择集覆盖 `items`（当前页）全部行，含"不可领取"行（见工单 3.4②与本节上方"不搬 `selectionMode='filtered'`"说明） | Claude |
| 分页型「选择当前页」+ 不看上限 → `NovelsTable`/`CatalogSyncClient`/`ArticleList` 的表头 checkbox 与 `toggleAll`/`toggleAllVisible` | `src/app/(admin)/sync/_components/changdu-sync-panel.tsx` | `444-445`（`allVisibleSelected = rows.length > 0 && rows.every(...)`）；`479-488`（`toggleVisibleRows`：只增删当前页 `rows`，不清空跨页选择）；`1038-1046`（表头 `aria-label="选择当前页"` 与 `className` 形态） | `c37602c3933ca97adad0281deb6c75e71e550412` | `ADAPT` | 三处目标文件均按此形态：`every` 判满、`aria-label="选择当前页"` 逐字复用、`onChange` 只增删当前页数组里的 id、不清空其他页已选、不与批量上限（200/50/50）交互——三个上限都 ≥ 每页 20 行，全选一页在数学上不会越限，越限判定继续留给既有提交侧逻辑（`overCap`/`selected.size > 50` 等），未改动；**不搬** CPS `submitTooMany`/`MAX_LINK_SELECTION` 一类"全选后再判断是否超限并禁用提交"的耦合逻辑，因为本仓选择上限判定本就与全选动作解耦 | Claude |
| 备份份数下限+陈旧保护的保留纪律形态 → `x8_gc()` 的镜像保留规则 | `scripts/ops/prune-backups.sh` | `1-49`（顶部纪律注释：并集条件、sidecar 标记、mtime 排序理由、退出码含义）；`66-67,83-86`（`FLOOR`/`STALE_HOURS`/`--label` 参数定义）；`142,165`（陈旧保护触发时 `exit 2`，本轮只告警不删） | `c37602c3933ca97adad0281deb6c75e71e550412` | `ADAPT` | 借鉴对象是"保留纪律该有的形状"，不是逐句代码：`--floor N`（份数下限，不论多旧最近 N 份永不删）对应到 `x8_gc()` 就是 §4.2 的"最近 N 个"这一类；按 mtime（这里是 `docker images` 的 CreatedAt）而非文件名排序、`--label` 式的可归因日志、顶部大段注释写清"这条保护为什么存在、降级时会怎样"三点原样借鉴。**明确不搬 `--stale-hours` 陈旧保护**（"上游备份管线疑似停摆时本轮放弃删除、只告警、退出码 2"）：这条保护解决的是"产出方停摆、消费方却继续按计划删"这个时间错位问题，镜像场景没有对应的"上游"概念——每次 `up` 是否新打一个 tag 完全由这次部署本身决定，不存在一个独立的、可能静默停摆的"生产方"。`x8_gc()` 里语义对等、且实测更强的保护是 §4.2 第 4 类"被任何容器引用（含已停止）的镜像永不删"——这是本工单 2026-09-09 审计实证过的真实场景（最老的 `0.1.0-62453d2` 仍在被另一 compose 项目的 worker/scheduler 使用），比"距今多久没更新"更精确地回答了"删了会不会打断正在跑的东西"这个问题，所以镜像侧选它作为等价保护，而不是移植一个没有对应现实场景的陈旧检测。同理**不搬**"情况 A/情况 B 标记文件降级"整套机制——镜像没有"验证通过"这个中间态，`docker images` 报出来的标签本身就是权威事实，无需 sidecar 标记佐证 | Claude |

### I18N 复数能力（intl-messageformat 解析引擎，v8.5.1 基线，2026-09-10）

依据 `施工工单_I18N_复数能力_移植CPS_next-intl_plural_2026-09-10.md`。沿用 C-17 已登记的第三条只读
参照路径 `cps-admin-v851-admin-host`（`baseline_commit` = `c37602c3933ca97adad0281deb6c75e71e550412`），
不新增参照仓。

**搬的是哪一层，登记为什么是 `ADAPT` 而不是 `COPY`：** 本条目搬运的不是仓库源码里的某个符号，
而是 CPS 复数能力实际落脚的第三方依赖版本——从 CPS 的 `node_modules` 逐层读 `package.json` 得到
真实 resolve 出来的调用链 `next-intl 4.11.0 → use-intl 4.11.0 → intl-messageformat 11.2.3 →
@formatjs/icu-messageformat-parser 3.5.6`，复数判定本身不在这条链的任何一层，最终调的是平台内置
`Intl.PluralRules`。本仓把 `intl-messageformat@11.2.3` / `@formatjs/icu-messageformat-parser@3.5.6`
两个版本号原样对齐 CPS 生产树引入为依赖（`package.json`），`t()`/`createTranslator`/`getPublicT`
三个函数本身是本仓既有函数的原地改造（替换内部渲染实现、新增 `locale` 参数与编译缓存），不是从
CPS 抄来的 wrapper 代码——CPS 那层 wrapper 是 `next-intl`/`use-intl`，本条目明确不搬。因此
`port_kind` 登记为 `ADAPT`：搬的是"引擎版本对齐"这个事实，改的是"整个调用方式与错误语义"。

**为什么不搬 `next-intl`/`use-intl` 框架层（详见工单 §4.1/§4.2）：** ①路由归属权冲突——
`next-intl` 的 `defineRouting`/`createNavigation`/中间件要接管语种前缀、`Link`、`redirect`，
与本仓自管的 `src/proxy.ts` + `src/app/[locale]/*` 薄壳正面冲突；②回落语义方向相反——CPS
`deepMergeMessages` 遍历 override 的键、允许译文引入英文没有的新键，本仓 `deepMergeOntoEnglish`
遍历 base（英文）的键、只接受非空字符串覆盖，这是"Owner 修正一"的既定方向，接 next-intl 要么
放弃这条要么在 `getRequestConfig` 里重新实现一遍；③类型安全退化——本仓 `MessageKey` 从 `en.ts`
的 `as const` 对象推出字面量联合，写错键名是编译错误，next-intl 的 key 类型推导走另一套
（`@schummar/icu-type-parser`），要接就得把 `en.ts` 从 TS 对象改成 JSON；④不必要的运行时——
next-intl 4.11 依赖里有 `@swc/core`/`@parcel/watcher`/`po-parser`/`negotiator`/`icu-minify`，
为一个复数功能量级不对。

**为什么不选 `use-intl` 而是裸 `intl-messageformat`（工单 §4.2 决定性证据）：** 海阅 `t()` 的
一条承重语义是"缺变量就抛"（fail-loud）。实测 `use-intl`（即便把 `onError` 配成直接 `throw`）
在"缺变量但不传第二个参数"这一格会**静默跳过格式化**、直接返回原始模板 `"{count} preview
chapters"`——`onError` 根本不会被调用；而裸 `intl-messageformat` 在同样场景下正确抛
`MissingValueError`。裸引擎比 `use-intl` **和**本仓原有的手写正则 `t()` 都更严格，方向正是海阅
既定的 fail-loud 纪律要求的方向（§4.4 收紧，见下）；`use-intl` 相对多出来的 React
hooks/number/date/list/relativeTime 格式化器/命名空间管理/错误兜底策略，本仓要么已有
（命名空间由 `MessageKey` 类型管）要么明确不想要（错误兜底）。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `intl-messageformat@11.2.3` + `@formatjs/icu-messageformat-parser@3.5.6`（CPS 复数能力依赖链的解析引擎层，非 `next-intl`/`use-intl` 框架层） | CPS `node_modules` 递归 `package.json` resolve 得到的真实版本（非仓库源码路径；`next-intl 4.11.0 → use-intl 4.11.0 → intl-messageformat 11.2.3 → @formatjs/icu-messageformat-parser 3.5.6`） | N/A（依赖版本对齐，非代码行搬运） | `c37602c3933ca97adad0281deb6c75e71e550412` | `ADAPT` | 只对齐引擎版本号作为本仓生产依赖（`intl-messageformat` production dep）+ 门禁专用 dev 依赖（`@formatjs/icu-messageformat-parser`）引入；不引入 `next-intl`/`use-intl` 框架层（路由/Link/redirect/usePathname、React hooks、messages 命名空间管理、`onError` 兜底策略）——理由见上方两段说明；`t()`/`createTranslator`/`getPublicT` 是本仓 `src/lib/locale/messages/index.ts` 既有函数原地改造为调用该引擎（新增 `locale` 参数、`Map<string, IntlMessageFormat>` 编译缓存、`MissingValueError` 重新包装为既有 `MissingMessagesError`），不是从 CPS 抄的 wrapper 代码 | Claude |

### L10N P1 语言归一与存量重算（channel-language.ts，2026-09-10）

依据 `施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md`。`baseline_commit`
固定为构建施工提示词本身指定的 `3a76877af27c6247ad94be946b44e9cc5c1cb9ce`——即 tag
`pulsedrama-v8.5.1-freeze-20260906` 自身的 peeled commit（`chore(release): prepare
v8.5.1`），**不是**上方 C-17/I18N 两节登记的 `c37602c...`（那是同一只读工作区上
`3a76877` 之上另外 2 个 docs-only commit 之后的 HEAD，见上方 C-17 小节的说明）。
两者是同一只读路径 `cps-admin-v851-admin-host` 上的两个不同坐标，本节明确使用
前者，与上方两节各自独立、互不覆盖。

**范围说明**：`src/lib/locale/channel-language.ts` 是新文件，COPY/ADAPT 自 CPS
`src/lib/channel-language.ts`——CPS 该文件服务多渠道多上游 app（`beidou`/
`changdu_moboreels`/`changdu_shortmax`/…），本仓只有一个上游来源 app
（`moboreader`），所以按 sourceApp 索引的结构（`LANGUAGE_REGISTRY_BY_SOURCE_APP`）
保留，但简化为单 key；`channel`/`channelAppKey`/`label`
（`LOCALE_LABEL` 依赖）字段丢弃——没有调用方需要，非"顺手精简"，是"CPS
多渠道维度在本仓不存在"。moboreader 18 码的**取值**来自海阅自己 X8 库的真实
证据（`docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`），CPS
`CHANGDU_SHORTMAX_LANGUAGE_CODE_TO_LOCALE` 只作交叉核对，不是取值来源，因此
该常量本身不登记为 COPY 对象（下表只登记算法/别名表/熔断函数的 COPY）。

`scripts/l10n/backfill-source-item-locale.ts` ADAPT 自 CPS
`scripts/backfill-drama-source-item-locale.ts`：CPS 版本按 `channelApp.channel.
code`/`channelApp.sourceApp.code` 派生 `channelAppKey`（多渠道场景），本仓单
source app 场景该步骤整段删除；CPS 的 `--apply` 无审批门禁，本仓按
`scripts/p2-06-5-production/tagging-bootstrap.ts` 同款方式加了 `--approver`
（须为 `status=active` 的 `AdminIdentity`）+ `OperationAudit` 审计行（详见脚本
文件头注释）。`scripts/l10n/probe-unnamed-language-codes.ts` 是新增证据线 X
工具，无 CPS 对应文件（`PATTERN_ONLY`：借用既有 `getchapterinfo` 适配器与
凭证/保险丝路径的调用形状，不是搬运 CPS 某个探针脚本——CPS 没有等价物）。
`worker/handlers/moboreader.ts` 的熔断接线 ADAPT 自 CPS
`src/lib/changdu-dry-run.ts:429-450`：CPS 在一次 `changdu-dry-run` 调用（对应
一次上游分页拉取）粒度内评估熔断，本仓按 `persistCatalogPage`（同样对应一次
`catalog_page` 任务项 = 一次上游分页拉取）粒度调用，语义对齐、粒度同构；CPS
熔断命中后在同一函数作用域内重写 `parsedItems`，本仓分两段（`pageLanguage
Resolutions` 预解析 → `suspendedLanguageCodes` 判定 → 逐行落库时读判定结果），
因为本仓的持久化是逐行 upsert 而非 CPS 那种整批 `parsedItems` 数组重写。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `ChannelLanguageConfidence`/`ResolvedChannelLanguageConfidence` 类型 → `src/lib/locale/channel-language.ts` | `src/lib/channel-language.ts` | `3-9` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `COPY` | 原样复制两个类型别名 |
| `ChannelLanguageWarning` 类型 → 同上（去 `channel`/`channelAppKey` 字段） | `src/lib/channel-language.ts` | `11-23` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | 删 `channel`/`channelAppKey` 两个多渠道字段，其余字段名/类型逐字保留 |
| `ChannelLanguageResolution` 类型 → 同上（去 `channel`/`channelAppKey`/`label`） | `src/lib/channel-language.ts` | `25-35` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | 删 `channel`/`channelAppKey`/`label`（`label` 依赖 `LOCALE_LABEL`，本仓无调用方，不搬），其余字段名/类型逐字保留 |
| `UNKNOWN_SOURCE_LOCALE_FILTER` 常量 → 同上 | `src/lib/channel-language.ts` | `57` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `COPY` | 原样复制（`"__unknown"`） |
| `LANGUAGE_NAME_ALIAS_TO_LOCALE` 别名表 → 同上（私有常量，未导出） | `src/lib/channel-language.ts` | `184-266` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `COPY` | 原样复制全表（含简体中文变体显式 `null`），不是过滤子集——本仓 18 码的全部上游 `languageName` 恰好都已在这张全表里，未新增任何条目 |
| `normalizeLanguageAlias`/`resolveLanguageNameAlias` 函数 → 同上 | `src/lib/channel-language.ts` | `269-281` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `COPY` | 原样复制（NFKC 归一 + trim + 折叠空白 + 小写；别名表查不到与显式 `null` 两种情况均返回 `null`，不做区分） |
| `resolveChannelLanguage` 函数 → 同上（去多渠道 `channel`/`channelAppKey`/`explicitSourceAppCode` 派生逻辑） | `src/lib/channel-language.ts` | `283-361` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | code→name 解析优先级、`code_name_conflict` 告警产出逻辑、三态返回（code/name_alias/unknown）逐字保留；`sourceAppCode` 默认值固定为 `"moboreader"` 取代 CPS 从 `channelAppKey` 派生 `changdu_<sourceApp>`/`beidou` 的多分支逻辑（本仓无此维度）；`resolveChannelCode`/`deriveSourceAppCodeFromChannelAppKey`/`normalizeSourceAppCode` 三个多渠道辅助函数不搬 |
| `evaluateLanguageMappingSuspensions` 函数 → 同上 | `src/lib/channel-language.ts` | `496-520` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `COPY` | 原样复制，含 `total>=10 && conflicts>=3 && rate>=0.2` 三阈值逐字不变 |
| 熔断接线粒度（每次上游分页拉取评估一次、命中即本批强制 `locale=null`）→ `persistCatalogPage` | `src/lib/changdu-dry-run.ts` | `380-450` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | 语义/粒度对齐（见上方范围说明段落最后一段）；持久化结构从"整批数组重写"改为"逐行 upsert 前读判定结果"，因为本仓落库路径本就是逐行 `tx.novelSourceItem.upsert`，不是 CPS 那种批量构造后统一写入 |
| `backfillSourceItemLocale` 核心循环（cursor 分页、dry-run 默认、`--re-resolve`、条件 `updateMany`）→ `scripts/l10n/backfill-source-item-locale.ts` | `scripts/backfill-drama-source-item-locale.ts` | `1-173`（全文件） | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | 删 `channelAppKey` 派生步骤（多渠道概念，本仓不适用）；`--apply` 从"无门禁直接写"改为"需 `--approver`（`AdminIdentity` 存在且 active）+ `OperationAudit` 审计行"，同款方式见 `scripts/p2-06-5-production/tagging-bootstrap.ts` 的 `resolveApprover`/审计写入模式；报告形状从"扁平计数"改为"按 `sourceLanguageCode` 分桶的 before/after locale 直方图"（施工提示词 §1.F 明确要求"每码 before/after 计数"）；无 `NovelSourceItem` 对应的 mapping-version DB 列（核对 `3a76877:prisma/schema.prisma` 的 `DramaSourceItem` 同样没有该列），故不加迁移，`MAPPING_VERSION` 只记在报告/审计快照里 |
| CanonicalTag bootstrap 的 approver 校验/审计写入形状 → `resolveApprover`/`OperationAudit` 写入 | `scripts/p2-06-5-production/tagging-bootstrap.ts` | `651-657`（`resolveApprover`）、`841-859`（`OperationAudit.create`） | 本仓内部模式复用，非 CPS 搬运 | `PATTERN_ONLY` | 只借"UUID 或 username 双形态查找 + status=active 校验失败即 fail() + OperationAudit 记录 actorType/action/entityType/requestId/reason/before-after snapshot"的形状；不搬 `pg_advisory_xact_lock`（backfill 场景不需要跨进程互斥，`--request-id` 重放判定已足够）与 `--channel-app` 绑定校验（本脚本没有对应概念） |

### L10N P2 创建链语种强制继承 + 发布层 locale 检查删除（content-creation/service.ts + publish-gate/evaluator.ts，2026-09-10）

依据 `施工提示词_Sonnet_L10N_P2_创建链语种强制继承_2026-09-10.md`。`baseline_commit`
沿用 L10N P1 小节同一坐标 `3a76877af27c6247ad94be946b44e9cc5c1cb9ce`。

**范围说明**：矩阵 #3/#4（创建链语种强制继承）与矩阵 #8（发布门禁语种条件删除）。
CPS 参照的 `changdu-promote-drama-dry-run.ts`/`changdu-promote-drama.ts` 是一次批量
"上游来源 → Drama 提级" 的 dry-run/apply 流水线，产出 `blockReasons: string[]` 数组；
本仓的 `createContentFromSourceItem` 是单条来源条目、单事务、结构化返回值（非
`blockReasons` 数组）的创建路径，形状本就不同，因此下表大多数条目登记为
`ADAPT`/`PATTERN_ONLY`（借语义/借顺序），不是逐行 `COPY`——`missing_locale`/
`unsupported_locale` 两个错误码名称本身是逐字复用（CPS parity 的落点是"码名一致"，
不是"实现逐字一致"）。模板同语种硬阻断取 CPS **批量**路径的语义
（`batch-actions-core.ts:167-183`：模板存在性与语种匹配合并成一次判定），不取
CPS 单篇路径的语义（`article-actions.ts:569-576`：先判"模板不存在"再单独判
"语种不匹配"两次独立判定）——因为 `selectActiveArticleTemplate` 的查询本身就是
locale-过滤在内的单次组合查询，无法在不改 `article-templates/service.ts`（P3
territory，本轮不改）的前提下拆成两次独立判定去复刻单篇路径的两阶段错误码。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `missing_locale`/`unsupported_locale` 阻断语义（locale 只来自来源事实、无人工覆盖）→ `deriveLocale`（`src/server/content-creation/service.ts`） | `src/lib/changdu-promote-drama-dry-run.ts` | `514-534` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | CPS 用 `blockReasons.push("missing_locale", "unsupported_locale")` 累积进批量 dry-run 报告数组；本仓改为 `ContentCreationInputError` 抛出（单条创建路径本就是"guard 即失败"的形状，`src/app/(admin)/catalog-sync/_actions.ts` 与 `./batch.ts` 已有的 `ContentCreationInputError` 捕获链路可直接复用），错误码名称逐字复用 CPS 的两个码名；`normalizeBcp47Locale`/`isSupportedSiteLocale` 两步判定合并为一次 `SITE_LOCALES.includes` 成员检查，因为本仓 `NovelSourceItem.sourceLocale` 落库时已经是 L10N P1 worker 写路径解析好的 BCP-47 值或 `NULL`（`src/lib/locale/channel-language.ts`），不需要在读取时再跑一次 `normalizeBcp47Locale` |
| locale 只来自来源事实，不接受调用方覆盖 → `Novel.locale`/`Article.locale` 写入点（`runCreateTransaction`） | `src/lib/changdu-promote-drama.ts` | `360-361`、`674-677` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `PATTERN_ONLY` | 只借"locale 是从 `sample.resolvedSiteLocale`/`plannedDramaFields.locale` 读出来的派生值，`createPlannedDramaFields` 找不到 locale 直接 `throw`，没有任何入参能覆盖它"这条设计原则；不搬 `ChangduPromotionSample`/`createPlannedDramaFields` 的具体实现（分类器接线、`generateDramaId`/`generateSlug` 等与本仓 `createNovelWithBusinessIdRetry`/`resolveUniqueSlug` 完全不同构） |
| 模板同语种硬阻断（找不到匹配语种模板即硬错，批量语义）→ `template_locale_mismatch`（`runCreateTransaction`/`runDryRun`） | `src/lib/batch-actions-core.ts` | `167-183` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `PATTERN_ONLY` | 只借"模板语种与内容语种不匹配是一次硬阻断，且不区分'模板不存在'与'模板语种不对'两种子情形"的批量语义；不搬 CPS 的两步实现（先 `Set` 去重模板语种检查同批模板是否单一语种，再逐个 `drama.locale` 比对）——本仓 `selectActiveArticleTemplate` 已经是"给定 locale 取单个模板"的单次查询，语种筛选在查询内部完成，没有"同批多模板语种是否一致"这个中间态需要复刻 |
| `getTemplateDramaLocaleMismatch` 的"模板不存在"与"语种不匹配"两次独立判定 | `src/actions/article-actions.ts` | `569-576` | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | 不搬（仅作对照说明，不登记为 port） | 见上方"范围说明"——本仓创建=单事务无单篇/批量之分，取批量语义，不取这个单篇路径的两阶段错误码 |
| 发布门禁删除语种检查（Owner 明示例外） → `src/server/publish-gate/evaluator.ts` 删 `checkLocale`/`isRegisteredSiteLocale`/`locale_not_publishable` push/deps 注入位 | 不适用（本条是删除，非搬运） | 不适用 | 不适用 | 不适用（DELETE，非 COPY/ADAPT/PATTERN_ONLY） | **Owner 2026-09-10 明示例外**：`docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md`/`evaluator.ts` 自身 2026-09-08 曾登记的"发布门禁只允许改这一处"的禁区，本轮 Owner 再次明示允许触碰、仅此一处、仅删除语种注册检查；`src/contracts/publish-gate.ts` 的 `locale_not_publishable` 理由码本身不删（该文件本轮不改，P2-01 FROZEN 契约），只是 evaluator 不再产出它；`tests/backend/publish-gate/no-bypass.test.ts` 的既有失败签名（`scripts/s1-exact-target-structural-smoke.ts` 一条 `.$executeRawUnsafe` 命中）改前改后逐字相同，已实测核对 | Claude |

**P2 遗留小项补登记（L10N P5 §1.E，2026-09-11）**：批量创建的**失败时机**是一处刻意保留的语义偏离，不是待收口的 gap——CPS `batch-actions-core.ts:167-183` 在写入前对整批做一次性语种一致性扫描，任何一条不满足即**事前**整批拒绝（零写入）；本仓 `applyContentCreationBatch`（`src/server/content-creation/batch.ts`）逐条走独立事务，一条 `template_locale_mismatch`/`missing_locale`/`unsupported_locale` 只让**该条**在 `runDryRun`/`runCreateTransaction` 内部以 `事后`（每条自己的事务边界内）报错并计入 `failed`，同批其余条目不受影响、各自继续尝试。两者对"模板语种不匹配"这条判定本身的语义一致（找不到匹配语种模板即硬错，不区分"模板不存在"与"语种不匹配"两种子情形），偏离仅在"整批同生共死"（CPS）与"逐条独立成败"（本仓）——本仓从 P0 起就没有 CPS 意义上的"一批 = 一次事前校验通过的写入窗口"这个概念（`batch.ts` 本身就是逐条事务循环，不是单个大事务），裁决为 `PARITY` 可接受，不倒退去为了逐字复刻 CPS 的整批拒绝语义而牺牲本仓已有的"部分成功、逐条可查"体验。

### L10N P3 模板 locale 非空化 + 15 语默认模板资产（2026-09-10）

`施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md` §1，矩阵 #5。CPS
参照仍是同一个冻结快照 `3a76877af27c6247ad94be946b44e9cc5c1cb9ce`（`git -C
/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v851-admin-host show
3a76877:<path>`）。`ArticleTemplate.locale` 的 `NOT NULL DEFAULT 'en'` 形状与
`scripts/l10n/article-template-bootstrap.ts` 的 dry-run/SHA-pin/审批门/幂等 CLI 形状均登记于
下表；`template-manager.tsx` 的 `TEMPLATE_LOCALE_OPTIONS`（CPS 17 项，相对本仓 `SITE_LOCALES`
多出 `it`/`tr` 两个真实但未登记为站点语种的 BCP-47 码，不是 `pt`/`zh-TW` 别名折叠）
**未搬运**——本仓沿用既有唯一真源 `SITE_LOCALES`（15 项），只是删掉了旧实现里那条「全部语种」
选项，不是从 CPS 搬入一张新表，故不在此登记为 port。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `ArticleTemplate.locale` 非空默认形状 → `prisma/schema.prisma`（`ArticleTemplate` model） | `prisma/schema.prisma` | `518`（`locale String @default("en")`） | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `ADAPT` | 列类型/长度不变（`VarChar(16)`），只把 CPS 的"非空 + 默认 en，无通用模板语义"这一约束形状对齐过来；本仓额外走一条 `UPDATE ... WHERE locale IS NULL` 防御性回填（X8 今日实测 0 行，生产未核实、迁移仍保留该 UPDATE 作为安全网），CPS 原始迁移无此回填（CPS 该列从建表起就是非空，没有历史 NULL 行要处理） |
| bootstrap CLI 的 dry-run/SHA-pin/`--apply --approver`/幂等 + 自建 `OperationAudit` 形状 → `scripts/l10n/article-template-bootstrap.ts` | `scripts/p2-06-5-production/tagging-bootstrap.ts` | `1-79`（文件头设计说明）、`156-227`（错误类型/CLI 解析）、`651-657`（`resolveApprover`）、`774-859`（apply 事务与审计写入） | 本仓内部模式复用，非 CPS 搬运 | `PATTERN_ONLY` | 只借"dry-run 默认 + hash 钉死输入 + `--apply` 需 `--approver`（`AdminIdentity` 存在且 active）+ 落库走独立 `OperationAudit`、不经 `mutateAdmin*` 语义层"的整体形状；不搬 `--channel-app` 绑定校验（本脚本没有对应的外部绑定概念）、不搬 `pg_advisory_xact_lock` + `--request-id` 请求级重放去重（tagging-bootstrap 的 196 条映射边需要跨进程互斥防止重复审计；本脚本 15 行数据量小，幂等性直接靠 `(templateKey, version)` 唯一键 upsert 收敛，每次 `--apply` 允许各自记一条 provenance 审计行，不做重放去重）；也不搬 keyword 词表三条过滤规则（本脚本无关键词词典概念） |
| 每语种独立 `templateKey`（`system-default-v1` / `system-default-<locale>-v1`）→ 15 份 `assets/article-templates/*.json` + `article-template-bootstrap.ts` | `scripts/ops/tkd-dryrun-paginated.sh` | `85-93`（`TEMPLATE_LOCALE` 关联数组：`RUTPL01`→`ru`、`FRTPL01`→`fr`、`PTTPL01`→`pt-BR`、`ESTPL01`→`es`、`FTTPL01`→`zh-Hant`、`TPL001`→`en`） | `3a76877af27c6247ad94be946b44e9cc5c1cb9ce` | `PATTERN_ONLY` | 只借"每个语种一个独立业务标识、不共用一份带通配语义的模板行"这条组织形态；不搬 CPS 该脚本的具体 6 个短码值（本仓 15 语种的 `templateKey` 由 §1.D 命名约定 `system-default[-<locale>]-v1` 独立生成，不复用 `RUTPL01` 这类简写） |

### L10N P4 公开面两层分层、根路径协商、白名单层删除（2026-09-10）

依据 `施工提示词_Sonnet_L10N_P4_公开面两层分层与白名单删除_2026-09-10.md`（§0–§5），
规划矩阵 #9/#10/#12（#11 JUSTIFIED_DEVIATION 不动）。`baseline_commit` 沿用
L10N P1/P2 同一坐标 `3a76877af27c6247ad94be946b44e9cc5c1cb9ce`。

#### §1 施工前取证（四张清单，先于代码改动产出）

**清单①：CPS 动态层（`getActiveLocales`/`active-locales`）消费点**
——`git -C <cps> grep -n "getActiveLocales\|active-locales" 3a76877 -- src`：

| 文件 | 用途 |
| --- | --- |
| `src/lib/active-locales.ts` | 定义本身（`unstable_cache(queryActiveLocales, ["active-locales-v1"], {revalidate:300, tags:["active-locales"]})`，`Drama.groupBy({by:["locale"], where:{status:"active", locale:{not:null}}})`，`en` 恒含，按 `locales` 顺序返回） |
| `src/components/site/site-header.tsx` | **唯一真实消费点**：`await getActiveLocales()`，结果传给 `<LocaleSwitcher availableLocales={activeLocales} />` |

CPS 动态层的消费面极窄——只有 `SiteHeader`→`LocaleSwitcher` 这一条链路读它；sitemap/hreflang/IndexNow/路由/canonical 全部读静态层（见清单②）。海阅动态层的消费点必须同样只对齐这一条链路，不得因为"反正已经有异步函数了"就顺手扩大到 sitemap 等静态层地盘（矩阵 #9 施工要点原话："CPS 用静态集的地方不得换动态集"）。

**清单②：CPS 静态层（`SUPPORTED_SITE_LOCALES`/`isSupportedSiteLocale`/`routing.locales`）消费点**
——`git -C <cps> grep -n "SUPPORTED_SITE_LOCALES\|isSupportedSiteLocale\|routing.locales" 3a76877 -- src`，
共 70 余处命中，按海阅有无对应落点分两类：

有海阅对应落点、本轮需要改的（与 §2 范围逐一对应）：
| CPS 文件/符号 | 语义 | 海阅对应落点 |
| --- | --- | --- |
| `src/i18n/routing.ts`（`locales = SUPPORTED_SITE_LOCALES`，`isSupportedLocale`） | 路由层 locale 集合 | `src/proxy.ts` 路径段解析、`src/app/[locale]/_guard.ts` |
| `src/app/[locale]/(site)/layout.tsx:15,35,46`（`hasLocale(routing.locales,...)`） | 注册即路由 | `src/app/[locale]/_guard.ts` `getRoutableLocale` |
| `src/lib/static-sitemap-generator.ts:190`（`routeLocales = options.routeLocales ?? locales`） | sitemap 分片默认全量 | `src/lib/seo/static-sitemap-generator.ts:190` |
| `src/lib/indexnow-outbox.ts:70-82`（`isSupportedSiteLocale`） | IndexNow 资格 | `src/lib/indexnow/eligibility.ts`（已有等价 `isRegisteredSiteLocale`，只是默认门未切换） |
| `src/lib/drama-hreflang.ts:17-31`（静态 `locales`） | hreflang sibling 查询范围 | `src/lib/seo/novel-hreflang.ts` `loadNovelHreflangSiblings` |
| `src/lib/supported-site-locales.ts:21`（`BLOG_ARTICLE_LOCALE_OPTIONS = SUPPORTED_SITE_LOCALES`，`article-blog-create-form.tsx:15`） | 博客创建表单语种下拉 | `blog-create-form.tsx`、`content-creation/blog.ts` `requireLocale` |

无海阅对应落点（CPS 特有能力，本轮不搬、不登记为 GAP）：`(admin)/articles/faq-workbench/**`（FAQ 工作台，海阅无此功能）、`(admin)/home-carousel/page.tsx`/`home-carousel-config-write.ts`（轮播 locale，P5 范围，本轮"不做"清单已列）、`(admin)/tags/_components/locale-field-editor.tsx`（对应海阅 `TAG_TRANSLATION_LOCALES`，独立域不动）、`api/admin/blog/drama-search/route.ts`、`lib/blog-seo.ts`、`lib/faq/**`、`lib/seo-utils.ts:132`（海阅 `seo-utils.ts` 现直接读静态层 `SITE_LOCALES`；`listPublishableLocales()` 已随 P4 删除发布白名单层撤销，见清单③）、`lib/site-search/site-search-service.ts`。

**清单③：海阅待删白名单层（`PUBLISHABLE_LOCALES`/`listPublishableLocales`/`isPublishableLocale`/`pickPublishableLocale`/`ARTICLE_TEMPLATE_CRUD_LANDED`）全部消费点**
——`grep -rn "PUBLISHABLE_LOCALES\|listPublishableLocales\|isPublishableLocale\|pickPublishableLocale\|ARTICLE_TEMPLATE_CRUD_LANDED" src worker scripts tests`：

真实运行时调用点（非注释/非纯文档）：

| 文件:行 | 符号 | 改向 |
| --- | --- | --- |
| `src/proxy.ts:155` | `pickPublishableLocale(firstPathSegment)` | 改 `SITE_LOCALES` 成员判定（静态层） |
| `src/app/layout.tsx:54` | `pickPublishableLocale(header)` | 改读请求 locale（`x-novel-locale`，`SITE_LOCALES` 校验，静态层） |
| `src/app/[locale]/_guard.ts:66` | `isPublishableLocale(locale)` | 删（保留 `SITE_LOCALES` 成员判定 + 默认语种排除两道，静态层） |
| `src/app/(admin)/articles/new-blog/_components/blog-create-form.tsx:50` | `listPublishableLocales()` | 改 `SITE_LOCALES`（对齐 CPS `BLOG_ARTICLE_LOCALE_OPTIONS`，静态层） |
| `src/features/public-ui/layout/LocaleSwitcher.tsx:128` | `listPublishableLocales()` | 改由服务端传入 `activeLocales` prop（动态层） |
| `src/server/content-creation/blog.ts:111` | `isPublishableLocale(value)` | 改 `SITE_LOCALES` 成员判定（静态层，对齐 CPS `requireLocale` 用 `isSupportedSiteLocale`） |
| `src/lib/site/request-locale.ts:39-44` | `pickPublishableLocale` 定义（内部调 `isPublishableLocale`） | 改为 `SITE_LOCALES` 成员判定，函数改名去 `Publishable` 措辞 |
| `src/lib/seo/seo-utils.ts:133` | `listPublishableLocales()` | 改 `SITE_LOCALES`（`buildHreflangAlternates` 的枚举范围，对齐清单②未搬项——`seo-utils.ts` 是 hreflang 的"无过滤盲枚举"分支，不是 `novel-hreflang.ts` 的"过滤 sibling"分支，语义上更贴近 CPS 静态 `locales` 枚举） |
| `src/lib/seo/novel-hreflang.ts:113` | `listPublishableLocales()` | 改 `SITE_LOCALES`（静态层，可见性谓词 `isVisibleSibling` 不动） |
| `src/lib/seo/static-sitemap-generator.ts:190` | `listPublishableLocales()` | 改 `SITE_LOCALES`（静态层，对齐 CPS `locales` 默认） |
| `src/lib/seo/sitemap.ts:426` | `listPublishableLocales().includes(...)` | 改 `SITE_LOCALES.includes(...)`（`parseSitemapFileName` 的文件名合法性判定，静态层） |
| `src/lib/indexnow/eligibility.ts:180,233` | `isPublishableLocale` 缺省 `localeGate` | 改 `isRegisteredSiteLocale`（已有的 `SITE_LOCALES` 成员判定，对齐 CPS `isSupportedSiteLocale`） |
| `src/lib/locale/locale-canonical.ts` | `PUBLISHABLE_LOCALES`/`isPublishableLocale`/`listPublishableLocales`/`ARTICLE_TEMPLATE_CRUD_LANDED`/`assertPublishableLocalesFailClosed` 定义本身 | 删除（§2.A） |

9 个测试文件的死 mock（覆盖 `isPublishableLocale`/`listPublishableLocales`，导出消失后 `importOriginal` 展开会 TS 报错）：
`tests/backend/publish-gate/{admin-wrappers,invalidation-wiring,service,db-retry-wiring,c27-article-type-fork}.test.ts`、
`tests/backend/seo/{novel-hreflang,sitemap-multi-locale}.test.ts`、
`tests/ui/locale-switcher-multi-locale.test.tsx`、
`tests/integration/p2-12-vertical-acceptance.test.ts`——逐一删 mock 键或改指向新接口，见 §改动清单。

**清单④：`PUBLIC_SITE_LOCALE` 消费点分类**
——`grep -rn "PUBLIC_SITE_LOCALE" src`（76 处非注释代码引用，import 语句与实际使用各算一处）：

| 分类 | 文件 | 结论 |
| --- | --- | --- |
| **默认语种常量（保留）** | `src/app/page.tsx`、`src/app/category/[slug]/page.tsx`、`src/app/blog/page.tsx`、`src/app/blog/[slug]/page.tsx`、`src/app/novel/[slugParam]/page.tsx`、`src/app/novel/[slugParam]/not-found.tsx`、`src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx`、`src/app/browse/page.tsx` | 这些是**裸路径路由树**（D-8 定案：默认语种在无前缀路径落地），`PUBLIC_SITE_LOCALE` 在这里不是"唯一语种假设"的 bug，是路由结构本身——裸路径树与 `[locale]` 前缀树是两棵并行路由树，各自服务固定的语种范围，不因本轮 guard 放开前缀树而改变 |
| **默认语种常量（保留，dev-only）** | `src/app/dev-preview/**/*`、`src/features/public-ui/fixtures/mock-chrome.ts` | 开发预览路由，非生产可达路径，`mockChrome` 本身注释明示"语言入口只在确实存在多个可发布语种时才传入"——本轮验证单语种隐藏态的既有测试夹具 |
| **默认语种常量（保留，根树/裸路径 404·error 边界，404 边界零 props，`headers()` 可用但结构性不读）** | `src/features/public-ui/status/PublicErrorStatus.tsx`、`src/features/public-ui/status/PublicNotFoundStatus.tsx` | 分类理由订正（review fix n4，2026-09-10）：原表述"无请求上下文"不准确——`src/app/not-found.tsx`（根 404 边界）是 Server Component，`headers()` 技术上是可读的（跟 `src/app/[locale]/novel/[slugParam]/not-found.tsx` 的 B-1 修复一样可以读 `x-novel-locale`）；`src/app/error.tsx` 是 `"use client"`，才是真正读不到 `headers()` 的一侧。两者共同的真实理由是**结构性**的，不是技术限制：这两个文件是根/裸路径树自己的 404/error 边界（不在 `[locale]` 前缀树下），裸路径树按 D-8 定案本就只服务默认语种，`PUBLIC_SITE_LOCALE` 在这里与该文件所在路由树的语种范围一致，不是遗漏——跟 B-1 修的 `[locale]` 子树 not-found（该文件确实需要显示请求方语种，因为它住在会路由到任意 `SITE_LOCALES` 成员的前缀树下）是两种不同处境，不能同法处理 |
| **默认语种常量（保留）** | `src/lib/site/blog-queries.ts:109`（`asSiteLocale(row.locale) ?? PUBLIC_SITE_LOCALE` 兜底）、`src/lib/locale/messages/index.ts:172`（`en` 消息目录短路判定） | 本就是"哪个 locale 缺失就兜底默认语种"的语义，不是遗漏 |
| **唯一语种假设（改读请求 locale）** | `src/app/layout.tsx:17,51,56` | 根布局 `<html lang dir>` 与顶层 `<title>` 兜底文案——之前恒定 `PUBLIC_SITE_LOCALE`，因为 `pickPublishableLocale` 白名单只放行 `en`；白名单删除后必须真正读 `x-novel-locale` 请求头（§2.E，已在清单③单独登记，已修） |
| **唯一语种假设（改读请求 locale，review fix B-1 已修，2026-09-10）** | `src/app/[locale]/novel/[slugParam]/not-found.tsx` | 这份文件住在 **`[locale]` 前缀树**（不是裸路径树），Next 16.1.6 以零 props 渲染 `not-found.tsx` 边界（该文件自己的头注释已实测确认，见 `create-component-tree.js`），拿不到路由的 `locale` 参数，此前只能跟裸路径 shell 一样调用 `NovelNotFoundBody({ locale: PUBLIC_SITE_LOCALE })`。P4 首轮之前这条子树整体不可达（旧 guard 恒 404），这个"假装是 en"的缺口无副作用；guard 改为"注册即路由"后，`/ru/novel/...` 这类路径下命中 not-found 边界会真的执行到这份文件，应显示 `ru` 却显示 `en`——是 P4 首轮 guard 改动新暴露的真实唯一语种假设。Opus 复核标为 BLOCKING（B-1），已修：跟 `app/layout.tsx` 同法，读 `headers().get(SITE_LOCALE_REQUEST_HEADER)` → `pickSiteLocale(...)`，try/catch 兜底 `PUBLIC_SITE_LOCALE`；全仓核查确认 `[locale]` 子树下不存在第二个同形文件（`error.tsx`/`not-found.tsx`），无需扩大修法范围 |
| **唯一语种假设（改读请求 locale）** | `src/proxy.ts:80`（`buildDefaultLocaleRedirectTarget` 的 `/en/*` → 裸路径前缀） | 不是 bug——这个用法是"默认语种是谁"这一个静态问题，`/en/*` 规整不因协商或白名单删除而变化，保留 `PUBLIC_SITE_LOCALE` 引用不动 |
| **唯一语种假设（改读请求 locale）** | `src/app/[locale]/_guard.ts:65`（`locale === PUBLIC_SITE_LOCALE` 排除默认语种前缀） | 同上，D-8 结构性判定，不是遗漏，保留不动 |
| **已修复（review fix n3 函数级 2026-09-10 + 调用点 L10N P4.1 `b5de04b` 2026-09-11）** | `src/server/publication/revalidate.ts` `revalidatePublicBlogPaths` | 原表述"博客当前仍是单语种产出面"已失实——`blog-create-form.tsx`/`content-creation/blog.ts`'s `requireLocale` 已开放全部 `SITE_LOCALES`。函数本身已改为按调用方传入的 `locale` 构造路径（`buildBlogPath({ locale: input.locale ?? PUBLIC_SITE_LOCALE, ... })`），非 `en` 路径的失效函数级别早已正确。唯一生产调用点 `publish-gate/service.ts:507` 当时仍在 P4 **禁改区**内、传不了 `locale`——L10N P4.1（`b5de04b`，该行已退出禁改区后收尾）补上了这一行，现在是 `revalidatePublicBlogPaths({ slug: txResult.slug, locale: txResult.locale as SiteLocale })`；`tests/backend/publish-gate/invalidation-wiring.test.ts` 用 `en`/`ru` 两个夹具断言这条调用真的带上了 locale。`locale` 参数本身仍保留可选（`?? PUBLIC_SITE_LOCALE` 兜底）——不再是"唯一调用点还没传"的遗留缺口，而是给"确实没有 locale 可给"的调用方留的文档化行为，`revalidate.test.ts` 的"falls back to en when locale is omitted"用例现在验的是这条兜底本身，不是生产路径的当前状态 |

结论：76 处非注释引用（import 语句与实际使用各算一处）中，
`src/app/layout.tsx` 一处、`src/app/[locale]/novel/[slugParam]/not-found.tsx`
一处属于"唯一语种假设"，均已修复（后者是 review fix B-1，本轮新修）；
`revalidatePublicBlogPaths` 一处函数级别与其唯一调用点均已修复（review fix n3 +
L10N P4.1 `b5de04b`），实际生效行为已随之改变（非 `en` 博客发布现在正确失效
`/{locale}/blog/{slug}`，不再落到 `en` 默认路径）；其余全部是裸路径路由树/
默认值兜底/开发预览等结构性用法，本身正确，不是遗漏。

#### §2 范围改动清单（文件 → CPS 参照）

| 海阅文件 | CPS 参照 | 改动 |
| --- | --- | --- |
| `src/lib/locale/locale-canonical.ts` | 不适用（删除） | 删 `PUBLISHABLE_LOCALES`/`isPublishableLocale`/`listPublishableLocales`/`ARTICLE_TEMPLATE_CRUD_LANDED`/`assertPublishableLocalesFailClosed`，`SITE_LOCALES`/`SITE_LOCALE_LABELS`/`SITE_LOCALE_NATIVE_NAMES`/`resolveSiteLocale`/`TAG_TRANSLATION_LOCALES` 三元组不动 |
| `src/lib/locale/active-locales.ts`（新增） | `3a76877:src/lib/active-locales.ts:12-41` | `ADAPT`：`Drama.groupBy({status:"active"})` 换成 `Article.groupBy({by:["locale"]})` + 本仓公开可见谓词族（`buildPublicArticleWhere` 复用自 `sitemap.ts`），`en` 恒含、按 `SITE_LOCALES` 顺序返回、`unstable_cache` 300s tag `active-locales` |
| `src/lib/site/chrome.ts` + `src/lib/site/queries.ts`（`loadPublicChrome`） | 不适用（本仓新设计的传递路径） | `SiteChrome` 新增可选字段 `activeLocales`。实码口径订正（review fix n4，2026-09-10）：不是 `loadPublicChrome` 自己并行拉取——`getActiveLocales()` 由 `src/app/_lib/public-load.ts` 新增的 `loadActiveLocales`（`React.cache()` 包一层 `getActiveLocales()`）承担，调用方是每个 `_pages/*.tsx` 页面体，先 `await loadActiveLocales()` 再作为第 4 个参数传给 `loadChrome(locale, current?, categories?, activeLocales?)`，`loadChrome` 再原样转发给 `loadPublicChrome(prisma, locale, current, categories, activeLocales)`——`loadPublicChrome` 自身不发起这次查询，只接收已取好的结果。8 个 `_pages/*.tsx` 页面体已经把 `chrome` 原样传给 `SiteShell`，借这条既有管道，不新增 prop 穿透 |
| `src/features/public-ui/layout/SiteShell.tsx`/`SiteHeader.tsx`/`LocaleSwitcher.tsx` | `3a76877:src/components/site/site-header.tsx`、`locale-switcher.tsx` | `LocaleSwitcher` 从内部调 `listPublishableLocales()` 改为接收 `activeLocales` prop（海阅 `SiteHeader`/`LocaleSwitcher` 是 `"use client"`，`ChapterScreen.tsx` 直接静态导入 `SiteShell`——`getActiveLocales()` 不能像 CPS 那样放进 `SiteHeader` 内部 await，否则把 `prisma`/`unstable_cache` 拖进客户端包，必须走 prop 传递） |
| `src/server/publication/revalidate.ts` | 不适用（本仓既有机制） | `revalidatePublicListings()`（发布状态迁移的既有唯一广播点）追加 `revalidateTag("active-locales")`，`safeRevalidateTag` 包一层同 `safeRevalidatePath` 的 try/catch 纪律 |
| `src/proxy.ts` | `3a76877:src/i18n/routing.ts:6-25`、`src/i18n/root-negotiation.ts`、`src/proxy.ts:287` | 路径段解析改 `SITE_LOCALES` 成员判定；新增根路径协商调用（仅 admin-host 判定放行后、`/en/*` 规整之后、header 转发之前，且只对公开主机生效） |
| `src/lib/locale/root-negotiation.ts`（新增） | `3a76877:src/i18n/root-negotiation.ts:1-41` | `COPY`：`match`/`parseAcceptLanguage`/bot UA 排除/cookie 优先/307 + Set-Cookie，`isSupportedLocale`→`SITE_LOCALES` 成员判定，`routing.defaultLocale`→`PUBLIC_SITE_LOCALE`，cookie `maxAge/path/sameSite` 逐字同 `3a76877:src/i18n/routing.ts:6-25` |
| `src/lib/site/request-locale.ts` | 不适用（本仓已有文件的改造） | `pickPublishableLocale` 改名 `pickSiteLocale`，内部改 `SITE_LOCALES` 成员判定；`SITE_LOCALE_REQUEST_HEADER` 不动 |
| `src/app/[locale]/_guard.ts` | `3a76877:src/app/[locale]/(site)/layout.tsx:43-48` | `getRoutableLocale` 删 `isPublishableLocale` 门，保留 `SITE_LOCALES` 成员判定 + 默认语种排除两道 |
| `src/app/layout.tsx` | 同上 request-locale 改造 | `lang`/`dir`/`getPublicT` 改读 `pickSiteLocale(header)` 而非固定 `PUBLIC_SITE_LOCALE` |
| `src/lib/seo/sitemap.ts` | `3a76877:src/lib/static-sitemap-generator.ts:190` | `parseSitemapFileName` 的合法性判定改 `SITE_LOCALES` |
| `src/lib/seo/static-sitemap-generator.ts` | 同上 | `routeLocales` 默认改 `SITE_LOCALES` |
| `src/lib/seo/seo-utils.ts` | `3a76877:src/lib/seo-utils.ts:132` | `buildHreflangAlternates` 枚举范围改 `SITE_LOCALES` |
| `src/lib/seo/novel-hreflang.ts` | `3a76877:src/lib/drama-hreflang.ts:17-31` | `loadNovelHreflangSiblings` 的 `locale: {in: ...}` 改 `SITE_LOCALES`，`isVisibleSibling` 可见性谓词不动 |
| `src/lib/indexnow/eligibility.ts` | `3a76877:src/lib/indexnow-outbox.ts:70-82` | `isNovelIndexNowEligible`/`isBlogIndexNowEligible` 的缺省 `localeGate` 改 `isRegisteredSiteLocale`（已有符号，本轮只切换默认引用） |
| `src/app/(admin)/articles/new-blog/_components/blog-create-form.tsx` | `3a76877:src/lib/supported-site-locales.ts:21`（`BLOG_ARTICLE_LOCALE_OPTIONS`） | 语种下拉改 `SITE_LOCALES` |
| `src/server/content-creation/blog.ts` | 同上 | `requireLocale` 改 `SITE_LOCALES` 成员判定 |
| `src/lib/slug/text-to-slug.ts` | 不适用（注释修正） | §5：删除失实的"本轮无非 en 调用方"表述，改为 P2 之后来源事实可以是任意 `SITE_LOCALES` 成员，`latin-word-segmentation` 占位规则现实可达 |
| `package.json` | 不适用 | 新增 `@formatjs/intl-localematcher`，精确版本钉死 |

#### §2.G nginx 对读结论（review fix n4，2026-09-10 补）

施工提示词 §2.G 要求对读 `3a76877:nginx/cps-admin.conf` 与海阅
`infra/production-like/nginx/full.conf.template` 关于 `/` 与 `Set-Cookie` 的
缓存行为，差异写进本节；已核对：**无差异，无需改模板**。

海阅 `infra/production-like/nginx/full.conf.template` 全文没有任何
`proxy_cache`/`proxy_cache_path` 指令（`grep -n "proxy_cache"` 零命中）。
公开 server 块的根路径落在 `location /`（`full.conf.template:141-144`），
配置只有 `include .../snippets/proxy-headers.conf; proxy_pass
http://app_backend;`，不带任何缓存层；同目录 `capacity-locations.conf`
snippet 里的三条 location（`^~ /novel/`、`^~ /go/`、`= /browse`）都不匹配
`/` 本身，根路径协商（`negotiateRootLocale`，本轮矩阵 #9/§2.D）落地后的
`307 + Set-Cookie` 响应因此直接透传到客户端，没有 nginx 层缓存会把这个
per-request 协商结果错误地缓存/复用给下一个访客的风险。CPS 冻结 tag
`nginx/cps-admin.conf` 本身在这份对读之前就已经在
`docs/governance/port-registry.md` 早前条目里记录过"未搬短剧主页面 proxy
cache"（见上文 "CPS nginx 安全头、gzip、静态缓存..." 一行）——两边独立确认
都不给根路径挂缓存，结论一致，不存在需要协调的差异。

#### 未搬项说明（明确记录，避免被误判为漏登）

`seo-utils.ts` 的 `buildHreflangAlternates`（"无过滤盲枚举"分支）与
`novel-hreflang.ts` 的 `loadNovelHreflangSiblings`（"按 Novel 过滤 sibling"
分支）本轮都从 `listPublishableLocales()` 改 `SITE_LOCALES`，但对应不同的
CPS 参照文件（前者对应 `lib/seo-utils.ts` 的静态 `SUPPORTED_SITE_LOCALES`
枚举，后者对应 `lib/drama-hreflang.ts` 的静态 `locales` sibling 查询范围）
——两者语义不同，登记为两条独立改动，不合并。

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
