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

- 🔴 **任何 DB 改动必须同步本文档**（词典段 + §12 改动日志），未同步的 Migration 视为不完整交付；与 CPS 同一纪律。
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
| `novel` | CPS_PARITY_ADAPTED | 站内作品身份与发布状态；canonical 字段普通同步只补空；C-30A 起另有 `title_normalized`（书名归一化形态，CPS `Drama.nameNormalized` 平移，NFKC+小写+去引号+标点转空格+压空白，`src/lib/novel/novel-identity.ts` 的 `normalizeNovelTitle`）供换小说批量二分图配对使用 | `business_id` 全局唯一；活跃 locale+slug 部分唯一；locale 必须是站点 canonical locale | 视频、剧集资源字段 |
| `novel_source_item` | CPS_PARITY_ADAPTED | 上游书目行的忠实镜像；未知语种保留原值且 mapped locale 可空 | app+book+language 唯一；novel 可空；unknown 不创建或发布 Novel | 跨语言自动合并、数据库第二套 locale 映射 |
| `novel_chapter_source_item` | ORIGINAL_REQUIRED | `chapterList[]` 元素镜像，不含正文 | source item+external chapter 唯一 | `consecutive_miss_count` |
| `novel_chapter` | ORIGINAL_REQUIRED | 站内章号、标题和展示状态 | 活跃 novel+chapter number 部分唯一 | 用 `allEpis` 生成章节占位 |
| `novel_chapter_content` | ORIGINAL_REQUIRED | 正文、字符数、SHA-256、物化来源 | chapter 1:1；字符数非负 | 正文进入 JSON、日志或审计 |
| `novel_preview_policy` | ORIGINAL_REQUIRED | 物化策略、安全上限、单本展示/索引/缓存授权 | novel 1:1；计数非负 | paid_from_chapter 触发删除 |
| `source_label` | ORIGINAL_REQUIRED | 未解释的上游原始标签字典 | app+kind+value 唯一 | V1 canonical tag |
| `novel_source_item_label` | ORIGINAL_REQUIRED | 来源条目标签出现历史与 active 状态 | source item+label 唯一 | recommend 直接成为 SEO 分类 |
| `article_novel_rebind_preview` | CPS_PARITY_ADAPTED | 换小说批量换绑（C-30，`article_drama_switch_preview` 平移）：有界扫描 + 二分图配对后的冻结预览快照，30 分钟有效期 | `expires_at` 索引供有界清理扫描回收；无 FK 约束业务列（见表说明） | — |
| `article_novel_rebind_batch` | CPS_PARITY_ADAPTED | 换小说批量换绑（`article_drama_switch_batch` 平移）：持久化批次头——提交幂等令牌、执行租约、五态计数、终态 | `id` 为可读批次编号非裸 UUID；`request_token` 全局唯一；`status` 五值 CHECK；`preview_id` FK → `article_novel_rebind_preview.id`（`ON DELETE RESTRICT`） | — |
| `article_novel_rebind_batch_item` | CPS_PARITY_ADAPTED | 换小说批量换绑（`article_drama_switch_batch_item` 平移）：批次内逐条文章的执行状态与前后 (novel_id, promo_link_id) 两字段快照——海阅特有的"两字段原子换绑"三元组翻倍（CPS 只有单字段 `drama_id` 三元组） | `(batch_id, article_id)` 唯一；`status` 五值 CHECK；`error_kind` 六值 CHECK（含 NULL）；`batch_id` FK → `article_novel_rebind_batch.id`（`ON DELETE CASCADE`）；`article_id`/`old_novel_id`/`old_promo_link_id`/`expected_new_novel_id`/`expected_new_promo_link_id`/`applied_new_novel_id`/`applied_new_promo_link_id`/`audit_id` 均为无 FK 的审计形状列（CPS 同构列同样无 FK） | — |

### 3.3 推广、发布与流量

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `promo_link` | CPS_PARITY_ADAPTED | 上游真实推广资产、所属 Novel 和我方永久公开码 | idempotency key 唯一；public code 全局非部分 UNIQUE；`(id, novel_id)` 复合唯一 | 上游码用于公开 URL |
| `tracking_event` | CPS_PARITY_ADAPTED | 公开码点击/页面事件；只存盐哈希 | 时间查询索引；原始事件 90 天 | 每事件同步写、IP/UA 原值 |
| `article_template` | CPS_PARITY_ADAPTED | 模板版本与 SEO 模板；P2-02B 补 template_name/applicable_article_type/content_template/slug_template/meta_keywords_template 五列，body_template 改由 content_template 编译得到 | template key+version 唯一；applicable_article_type 五值 CHECK | 作者/国家/完结模板变量；slug_template 只是候选字符串，不是最终 Article.slug |
| `article` | CPS_PARITY_ADAPTED | Novel 的 locale 页面快照、模板渲染 SEO 正文、页面身份和确定 PromoLink | novel+locale 唯一；复合 FK 保证 Article 与 PromoLink 属于同一 Novel；published 行内 CHECK | 换租客、评论生成、跨 Novel hreflang、渠道版权试读正文 |

### 3.4 任务、外部副作用与调度

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| ~~`catalog_scan_task` / `_item`~~ | **已 DROP（Phase C step C-4）**：并入 `generic_task`，见下方 `generic_task` 行 | ~~页区间目录扫描及租约~~ | ~~account+app+project_type 单 active；item fencing~~ | 已执行：`prisma/migrations/20260907091500_p3_drop_catalog_scan_task` |
| `channel_sync_task` / `_item` | CPS_PARITY_ADAPTED | 已有 SourceItem 的定向作业 | 规范化 scope 单 active；item 指向 SourceItem | item 指向 Novel |
| `generic_task` / `_item` | CPS_PARITY_ADAPTED；Phase C 起承载 `task_type='catalog_scan'` 行（`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`），11 个原 CatalogScan 专属字段落 `params`/`result`/item `payload` JSON，item 用 `target_type='catalog_page'`、`target_id=页码字符串` | 规范化 scope 单 active（`operation_scope_hash` 对 catalog_scan 行折入 `project_type`）；target 二元唯一；C-1 新增两条 `WHERE task_type='catalog_scan'` partial index（`generic_task_catalog_scan_status_created_idx`、`generic_task_catalog_scan_scope_idx`），等价旧 `catalog_scan_status_created_idx`/`catalog_scan_scope_idx` | `drama_id` 非空固定目标 |
| `side_effect_intent` | ORIGINAL_REQUIRED | 外部调用前永久 effect key 和独立已提交意图 | `effect_key` 永久唯一；operation+idempotency 唯一 | 与业务写同一未提交事务 |
| `operation_audit` | ORIGINAL_REQUIRED | 本地业务变更审计 | append-only；与业务写同事务 | 业务提交后补写 |
| `schedule_run` | ORIGINAL_REQUIRED | 确定 scheduled instant、revision、DST/misfire 语义 | schedule+scheduled_for 唯一；manual trigger 独立唯一 | `globalThis` 去重 |
| `cron_run` | ORIGINAL_REQUIRED | 一次 Scheduler enqueue 结果及唯一 Task 关联 | schedule_run、generic_task 分别 1:1 | Scheduler 持有凭证 |

### 3.5 Outbox 与首页轮播

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `indexnow_outbox` | CPS_PARITY_ADAPTED | URL revision 的异步投递状态；v0.2.0 foundation 补 8 个 CPS parity 字段（生命周期时间戳 `last_request_at`/`last_response_at`、review-defer 三件套 `defer_reason`/`released_at`/`release_reason`、审计字段 `release_commit`/`payload_host`、任务关联 `delivery_task_id`） | `(url, revision)` 唯一；七态 CHECK；`delivery_task_id` 是 GenericTask.id 关联但故意不建 Prisma FK（避免 GenericTask 365 天头保留期阻塞投递记录留存） | 请求路径同步推送 |
| `indexnow_outbox_attempt` | CPS_PARITY_ADAPTED | 每次投递尝试；v0.2.0 foundation 把原 `attempt_state`（HTTP 结果分类，0 消费方）更名为 `outcome`（取值不变），把腾出的 `attempt_state` 名字用于 CPS worker 崩溃恢复语义（`started/completed/unknown_outcome`），并补 `worker_task_id` 任务关联 | outbox+attempt_no 唯一；append-only；`worker_task_id` 同样不建 Prisma FK | attempt JSON 数组作为真源 |

#### v0.2.0 foundation：IndexNow attempt 字段更名与新增语义显式登记

| ID | 分类 | CPS 行为 | 小说行为 | 偏离原因 | Owner 决策 |
| --- | --- | --- | --- | --- | --- |
| `V020-INDEXNOW-ATTEMPT-STATE-SPLIT` | `CPS_PARITY_ADAPTED` | `attemptState` 单字段同时承担 HTTP 结果分类语义 | 拆成两个独立字段：`outcome`（HTTP 结果分类，原 `attemptState` 更名，取值不变）+ 新 `attemptState`（CPS 崩溃恢复语义：`started/completed/unknown_outcome`） | 小说侧原 `attemptState` 字段全仓 0 个消费方（已核实），改名成本≈1 行且零下游影响；反向让移植代码迁就旧命名成本更高（CPS 侧 14 处引用） | `P2_07_12_STREAM_F_APPROVED`（`P2-07-12-移植审计-2026-08-12/DECISION-CHECK.md` 核查 1d） |
| `V020-TASK-CORRELATION-UUID` | `CPS_PARITY_ADAPTED` | `deliveryTaskId`/`workerTaskId` 为 `Int`，指向 SQLite `BatchTask.id` 自增整数 | 改为 `String? @db.Uuid`，指向 `GenericTask.id`；不建 Prisma relation/FK（对称于既有 `indexnow_outbox.source_task_id` 的裸引用写法，且规避 GenericTask 365 天头保留期与 IndexNow outbox/attempt 保留期不一致导致的 FK 冲突） | 类型层面必须改（PG UUID vs SQLite Int 不兼容）；是否建 FK 是本轮新决策 | `P2_07_12_STREAM_F_APPROVED` |

