# 领推广链接生命周期（阶段2）UAT 方案

日期：2026-09-24（北京时间）
依据：`设计_领推广生命周期与自动分片_阶段2_2026-09-23.md` 第九节第 2/10 项、`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`、施工任务第 5 步 2.6
状态：**方案定稿，等待 Owner 拍板 2.1 节的待决问题后方可执行**。本方案本身不改代码、不在任何环境执行任何操作。

---

## 一、范围

设计第九节验收标准里，只有第 2 项（8 万级真实提交）和第 10 项（8 万级 dry-run 模拟）需要在预生产真实跑一遍——其余 8 项已经用真实 Postgres 集成测试 + 一次性 `scheduler_app`/`worker_app` 角色验证覆盖，见同目录 `PROMO_CLAIM_LIFECYCLE_ACCEPTANCE_REPORT_2026-09-24.md`。本方案只覆盖这两项，分两节：

- **§二 8 万级 dry-run 模拟**：在预生产用小窗口反复触发放行/错过截止时间/凭据暂停，验证生命周期机制本身在高频事件下不出错——不请求上游，用于验证机制，不消耗真实上游配额。
- **§三 真实验收**：预生产开关开启后，由 Owner 决定时间窗的一次真实批量领取。

两节都要求：**必须走生产路径**（预生产真实的 web/worker/scheduler 进程，而不是测试 harness 或临时脚本代替生产组件的步骤——`feedback_rehearsal_must_use_prod_path` 这条教训在本方案里同样适用）；**必须在 v0.4.0（阶段2代码）部署到预生产、且 Owner 已批准开启开关之后**才能执行；执行前后都要跑一次 `scripts/preproduction/preflight.sh` 确认写闸、字典、grants 状态正常。

---

## 二、8 万级 dry-run 模拟

### 2.1 代码路径核实结论（先于方案定稿完成，2026-09-24）

设计原文（第九节第 10 项、§5 多处）设想"用 dry-run 模式批次（不请求上游，单本约 0.05 秒）跑 8 万本"。**这条路径核实结论是：不存在，不能直接跑通**，理由如下（均为当前代码的确定性事实，不是猜测）：

1. `src/lib/tasks/catalog-batch.ts` 的 `enqueueCatalogBatch`（第 173 行）把批次父任务的 `mode` **硬编码为 `"apply"`**——`CatalogBatchEnqueueInput`/`CatalogBatchPayload` 类型本身也不包含任何 `mode` 字段，调用方无法传入 `"dry_run"`。
2. `worker/handlers/catalog-batch.ts` 枚举生命周期分片时（第 411 行）同样把每个分片子任务的 `mode` **硬编码为 `"apply"`**；旧路径（非生命周期）子任务（第 490 行）也是同一硬编码。
3. `worker/handlers/promo-link-claim.ts` 的 handler 确实认识 `mode === "dry_run"`（第 1120/1143 行，`writeAllowed = mode === "apply" && ...`，dry-run 时把决策记成 `would_claim`/`would_skip_capability_disabled`，不调用 getcode）——**但这条 dry-run 语义目前只有单本领取入口** `src/lib/tasks/promo-link-claim.ts` 的 `enqueuePromoLinkClaimTask` 会真正用到（它的 `mode` 参数确实可以是 `"dry_run" | "apply"`，第 83/115/124 行）。批量入口完全没有把 `mode` 一路透传下去的代码。

结论：**"生命周期批次 + dry-run" 这条端到端路径目前不存在，不是配置缺失，是代码结构性缺失**——批次/分片入队函数根本不接受 `mode` 参数。不应该为了这次模拟去改动批量入队/枚举的核心逻辑（那已经超出施工任务第 5 步"配置、文档与 UAT 方案"的范围，且会绕开 Opus 复核链条临时加一条新代码路径）。

