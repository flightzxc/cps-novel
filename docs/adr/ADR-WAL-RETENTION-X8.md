# ADR-WAL-RETENTION-X8 · X8 本地 WAL 保留治理

```text
ADR_ID                         = WAL-RETENTION-X8
DECISION_STATUS                = ACCEPTED
DECISION_DATE                  = 2026-09-16..2026-09-19
BASELINE                       = integration/2026-09-16-night 7b8d176
SCOPE                          = local X8 only; production profile deferred
FIRST_APPLY_EXECUTED           = 2026-09-18T05:45Z deleted=2513 anchor=0000000100000043000000D8
ARCHIVE_BEFORE_AFTER           = 42.5GB -> 386MB
PRODUCTION_AUTO_APPLY          = NO
TIMER_APPLY                    = NEVER
WAL_ARCHIVE_MOUNT_IN_TIMER     = ro
REVIEW                         = Opus x4 rounds + GPT external review + third-party arbitration
```

本 ADR 记录 X8（`cps-novel-x8-local-*`）本地 production-like 环境 WAL 归档与基准备份保留
策略的最终工程决定：从"38 GiB 无锚点归档、零保留能力"到"锚定式清理 + 首次真实删除 +
本地日常自动化"的完整落地过程。范围严格限定在 X8 本地栈；生产 VPS 的保留参数不在本
ADR 拍板范围内，见第 8 节。

## 1. 背景

X8 本地栈此前发生过一次连续 29 小时无锚点、无保留的 WAL 归档积压，导致 Docker VM
磁盘被撑到 181GB 濒临写满。真因是 worker 领取查询在冻结任务上锁住导致的持续写负载
（修复 commit `2705b4d`，已上线，本 ADR 不重新验证 worker 代码本身）。这次事故暴露
出两个此前完全不存在的能力缺口：

1. **`archive_cleanup_command`（PostgreSQL 内置的归档清理钩子）在单主库、无 standby
   的拓扑下永不触发**——它是为 streaming replication 场景设计的，X8 没有 standby，
   这条路径天生是死的，不能指望它做任何清理。
2. **旧版 `scripts/db/archive-wal.sh` 的文件名白名单只认 24 位十六进制 WAL 段名，
   拒收 `pg_basebackup` 产生的 `<24hex>.<8hex>.backup` 与时间线 `<8hex>.history`
   两类文件**——这是本轮最先修复也是最核心的缺陷（"断点二"）：归档器一旦在第一个
   `.backup` 文件上卡死，此后所有 WAL 归档全部停摆，且不会自愈（轮 A 演练实证：
   `failed_count` 从 0 涨到 30 都没停）。

在这两个缺口被堵上之前，"清理"这件事无从谈起——不是清理逻辑有 bug，而是压根没有
清理逻辑，也没有任何一份基准备份可以充当清理的锚点（取证时 38 GiB / 2408 段归档，
`base-backups` 挂载点当时甚至不存在）。第 2 节起的每一条决定都是在这个前提之上
逐步补齐的。

## 2. D1 · 锚定删除，禁止按日期删

**决定**：保留策略 = 最近 N 份已校验（`VERIFIED`）物理基准备份 + 其后全部 WAL；
锚点从每份基准备份自身的 `backup_label`（经 `verify-physical-base.sh` 校验、写入
`VERIFIED` 标记的 `start_wal` 字段）读取，不使用 `pg_walfile_name()` 之类的运行时
函数现场计算；实际删除动作交给 PostgreSQL 官方工具 `pg_archivecleanup`，不自行
实现文件枚举/删除逻辑。

**为什么**：`pg_archivecleanup` 是 PostgreSQL 自带的、语义明确的 WAL 段清理器——
给定一个 `OLDESTKEPTWALFILE`（即锚点），它保留该文件及更新的所有段，删除更旧的。
把"哪个文件是锚点"这个判断权交给"已经校验过、证明可用于 PITR 的基准备份"，而不是
交给时间，是因为**恢复链的完整性只能由"某份 VERIFIED 备份 + 其后连续 WAL"这个结构
来保证，与日历无关**。

**拒绝了什么替代方案**：

- **日历规则**（例如"删除 7 天前的文件"）：方案原则一明确禁止，理由是日历规则不
  知道恢复链断在哪里——WAL 段的可删除性取决于是否已经被某份仍然有效的基准备份
  锚定住，而不是它的时间戳。
