# P1-03 · 必须修订项

> 适用结论：当前架构包必须修订  
> 本文件只规定架构/契约修订，不授权任何业务代码、Schema、Migration、Worker、Scheduler、Adapter、页面或部署实现。  
> 所有阻断级项关闭并经二次 SOL 5.6 独立审计后，才可重新评估实现 Gate。

## 1. 修订纪律

1. 不修改 CPS。
2. 不覆盖或静默改写 `candidate-v0.2.1`；新建下一版本候选，并用 changelog/ADR 记录 supersedes。
3. Claude 原始六份文件保留为本次审计输入；修订应形成新版本或明确的审计响应稿。
4. 冻结基线、正式实施台账和事实库不允许只写“已对齐”；必须给页面 ID、状态、最后修改时间、快照时间和按规范化规则生成的内容哈希。
5. 每项修订必须有唯一 Owner、不同且真实独立的 Reviewer 执行体、证据路径与验收条件；只切换同一执行体的角色不算独立复核。
6. 状态、字段、权限、事务与错误语义必须能落为可编译合同或表格化真源，不能只靠散文互相引用。

## 2. 阻断级修订

### R-01 · 固化已确认需求基线

**Owner**：GPT+Notion（整理）/ Weifeng（批准）  
**Reviewer**：SOL 5.6 架构审计

必须：

