# P1-03 · 海外阅读 P1 SOL 5.6 独立架构审计

> 审计时间：2026-08-02 18:12 JST  
> 审计性质：独立、只读、仅审计；未开始前端、后端、数据库或基础设施实现  
> 审计角色：架构审计师、后端开发负责人、数据库工程师  
> 审计模型：SOL 5.6；架构/CPS、后端/契约、数据库/安全三条独立子审阅后由主审交叉复核  
> Gate：关闭

## 1. 审计结论

当前架构包方向基本正确，尤其是“默认复刻 CPS、按符号搬运、显式排除 SQLite 单写者技巧、独立 PostgreSQL/Worker/Scheduler”的主线。但它尚不能作为 Claude 与 Codex 的并行编程合同。

本轮确认了足以关闭实现 Gate 的阻断级问题，并记录必须在后续阶段受控关闭的高风险问题。核心不是缺少更多设计文字，而是若干关键语义互相矛盾或尚未形成可执行契约：

- Notion 已存在明确声明为 P1 唯一需求真源的冻结基线和正式 P1 实施台账；candidate 当时如实声明未读四库，但 Claude 六份文档在进入 Gate 前仍未完成对账、快照与哈希，并且重用了错误的 P1 任务编号。
- Worker 有领取锁和租约字段，却没有冻结 fencing/CAS 规则；租约过期后的旧 Worker 仍可能写业务结果或重复触发上游副作用。
- candidate/P1 文档把“外部副作用前先提交意图审计”与“本地操作审计和业务同一事务”的术语混用，未冻结两个不同事务边界。
- Admin API 的默认拒绝、Credential 的解密主体、Web/Worker/Scheduler 数据库角色边界未闭合。
- 物理 Schema、任务/IndexNow 状态机、CronRun、迁移权限和恢复链路尚未冻结，却在执行包任务表中被标为完成或冻结。
- 模块所有权既与正式已确认的职责条目冲突，也留下多处共享或无人负责的高冲突路径。
- 阅读器的手动主题覆盖与持久化被 Claude 文档明确删除，和正式已确认需求相反。

因此，本次审计可完成且修订路径明确，不属于无法审计；但实现 Gate 必须保持关闭。

## 2. 输入与证据身份

### 2.1 本地输入

