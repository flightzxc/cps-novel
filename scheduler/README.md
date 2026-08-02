# scheduler/

**Owner: Codex（独占写入）**

## 用途

独立 Scheduler 进程：按时间/周期到点建任务（入队），不执行任何业务逻辑。

## P1-07 实现

- `index.ts` 是独立、一次性 Scheduler 进程入口；
- schedule registry 可注入，本轮生产 registry 为空；
- `ScheduleRun`、`CronRun`、`GenericTask` 和 items 在同一事务内 enqueue；
- Scheduler 不导入渠道 Adapter、Credential 或任何网络投递代码。

## 特别纪律

🔴 **只入队，不执行业务；无凭证密钥。**

- Scheduler 容器不得注入任何凭证解密密钥类环境变量；
- 调度去重依靠 `(schedule_key, scheduled_bucket)` 唯一键，多实例并发调度只能产生一次有效调度记录；
- Scheduler 与 Worker 是两个独立进程/容器，不得合并部署以图省事。
