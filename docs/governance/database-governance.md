# PostgreSQL 数据库治理与物理设计

**Owner：Codex**

**任务：P1-05B / P1-06 / P1-08 CPS parity**

**状态：P1-05B VALIDATED；P1-06 IMPLEMENTED，待本报告记录恢复演练证据**

**数据库目标：PostgreSQL 16**

本文件是人类可读的数据库治理基线；机器可读基线为
`docs/governance/database-schema-dictionary.jsonl`。P1-05B 的可执行初始基线为
`prisma/migrations/20260803090000_p1_initial_schema/migration.sql`；后续决策只允许通过增量
Migration 演进，当前 Credential 状态增量为
`20260804090000_p1_08_credential_status_parity`。

## 1. 权威与边界

冲突裁决顺序：Notion P1 正式台账 → Owner 六项修正 → 正式实施分工 → candidate-v0.2.1 → P1 shared contracts → CPS parity matrix → CPS 只读证据。

数据库落地后的运行真源优先级：**已执行 Migration > 当前 Schema/SQL > 本治理文档 > JSONL 数据字典 > Notion 治理镜像**。

- 新项目与 CPS 零共享；CPS 只作只读证据。
- 涉及 CPS 同类模块的数据字典、状态词表、字段语义、状态转换、错误码或安全边界冻结前，
  必须完成 CPS 只读 parity 调研。CPS 是强制参考证据，不是高于小说冻结架构的权威源。
- 偏离 CPS 时，必须在 JSONL evidence 或本治理文档登记 CPS 行为、小说行为、偏离原因和
  Owner 决策；不得用普通 parity 备注掩盖架构偏离。
- P1-05B 只使用一次性 PostgreSQL 16 验证实例，不创建正式数据库。
- P1-06 落地数据库角色、GRANT/REVOKE、备份与恢复。
- P1-07 实现 claim、heartbeat、fencing、Worker 与 Scheduler 运行时。
- P1-08 实现 Auth、Credential 加解密和后台 API。
- 未证外部合同只登记 `registered_disabled`，不保存猜测的 Endpoint 或 Body。

## 2. 统一物理约定

| 项 | 决策 |
| --- | --- |
| 命名 | PostgreSQL 表/列/约束/索引使用 `snake_case`；Prisma 通过 `@map`/`@@map` 映射 |
| 主键 | 领域、配置、任务表使用 `uuid`；高频追加日志使用 `bigint identity` |
| 时间 | 全部业务时间使用 `timestamptz(6)`；日期使用 `date` |
| 状态 | Prisma 使用 String；正式 Migration 必须为每个状态列追加命名 CHECK |
| JSON | 上游快照、版本化参数/结果、脱敏审计详情使用 `jsonb`；可筛选、约束或关联字段必须列化 |
| 软删除 | 核心可变实体使用 `deleted_at`；默认查询排除非空值 |
| 删除 | 注册/身份实体默认 RESTRICT；纯从属 Item/Content/Attempt 使用 CASCADE；可解除映射使用 SET NULL |
| 敏感级别 | S0 公开；S1 内部；S2 受限；S3 凭证密文 |
| 时间真源 | due、lease expiry、misfire 判断只使用 PostgreSQL 时钟；应用时钟只用于展示 |

## 3. 实体目录、字段责任与 CPS 分类

### 3.1 渠道、账户与凭证

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `channel` | CPS_PARITY | 渠道注册身份、名称、状态 | `code` 全局唯一；状态 CHECK | 渠道专用业务字段 |
| `source_app` | CPS_PARITY | 来源应用/书城注册 | `code` 全局唯一；状态 CHECK | CPS 剧场语义 |
| `channel_app` | CPS_PARITY_ADAPTED | 渠道×来源应用绑定；`project_type` 参数化 | 绑定三元唯一；project_type 正数 | 模块级 `projectType=2` |
| `channel_capability` | CPS_PARITY_ADAPTED | 能力、证据、禁用原因、QPS/超时 | `(channel_app_id, capability_key)` 唯一 | 猜测的 Endpoint/Body |
| `channel_account` | CPS_PARITY | Day 0 多账户身份与运维状态 | `business_id` 全局唯一；不得建 Channel 1:1 Account | 单账户 Schema 假设 |
| `channel_account_credential` | CPS_PARITY_ADAPTED | 加密凭证、key version、指纹元数据 | 每账户/类型单 active 部分唯一 | 明文、env fallback、conflict 三轨 |
| `channel_credential_active_fingerprint` | CPS_PARITY（模式） | 活跃凭证指纹占位 | fingerprint、credential_id 分别唯一 | 应用层先查后写 |
| `credential_change_log` | CPS_PARITY_ADAPTED | 凭证安全变更事件，不含 secret | append-only；账户/时间索引 | legacy credential log |