- **依赖 `archive_cleanup_command`**：第 1 节已说明，无 standby 拓扑下这条路径
  永不触发，等于没有清理。
- **对旧版 `archive-wal.sh` 打补丁以外的绕过方案**（例如让归档器跳过 `.backup`
  文件）：会导致基准备份自身的 WAL 附件永远进不了归档目录，破坏而不是修复恢复链。

**后果**：清理器在"没有任何 `VERIFIED` 基准备份"之前天生什么都做不了——这不是
缺陷，是设计（`NOOP reason=insufficient_verified_backups`，Gate 3 的 PASS 条件之
一）。首份基准备份（commit `077da0a` 修复白名单）之前，38 GiB 历史归档对清理器来说
不可见、不可清理，只能等锚点产生后自然纳入。

## 3. D2 · fail-closed 守卫清单

**决定**：`scripts/db/wal-retention.sh` 在真正执行 `pg_archivecleanup -d` 之前，
必须依次通过以下拒绝分支中的每一条，任一条不满足即 `REFUSED`/`WARN` 并退出非零，
不触碰任何文件：`anchor_not_in_archive`、`would_empty_archive`、
`archiver_failing`/`archiver_unreadable`、`plan_failed`、`unexpected_directory`、
`verified_malformed`、`timeline_unsupported`、`stale_base_backup`、
`delete_surge_guard`、`reconcile_mismatch`。`--force` 参数**只**解除
`delete_surge_guard`（本次删除量 > 上次 × 10 的熔断）一项，不绕过其余任何一条。

**为什么每一条都存在**（均来自真实踩到或人为构造出的失败模式，不是预防性堆砌）：

- **`anchor_not_in_archive`**：这是本轮实证过的最严重的 P0——轮 A 演练（旧脚本、
  归档器卡死）里，清理器拿一个从未真正归档过的锚点，把归档目录里已有的 `01–06`
  六个真实段全部删空，还打印绿色 `APPLIED`（证据 `evidence-roundA-final/step4-apply.log`）。
  锚点必须先证明"真实存在于归档目录"才允许被信任。
- **`would_empty_archive`**：计划执行后归档清零即拒。Opus 二轮复核论证过这是
  **防御性兜底、不是独立可达路径**——只要 `anchor_not_in_archive` 先把关（锚点必须
  真实在档），锚点本身就是 `pg_archivecleanup` 的 `OLDESTKEPTWALFILE`，按其契约
  永远不会出现在自己的删除计划里，两个条件不可能同时成立。保留是为了防守"万一
  上面那条假设被打破"的场景。
- **`archiver_failing`/`archiver_unreadable`**：`--require-archiver-healthy` 在
  三轮修复中经历过一次方向性纠正——v2 用 `failed_count` 累计基线/state 比较，
  但一旦某次瞬时失败把 `failed_count` 推高，只要之后哪怕再涨 1，就会永久拒绝、
  无法在不重启 Postgres 的情况下自愈；v3 改为对 `pg_stat_archiver` 的**时点谓词**
  （`last_failed_time > last_archived_time` 由 Postgres 自己比较返回 t/f），修复
  了这个"一次失败、永久锁死"的缺陷。
- **`plan_failed`**：`pg_archivecleanup -n`（dry-run 规划）本身非零退出即拒——避免
  在规划都不可信的情况下继续往下走。
- **`unexpected_directory`**：`base-backup-dir` 下出现不认识命名格式的目录时拒绝
  枚举，防止把无关目录误当作候选备份处理。
- **`verified_malformed`**（P1-D，另一条真实数据丢失通路）：`VERIFIED` 文件缺
  `start_wal`/`start_timeline`/`verified_epoch` 任一字段时，旧的排序规则会把
  空字符串当成"最老的备份"排在最前，在 apply 时被静默标记 `RETIRED` 并 `rm -rf`
  ——即便它可能是唯一一份没坏的备份。三项格式必须全部匹配对应正则才进入有效集合。
- **`timeline_unsupported`**：`backup_manifest` 的 `WAL-Ranges` 数量不等于 1，或
  锚点自身 `timeline != "1"`，两种形状之一即拒——本方案不处理多时间线场景。
- **`stale_base_backup`**：`verified_epoch` 距今超过新鲜度窗口（26 小时，见第 5
  节）即拒，防止拿一份"验证过但已经太旧、后面链路可能已经断了"的备份当锚点。
