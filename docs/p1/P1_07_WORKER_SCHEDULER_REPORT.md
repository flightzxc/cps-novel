# P1-07 Worker、Scheduler、任务租约与 fencing 验证报告

## 1. 结论

P1-07 已实现 PostgreSQL 任务运行时地基，投递语义明确为 **at-least-once**。三类 Task/Item 共用相同的所有权不变量，但各自保留固定 SQL：pending claim 与 expired recovery 完全分离，均使用 `FOR UPDATE SKIP LOCKED`，并实测命中 P1-05B 的独立部分索引。

- 分支：`feature/v0.1.0-p1-worker-runtime`
- 原始基线：`d7287729bd02b4f9957485aec6be96118efae864`
- 合并前同步基线：`419ac82c8f8646b74b1621733a1954fdd7b12035`
- 原始 P1-07 HEAD：`ff0ad82f1fd1003de924a49a65c3e249628e457b`
- Worker commit（rebase 后）：`2ef89b0` `feat(p1-07): implement PostgreSQL task claim lease and fencing`
- Scheduler commit（rebase 后）：`5e837e3` `feat(p1-07): add singleton scheduler enqueue runtime`
- 测试/报告 commit：本报告随 `test(p1-07): verify concurrent worker and scheduler invariants` 提交

没有修改 Prisma Schema、Migration、`package.json`、lockfile、infra、`scripts/db`、UI、contracts 或 CPS。没有新增 npm 依赖，没有实现 Adapter、渠道 handler、Auth/Credential、Promo claim 或网络副作用。

## 2. Worker 语义

- 生产 `HANDLERS` 注册表有意为空；测试和后续业务通过显式 registry 注入。allowlist 只消费 `allowlist ∩ HANDLERS`，空 allowlist 不查询、不恢复、不消费。
- pending claim 在事务内使 `attempt_count + 1`、`lease_epoch + 1`，并生成新的 UUID `execution_token`；租约时间统一使用 PostgreSQL `transaction_timestamp()`。
- expired recovery 是独立路径：attempt 未达 3 次时清租约回到 `pending`；达到上限时进入 terminal `failed`，错误码为 `stale_processing`。恢复本身不增加 attempt/epoch，后续 pending claim 才增加。
- heartbeat 同时校验 owner、token、epoch、`processing` 和未过期租约，只延长 `locked_until`/`heartbeat_at`，不改变 epoch。
- finalize 的第一条 update 带完整 fencing 条件；影响 0 行抛出非重试 `LeaseLostError`，protected business write callback 不运行，旧结果不重试。
- 合法 protected write、item terminal transition、operation audit 和 parent 重算位于同一事务。parent 计数来自数据库聚合，不使用内存累加器。
- Worker 收到 SIGINT/SIGTERM 后停止新 claim/recovery，保持当前 heartbeat，等待当前 handler/事务 drain；最终提交仍必须通过 fencing。

## 3. Scheduler 与 side-effect intent

- `scheduler/index.ts` 是独立一次性进程入口，不接入 Next/Web instrumentation。本轮 production schedule registry 为空。
- 同一个 `(schedule_key, scheduled_for)` 通过数据库唯一键竞争；ScheduleRun、GenericTask/items、CronRun 及最终状态在一个事务中完成。
- 10 个独立 Prisma client 并发 enqueue，结果为 1 个 `enqueued`、9 个 `duplicate`，数据库中各留下 1 个 ScheduleRun、CronRun、GenericTask 和 item。
- task 创建后注入异常时整个事务回滚，ScheduleRun、CronRun、GenericTask 和 items 均为 0。
- Scheduler 不导入 Credential、Adapter、IndexNow 或网络调用代码，也不读取解密 key。
- `prepareSideEffectIntent` 使用独立顶层事务，返回时 intent 已提交；`effect_key` 与 operation/idempotency identity 由数据库唯一约束原子兜底。
- unknown outcome 进入 `claim_retry_blocked`，不允许自动转 confirmed/failed；只能进入 `manual_review_required` 边界。本轮没有真实外部调用。

## 4. PostgreSQL 16 验证

使用唯一 disposable PostgreSQL `16.14 (Debian 16.14-1.pgdg13+1)` 容器和 volume，部署现有 `20260803090000_p1_initial_schema` migration 后运行测试。未连接正式、预生产或 CPS 数据库；验证结束后容器和 volume 均已清理。

