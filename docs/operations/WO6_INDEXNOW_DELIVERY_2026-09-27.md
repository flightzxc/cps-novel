# 工单 6：IndexNow 扫描与轻量投递交付

状态：已在独立分支实现，**全量测试门禁尚未通过，不能视为完整验收通过**；待复核合入与生产开闸验收；未修改任何部署主机、未开闸、未合并、未建 PR、未发版。

- 分支：`feat/indexnow-sweep-wiring`。
- worktree：`/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep`，不在 `/tmp`。
- 基线：`origin/integration/v0.5.0-2026-09-27`，`17d07ccb588358f18fd32191cfc26ac2170fe30c`。实施前 `git fetch origin integration/v0.5.0-2026-09-27` 与 `git ls-remote origin refs/heads/integration/v0.5.0-2026-09-27` 一致。
- 实现及变异检查点：`d1e6769bf80fdf99e42f535bf8c831656fc74bef`；最终交付 HEAD 以交付回复及 `git rev-parse feat/indexnow-sweep-wiring` 为准。后续提交仅整理证据及交付文档。
- 应用 worktree 工具返回 `Not a git repository`（聊天根目录是多 worktree 的父目录），因此使用仓库原生 `git worktree add -b` 建立独立目录。
- node_modules 由同 lockfile 的集成线复制为独立文件副本，重新生成 Prisma Client；后续 p1-05b / p1-06 运行器还各自执行 `npm ci`。本地 PostgreSQL 16.14 应用完整迁移，包括 `20260926150000_periodic_sweep_skip_reason`。

## 实现与取舍

`indexnow.sweep.v1` 在真实 scheduler 注册为分钟 schedule，复用工单 5 的数据库时钟、advisory lock、同桶去重、当前分钟严格匹配、错过不补跑和在途合并。scheduler 只有执行即报错的 generic 占位，不导入实际扫描或推送。

任一 delivery 闸不严格为 `true`，`dueInstants` 返回空，关闭环境不增加本扫描的 ScheduleRun/CronRun/GenericTask/Item；扫描 primitive 关闭时也零写入。worker 扫描在 protectedWrite 事务中读 PostgreSQL 时钟并调用现有 sweep，结果持久化 `recovered / swept / skippedAlreadyLive`。

不实现“开启但没有 pending/retry 到期记录就不排扫描”：该扫描还承担陈旧 processing 回收，仅靠建议的 status/available_at/next_attempt_at 三列预查会漏恢复。完整预查会增加时间字段、查询与权限范围。本单不扩 scheduler 权限，接受开闸后每分钟一次可能为空的扫描；关闭环境不会产生每日 1,440 个空任务。

批准轻量集合新增扫描与 `indexnow_delivery`；启动和共享 preflight 通道策略拒绝 main 含任一种类型，即使白名单不重叠也拒绝。预生产、基础及仿生产模板仅加扫描；生产投递仍需独立批准，与 delivery 双闸在 V020 步骤 8–9 同次进入 light 白名单。预生产四闸和 preflight IndexNow 硬关保持原样。

新增内部 `WorkerRuntimeOptions.lane?: "main" | "light"`，默认 main。真实入口传入经解析的 lane；light 对投递组与其它有效轻量类型组轮转，先尝试其它组，完成一项（含恢复工作）后优先另一组；组空则立即尝试另组，两组空才等待原有 1,000 ms 轮询。组内复用原有 claim、heartbeat、fencing、recovery 和 drain；main 保持原有排序。不新增 HTTP 接口、环境变量或数据库结构。

## 条目、URL 与占用

实际代码 `worker/handlers/indexnow-delivery.ts` 使用 `urlList: [row.url]`、attempt `batchSize: 1`：一个条目一次 HTTP 只提交一个 URL，超时 10 秒。首次发布及人工释放直接建首投条目；降低扫描上限不能限制这些积压，所以同时引入已获 Owner 确认的公平轮转。

| 同批条目数 | 每次 HTTP 满 10 秒的串行服务时间 |
| ---: | ---: |
| 200 | 33 分 20 秒 |
| 2,000 | 5 小时 33 分 20 秒 |
| 10,000 | 27 小时 46 分 40 秒 |

上述不含数据库时间、其它轻量工作及后续重试。定时 handler 选定 200 候选上限，保留 primitive 历史默认 2,000 / ceiling 10,000 的其它调用兼容性；已有 live 条目也占候选名额，所以一轮实际新建可能少于 200。陈旧 processing 回收沿用原有查询，不受候选 200 限制。

公平轮转解决队列饿死，不提高 HTTP 吞吐、不抢占正在执行的请求；其它组仍可能等待当前请求约 10 秒及数据库耗时。持续输入超过消费能力时仍会积压，生产开闸必须观察。未改变批量协议、重试退避、人工释放或发布业务语义。

## 本地链路与实测

真实 `web_app` 经 `applyPublishTransition` 发布；真实 `scheduler_app` 经已注册 schedule 和 `runSchedulerOnce` 入队；真实 `worker_app` 执行正式 `runWorker` 循环及 IndexNow/sitemap handler。仅 Next revalidation 被测试桩替代；IndexNow fetch 保留 body/signal 转送本地 HTTP。主通道压力使用同一真实 worker 循环与 20,000 条真实 pending 条目，领取业务 handler 以本地 200 ms HTTP 替代，绝不调用 MoboReader。

