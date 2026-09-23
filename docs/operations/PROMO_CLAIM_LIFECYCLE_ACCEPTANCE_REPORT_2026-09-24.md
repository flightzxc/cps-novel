# 领推广链接生命周期（阶段2）验收报告

日期：2026-09-24（北京时间）
依据：`设计_领推广生命周期与自动分片_阶段2_2026-09-23.md` 第九节（10 项验收标准）、`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`
范围：本报告覆盖第 1–5 步的全部代码与本步（第 5 步）新增的配置/文档；第 2、10 两项需要预生产真实环境，本报告如实标注为**待 UAT**，不冒充已通过。
工作树：`cps海阅/promo-claim-lifecycle-v1`，分支 `feat/promo-claim-lifecycle-v1`

---

## 逐项对照

### 1. 开关关闭时，行为与改动前逐项一致（现有测试全部通过）

**状态：通过。**

- `src/lib/tasks/catalog-batch.ts` 的 `resolveCatalogBatchLifecycleFields` 在开关关闭时返回 `{ fields: {}, expiresAt: legacyExpiresAt }`——批次参数不写任何 `lifecycleVersion` 字段，`expiresAt` 沿用旧的"提交时刻 + 6 小时"。
- 真实 Postgres 验证：`tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts` 的 "switch off: the same data still builds exactly one pending child task under the legacy TTL, byte-for-byte unchanged" 用例（随三个一次性容器脚本之一同跑，见第 2 项）。
- 全量单测：

  ```
  npx vitest run --project node tests/backend/tasks/promo-claim-lifecycle.test.ts \
    tests/backend/tasks/promo-claim-release.test.ts \
    tests/backend/tasks/promo-claim-release-branches.test.ts \
    tests/backend/tasks/promo-claim-release-scheduler-wiring.test.ts \
    tests/backend/tasks/promo-link-claim-handler.test.ts \
    tests/backend/catalog-batch/lifecycle-shard-enumeration.test.ts \
    tests/backend/catalog-batch/lifecycle-enqueue.test.ts
  ```

  实测：**7 个文件、158 条用例全部通过**（2026-09-24，本报告执行）。
- 全量 `npm test`（含 UI + backend + integration）在本报告末尾的"最终验收命令"一节统一给出。

### 2. 开关开启，一次提交 8 万本：分片依次放行、依次完成，0 条过期失败，运营全程不需要拆批

**状态：待 UAT（预生产真实环境）。** 见 `docs/operations/PROMO_CLAIM_LIFECYCLE_UAT_PLAN_2026-09-24.md` 第三节"真实验收"。不得在这里写成"已通过"——这一项按设计原文本就要求预生产真实环境、Owner 决定时间窗，本报告只做代码/测试层面能覆盖的部分：

- **结构性 8 万级实测**（本报告执行，2026-09-24）：临时把 `PROMO_CLAIM_SHARD_ENUM_SCALE_COUNT` 调到 80000 跑 `tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts` 的枚举用例（一次性 `postgres:16.14` 容器）：
  - 80,000 本按 `computeShardSize` 算出的分片大小（样本不足回退 5 秒/本 → 756 本/片）正确切成 106 个分片，条目总数、`shardIndex`/`releaseCount`/`missedDeadlineCount` 初始值、`payload.lifecycle="shard_v1"`、`requestToken`/`operationScopeHash` 全局唯一均逐项正确；
  - **枚举事务真实耗时 `enumerateMs=10127`（约 10.1 秒）**，远低于 120 秒的事务超时；
  - 放行前 `selectPending` 完全领不到任何条目；模拟放行（写 `deadlineAt`）后同一分片条目立即可领——下推条件不是恒假；
  - 用后已删除容器，无残留。
- 这条实测证明的是"结构性正确 + 枚举不是瓶颈"，**不等于**"8 万本从提交到全部领取完成、0 条过期失败"这一完整验收标准——后者需要真正跑通 scheduler 的多轮放行 + worker 的真实（或等价）领取执行，这正是待 UAT 的部分。

### 3. 任意时刻同一渠道账号最多一个分片处于待处理 / 处理中（真实 Postgres 并发触发放行 100 次）

**状态：通过。**