| 验证项 | 结果 |
| --- | --- |
| build | PASS（沙箱外重跑；首次失败仅因沙箱禁止 Turbopack 绑定本地端口） |
| typecheck | PASS |
| lint | PASS |
| backend | 7 files / 21 tests PASS |
| P1-07 PostgreSQL integration | 1 file / 11 tests PASS |
| 完整 `npm test` | 8 files PASS、3 个 gated integration files skipped；22 PASS、25 skipped |
| 双 Worker 单 owner | PASS |
| attempt 在 claim 时 +1 | PASS |
| expired → pending → 新 owner | PASS，token 更换、epoch 1→2 |
| 旧 owner finalize | PASS，0 行并拒绝 protected write |
| heartbeat epoch | PASS，不变 |
| poison item | PASS，attempt=3 后 terminal failed |
| kill/restart | PASS，真实子 Worker SIGKILL 后恢复并以 attempt=2/epoch=2 接管 |
| allowlist 空 | PASS，零消费 |
| 未注册 handler | PASS，结构化显式失败 |
| 10 Scheduler 并发 | PASS，1 enqueue / 9 duplicate |
| CronRun/Task 原子性 | PASS，故障注入后均无残留 |
| side-effect intent | PASS，并发唯一、独立提交可见、unknown 阻断 |

## 5. 实际索引计划

EXPLAIN 使用运行时同形 SQL：item candidate 先由 `MATERIALIZED` CTE 按对应部分索引执行 `FOR UPDATE SKIP LOCKED`，外层再做 parent/allowlist 过滤。pending 与 expired 没有用 `OR` 合并。

| Item 表 | pending 实际索引 | expired 实际索引 |
| --- | --- | --- |
| `catalog_scan_task_item` | `catalog_scan_task_item_pending_global_idx` | `catalog_scan_task_item_expired_lease_idx` |
| `channel_sync_task_item` | `channel_sync_task_item_pending_global_idx` | `channel_sync_task_item_expired_lease_idx` |
| `generic_task_item` | `generic_task_item_pending_global_idx` | `generic_task_item_expired_lease_idx` |

最终验证标记：

```text
P1_07_VERIFICATION=PASS
P1_07_DATABASE_CLEANED=yes
```

## 6. CPS 与交接

- CPS 只读参考目录：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`
- 开工前：clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- 完成后：clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- CPS SOP_ACK：`54c3e49433ca05f5129afe1bda74d4e39b88cba175b1cd6a18ebb26c4f3704fd`
- 下一门禁：`FOCUSED_SOL56_P1_07_CODE_REVIEW`

## 7. 合并前基线同步与回归

P1-07 从 `origin/main@419ac82c8f8646b74b1621733a1954fdd7b12035` 无冲突 rebase，三个逻辑提交保持独立、未 squash。P1-06 新增的数据库权限、备份和治理文件未发生冲突，也未由 P1-07 修改。

```text
ORIGINAL_HEAD=ff0ad82f1fd1003de924a49a65c3e249628e457b
REBASED_ON_MAIN=419ac82c8f8646b74b1621733a1954fdd7b12035
NEW_HEAD=FINAL_BRANCH_HEAD_VERIFIED_BY_GIT_LS_REMOTE_AND_RECORDED_IN_GATE_OUTPUT
REBASE_CONFLICTS=NONE
POST_REBASE_TESTS=BUILD_PASS,TYPECHECK_PASS,LINT_PASS,NPM_TEST_PASS_22_25_SKIPPED,BACKEND_PASS_21,POSTGRES_INTEGRATION_PASS_11
POSTGRES_VERSION=16.14 (Debian 16.14-1.pgdg13+1)
DISPOSABLE_DATABASE_CLEANED=YES
CPS_STATUS_BEFORE=clean@d77c3b968285698529cf97c7f0f97b286d7a2a9c
CPS_STATUS_AFTER=clean@d77c3b968285698529cf97c7f0f97b286d7a2a9c
```

`NEW_HEAD` 的精确 SHA 由包含本段内容的最终 commit 决定，因此不能在同一 commit 内自引用；最终 gate 输出和 `git ls-remote` 结果记录该 SHA。