首次发布原本就直接建条，因此单独验证扫描跳过已有 live 条目。完整“扫描建条→投递”链路由 429/500/503 后真实 retry_wait 驱动：核实 5 分钟加抖动的实际 next_attempt_at，未到期扫描不建条，再仅调整测试数据库 fixture 时间，重新由 scheduler 和 light 扫描创建不同 taskId 并成功发送。测试专用 schedule key 用于同一真实分钟内的独立状态场景；正式 key 同桶并发去重、过期桶及在途合并另有真实角色测试。

最终本单运行器：20 passed / 0 skipped，drift 0；包含成功、429/500/503、403/422 终态、陈旧 processing、真实 10 秒超时、关闭零写、200 候选上限、fencing 和通道隔离。

| 场景 | 实测 |
| --- | --- |
| 主队列 20,000 条领取积压 | 投递入队→领取 931 ms，入队→HTTP 到达 970 ms；poll 1,000 ms；仍 pending 19,996 条，主模拟 HTTP 已调用 4 次 |
| light 内 301 条投递积压 | 完成顺序前 3 个为 sitemap、投递、扫描；扫描完成时观测到 1 次投递请求，未等待积压排空 |
| 当前投递 HTTP 满 10 秒超时 | 新入队 sitemap 等待 10,296 ms，随后成功；投递进入 retry_wait，并由后续扫描重新投递成功 |
| 首次 429 / 500 / 503 | 真实退避分别 352,939 / 309,178 / 312,854 ms，均落在既有 300,000–360,000 ms 区间 |

压力断言允许一个轮询周期加少量本地调度/数据库开销（领取 ≤1,200 ms，HTTP ≤1,250 ms），实测均低于 1,000 ms。以上是本地证据，不是生产 SLA。

真实角色确认 scheduler 无 outbox、IndexNow key、凭据密文 SELECT，worker 可完成现有读写。无需新增 grants、schema 或字典条目；字典检查 53 models / 1,236 records，drift 0。

## 门禁状态与剩余阻塞

- `npm run typecheck`：0；本单定向单元/契约 42 passed；真实库 20 passed / 0 skipped，drift 0；五项变异均按预期变红并逐字恢复。
- `npm run build`：0；三套 `docker compose config`：0。
- 全部 19 个 `scripts/run-*-postgres-verification.sh` 已执行。以各套件最后一次结果计：15 通过，4 个用户已登记的旧失败保留。
- p1-05b / p1-06：相同的三处既有 lint 错误（领取弹窗 effect 内 setState、领取放行变量 prefer-const、标签测试 no-this-alias），三文件与基线逐字一致，未改领取逻辑。
- x6：临时 PostgreSQL socket 不存在，退出 2；x9：期待 side_effect_intent 权限拒绝，但实际先得到 `Illegal side-effect transition: manual_review_required -> confirmed`，退出 1。保留精确错误，不以“已通过”处理。
- 发布/试读旧 500 条压力用例首次达到 180 秒超时，未改测试、未放宽超时；随后原运行器复跑通过全部 12 项，drift 0。
- **全量 `npm test -- --maxWorkers=4` 未取得 0 failed。** 既有 `articles-admin` 的 201 行上限场景在全量及两次独立复跑中均超过 5 秒；后续全量还有 AST 扫描及多项 shell/Docker 用例超时。完整次数、失败名称及尾行见验证证据。未将这些额外失败归入 B-15/B-16。
- 实现检查点后的首轮全量：1 failed / 6,868 passed / 392 skipped，无 Unhandled Error；最后确认轮：8 个文件失败，12 failed / 6,855 passed / 394 skipped，另有 5 个 `Timeout calling "onTaskUpdate"` Unhandled Error，耗时 845.16 秒。两轮均退出 1，最后一轮也不满足“无 Unhandled Error”。
- 只读观测到本机 load average 从约 46/51/46 上升到约 74/59/49（详见 environment.json）。高负载与广泛超时同时出现，但这不等于已经证明所有超时的根因，也不能替代全量 PASS。
- 已提出是否允许优化两处 `tests/ui/` 测试的范围问题；CLAUDE.md §3.1 将该目录归 Claude，工单未点名这两个文件，因此未擅自修改。后续更广泛超时表明只优化 UI 也不能替代整体复验；本单保留原断言、原超时、原扫描范围。

剩余要求：在资源稳定的本地环境或隔离 CI 中，以原命令取得全量 0 failed 且无 Unhandled Error 后，再由复核方判断是否允许合入。当前分支交付代码与证据，不声称已经满足该硬门禁。没有变更任何部署环境或其它进程来规避失败。

## 证据与运维交接

- [全部验证命令、退出码、尾行及完整门禁结果](evidence/wo6-2026-09-27/verification.md)。
- [未通过门禁的原始错误摘录](evidence/wo6-2026-09-27/failure-excerpts.md)，完整本地日志的 SHA-256 清单见同目录 `local-log-manifest.json`。
- [五项变异与逐字恢复证明](evidence/wo6-2026-09-27/mutations.md)：关闭仍入队 7 红、移除轻量投递批准 10 红、漏占位 1 红、去合并 2 红、取消公平轮转 1 红；每次恢复 `git diff --quiet` 为 0。
- [改动文件清单](evidence/wo6-2026-09-27/changed-files.txt)。
- [生产步骤 3→9 开闸草稿及回关动作](WO6_INDEXNOW_PRODUCTION_OPENING_DRAFT.md)，全部待 Owner 审批，未执行。
- [容量与公平轮转 ADR](../adr/ADR-WO6-INDEXNOW-LIGHT-FAIRNESS.md)。

CPS 仅通过指定 commit `3a76877` 的 `git show` 读取参考，未复制协议实现；其现有工作区改动未处理。旧冻结参考 HEAD 保持 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`、status 0 行。新参考工作区按 HEAD/status 哈希核对，详见证据。
