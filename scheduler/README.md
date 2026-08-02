# scheduler/

**Owner: Codex（独占写入）**

## 用途

独立 Scheduler 进程：按时间/周期到点建任务（入队），不执行任何业务逻辑。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-07（Worker、Scheduler、任务租约和 fencing）** 填充。

## 特别纪律

🔴 **只入队，不执行业务；无凭证密钥。**

- Scheduler 容器不得注入任何凭证解密密钥类环境变量；
- 调度去重依靠 `(schedule_key, scheduled_bucket)` 唯一键，多实例并发调度只能产生一次有效调度记录；
- Scheduler 与 Worker 是两个独立进程/容器，不得合并部署以图省事。