- **`delete_surge_guard`**：单次删除量突增（> 上次 × 10）是熔断而非拒绝——
  `--force` 存在的唯一意义就是绕过这一条，且历史归档体积越大越容易触发它，触发
  本身是信号，不是需要绕过的障碍。
- **`reconcile_mismatch`**：`pg_archivecleanup -d` 声称删除的路径事后逐一 `[[ -e ]]`
  复查，若仍残留则拒绝继续（不删 `RETIRED` 目录、不持久化 state），并打印
  `WAL_RETENTION_HINT=retired_markers_kept` 提示人工确认——刻意不做成自愈。

**拒绝了什么替代方案**：让 `--force` 绕过全部守卫（"删得太多所以加个参数让它别
管"）——代码与单测都锁定 `--force` 只影响 `delete_surge_guard`，其余任何一条拒绝
分支都不受它影响，这在方案第 6 节被明确写成红线。

**后果**：正常路径下清理器"话很多但从不沉默失败"——任何一次拒绝都有明确的
`reason=` 字面量输出到 stdout，可被上游脚本（`infra/local-x8/wal-gc-daily-apply.sh`）
精确 grep。代价是实现复杂度显著高于一个"能跑就行"的清理脚本，但这正是本轮从
"一次真实数据丢失事故的思路"里吸取的教训。

## 4. D3 · 校验定义

**决定**：`scripts/db/verify-physical-base.sh` 解包 `base.tar.gz` + `pg_wal.tar.gz`
到临时工作目录后调用 `pg_verifybackup`，**从不带 `--no-parse-wal`**；`VERIFIED`
标记是加入"有效基准备份集合"的唯一凭证——没有 `VERIFIED`（或带 `RETIRED`）的目录
不参与保留判断，只在 stdout 打一行 `unverified_backup_dir` 警告。apply 时的写入
顺序固定为：先给退休目录打 `RETIRED` 标记 → 再执行 `pg_archivecleanup -d` → 最后
才 `rm -rf` 被标记的目录本身（`scripts/db/wal-retention.sh` 的三段式提交顺序）。

**为什么**：

- `pg_verifybackup`（PG16/17）**只接受目录格式的备份**，这是它本身的版本行为——
  对 tar 归档直接校验是 PG18 才有的能力，X8 当前跑的是 PostgreSQL 16.14，因此
  必须先解包再校验，这不是本方案的选择，是上游工具的版本约束。
- **不带 `--no-parse-wal`**：这是让这次校验真正覆盖"WAL 连续性"而不只是"文件
  校验和"的关键——带上这个参数会跳过 WAL 层面的一致性检查，退化成单纯的文件级
  校验。
- 校验脚本额外做了一层 `pg_verifybackup` 本身不做的交叉核对：`backup_label` 的
  `START TIMELINE`/`START WAL LOCATION` 必须与 `backup_manifest` 的
  `WAL-Ranges[0].Timeline`/`Start-LSN`（按标准 16MB 分段公式换算出的段名）逐字
  一致——这条核对已用真实 B2 备份的 `Start-LSN=0/B000028` 分别用 Python 与 bash
  `$((16#...))` 独立验证过，两者与 `backup_label` 完全一致。
- 写入顺序 `RETIRED → pg_archivecleanup -d → rm -rf` 保证"进程被杀在中途"时，
  有效集合的判断只认 `RETIRED` 标记、不认目录是否物理存在，设计上是安全的（P1-3
  的单测验证了正常完整跑完时的时序；真实 kill -9 中途测试仍是已知缺口，见第 10
  节）。

**拒绝了什么替代方案**：对 tar 归档直接跑 `pg_verifybackup --no-parse-wal`——虽然
更省一次解包，但会跳过 WAL 一致性检查，且 PG16/17 的 `pg_verifybackup` 本身也不
支持对 tar 直接操作，这条路径在技术上不可行。

**后果**：每次校验都要花时间解包一整份基准备份（与 `postgres_data` 同量级），是
第 8 节磁盘容量规划里"基准备份 + 校验临时空间"这一档预算存在的直接原因；解包目录
在 `base-backup-now` 场景下改用点号前缀的 `.verify-<stamp>`（`wal-retention.sh`
的目录枚举 `find ... ! -name '.*'` 会原样跳过），避免被误当成候选备份，也不落在
容器 overlay 层（Docker VM 盘）。