#### P1-08 CPS parity 与显式偏离登记

| ID | 分类 | CPS 行为 | 小说行为 | 偏离原因 | Owner 决策 |
| --- | --- | --- | --- | --- | --- |
| `P1-08-CRED-STATUS` | `CPS_PARITY_WITH_DEFECT_FIX` | Credential 使用 `active/superseded/expired/invalid`；validate 未过滤 status，可将 superseded 复活 | 使用同一四态；validate 只接受 active/expired/invalid，superseded 不可恢复 | 修复 CPS 已证实的复活缺陷；disabled 只属于 Account；删除小说原 revoked | `O1=ADOPT_CPS_CREDENTIAL_STATUS_WITH_DEFECT_FIX` |
| `P1-08-CHALLENGE-SESSION` | `CPS_HAS_NO_EQUIVALENT` | 登录前 challenge 绑定 user + cookie，无数据库 Session | challenge 必须绑定当前数据库 Session | 小说采用长生命周期 DB Session + step-up 2FA，模型不同 | `CHALLENGE_SESSION_BINDING=REQUIRED` |
| `P1-08-PERSISTED-SECRET-READ` | `CPS_PARITY_ADAPTED` | Web 接收明文、加密入库，也可读取并解密持久化 Credential | Web 请求内接收并加密新 JWT，只获密文 INSERT、无密文 SELECT/历史解密；Worker 独占持久化密文读取/解密；Scheduler 无密钥 | 避免 sealed intake 额外表、密钥对、TTL/消费状态机，同时以列级权限缩小 Web 暴露面 | `P1_08B_WEB_SYNCHRONOUS_INGRESS_APPROVED`；`WORKER_ONLY_PERSISTED_SECRET_READ_AND_DECRYPT` |
| `P1-08-ASYNC-VALIDATION` | **`EXPLICIT_DIVERGENCE / CPS_HAS_NO_EQUIVALENT`** | Credential validation 同步、本地执行，无 taskId | add/replace 同步完成并返回 metadata；显式 validate/supersede 仍通过任务入队并返回稳定 taskId 与 mutation request id | 保留 P1-07 fencing、重试和可恢复执行语义，且 Web 不读取持久化密文 | P1-08B add/replace 同步 Gate 已关闭；validate/supersede Worker 链保持 |

`P1-08-ASYNC-VALIDATION` 是显式 divergence record，不得降级为普通 parity 备注或在后续
字典生成中丢失。

### 3.2 Novel、章节与标签

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `novel` | CPS_PARITY_ADAPTED | 站内作品身份与发布状态；canonical 字段普通同步只补空 | `business_id` 全局唯一；活跃 locale+slug 部分唯一；locale 必须是站点 canonical locale | 视频、剧集资源字段 |
| `novel_source_item` | CPS_PARITY_ADAPTED | 上游书目行的忠实镜像；未知语种保留原值且 mapped locale 可空 | app+book+language 唯一；novel 可空；unknown 不创建或发布 Novel | 跨语言自动合并、数据库第二套 locale 映射 |
| `novel_chapter_source_item` | ORIGINAL_REQUIRED | `chapterList[]` 元素镜像，不含正文 | source item+external chapter 唯一 | `consecutive_miss_count` |
| `novel_chapter` | ORIGINAL_REQUIRED | 站内章号、标题和展示状态 | 活跃 novel+chapter number 部分唯一 | 用 `allEpis` 生成章节占位 |
| `novel_chapter_content` | ORIGINAL_REQUIRED | 正文、字符数、SHA-256、物化来源 | chapter 1:1；字符数非负 | 正文进入 JSON、日志或审计 |
| `novel_preview_policy` | ORIGINAL_REQUIRED | 物化策略、安全上限、单本展示/索引/缓存授权 | novel 1:1；计数非负 | paid_from_chapter 触发删除 |
| `source_label` | ORIGINAL_REQUIRED | 未解释的上游原始标签字典 | app+kind+value 唯一 | V1 canonical tag |
| `novel_source_item_label` | ORIGINAL_REQUIRED | 来源条目标签出现历史与 active 状态 | source item+label 唯一 | recommend 直接成为 SEO 分类 |

