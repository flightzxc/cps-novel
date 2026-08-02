# src/lib/tasks/

**Owner: Codex（独占写入）**

## 用途

任务定义与处理器（handler）注册表、任务领取/租约/心跳续租辅助逻辑，供 `worker/` 与 `scheduler/` 共用。

## P1-07 实现

- `registry.ts`：HANDLERS 注册与 allowlist 双重 fail-closed；
- `store.ts`：三类固定 PostgreSQL claim/recovery SQL、lease、heartbeat、fencing 与 parent 重算；
- `scheduler.ts`：ScheduleRun/CronRun/GenericTask 单事务 singleton enqueue；
- `side-effect-intent.ts`：外部调用前独立提交的 intent 与 unknown 阻断边界；
- `state.ts` / `types.ts`：共享状态派生与运行时接口。

## 特别纪律

🔴 **投递语义为 at-least-once，业务侧必须幂等，且必须有 fencing。**

- 每次租约分配生成新的 `execution_token`，并使 `lease_epoch` 单调 +1；
- Worker 每一次业务写入都必须在同一事务内带 `WHERE execution_token = ? AND lease_epoch = ?` 的 fencing 条件；fencing 不匹配则该次写入必须被拒绝，**旧租约持有者不得提交业务结果**，且不得重试写入；
- 心跳续租只延长 `locked_until`，不改变 `lease_epoch`；只有租约易主才 +1；
- 任务领取使用 `FOR UPDATE SKIP LOCKED` + 同事务 update/audit，双 worker 对同一任务只执行一次；
- allowlist 与 handlers 注册表需双重 fail-closed 交叉核验。