## 5. D4 · timer 永远 dry-run，归档卷在 timer 侧只读挂载

**决定**：`infra/production-like/backup-timer.sh` 的四步日常循环（逻辑备份 → 物理
基准备份 → 校验 → `wal-gc-x8.sh --json`）中，第 4 步**永远不带 `--apply`**——
不存在任何开关能让这个循环本身触发真实删除。配套地，`backup-timer` 容器对归档卷
的 compose 挂载固定为 `wal_archive:/var/lib/postgresql/wal-archive:ro`（只读）。

**为什么不给 timer 加 auto-apply 开关**：这是一条生产不变量，由 Owner 在
2026-09-18 明确拍板——`--apply` 是且只能是一个独立的、有报告、有批准的人工动作
（第 6 节），不允许被悄悄绑进一个每天自动触发的循环里，即使本地环境后来放松成了
"每日自动 `--apply`"（第 7 节），那也是一个**独立的、从不共享 timer 触发时机的
LaunchAgent**，不是把 timer 本身改成会删数据。

为了让"归档卷对 timer 只读"这个约束能成立，`wal-retention.sh` 本身做过一次配套
修复（commit `5b8916d`）：`archive_not_writable` 检查原来是无条件的（任何调用都
要求归档目录可写），这与"给 timer 的归档挂载改成只读"直接矛盾——修复后这条检查
**只在 `--apply` 时才生效**，因为 dry-run（`pg_archivecleanup -n`、容量扫描）
本来就只读归档目录，从不需要写权限。

**拒绝了什么替代方案**：给 timer 增加一个"最近 N 天不用批准直接 apply"之类的
半自动开关——Owner 明确否决，理由与第 6 节"首次真实删除"红线相同：生产环境
（以及本地环境在获得明确豁免之前）的一次误删有真实数据风险，人工报告+批准流程
是唯一被验证过的路径。

**后果**：`archive_not_writable` 现在是"入口级控制"而非"容器级控制"（Opus
三轮复核 P2-6 的措辞）——compose 必然把裸 `wal-retention.sh` 也挂进 postgres
容器供 `wal-gc-x8.sh` 内部调用，任何能 `docker exec` 进容器的人理论上仍可以绕过
`wal-gc-x8.sh` 强加的 `--require-archiver-healthy` 直接手敲脚本。这是运维纪律
问题，不是可以用代码堵死的口子：对活栈的一切 WAL 保留/基准备份操作**只允许**经
`scripts/x8-production-like.sh wal-gc` / `base-backup-now` 两个入口，禁止在容器
内手敲 `wal-retention.sh`。

## 6. D5 · 首次真实删除 = Owner 书面批准

**决定**：在拿到 B1、B2 两份 `VERIFIED` 基准备份、且 Gate 4（正向 + 负向恢复链
验收）PASS 之前，任何 `wal-gc --apply` 都不得执行——即使 dry-run 已经打印出一个
看起来合理的删除计划。首次执行需要一份固定格式的执行前报告（运行时间、操作者、
保留的 B1/B2 详情、归档器健康、dry-run 计划原样、Docker VM 容量）提交给 Owner，
获得明确书面批准（不接受"看起来没问题就先删了"）后才能加 `--apply`。

**为什么**：这是整套锚定式保留唯一"第一次没有历史可比对"的时刻——`delete_surge_guard`
这类基于历史的熔断在第一次删除时没有基线可用，唯一的把关手段就是人工审阅。

**执行结果**：首次真实 `wal-gc --apply` 已于 **2026-09-18T05:45Z** 完成，删除
2513 个 WAL 段，锚点 `0000000100000043000000D8`，归档目录从约 42.5GB 降至约
386MB。preflight/apply/post 三段式证据（`planned_delete=2513` → `WAL_RETENTION=APPLIED
deleted=2513` → `planned_delete=0` `CAPACITY=OK bytes=385876656`）与一次删后正向
恢复验证（`replay_lsn=43/DB000090`、`selected new timeline ID: 2`）均已留存于
`integration-night/.tmp/x8-production-like/gate5-evidence/`（不进 git）。Fable 只读
终审（2026-09-18T06:58Z）额外核对了归档目录剩余 23 个 WAL 段（区间 `D8..EE`，
连续无缺口）、`.wal-retention.state` 的 `last_deleted_count=2513`、宿主 VM 磁盘
占用从 106G 降到 66G，以及参与操作的六个容器 `container id` 前后未变（本次操作
未触发任何容器重建）。

