# ADR-PROMO-CLAIM-BATCH-LIFECYCLE · 领推广链接批次改为"批次 → 分片 → 条目"生命周期

```text
ADR_ID              = PROMO-CLAIM-BATCH-LIFECYCLE
DECISION_STATUS     = ACCEPTED（Owner，2026-09-23，北京时间）
DECISION_DATE       = 2026-09-23
DECIDED_BY          = Owner
SCOPE               = cps-novel 领推广链接（promo_claim）批量领取的批次/分片/条目生命周期与自动分片；正式修复第 2 阶段
RELATED             = ADR-PREPROD-APPROVED-OPEN-WRITE-GATES（预生产写闸登记制）
DESIGN_DOC          = 设计_领推广生命周期与自动分片_阶段2_2026-09-23.md（仓库外，产品原型及文档/cps海阅）
CONSTRUCTION_TASKS  = 施工任务_领推广生命周期阶段2_2026-09-23.md（仓库外）
FEATURE_FLAG        = PROMO_CLAIM_LIFECYCLE_V1_ENABLED（代码默认 false）
FROZEN_DECISIONS    = D1–D9（本文第 2 节逐条对应）
```

## 1. 背景

2026-09-23，预生产一次提交领取 80,006 本书的推广链接。实测每本约 4.45 秒：3 次上游请求（预读、领取、回读），每次都要排同一个 1500 毫秒的限速门。按这个速度 6 小时只能处理约 4,800 本，其余约 7.5 万本注定在执行前过期，并被逐条标为失败（`task_expired`，每条只允许执行一次，不能重试）。

与 CPS 短剧 `v8.5.1` 对照：CPS 的"任务创建后 6 小时过期、所有条目共用"，是和"每批最多 1,000 部、只能手动勾选、全局只允许一个领取批次"一起定下的（commit `0407259`，2026-07-09，30 分钟 → 6 小时与 500 → 1,000 同时修改）。海阅只移植了 6 小时，却刻意取消了批量上限，并支持按筛选全量领取。于是过期时钟从提交那一刻起走，而任务规模不受约束。即使把速度优化到上游理论极限，8 万本也需要 1 天左右以上，所以这不是调参能解决的问题。

同时已确认（Owner 业务确认）：上游领取接口**非幂等**。对已有推广码的书再次领取，会生成并切换到新码，旧码仍然有效。任何生命周期方案都不能放松领取前的检查，也不能让可能已经产生上游写入的条目被自动重新领取。

## 2. 决定

1. **三层结构**：批次（操作人的意图，沿用现有"批量纳入"父任务）→ 分片（worker 枚举时一次切好，每片是一个领取子任务）→ 条目（一本书，执行逻辑不变）。不新增表，不改任务状态约束；新增内容放在任务参数和任务控制标记（新增 `awaiting_release`）里。
2. **放行时才开始计时**：分片在 scheduler 放行时写入 `releasedAt` 和 `deadlineAt = releasedAt + 90 分钟`（D2）。条目不再在提交时写入统一的执行截止时间。
3. **批准时钟只管"从未开始"**：批次批准后 24 小时内必须放行出第一个分片，否则进入系统暂停 `approval_expired`，只能运营重新批准。第一个分片放行后，批次进入执行期，无论总执行多久，都不再因批次创建时间要求重新批准（D1）。24 小时不是全批次 TTL。
4. **分片大小动态计算**：S = min(1000, floor(0.7 × 90 分钟 ÷ 近期 p90 单本耗时))，下限 50。1,000 只是上限，不是固定值（D3）。
5. **准入**：同一渠道账号同时最多一个领取分片处于待处理 / 处理中（D6）。
6. **职责划分**：scheduler 只负责准入、凭据判断、放行 / 暂停分片；领取的真实执行全部由 worker 完成（D7）。放行只修改任务表，不修改条目表；scheduler 只能读凭据表的非秘密列。
7. **过期不等于失败**：worker 领取条目的查询下推"分片截止时间已过则不可领取"，被挡住的条目零写入；handler 对分片条目以任务级截止时间加宽限作为第二道防线。
8. **错过截止时间**：只有从未尝试、没有任何 getcode 副作用的待处理条目，才允许随分片自动重新放行。已调用过 getcode、已有意图记录、结果不明、人工核对中、进入过任何可能写上游的执行阶段的条目，永远禁止自动重新领取，只能走回读或人工核对。同一分片连续两次错过截止时间，进入系统暂停，等待人工处理（D4）。
9. **凭据时钟**：放行前要求凭据状态可用、校验成功（`last_validated_at` 不为空且不早于凭据创建时刻）、剩余有效期 ≥ 90 分钟 + 安全余量；否则批次系统暂停，条件满足后自动恢复。"新凭据已录入"本身不是恢复条件（D5）。
10. **回退开关**：`PROMO_CLAIM_LIFECYCLE_V1_ENABLED`，代码默认 false。开关只决定新批次用哪种生命周期；关闭后，已创建的生命周期批次停止放行新分片，进入 `lifecycle_disabled`，不改写任何条目。先在预生产显式开启，完整 UAT 和 8 万级模拟 / 真实验收通过后，再决定目标环境配置（D8）。
11. **单本领取**：暂时保留旧路径（提交后 6 小时），明确列为过渡项，最终统一到放行 / 执行生命周期（D9）。
12. **不变的红线**：预读永久保留；意图记录、`maxAttempts=1`、结果不明只许回读、租约围栏、单一收尾事务、确认时原子写入，全部保持。
13. **权限同步是验收的一部分**：scheduler 新增的数据库读写，必须同步 `infra/postgres/grants.sql`、数据字典和权限契约测试，并以真实 `scheduler_app` 角色验证放行成功。

