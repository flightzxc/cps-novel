# worker/

**Owner: Codex（独占写入）**

## 用途

Worker 进程入口与任务处理器实现：轮询/领取任务、执行业务逻辑（含需要解密凭证的任务）、写回结果与审计。是本项目唯一可解密渠道凭证的进程。

## P1-07 实现

- `index.ts` 是独立 Worker 进程入口；
- `runtime/` 提供 allowlist 驱动的轮询、三类 item 的领取/恢复、心跳和 graceful drain；
- 本轮生产 `HANDLERS` 为空，不包含渠道 Adapter 或正式业务 handler；
- handler 结果只通过 fenced finalize 提交，失去租约后结果被丢弃。

## 特别纪律

- ✅ **唯一可解密凭证的进程**；所有需要凭证的任务由 Worker 执行，Web 进程只入队；
- 原子领取必须用 `FOR UPDATE SKIP LOCKED` + 同事务 update/audit；
- 每次业务写入必须携带 `execution_token` + `lease_epoch` fencing 条件，旧租约持有者写入必须被拒绝；
- 进程崩溃重启后，item 需可恢复且 attempt 计数已正确 +1；
- dry-run 模式必须做到零上游副作用、零业务资产写入。