**拒绝了什么替代方案**：为了在只有一份 `VERIFIED` 备份时就提前处理 38 GiB 历史
归档而传 `--keep-base 1`——方案 v2 §6 确实留了一个"冷启动 N=1 初始化阶段"的例外，
但那必须是一次独立于常规流程、Owner 单独书面授权的一次性动作，且报告里必须显式
写明"回溯窗口约为零，不是常态"；默认路径是让 N=2 按每日节奏自然积累，等 B2 产生、
Gate 4 验完恢复链之后再自然纳入第一次真实清理。实际执行走的正是这条默认路径。

**后果**：第一次删除已经把"报告模板 + 书面批准"这套流程验证为可执行、且没有产生
任何 `reconcile_mismatch` 或非预期残留。这为第 7 节把"每次都人工批准"放松为"本地
每日自动化"提供了前提——但放松的前提是这套判定逻辑本身在真实数据上已经被证明
可信，不是绕开它。

## 7. D6 · 本地放松（2026-09-18，Owner 批准）

首次真实删除按人工流程走完一轮之后，Owner 批准了一组**仅限 local-X8**的自动化
放松。每一项都是"把人工逐次批准 `--apply` 放松为日常自动化"，不是放松任何一条
安全闸门本身：

| 放松项 | 放松前 | 放松后（仅 local-X8） |
| --- | --- | --- |
| `--apply` 触发方式 | 操作者手工走报告模板 + 人工批准 + 手工执行 | macOS LaunchAgent（`infra/local-x8/wal-gc-daily-apply.sh`）每日自动跑同一个正式入口 `scripts/x8-production-like.sh wal-gc --apply --json`，preflight/apply/post 三段式校验 + `X8_LOCAL_WAL_GC_MAX_DELETE`（默认 3000）熔断 |
| 恢复链验证节奏 | 只在 Gate 4 时完整跑过一轮 | **相关代码变更后必跑** `wal-retention-rehearsal.sh` + **每月**一次 `pitr-smoke-local.sh`（零活库写的正向 PITR 抽查） |
| 告警投递 | 未接线 | **log-only 豁免**：判据继续本地跑、继续判定 fire/recover，但不要求接入真实推送通道（`OWNER_WAIVER_ALERT_DELIVERY=yes`）——豁免的是"投递"，不是"判据本身" |
| 26 小时新鲜度阈值 | — | **不改**：仍钉死在 93600 秒，且明确不与 `X8_BASE_BACKUP_MIN_INTERVAL_SECONDS`（72000 秒，20 小时，"去抖"参数）混为一谈——两者回答的是不同问题（"要不要现在打新备份" vs "现有备份是否还新到可信"），且大小关系本身就是安全边界的一部分：去抖必须严格小于新鲜度窗口 |
| 归档迁宿主绑定（原 Gate 6） | 计划中，未排期 | 本地继续延后，不因日删自动化而提前 |

**为什么**：首次删除的真实执行已经证明这套判定逻辑可信，重复的人工审批对本地开发
环境的边际价值递减，而每日堆积不清理又会让本地磁盘重演最初的撑爆问题。

**不放松的部分**（对本节所有条目都成立，没有例外）：

- 锚定式删除的判定逻辑本身不变——第 3 节的每一个 fail-closed 分支，自动化前后
  行为完全一致，本节任何一项放松都不触碰 `wal-retention.sh` 的判定代码。
- `--force` 的作用范围不变，且本地自动化的每日命令行**从不**拼接 `--force`
  （`infra/local-x8/wal-gc-daily-apply.sh` 自身有静态测试锁死这一点，连
  `--force`/`--keep` 两个 token 都不允许出现在头部注释之外的正文里）。
- fail-closed 原则不变——preflight/apply/post 任一段出现 `REFUSED`/`LOCKED`/
  `reconcile_mismatch`/非零退出，当天自动化直接 `LOCAL_WAL_GC=STOPPED`，不重试、
  不静默跳过、不自动放宽熔断上限重跑。
- `wal_archive:ro`（第 5 节）不变，本工单未改动、也不允许改动。
- `backup-timer.sh` 四步循环永远不 apply 不变——本地日删自动化是一个独立的
  LaunchAgent，从不挂在 `backup-timer` 容器的循环里，也不共享它的触发时机。