- 将 [海外阅读 V1 · 已确认需求与工程基线 v1.0](https://app.notion.com/p/1145334700974e6e84b8214ff16eaaa4) 作为最高优先级 P1 真源，并导出 [P1 实施任务台账](https://app.notion.com/p/9ec8ed7c084842318f77c454b9473388)；
- 导出四个正式事实库中适用 P1、Gate A/B、全局的当前行；
- 每行保留 page/data-source ID、状态、Owner、最后修改时间、来源证据和验收标准；
- 先定义去除抓取时间等动态字段的规范化规则，再生成不可变快照清单与 SHA-256；
- 冻结唯一优先级：P1 冻结基线、可追溯 Owner 新裁决、正式已确认/已验证条目、候选、历史快照如何比较；
- 候选不得被文档写成已确认；被替代条目不得继续成为实现依据；
- 定义快照之后事实库发生变化时的 change-control/ADR 和重新审计触发条件。

**关闭证据**：`requirements-baseline-manifest`（或等价文档）+ 冻结页/实施台账/四库查询快照 + 可追溯 Owner 批准证据 + 规范化说明与哈希。

### R-02 · 清理事实冲突和伪冻结状态

**Owner**：Weifeng（产品/风险裁决）；Claude 与 GPT+Notion 只负责方案整理、文档修订和状态回写  
**Reviewer**：Codex SOL 5.6

至少关闭：

- 冻结基线已替代统一 `splitRatio >= 50`，但字段字典未传播“被替代”；必须区分“全量入 SourceItem”和“机器发布门禁阈值待 Owner 定”；
- P1 必须容纳多 ChannelAccount 已冻结；需删除逻辑模型中的 V1 单账户句子，同时保持收益归因/结算关系为未证；
- 阅读器手动主题覆盖/持久化/字号/行高/页宽/滚动记忆/无整页刷新章节切换；
- “试读章节页面可进入 SEO”与“正文是否允许全文索引、长期缓存、截断阈值”分开定义并取得 Owner 裁决；
- 推广真实值 admin 明文 vs 掩码+能力位 reveal；
- D-8 已由冻结基线的 URL 形态关闭，D-7、D-12、W6、纸色和发布门禁阈值对具体阶段/文件的准确影响；
- 原子领取、Cron、数据库角色分离的内部合同应在审计前冻结，但正式实现与并发验证属于审计通过后的 P1-05～P1-08/P1-13；
- Claude 执行包的 P1-01～P1-12 与正式 P1-00～P1-15 台账逐项重映射，尤其恢复 P1-03=SOL 5.6 架构独立审计。
- P1-01/P1-02/P1-03 的实际交付证据与台账“未开始”状态 reconciliation；本轮 `docs/p1/audit/` 相对正式默认 `docs/architecture/audit/` 的 Owner path override 留痕。

每项必须选择：确认、候选、不阻塞、阻塞、被替代；不得用勾号替代正式状态。

**关闭证据**：冻结基线/实施台账/事实库 supersedes 链 + 新候选版本的逐项对账表，零未解释冲突。

### R-03 · 建立唯一正式仓库身份与隔离验收

**Owner**：仓库 Custodian（Owner 指定）  
**Reviewer**：Codex

架构必须冻结：

- canonical realpath、Git remote、默认分支和 worktree 规则；
- 启动前 `git rev-parse --show-toplevel`/remote/HEAD 校验，cwd 不匹配即 fail closed；
- 无 CPS 符号链接、submodule、本地 path dependency、相对路径引用；
- 独立 compose project、network、volume、`.env`、secret、对象存储 prefix、端口；
- CPS before/after status 与关键路径哈希报告格式；
- Notion 中出现的 `cdfb75e`、`d4e4bf9...` 与本包 `d77c3b9...` 分别代表“来源提交/审计快照/当前参照基线”的明确口径。

**关闭证据（架构合同 Gate）**：canonical target/remote reservation、preflight 规则和 shadow-repo 风险处置方案已批准；CPS clean。实际 `git init/clone`、branch/worktree 与自动校验属于审计通过后的正式 P1-04 Foundation 任务，不要求在本轮提前实现。

### R-04 · 重写模块所有权

**Owner**：Claude 提案  
**Reviewer**：Codex；Owner 终裁

必须先解决正式 [职责与 Gate](https://app.notion.com/p/12253cd826f64aa7897a41399083291e) 与 `P1_MODULE_OWNERSHIP.md` 的冲突。每个路径只能有一个写 Owner；“共享”路径必须改成：

- 唯一 merge custodian；
- 非 custodian 只提 contract/PR；
- 明确 review 与合并顺序。

必须覆盖：

- `package.json`、lockfile、tsconfig、Next/Tailwind/ESLint 配置；
- CI、Dockerfile、compose、infra、scripts；
- `src/proxy.ts`、instrumentation、root layout、globals；
- login/2FA、i18n/messages、public assets；
- `src/contracts`、`src/domain`、generated Prisma client；
- admin UI、public UI、server actions/API；
- `tests/ui`、`tests/backend`、`tests/integration`、fixtures；
- `docs/p1/audit` 的独立审计所有权。

**关闭证据**：与冻结基线/正式任务台账一致、无共享写 Owner/无 owner/重叠 glob 的机器可检 ownership map + CODEOWNERS 设计稿 + 并行集成顺序。

### R-05 · 将共享契约升级为可执行冻结合同

**Owner**：Claude/Codex 各自负责生产侧；契约 Custodian 唯一合并  
**Reviewer**：SOL 5.6

必须新增并冻结：

- 可编译 TypeScript DTO、enums、result/error codes；
- 数据 nullability、version/revision、幂等键和事务边界；
- Auth/Capability、Credential、Task、Worker lease、Scheduler、IndexNow、Sitemap、Tracking、public read/CTA 的跨侧合同；
- producer/consumer contract tests 计划；
- 契约版本和破坏性变更 ADR 规则。
- 对未证外部合同只冻结 `UNPROVEN/registered_disabled`、reason code、禁止调用路径与解冻前置；不得为通过 Gate 猜写 `claimPromo` Endpoint/Body、收益字段或北斗协议。

同时修正：

- 公共可见性必须同时要求 `Article.status=published`、`Novel.status=published`、允许的章节状态、locale 白名单和非软删；
- 多 PromoLink 时 CTA 的确定性选择规则；
- D-8 按冻结基线关闭；D-12 未决期间不得冻结依赖目录承载形态的消费者。

**关闭证据**：所有已证内部核心合同 FROZEN；未证外部 wire contract 显式 disabled；两侧可从同一枚举/DTO 设计真源生成；无互相矛盾的散文定义。

### R-06 · 冻结 Worker claim/lease/fencing 合同

**Owner**：Codex  
**Reviewer**：数据库工程师

必须定义：

- pending claim 与 expired lease recovery 两条 SQL/索引合同；
- 不可复用的 `execution_token` + 递增 `lease_epoch/fence_version`（或等价 generation）；
- 租约产生/比较只用数据库时钟；heartbeat/finalize 需验证 token/generation、当前 owner 和数据库时钟下仍有效，不精确匹配会被心跳更新的旧 `locked_until`；
- 每次受保护业务写事务先锁/guard item lease，再在同一事务写幂等业务行、outbox、operation audit 和 item terminal transition；或由业务行持有 fence version 并拒绝旧 epoch；
- 无法同事务的 handler 必须有明确幂等键与确定恢复规则；parent task 计数/派生与 item 终态同事务更新，或可从 item 真源确定重算；
- guard 影响 0 行时不得再发新网络请求或提交本地业务结果；
- 区分 task lease token 与 side-effect attempt token；失去 task lease 后，允许用合法 attempt token补录已经发生调用的 outcome；
- attempt/max-attempt、backoff、poison item、dead-letter、shutdown/drain；
- at-least-once 语义，禁止宣称 exactly-once；
- Worker 失联、GC pause、网络超时、租约跨越、时钟偏差的测试矩阵。

**关闭证据（设计级）**：不变量、状态转移表、SQL 伪合同和故障注入测试计划，证明租约失效后的旧持有者不能提交受保护写；实际并发执行证据属于 Foundation Verification Gate。

### R-07 · 冻结 Scheduler 单例与时间语义

**Owner**：Codex  
**Reviewer**：数据库工程师

必须新增 `CronRun/ScheduleRun` 物理实体，定义：

- `scheduled_for timestamptz` 由冻结的 schedule definition + `schedule_revision` + 业务时区/DST 重复或缺失小时规则确定性计算，`(schedule_key, scheduled_for)` 唯一；
- 是否 due、misfire/catch-up 窗口和写入时间只使用数据库时钟判断；
- CronRun 与 Task 建立唯一关联/FK，并在同一事务创建；
- misfire、有限 catch-up 窗口/最大补跑数、迟到和重跑；
- 人工触发使用独立 trigger id，不伪造 scheduled instant；
- Scheduler 单独最小权限角色，不复用可解密凭证的 Worker 角色；
- 10 实例并发、事务失败、enqueue 失败、进程崩溃测试。

**关闭证据（设计级）**：Scheduler 合同与测试计划能证明同一 scheduled instant 最多一个逻辑 enqueue，事务失败可由其他实例重试，且不会出现只有 marker 无 task。

### R-08 · 统一全部状态机

**Owner**：Codex（生产者）+ Claude（UI 消费者）  
**Reviewer**：架构审计师

建立单一状态真源，至少覆盖：

- CatalogScanTask/Item；
- ChannelSyncTask/Item；
- GenericTask/Item；
- IndexNowOutbox；
- Article、Novel、NovelChapter；
- Credential 与 PromoLink。
- SideEffectIntent/SideEffectAttempt；
- CronRun/ScheduleRun；
- ManualReview/Reconciliation；
- sitemap version；
- durable Tracking delivery/outbox（若选择 durable）。

每个实体必须列：初始态、active/terminal 态、合法转移、expected state/revision、actor、reason、guard、side effects、retry/pause/cancel/dead-letter、并发冲突码、HTTP/UI 映射和 DB CHECK。active 集合与部分唯一索引 predicate 必须共用真源；明确 parent item-count 派生与 pause/cancel/disabled 优先级、`cancel_requested` 对在途调用的处置，以及 retry 是新 attempt、重置 item 还是新 task。解决四表/六表、五态/六态、`partial_failed` 缺失、IndexNow 五态/七态和 Article 枚举冲突。

**关闭证据（Stage A）**：状态机真源、代码/DB/UI 生成规则、消费者映射与 transition/drift 测试计划冻结，零“同上”。Stage B 再验证实际 Schema/UI/Worker 引用同一生成物。

### R-09 · 拆分副作用意图与本地业务审计

**Owner**：Codex  
**Reviewer**：安全与数据库双审

必须：

- 把 `side_effect_intent` 和本地 `operation_audit` 定义为两个清晰概念；
- intent 在网络调用前独立提交；
- 本地业务写、outbox、operation audit 同事务；
- 按效果类型冻结 key：不可重复领取的永久 `effect_key` 描述账户+资源+业务操作，不含 credential/request revision；IndexNow、对象存储发布等版本化效果则包含不可变 desired-state revision（如 URL revision、sitemap generation/version），允许新 revision 产生新效果；
- 所有 key 都不得包含可变时间戳、重试次数、随机数或 credential revision；
- `attempt_key/request_fingerprint` 单独记录实际 credential revision、协议版本和脱敏请求摘要；
- non-repeatable 操作的 `success` 与 `unknown` 都持续占用永久业务键；一个 intent 下只有在合同证明安全时才允许新 attempt；
- 上游若支持 idempotency key，必须持久化并在所有安全重试中复用；
- 用原子 `INSERT ... ON CONFLICT`/唯一约束取得调用权，禁止 query-then-insert；
- 禁止“查询最近一条再决定”的无锁 TOCTOU；
- 定义 timeout/unknown/manual reconcile 和永不自动重试边界；
- 说明 append-only 与 outcome 更新采用事件追加还是受控状态转移。
- 建立逐操作策略表，至少覆盖 Promo Claim、IndexNow 与对象存储发布的 repeatability、readback、unknown 和人工对账。

**关闭证据**：崩溃点表覆盖 intent 前、intent 后/调用前、调用中、调用后/回写前、回写后；每点都有唯一恢复动作。

### R-10 · 冻结 Auth 默认拒绝与能力矩阵

**Owner**：Codex  
**Reviewer**：安全审计

必须：

- `(admin)` layout/命名空间负责页面 AuthN，但不能替代 Route Handler/Server Action 自身的 AuthN+AuthZ；
- API 统一放入 `/api/admin/**` 或等价私有命名空间，并在传输层默认认证；
- 每个 mutation 在 Route/Action 和服务层都校验 capability/AuthZ，避免从其他已认证入口绕过；
- 未登记 route/action fail closed；
- Server Action exports 进入显式或机器生成注册表；
- 若有 `/api/internal/**`，冻结 service-to-service identity、replay 与密钥轮换；
- 为每个读写操作映射 session、capability、feature flag、allow-write、dry-run、audit；
- 冻结 capability 撤销/session 过期后，延迟高风险任务采用入队授权快照还是执行时重新授权；system actor 使用独立 service capability；
- 明确 CSRF/Origin、cookie、安全头、replay、rate limit；
- 冻结 401/403/404/409/429 语义；
- 设计静态 CI 扫描，能发现新增但未 guard 的 admin route/action。

**关闭证据**：完整 endpoint/action × guard matrix + 负向测试清单；`PROTECTED_PREFIXES` 不再被当作 API 安全边界。

### R-11 · 修正 Credential/Web/Worker/Scheduler 边界

**Owner**：Codex  
**Reviewer**：安全与数据库双审

必须选定一个可部署拓扑，不能保留多个“实现时任选”方案。默认安全方案：Web 只提交校验任务；独立 credential executor 进程以独立连接池、DB role 和 secret distribution 解密并返回脱敏结果。若 Owner 选择专用 admin service，它必须是物理独立的受信解密主体；单靠 DB function/`SECURITY DEFINER` 不能隔离仍持 Node 密钥的 Web 进程。

同时：

- 给出完整 LOGIN/NOLOGIN 角色继承图，覆盖 public/admin Web（若同一 Next 进程则必须承认同一信任边界）、credential executor、worker、scheduler、migrator、analyst、backup；
- 分开描述新凭证录入、存量凭证本地复核、Worker 出网使用三条流程；
- `public_web`、`admin_web`、credential executor、worker、scheduler 不得共用过宽角色或连接池；
- Scheduler 环境不注入解密 key，只能读取 schedule 配置/执行 enqueue procedure；
- Worker 出网使用渠道 host allowlist；
- 凭证读取、换证、停用、校验、指纹冲突分别列 GRANT；
- secret 不得进入 Task result/error、audit 或 structured log；
- UI 永不回显密文；是否显示推广真实值必须按 R-02 的最终裁决执行；
- `validateJwtLocally` 改名/描述为结构与 exp 检查，不能暗示签名验证。

**关闭证据**：调用序列图 + 每角色表/列/function 权限矩阵 + 泄露面分析。

### R-12 · 冻结物理 Schema 与并发约束

**Owner**：Codex 草拟  
**Reviewer**：Claude（读模型）+ 数据库工程师

必须给每表：

- PG 类型、null/default、CHECK、FK action、唯一/普通/部分索引及 predicate；
- 软删策略和永久标识例外；
- `jsonb` schema/version、敏感列、保留期；
- raw/upstream 值与 public view/secure view；
- active task、credential fingerprint、public code、idempotency key 的 DB 级约束；
- overlap scope 的原子方案；
- 审计表 append-only/no UPDATE/DELETE 策略；
- 事务隔离与 serialization/deadlock retry。
- 物理数据库和 SQL migration 是部分唯一索引、复杂 CHECK、trigger、ACL、view/function 的权威；Prisma schema 仅作 ORM 映射；
- 生产禁止 `prisma db push`，并定义 drift/introspection 审计，防手写 PG 约束被丢失。

**关闭证据**：物理 schema specification 可无歧义转成 Prisma 映射 + SQL migration；所有逻辑唯一性均有 DB 兜底，手写 PG 特性有 drift 与 migration-level 测试计划。

## 3. 高风险必修项

本节在当前 Architecture Contract Gate 要求的是设计合同、禁用边界、Owner 和测试计划，不要求提前提交实现或运行结果。实际 SQL/CI/并发/恢复证据在审计通过后的 Foundation Verification Gate 取得。只有明确 `registered_disabled`、不在调用路径且已有后续 Gate 的未证外部能力，才可按阶段延后。

### R-13 · 完整 PostgreSQL 运行参数与网络安全

冻结完整角色拓扑和每角色参数：

- 运行角色全部 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，明确 LOGIN 与 NOLOGIN group；
- REVOKE `PUBLIC` 对应用 database/schema 的不必要 CONNECT/CREATE，以及默认 function EXECUTE；
- `ALTER DEFAULT PRIVILEGES` 由实际 object owner 设置；敏感表使用列级 GRANT 或安全 view，而不是先授表级 SELECT 再口头排除密文；
- 安全固定 `search_path`；所有受控 function schema-qualified，若有 `SECURITY DEFINER` 则 function 内显式 `SET search_path`、无动态 SQL、`REVOKE PUBLIC`、最小 EXECUTE；
- 每角色 `statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout`、UTC、连接池预算、TLS/SCRAM、`listen_addresses`/pg_hba、慢查询、`pg_stat_statements` preload 和 `application_name`；
- intent、credential、outbox、Cron marker 等关键事务通过事务封装显式 `SET LOCAL synchronous_commit = on`，启动/集成测试校验且代码禁止设置 off；不得误称仅靠 role ACL 就能阻止 USERSET 覆盖；
- Web 等默认 READ COMMITTED；只有经证明的不变量使用 SERIALIZABLE/显式锁，按 SQLSTATE `40001`/`40P01` 有界重试整个事务；
- migration/backup 使用独立 timeout，migration 保持有限 `lock_timeout`；
- 网络调用绝不在数据库事务内。

**验收**：配置矩阵覆盖 dev/staging/prod；池上限之和与管理/备份余量有数字证明。

### R-14 · 安全迁移角色与发布流程

采用 NOLOGIN owner group + 临时 production deploy migrator/`SET ROLE` 或等价最小权限方案；冻结 schema/sequence/function/default privileges、单一迁移协调机制、expand-contract，以及应用启动绝不自动 migrate。

- Prisma shadow DB/role 只用于 dev/diff 工作流；production deploy principal 不持 CREATEDB；
- Prisma Migrate 内建锁或经验证的外层锁二选一并说明，不无条件叠加自定义 advisory lock；
- 回退优先 application rollback + roll-forward；不可逆 DDL 不承诺 down migration，灾难恢复走 PITR/restore。

**验收**：Web/Worker DDL 被拒；迁移可独立执行；失败不会让应用启动过程半迁移。

### R-15 · 修正备份与 PITR

分开定义：

- 逻辑备份：`pg_dump`；
- 物理 PITR：physical base backup + 连续 WAL archive。

补齐 physical backup 工具/一致快照、连续 WAL、`restore_command`、timeline/history、backup manifest、归档监控、加密、异地、保留期、RPO/RTO、密钥可用性、restore drill、校验和业务一致性核对。角色/授权等 cluster globals 由 IaC 重建或单独保护；WAL 归档目标必须独立于 PG volume。

**验收**：恢复演练计划能从指定时间点恢复，而不是把 `pg_dump` 当作 WAL base；同时校验 timeline、约束、关键业务不变量、credential key 可解密和 RPO/RTO。

### R-16 · 冻结 Credential 密码学与轮换

承认 CPS envelope 已有格式前缀 `v1`，并补齐真正缺失的密钥生命周期合同：

- 用 HKDF domain separation 或等价方法分离 encryption 与 fingerprint 域；
- encryption DEK 可按 `kid` 轮换；
- fingerprint key/version 必须跨加密轮换稳定，或支持多版本并行查重，避免换密钥绕过去重；
- ciphertext 保存 format version + key id；AAD 只绑定加密前已知且不可变的 account UUID、credential UUID、schema version；
- dual-read/single-write、回滚、备份恢复和 key 可用性演练；
- key material 不进 DB、日志或备份正文；
- 补建指纹唯一实体/约束，不再称“两表”却依赖第三表。

**验收**：旧密钥轮换、错误 AAD、篡改、重复凭证、恢复后解密均有设计级测试。

### R-17 · 修正永久公开短码

选择 append-only registry/tombstone；或全局非部分 UNIQUE + PromoLink 禁止硬删/永久保留 tombstone。冻结长度、ASCII alphabet、大小写 normalization、reserved words、`COLLATE "C"` 或等价 byte-wise 语义、最大冲突重试和生成失败错误。唯一冲突重试使用 `INSERT ... ON CONFLICT DO NOTHING RETURNING`、savepoint 或新事务。多账户/多来源下冻结 CTA 选链策略。

**验收**：软删后旧码永不指向新资产，并发分配只有一个稳定结果。

### R-18 · 消除作用域重叠 TOCTOU

对需要禁止部分重叠的任务，使用持久化 `active_task_target_membership`（每 target active 唯一）或可由 exclusion/unique 证明的规范化 scope。Task terminal transition 与 membership release 必须同一事务；部分唯一 predicate 以 `released_at IS NULL`（或等价 active 真源）为准。定义 orphan membership repair/reconciliation：修复时锁 task+membership、写审计。Advisory lock 只能按稳定 target key、固定排序串行化“检查+写 membership”，不能在事务结束后替代长期 active 约束；多 target 必须定义获取顺序以避免死锁。

**验收**：两个不同 hash 但目标相交的并发入队中，最多一个成功。

### R-19 · 建立写能力双闸注册表

建立分类注册表：

- 产品/运营 mutation：capability + feature + allow-write + dry-run/audit；
- 外部副作用：再加执行时 kill switch、durable intent、幂等/unknown 策略；
- heartbeat、audit、outcome、reconcile、cleanup、cancel/dead-letter 等安全基础写：不受业务 feature 关闭影响，但受最小 DB 权限和状态 guard；
- Worker 在执行时重查 feature/allow-write；用户 capability 按风险冻结“入队授权快照”或“执行时当前授权”，Scheduler/system actor 使用独立 service capability。

覆盖 promo claim、IndexNow、sitemap refresh、channel worker、tracking 等当前未闭合项目。

**验收**：需要业务闸门的操作任一条件缺失都 fail closed；基础安全写不因 kill switch 关闭而失去审计/恢复能力；队列旧任务按注册策略重新检查。

### R-20 · 补齐后台 CPS parity 与运维处置闭环

补充：

- 操作审计/日志入口；
- Scheduler run/misfire；
- Worker lease/stale recovery；
- dead-letter/redrive；
- unknown locale；
- `claim_retry_blocked` 人工对账；
- task enqueue/pause/cancel/retry 能力位；
- IndexNow 与 sitemap 失败处置；
- 原因、行为人、时间、影响范围审计。

每处与 CPS 不同的能力必须单独列 `ADAPT/ORIGINAL_REQUIRED/DROP` 和理由，不得只在汇总项中打包。

同时消除后台规格内部歧义：北斗 API 配置到底“删除”还是“可见但禁用”只能有一个答案；凭证/推广 reveal 策略按 R-02 的 Owner 裁决执行。

**验收**：菜单、页面、字段、操作、能力位和审计事件形成一一对应矩阵。

### R-21 · 修正公开读、Tracking、Health、Sitemap 合同

必须：

- 公共读统一状态判定；
- Tracking 明确 durable 或 lossy、丢失预算、batch/flush/backpressure/shutdown/retry/dead-letter/retention/salt version；
- public liveness 只返回最小状态，版本/commit/flag/DB diagnostics 放内网或鉴权 endpoint；
- sitemap 使用 versioned object、原子 pointer、last-known-good、namespace、cache invalidation。

**验收**：发布/下架/撤回可原子地产生正确 outbox，观测系统故障不泄露配置也不阻断主请求。

### R-22 · 修正深色主题合同与前端所有权

按正式已确认需求恢复：

- 阅读器默认跟随系统；
- 用户手动覆盖优先于系统并持久化；
- 字号、行高、页宽调节；
- 滚动位置记忆、章节切换不整页刷新；
- 长文分段渲染、移动端优先、目录与上下章导航；
- `.admin/.site/.reader` scope；
- 共享 UI 的语义 token 映射；
- `color-scheme` 与原生控件；
- 具体 light/dark reader tokens；
- WCAG AA 和系统/手动切换视觉回归。

D-12/W6 可保持待决，但必须精确写“不阻塞后端、阻塞哪些前端文件”；纸色是否一期上线明确归 Weifeng 裁决。不得删除其他已确认能力。

**验收**：需求、设计 brief、所有权和测试矩阵四者一致。

### R-23 · 增加 SQLite 残留静态门禁

设计 CI 规则与 fixture 计划，审计通过后的 Foundation 阶段再实现扫描。规则必须阻止：

- Prisma `provider = "sqlite"`、`file:` datasource；
- `PRAGMA`、SQLite busy retry/helper；
- `UPDATE ... id=-1` 伪锁；
- SQLite 日期函数、boolean/int 假设；
- 未加引号 camelCase raw SQL alias；
- SQLite 生成客户端或 CPS 本地路径依赖。

**验收（当前 Gate）**：每类残留的匹配规则、误报边界、失败 fixture 与 PG 合法对照计划已冻结。实际 CI 和 fixture 执行证据归 Foundation Verification Gate。

### R-24 · 原子化 CPS 偏离分类与证据追踪

**Owner**：Claude（矩阵）  
**Reviewer**：Codex SOL 5.6

必须：

- 把“埋点批量写 / sitemap 对象存储 / sitemap SQL”等打包项拆成原子条目；
- 每条标 `COPY_AS_IS/ADAPT_FOR_NOVEL/PG_REIMPLEMENT/ORIGINAL_REQUIRED/DROP`；
- 每条给 CPS `file:line`、前提差异、Owner、唯一写路径、设计验收和后续验证 Gate；
- 密钥/AAD、NOLOGIN owner、PITR 等安全加固同样分类，避免成为无来源原创；
- 建立 `A-ID → R-ID → G-ID → source evidence → phase` 的追踪表。

**验收**：不存在一个分类条目覆盖多个独立风险/验收；所有审计发现均能追到修订、Gate 和证据。

## 4. 修订完成定义

只有同时满足以下条件，才可请求二次审计：

- R-01 至 R-24 全部有架构合同级关闭证据；
- 正式需求快照与新候选版本零未解释冲突；
- 所有已证内部阻断级契约已 FROZEN；未证外部合同以 `UNPROVEN/registered_disabled` 冻结禁用边界；
- 模块路径无共享 Owner、无人负责或重叠 glob；
- CPS 保持 clean，Claude 原始六文件与 candidate-v0.2.1 哈希不变；
- 没有任何正式业务实现提交；仓库、CI、SQL 与并发执行证据留给审计通过后的 Foundation 阶段；
- 二次审计输入列出完整变更集、哈希和 supersedes 关系。
