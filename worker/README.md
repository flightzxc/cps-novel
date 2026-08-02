# worker/

**Owner: Codex（独占写入）**

## 用途

Worker 进程入口与任务处理器实现：轮询/领取任务、执行业务逻辑（含需要解密凭证的任务）、写回结果与审计。是本项目唯一可解密渠道凭证的进程。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-07（Worker、Scheduler、任务租约和 fencing）** 填充。

## 特别纪律

- ✅ **唯一可解密凭证的进程**；所有需要凭证的任务由 Worker 执行，Web 进程只入队；
- 原子领取必须用 `FOR UPDATE SKIP LOCKED` + 同事务 update/audit；
- 每次业务写入必须携带 `execution_token` + `lease_epoch` fencing 条件，旧租约持有者写入必须被拒绝；
- 进程崩溃重启后，item 需可恢复且 attempt 计数已正确 +1；
- dry-run 模式必须做到零上游副作用、零业务资产写入。