**顺带做的一次相关实测**（不是对第 10 项本身的替代，只是支撑上面结论的一个数据点）：临时把 `tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts` 的 `PROMO_CLAIM_SHARD_ENUM_SCALE_COUNT` 调到 80000 跑一次（一次性 `postgres:16.14` 容器，见验收报告第 2 项），**真正落在生产枚举事务里的耗时是 `enumerateMs=10127`（约 10.1 秒），远低于 120 秒的事务超时**；这条测试自身连同 80,000 行的种子数据写入、逐条目断言等 harness 开销，整条用例跑了约 710 秒——这 700 秒绝大部分是测试自己为了逐条核对正确性而做的断言开销（拉取全部 8 万条 item 到 Node 进程里逐条 `expect`），不是生产路径会承担的成本。这说明：8 万本规模下，**枚举本身不是瓶颈**；第 10 项模拟真正要验证的是放行 / 错过截止时间 / 凭据暂停这条**持续多轮**的调度链路，而不是一次性的枚举耗时。

### 2.2 待 Owner 决定的选项

| 选项 | 做法 | 优点 | 缺点/风险 |
| --- | --- | --- | --- |
| **A. 新增受开关保护的 dry-run 生命周期批次入口** | 单独一个小改动（`enqueueCatalogBatch`/枚举 handler 各加一个可选 `mode` 参数，默认 `"apply"`，只在显式传 `"dry_run"` 且生命周期开关也开启时才让分片和条目都以 `mode: "dry_run"` 建立），走正常的 Sonnet 编码 + Opus 复核 + 变异验证流程 | 最接近设计原文设想的模拟方式；可以真实验证放行/错过截止时间/凭据暂停这条完整链路在 8 万条目规模下的行为，且零上游请求、零真实推广码写入 | 需要新增一条代码路径（哪怕受开关保护），多一轮施工+复核，且这条路径本身在生产环境永远不会被使用——为了一次性模拟新增永久代码，需要评估是否值得 |
| **B. 改用 ops 脚本批量造 dry-run 分片** | 不改产品代码，写一个一次性运维脚本，直接用 Prisma/SQL 在预生产库里手工构造 8 万条挂在 `disabled`+`awaiting_release` 生命周期分片下、`payload.mode`（或等价标记）为 `dry_run` 形状的条目，配合临时把 `promo-link-claim.ts` handler 的 `mode` 判定接到这批数据上 | 不碰批量入队/枚举的产品代码；脚本用完即弃 | handler 目前按 `generic_task.mode` 列（不是条目 payload）区分 apply/dry_run（见 `worker/handlers/promo-link-claim.ts:1069` 的 `mode` 来自任务级），脚本需要直接写 `generic_task.mode = 'dry_run'`——这已经不是"只读模拟"，是绕过入队逻辑直接操纵生产库的任务表；"演练必须走生产路径"这条纪律要求谨慎评估这算不算"生产组件"，需要 Owner 明确认可这种手工构造是否可信 |
| **C. 直接以小批量真实领取代替** | 放弃"8 万级、零上游请求"的模拟目标，改为在预生产用远小于 8 万的真实批量（例如几百到几千本，视上游配额与 Owner 意愿）走真实 apply 路径，配合缩小窗口/安全余量来触发放行/错过截止/凭据暂停 | 是真正的生产路径，不需要任何新代码；已有的三个一次性 Postgres 集成测试套件（本步骤已跑通，见验收报告）已经覆盖了"结构性"的分片/放行/D4/凭据判定逻辑，小批量真实验收足以补上"真实 worker+scheduler 进程"这一层 | 不满足设计原文"8 万级"这个规模数字；且会真实消耗上游配额、真实领取真实推广码（非幂等，见 ADR 背景），需要衡量是否要为了单纯"跑一次机制"而领取几百本真实不需要的推广码 |

**本方案不预先替 Owner 选定选项**——三个选项各有明确代价，第 2.6(a) 的核实结论已经排除了"直接照抄设计原文就能跑"这条路，接下来怎么做需要 Owner 拍板。

### 2.3 若选定选项 A/B（能够跑通 dry-run 或等价机制模拟）：执行步骤

