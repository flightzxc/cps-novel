# P1-07R Worker Runtime 审计修复报告

## 1. 状态

P1-07R 从 `origin/main@1342f93118ab9a05d6a6e6f9168b65e844ab2d28` 前向修复 SOL 5.6 聚焦审计发现的三项问题。本报告记录实现与回归证据；结论仍待新的 SOL 5.6 聚焦复核，不自行宣称审计 PASS。

## 2. Parent 锁内重算

根因是不同 item 的 finalize 事务可在更新 parent 时使用不完整的聚合快照，后提交者覆盖正确状态。修复后，三类 parent 均使用固定表名执行 `SELECT id ... FOR UPDATE`，取得对应 parent 行锁后才执行 item 聚合和 parent UPDATE。PostgreSQL READ COMMITTED 会在锁等待结束后的聚合语句取得新的 statement snapshot。

- item terminal update 仍先通过 owner、execution token、lease epoch、processing 和有效租约 fencing。
- parent 锁、聚合、parent update 与 protected write 均处于同一事务。
- 锁粒度是单一 parent 行；不同 parent 继续并发。
- parent 的 `total_count`、`success_count`、`failed_count`、`skipped_count` 和 status 一次更新。
- Schema 未冻结 `pending_count`/`processing_count` 列；锁内聚合仍计算这两个值并用于 parent 状态，回归测试直接从 item 表断言 processing item 为 0。
- 不使用内存计数，不进行异步补算，不改变事务隔离级别。

审计前稳定复现：items=`[success, success]`，parent=`processing/success_count=1`。修复后真实双连接测试用第三连接持有 parent 行锁，强制两个 finalize 同时进入锁等待；释放 barrier 后连续 3 轮均得到 parent=`completed/success_count=2`，且两个 item 均 success。另一项测试证明锁住 parent A 不阻塞 parent B 完成。

## 3. 持久化错误安全边界

新增 `sanitizePersistedTaskError(error)`，并在 `guardedFinalize` 数据库边界统一调用。Worker 捕获 handler/runtime 异常和进程入口日志也使用同一安全形态。

- 只持久化 `code` 和 `message`。
- 未知错误默认 code 为 `handler_failed`；runtime 错误使用 `worker_runtime_error`。
- message 最大长度为 `1024` UTF-16 code units，先脱敏再稳定截断。
- Bearer、JWT、API key、password、token、secret、credential、cookie 和完整 PostgreSQL connection URL 替换为 `[REDACTED]`；数据库连接类 Error 使用通用安全消息。
- 不复制 stack、cause、request headers、response body 或未知 object payload。
- stale recovery 的错误也转换为相同安全 shape。

Backend 覆盖 Error、字符串、未知 object、全部指定 secret 形态和超长内容。PostgreSQL 集成测试直接读取 item `error` JSONB，确认仅有 code/message、原始 secret 不存在、message 不超过 1024 且无 stack。

## 4. 有限 shutdown drain

Worker 增加 `shutdownDrainTimeoutMs`，默认 `30_000ms`；独立进程可通过 `WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS` 配置正整数值。

- shutdown signal 立即停止新的 cycle/claim，并传递给当前 handler。
- deadline 前自动 heartbeat 和 handler heartbeat 能力保持有效，允许 cooperative handler 正常提交。
- deadline 到达后 heartbeat controller 停止，handler heartbeat 返回 false；已发起的 handler heartbeat 被跟踪并收尾后，runtime 在有限时间内返回。
- runtime 不为超时 handler写 success/failed；lease 自然过期后由 recovery 接管。
- 忽略 AbortSignal 的 handler 即使迟到返回，也没有 finalize 路径；旧 lease 的显式 finalize 继续被 token+epoch fencing 拒绝。
- library 不调用 `process.exit`，timer 和 abort listener 在 settle 时释放。

真实 PostgreSQL 场景 A 使用 abort-aware handler，在 250ms 测试 deadline 内合法完成并写入 success。场景 B 使用忽略 AbortSignal 的 handler和 40ms 测试 deadline，验证 runtime 有限返回、heartbeat 停止、数据库时钟确认 lease 过期、新 owner 以新 token/epoch 接管、旧结果被拒绝且新结果保持。

## 5. 修改文件

- `src/lib/tasks/errors.ts`
- `src/lib/tasks/index.ts`
- `src/lib/tasks/store.ts`
- `worker/index.ts`
- `worker/runtime/worker.ts`
- `tests/backend/tasks/error-sanitizer.test.ts`
- `tests/backend/tasks/runtime-contract.test.ts`
- `tests/integration/tasks/p1-07-postgres.test.ts`
- `docs/p1/audit/P1_07_SOL56_FOCUSED_CODE_REVIEW.md`
- `docs/p1/P1_07_REMEDIATION_REPORT.md`

## 6. 回归证据

```text
BUILD=PASS
TYPECHECK=PASS
LINT=PASS
NPM_TEST=9_FILES_31_TESTS_PASS_30_ENVIRONMENT_GATED_SKIPPED
BACKEND=8_FILES_30_TESTS_PASS
POSTGRES_VERSION=16.14 (Debian 16.14-1.pgdg13+1)
POSTGRES_INTEGRATION=16_OF_16_PASS
PARENT_BARRIER_REPETITIONS=3_PASS
DIFFERENT_PARENT_CONCURRENCY=PASS
ERROR_JSONB_REDACTION=PASS
ABORT_AWARE_DRAIN=PASS
ABORT_IGNORING_DRAIN=PASS
LATE_RESULT_FENCING=PASS
INDEX_PLANS=ALL_SIX_TARGET_INDEXES_PASS
DISPOSABLE_DATABASE_CLEANED=YES
```

最终 CPS 与远端状态将在提交前门禁补录。

## 7. 下一门禁

```text
NEXT_GATE=FOCUSED_SOL56_P1_07_FIX_REVIEW
```
