# WAL 保留策略参数 Profile：local-X8 现行值 vs production-target 暂定值

2026-09-18，local-X8 每日自动 apply 工单的一部分。

## 0. 这份文档解决什么问题

`scripts/db/wal-retention.sh`（以及它的 X8 formal 入口
`scripts/db/wal-gc-x8.sh`）的每一个数值参数（`--keep-base`/`--max-bytes`/
`--max-backup-age-seconds`/`--archive-ext`）都保持**中性可配置**，核心脚本
本身不内置任何环境身份。X8 本地栈通过 `wal-gc-x8.sh` 里固定的
`:-` 默认值（以及本工单新加的 `X8_WAL_GC_MAX_BACKUP_AGE_SECONDS`）把这些参数
钉死成一组**local-X8 专属**的取值——这份文档就是把这组取值，和它们在真实
（尚不存在的）生产部署里"应该是什么量级"的暂定值，并排列出来，防止两者被
误当成同一件事。

**读这份文档的第一原则**：下表左列（local-X8 现行值）不是生产口径，不能被
任何"反正本地跑得好好的"的直觉带进生产部署——右列本身也只是暂定值，真正
的生产参数需要在真实生产 WAL/备份数据积累 7–14 天后重新计算（见第 3 节）。

## 1. 参数对照表

| 参数 | local-X8 现行值 | 来源 | production-target 暂定值 | 暂定值依据 |
| --- | --- | --- | --- | --- |
| `--keep-base`（保留的基准备份份数） | `2` | `wal-retention.sh` 自身中性默认，X8 从未覆盖 | 按 PITR 回溯窗口 ≥ 7 天、且按实际备份频率折算——例：若生产是**每日**备份，N=8（7 天回溯 + 1 份缓冲）；若是**每周**备份，则 N 需要更小心地按"周期 × 保留份数 ≥ 7 天"反推，不能直接套用 X8 的 N=2 | PITR RPO/RTO 承诺（见 `docs/p1/P1_06_PITR_RUNBOOK.md`：RPO ≤ 15 分钟、RTO ≤ 4 小时）要求回溯窗口本身要有意义地覆盖"发现问题"到"决定回滚"之间的真实延迟，不是"够用两天" |
| `--max-bytes`（归档容量阈值） | `21474836480`（20 GiB，`wal-gc-x8.sh` 硬编码默认） | X8 单机 Docker VM 磁盘预算（见第 4 节） | 60–80 GB（长期预算，非峰值上限） | 生产 WAL 产生速率显著高于 X8 本地开发/验收流量（真实用户写入 + worker 批处理），20 GiB 在生产节奏下会远比 X8 更快触达 `OVER`；60–80GB 是基于"数据库磁盘总预算的一部分，不是全部"的粗量级，仍需第 3 节的真实数据校准 |
| `--max-backup-age-seconds`（`--apply` 前置的基准备份新鲜度门槛） | `93600`（26 小时 = 日备 + 2 小时缓冲，本工单在 `wal-gc-x8.sh` 显式传入，见其头注释） | 与 `backup-timer.sh` 的 `X8_BACKUP_INTERVAL_SECONDS` 默认（86400s=日备）+ `check-wal-archive.sh` 的 `base_backup_stale` 阈值同款 26h 对齐 | 与生产实际备份频率绑定——例：**周备**则约为 `619200`s（7 天 + 2 小时缓冲）；若生产改为更高频（如每 12 小时），阈值应相应下调，不能沿用 26h | 这个阈值的唯一职责是"最新一份 VERIFIED 基准备份是否新鲜到可以信任"——它必须比备份周期本身略宽（容忍一次迟到），但绝不能宽到掩盖"备份链其实已经断了好几个周期"这种情况 |
| `--archive-ext`（归档文件压缩后缀） | 未设置（空，`wal-retention.sh` 中性默认） | 当前 X8 归档不压缩 | 视生产是否启用 WAL 压缩归档而定（例如 `.gz`/`.lz4`/`.zst`） | 与生产 `archive_command` 的实现方式绑定，不是本文档能预先拍板的 |
| `--apply` 的触发方式 | 本地 macOS LaunchAgent（`infra/local-x8/`，每日一次，`X8_LOCAL_WAL_GC_MAX_DELETE` 熔断默认 3000） | 本工单新增，见 `infra/local-x8/wal-gc-daily-apply.sh` | **默认关闭自动 apply**——生产部署另定触发方式与审批流程，不假设"和本地一样自动跑" | 生产环境的一次误删有真实用户数据风险，`docs/audits/WAL_RETENTION_X8_ROLLOUT_PLAN_2026-09-17.md` 第 5 节"首次真实删除 Owner Gate"的人工报告+批准流程是当前唯一被验证过的生产路径；本地自动化是该流程明确批准放松的例外（见第 11 节），不是新的生产默认 |
| 容器/项目身份标识 | `cps-novel-x8-local`（compose 项目名）、`Darwin`（LaunchAgent 唯一支持的宿主 OS） | X8 本地 127.0.0.1-only production-like 环境的既有约定 | 另设——真实生产环境的 compose 项目名、宿主 OS（大概率是 Linux VPS，见 Gate 5 文档"Linux 可移植前提"一节）、乃至"是否用 launchd 这种机制"本身都需要重新设计，不能假设生产是"更大号的 X8" | X8 是"production-like"（生产式）本地环境，不是生产部署的缩小版——两者的运维机制（LaunchAgent vs. 真实生产的调度系统）从设计出发点上就不同 |