1. **前置条件**：v0.4.0 已部署预生产；Owner 已批准开启 `PROMO_CLAIM_LIFECYCLE_V1_ENABLED`；选定方案的代码/脚本已完成并经复核。
2. **配置**：临时调小以下三项（预生产 env，按 §2.1 的 preflight 校验规则改），使 90 分钟窗口内能触发多次放行周期：
   - `PROMO_CLAIM_SHARD_WINDOW_MINUTES`：建议 2～5 分钟（而不是生产的 90 分钟）；
   - `PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES`：建议保持默认 1440（不需要在模拟期间触发批准过期，除非专门设计一个案例）；
   - `PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES`：模拟"凭据即将到期"分支时，临时调大到接近凭据实际剩余有效期（**绝不篡改凭据本身**，只调安全余量这一个纯配置数字，让 D5 判定自然落入 `credential_not_ready`）。
   - 每一步改完都跑一次 `scripts/preproduction/preflight.sh` 确认取证行 `PREPROD_PROMO_CLAIM_LIFECYCLE_CONFIG=PASS ...` 反映的是刚改的值，再重建 web/worker/scheduler（按运维手册"领推广链接生命周期"一节的步骤，只重建三个应用服务，不发新版）。
3. **提交**：用选定方案构造一批 8 万条目的 dry-run（或等价）生命周期批次。
4. **强制触发的场景与观察点**：

   | 场景 | 触发方法 | 观察点 | 通过标准 |
   | --- | --- | --- | --- |
   | 多次放行 | 缩小窗口后自然发生（每 2～5 分钟一片） | `promo_claim_release.tick` 日志 `action: "released"` 事件数量、批次详情页分片列表的 `releasedAt`/`deadlineAt` 递增 | 分片按 `shardIndex` 顺序依次放行，任意时刻只有一个 `pending`/`processing` |
   | 错过截止时间 | 把窗口调到比单片处理耗时更短（dry-run 单本约 0.05 秒计算耗时不含 scheduler 的 60 秒轮询间隔，需要窗口小到明显小于"分片条目数 × 单本耗时 + 一个 scheduler 轮询周期"） | `action: "deadline_missed"`/`deadline_missed_twice` 事件；`missedDeadlineCount` 递增 | 条目保持 `pending`，零条目被写成 `failed`；连续两次的分片进入 `deadline_missed_twice` 后不再被自动放行 |
   | 凭据暂停（`credential_not_ready`） | 临时调大 `PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES`，让 D5 第三条"剩余有效期 ≥ 窗口+安全余量"判定失败 | `action: "credential_not_ready"` 事件；批次进入 `system_hold` | 恢复安全余量到正常值后，下一轮自动恢复放行，不需要人工干预 |
5. **模拟结束后**：把 §2.2 步骤 2 调过的配置全部改回预生产正常值（含窗口/安全余量），重新走一次三步骤生效流程，跑一次 `preflight.sh` 确认已恢复默认。
6. **通过标准（汇总）**：
   - 全程零过期失败（`task_expired`）——8 万条目最终状态只能是 `dry_run` 决策成功（`would_claim`/`would_skip_capability_disabled`，视选定方案的具体产出字段）或仍处于合法的排队/暂停中间态，不出现被判定失败的条目；
   - D6 不变量全程成立（同账号至多一个分片 pending/processing）；
   - 用 §六附录的只读 SQL 核对：`side_effect_intent` 表里**没有**因为这次模拟新增的意图记录（dry-run 不应该走到"准备 getcode"这一步；若选定方案本身就不涉及 side_effect_intent，这条检查按方案实际路径调整）——证明无重复领取、无非预期的真实上游调用；
   - 模拟全程 scheduler/worker 容器保持 healthy，未出现 `promo_claim_release.tick_failed`（配置笔误信号）。

---

## 三、真实验收

### 3.1 前置条件