### 3.6 全局站点配置

| 表 | 分类 | 字段责任 | 关键约束 | DROP |
| --- | --- | --- | --- | --- |
| `site_setting` | CPS_PARITY_ADAPTED | 全局 SEO/IndexNow 配置单例（v0.2.0 foundation 新增，PG 化自 CPS `SiteSetting`） | `id` 恒为 1；`site_setting_singleton_check` CHECK 在数据库层强制单例（CPS 仅靠应用纪律，本表新增该防线） | 北斗/飞书渠道专属字段（`beidouApiBase`/`beidouAuthToken`/`feishuAppId` 等）、`carouselConfigJson`（小说侧轮播参数已按批次存 `home_carousel_auto_batch.params`）、`previewSyncEnabled`（CPS 专属预览同步开关） |
| `home_carousel_manual_slot` | CPS_PARITY_ADAPTED | locale 人工位置 | enabled active 部分唯一 | drama_id、SQLite boolean/int |
| `home_carousel_auto_batch` | CPS_PARITY_ADAPTED | 自动计算批次 | unique_key 唯一；状态 CHECK | Web 内 cron |
| `home_carousel_auto_candidate` | CPS_PARITY_ADAPTED | 排名、分数与解释 | batch+locale+rank、batch+novel 唯一 | Float 排名金额式精度 |
| `home_carousel_serving` | CPS_PARITY_ADAPTED | 只保存当前正在服务的结果，不承担历史区间 | `(locale, position)` 绝对唯一；无 `valid_from/valid_to` | 在 serving 表内保存历史有效期 |
| `home_carousel_change_log` | CPS_PARITY | 轮播历史变更与来源追溯的追加日志 | append-only | CPS drama 专用引用 |

X6 只开放 `default_og_image` 与 IndexNow 三字段的管理写口：单例缺失是部署损坏，
禁止 upsert/自动重建；写入以 `updated_at` 为乐观锁，并与脱敏 `operation_audit`
同事务。IndexNow key 原值禁止进入 Audit，提交后才失效进程内读缓存。

#### Sitemap 运行期部署环境合同

| 环境变量 | 必填阶段 | 使用方 | 约束 |
| --- | --- | --- | --- |
| `SITE_URL` | **运行期部署必填**（Web 与执行 Sitemap 刷新的 Worker） | `robots.txt`、Sitemap URL 绝对化 | 必须是无凭证、无 path/query/fragment 的绝对 HTTP(S) origin；不得提供 CPS、localhost、fixture 或其他默认域名。容器镜像 build 不读取该值，运行期缺失或非法时 fail-closed。 |

部署门禁与 D-7/feature flag 的上线顺序见 `docs/p2/P2_10_SITEMAP_RELEASE_CHECKLIST.md`。

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
- ~~Catalog Item：`pending | processing | success | failed`~~（Phase C 起随 `catalog_scan_task_item` 一并 DROP；`task_type='catalog_scan'` 的 GenericTaskItem 走下面的 Other Item 六值集合，worker 侧仍保持“从不产生 skipped”的运行期不变量，但这不再是独立物理状态集）
- Other Item：`pending | processing | success | skipped | failed`
- SideEffectIntent：`prepared | confirmed | failed | claim_retry_blocked | manual_review_required`
- IndexNow：`pending | processing | accepted | retry_wait | permanent_failed | dead_letter | cancelled`
- ArticleTemplate：`draft | active | inactive`（P2-02B 前 CHECK 误写 `retired`，与应用层实际写入的
  `inactive` 不一致——真实 PostgreSQL 上会让每次停用/软删除写入以 23514 报错；已在
  `20260906090000_p2_02b_article_template_cps_parity` 一并修正）
- Article：`draft | published | unpublished | takedown`
- ArticleType（C-24 文章三轴地基）：`novel_article | blog_article | listicle | guide`
- ContentMode（C-24 文章三轴地基）：`manual | template`
- SeoVisibility（C-24 文章三轴地基）：`public | seo_only | hidden`
- ArticleNovelRebindBatch（C-30A 换小说批量换绑，`article_novel_rebind_batch.status`）：
  `ready | processing | completed | partial | failed`
- ArticleNovelRebindBatchItem（C-30A，`article_novel_rebind_batch_item.status`）：
  `pending | processing | applied | skipped | failed`
- ArticleNovelRebindBatchItem error kind（C-30A，`article_novel_rebind_batch_item.error_kind`，可空）：
  `drift | not_found | blocked | ineligible | fence_lost | unknown`
- ScheduleRun：`due | enqueued | misfired | skipped | failed`
- CronRun：`created | task_created | failed`
- Carousel batch：`pending | processing | completed | failed`

其他受限枚举同样进入 CHECK：task mode `dry_run | apply`、PromoLink origin
`upstream_existing | claimed`、label kind、IndexNow attempt `outcome`（原 `attempt_state`
更名，取值不变：`started | accepted | retryable_failed | permanent_failed`，机器真源
`src/domain/database-statuses.ts` 的 `INDEXNOW_ATTEMPT_OUTCOMES`）、IndexNow attempt
`attempt_state`（v0.2.0 foundation 新增，CPS 崩溃恢复语义：`started | completed |
unknown_outcome`，机器真源 `INDEXNOW_ATTEMPT_RECOVERY_STATES`，与 `outcome` 是两个独立字段，
不得混淆）、ScheduleRun trigger kind、misfire policy、preview materialization policy、
carousel serving source 和 ArticleTemplate 的 `applicable_article_type`
（`novel_article | blog_article | listicle | guide | any`，机器真源
`src/lib/article-templates/applicable-article-type.ts` 的 `APPLICABLE_ARTICLE_TYPES`；`novel_article`
是 CPS `drama_article` 的直接改名，其余四值逐字照搬）。C-24 新增的 Article 三轴同样在此列：
`article_type`（机器真源 `src/domain/database-statuses.ts` 的 `ARTICLE_TYPES`，与
`APPLICABLE_ARTICLE_TYPES` 同源去掉 `any`）、`content_mode`（机器真源
`ARTICLE_CONTENT_MODES`，CPS 逐字照搬）、`seo_visibility`（机器真源
`ARTICLE_SEO_VISIBILITIES`，CPS 逐字照搬）。三列均由
`20260909090000_c24_article_axes` 一次性加列 + CHECK + 索引落地，本迁移零行为改变——
三列在本仓库任何查询里都还没有读取点，读取与生效留给 C-25（SEO 可见性）、C-26（类型/内容模式
筛选）、C-27（博客地基）。

C-30A（换小说地基，`20260911090000_c30_novel_rebind_foundation`）新增的两个五值状态与一个可空
六值错误分类同样在此列：`article_novel_rebind_batch.status`（机器真源
`src/domain/database-statuses.ts` 的 `REBIND_BATCH_STATUSES`，CPS `ArticleDramaSwitchBatch.status`
同构值集平移）、`article_novel_rebind_batch_item.status`（机器真源 `REBIND_ITEM_STATUSES`，CPS
`ArticleDramaSwitchBatchItem.status` 同构值集平移）、`article_novel_rebind_batch_item.error_kind`
（机器真源 `REBIND_ERROR_KINDS`，可空——`NULL` 表示尚未记录错误或终态非失败）。三者均由
`20260911090000_c30_novel_rebind_foundation` 一次性建表 + CHECK + 索引落地；本迁移创建的三张表
（`article_novel_rebind_preview`/`article_novel_rebind_batch`/`article_novel_rebind_batch_item`）
在本单（C-30A，施工工单单 1）内均为空表、零现存行、零调用点读取——批量预览/持久化执行/批量界面
的读写代码是 C-30B（单 2，本文档所指施工工单的第二单），不在本单范围内。C-30A 单篇换绑范围内
真正接线的只有既有 `Article.novel_id`/`Article.promo_link_id` 两列的原子换绑写入（不新增列、不
新增 CHECK，走既有 `article_novel_id_by_type_check` 与 `article_promo_link_novel_fkey`）与既有
`operation_audit` 表的追加写入。

逐值业务语义以 `src/domain/database-statuses.ts` 的 `DATABASE_STATUS_SEMANTICS`（`indexnow_outbox_attempt`
条目按列名 `outcome`/`attemptState` 二级嵌套，因为该表没有单一 `status` 列）和 JSONL 字典为机器真源。特别冻结：