**拒绝了什么替代方案**：把日删自动化直接接进 `backup-timer.sh` 第 4 步（复用
容器已有的循环，少建一个 LaunchAgent）——拒绝理由与第 5 节相同：会让"timer 永远
dry-run"这条生产不变量在本地环境出现一个隐蔽的、容易被后续修改不小心带进生产
profile 的分支。保持两条完全独立的机制，即使多一点重复的调度代码，也比在
共享循环里加一个 apply 分支更安全。

**明确声明**：这些是 **local profile**，不是生产口径——第 8 节逐条列出生产不能
沿用哪些数字与机制。

## 8. D7 · 生产适配约束

`scripts/db/wal-retention.sh`/`wal-gc-x8.sh` 的每一个数值参数
（`--keep-base`/`--max-bytes`/`--max-backup-age-seconds`/`--archive-ext`）在核心
脚本层面保持**中性可配置**，不内置任何环境身份；`wal-gc-x8.sh` 只是把这些参数钉
成了一组 X8 专属取值。生产部署前必须遵守：

- **禁止**把 `--keep-base=2`、`--max-bytes=20 GiB`、`93600` 秒新鲜度窗口、
  Darwin/launchd 这套触发机制、或 `cps-novel-x8-local` 这个 compose 项目名固化
  进共享核心代码——这些都是 X8 本地 profile 自己的取值，不是生产默认值。
- **`--keep-base`**：生产需按 PITR 回溯窗口 ≥ 7 天、且按实际备份频率折算（例如
  每日备份对应 N=8；每周备份则需按"周期 × N ≥ 7 天"反推，不能直接套用 X8 的
  N=2）。
- **`--max-bytes`**：暂定 60–80 GB（长期预算量级，非峰值上限），因为生产 WAL
  产生速率显著高于 X8 本地开发/验收流量，20 GiB 在生产节奏下会远比本地更快触达
  `OVER`。
- **`--max-backup-age-seconds`**：必须与生产实际备份频率绑定——例如周备对应约
  619200 秒（7 天 + 2 小时缓冲），不能沿用 26 小时。
- **磁盘容量**：X8 本地 200GB 预算粗分为 50GB 必要占用 + 60–80GB WAL 归档 +
  基准备份/校验临时空间 + 40–50GB 紧急余量——这套配比本身也只是本地参照，不是
  生产采购依据。
- **生产不默认 auto-apply**：`docs/audits/WAL_RETENTION_X8_ROLLOUT_PLAN_2026-09-17.md`
  第 6 节"首次真实删除 Owner Gate"的人工报告+批准流程是当前唯一被验证过的生产
  路径；本地自动化是该流程明确批准放松的例外，不是新的生产默认。
- **`ALERT_COMPOSE_PROJECT` 默认值**：`infra/production-like/alerts/*` 里这个变量
  当前默认 `cps-novel-x8-local`，只对 local-X8 profile 成立；生产部署前必须把
  它从"有默认值"（`:=`）改为"未设置即报错"（`:?`），否则生产环境项目名一旦对不上
  会静默探测/告警到错误的容器而不自知。
- **正式生产阈值必须在真实生产数据上重算**：daily WAL bytes 的 p50/p95（不是
  峰值单日也不是均值）、真实基准备份字节数（而非 X8 本地 3.81GB 量级数据库的
  外推）、数据库增长率三项，都要在生产流量下运行 7–14 天后才能定案；本节所有
  数字都只是"避免上线时凭空拍数字"的占位。

## 9. D8 · 运维事实与教训

以下是本轮施工中实证过的、与部署机制相关的事实，供后续同类工作参考：

- **单文件 bind mount 不跟随 host 端 rename**：容器启动后，host 端一次 rename 式
  编辑（如 `sed -i ''`）会让运行中容器对该文件的 `open()` 直接 `ENOENT`，
  `stat`/`ls` 却仍报告旧的（已被 unlink 的）元数据；容器不重启，这个不一致不会
  自愈。任何改动了被 bind mount 进容器的脚本文件之后，必须 recreate 该容器并
  重新核对哈希，不能只看挂载是否存在。pgpass reconcile（`mktemp`+`mv -f` 原子
  替换）同样会换新 inode，命中同一个坑，因此该工单第 5 节明确要求"必须
  `up -d --no-deps backup-timer`，`restart` 不够"。