- **渠道令牌**：当前预生产渠道令牌 **2026-09-24 13:54 +0800 到期**，必须先续签，且新令牌**只录入预生产**（不得复用/复制到 X8 或其它环境，见 `docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md` §3）；续签后走 worker 校验任务成功，`last_validated_at` 非空。
- **开关**：`PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 已在预生产开启（Owner 批准，按运维手册"领推广链接生命周期"一节的步骤执行，只重建三服务、不发新版）；`scripts/preproduction/preflight.sh` 取证行确认七项配置合法。
- **claimPromo capability 状态**：`promo:claim` 后台能力当前只授权给 `PROMO_CLAIM_USER_IDS` 里的单一管理员身份（`PROMO_CLAIM_ROLES` 留空，见 `infra/preproduction/preprod.env.example` 的既有说明）；执行前确认这个身份仍然有效、且执行人就是这个身份（`requiresTwoFactor`，需 2FA）。
- **写闸**：`promo_write`（`FEATURE_PROMO_LINK_CLAIM`/`PROMO_LINK_CLAIM_ALLOW_WRITE`）已登记在 `PREPROD_APPROVED_OPEN_WRITE_GATES`，`preflight.sh` 通过。
- **数据字典/grants**：本轮（第 5 步）未改任何 schema，`scripts/preproduction/preflight.sh` 之外，确认最近一次部署已重放 `grants.sql`（`scheduler_app` 三项新权限，见 ADR 第 7 节第 1 条）。

### 3.2 批量规模

由 Owner 决定；建议按 §2.2 选定的 dry-run/模拟方案结果，先从一个明显小于 8 万本的真实批量开始（例如先验证机制本身在真实上游下工作正常），再决定是否/何时提交完整 8 万本。真实提交前，先用 `已建立书目` 的实际存量确认这次提交的书目范围与预期一致（不多领、不少领）。

### 3.3 时间窗

由 Owner 定。建议避开预生产其它高负载运维窗口（如 WAL 归档、备份、其它一次性验收任务），并预留至少一个完整批次的预计完成时间（按批次详情页给出的保守 ETA）+ 缓冲。

### 3.4 监控

- 任务中心批次详情页：六类计数、当前放行分片、批次状态；
- scheduler 结构化日志：`promo_claim_release.tick`/`tick_error`/`tick_failed`（详见运维手册"如何观察"一节）；
- 只读 SQL（运维手册已给出）：D6 不变量、`side_effect_intent` 增长趋势是否与"已领取"计数吻合（每领取一本最多一条新意图记录，不应该看到同一本书对应多条）；
- 上游侧：如有上游配额/速率监控面板，一并观察，确认没有触发上游限速或异常。

### 3.5 中止条件

出现以下任一情况立即人工中止（批次级中止，`task:manage` + 2FA）并停止提交后续批次：

- 任意时刻同一渠道账号出现超过一个分片处于 `pending`/`processing`（D6 不变量被打破，按 P0 处理）；
- 出现条目被错误标记为 `task_expired`/`failed` 且不属于预期的 `capability_disabled` 分类；
- `side_effect_intent` 出现同一本书（同一 `novelSourceItemId` + 渠道账号）对应两条独立的 `promo_link.claim_promo` 意图记录（重复领取信号）；
- scheduler 容器不再 healthy，或反复出现 `promo_claim_release.tick_failed`；
- 上游返回异常错误率升高或触发限速。

### 3.6 回滚

- 中止后，未完成的分片保持在系统暂停/排队状态，不需要额外操作即可安全停在原地（不会有条目被自动改写成失败）；
- 如需彻底回退到旧行为：把 `PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 改回 `"false"`（按运维手册"关闭"步骤），已创建的生命周期批次进入 `lifecycle_disabled`，已放行的那一个分片正常跑完；
- 真实验收产生的推广码是真实、不可逆的（上游 getcode 非幂等）——回滚不撤销已经领取成功的推广码，只停止后续新的放行。

---

## 附：与设计文档的对应关系

- 本方案 §二对应设计第九节第 10 项、§5 的"8 万级 dry-run 模拟"表述；
- 本方案 §三对应设计第九节第 2 项"真实验收在预生产开启开关后，由 Owner 决定时间窗"；
- §2.1 的核实结论是本方案区别于直接照抄设计原文的关键前提——在 Owner 就 §2.2 三个选项做出选择之前，第 10 项无法真正开始执行，只能停在"方案就绪、待选择"。