## 3. 被否决的方案

- **把 6 小时改成 24 / 72 小时**：只是推迟问题。批次越大，越接近必然过期；同时削弱了"意图放久了不能写上游"这条保护。
- **永久限制运营每批不超过 4,000 本**：把系统缺陷变成运营负担；英文书 43,431 本按语种根本切不开。只保留为正式修复上线前的临时操作规程。
- **worker 在分片收尾事务里放行下一片**：会把放行逻辑卷进单一收尾事务这条红线，也让 worker 承担准入和凭据判断。改为 scheduler 放行，代价是最多 60 秒的放行延迟。
- **放行时再从待处理池重新切分片**：需要改条目的归属，scheduler 要获得条目表的写权限，复杂度和权限面都更大。分片大小在枚举时按实测吞吐确定，吞吐变化由错过截止时间机制兜底。
- **错过截止时间后把条目标失败**：违背"过期不等于失败"，而且每条只允许执行一次，会把本可执行的条目永久浪费掉。

## 4. 后果

- 运营可以一次提交任意规模的领取；系统自动分片、依次放行，给出预计完成时间。
- scheduler 获得更大一些的数据库权限（任务表读写、条目表与意图表只读、凭据表非秘密列只读、审计表写入），需要用契约测试锁住。
- 分片之间最多 60 秒的放行间隙，相对 90 分钟窗口可以忽略。
- 在第 3 阶段（调度公平性）完成前，一个分片（约 90 分钟的量）仍会挡在其它普通任务前面，比现状的"数天"好得多，但还没根治。
- 单本领取暂时仍是旧语义，已列为过渡项。

## 5. 验收

见详细设计（`设计_领推广生命周期与自动分片_阶段2_2026-09-23.md`）第九节。关键项：开关关闭时行为不变；开关开启时 8 万本 0 条过期失败；同账号单分片（并发测试）；批准时钟只约束首次放行；D4 前置检查拒绝有副作用的条目；凭据三条件；`scheduler_app` 真实权限验证；红线变异测试全部保持有效；8 万级 dry-run 模拟通过。

## 6. 施工分期

本 ADR 覆盖的设计按 5 个施工步骤落地（`施工任务_领推广生命周期阶段2_2026-09-23.md`）：① 生命周期基础（本 ADR 随第 1 步入库）→ ② 枚举时切分片 → ③ scheduler 放行与暂停 → ④ 界面与批次级操作 → ⑤ 配置、文档与 UAT 方案。开关默认关闭，第 1 步单独合入不改变任何环境的行为。

## 7. 实施偏差与补充决定（第 5 步收口，2026-09-24）

第 1–4 步施工与 Opus 复核过程中，出现了几处设计原文没有写死、或施工中被复核发现需要收紧的地方。这些都不改变第 2 节"决定"的任何一条，只是把具体怎么落地的选择记录下来，避免以后有人对着代码找不到"为什么是这样"的出处。