| 输入 | 实际位置/身份 | 审计状态 |
| --- | --- | --- |
| candidate-v0.2.1 | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/docs/architecture/candidate-v0.2.1/`，10 个文件 | 已读 |
| Claude P1 六份文件 | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel/docs/p1/` | 已读；原文件未修改 |
| CPS 基线 | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`，HEAD `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | 审计前后 `git status --porcelain` 为空 |
| 审计任务启动目录 | `/Users/chenweifeng/Documents/cps海阅` | 空 Git 仓库，非输入仓库 |
| 规划的新项目目录 | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel` | 与 CPS realpath 分离、无符号链接，但当前不是 Git 仓库 |

Claude 六份文件的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `P1_ARCHITECTURE_EXECUTION_PACKAGE.md` | `70acbf529a9533b2d2449c2d0963187e497bf8ac05066077306d9d59ed87bb2f` |
| `P1_CPS_PARITY_MATRIX.md` | `fd89b4cc6e90bb27ed8758fa58a07a2fe2996d5cc27faa930ec0c75a7f23779e` |
| `P1_MODULE_OWNERSHIP.md` | `2864a006f547810c12b28f8acd6ad61d19872f39d7c56a02d4a616c2952e58f3` |
| `P1_SHARED_CONTRACTS.md` | `d8d69fc389f168e1b4e8d62c4c56ff672d229a1f41a22406e2684a0fe573fb68` |
| `P1_DARK_DESIGN_BRIEF.md` | `8dc7ada249a34fc1a317bb8a39342c1394673161349fa22c45e595e4c027ba4f` |
| `P1_ADMIN_PARITY_SPEC.md` | `625e09a49a6cad0034d130194fc05cddb457eeea7d651e50dad8e28053d7fd05` |

candidate-v0.2.1 的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `CHANGELOG-v0.2-to-v0.2.1.md` | `614b45d13a22e4875a89d1d37718e442f1719b17c98541450a4352ae7efb5c86` |
| `notion-architecture-candidate-upserts.jsonl` | `2554a428f0bc491c6e6047b4f50fce90f2df58f4cd804d01e94b3ae563995485` |
| `notion-task-candidate-updates.jsonl` | `94ac991d8f878dd9027c6a607fefb3ac9bb93527737b6b714b0e79e3edce7605` |
| `novel-v1-adapter-and-workflow-v0.2.1.md` | `c74660e2c0bea192c5c548c3423ba08eab79ba00a3333b8fdb965863583bbf24` |
| `novel-v1-cps-parity-review.md` | `5ee916fbcb911fd569d6a3b10bedd4a9b1d256d0aca02d83a4fd055f86b37996` |
| `novel-v1-evidence-reconciliation.md` | `47410079adb3e52c55f28a3c395a646e63d9da24c0d9a5ad4373b699dbf97e52` |
| `novel-v1-implementation-plan-v0.2.1.md` | `964c6dc409f6f0f3553a0336dcab4810e183186230bdcb6cbf646b3247d25e26` |
| `novel-v1-logical-data-model-v0.2.1.md` | `2aa8e855cd6cb9bda9b45f0127cf7ec9003b3d352f19d43dadc30ba7bb308aaa` |
| `novel-v1-open-decisions.md` | `34c47cd4a2a3d6c97161cf7ae4fd3e14d83c0e0bfd066775bfd5761c55713321` |
| `novel-v1-system-architecture-v0.2.1.md` | `459acc25497b6d08d070cf3c1e67a308331dc3b9acf47af0f51f7cdaabd631eb` |

### 2.2 正式需求基线（只读核对）

审计于 2026-08-02 先读取最高优先级的冻结基线与正式实施台账：

- [海外阅读 V1 · 已确认需求与工程基线 v1.0](https://app.notion.com/p/1145334700974e6e84b8214ff16eaaa4)：状态 `BASELINE_FROZEN_FOR_P1`，明确声明为 P1 唯一需求真源。
- [P1 实施任务台账](https://app.notion.com/p/9ec8ed7c084842318f77c454b9473388)：P1-00～P1-15 的正式任务、Owner、Reviewer、Gate 与写入路径。
- [P1-03 · 架构独立审计](https://app.notion.com/p/b0070121ac0c4297a5cbe41a08e10ccb)：正式任务身份为 SOL 5.6 独立审计，不是数据模型任务。

随后读取并查询四个正式事实库的 P1 相关条目：

- [技术调研任务台账](https://app.notion.com/p/e52511a7661747bba50b75abdd080711)
- [渠道接口台账](https://app.notion.com/p/fb14be8f6b0d49c8a9351398418b29da)
- [接口字段数据字典](https://app.notion.com/p/132f98247876435a96299d0d84359ff6)
- [架构与数据模型字典](https://app.notion.com/p/cd15312396384a418a952589c01762f7)

关键当前事实与不一致：

- 冻结基线第 10 节与正式实施台账均明确：Claude 负责前端和 admin UI；Codex 负责 DB/Auth/Worker/Adapter；共享合同经审计冻结。Claude 的 P1 所有权表反向把后台页面交给 Codex。
- 正式台账定义 P1-03 为本次审计、P1-04 才是仓库骨架、P1-05 才是 Schema；`P1_ARCHITECTURE_EXECUTION_PACKAGE.md:242-257` 却把 P1-03 改成数据模型，并整体重编号 P1-04～P1-12。
- 正式台账当前仍把 P1-01、P1-02、P1-03 标为“未开始”，与六份设计已交付、本次审计已执行的事实不同；状态尚未 reconciliation。
- [职责与 Gate](https://app.notion.com/p/12253cd826f64aa7897a41399083291e) 状态为“已确认”，明确 Claude 主责 `src/app`、`src/components`、`src/styles`、`src/design`、`src/features/admin-ui`；Codex 主责 `src/server`、DB/Auth/Worker/Adapter/Infra；`src/contracts`、`src/domain`、包与构建文件属于共享冻结区。
- [后台 CPS UI 复刻](https://app.notion.com/p/182fb101a7324f54bcec3a037b4e4fea)、[物理隔离](https://app.notion.com/p/9a3e5ff839144b09a3292a53af2964cb)、[MUST_PARITY](https://app.notion.com/p/09f82636a68f40b984de856b7a101cf1) 均为“已确认”。
- 冻结基线第 7 节及 [深色设计与系统主题阅读器](https://app.notion.com/p/c8977cf381a44c76a9676fc1bf0ea648) 要求阅读器允许手动覆盖并持久化，并提供字号、行距、页宽、主题调节、滚动位置记忆和不整页刷新的章节切换；纸色是否一期上线仍待 Owner 裁决。
- [内容与试读基线](https://app.notion.com/p/b980bd7ad1f64635991226f0dee67ca9) 为“已验证”，明确只展示 `is_preview=true` 且不得写死三章。
- 冻结基线第 6 节已冻结“P1 Schema 必须容纳多个 ChannelAccount”；收益字段、归因关系和结算主体关系仍未冻结。[多账户收益模型](https://app.notion.com/p/30331354ac8d4e958b20f2365e1a054d) 的整行状态仍为候选，说明事实库状态传播还需细分，不能退回单账户假设。
- 冻结基线的 supersedes 清单已废弃统一 `splitRatio >= 50` 门槛，但第 9 节仍要求 Owner 决定新的机器发布门禁阈值。字段字典 [`splitRatio`](https://app.notion.com/p/3af601b5fd3480c38a54e0fd37a15d75) 未同步被替代状态；Claude 的“全量入 SourceItem”可以成立，但不能被解释成“全部内容自动通过发布门禁”。
- 冻结基线第 4 节已固定详情与章节 URL 形态，Claude 共享契约仍把 D-8 写成开放项；冻结基线第 3/4 节对“页面可索引”与“正文全文索引细则”也需用不同术语消除歧义。
- `PostgreSQL 原子任务领取`、`Cron 唯一执行`、[数据库角色分离](https://app.notion.com/p/2a65c38eda15447b851f68c85eb63944) 在架构字典仍为候选；它们的正式实现任务位于审计通过后的 P1-05～P1-08，所以本次 Gate 应要求合同和测试计划冻结，不应要求提前提交实现证据。

冻结页面解决了“唯一真源是谁”的问题，但 Notion 页面仍可编辑，Claude 包也没有记录读取时点与内容哈希。审计可复现性仍要求形成带页面 ID、最后修改时间、快照时间、规范化规则和 SHA-256 的不可变导出。

## 3. 十项重点检查结论

| # | 检查项 | 结论 | 说明 |
| ---: | --- | --- | --- |
| 1 | 可复刻流程是否遵循 CPS | 部分通过 | 任务两级、attempt 领取时计数、allowlist、2FA、批量三步向导、推广四段流程、审计脱敏等有明确 CPS 证据；但后台审计/日志能力和若干控制面未闭合，`ORIGINAL_REQUIRED` 统计还把三个独立偏离合成一项。 |
| 2 | 是否误复制 SQLite 专用实现 | 识别正确，替代合同不足 | 已明确排除 `file:` 回落、PRAGMA、伪写锁、非原子领取、`globalThis` Cron 和未加引号的 PG 别名；但 fencing、CAS、事务隔离、重试、Scheduler 原子性未冻结。 |
| 3 | 新项目与 CPS 是否物理隔离 | 设计通过，运行态不通过 | 两个目录 realpath 分离且 CPS 干净；但 `cps-novel` 不是 Git 仓库，任务启动目录又指向另一个空仓，无法证明后续提交会落到唯一正式仓库。 |
| 4 | 模块所有权是否避免并行冲突 | 不通过 | 当前表与正式已确认职责冲突；`ui`、`constants`、`governance`、`tests` 仍共享，包/锁/配置/CI/Docker/proxy/instrumentation/i18n 等无人唯一负责。 |
| 5 | 共享契约是否足够冻结 | 不通过 | 仅 Locale、公开短码、渠道无关性为 FROZEN；核心 DB、Worker、Auth、Credential、Scheduler、状态机、错误码和事务语义仍为自然语言。 |
| 6 | PG/Worker/Scheduler/Credential/Auth 边界 | 不通过 | Worker 缺 fencing；Scheduler 共享 `worker_app`；Web 的凭证校验动作又需要解密，而 Web 被禁止读密文；Admin API 无可证明的默认拒绝。 |
| 7 | 后台菜单、字段、安全策略 | 不通过 | 基础复刻较完整，但缺操作审计/任务日志闭环、租约/调度/死信处置、完整能力位矩阵和原因+行为人审计；菜单计数与 CPS 也有小偏差。 |
| 8 | 深色前台和系统主题阅读器 | 技术可实施，需求合同不通过 | CSS 媒体查询与 scoped tokens 可实现且不会引发 DOM hydration 差异；但 Claude 删除了已确认的手动覆盖、持久化、字号/行高/页宽、滚动记忆和无整页刷新章节切换，并未冻结 `.admin/.site/.reader` scope 与 token 映射。 |
| 9 | 未决事项是否伪装成已确认 | 存在 | P1 执行包用勾选表示数据模型、Worker、Cron、角色与备份已冻结，且错用正式 P1 任务编号；D-8 已由冻结基线定案却仍写开放，D-12、D-7、W6、纸色和机器发布阈值的准确阶段影响仍未对齐。 |
| 10 | 是否具备进入正式编程条件 | 不具备 | Gate 保持关闭；先完成修订、冻结快照和二次 SOL 5.6 审计。 |

## 4. CPS 复刻与 SQLite 专用实现审计

### 4.1 正确继承的能力

以下方向有 CPS 代码证据，且无需无理由原创：

- 能力位模型、`requireAdminCapability`、会话/2FA/恢复码；
- Feature Flag 默认关闭与写操作双闸；
- 批量操作“三步向导”、默认 `draft`/`dry_run`、显式选择；
- task/item 两级语义、attempt 在领取时递增、状态由 item 计数派生、检查点和 stale 恢复；
- 推广资源 pre-read → claim → readback → writeback、写前意图、未知结果禁止自动重试、审计脱敏；
- IndexNow outbox、sitemap last-known-good、公开跳转只允许 HTTP(S)；
- 来源实体与 canonical 实体分离、渠道账户/应用维度配置化。

### 4.2 正确排除的 SQLite/单进程实现

CPS 实读证据支持 Claude 的排除判断：

- `src/lib/datasource-url.ts:3-20` 的 `file:` 默认值；
- `src/lib/sqlite-busy-timeout.ts:7-20` 和 `src/lib/channel-sync-task.ts:300-302` 的 PRAGMA；
- `src/lib/changdu-promo-claim-enqueue.ts:200-206` 的 `UPDATE ... id=-1` SQLite writer lock；
- `worker/index.ts:101-120` 的 `findFirst` → `update` 非原子领取；
- `src/instrumentation.ts` 的 Web 进程内 Cron 和 `globalThis` 去重；
- 原生 SQL 中未加引号的 camelCase alias、SQLite boolean/int 和日期函数假设。

这些都不得复制到 PostgreSQL。

### 4.3 偏离分类仍需修订

`P1_CPS_PARITY_MATRIX.md:232-246` 声称九项 `ORIGINAL_REQUIRED`，但第 9 项合并了“埋点批量写、sitemap 对象存储、sitemap SQL”三个独立变化。审计对象、风险和验收不同，必须拆成原子条目。

另外，“新方案”不能只写技术名词。每个 `PG_REIMPLEMENT/ORIGINAL_REQUIRED` 必须同时冻结：

1. CPS 前提为什么失效；
2. 新合同的并发/失败/恢复语义；
3. 可执行验收；
4. 回滚或人工接管边界；
5. 对应 Owner 和唯一修改路径。

## 5. 阻断级发现

### A-01 · 冻结基线与正式任务台账未被执行包对账

candidate 在 `novel-v1-evidence-reconciliation.md:335-358,680-687` 和 `novel-v1-open-decisions.md:255-277` 如实声明当时四个正式数据库未读；真正的缺陷是 Claude 包进入 Gate 前仍未对后续冻结的 [P1 唯一需求基线](https://app.notion.com/p/1145334700974e6e84b8214ff16eaaa4) 和 [P1 实施任务台账](https://app.notion.com/p/9ec8ed7c084842318f77c454b9473388) 做 reconciliation。执行包把正式 P1-03“架构独立审计”重编号为“数据模型”，P1-04～P1-12 的名称、Owner 和前置也随之错位；P1-01～P1-03 的账面状态仍为“未开始”。正式 P1-03 的默认写入路径是 `docs/architecture/audit/`，本轮则依 Owner 当前明确指令写入 `docs/p1/audit/`，必须记录为当次 path override，而不能静默漂移。

影响：六份 P1 文档无法证明自己实现了哪一版冻结基线，实施台账也无法可靠接收状态；后续执行体可能忠实实现错误需求或错误任务。

### A-02 · Worker lease 没有 fencing/CAS 合同

`novel-v1-adapter-and-workflow-v0.2.1.md:710-729` 和逻辑模型 `:543-553` 定义了 `locked_by`、`locked_until`、`heartbeat_at`、`execution_token`，却没有把 fencing 升级为事务不变量：不可复用的 token/generation、当前 owner、数据库时钟下租约仍有效，并在写业务行/outbox/audit 的同一事务中验证。精确匹配可变的 `locked_until` 反而会让合法心跳失败，不应成为唯一身份条件。

影响：租约过期后，旧 Worker 恢复运行仍可写结果；新旧 Worker 都可能“合法”完成同一 item。P1 验收“同一任务只执行一次”也错误地承诺 exactly-once。正确边界应是 at-least-once 领取、本地提交受 fencing 保护、业务写幂等；外部 HTTP 副作用另由 durable intent、上游幂等或 unknown 人工对账保护。失去 task lease 后不得发新请求或提交业务结果，但仍可凭独立、合法的 side-effect attempt token 补录已发生调用的 outcome。

### A-03 · 外部副作用审计的事务语义自相矛盾

CPS `src/lib/changdu-promo-claim.ts:933-948` 先提交意图，再调用上游；candidate workflow `:615-630` 也要求先提交。正式 [同库同事务条目](https://app.notion.com/p/fd38373149f44da3815fa24e5ee05612) 的正确适用面是本地 `operation_audit`，但 system architecture `:108,116,282` 和 P1 parity `:177` 没有区分它与外部 `side_effect_intent`，造成术语与事务边界混用。

两者需拆开：

- 外部不可逆调用：独立事务提交 `side_effect_intent`，随后才发网络请求；
- 本地业务变更：业务行、outbox、操作审计在同一事务；
- 调用结果：另一个事务按永久业务 `effect_key` 记录 outcome；实际 credential revision 与请求摘要只进入 attempt/request fingerprint，不得改变业务幂等身份。

当前 `PromoClaimAudit` 无唯一副作用键，靠“最近一条”查询还存在并发竞态；non-repeatable 操作的 `success` 与 `unknown` 都必须持续占用永久业务键。

### A-04 · Admin API 默认拒绝不可证明

P1 文档只描述 `PROTECTED_PREFIXES`。CPS `src/proxy.ts:198-200` 明确排除 `api`，`src/app/(admin)/layout.tsx:23-35` 只保护页面布局；复制页面前缀无法保护未知 `/api/admin/**` 或 Server Action。

缺失：

- 独立 `/api/admin/**` 命名空间；
- 页面命名空间的 AuthN、Route/Action 的 AuthN+AuthZ、服务层 mutation 的再次授权三层边界；
- Server Action export 的显式/生成注册表；
- `/api/internal/**`（若存在）的 service identity、replay 与密钥轮换；
- 高风险延迟任务对 session 过期、capability 撤销采用入队快照还是执行时重查；
- CSRF/Origin/replay 策略；
- 路由清单静态扫描；
- 401/403/404 语义和测试矩阵。

### A-05 · Credential 校验与数据库列权限无法同时实现

P1 后台要求 Web Server Action 执行“校验凭证”，CPS 的对应服务会读 `encrypted_secret` 并解密；但逻辑模型 `:395` 和执行包 `:208-211` 又规定 `web_app` 不得读密文、只有 `worker_app` 可读。Scheduler 还共用 `worker_app`，取得了不必要的凭证权限。

必须冻结一个可部署拓扑，而不是列出任选方案。推荐 Web 只入队，由独立 credential executor 进程以独立连接池和 secret distribution 执行校验/解密；若选专用 admin service，也必须是物理独立的受信解密主体。单靠数据库 `SECURITY DEFINER` 只能保护密文列，无法替代 Node 进程中的密钥隔离。Scheduler 必须使用最小权限角色且不注入解密密钥。

### A-06 · 物理 Schema 与 Scheduler 合同没有冻结

执行包只冻结 PG16 和五个宽泛角色，却在它自己的错位任务表中把数据模型、Worker、Cron、角色与备份标成已冻结。共享契约没有表级类型、null/default、CHECK、FK action、部分索引 predicate、事务隔离、重试和 `CronRun` 实体。Scheduler 依赖 `(schedule_key, scheduled_bucket)`，逻辑模型却没有该表。

此外必须冻结由 schedule definition + revision + 时区/DST 规则确定性计算的 `scheduled_for timestamptz`；数据库时钟只判断 due/misfire/catch-up。还需冻结人工 trigger identity，以及 CronRun 与 enqueue 同事务/FK。

### A-07 · 任务与 IndexNow 状态机互相冲突

- 逻辑模型 `:485` 写 Catalog 采用 ChannelSync “五态”，而 ChannelSync `:511` 实际列六态。
- workflow 验收使用 `partial_failed`，逻辑模型状态未包含。
- implementation plan `:85-93` 仍说任务四表，而逻辑模型 `:472-538` 已有六表。
- `GenericTask` 写“同上”但没有精确定义。
- IndexNow 逻辑模型 `:565` 是五态，P1 parity `:222` 要求继承七态。
- Admin 计划复刻 CPS 的暂停/取消/重试按钮，却没有对应可达转移。
- SideEffectIntent/Attempt、CronRun、人工 reconciliation、sitemap version，以及 durable tracking（若采用）没有状态机。

DB enum/CHECK 只能限制取值，不能证明转移合法。每次转移还需要 expected state/revision、actor、reason、并发错误码，并明确 parent 派生、pause/cancel/retry 与在途外部调用的优先级。在一个冻结状态机真源出现之前，Schema、Worker 和 UI 无法并行。

### A-08 · 模块所有权与正式已确认职责直接冲突

`P1_MODULE_OWNERSHIP.md:20-35` 把后台 `src/app/(admin)` 和 `src/components/admin` 交给 Codex；正式 [职责与 Gate](https://app.notion.com/p/12253cd826f64aa7897a41399083291e) 则把 `src/app`、`src/components` 和 `src/features/admin-ui` 交给 Claude。

同一冲突也出现在正式任务台账：P1-09 后台框架 Owner 为 Claude，P1-08 才是 Codex 的后端鉴权/API；Claude 执行包则把后台页面和全部 API 都交给 Codex并整体重编号。

同一文件还同时宣称“一目录一 Owner”和共享 `src/components/ui`、`docs/governance`、`tests`；`docs/p1/**` 归 Claude，但契约要求双方修改，审计输出也必须落在其下。

无人明确负责的高冲突路径包括：`package.json`/lockfile、tsconfig、Next/Tailwind 配置、CI、Docker/compose、`src/proxy.ts`、instrumentation、生成 Prisma client、根 layout、登录/2FA 路由、i18n/messages、public assets。

### A-09 · 共享合同不足以支持并行实现

`P1_SHARED_CONTRACTS.md:224` 只有三项 FROZEN。其余关键合同仍是自然语言或伪签名，没有可编译 DTO/enums/result/error code、null/version、事务/idempotency 和契约测试。

具体错误：

- `:25` 的可见性表达为 Article published 且 Novel 不是下架态，会让 Novel `draft/ready` 穿透；`:181-190` 又要求只有 Novel published 可见。
- `getPublicRedirectCode(novelId)` 在一书多 source/account/promo link 时选择规则不明。
- URL 合同仍受 D-8、D-12 影响，却被下游 sitemap/IndexNow/CTA 依赖。

### A-10 · 永久公开短码与软删部分唯一冲突

`P1_SHARED_CONTRACTS.md:88-96` 和逻辑模型 `:406-420` 同时要求公开码“永不变化”和“部分唯一索引排除软删”。软删后代码可被复用，旧外链会跳到新资产。

永久公开标识必须使用 append-only code registry/tombstone；或使用全局非部分 UNIQUE 并明确 PromoLink 禁止硬删、永久保留 tombstone。还需冻结长度、ASCII 字母表、大小写归一、保留词、byte-wise collation 和冲突重试上限。PostgreSQL unique violation 会中止当前事务，重试必须使用 `INSERT ... ON CONFLICT DO NOTHING RETURNING`、savepoint 或新事务，不能 catch 后在同一失败事务里继续。

### A-11 · 正式仓库身份尚未成立

执行包声明新项目是独立 Git 仓库，但实际 `cps-novel` 不是 Git 仓库；本任务启动目录则是另一个空 Git 仓库。虽然 CPS 未被修改，后续执行体仍可能在错误根目录提交。

必须建立唯一 canonical realpath、仓库/remote/branch 身份校验，以及禁止 CPS symlink/path dependency 的自动检查后，才可并行。

## 6. 高风险发现

| ID | 发现 | 证据/影响摘要 |
| --- | --- | --- |
| A-12 | PG 参数、角色拓扑与连接预算不完整 | 缺完整 LOGIN/NOLOGIN 继承图、默认 ACL、`PUBLIC` revoke、各角色 timeout、关键事务显式 `SET LOCAL synchronous_commit=on` 不变量、`application_name`、隔离/SQLSTATE retry、UTC/search_path、TLS/SCRAM/pg_hba、精确池预算和 `pg_stat_statements` preload。 |
| A-13 | 迁移 Owner 模型过宽 | 应采用 NOLOGIN owner group + 临时 production deploy migrator/`SET ROLE`，冻结 actual-owner default privileges 与单一迁移协调机制。Prisma shadow DB 仅属 dev/diff 流程，production principal 不得因此持有 CREATEDB；回滚以 expand-contract + app rollback + roll-forward 为主。 |
| A-14 | 备份/PITR 表述技术错误 | `pg_dump + WAL` 不能单独形成物理 PITR；应分开定义逻辑导出与 physical base backup + 连续 WAL/restore command/timeline，并保护 cluster globals、密钥、manifest，给 RPO/RTO、异地和业务不变量恢复验收。 |
| A-15 | Credential crypto 合同不完整 | CPS AES-GCM envelope 已有 `v1` 格式前缀，但没有 key id、AAD、独立密钥生命周期和轮换合同；加密 DEK 可轮换，而 fingerprint key 必须稳定或支持多版本查重。`validateJwtLocally` 只解析结构/exp，不验证签名。逻辑模型还说“两表”却依赖未列出的指纹唯一实体。 |
| A-16 | 多账户模型内部矛盾 | 冻结基线已要求 P1 Schema 容纳多个 ChannelAccount；system architecture 与逻辑模型 `2.16` 符合这一方向，但逻辑模型 `:374-376` 仍写 V1 一个账户。未冻结的是收益字段/归因/结算关系，不是结构是否允许多账户。 |
| A-17 | 推广值后台可见性冲突 | Owner candidate `open-decisions.md:219-237` 要 admin 明文；P1 admin `:107-120,218` 要掩码+能力位展开。需以当前正式裁决或新 supersedes 记录统一。 |
| A-18 | Article 状态冲突 | 逻辑模型 `draft/published/unpublished/takedown`，parity 另写 `draft/pending/published/offline`；发布、SEO、下架与 HTTP 状态无法据此实现。 |
| A-19 | 作用域哈希重叠有 TOCTOU | 完全相同 hash 有 DB 唯一，部分重叠只做应用预检；并发入队仍可同时通过。需持久化 active target membership 或可由 exclusion/unique 证明的互斥；advisory lock 只能串行化“检查+写 membership”，不能代替长期约束。 |
| A-20 | 写闸门分类与注册不闭合 | parity `:98` 中 promo claim、IndexNow、sitemap、worker、tracking 未全部列出对应 Allow Write。产品 mutation、外部副作用和 heartbeat/audit/reconcile 等安全基础写不能用同一套双闸；enqueue 与 execution 的授权快照/重查也未定义。 |
| A-21 | 后台控制面缺闭环 | 缺操作审计入口、scheduler run/misfire、lease/stale recovery、dead-letter/redrive、未知 locale 处置、`claim_retry_blocked` 人工动作，以及任务 enqueue/pause/cancel/retry 等能力位。 |
| A-22 | Tracking 不是耐久合同 | `trackEvent → void` + 批量 flush 没有队列、批量上限、关机 drain、重试/死信、丢失 SLA、retention job 和 salt version。归因关键事件应走 durable outbox；若允许丢失必须写明预算。 |
| A-23 | Health 暴露过多 | 公开 `/api/health` 不应返回 version/commit/完整 flag snapshot；需拆成最小 public liveness 与内网/鉴权 readiness/diagnostics。 |
| A-24 | Sitemap 对象存储合同不完整 | 缺 versioned key、原子 pointer、last-known-good、命名空间、cache invalidation 和发布失败恢复。 |
| A-25 | Admin 复刻遗漏与计数偏差 | Claude 写 CPS 17 个顶级菜单，实读 sidebar 是 18；更重要的是架构要求审计/日志能力，菜单与逐页规格未覆盖。 |
| A-26 | 深色设计与已确认需求冲突 | `P1_DARK_DESIGN_BRIEF.md:45-48,131-136` 删除手动主题覆盖、持久化、字号/行高，并漏掉页宽、滚动位置记忆、移动端优先和不整页刷新的章节切换；冻结基线已确认这些能力。纸色是否一期上线仍待 Owner 裁决。 |

## 7. 发现—修订—Gate 追踪

| Findings | Required revisions | Architecture Gate |
| --- | --- | --- |
| A-01 | R-01、R-02、R-24 | G-A01、G-A02、G-A17 |
| A-02 | R-06、R-08 | G-A06、G-A08 |
| A-03 | R-09 | G-A09 |
| A-04 | R-10 | G-A10 |
| A-05 | R-11、R-13、R-16 | G-A11、G-A13 |
| A-06 | R-07、R-12～R-15 | G-A07、G-A12、G-A13 |
| A-07 | R-08 | G-A08 |
| A-08 | R-02、R-04 | G-A02、G-A04 |
| A-09 | R-05 | G-A05 |
| A-10 | R-17 | G-A14 |
| A-11 | R-03 | G-A03 |
| A-12～A-15 | R-11、R-13～R-16 | G-A11、G-A13 |
| A-16～A-18 | R-02、R-08、R-12、R-20、R-21 | G-A02、G-A08、G-A12、G-A16 |
| A-19 | R-12、R-18 | G-A12、G-A14 |
| A-20 | R-19 | G-A15 |
| A-21～A-25 | R-02、R-04、R-08、R-10、R-19～R-21、R-24 | G-A02、G-A04、G-A08、G-A10、G-A15～G-A17 |
| A-26 | R-02、R-04、R-22 | G-A02、G-A04、G-A16 |

## 8. 可实施性判断

深色前台与系统主题阅读器本身可实施，推荐的架构形态是：

- `.admin`、`.site`、`.reader` 三个明确 DOM scope；
- 共享 UI 只消费语义 token，各 scope 做 `--novel-*` / `--reader-*` 到语义 token 的映射；
- 阅读器默认读取 `prefers-color-scheme`，用户选择高于系统偏好并持久化；
- 字号、行高、页宽可调；滚动位置记忆，章节切换不整页刷新；
- 长文分段渲染、移动端优先、目录与上下章导航；
- 设置 `color-scheme` 以覆盖原生控件；
- DOM/正文完全一致，只改变 CSS 变量；
- 自动化验证 WCAG AA、系统主题切换、手动覆盖优先级和持久化。

品牌色、logo、纸色是否一期上线可保持待决，但不能删除已经确认的主题覆盖、字号、行高、页宽和基础阅读交互。

## 9. 审计边界与完整性声明

- 未修改 candidate-v0.2.1。
- 未修改 Claude 的六份原始架构文件。
- 未修改 CPS，CPS HEAD 仍为 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`，工作区保持 clean。
- 未创建 Prisma Schema、Migration、Worker、Scheduler、Adapter、页面、数据库、容器或部署配置。
- 本轮只新增 `docs/p1/audit/` 下三份审计输出。

固定交付记录：

```text
TASK_ID=P1-03
ROLE=SOL 5.6 ARCHITECTURE/BACKEND/DATABASE INDEPENDENT AUDIT
BRANCH=N/A（正式 cps-novel 尚非 Git 仓库）
COMMIT=NONE
CPS_BASELINE=d77c3b968285698529cf97c7f0f97b286d7a2a9c
CPS_REFERENCE_ROOT=/Users/chenweifeng/Documents/产品原型及文档/cps项目
NEW_PROJECT_ROOT=/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel
CPS_BEFORE_STATUS=clean
CPS_AFTER_STATUS=clean
CPS_PATHS_READ=src/proxy.ts; src/app/(admin)/layout.tsx; src/components/layout/sidebar.tsx; worker/index.ts; src/lib/channel-sync-task.ts; src/lib/changdu-promo-claim-enqueue.ts; src/lib/changdu-promo-claim.ts; src/lib/channel-account/service.ts; src/lib/channel-account/credential-crypto.ts
NEW_PROJECT_PATHS_CHANGED=docs/p1/audit/P1_SOL56_ARCHITECTURE_AUDIT.md; docs/p1/audit/P1_REQUIRED_REVISIONS.md; docs/p1/audit/P1_IMPLEMENTATION_GATE.md
NEW_PROJECT_ONLY_WRITES=true
CPS_PARITY_CLASS=N/A（审计任务）
TESTS=read-only source/hash/status/contract cross-check; no implementation tests
AUDIT_RESULT=REVISE
P1_TASK_OUTCOME=AUDIT_FAIL（正式台账二值映射；不替代本报告 RESULT）
DISPOSITION=REVISE_REQUIRED
NOTION_STATUS_PROPOSED=阻塞（合法枚举；本轮未回写）
OUTPUT_PATH_OVERRIDE=Owner 本轮明确指定 docs/p1/audit/，覆盖台账默认 docs/architecture/audit/，仅适用于本次交付
BLOCKERS=A-01 through A-11 plus required high-risk contracts
NEXT_GATE=Architecture Contract re-audit after R-01 through R-24
```

RESULT=P1_SOL56_ARCHITECTURE_AUDIT_REVISE