- `tests/integration/tasks/promo-claim-release-postgres.test.ts` "并发放行：同一账号 100 次并发触发，任意时刻至多一个分片处于 pending/processing" 用例：100 次并发调用 `runPromoClaimReleaseTick`，`releasedCount === 1`、`blockedCount === 99`，数据库里同账号处于 `pending`/`processing` 的分片数恰好为 1。
- 命令与结果（`scripts/run-promo-claim-release-postgres-verification.sh`，一次性 `postgres:16.14` 容器，本报告执行 2026-09-24）：

  ```
  tests/integration/tasks/promo-claim-release-postgres.test.ts (18 tests) 1196ms
  {"status":"ok","models":53,"recordCount":1234,"activeCount":1164,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
  PROMO_CLAIM_RELEASE_DICTIONARY_DRIFT=0
  PROMO_CLAIM_RELEASE_POSTGRES_VERIFICATION=PASS
  ```

### 4. 批准时钟：未放行过的批次超过 24 小时，停在 `approval_expired`，不写上游；首个分片放行后，即使总执行超过 24 小时，也不再要求重新批准

**状态：通过。**

- 同上 `promo-claim-release-postgres.test.ts` "D1 批准时钟：从未放行过的批次超过批准有效期后停在 approval_expired；首个分片放行后即使总执行超过有效期也不再要求重新批准" 用例，覆盖两个方向。
- 纯函数边界单测：`tests/backend/tasks/promo-claim-lifecycle.test.ts` 对 `isApprovalExpired` 的全部分支（`firstReleasedAt` 存在/缺失 × `approvalValidUntil` 存在/缺失/已过/未过）。

### 5. 错过截止时间：条目保持待处理，分片进入 `deadline_missed`，零条目写成失败；满足 D4 条件时自动重新放行；构造"待处理但已有意图记录"的条目时，拒绝自动重新放行并转人工；连续两次错过进入 `deadline_missed_twice`

**状态：通过。** `promo-claim-release-postgres.test.ts` 的 `describe("D4/§5.7 错过截止时间")` 覆盖全部四个分支：

- 第 1 次错过：条目保持 `pending`（`attemptCount: 0`），分片进 `deadline_missed`，满足条件后下一轮自动重新放行（`releaseCount: 2`）；
- D4 前置检查：构造一条已存在 `side_effect_intent`（`request_summary.novelSourceItemId` 指回该书）的条目，第 2 次判定时拒绝自动重新放行，转 `deadline_missed_twice`，`reason: "unsafe_to_auto_retry"`；条目本身零写入（仍 `pending`，`attemptCount: 0`）；
- 变体：条目 `attemptCount != 0`（曾被拿到租约又退回）但**没有**任何意图记录，同样拒绝自动重新放行（D4 是"两个独立条件都必须满足"，不是任一满足即可）；
- 连续两次单纯超时（无意图记录）→ `deadline_missed_twice`；此后 `select-next` 不再选中该分片（需要人工处理）。
- 批次级暂停 → 恢复后再放行同样重新过 D4（`describe("阶段2 第4步：批次级暂停→恢复后再放行必须重新过 D4")`），覆盖 ADR 第 7 节第 3 条记录的那处施工收口。

### 6. 凭据：未校验、状态不可用、剩余有效期不足三种情况都不放行；替换凭据并校验通过后自动恢复；意图记录证明同一本书至多一次领取调用

**状态：通过。** `promo-claim-release-postgres.test.ts` 的 `describe("D5 凭据三条件")` 三个用例分别覆盖：

- 无 `active` 凭据行 → `credential_missing`；补上就绪凭据后自动恢复并放行；
- 凭据存在但 `last_validated_at` 为空 → `not_validated`；校验后自动恢复；
- 剩余有效期不足一个窗口 + 安全余量 → `expires_too_soon`；续期后自动恢复。
- "同一本书至多一次领取调用"由第 1 步冻结未改的红线（`SideEffectIntent` 唯一性、`maxAttempts=1`）保证，本步的 D4 前置检查（第 5 项）是这条红线在"自动重新放行"这个新增场景下的延伸验证，两者共同覆盖"意图记录证明至多一次调用"。

### 7. 批次级暂停 / 恢复 / 中止都正确级联；中止仍然终止所有未尝试条目

**状态：通过。** `tests/integration/tasks/promo-claim-batch-control-postgres.test.ts`（`scripts/run-promo-claim-batch-control-postgres-verification.sh`，一次性 `postgres:16.14` 容器，本报告执行 2026-09-24）：