### 3.3 推广、发布与流量

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `promo_link` | CPS_PARITY_ADAPTED | 上游真实推广资产、所属 Novel 和我方永久公开码 | idempotency key 唯一；public code 全局非部分 UNIQUE；`(id, novel_id)` 复合唯一 | 上游码用于公开 URL |
| `tracking_event` | CPS_PARITY_ADAPTED | 公开码点击/页面事件；只存盐哈希 | 时间查询索引；原始事件 90 天 | 每事件同步写、IP/UA 原值 |
| `article_template` | CPS_PARITY_ADAPTED | 模板版本与 SEO 模板 | template key+version 唯一 | 作者/国家/完结模板变量 |
| `article` | CPS_PARITY_ADAPTED | Novel 的 locale 页面快照、模板渲染 SEO 正文、页面身份和确定 PromoLink | novel+locale 唯一；复合 FK 保证 Article 与 PromoLink 属于同一 Novel；published 行内 CHECK | 换租客、评论生成、跨 Novel hreflang、渠道版权试读正文 |

### 3.4 任务、外部副作用与调度

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `catalog_scan_task` / `_item` | ORIGINAL_REQUIRED | 页区间目录扫描及租约 | account+app+project_type 单 active；item fencing | SQLite 伪写锁 |
| `channel_sync_task` / `_item` | CPS_PARITY_ADAPTED | 已有 SourceItem 的定向作业 | 规范化 scope 单 active；item 指向 SourceItem | item 指向 Novel |
| `generic_task` / `_item` | CPS_PARITY_ADAPTED | 非渠道批量任务与多态目标 | 规范化 scope 单 active；target 二元唯一 | `drama_id` 非空固定目标 |
| `side_effect_intent` | ORIGINAL_REQUIRED | 外部调用前永久 effect key 和独立已提交意图 | `effect_key` 永久唯一；operation+idempotency 唯一 | 与业务写同一未提交事务 |
| `operation_audit` | ORIGINAL_REQUIRED | 本地业务变更审计 | append-only；与业务写同事务 | 业务提交后补写 |
| `schedule_run` | ORIGINAL_REQUIRED | 确定 scheduled instant、revision、DST/misfire 语义 | schedule+scheduled_for 唯一；manual trigger 独立唯一 | `globalThis` 去重 |
| `cron_run` | ORIGINAL_REQUIRED | 一次 Scheduler enqueue 结果及唯一 Task 关联 | schedule_run、generic_task 分别 1:1 | Scheduler 持有凭证 |

### 3.5 Outbox 与首页轮播

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `indexnow_outbox` | CPS_PARITY_ADAPTED | URL revision 的异步投递状态 | `(url, revision)` 唯一；七态 CHECK | 请求路径同步推送 |
| `indexnow_outbox_attempt` | CPS_PARITY_ADAPTED | 每次投递尝试 | outbox+attempt_no 唯一；append-only | attempt JSON 数组作为真源 |
| `home_carousel_manual_slot` | CPS_PARITY_ADAPTED | locale 人工位置 | enabled active 部分唯一 | drama_id、SQLite boolean/int |
| `home_carousel_auto_batch` | CPS_PARITY_ADAPTED | 自动计算批次 | unique_key 唯一；状态 CHECK | Web 内 cron |
| `home_carousel_auto_candidate` | CPS_PARITY_ADAPTED | 排名、分数与解释 | batch+locale+rank、batch+novel 唯一 | Float 排名金额式精度 |
| `home_carousel_serving` | CPS_PARITY_ADAPTED | 只保存当前正在服务的结果，不承担历史区间 | `(locale, position)` 绝对唯一；无 `valid_from/valid_to` | 在 serving 表内保存历史有效期 |
| `home_carousel_change_log` | CPS_PARITY | 轮播历史变更与来源追溯的追加日志 | append-only | CPS drama 专用引用 |