1. **scheduler_app 获得 `operation_audit` 表级 SELECT，不只是 INSERT**。设计 §7 原文只写"`operation_audit`：INSERT"。施工时按此实现后，在一次性 Postgres 容器上用真实 `scheduler_app` 角色跑放行事务，第一次调用 `auditSystemAction`（`tx.operationAudit.create()`）就整体回滚，报 `permission denied for table operation_audit`。根因和 2026-09-11 "worker_app RETURNING 权限缺口全仓审计"那一次一样：Prisma 的 `.create()` 在没有显式 `select` 时，一律编译成带 `RETURNING <全部标量列>` 的 SQL，PostgreSQL 对 RETURNING 里的每一列都按 SELECT 权限校验，只给 INSERT 挡不住这一刀。`operation_audit` 对 `web_app`/`worker_app` 一直是表级 SELECT（这张表没有对任何角色隐藏的敏感列），所以给 `scheduler_app` 同样是表级 SELECT + INSERT，不再收窄到某几列，与既有两个角色的授权形状一致（`infra/postgres/grants.sql` 该处注释、`docs/governance/database-governance.md` 2026-09-23 那条变更日志已记录）。
2. **D4 不安全时复用 `deadline_missed_twice` 这一个终态桶，不新增第六个原因码**。设计 §5.7 第 3 条只说"发现一条不满足就不自动重新放行，转人工"，没有规定具体落在哪个 `system_hold.reasonCode` 上。`PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES`（第 1 步）已经把五个原因码定成常量数组，设计 §5.8 的暂停/恢复一览表也只列了五种；施工决定不为"D4 前置检查发现不安全条目"单独开第六个原因码，而是复用 `deadline_missed_twice`（同样是"连续/确定性地不能自动恢复、只能人工处理"的语义），用 `TaskControlMarker.reason`（自由文本字段，不是 `reasonCode`）写 `unsafe_to_auto_retry` 来区分"因为发现不安全条目被卡住"与"单纯连续两次超时"——两者在恢复方式上完全一样（都只能人工处理），只是审计/排查时能分辨触发原因（`src/lib/tasks/promo-claim-release.ts` 的 `hasUnsafePendingItems` 判定 + 上述 `holdShardSystemHold` 调用点）。
3. **D4 前置检查的触发条件从"只在 `deadline_missed_retry` 时检查"扩为"只要 `releaseCount > 0` 就检查"**。设计 §5.7 第 2 条描述的是"错过截止时间重新放行前"这一个场景，字面上容易理解成只在 `eligibility === "deadline_missed_retry"` 时才需要跑这条安全检查。但批次级暂停 → 恢复（3.1）会把一个已经放行过、其中某个条目可能已经调用过 getcode 的分片，交还成 `disabled` + `awaiting_release`（与"第一次放行、结构上不可能有任何副作用"的分片标记完全相同），如果放行判定只认标记不认历史，这条分片会被当成"第一次放行"直接免检，绕开 D4 的安全网。施工把前置检查的触发条件改成"只要 `shard.params.releaseCount > 0`（不论当前标记是 `awaiting_release` 还是 `system_hold:deadline_missed`）就必须重新跑一遍"，`releaseCount === 0` 的真正首次放行才完全跳过（`src/lib/tasks/promo-claim-release.ts` 第 736–767 行附近，标注为"施工任务 3.2 收口"）。
4. **枚举时新增阻断码 `queued_in_other_batch`**。设计 §5.2/§5.3 没有提到跨批次重复排队的检测；施工任务 3.4 收口时补上：worker 枚举一个生命周期批次时，如果发现某本书已经挂在另一个批次仍在排队（`disabled`/`paused`）的生命周期分片下，计入 `result.blockedReasonCounts.queued_in_other_batch`，不再把它也切进当前批次的分片——避免同一本书被两个尚未放行的批次同时排队、将来被两条独立的 scheduler 放行路径先后领取。这条检测只覆盖生命周期批次之间；旧路径双闸关闭时创建的 `disabled` 子任务不在检测范围内，是旧路径本身既有的盲区，本阶段不改旧路径判定。
5. **批次六类计数口径**：批次详情页把每个分片名下的条目按六类互斥桶计数（`已领取`/`已有推广码`/`人工核对`/`失败`/`跳过`/`剩余`），口径落在 `classifyPromoClaimItemOutcome`（`src/domain/catalog-batch.ts`）：`claimed` = `result.decision` 为 `claimed` 或 `readback_recovered`（真正新领到码，含租约丢失后回读确认成功）；`withCode`（已有推广码）= `already_available` 或 `already_fetched`（本来就有码，不消耗一次真实 getcode）；`manualReview`（人工核对）= `manual_review_required` 及任何未识别的 `decision`（CASE 表达式穷举到 `ELSE`，保证不会有条目被静默漏计到某个桶之外）；`failed`（失败）= 条目状态本身是 `failed`，或 `decision` 为 `capability_disabled`（执行时领取能力被关闭，没有调用 getcode、没有创建 `side_effect_intent`，因此归入失败而非人工核对——2026-09-24 收口，不是设计原文的默认选择，是复核期间明确讨论后定下的口径：`capability_disabled` 是确定性的配置状态，不需要人工去核对上游到底发生了什么）；`skipped`（跳过）= 状态 `skipped` 且不属于 `already_fetched`；`remaining`（剩余）= 状态 `pending`/`processing`。六类互斥、加总恒等于分片条目总数。
6. **单任务暂停/恢复对生命周期分片一律拒绝（409），单任务中止仍然允许**。设计 §5.9 只说"批次级操作：暂停/恢复/中止，作用于整个批次"，没有明确规定"能不能对批次下的单个分片直接用旧的单任务暂停/恢复按钮"。施工/复核期间发现：如果不挡住，运营在分片自己的任务详情页上用旧版通用暂停/恢复按钮，可以绕开 scheduler 的 D1/D4/D5 三道前置检查，直接把一个分片的状态改来改去——尤其是"直接恢复"，会把一个可能已经有 getcode 副作用的分片直接改回 `pending`，跳过 D4 安全网。因此：`pauseTask`/`resumeTask`（`src/server/task-admin/service.ts`）对 `task_type = 'promo_link.claim.v1'` 且 `isLifecycleShardParams(parent.params)` 为真的任务一律返回 409（`task_admin_state_conflict`），只能走批次级暂停/恢复（`pausePromoClaimBatchTx`/`resumePromoClaimBatchTx`）。单任务"中止"（`abortTask`）不受此限——放弃这一片、批次继续，是合理的人工处置，不产生"孤儿状态"那类语义混乱（中止是终态，不像暂停/恢复那样需要与批次级流程重新对齐）。
7. **系统暂停中的批次不能再手动暂停**。`pausePromoClaimBatchTx`（`src/lib/tasks/promo-claim-batch-control.ts`）与 `runPromoClaimReleaseTick`（`src/lib/tasks/promo-claim-release.ts`）共用同一份"批次正常与否"判据 `HELD_BATCH_STATUSES = ["paused", "cancelled", "disabled"]`——批次处于 `disabled`（即处于任一 `system_hold` 原因码下）时，`pausePromoClaimBatchTx` 直接返回 `state_conflict`，不允许再叠加一次人工暂停。这条不是设计条款,是为了避免"系统暂停"和"人工暂停"两种语义在同一个 `disabled` 状态上互相覆盖标记、恢复时无法判断该走哪条恢复路径的实现细节。
8. **批次级操作复用 `task:manage`（2FA）**，不是新开一个权限点。批次级暂停/恢复/中止/重新批准全部经 `requireFreshAdminServiceMutation(authorization, "task:manage", ...)`（`src/server/auth/guards.ts`），与既有单任务暂停/恢复/中止同一个 capability、同一条"新鲜会话 + 2FA"（`requireAdminTwoFactor`）要求，没有为生命周期批次单独发明一个更松或更严的权限点。
9. **批次详情页的预计完成时间（ETA）是保守的串行估算，不是按历史吞吐外推**。`estimatePromoClaimBatchEtaMinutes`（`src/domain/catalog-batch.ts`）= 当前处于 `pending`/`processing` 的分片剩余到 `deadlineAt` 的时间，加上其余排队分片各自按**整个放行窗口** `windowMinutes` 计（不是按实测平均放行→完成时长），这与 D6"同一账号同时最多一个分片在跑"的准入规则一致——排队分片确实只能一个接一个串行放行，这个 ETA 因此是一个偏保守（略高估）但结构上不会算少的估计，不依赖对"这一批到底能跑多快"的乐观假设。
10. **`deadline_missed_twice` 的分片只能走批次级中止，没有单独的"分片级重新放行"操作**。这不是遗漏，是设计 §5.8 暂停/恢复一览表本身的选择："连续两次错过截止时间"这一行的恢复方式写的就是"人工处理"，没有配套一个"重新放行这一片"的按钮——运营能做的人工处置就是批次级中止（放弃这一片和批次里其它未完成分片）或者不处理（保持系统暂停，问题排查清楚后再决定），不提供绕开 D4 安全网、直接把一个已经两次错过截止时间的分片重新放行的入口。