```
tests/integration/tasks/promo-claim-batch-control-postgres.test.ts (18 tests) 1055ms
{"status":"ok","models":53,"recordCount":1234,"activeCount":1164,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PROMO_CLAIM_BATCH_CONTROL_DICTIONARY_DRIFT=0
PROMO_CLAIM_BATCH_CONTROL_POSTGRES_VERIFICATION=PASS
```

覆盖 `describe` 分组：3.1 暂停（只有当前放行的分片跟着暂停，排队中的 `disabled` 分片原样不动）/ 3.1 恢复（暂停的已放行分片一律交还成 `disabled + awaiting_release`，绝不直接改回 `pending`）/ 3.1 中止（级联终止批次自身 + 所有未终结分片的全部未尝试条目，`terminatedItemCount` 与实际终止的条目数一致）/ 3.3 重新批准（仅对 `approval_expired` 且从未放行过的批次生效）/ 3.4 枚举盲区（跨批次排队冲突阻断）/ 3.5 批次详情 DTO / 真实角色边界（D7，`web_app` 驱动批次操作、`worker_app` 驱动枚举、`scheduler_app` 驱动放行，三个角色各自只能做自己权限范围内的事）。

### 8. scheduler 以 `scheduler_app` 角色在真实数据库上完成一次放行（证明权限到位），且无法读取凭据密文列

**状态：通过。** `promo-claim-release-postgres.test.ts` 的 `describe("真实 scheduler_app 角色权限验证（D7）")`：

- `SELECT current_user` 确认连接身份确实是 `scheduler_app`（不是拿 `migration_owner` 冒充）；
- 用该角色真实完成一次放行（`action: "released"`）；
- 对 `channel_account_credential.encrypted_secret`/`secret_fingerprint`/`SELECT *`、`side_effect_intent.target_id`/`.status`/`SELECT *` 的读取均被数据库拒绝（`permission denied`）；
- 对 `channel_account_credential`/`operation_audit` 的越权写入（`UPDATE`/`DELETE`）同样被拒绝。

### 9. 意图记录、租约围栏、单一收尾事务、`maxAttempts=1` 的既有变异测试全部保持有效；新增用例覆盖下推条件、放行锁、D4 前置检查，并做变异验证

**状态：通过（本步验证不回归；新增覆盖点的变异证据见各自步骤记录）。**

- 红线既有变异测试：本步（第 5 步）只改配置/文档/预生产脚本，未触碰 `worker/handlers/promo-link-claim.ts`、`src/lib/tasks/store.ts` 的执行逻辑；`tests/backend/tasks/promo-link-claim-handler.test.ts`（53 用例）与相关红线用例本报告执行仍全部通过，证明第 1–4 步施工遗留的变异证据未被本步破坏。
- 下推条件（`selectPending` 对生命周期分片的 `deadlineAt` 判定）：`tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts`（本报告在 80,000 规模下重新验证：放行前零可领，"父任务状态被误改成 pending 但缺 deadlineAt"仍然零可领，写入合法 `deadlineAt` 后立即可领）+ `tests/integration/tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts`（第 1 步独立真实 Postgres 验收，覆盖 handler 侧任务级截止 + 宽限判定）。
- 放行锁（D6 按账号事务级咨询锁）：本项第 3 条的 100 次并发用例即是这条变异（"去掉咨询锁"）的正面证据——真实并发下只有 1 次成功。
- D4 前置检查：本项第 5 条列出的四个分支本身就是"D4 前置检查漏判"这条变异（"忘记检查意图记录"/"只检查 attempt_count"/"只在 deadline_missed_retry 时检查、漏掉暂停恢复路径"）的正面/反面对照用例。
- 本步（第 5 步）自己新增的一处判定逻辑——`scripts/preproduction/lib.sh` 的 `preprod_assert_promo_claim_lifecycle_config()`——变异证据见 §2.2 的独立记录：删除 `preflight.sh` 调用行、放宽 `lib.sh` 正整数下界判断，均使新增的 92 条用例中的相应用例转红；恢复后 `git diff --quiet` 确认无残留、全部转绿（详见对应 commit `49f00f1`）。

### 10. 8 万级模拟：用 dry-run 模式（不请求上游，单本约 0.05 秒）跑 8 万本，配合很小的窗口，强制触发多次放行、错过截止时间和凭据暂停，全程无过期失败、无重复领取。真实验收在预生产开启开关后，由 Owner 决定时间窗