## 4. 状态 CHECK 真源

正式 CHECK 值必须与 `src/domain/database-statuses.ts` 一致：

- Channel：`active | inactive | registered_disabled`
- Account：`active | disabled`
- Capability：`enabled | registered_disabled | registered_partial`
- Credential：`active | superseded | expired | invalid`
- Novel：`draft | ready | published | unpublished | takedown`
- SourceItem：`pending | linked | ignored | stale`
- Chapter：`preview | locked | stale | withdrawn`
- ChapterSourceItem：`pending | materialized | failed`
- PromoLink：`pending | fetched | failed | registered_disabled`
- Task：`pending | processing | completed | completed_with_errors | failed | disabled`
- Catalog Item：`pending | processing | success | failed`
- Other Item：`pending | processing | success | skipped | failed`
- SideEffectIntent：`prepared | confirmed | failed | claim_retry_blocked | manual_review_required`
- IndexNow：`pending | processing | accepted | retry_wait | permanent_failed | dead_letter | cancelled`
- Article：`draft | published | unpublished | takedown`
- ScheduleRun：`due | enqueued | misfired | skipped | failed`
- CronRun：`created | task_created | failed`
- Carousel batch：`pending | processing | completed | failed`

其他受限枚举同样进入 CHECK：task mode `dry_run | apply`、PromoLink origin
`upstream_existing | claimed`、label kind、IndexNow attempt state、ScheduleRun trigger kind、misfire policy、preview materialization policy 和 carousel serving source。

逐值业务语义以 `src/domain/database-statuses.ts` 的 `DATABASE_STATUS_SEMANTICS` 和 JSONL 字典为机器真源。特别冻结：

- Novel/Article `draft`、Novel `ready` 对公众为 404；`published` 才进入公开读取。
- `unpublished` 保留稳定下架页并退出索引，内容继续保留；`takedown` 是版权或安全移除，公开路由返回 **HTTP 410 Gone**，两者不得合并。
- Chapter `preview` 可展示和索引，`locked` 在 V1 不物化；可信且结构完整、非空的响应中缺席才进入 `stale`，立即停展并退出 sitemap，但正文保留。
- 失败、结构异常或异常空列表等不可信响应不改变章节状态；`stale` 章节可信重现后自动恢复 `preview`。
- `withdrawn` 是人工/版权撤回并返回 404，是唯一会通过版权流程删除 `novel_chapter_content` 的章节状态。
- Credential、PromoLink、Task/Item、SideEffectIntent、IndexNow、ScheduleRun/CronRun 与 Carousel 的逐值术语不得退化为“实体当前状态”。

## 5. Migration-only 物理约束清单

以下对象由 `20260803090000_p1_initial_schema` 及后续具名增量 Migration 落地：

1. 所有状态、非负计数、正数页码/章号、时间窗顺序和 processing 租约完整性 CHECK。
2. `channel_account_credential(channel_account_id, credential_type) WHERE status='active'`。
3. `novel(locale, slug) WHERE deleted_at IS NULL`。
4. `novel_chapter(novel_id, canonical_chapter_number) WHERE deleted_at IS NULL`。
5. `article(locale, slug) WHERE deleted_at IS NULL`。
6. `catalog_scan_task(channel_account_id, channel_app_id, project_type) WHERE status IN ('pending','processing')`。
7. ChannelSync active scope 部分唯一；GenericTask 使用 PostgreSQL `NULLS NOT DISTINCT` 对 nullable account/app 建立 active 唯一，不使用 UUID sentinel 或 `COALESCE` 表达式。
8. 三类 Item 分别建立 pending claim 与 expired lease recovery 两套部分索引；查询不得使用 OR。
9. `home_carousel_manual_slot` 的 enabled+未软删 position/novel 两个部分唯一索引，PostgreSQL 谓词使用 `enabled IS TRUE`。
10. `promo_link.public_redirect_code` 使用全局非部分 UNIQUE、byte-wise/case-sensitive 语义和不可变 trigger；软删行继续占位。
11. published Article 的行内必要条件拆为四条命名 CHECK，禁止空字符串绕过：
    - `db:public:article:article_published_title_check`: `status <> 'published' OR btrim(title) <> ''`；
    - `db:public:article:article_published_slug_check`: `status <> 'published' OR btrim(slug) <> ''`；
    - `db:public:article:article_published_body_check`: `status <> 'published' OR btrim(body) <> ''`；
    - `db:public:article:article_published_promo_link_check`: `status <> 'published' OR promo_link_id IS NOT NULL`；
    - `db:public:article:article_published_published_at_check`: `status <> 'published' OR published_at IS NOT NULL`。