- **`pg_hba.conf` 在数据卷内只需要 `pg_reload_conf()`**：`hba_file` 显示为
  `/var/lib/postgresql/data/pg_hba.conf`，不是 bind mount，按 PostgreSQL 官方
  协议行为，改动只需要 `SELECT pg_reload_conf()`（或 SIGHUP）即可生效，不需要
  重启进程更不需要容器 recreate——这是协议本身的行为，与部署方式无关。只有当
  需要让改动在**未来每一次容器重启后依然存在**（即写进 `postgres-entrypoint.sh`
  这类受版本控制、每次启动都跑的脚本）时，才需要那次持久化专属的 recreate，
  两件事不能混为一谈。
- **`backup_role` 的 pgpass 必须同时有 `cps_novel` 与 `replication` 两条精确
  规则**：libpq 对物理复制连接（`pg_basebackup --replication`）匹配 pgpass 时，
  "database" 字段不是调用者传入的任何数据库名，而是**字面字符串
  `replication`**——只写一行 `postgres:5432:cps_novel:backup_role:<pw>` 只能
  匹配 `pg_dump` 这类逻辑连接，`pg_basebackup` 会因为找不到匹配行直接
  `fe_sendauth: no password supplied`，且这个失败发生在认证协议层面，与服务端
  `backup_role` 的 `REPLICATION` 属性或 `pg_hba.conf` 配置是否正确无关。
- **bash 3.2（macOS 系统 bash，本轮多处脚本的目标 shell）下 `set +e; f; rc=$?`
  不能安全捕获函数内部再次切换过 `set -e`/`+e` 的返回码**：`set -e`/`set +e`
  是全局 shell 选项而非函数作用域，若被调函数体内部又切回了 `-e`，一条裸
  `f` 语句在 `-e` 生效时遇到非零返回会在下一行 `rc=$?` 执行前就直接触发
  errexit，整个捕获逻辑被跳过。正确写法是把调用放进 `if`/`else` 的"被测试"
  位置（`if f; then rc=0; else rc=$?; fi`）——处于该位置的命令天然豁免
  errexit，不受其内部如何切换 `-e` 影响。`backup-timer.sh` 的
  `run_backup_resilient()` 即用此模式包裹 `run_backup()`。
- **首次删除后的恢复验证判据**：`pg_create_restore_point()` 返回的 LSN，与之后
  用该恢复点 promote 出的实例上 `pg_last_wal_replay_lsn()` 读到的值一致，是本轮
  用作 marker 级证据的判据之一（首次删除后的正向恢复验证记录了
  `replay_lsn=43/DB000090`）；PITR 演练与月度 smoke 均采用同一家族的判据，而不是
  只看进程退出码——`pg_ctl -w` 在到达"一致恢复点、可接受只读连接"时就会返回 0，
  即便最终会在到达具名恢复点之前失败，脚本必须结合 `pg_ctl status` 与日志
  `FATAL` 行才能正确判定失败，不能只看退出码（Gate 4 6A 负例/6B 均按此写法）。
- **新时间线号恒为已知最大 + 1，恢复实例需要 `recovery_target_timeline='current'`**：
  月度 PITR smoke（`pitr-smoke-local.sh`）与 Gate 4 恢复演练均依赖这条 PostgreSQL
  行为，促升后归档会出现一份新的 `.history` 文件（例如首次删除后的恢复验证记录了
  `selected new timeline ID: 2`）。
- **"六个容器 healthy" 不构成任何 WAL 相关结论的版本证据**：本轮写作过程中的
  真实案例——活栈六容器全部 `healthy`、`RestartCount=0`，但归档目录挂的仍是
  未修复的旧版 `archive-wal.sh`，`base-backups` 挂载点当时完全不存在。健康检查
  测的是"进程在跑、端口有响应"，不测"跑的是不是以为的那份代码"。任何"已上线/
  已生效"的结论必须同时给出 container id、image digest、`StartedAt`、
  `RestartCount`、health、完整 mounts（尤其每个 bind mount 的 `Source` 路径）、
  脚本哈希比对、发起变更时的 `git rev-parse HEAD` 八项，缺一不算证据。

## 10. 已知缺口 / 后续工单

- **告警推送未接线**：本地按第 7 节走 log-only 豁免（判据本身继续跑、继续判定
  fire/recover），真实推送通道尚未接入，生产部署前必须补上。