**状态：待 UAT，且存在一个需要 Owner 先拍板的前置问题。** 详见 `docs/operations/PROMO_CLAIM_LIFECYCLE_UAT_PLAN_2026-09-24.md` 第二节。

核实结论（本步完成，不是待办）：**"生命周期批次 + dry-run" 这条端到端路径目前不存在**——`src/lib/tasks/catalog-batch.ts` 的批次入队（第 173 行）与 `worker/handlers/catalog-batch.ts` 枚举出的每个生命周期分片（第 411 行）都把 `mode` 硬编码为 `"apply"`，两处都不接受外部传入 `mode`；`worker/handlers/promo-link-claim.ts` 虽然认识 `mode === "dry_run"`，但目前只有单本领取入口（`src/lib/tasks/promo-link-claim.ts`）会真正用到这个参数。这不是配置缺失，是代码结构性缺失，本步按施工任务的要求**没有**擅自新增这条路径，而是把三个选项（新增受开关保护的 dry-run 生命周期批次入口 / 改用 ops 脚本构造等价数据 / 改用小批量真实领取代替）列成待决问题，交给 Owner 选择（见 UAT 方案 §2.2）。

---

## 2.2 校验规则与测试证据（施工任务第 5 步专项要求）

`scripts/preproduction/lib.sh` 新增 `preprod_assert_promo_claim_lifecycle_config()`，规则与 `resolvePromoClaimLifecycleConfig`（`src/lib/tasks/promo-claim-lifecycle.ts`）逐条一致：

- 六个数值项（批准有效期/放行窗口/分片上下限/凭据安全余量/截止宽限）：未设置或去空白后为空串→用回退默认值；否则必须是十进制整数字面量，满足正数（`>0`）或非负（`>=0`）；`shardSizeMin` 不得超过 `shardSizeMax`。
- 开关：**原值必须恰好是 `""`（未设置/显式空串）、`"true"`、`"false"` 三者之一，不做任何 trim**——其它任何值（含首尾空白、`"TRUE"`/`"1"`/`"yes"`/`"on"`/`"False"` 等）一律 FAIL。比 TS 解析器本身更严格（TS 对非法开关值从不报错，只会静默当 `false`）。

**2026-09-24 Opus 复核发现并已修复的一处问题**：初版实现在比较前先对开关原值做 `_pcl_trim`。`isPromoClaimLifecycleEnabled`（TS）是 `env[...] === "true"` 严格字符串相等、不 trim；于是目标机 env 里若把开关写成带首尾空白的形态（如 `" true"`），旧实现会把它 trim 成合法的 `"true"` 而 PASS、打印 `enabled=true`，但运行时 TS 侧按严格相等判定为 `false`——preflight 说"已开启"，实际运行时是关闭的，这正是这道门禁本该消除的"两边判定不一致"，却被门禁自己的 trim 制造了出来。修法：去掉开关判定里的 `_pcl_trim` 调用，直接匹配原始值（`scripts/preproduction/lib.sh` 的 `preprod_assert_promo_claim_lifecycle_config()`）。初版的"双跑"一致性测试只覆盖了六个数值项（49 条），没有覆盖开关，所以没能抓住这处不一致。

测试证据（`tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts`，本报告执行 2026-09-24，含 Opus 复核后新增的开关双跑测试）：

```
✓ preprod_assert_promo_claim_lifecycle_config: 全部未设置 -> PASS，取回退默认值 (3 tests)
✓ preprod_assert_promo_claim_lifecycle_config: 开关严格 true/false/未设置 (4 tests)
✓ preprod_assert_promo_claim_lifecycle_config: 六个数值项——非整数/越界/min>max (26 tests)
✓ preflight.sh 接线：调用行真的存在，取证行真的在最终 PASS 之前 (2 tests)
✓ preflight.sh 真实行为（不 mock）：配置门禁在写闸判定之后、git_commit 判定之前生效 (4 tests)
✓ TS 解析器 vs shell 校验：数值项判定一致性（防两边漂移） (57 tests，含新增的首尾空白样例 " 90"/"90 ")
✓ TS 解析器 vs shell 校验：开关判定必须逐值一致（不得靠 trim 制造假一致） (10 tests，新增)
✓ bash 5 下的行为对照（docker bash:5.2） (4 tests)

Test Files  1 passed (1)
     Tests  110 passed (110)
```