12. `promo_link` 提供 `db:public:promo_link:promo_link_id_novel_key` = `UNIQUE(id, novel_id)`；Article 以 `db:public:article:article_promo_link_novel_fkey` = `(promo_link_id, novel_id)` 复合 FK 引用该键，数据库保证所选 PromoLink 与 Article 属于同一 Novel。Prisma 和初始 Migration 均保留该具名复合 FK。
13. Article locale 与 Novel locale 一致仍由写事务和集成测试保证；数据库不建立第二套 locale 映射。
14. `operation_audit`、IndexNow attempt、credential/carousel log 禁止普通 UPDATE/DELETE；权限落地归 P1-06。
15. ScheduleRun scheduled/manual 互斥字段 CHECK；CronRun 与 GenericTask 在同一事务创建并一对一关联。
16. Item 结果提交必须在同一事务验证 `execution_token` 和 `lease_epoch`；旧租约为零行更新并回滚业务结果。
17. `20260804090000_p1_08_credential_status_parity` 将 Credential CHECK 增量替换为
    `active | superseded | expired | invalid`；如检测到 `revoked` 存量必须失败并要求人工处置，
    不得静默迁移到其他状态。

### P1-05B Migration 注意事项

- Article 进入 `published` 前必须在同一原子写入中设置 `published_at`；draft 及其他非 published 状态允许 `published_at IS NULL`。
- `Article(promo_link_id, novel_id)` → `PromoLink(id, novel_id)` 复合 FK 必须保持 PostgreSQL 默认 `MATCH SIMPLE`，禁止手写为 `MATCH FULL`。草稿 Article 合法允许 `promo_link_id = NULL` 且 `novel_id` 非空；`MATCH FULL` 会错误拒绝该合法记录。

## 6. 并发与事务不变量

- `db:public:novel:novel_canonical_fill_only_contract`：来源同步写 Novel canonical 字段时只允许把数据库当前空值补成来源值；`title`、`description`、`cover_url`、`slug`、`author` 等非空 canonical 值一律不覆盖。P1-07 必须用条件 UPDATE/同事务行锁实现，不采用“先读再无条件写”。
- 运营明确清空 canonical 字段后，是否重新从来源补值必须由显式运营操作携带授权；普通同步不得根据空值猜测授权。P1-05 不增加字段 provenance 表。
- SourceItem 可保留未知上游语种原值，`source_locale` 映射失败时为 `NULL`/unknown 语义；不得猜测、不得把上游原值直接写入 `Novel.locale`。无法映射时不创建或不发布 Novel，locale 映射唯一真源仍在应用层。
- Worker 是 at-least-once。claim 或过期回收每次易主都生成新 token 并令 epoch +1；heartbeat 不改变 epoch。
- pending claim 使用 `status='pending'` 专用查询；recovery 使用 `status='processing' AND locked_until < transaction_timestamp()` 专用查询。
- public code 和 credential fingerprint 的应用层预查只用于提示，正确性由数据库唯一约束保证。
- `side_effect_intent` 在外部调用前独立事务提交；未确认结果进入 `claim_retry_blocked`。
- `operation_audit` 和本地业务写同事务；不建立独立审计库。
- `(url, revision)` 是 IndexNow 唯一幂等身份。
- ScheduleRun 与 CronRun/Task 的 marker 和 enqueue 在同一事务完成，禁止“只有 marker 没有 task”。
- `home_carousel_serving` 每个 `(locale, position)` 只有当前一行；更新 serving 必须同步追加 `home_carousel_change_log`，历史不写回 serving。