- **`base_backup_now()` 容器内临时 pgpass 仍是 `*:*:*:backup_role:` 通配写法**：
  这个临时文件走 unix socket、`mktemp` 现场生成、EXIT trap 删除、用完即焚，与
  宿主持久 pgpass（第 9 节已收窄为两条精确规则）是两个完全独立的生命周期，互不
  影响，但纪律不统一——已登记为后续工单，需收窄为同样的
  `postgres:5432:cps_novel:backup_role:`/`postgres:5432:replication:backup_role:`
  两条精确规则。
- **Linux 原生 Docker 上 root 属主目录的可删性**：Docker Desktop for macOS 的
  uid 重映射让"非 root uid 能否清理 root 属主的备份文件"这件事在本地看不出问题，
  原生 Linux（未来生产 VPS）没有这层重映射，一个非 root uid 尝试删除/覆写 root
  属主的 `base-backups` 内容会被内核直接拒绝。生产部署前需要给 `backup-timer`
  服务的 `user:` 对齐实际写入身份，或补一条显式 `chown` 步骤。
- **Gate 6（归档迁宿主绑定）**：仍是独立的、未排期的后续 Gate，不因本地日删
  自动化落地而提前——归档目录当前仍是具名卷，与 `postgres_data` 共享同一块
  Docker VM 虚拟盘。
- **生产 profile 参数待生产真实数据校准**：第 8 节列出的暂定值需要在生产流量下
  运行 7–14 天、用 daily WAL bytes 的 p50/p95 等口径重新计算后才能定案。
- **多时间线的 `timeline_unsupported` 两种形状之一、`reconcile_mismatch`、apply
  中途 kill、压缩归档路径**：均已在 `docs/operations/WAL_RETENTION_REHEARSAL_2026-09-16.md`
  "未覆盖项"一节如实登记为仍未实测的分支，本 ADR 不重复展开，仅提醒后续变更
  这些分支的代码时必须同步补验证。

## 11. 引用

- `docs/audits/WAL_RETENTION_X8_ROLLOUT_PLAN_2026-09-17.md`（尤其 §1–§6、§11：
  Gate 1–5 路线图、首次真实删除报告模板、本地放松项）
- `docs/operations/WAL_RETENTION_REHEARSAL_2026-09-16.md`（轮 A/B 演练矩阵、
  v2/v3/v4 修复轮改动清单、Gate 5-Dev 补充）
- `docs/operations/WAL_RETENTION_PROFILES.md`（local-X8 现行值 vs
  production-target 暂定值参数对照表）
- `docs/operations/X8_BACKUP_PGPASS_RECONCILE_2026-09-18.md`（分支
  `origin/fix/x8-backup-pgpass-replication`，未合并进本 ADR 的基线；
  `backup_role` pgpass 双规则修复的完整根因与迁移场景 A–F）
- `scripts/db/wal-retention.sh`、`scripts/db/wal-gc-x8.sh`、
  `scripts/db/verify-physical-base.sh` 头部注释与内联注释
- `infra/production-like/backup-timer.sh`、`infra/local-x8/wal-gc-daily-apply.sh`
  头部注释
- 关键 commit 区间（均可 `git show <sha>` 核对，基线 `integration/2026-09-16-night`
  `7b8d176`）：
  - `077da0a`..`8923814`：归档白名单修复、`verify-physical-base.sh`/
    `wal-retention.sh` 首次落地、一次性 rig 演练、Opus 一/二轮复核修复
    （`anchor_not_in_archive`/`would_empty_archive`/`set -e` 陷阱族）
  - `bbec454`..`d102089`：正式 X8 入口（`wal-gc`/`base-backup-now`）、compose
    挂载、Opus 三轮复核修复（挂载预检、worktree 绑定）
  - `5b8916d`..`de745c0`：Gate 5——`archive_not_writable` 仅 apply 时检查、
    `backup-timer.sh` 四步循环、`check-wal-archive.sh` 四判据告警
  - `61db7cb`..`de568e0`：本地日删自动化（LaunchAgent）、月度正向 PITR smoke、
    保留 profile 文档化
  - `c557d0d`..`91eca23`（未合并分支 `fix/x8-backup-pgpass-replication`）：
    `backup_role` pgpass 双规则 reconcile 修复
- 外部评审：多轮 Opus 复核（一/二/三轮，及 Gate 5、本地自动化、pgpass reconcile
  各自独立的复核轮次）、Fable 只读终审（2026-09-18T06:58Z）