变异证据（本报告执行，均已复原）：

1. **删除 `preflight.sh` 的调用行** `lifecycle_config_evidence="$(preprod_assert_promo_claim_lifecycle_config)" || fail "$lifecycle_config_evidence"` → 3 条依赖真跑 `preflight.sh` 的用例转红（"接线"文本用例 + 两条真实行为用例）；`cp` 恢复后重跑 110/110 全绿，`git diff --quiet -- scripts/preproduction/preflight.sh` 确认无残留。
2. **放宽 `lib.sh` 的正整数下界判断**（`if (( value <= 0 ))` 改成恒假 `if false`）→ 16 条用例转红，含全部四个正整数字段的"0"/负数取值用例，以及"双跑"防漂移测试里所有涉及正整数字段边界的组合；`cp` 恢复后重跑 110/110 全绿，`git diff --quiet -- scripts/preproduction/lib.sh` 确认无残留。
3. **（Opus 复核发现问题后新增）把 trim 加回开关判定**（`enabled_raw="$(_pcl_trim "${PROMO_CLAIM_LIFECYCLE_V1_ENABLED:-}")"`）→ 精确 2 条用例转红：`" true"`/`"true "` 这两个专门针对"trim 制造假一致"的用例（其余 8 个开关双跑用例不受影响，因为它们的原值即便 trim 后仍然不是合法的 `true`/`false`，如 `"TRUE"`/`"1"`）；`cp` 恢复后重跑 110/110 全绿，`git diff --quiet -- scripts/preproduction/lib.sh` 确认无残留。
4. **（Opus 复核发现问题后新增）让开关额外接受 `"yes"`**（`case` 分支改成 `"true"|"yes") enabled="true" ;;`）→ 精确 1 条用例转红（`"yes"` 那一条，断言"shell 必须 FAIL"却观察到 `rc=0`）；`cp` 恢复后重跑 110/110 全绿，`git diff --quiet -- scripts/preproduction/lib.sh` 确认无残留。

四次变异均按"改坏 → 转红 → 用 `cp` 备份恢复（非 `git checkout`，因为改动集混有本步计划内的编辑）→ `git diff --quiet` 确认逐字节复原 → 重跑转绿"的顺序执行，脚本用 `set +e` 避免中途因非零退出码提前中断。

---

## 2.6(a) dry-run 路径核实结论（不能跑，已列选项）

见本报告第 10 项与 UAT 方案 §2.1/§2.2；结论：**不能直接跑通**，已给出三个选项交 Owner 选择，未擅自实现新代码路径。

---

## 新增 / 修改的文档清单

| 文件 | 改动 |
| --- | --- |
| `infra/preproduction/preprod.env.example` | 补齐领推广生命周期七项配置，开关默认关闭，注释写明 Owner 批准流程与只重建三服务的操作步骤 |
| `scripts/preproduction/lib.sh` | 新增 `preprod_assert_promo_claim_lifecycle_config()` |
| `scripts/preproduction/preflight.sh` | 接入上述校验，取证行在最终 PASS 之前打印 |
| `tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts` | 新增，92 条用例 |
| `tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts` | 新增一条合并渲染契约测试，验证七项配置真的透传到 web/worker/scheduler |
| `docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md` | 新增"实施偏差与补充决定"一节（十条） |
| `docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md` | 新增"领推广链接生命周期"一节（中文） |
| `docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md` | 新增"领推广链接生命周期开关"一节（中文） |
| `docs/governance/database-governance.md` | §3.4 补 JSON 键语义说明子节；§12 补一条改动日志 |
| `docs/operations/PROMO_CLAIM_LIFECYCLE_UAT_PLAN_2026-09-24.md` | 新增，本报告的姊妹文档 |
| `docs/operations/PROMO_CLAIM_LIFECYCLE_ACCEPTANCE_REPORT_2026-09-24.md` | 新增，即本文件 |

---

## 最终验收命令与结果

以下命令均在本工作树（`cps海阅/promo-claim-lifecycle-v1`，`feat/promo-claim-lifecycle-v1`）本报告最终定稿前执行一次，结果见提交说明与本报告正文引用的具体输出；完整的 `npx tsc --noEmit`、`npm test`、三个一次性容器脚本与 `tests/backend/governance` 的最终一次运行结果，以本次提交的 commit 记录与 `git status --short`（应为空）为准。