## 7. 敏感字段与角色计划

| 数据 | 级别 | Web | Worker | Scheduler | Analyst |
| --- | --- | --- | --- | --- | --- |
| `encrypted_secret` | S3 | 仅可 INSERT 新密文；禁止 SELECT/解密已保存密文 | 最小范围可读并解密 | 禁止 | 禁止 |
| fingerprint prefix/expiry/status | S1 | 后台 `web_app`/admin 可读元数据 | 可读写 | 不读 | prefix/status 可读；不得反推出完整凭证 |
| upstream_code/web_url/raw source payload | S2 | 默认不直读；受控服务投影 | 业务需要可读 | 不读 | 脱敏投影 |
| chapter body | S2 版权内容 | 仅公开读模型读取 preview | 物化写 | 不读 | 禁止导出 |
| public code、published metadata | S0 | 可读 | 可读写 | 任务参数可引用 | 可读 |
| `article.body` | S0（published 时） | `web_app` 公开页面渲染可读 | 可生成/更新 | 不读 | 可读公开版本；不是章节版权正文 |

### P1-06 已实施权限矩阵

| 角色 | 对象所有权 / DDL | 读取 | 写入 | 额外限制 |
| --- | --- | --- | --- | --- |
| `migration_owner` | 唯一应用对象 Owner；执行 Migration | 全部 | 全部 | 不作为应用运行身份 |
| `web_app` | 无 | S0/S1 与公开章节正文；凭证仅元数据 | 后台元数据、任务入队、Audit 追加；同步 add/replace 可 INSERT 新密文及轮换元数据 | 禁止 SELECT/解密已保存 `encrypted_secret`、禁止读取完整 fingerprint、原始上游 payload/真实跳转信息 |
| `worker_app` | 无 | 完成任务与凭证处理所需全部列 | 业务/任务状态与追加日志；仅章节撤回正文允许 DELETE | `operation_audit` 等追加日志禁止 UPDATE/DELETE |
| `analyst_ro` | 无 | S0/S1 列 | 无 | `default_transaction_read_only=on`；`statement_timeout=30s`；禁止 S2/S3 |
| `backup_role` | 无 | 完整逻辑/物理备份所需全部表、序列 | 无 | `REPLICATION` 仅用于 `pg_basebackup`；凭证仅由备份系统托管 |
| `scheduler_app` | 无 | schedule/generic task 元数据 | 仅创建/更新 schedule 与 GenericTask 元数据 | 禁止 Auth/Credential secret；不导入 Worker handler registry；无 Credential key |

`infra/postgres/roles.sql` 不含密码；登录凭证由运行时 secret manager 或一次性测试脚本生成。
`infra/postgres/grants.sql` 必须在每次 Migration 后重放；未来对象默认关闭，新增表或敏感列必须显式评审后授予。
`PUBLIC` 没有 `public` schema 的 `CREATE`，运行角色没有数据库 `TEMPORARY` 或 schema `CREATE`。

P1-08B 新增独立 `scheduler_app`，只授予 schedule/generic task 元数据权限；它不获得任何凭证
解密密钥，不读取 Auth/Credential secret，也不执行 Credential handler。
完整逻辑备份要求 `backup_role` 能读取密文；在线读取能力不授予 Web、Analyst 或 Scheduler，
备份产物必须按最高敏感级别加密、隔离和审计。

## 8. 软删除与保留

- Novel、SourceItem、Account、PromoLink、Article、Template、ManualSlot 使用软删除。
- PromoLink 不允许硬删；公开码永久占位。
- 核心身份、业务审计、side-effect intent 长期保留。
- Task 头建议终态后 365 天、Item 180 天；TrackingEvent 90 天；IndexNow attempt、CronRun 180 天；carousel change log 365 天。
- P1-05B 不创建清理任务；保留期执行归 P1-07/P1-06 运维流程。
- `withdrawn` 章节保留元数据但删除 `novel_chapter_content`；`stale` 只停展，正文保留。
- `article.body` 是模板渲染后的 SEO 正文，随 Article 软删除和长期保留策略管理；章节 `withdrawn` 不得级联删除 Article body。公开版本可按 Article 导出策略导出，不能按章节版权正文策略处理。