## 2. 磁盘容量规划（X8 本地，仅供参照，非生产口径）

X8 本地 Docker VM 磁盘预算按 200GB 总量粗分：

- **50GB 必要占用**：应用镜像（`cps-novel:0.1.0-*` 系列，`x8_gc()` 已做保留策略）、`postgres_data`（当前 3.81GB 量级，见 `project_phase8_readiness_audit`）、系统本身。
- **60–80GB WAL 归档**：本表第 1 节的 `--max-bytes` 预算区间，与 `wal_archive` 具名卷共享同一块 Docker VM 虚拟盘（见 rollout 计划第 7 节"归档迁宿主绑定"，Gate 6，未在本轮范围）。
- **基准备份 + 校验临时空间**：`base-backups` 目录本身（当前 keep-base=2，每份约与 `postgres_data` 同量级）+ `verify-physical-base.sh` 解包校验用的 `.verify-<stamp>` 临时目录（校验完成后清理，但峰值期间两者同时占用）。
- **40–50GB 紧急余量**：不计入任何一项预算，专门应对"某一项估算偏差 + 同一时刻多个操作并发"的组合情况——这不是一个具体功能的预算，是留白。

## 3. 生产阈值上线后的重新校准流程（暂定，非本轮范围）

生产 WAL 保留参数**不得**直接照抄本文档第 1 节的暂定值上线——暂定值本身只是"量级不离谱"的起点。正式生产阈值必须在真实生产流量下运行 7–14 天后，用以下口径重新计算：

1. **daily WAL bytes 的 p50/p95**：按天聚合归档目录新增字节数，取中位数和 95 分位（不是峰值单日，也不是平均值——平均值会被极端促销/批处理日拉偏）。
2. **base backup 实际大小**：取最近若干份 VERIFIED 基准备份的真实字节数，而不是 X8 本地数据库（当前 3.81GB 量级）的外推。
3. **增长率**：数据库总量按周/月的增长趋势，决定 `--max-bytes` 预算需要多快追加，而不是一次性定死。

在这组真实数据出现之前，第 1 节右列的所有暂定值都只是"避免上线时凭空拍数字"的占位，不是可以直接部署的生产配置。

**生产前待办（Opus 复核 2026-09-18 补充，本轮不改）**：`infra/production-like/alerts/*`
（`check-wal-archive.sh`/`check-backup-freshness.sh`/`check-worker-locks.sh`）里的
`ALERT_COMPOSE_PROJECT` 默认值 `cps-novel-x8-local` 是 RC-7 就有的既有约定，本轮
（local-X8 日删自动化工单）未改动、也不在本轮范围内改动。但这个默认值本身只对
local-X8 profile 成立——生产部署的 compose 项目名大概率是另一个值，若这几个
脚本继续沿用"猜一个默认值"，生产环境一旦项目名对不上就会静默探测/告警到错误
的容器而不自知。生产部署前必须把这三处的 `ALERT_COMPOSE_PROJECT` 从
`:=cps-novel-x8-local`（有默认值）改为 `:?`（未设置即报错退出，强制调用方显式
传入），列为生产前待办事项，本轮不动。

## 4. 一句话总结

**local-X8 的任何参数取值都不是生产口径**——包括但不限于 `keep-base=2`、
`20 GiB`、`93600` 秒新鲜度窗口、macOS LaunchAgent 这种触发机制本身、以及
`cps-novel-x8-local` 这个项目名。核心脚本（`scripts/db/wal-retention.sh`、
`infra/production-like/**`、compose 文件）必须继续对这些值保持中性、
可配置——本文档只负责把"X8 现在用的是什么"和"生产大概需要什么量级"并排
写清楚，不代表任何一方已经为生产拍板。