- Novel/Article `draft`、Novel `ready` 对公众为 404；`published` 才进入公开读取。`published` 的四条行内必要条件（§5 第 11 条：title/slug/body 非空 + 推广链接）中，推广链接一条自 C-27（`20260910090000_c27_blog_article_foundation`）起只对 `article_type = 'novel_article'` 成立——博客/listicle/guide 已发布可以没有推广链接，因为它们根本没有 Novel 可挂推广链接。
- `unpublished` 保留稳定下架页并退出索引，内容继续保留；`takedown` 是版权或安全移除，两者不得合并。公开路由 **V1 = HTTP 404**（页面层 `notFound()`）；**HTTP 410 为 post-V1，由 proxy 层实现**，本轮不在 RSC 里用自定义 digest 打 410。
- Chapter `preview` 可展示和索引，`locked` 在 V1 不物化；可信且结构完整、非空的响应中缺席才进入 `stale`，立即停展并退出 sitemap，但正文保留。
- 失败、结构异常或异常空列表等不可信响应不改变章节状态；`stale` 章节可信重现后自动恢复 `preview`。
- `withdrawn` 是人工/版权撤回并返回 404，是唯一会通过版权流程删除 `novel_chapter_content` 的章节状态。
- Credential、PromoLink、Task/Item、SideEffectIntent、IndexNow、ScheduleRun/CronRun 与 Carousel 的逐值术语不得退化为“实体当前状态”。
- Article `seo_visibility`（C-24）的逐值语义冻结为：`seo_only` = 页面 `index,follow` 且进
  sitemap，但不出现在站内任何列表页；`hidden` = 公开侧一律不可达（404），不进 sitemap，不进
  IndexNow。**这两个值截至 C-24 均未被任何调用点读取**（C-24 只加列不接线，是零行为变化的地基
  迁移）；上述语义是 C-25 落地时必须实现成的目标行为，不是 C-24 之后立即生效的行为。
  **C-25（`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25）已按此冻结语义
  接线**：`src/server/publication/visibility.ts` 新增 `isHiddenFromPublicView`/
  `buildPublicListArticleWhere`（列表层，排除 `hidden` 与 `seo_only`）并把
  `buildPublicArticleWhere` 收口为收录层（排除 `hidden`，保留 `seo_only`）；三层调用点
  （详情 `access.ts`、sitemap、IndexNow、后台文章列表/编辑）全部读取该列，读取本身受单闸
  `FEATURE_ARTICLE_SEO_VISIBILITY`（默认 `false`）保护——关闸时公开侧仍按 C-24 落地时的
  "零行为变化" 运行，后台的筛选/列/编辑控件不受此闸门控。列本身无 schema 改动，本行只是把
  上一段的"目标行为"更新为"已实现，待开闸"。
- 换小说（C-30A）：`Article` 的换绑是 `novel_id` + `promo_link_id` 两字段的原子替换，一条 `UPDATE`
  必须同时改到目标那一侧，少改一个就撞既有复合 FK `article_promo_link_novel_fkey`（`(promo_link_id,
  novel_id)` → `promo_link(id, novel_id)`）——数据库层面直接拒绝"只换书目不换推广链接"的半吊子写
  入。🔴 `article_novel_locale_key`（`UNIQUE(novel_id, locale)`，§5 第 5/21 条）是**不含软删豁免**
  的普通唯一约束（对照同表 `article_locale_slug_active_uidx` 是带 `WHERE deleted_at IS NULL` 的部
  分索引）：目标书目哪怕只有一篇**已软删**的同语种文章，那个槽位仍然占着，换绑照样撞唯一冲突。
  应用层守卫（`src/server/article-rebind/guards.ts` 第 8 条"同语种页面冲突"）必须按"含软删"判
  定，集成测试须专门覆盖这一格。

## 5. Migration-only 物理约束清单

以下对象由 `20260803090000_p1_initial_schema` 及后续具名增量 Migration 落地：

1. 所有状态、非负计数、正数页码/章号、时间窗顺序和 processing 租约完整性 CHECK。
2. `channel_account_credential(channel_account_id, credential_type) WHERE status='active'`。
3. `novel(locale, slug) WHERE deleted_at IS NULL`。
4. `novel_chapter(novel_id, canonical_chapter_number) WHERE deleted_at IS NULL`。
5. `article(locale, slug) WHERE deleted_at IS NULL`。
6. ~~`catalog_scan_task(channel_account_id, channel_app_id, project_type) WHERE status IN ('pending','processing')`~~（Phase C step C-4 已 DROP；等效排他性现由 `generic_task_active_scope_uidx` 提供——`operation_scope_hash` 对 `task_type='catalog_scan'` 行折入 `project_type`）。
7. ChannelSync active scope 部分唯一；GenericTask 使用 PostgreSQL `NULLS NOT DISTINCT` 对 nullable account/app 建立 active 唯一，不使用 UUID sentinel 或 `COALESCE` 表达式。
8. ~~三类~~两类（Phase C 起 `catalog_scan_task_item` 已 DROP）Item 分别建立 pending claim 与 expired lease recovery 两套部分索引；查询不得使用 OR。
9. `home_carousel_manual_slot` 的 enabled+未软删 position/novel 两个部分唯一索引，PostgreSQL 谓词使用 `enabled IS TRUE`。
10. `promo_link.public_redirect_code` 使用全局非部分 UNIQUE、byte-wise/case-sensitive 语义和不可变 trigger；软删行继续占位。
11. published Article 的行内必要条件拆为四条命名 CHECK，禁止空字符串绕过：
    - `db:public:article:article_published_title_check`: `status <> 'published' OR btrim(title) <> ''`；
    - `db:public:article:article_published_slug_check`: `status <> 'published' OR btrim(slug) <> ''`；
    - `db:public:article:article_published_body_check`: `status <> 'published' OR btrim(body) <> ''`；
    - `db:public:article:article_published_promo_link_check`（C-27 起分叉，`20260910090000_c27_blog_article_foundation` DROP + 同名 ADD）：
      `status <> 'published' OR article_type <> 'novel_article' OR promo_link_id IS NOT NULL`——原谓词对所有文章类型一律要求推广链接；博客/listicle/guide 没有 Novel，也就没有推广链接可要求，分叉后只对 `novel_article` 保留原有强度，novel_article 的保护一格不降；
    - `db:public:article:article_published_published_at_check`: `status <> 'published' OR published_at IS NOT NULL`。

    另新增一条不受 `status` 限制、全时段成立的结构性 CHECK（C-27，同一迁移）：
    - `db:public:article:article_novel_id_by_type_check`：
      `(article_type = 'novel_article' AND novel_id IS NOT NULL) OR (article_type <> 'novel_article' AND novel_id IS NULL)`——
      把 `novel_id` 收窄为可空（见本节末尾迁移清单第 20 条与 C-27 迁移文件本身）之后，用这条 CHECK 把 `novel_article` 必须有 Novel 的保护补回来，同时把非 `novel_article` 的 `novel_id` 钉死为 NULL（禁止"半挂"状态——`docs/governance/database-governance.md` 认定这一格比 CPS 更严是有意的，见 C-27 工单"明确不移植"一节）。

    **L-1（C-27 review，服务层补的防护，非新 CHECK）**：`novel_id` 可空之后，`novel_id IS NULL AND promo_link_id IS NOT NULL` 是一个 schema 合法但业务上永不该出现的形状——`article_promo_link_novel_fkey`（本节第 12 条）是 `MATCH SIMPLE`，任一列 NULL 即不检查，所以数据库这一层本身不会拒绝它；真正挡住它的是应用层：`worker/handlers/promo-link-binding.ts` 的 `bindPromoLinkToArticles` 是这个代码库里唯一会在 Article 创建之后再写 `promo_link_id` 的**生产**写口（创建时——`src/server/content-creation/service.ts`——恒写 `null`；`scripts/x8-promo-fixture.ts:124` 的验收脚本也会直接写这一列，但那是一次性运维脚本，不是生产路径），它的 `where: { novelId, ... }` 过滤天然不会选中 `novel_id` 为 NULL 的行，但那只是查询形状带来的隐性保证；本次 review 在函数体内加了一条显式断言（`article.novelId === null` 时直接 `throw`，绝不调用 `article.update`），把这条不变量从"隐含在查询里"变成"代码里可读的断言"，防的是未来这条查询被改写（例如换成 join）之后隐性保证跟着失效。见 `tests/backend/tasks/promo-link-binding.test.ts`。
12. `promo_link` 提供 `db:public:promo_link:promo_link_id_novel_key` = `UNIQUE(id, novel_id)`；Article 以 `db:public:article:article_promo_link_novel_fkey` = `(promo_link_id, novel_id)` 复合 FK 引用该键，数据库保证所选 PromoLink 与 Article 属于同一 Novel。Prisma 和初始 Migration 均保留该具名复合 FK。
13. Article locale 与 Novel locale 一致仍由写事务和集成测试保证；数据库不建立第二套 locale 映射。
14. `operation_audit`、IndexNow attempt、credential/carousel log 禁止普通 UPDATE/DELETE；权限落地归 P1-06。
15. ScheduleRun scheduled/manual 互斥字段 CHECK；CronRun 与 GenericTask 在同一事务创建并一对一关联。
16. Item 结果提交必须在同一事务验证 `execution_token` 和 `lease_epoch`；旧租约为零行更新并回滚业务结果。
17. `20260804090000_p1_08_credential_status_parity` 将 Credential CHECK 增量替换为
    `active | superseded | expired | invalid`；如检测到 `revoked` 存量必须失败并要求人工处置，
    不得静默迁移到其他状态。
18. `20260818120000_v020_foundation_shared`（v0.2.0 foundation，本轮唯一 Migration）：
    - `indexnow_outbox` 新增 8 字段（见 3.5）与 `(defer_reason, status)` 索引；
    - `indexnow_outbox_attempt` 用 `RENAME COLUMN` + `RENAME CONSTRAINT` 把原 `attempt_state`
      物理列与其 CHECK 更名为 `outcome`/`indexnow_outbox_attempt_outcome_check`（取值不变），
      随后新增 `attempt_state` 列（CPS 崩溃恢复语义）与同名新 CHECK、以及 `worker_task_id`；
    - 新建单例表 `site_setting`，`updated_at` 遵循本仓 `@updatedAt` 字段惯例不带数据库
      `DEFAULT`（对照 `channel.updated_at` 等既有字段），迁移内种子 INSERT 显式提供该列的值；
    - 本迁移在一次性 PostgreSQL 16 容器中完成 `migrate deploy`（含二次幂等重放）、
      `migrate diff --exit-code`（migrations→schema、live db→schema 均零差异）与
      `scripts/check-database-dictionary-drift.mjs` 全量校验（44 张表、950 条 active 字典记录、
      零孤儿/幽灵）。

19. `20260816160000_p2_06_5_tagging_v3` 手写的 6 条非默认名 FK 由 Prisma `@relation(..., map:)` 具名认领（与第 12 条同一做法）：
    `db:public:canonical_tag_translation:canonical_tag_translation_tag_id_fkey`、
    `db:public:canonical_tag_keyword:canonical_tag_keyword_tag_id_fkey`、
    `db:public:source_label_mapping:source_label_mapping_tag_id_fkey`、
    `db:public:novel_tag_state:novel_tag_state_current_auto_run_id_fkey`、
    `db:public:novel_canonical_tag:novel_canonical_tag_tag_id_fkey`、
    `db:public:novel_canonical_tag:novel_canonical_tag_run_id_fkey`。
    该迁移其余 6 条 FK 的手写名恰与 Prisma 默认名相同，Prisma 侧不写 `map:`。
    今后若要改这 6 条 FK 的物理名，必须走新 Migration 的 `RENAME CONSTRAINT` 并同步 `map:` 与 JSONL 三处，禁止只改一侧。
20. `20260909090000_c24_article_axes`（C-24 文章三轴地基）新增 `article_type`/`content_mode`/
    `seo_visibility` 三列（均 `NOT NULL DEFAULT`，默认值分别为 `novel_article`/`template`/`public`，
    与迁移前每一行的隐含行为逐字等价，零回填脚本、零行为变化）与三条命名 CHECK：
    - `db:public:article:article_article_type_check`：
      `article_type IN ('novel_article', 'blog_article', 'listicle', 'guide')`；
    - `db:public:article:article_content_mode_check`：`content_mode IN ('manual', 'template')`；
    - `db:public:article:article_seo_visibility_check`：
      `seo_visibility IN ('public', 'seo_only', 'hidden')`。
    同一迁移新增两条索引：`db:public:article:article_seo_visibility_idx` = `INDEX (seo_visibility)`
    （对齐 CPS 的同名索引）、`db:public:article:article_type_locale_status_published_idx` =
    `INDEX (article_type, locale, status, published_at)`（对齐 CPS 的复合索引）。迁移末尾附一条
    `DO $c24_article_axes_guard$` 自证守卫：统计三列偏离上述默认值的行数，非零即
    `RAISE EXCEPTION`（ERRCODE `23514`）；因为 `ADD COLUMN ... DEFAULT` 在同一 DDL 语句内就把既存行
    回填成该默认值，这个计数在本迁移下机械恒为零，守卫只是防止未来有人误改这个文件时静默改变既存行为。
21. `db:public:article:article_novel_locale_key`（`UNIQUE(novel_id, locale)`）在 C-27
    （`20260910090000_c27_blog_article_foundation`）把 `novel_id` 收窄为可空之后的 NULL 语义登记：
    **依赖 PostgreSQL 默认的 NULL 互不相同语义，禁止改为 `NULLS NOT DISTINCT`**。PostgreSQL 的普通
    UNIQUE 约束把每个 NULL 视为与其他任何 NULL 都不同，所以任意多篇 `novel_id IS NULL` 的博客文章
    可以在同一 `locale` 下共存，这正是博客需要的行为（一个 `locale` 下当然要能发多篇博客）。若误加
    `NULLS NOT DISTINCT`，效果是把博客锁死成每 `locale` 全站只能有一篇，而且失败是静默的——第二篇
    博客创建时只会报一个莫名其妙的唯一冲突，运营看不出这是约束选错了写法。这条约束本身（物理名、
    列组成）**不改**，本条只是把"为什么不能加 NULLS NOT DISTINCT"这条否定性决策钉在字典里。
22. `20260911090000_c30_novel_rebind_foundation`（C-30A 换小说地基）新增：
    - `db:public:novel:title_normalized`：可空 `VARCHAR(500)`，CPS `Drama.nameNormalized` 平移，
      `db:public:novel:novel_locale_title_normalized_idx` = `INDEX (locale, title_normalized)`。
      本迁移不回填任何存量行（回填是独立、幂等、可重跑的
      `scripts/backfill-novel-title-normalized.ts`，不折进本 DDL），迁移末尾附
      `DO $c30_novel_rebind_foundation_guard$` 自证守卫：统计
      `title_normalized IS NOT NULL` 的行数，非零即 `RAISE EXCEPTION`（ERRCODE `23514`）——因为
      新列无 `DEFAULT`，`ADD COLUMN` 本身机械保证这个计数为零，守卫只防未来有人误把回填逻辑塞进
      这个文件。
    - 三张新表（`article_novel_rebind_preview`/`article_novel_rebind_batch`/
      `article_novel_rebind_batch_item`，字段清单见 §3.2）：
      - `db:public:article_novel_rebind_batch:article_novel_rebind_batch_status_check` =
        `status IN ('ready','processing','completed','partial','failed')`；
      - `db:public:article_novel_rebind_batch_item:article_novel_rebind_batch_item_status_check` =
        `status IN ('pending','processing','applied','skipped','failed')`；
      - `db:public:article_novel_rebind_batch_item:article_novel_rebind_batch_item_error_kind_check` =
        `error_kind IS NULL OR error_kind IN ('drift','not_found','blocked','ineligible','fence_lost','unknown')`；
      - `db:public:article_novel_rebind_batch:article_novel_rebind_batch_request_token_key` =
        `UNIQUE(request_token)`（提交幂等令牌，CPS `ArticleDramaSwitchBatch.requestToken` 平移）；
      - `db:public:article_novel_rebind_batch_item:article_novel_rebind_batch_item_batch_article_key`
        = `UNIQUE(batch_id, article_id)`（同一批次内每篇文章至多一条条目）；
      - `db:public:article_novel_rebind_batch:article_novel_rebind_batch_preview_id_fkey` =
        `(preview_id)` → `article_novel_rebind_preview(id)`，`ON DELETE RESTRICT`；
      - `db:public:article_novel_rebind_batch_item:article_novel_rebind_batch_item_batch_id_fkey` =
        `(batch_id)` → `article_novel_rebind_batch(id)`，`ON DELETE CASCADE`。
      `batch_id` 是这三张表之间唯一的硬 FK；`article_id`/`old_novel_id`/`old_promo_link_id`/
      `expected_new_novel_id`/`expected_new_promo_link_id`/`applied_new_novel_id`/
      `applied_new_promo_link_id`/`audit_id`（→ `operation_audit.id`）均为无 FK 的审计形状列——
      CPS 同构列（`ArticleDramaSwitchBatchItem.articleId`/`oldDramaId`/`expectedNewDramaId`/
      `appliedNewDramaId`）同样无 FK：这三张表记录的是"计划/尝试过什么"，即使对应的 article/
      novel/promo_link 行之后被另一条路径软删或硬删，记录也必须继续可读。
    - 本单（C-30A，施工工单单 1）范围内三张新表均为空表、零调用点读写——批量预览/持久化执行/
      批量界面的读写代码是 C-30B（单 2），故本单**未**在 `infra/postgres/grants.sql` 里为这三张
      表登记任何角色 GRANT（沿用本仓库既有"地基迁移先加表/列、读写代码接线时再登记 GRANT"的顺序，
      同 C-24 文章三轴地基先例）；C-30B 落地读写代码时必须同时补齐 `web_app` 对三张表的
      `SELECT`/`INSERT`/`UPDATE` GRANT，否则真实 PostgreSQL 上会 `42501 permission denied`（参见
      本文件 2026-09-05 "PR6 fix lane E" 一行记录的同类事故）。
    - C-30A 单篇换绑本身**不**新增任何列或 CHECK——它只原子写入 `Article` 既有的 `novel_id`/
      `promo_link_id` 两列，受既有 `article_novel_id_by_type_check`（§5 第 11 条）与
      `article_promo_link_novel_fkey`（§5 第 12 条）约束，且这两列的 JSONL 字典记录已在 C-24/
      P1-05B 落地，本迁移不重复登记。

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
- `side_effect_intent` 在外部调用前独立事务提交；未确认结果进入 `claim_retry_blocked`。通用 worker 迁移图中 `claim_retry_blocked` 只能进入 `manual_review_required`；由 readback 证据确认（`prepared`/`claim_retry_blocked` → `confirmed`）只经 `confirmSideEffectIntentByReadbackInTransaction` 专用边界并与业务写同事务；`manual_review_required` 的出边只属于 X9 人工裁决。
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
| `site_setting.indexnow_key` | S2 | `settings:manage` + 当前会话 2FA 的受控 API 可读/写 | IndexNow 任务可读 | 禁止 | 禁止 |

### P1-06 已实施权限矩阵

| 角色 | 对象所有权 / DDL | 读取 | 写入 | 额外限制 |
| --- | --- | --- | --- | --- |
| `migration_owner` | 唯一应用对象 Owner；执行 Migration | 全部 | 全部 | 不作为应用运行身份 |
| `web_app` | 无 | S0/S1 与公开章节正文；凭证仅元数据；`site_setting`；仅为发布门禁与公开 `/go` 读取 `promo_link.web_url/app_url` | 后台元数据、任务入队、Audit 追加；同步 add/replace 可 INSERT 新密文及轮换元数据；`site_setting` 仅四字段 + `updated_at` UPDATE；X9 人工裁决仅可 UPDATE `side_effect_intent(status,response_shape,confirmed_at)` | 禁止 SELECT/解密已保存 `encrypted_secret`、完整 fingerprint、`promo_link.upstream_code` 与原始上游 payload；目的 URL 只供受控发布/跳转服务使用，不进入通用后台投影或审计；SiteSetting 禁止 INSERT/DELETE/其他列 UPDATE；人工裁决不得改 intent identity/evidence/linkage；超时 `30s / 5s / 60s`（statement / lock / idle transaction） |
| `worker_app` | 无 | 完成任务与凭证处理所需全部列，显式包括 `side_effect_intent`（含 attempt fingerprint）；`site_setting` | 业务/任务状态与追加日志；仅章节撤回正文允许 DELETE | `operation_audit` 等追加日志禁止 UPDATE/DELETE；SiteSetting 只读；通用 intent transition 无 `manual_review_required` 出边，且 `claim_retry_blocked` 无 `confirmed` 出边（readback 确认走专用边界）；超时 `5min / 15s / 5min` |
| `analyst_ro` | 无 | S0/S1 列 | 无 | `default_transaction_read_only=on`；`statement_timeout=30s`；禁止 S2/S3 |
| `backup_role` | 无 | 完整逻辑/物理备份所需全部表、序列 | 无 | `REPLICATION` 仅用于 `pg_basebackup`；凭证仅由备份系统托管 |
| `scheduler_app` | 无 | schedule/generic task 元数据 | 仅创建/更新 schedule 与 GenericTask 元数据 | 禁止 Auth/Credential secret；不导入 Worker handler registry；无 Credential key；超时 `1min / 5s / 60s` |

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
- C-30A（换小说）新增两对 JSONB + 固定版本列：`article_novel_rebind_preview.filters_json` /
  `filters_json_schema_version`（生成预览时使用的筛选条件——语种、来源应用等）与
  `article_novel_rebind_preview.matches_json` / `matches_json_schema_version`（二分图四分类配对
  结果的冻结快照）；`article_novel_rebind_batch` 复制同一对 `filters_json` /
  `filters_json_schema_version`（批次落库时对预览筛选条件的快照，与预览行各自独立版本演进）。三对
  版本列均从 `1` 起步——CPS 参照物的 `schemaVersion 1` 兼容路径不移植（海阅没有历史快照需要兼容，
  见施工工单 §2.4/§3.3），因此这里没有"版本 0"或历史迁移分支要登记。四个 JSONB 列均不得写入明文
  凭证；`matches_json` 可能包含文章标题/书名等 S1 内部信息，不含章节正文。

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
| 2026-08-18 | v0.2.0-foundation（Stream F，P2-07～12 一轮实施） | 唯一 Migration `20260818120000_v020_foundation_shared`：`indexnow_outbox` 补 8 字段、`indexnow_outbox_attempt` 更名 `attempt_state`→`outcome` 并新增 CPS 崩溃恢复语义的 `attempt_state`/`worker_task_id`、新建单例 `site_setting` 表（PG 化自 CPS，DROP 北斗/飞书/轮播 JSON 专属字段）；随附 db-retry 与 `credentials/service.ts` 内联判定收敛、可见性谓词族 `src/server/publication/visibility.ts`、`SiteSetting` accessor、公开访问入口适配、`publication-dispatcher`、Article path builder 移植 | Claude（Sonnet 编码/Opus 复核） | 一次性 PostgreSQL 16 容器验证 PASS（44 张表、950 条 active 字典记录、零 drift）；**P1 既有 45 个模型的字典词典全量回填另立轻量任务，不阻塞本轮**（沿用 2026-08-12 Owner 裁决第 2 条） |
| 2026-08-18 | v0.2.0-publish-gate（Stream A，P2-07 发布门禁，合并前 Opus 复核 必改1/2） | 零 schema 改动。`applyPublishTransition` 收口 TOCTOU（facts/gate 读取移入事务、写入改条件 `updateMany`+`count` 校验+失败即抛出回滚）；移除 `OperationAudit` 上一版依赖 P2002 恢复的死分支，相关幂等注释降级为"顺序重试幂等，非并发安全"；§13 登记 `operation_audit` 幂等唯一索引为跟进项 | Claude（Sonnet 编码/Opus 复核） | `npm test` 1281 passed / 85 skipped；新增 TOCTOU 并发交错回归测试（`tests/backend/publish-gate/service.test.ts`，注入钩子模拟交错时序） |
| 2026-08-18 | v0.2.0-public-wiring（Stream B PR2，P2-08 复核） | §4 冻结公开路由：`takedown` **V1 = HTTP 404**；**410 为 post-V1（proxy 层）**。零 schema 改动。 | Cursor | 页面层 `notFound()` + `novel/[slugParam]/not-found.tsx`；禁止 `NEXT_HTTP_ERROR_FALLBACK;410` digest |
| 2026-08-18 | P2-10 Sitemap | 登记 `SITE_URL` 为 Web/刷新 Worker 的运行期部署必需 origin；镜像 build 不注入默认域名，运行期继续严格 fail-closed | Codex | 待 Claude 增量复核 |
| 2026-08-26 | P0 catalog promo capture (`ce7f0f1`) | `worker_app` 的表级 SELECT 增加 `promo_link` 与 `article`，供 MoboReader catalog 在脱敏前捕获已有推广资产并绑定本地文章；不新增写权、不扩张 Web/Scheduler 凭证面 | Codex | 已合入 `ce7f0f1`；集成验证覆盖角色读取与脱敏边界 |
| 2026-08-26 | X2 PostgreSQL 硬化 | 零 schema migration；冻结 Web/Worker/Scheduler 的 statement/lock/idle transaction 超时，增加 `max_connections=100`、500ms 慢查询与 `pg_stat_statements` preload 配置合同，并补启用/回滚手册与一次性 PostgreSQL 16 验证 | Codex | 仓库配置合同已验证；生产尚需运维窗口 preload、重启、`CREATE EXTENSION` 与现网核验 |
| 2026-08-26 | X6 SiteSetting 写服务 | 零 schema migration；新增 `settings:manage` + 当前会话 2FA 双门、精确 GET/PATCH registry、四字段校验、`updated_at` 乐观锁、request-id 重放绑定、脱敏 Audit 与提交后缓存失效；同步收紧 `site_setting` 到 Web/Worker 读与 Web 最小列 UPDATE | Codex | 待 Claude custodian 复核 `src/app/**`、`src/contracts/**`、`src/features/admin-ui/**` 伴随变更；`scripts/run-x6-site-setting-postgres-verification.sh` 已以 PostgreSQL 16.14 验证 Web 最小写列、Worker 只读、Analyst/Scheduler 拒绝、事务 Audit 与字典零漂移，并清理 disposable 实例 |
| 2026-08-26 | X9 Task Admin | 零 migration；新增 `task:manage` + 当前会话 2FA 的三族任务读取/失败重试与 SideEffectIntent 人工裁决。Web 仅获得 `side_effect_intent(status,response_shape,confirmed_at)` 列级 UPDATE；裁决 CAS 与 OperationAudit 同事务，不触发上游、PromoLink 自动对账或 worker 通用 transition 出边 | Codex | PostgreSQL 16.14 disposable role/CAS/audit/worker-negative verification PASS；零 dictionary drift；容器已清理 |
| 2026-09-01 | Book B E2E PromoLink 目的 URL 读取 | 零 schema migration；`web_app` 增加且仅增加 `promo_link.web_url/app_url` 的列级 SELECT，供发布门禁与公开 `/go` 跳转使用；不开放 `upstream_code`、原始上游 payload 或 Analyst/Scheduler 读取 | Codex | X8 Book B E2E 已验证发布门禁与 `/go`；Web 两列可读、Analyst 两列拒绝 |
| 2026-09-03 | Book C SideEffectIntent Worker 读取 | 零 schema migration；`worker_app` 增加 `side_effect_intent` 表级 SELECT，使正式 claim handler 可执行 intent 预查、独立 prepare、状态迁移与 readback-only recovery；不扩张 Web/Scheduler 权限 | Codex | Book C 首次启动在 mutation 前发现缺口；补权后正式 handler PASS，`getcode=1`、intent `confirmed`、capability 已恢复关闭 |
| 2026-09-05 | P2-06.5 Tagging V3 | 增加七表 Tagging V3 foundation、exact raw-language scope、角色权限与治理合同；无 taxonomy auto-write | Codex | 集成冻结提交历史；AUTO_WRITE_AUTHORIZED=NO |
| 2026-09-05 | Launch parity M5 home carousel（`20260905090000_site_setting_carousel_config`） | `site_setting` 加一列 `carousel_config_json JSONB NOT NULL DEFAULT '{}'`（首页人工位/新剧位/衰减排序运营配置；收益排序对 Novel V1 恒禁用，见列注释） | Codex | 已在 X8 uat（`cps-novel-x8-local`）应用；补记本行前 §12 遗漏此条 |
| 2026-09-05 | PR6 fix lane C — migration 时间戳顺序治理记录 | `20260816160000_p2_06_5_tagging_v3` 的目录名字面序排在 `20260818120000_v020_foundation_shared` 之前，但两者在同一 X8 长期卷上的实际 `migrate deploy` 应用顺序与目录名序不一致（`_prisma_migrations` 记录的 apply 顺序早于目录名对比结果）——`prisma migrate deploy` 只按"是否已记录在 `_prisma_migrations`"决定要不要应用，与目录名字面序无关，因此**安全**；`prisma migrate dev` 的 shadow-DB 重放假定目录名序即预期应用序，对这条历史会报漂移（drift），**不安全**、不能在这套 X8 卷上跑。两个目录都不改名——改名会使已落盘的 `_prisma_migrations.migration_name` 与磁盘目录名不一致，制造新的漂移而不是修复旧漂移。生产/新库从空库开始 `migrate deploy` 时两迁移严格按目录名序连续应用，不受此限制影响 | Claude（Sonnet，PR6 B-3 修复附带发现） | 只读记录，未执行任何 migration 操作；本行是 N-11 的登记，不是新变更 |
| 2026-09-05 | PR6 fix lane E — carousel 权限缺口 | 零 schema migration。真机 X8 uat 暴露 `scheduler` 容器因 `42501 permission denied for table site_setting` 崩溃重启（`scheduler` 读 `carouselConfigJson` 判定 cron 是否到点，但 `scheduler_app` 对 `site_setting` 无任何授权）；`information_schema.role_table_grants` 复核同时发现 `worker_app` 对 `home_carousel_manual_slot/auto_batch/auto_candidate/serving` 只有 INSERT/UPDATE 无 SELECT（`computeHomeCarouselInTx` 的 `findMany`/`update`/`deleteMany` 均需 SELECT），且对 `home_carousel_serving` 无 DELETE（merge 用 `deleteMany` 整体收缩后 `createMany` 重建，非 UPDATE 语义）。修复：`GRANT SELECT (id, carousel_config_json) ON site_setting TO scheduler_app`（列级，`indexnow_key` 等其余列/`analyst_ro` 依旧零可见性）；`worker_app` 补四表 SELECT + `home_carousel_serving` DELETE；`home_carousel_change_log` 保持 INSERT-only 不变。`src/server/home-carousel/service.ts` 的 `getHomeCarouselConfig`/`computeHomeCarouselInTx` 已是列级 `select:{carouselConfigJson:true}`，代码侧无需改动。同步更新 `database-schema-dictionary.jsonl` 中 `site_setting.id`/`site_setting.carousel_config_json` 两条记录的 `read_roles`（加 `scheduler_app`），以及 `tests/backend/database/x6-site-setting-grants.test.ts` 原先"scheduler_app 对 site_setting 零访问"的契约断言（收窄为"零全表 SELECT/INSERT/UPDATE/DELETE，仅允许既定列级 SELECT"），使其与新授权一致 | Claude（Sonnet，PR6 fix lane E） | 新增 `tests/backend/database/carousel-grants.test.ts`（6 用例，含对列级 grant 的变异测试：删除该行断言立即转红）；`npm run typecheck && npm run lint && npm run test:backend`（163/164 文件通过，唯一失败为既有 `publish-gate/no-bypass` 基线失败）+ `npm run test:ui`（113/113 通过）全绿；X8 uat（`cps-novel-x8-local`）复现修复前崩溃（`docker ps` 显示 `scheduler` 持续 `Restarting`）后，以 postgres 超级用户重跑修复后的 `grants.sql`（自带 REVOKE 重置，幂等）并 `docker compose restart scheduler`：容器转为持续 `Up ... (healthy)`（`RestartCount` 维持 0，观察窗覆盖至少两次 60s cron tick，`docker logs` 自重启后再无 42501）；`role_table_grants`/`role_column_grants` 复核与预期矩阵完全一致（`scheduler_app` 仅 `site_setting(id, carousel_config_json)` 列级 SELECT、对 `home_carousel_*` 零访问；`worker_app` 四表新增 SELECT + `home_carousel_serving` 新增 DELETE）；`/api/health` 200 `ok:true` |
| 2026-09-06 | Phase C — C-1 任务模型迁移 schema 先行（`20260907090000_p3_generic_task_catalog_scan_indexes`） | `TASK_ARCHITECTURE_DECISION = MIGRATE_TO_CPS_TASK_MODEL`（`CPS海阅_短剧到小说全链路Parity审计与收敛规划_2026-09-06.md` §4/§0）第一步：给 `generic_task` 补两条 `WHERE task_type='catalog_scan'` partial index，等价现有 `catalog_scan_status_created_idx`/`catalog_scan_scope_idx`；本步不删任何表、不改任何 CHECK/FK，`catalog_scan_task(_item)` 原样保留。`database-schema-dictionary.jsonl` 新增两条 `managed_by=migration_sql` 记录 | Claude（Sonnet，Phase C 施工） | 待一次性 PostgreSQL 16 容器验证（migrate deploy 幂等重放 + `check-database-dictionary-drift.mjs`）；详见本轮 Phase C 报告 |
| 2026-09-06 | Phase C — C-4 DROP catalog_scan_task(_item)（`20260907091500_p3_drop_catalog_scan_task`） | C-2/C-3（应用层与测试已全部切至 `generic_task`/`generic_task_item`，`task_type='catalog_scan'`、`target_type='catalog_page'`）合入后，DROP 两表；Prisma model `CatalogScanTask`/`CatalogScanTaskItem` 一并移除（含 `ChannelAccount`/`ChannelApp` 上的 `catalogScanTasks` 反向关系字段）；无生产历史（102 行 UAT、零活体），非回填式迁移。`database-schema-dictionary.jsonl` 68 条记录改 `status=superseded`（不删除，遵 §10）；`check-database-dictionary-drift.mjs` 的 Prisma model/数据库表计数断言 51→49；`scripts/entity-fix/moboreader-foundation-swap.ts` 的前后快照去掉独立 `catalogScanTasks` 计数（并入 `genericTasks`）。 | Claude（Sonnet，Phase C 施工） | 待一次性 PostgreSQL 16 容器验证；详见本轮 Phase C 报告 |
| 2026-09-07 | Tagging V3 FK 具名对齐（零 schema migration，仅 Prisma `map:`） | `prisma migrate diff --from-migrations … --exit-code` 自 `20260816160000_p2_06_5_tagging_v3` 合入起即报 6 条 `Renamed the foreign key`（`canonical_tag_translation_tag_id_fkey`、`canonical_tag_keyword_tag_id_fkey`、`source_label_mapping_tag_id_fkey`、`novel_tag_state_current_auto_run_id_fkey`、`novel_canonical_tag_tag_id_fkey`、`novel_canonical_tag_run_id_fkey`）：手写 Migration 取了短名，而 `schema.prisma` 对应 `@relation` 未写 `map:`，Prisma 按默认规则期望 `<table>_<columns>_fkey` 长名。后果：`scripts/p1-13-postgres-verification.sh`（以及同样内置该 diff 门禁的 `run-p1-05b`/`run-p1-08b`）在任何分支都于 diff 门禁 exit 2，跑不到 grants 与测试。裁决依据 §1「已执行 Migration > 当前 Schema/SQL」与 §13「未经 Owner 批准不得抢跑新增 migration」：不改 Migration、不新增 `RENAME CONSTRAINT` 迁移，只给 6 条 `@relation` 补 `map:` 指向 Migration 已落地的物理名（先例 §5 第 12 条 `article_promo_link_novel_fkey`；本次登记为 §5 第 19 条）。已应用该 Migration 的 X8 uat（`cps-novel-x8-local`）与 tplsmoke 两库现场 `pg_constraint` 均为短名，本改动对活库零影响、无需任何 SQL。`database-schema-dictionary.jsonl` 12 条 FK 记录 `physical_name` 本就是短名，不改；`managed_by` 保持 `migration_sql`（对象由手写 Migration 创建，`map:` 只是让 Prisma 认领同名）。§3.2 至今没有 Tagging V3 七表的词典行（2026-09-05 登记时遗留），本轮不代写，待 Codex/Owner 补。 | Claude（Sonnet 编码/Opus 复核） | `prisma/schema.prisma` 恰 6 行变化，`npx prisma validate` PASS；一次性 PostgreSQL 16.14 容器（`repro-diff-v2.sh`）验证 `migrate deploy` 幂等重放后两方向 `migrate diff --exit-code` 均 `No difference detected` / `EXIT_CODE=0`，`check-database-dictionary-drift.mjs` 通过（`{"status":"ok","models":49,...}`，`DRIFT_EXIT=0`），活库 6 条 FK 名仍为短名；生产路径 `scripts/p1-13-postgres-verification.sh`（未修改）diff 门禁本身已通过（此前 exit 2 的阻塞已解除），但在 `npm run test:integration` 步命中既有基线失败 `KTF-001`（`tests/integration/tasks/p1-07-postgres.test.ts` > "commits side-effect intent independently and blocks unknown retry"，完全命中，1 failed / 25 passed，脚本 `set -e` 于该步中止，未跑到 build/typecheck/lint/test:backend/`npm test`，故生产路径本身不回答 `publish-gate/no-bypass` 是否命中，其结果见本行末的补充证据）；`P1_13_POSTGRES_ERROR line=141 status=1`、`P1_13_POSTGRES_CLEANUP=PASS`、容器/卷/网络自清理（`docker ps -a \| grep p1-13` 为空）。为证明该失败与本改动无关，对同一测试文件单独起一次性库做 A/B：`git stash` 前（含本次 `map:` 修复）与 `git stash` 后（回到修复前的 2e81d18 基线）跑同一条 `npx vitest run tests/integration/tasks/p1-07-postgres.test.ts`，两次均是同一用例 1 failed / 25 passed、断言内容逐字相同；`git stash pop` 后 `git stash list` 为空、`git diff --stat` 恢复到本行变更前的状态。补充非生产路径证据（p1-13 脚本各 `npm run/test` 行追加 `\|\| printf STEP_FAILED=…` 后完整跑一遍）见开发日志同日条目 |
| 2026-09-07 | SideEffectIntent 通用状态机收口（KTF-001） | 零 schema migration。`isAllowedSideEffectTransition` 关闭 31d4723 引入的通用 `claim_retry_blocked -> confirmed` 出边，恢复 P1-07 原始迁移图；新增 `confirmSideEffectIntentByReadbackInTransaction` 作为 readback-recovery 唯一确认边界（强制 readback 证据、合并既有 ambiguity 证据、同事务 CAS），claim handler 的 `writePromoLinkClaimed` 改走该边界；X9 `resolveManualReview` 不变 | Claude（Sonnet 编码/Opus 复核） | hermetic backend + 一次性 PostgreSQL 16 容器 p1-07/x9 集成验证；见本轮报告 |
| 2026-09-08 | Phase E — C-24 文章三轴地基（`20260909090000_c24_article_axes`） | `article` 新增 `article_type`/`content_mode`/`seo_visibility` 三列（各配一条命名 CHECK：`article_article_type_check`/`article_content_mode_check`/`article_seo_visibility_check`）与两条索引（`article_seo_visibility_idx`、`article_type_locale_status_published_idx`）；全部由 `NOT NULL DEFAULT`（`novel_article`/`template`/`public`）回填，零回填脚本、零行为变化——本迁移不改任何查询、不改任何写路径，三列截至本行在仓库任何调用点均未被读取。`src/domain/database-statuses.ts` 新增 `ARTICLE_TYPES`/`ARTICLE_CONTENT_MODES`/`ARTICLE_SEO_VISIBILITIES` 三个机器真源常量集合（`ARTICLE_TYPES` 与 `ArticleTemplate.applicable_article_type` 的 `APPLICABLE_ARTICLE_TYPES` 同源去掉 `any`）及 `DATABASE_STATUS_SEMANTICS` 对应逐值语义；`database-schema-dictionary.jsonl` 新增 3 条 `record_kind: "field"`（`db:public:article:article_type`/`content_mode`/`seo_visibility`，`managed_by: "prisma_schema"`）+ 3 条 CHECK 约束记录（`managed_by: "migration_sql"`）+ 2 条索引记录（`managed_by: "prisma_schema"`），本行同步登记（策划文档原文只点名"两条"索引/约束记录，是对既有惯例——每条 CHECK 与索引各自成一条独立字典记录，如 P2-02B 的 `article_template_applicable_article_type_check`——的计数疏漏；本次按惯例足额登记 3+2=5 条，以避免未来一次性 PostgreSQL 16 容器跑 `check-database-dictionary-drift.mjs` 的非 `--static` 目录漂移分支时报缺失数据库对象） | Claude（Sonnet，C-24 施工） | 本轮按工单边界未连接任何数据库：`npx prisma validate`（schema 语法，无 DB）+ `npm run typecheck` + `npm run lint` + `npx vitest run --project node --project ui` 全绿（唯一允许的既有基线失败 `tests/backend/publish-gate/no-bypass.test.ts` 不受影响）。**一次性 PostgreSQL 16 容器 `migrate deploy` 幂等重放 + 双向 `migrate diff --exit-code` 零差异 + `check-database-dictionary-drift.mjs`（非 `--static`）均待后续执行方补跑**，本行状态到那之前不得视为"已验证" |
| 2026-09-08 | Phase E — C-27 博客数据地基（`20260910090000_c27_blog_article_foundation`） | 本迁移净效果是**放宽 + 补强**：放宽 `novel_id` 与推广链接 CHECK，同时新增按类型的 `novel_id` 存在性 CHECK，使小说文章的保护强度与迁移前完全等价。具体三步：(1) `article.novel_id` 由 `NOT NULL` 改为可空（`ALTER COLUMN ... DROP NOT NULL`），零数据改动，存量行全部保持原值；(2) `db:public:article:article_published_promo_link_check` DROP + 同名 ADD，谓词从 `status <> 'published' OR promo_link_id IS NOT NULL` 改为 `status <> 'published' OR article_type <> 'novel_article' OR promo_link_id IS NOT NULL`（§5 第 11 条已同步改写）；(3) 新增 `db:public:article:article_novel_id_by_type_check`（§5 第 11 条新增行）：`(article_type = 'novel_article' AND novel_id IS NOT NULL) OR (article_type <> 'novel_article' AND novel_id IS NULL)`——这是"补强"的那一半，没有它，(1) 会让 `novel_article` 也能在没有 Novel 的情况下发布，是净变松而不是净等价。**不动**的两处按 §一 结构事实与 P1-05B 注意事项裁决：`article_novel_locale_key`（`UNIQUE(novel_id, locale)`）依赖 PostgreSQL 默认 NULL 互不相同语义天然支持多篇博客共存同 `locale`，误加 `NULLS NOT DISTINCT` 会把博客锁死成每 locale 一篇（§5 第 21 条新增登记）；`article_promo_link_novel_fkey`（`(promo_link_id, novel_id)` 复合 FK）保持 PostgreSQL 默认 `MATCH SIMPLE`，任一列 NULL 即不检查，博客两列皆 NULL 天然合法（P1-05B 注意事项"禁止手写为 MATCH FULL"的第二个受益场景）。迁移末尾附 `DO $c27_blog_article_foundation_guard$` 自证守卫：统计 `article_type='novel_article' AND novel_id IS NULL` 的行数，非零即 `RAISE EXCEPTION`（ERRCODE `23514`）——因为本迁移不含任何回填，存量行（全部 `novel_article` 且 `novel_id` 非空）在新 CHECK 下机械恒为零，守卫只防未来误改。**L-3（C-27 review 已登记，migration.sql 本身未改）**：该 `DO` 块内部的 PL/pgSQL 变量名 `non_novel_article_with_novel_count` 命名有误导性——它实际统计的是"`article_type='novel_article'` 但 `novel_id IS NULL`"的行数（即"该有 Novel 却没有"），变量名读起来却像是反过来的"非 `novel_article` 却有 Novel"。这个变量声明与赋值都在 `DO $c27_blog_article_foundation_guard$` 块内，属于可执行 PL/pgSQL 语句而非纯注释，改名会改变 `migration.sql` 的文件字节，进而改变 Prisma 记录在 `_prisma_migrations` 表里的该迁移 checksum；该迁移已在本地栈应用过（checksum 已落库），改名会被下一次 `prisma migrate status`/`migrate deploy` 判定为"迁移文件在应用后被修改"从而报漂移。因此本次**不改动 `migration.sql` 文件本身**，只在此处的治理文档描述文字里记录这个命名缺陷，供以后任何新迁移里如需复用同一条真值统计逻辑时改用更准确的命名（例如 `novel_article_missing_novel_count`）；`migration.sql` 文件里的实际变量名与本迁移的 SQL 语义保持逐字节不变。发布门禁按类型分叉：`src/server/publish-gate/facts.ts`（`loadPublishGateFacts`）在 Novel 不存在时跳过 Novel 软删检查与试读章节查询（`NovelChapter.novelId` 是 `NOT NULL` 列，不能塞可空值）；`src/server/publish-gate/evaluator.ts`（`evaluatePublishGate`）按 `facts.novel === null`（结构上与 `article_type <> 'novel_article'` 等价，由新 CHECK 保证）分叉，非 `novel_article` 只走 locale（读 `facts.article.locale` 而非 `facts.novel.locale`，`facts.novel` 为 `null` 时别无选择，novel_article 分支本身逐字未改——是否把 novel_article 也改读 `article.locale` 仍是待 Owner 签字的独立问题，`规划_...` §4.4/§六 item 6，本迁移不动它）+ 必要元数据 + 页面身份 + 权利阻断（仅 Article 侧，见 C-27 review M-1 修正）四条，跳过试读章节/试读正文/推广链接缺失/推广链接未就绪四条（全部是 Novel 侧概念）——**M-1 修正（C-27 review，本次一并登记）**：C-27 落地时判定器把 `rights_blocked` 整条归入"Novel 侧概念"一并跳过，但 `isRightsBlocked`（`visibility.ts`）是 `novel.status === 'takedown' OR article.status === 'takedown'` 的析取，Article 侧半条与 Novel 是否存在无关——一篇被下架（`takedown`）的博客同样不得发布。评审后改为：非 `novel_article` 分支单独判 `facts.article.status === 'takedown'`（不经 `isRightsBlocked` 本身，因为该函数要求一个 `NovelPublicationState` 入参，这一分支没有 Novel 可传），保留 `rights_blocked` 这一条原因码，只跳过其 Novel 侧半条；`tests/backend/publish-gate/evaluator.test.ts` 里原先断言"该分支下 `rights_blocked` 恒不触发"的用例同步改为断言 Article 侧 takedown 会触发、非 takedown 不触发；`src/server/publish-gate/service.ts`（`applyPublishTransition`）把 Novel 提级、Novel 状态审计快照两处包进"有 Novel"条件，博客只写 Article 一侧；IndexNow/Sitemap 首发派发（`dispatchFirstPublicPublication`）在 `novelId` 为 `null` 时整体跳过（两者今天都是 Novel-only 概念，博客自己的 IndexNow/Sitemap 接线是 C-29 的工作）。公开侧（`src/server/publication/visibility.ts` 的谓词族）**零改动**——公开可见性谓词族此时仍然把博客判为不可见（硬要求 Novel 已发布 + 推广链接已就绪），这是有意的中间态，直到 C-29 打开。`article.novelId`/`article.novel` 可空化后类型层面浮出的每一处非空假设调用点（`src/app/(admin)/articles/[articleId]/page.tsx`、`src/app/(admin)/novels/_lib/read-primary-article.ts`、`src/lib/seo/novel-hreflang.ts`、`src/lib/seo/sitemap.ts`、`src/lib/site/home-carousel-service.ts`、`src/lib/site/queries.ts`、`src/server/articles/service.ts`、`src/server/home-carousel/service.ts`、`src/server/publication/access.ts`）逐一按最小改动收口（条件渲染、类型收窄辅助类型、`article_not_regenerable` 新结果分支等），无一使用 `!` 断言。`database-schema-dictionary.jsonl`：`db:public:article:novel_id` 就地改 `nullable: true` 并补 `llm_constraints`（与字典 Owner 对齐后按§10"同字段语义演进"就地更新，未 supersede，见本行末状态列）；新增 `db:public:article:article_novel_id_by_type_check` 记录（`managed_by: "migration_sql"`）；更新 `db:public:article:article_published_promo_link_check` 既有记录的 `enum_or_check`/`notes`（`introduced_in_migration` 保持原值不变，`evidence` 追加本迁移文件引用，同 P2-02B 对 `article_template_status_check` 的先例）——**计数疏漏说明（同 C-24 那一行的先例）**：策划文档 C-27 节"治理文档与字典的确切条目"第 5 条原文写"新增两条 `managed_by: "migration_sql"` 的 CHECK 记录，更新 `article_published_promo_link_check` 那条既有记录的谓词"，字面读作"两条新增 + 一条更新"；实际落地是**一条全新记录（`article_novel_id_by_type_check`）+ 一条既有记录原地更新（`article_published_promo_link_check`，DROP+ADD 同名不改变量数不算新增）**，即"一新一更新"而非"两新一更新"——本行按实际执行的动作登记，不按策划文档的字面计数。 | Claude（Sonnet，C-27 施工） | 本轮按工单边界未连接任何数据库：`DATABASE_URL=postgresql://x:y@localhost:5432/z npx prisma validate`（schema 语法，无 DB）+ `npm run typecheck` + `npm run lint`（0 error）+ `npx vitest run --project node --project ui` + `node scripts/check-database-dictionary-drift.mjs --static` 全绿（唯一允许的既有基线失败 `tests/backend/publish-gate/no-bypass.test.ts` 不受影响，与 C-24 同一基线失败，非本轮引入）。**一次性 PostgreSQL 16 容器 `migrate deploy` 幂等重放 + 双向 `migrate diff --exit-code` 零差异 + `check-database-dictionary-drift.mjs`（非 `--static`）均待后续执行方补跑**，本行状态到那之前不得视为"已验证"，与 C-24 那一行同一措辞、同一约束 |
| 2026-09-09 | C-30A 换小说地基 + 单篇换绑（施工工单_C30_换小说_移植CPS换租客_2026-09-08.md 单 1，`20260911090000_c30_novel_rebind_foundation`） | 一条迁移，四件事：(1) `novel.title_normalized`（可空 VARCHAR(500)）+ `novel_locale_title_normalized_idx`，CPS `Drama.nameNormalized`/`normalizeName` 平移为 `src/lib/novel/novel-identity.ts` 的 `normalizeNovelTitle`；本迁移不回填，独立幂等脚本 `scripts/backfill-novel-title-normalized.ts` 负责历史行，DO-guard 自证零数据改动。写入维护点截至本轮**只有一处**（`src/server/content-creation/service.ts` 的 `runCreateTransaction`）——施工工单预期的"两处"（创建 + 标题更新）里，标题更新路径在本仓库当前**不存在**（grep 全仓 `\.novel\.(create\|update\|updateMany\|upsert)` 只命中一处会写 `title` 的调用），按工单"发现与事实不符时停下来上报"原样如实登记，未自行新增写入点。(2)(3)(4) 三张新表 `article_novel_rebind_preview`/`article_novel_rebind_batch`/`article_novel_rebind_batch_item`（字段清单、CHECK/唯一/FK 详见 §3.2 与 §5 第 22 条），C-30A 本单范围内均为空表零读写——批量预览/持久化执行的读写代码是 C-30B（单 2，未施工），故本单**未**给这三张表登记 `infra/postgres/grants.sql` 的角色 GRANT（沿用 C-24"先加表/列、读写接线时再登记 GRANT"的顺序）。同一提交内落地：`src/domain/database-statuses.ts` 新增 `REBIND_BATCH_STATUSES`/`REBIND_ITEM_STATUSES`/`REBIND_ERROR_KINDS`（及 `DATABASE_STATUS_SEMANTICS` 对应语义）；两个新能力 `content:rebind`/`content:batch-rebind`（`src/lib/auth/capabilities.ts`，`super_admin` 默认 + `requiresTwoFactor: true`，与 `content:publish` 同档，Owner 2026-09-08 裁决两粒度不合并）；动作注册 `ADMIN_ARTICLE_REBIND_ACTIONS`（`admin.article.rebind_novel`/`rebind_rollback` 写、`rebind_candidates` 读，均登记能力，不复制 CPS 那两个只读漏能力校验的历史缺口）；双闸 `FEATURE_ARTICLE_NOVEL_REBIND`/`ARTICLE_NOVEL_REBIND_ALLOW_WRITE`（五处登记：`src/lib/flags/feature-flags.ts`、`docs/governance/feature-flag-registry.md`、`docker-compose.yml` web 服务块、`scripts/lib/x8-levels.json` 三档全 `false`、`scripts/acceptance/x8-validate-compose.mjs`；C-30B 批量预览快照写入的单闸例外已提前在这五处写清楚，本单不落地该例外的消费代码）；单篇换绑服务 `src/server/article-rebind/`（`errors.ts`/`guards.ts`/`service.ts`/`index.ts`）——九条守卫（附录 D）、恰好两字段的原子 `updateMany`（`{novelId, promoLinkId}`，🔴 由 `tests/backend/article-rebind/service.test.ts` 逐字断言锁死）、审计改用既有 `operation_audit`（`action: "article.rebind_novel"`/`"article.rebind_rollback"`）、事务外安全失效（`revalidatePublicArticlePaths`，URL 不变路径不变）；编辑页面板 `src/app/(admin)/articles/_components/article-rebind-panel.tsx`（搜索式目标选择器、零裸 UUID、三档守卫横幅、"分类将随之变更"常显提示）经 `[articleId]/page.tsx` 接线，仅在 `article.novel !== null` 分支渲染。IndexNow：单篇换绑**不入队**——CPS 自身的 `switchArticleDrama`/`switchArticleDramaAction` 全文 grep 零 "indexnow" 命中，只调用 `revalidatePath`，本单据此镜像不入队并落一条源码扫描负向测试锁死。`src/lib/flags/README.md` 标注"Owner: Codex（独占写入）"未拦这次编辑——施工工单显式把 `src/lib/flags/feature-flags.ts` 列入本单五处登记之一，按工单要求执行。 | Claude（Sonnet，C-30A 施工） | 本轮未连接任何数据库：`DATABASE_URL=postgresql://x:y@localhost:5432/z npx prisma validate` PASS；`npm run typecheck`（0 error）；`npm run lint`（0 error，4 条既有警告，与本轮改动前的基线数量逐字相同）；`npx vitest run --project node --project ui`（4138 passed / 171 skipped，唯一失败 `tests/backend/publish-gate/no-bypass.test.ts`——已用 A/B 复核：同一条命令在未改动的 `215b109` 基线上跑，命中同一用例、同一 `scripts/s1-exact-target-structural-smoke.ts` 命中点，逐字相同，与本轮改动无关）；`node scripts/check-database-dictionary-drift.mjs --static`（`{"status":"ok","models":52,"recordCount":1209,"activeCount":1139}`，脚本内两处硬编码模型计数 49→52 一并更新）。新增测试：`tests/backend/article-rebind/`（guards.test.ts 18 例、service.test.ts 25 例含 IndexNow 负向 3 例、backfill-novel-title-normalized.test.ts 6 例）、`tests/backend/flags/article-novel-rebind-flags-passthrough.test.ts`（6 例）、`tests/ui/article-rebind-panel.test.tsx`（12 例）、`tests/ui/article-rebind-page-wiring.test.ts`（3 例）、`tests/ui/article-rebind-capability-projection.test.ts`（5 例）、`tests/integration/article-rebind/two-field-atomic.test.ts`（`C30_DATABASE_TEST=1` 门控，4 例，**未执行**——本 worktree 无 PostgreSQL 连接，按 `c27-blog-article-postgres.test.ts` 先例如实登记待执行）。因既有 schema 变化导致三处既有静态测试的硬编码计数同步更新（`tests/backend/database/p1-05b-static.test.ts` 49→52、`tests/backend/database/p1-06-static.test.ts` 1130→1209、`tests/backend/tagging/p2-06-5-governance.test.ts` 49→52）与一处既有列表断言追加三个新 action id（`tests/ui/admin-content-registry.test.ts`）。**一次性 PostgreSQL 16 容器 `migrate deploy` 幂等重放 + 双向 `migrate diff --exit-code` 零差异 + `check-database-dictionary-drift.mjs`（非 `--static`）+ 本行登记的集成测试均待后续执行方补跑**，本行状态到那之前不得视为"已验证"，与 C-24/C-27 两行同一措辞、同一约束。C-30B（批量预览/持久化执行/批量界面，施工工单单 2）不在本轮范围。 |

## 13. 待跟进项（Schema 变更队列，Owner 待批）

本节登记"已识别、本轮因 schema 冻结未处理"的数据库变更需求，供下一轮 migration 排期时核对；
未经 Owner 批准不得抢跑新增 migration。

| 登记日期 | 提出方 | 表/字段 | 现状 | 建议变更 | 依据 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-18 | Claude（Stream A，P2-07 合并前复核） | `operation_audit`（`prisma/schema.prisma:755-774`） | 仅 `@@index([requestId], map: "operation_audit_request_idx")` 普通索引；`(actor_type, action, entity_type, entity_id, request_id)` 无唯一约束 | 新增部分唯一索引 `(action, entity_type, entity_id, request_id)`（或含 `actor_type`），使 `src/server/publish-gate/service.ts` 的写口/权利态转换幂等判定从"应用层 check-then-insert（仅顺序重试安全）"升级为"数据库层强制（并发安全）" | `scratchpad/reports/A-REVIEW.md` 必改 2：`OperationAudit` 无唯一约束⇒P2002 恢复分支为死代码⇒并发同 `requestId` 提交可双写审计行 + 双发 `dispatchFirstPublicPublication`。本轮范围内 schema 已冻结（`P2_07_12_一轮实施分工方案_2026-08-12.md`），不新增 migration；已在 `service.ts` 相应位置的注释与本文件 §12 变更日志如实标注该限制，不作虚假的并发安全声明 |