## 9. JSONB 边界与版本

- 每个 JSONB payload 旁必须有明确 schema version，或由同表固定版本字段覆盖。
- JSONB 不得包含明文凭证、Cookie、完整 JWT、章节正文。
- Promo/Source raw payload 可能包含真实码或 URL，按 S2 处理，不进入审计和 Notion。
- Audit JSON 只能保存脱敏后的 before/after、request summary、response shape。

## 10. 数据字典一致性

- 每个 Prisma scalar 字段必须有 `db:public:{table}:{field}` 记录。
- 每张表和每个约束分别有 table/constraint stable_key。
- 920 条字典记录均为 `active`；数据库对象记录必须填写 `managed_by`、`physical_name` 和 `introduced_in_migration`。
- `managed_by` 只允许 `prisma_schema | migration_sql | application_contract`；应用事务合同不得冒充数据库对象。
- active 字典记录必须映射 Prisma、已应用 SQL Migration 或 `src/domain/database-invariants.ts` 中的应用事务不变量。
- 字段替代只允许 `deprecated/superseded`，旧记录不得删除。
- `scripts/check-database-dictionary-drift.mjs` 同时解析 Prisma Schema、JSONL 和迁移后的 `pg_catalog`，双向拒绝孤儿字段、幽灵字段和未登记数据库对象。
- 每个正式 Migration 必须回填 `introduced_in_migration`。
- Notion 只同步已确认的 business meaning、状态、敏感级别、角色、不变量和关键唯一/FK；索引物理名、opclass、执行计划、锁和 rollback SQL 只留本地。
- Notion 以 stable_key 幂等 upsert，禁止同一字段重复建记录。

## 11. Prisma 与依赖边界

- Prisma 管理普通列、关系、FK、普通 unique/index。
- CHECK、部分索引、不可变 trigger、表达式索引、append-only 权限和列级权限必须使用手写 Migration。
- 生产禁止 `prisma db push`。
- Prisma CLI 与 Client 均固定为 `6.19.2`，由 Claude dependency commit `db0d4cd1` 合入；P1-05B 未修改依赖文件。
- 原生 SQL 如返回 camelCase alias，必须双引号。

## 12. 变更日志

| 日期 | 任务 | 变更 | 执行者 | 状态 |
| --- | --- | --- | --- | --- |
| 2026-08-02 | P1-05A | 建立 37 表 Prisma 草案、状态真源、机器字典、约束与评审基线；未创建 Migration | Codex | 待 Claude 领域评审 |
| 2026-08-03 | P1-05A-REVISION | 修复 Claude 10 项领域评审：canonical 只补空、Article CHECK/复合 FK、serving 当前快照、locale、字典语义与 CPS pattern registry；仍未创建 Migration | Codex | 待 Claude 领域复评 |
| 2026-08-03 | P1-05B | 建立 37 表 PostgreSQL 初始 Migration，落地 66 个 CHECK、部分唯一/claim/recovery 索引与 2 个保护 trigger；在 PostgreSQL 16.14 完成空库、重放、零 drift 与真实正负测试 | Codex | 已验证 |
| 2026-08-03 | P1-06 | 建立五角色、列级敏感数据隔离、逻辑备份/一次性恢复脚本和物理 base backup/WAL/PITR 运行手册；生产 PITR 未在本轮宣称建立 | Codex | 逻辑恢复演练见 P1-06 报告 |
| 2026-08-04 | P1-08B | 增加六张 Auth 表、生产 PostgreSQL Store、独立 scheduler_app、Credential validate/supersede Worker 与脱敏查询；create/replace secret intake 保持 Gate | Codex | PostgreSQL 16.14 disposable verification PASS |
| 2026-08-04 | P1-08B | Owner 关闭 Secret Ingress Gate：Web 同步校验并加密新 JWT，只获密文 INSERT、无持久化密文 SELECT；add/replace 返回 metadata，validate/supersede 保持 Worker 异步 | Codex | `P1_08B_WEB_SYNCHRONOUS_INGRESS_APPROVED`；待 targeted review |
