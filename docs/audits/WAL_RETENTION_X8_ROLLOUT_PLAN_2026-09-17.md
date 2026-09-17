# WAL 保留策略 X8 上线路线图（2026-09-17）

状态：`READY_FOR_CODEX_RELEASE_GATE`。本文档只是路线图与验收脚本集合，**不代表任何一步已经执行**。除第 0 节的只读取证外，本文档描述的所有命令在写作时均未对活栈执行。

分支：`feature/wal-retention-rehearsal`。**代码终态 commit = `d102089`（`d1020897ac53cdc26379229cd944f9b37892d23a`）**，本文档以此为准；本文档自身作为其后的一个 docs-only commit 提交，因此分支 HEAD = 本文档提交，代码内容与 `d102089` 完全一致。Codex 提示词里给的是含本文档的分支 HEAD。

---

## 1. 当前状态

### 1.1 分支与远端

| 项目 | 值 |
|---|---|
| worktree | `/Users/chenweifeng/Documents/cps海阅/wal-retention-rehearsal` |
| 分支 | `feature/wal-retention-rehearsal`（已 push 到 `origin`，与 `origin/feature/wal-retention-rehearsal` 同步） |
| 分支 commit（基线之上共 10 条） | `077da0a` → `97ab212` → `07d8cad` → `0c3ae6b` → `e039350` → `8923814`（首批 6 条，已 push）→ `bbec454` → `4bfca0f` → `d102089`（正式入口三条）→ 本文档（docs-only）。详见第 2 节逐条对照 |
| 正式入口改动 | 已提交为 `bbec454`（入口 + compose 挂载）、`4bfca0f`（测试）、`d102089`（挂载预检 + worktree 绑定 + 测试加固），见第 2 节 |
| 代码终态 commit | `d1020897ac53cdc26379229cd944f9b37892d23a`（`d102089`）；分支 HEAD 为其后的 docs-only 提交，`git log --oneline integration/2026-09-16-night..origin/feature/wal-retention-rehearsal` 应恰好 10 条 |
| **`<RELEASE_WORKTREE>`** | **占位符 —— Gate 1 产出的、检出了 `d102089` 的工作目录路径；合并目标分支（`main` 还是某个 `integration/*`）由 Owner 指定，本文档不代为选择** |

### 1.2 活栈快照（2026-09-17 00:3x UTC，只读 `docker inspect`/`docker exec ... psql -tAc` 取证，未做任何写操作）

| 容器 | Id（短） | Image | StartedAt (UTC) | RestartCount | Health |
|---|---|---|---|---|---|
| `cps-novel-x8-local-postgres-1` | `6ae7d1fbff65` | `postgres:16.14`（`sha256:02ad0fee…f227d8`） | 2026-09-16T13:00:37Z | 0 | healthy |
| `cps-novel-x8-local-worker-1` | `4b9850b667e0` | `cps-novel:0.1.0-da59d13` | 2026-09-16T13:04:15Z | 0 | healthy |
| `cps-novel-x8-local-web-1` | `e624a2d43f26` | `cps-novel:0.1.0-da59d13` | 2026-09-16T13:00:43Z | 0 | healthy |
| `cps-novel-x8-local-scheduler-1` | `d306595e3dc2` | `cps-novel:0.1.0-da59d13` | 2026-09-16T13:00:43Z | 0 | healthy |
| `cps-novel-x8-local-nginx-1` | `10b9628e9086` | `nginx:1.28.0-alpine` | 2026-09-16T13:00:50Z | 0 | healthy |
| `cps-novel-x8-local-backup-timer-1` | `6e961979ee4c` | `postgres:16.14` | 2026-09-16T13:00:51Z | 0 | healthy |

worker 镜像 `cps-novel:0.1.0-da59d13` 含 worker 领取查询热修（commit `2705b4d`）；六容器 `RestartCount=0`，全部 healthy —— 但**六个容器 healthy 不构成任何 WAL 相关结论的证据**，见第 8 节。

**快照失效提醒（2026-09-16 17:3x UTC 复核时发现）**：上表拍摄之后，`web-1` 与 `worker-1` 在 **16:45:12Z 被第三方 recreate**（新容器 id `66eb47b0e420` / `e0505d1d8ba0`，`Created == StartedAt`，`RestartCount=0`，镜像仍为 `cps-novel:0.1.0-da59d13`），不是本轮任何 agent 所为（本轮全程禁 `docker compose`），最可能是共享 `integration-night` worktree 的另一会话再次部署。同一时段有人手工创建并运行了一个 `catalog_scan`（`languages=["ko"]`，2000 页，`mode=apply`，`source=manual`），跑到 973 成功 / 123 失败（`worker_finalize_failed prismaCode=P2028`）后进入 `paused`；这段真实任务负载让 `pg_stat_wal.wal_bytes` 自 13:19Z 起累计 **+1.69 GB**、归档 +102 段（13:19Z→13:52Z 那段 33 分钟零增量的观察仍然成立——它测的是"冻结积压 + 空闲"形态）。任务暂停后 17:32Z 再测 30 秒窗口又回到 0 字节。同时 `generic_task` 新增一个 `disabled` 任务（2000 条 pending），冻结口径下的 `pending_under_disabled` 由 95,860 变为 97,860——原 95,860 条未被消费。**结论：活栈正被其它会话使用；Gate 2 之前必须按第 8 节重新拍完整快照，不能沿用本表；`P2028` 失败是 worker 功能问题，与 WAL 保留无关，另立议题。**

**重要发现（写文档时才核实到，Gate 2 执行前必须对齐）**：`docker inspect cps-novel-x8-local-postgres-1` 的 bind mount 源路径全部指向 `/Users/chenweifeng/Documents/cps海阅/integration-night/...`，即当前活栈是从 **`integration-night` 这个 worktree** 跑起来的，不是本 worktree，也几乎肯定不会是 `<RELEASE_WORKTREE>`。`scripts/lib/x8-production-like-env.sh` 里的 `x8_assert_worktree_stack_binding()` 会在 `up`/`gate` 家族命令里比对 compose 容器标签 `com.docker.compose.project.working_dir` 与调用者所在 worktree 是否一致，不一致就拒绝执行（防止 D-2/D-4 那类"跨 worktree 用错密钥/配置"事故）——但 `wal_gc()`/`base_backup_now()` 这两个新子命令**没有调用这个 guard**（只调 `prepare_x8_environment`，不做 worktree 绑定校验）。这意味着：
- 从任意 worktree 敲 `wal-gc`/`base-backup-now` 不会被工具本身拦下来（`exec` 只需要目标容器存在），但这不代表可以放心从错误的 worktree 操作——仍必须按下方 Gate 2 的写法手动调用同一个 guard。
- Gate 2 描述的"postgres 一次 recreate"如果直接用 `x8_compose up -d --no-deps postgres`，**必须先手动调用 `x8_assert_worktree_stack_binding`**（做法见 Gate 2），否则可能在不知情的情况下把 `<RELEASE_WORKTREE>` 的 compose 配置糊到一个由 `integration-night` 拥有的栈上。
- 这个 guard 目前**一定会拒绝**——因为 `<RELEASE_WORKTREE>` 不等于 `integration-night`。Owner 在 Gate 2 前需要二选一：
  ① 让 `<RELEASE_WORKTREE>` 直接复用/接管 `integration-night` 这个工作目录路径（例如 `git worktree move`，使 compose 标签比对通过）；
  ② 接受 Gate 2 的代价从"仅 recreate postgres"升级为"先 `down` 整个栈、再从 `<RELEASE_WORKTREE>` 完整 `up`"（六容器全部重启，Gate 2 的验收面显著扩大，且需要重新走一遍 `verify`/`accept`）。
  本文档 Gate 2 的命令默认按 ① 撰写；若 Owner 选 ②，把 Gate 2 的 recreate 命令换成 `down` 后接 `up`，并把 Gate 2 的"仅 postgres 重建"前提在报告里改口。

### 1.3 归档现状

| 项目 | 值（2026-09-17 取证） |
|---|---|
| 归档段数 | 2408（`find /var/lib/postgresql/wal-archive -maxdepth 1 -type f \| wc -l`，容器内执行） |
| 归档体积 | 38 GiB（`du -sh /var/lib/postgresql/wal-archive`） |
| `pg_stat_archiver` | `failed_count=0`；`archived_count` 持续增长（取证时 2068，随时间推进而非固定值，属正常） |
| 已存在的基准备份 | **0**（`/var/lib/postgresql/base-backups` 挂载点当前不存在——见下） |
| 归档目录位置 | 具名卷 `cps_novel_x8_wal_archive` → `/var/lib/postgresql/wal-archive`（不是宿主绑定目录，见第 7 节） |
| `archive-wal.sh` 容器内哈希（当前生效版本） | `440f830c85d13b504cfc10598f87c28763319813bf3befc054cacde0acc143ea`（= `integration-night` 分支上未修复的旧版，拒收 `.backup`/`.history`） |
| `archive-wal.sh` 本 worktree（`feature/wal-retention-rehearsal`）版本哈希 | `ea0d67e5c1fcb73896a19aa602f67a6c72364bb3e5bac10fcc514f37ccecaf59`（已放行白名单，commit `077da0a`） |
| `hba_file` | `/var/lib/postgresql/data/pg_hba.conf`（**在数据卷内，不是 bind mount**——见第 4 节 Gate 5 的说明） |

### 1.4 零锚点

38 GiB / 2408 段归档目前**没有任何基准备份可以锚定**——`wal-retention.sh`/`wal-gc-x8.sh` 目前对这整个归档目录无计可施，也无法清理任何一个字节（`--base-backup-dir` 下没有目录，见 `wal-retention.sh` 第 122-136 行：`valid_dirs` 为空数组，`insufficient_verified_backups` NOOP）。这是 Gate 3 要解决的第一件事，也是全文档最核心的初始条件：**在拿到第一份 `VERIFIED` 基准备份之前，清理器天生什么都做不了，这不是缺陷，是设计**。

---

## 2. 已完成风险修复

以下按已 push 到 `origin/feature/wal-retention-rehearsal` 的 commit 顺序列出；每条修复见 `docs/operations/WAL_RETENTION_REHEARSAL_2026-09-16.md` 对应的演练/单测证据行。

| Commit | 内容 | 修复的问题 |
|---|---|---|
| `077da0a` | `scripts/db/archive-wal.sh` 放行 `pg_basebackup` 的 `<24hex>.<8hex>.backup` 与时间线 `<8hex>.history` 两种额外文件名（原白名单只认 24 位十六进制 WAL 段名），配套测试 | **断点二（本轮最核心的缺陷）**：旧版白名单会让归档器在第一个 `.backup` 文件上永久卡死（轮 A 演练实证：`failed_count` 从 0 涨到 30 都没停，此后所有 WAL 归档全部停摆） |
| `97ab212` | 新增 `scripts/db/verify-physical-base.sh`（解包校验 `pg_verifybackup`，不带 `--no-parse-wal`，交叉核对 `backup_label`/`backup_manifest` 的段名，写 `VERIFIED` 标记）与 `scripts/db/wal-retention.sh`（`pg_archivecleanup` 包装器，锚点式保留） | 补齐"校验"与"清理"两个此前完全不存在的能力 |
| `07d8cad` | 新增 `scripts/db/wal-retention-rehearsal.sh`，一次性 Docker rig，跑通轮 A（对照组，实证旧脚本缺陷）与轮 B（修复版，23/23 断言 PASS） | 用真实 PostgreSQL 进程（非猜测退出码）验证整条恢复链 |
| `0c3ae6b` | Opus 一轮复核后的 P0/P1 修复：`anchor_not_in_archive`、`would_empty_archive`、`--require-archiver-healthy` 开关、`plan_failed`、`unexpected_directory` 目录名校验 + 按 `VERIFIED.start_wal` 排序 | **P0**：归档器一旦卡死，旧版清理器会拿一个从未真正归档过的锚点把归档目录清空、还打印绿色 `APPLIED`（轮 A 演练的真实证据：删光 01–06 六段，锚点 `…0B` 从未出现在任何一次 `pg_archivecleanup` 输出里） |
| `e039350` | `tests/backend/database/wal-retention-apply-order.test.ts`（无 Docker，PATH shim），演练新增 Step4N | 补上 `anchor_not_in_archive`/`plan_failed` 的自动化覆盖 |
| `8923814` | Opus 二轮复核（v3）：`archiver_failing` 改成对 `pg_stat_archiver` 的**时点谓词**（不再是 `failed_count` 累计基线，避免一次失败后永久拒绝、无法自愈）；`set -e` 陷阱修复（P1-A/P1-B，两处命令替换缺 `\|\| true` 会在赋值处直接杀死脚本，导致 `REFUSED` 行永远打不出来）；`verified_malformed`（P1-D，`VERIFIED` 缺字段的备份此前会被空字符串排序规则当成"最老"静默退休删除）；`WAL_RETENTION_HINT`（`reconcile_mismatch` 分支的人工操作提示） | Opus 二轮复核抓到的"判断本身没错，但根本跑不到判断"这一整族 `set -e`/`pipefail` 陷阱，以及一个真实数据丢失通路（P1-D） |

**测试与演练现状**：`npx vitest run --project node tests/backend/database/` 在 `8923814` 上是 18 files / 130 tests 全过；`wal-retention-rehearsal.sh` 轮 B v3 是 30/30 断言 PASS（含两处"必须真失败"的负例，均以真实 PostgreSQL 日志 `FATAL` 行收尾，不是猜退出码）。

**「正式入口」改动（已提交：`bbec454` / `4bfca0f` / `d102089`；Opus 三轮复核 APPROVED_WITH_FIXES 后按其清单修复）**：

- `scripts/db/wal-gc-x8.sh`（新文件，`bash -n` 已过）：固定 `--archive-dir /var/lib/postgresql/wal-archive`、`--base-backup-dir /var/lib/postgresql/base-backups`、`--require-archiver-healthy`（**调用者无法关闭**）、`--max-bytes 21474836480`（20 GiB，对齐方案 §2.3），只透传 `--apply`/`--keep-base`/`--json`/`--force`。任何不在白名单内的参数直接 `usage; exit 64`。
- `scripts/x8-production-like.sh` 新增两个子命令：
  - `wal-gc [--apply] [--keep N] [--json] [--force]` → `x8_compose exec -T -u postgres postgres bash /app/scripts/db/wal-gc-x8.sh ...`（`--keep` 映射为 `--keep-base`）。
  - `base-backup-now` → 容器内以 `postgres` OS 用户、`PGHOST=/var/run/postgresql`（本地 socket）、`backup_role`（口令来自已挂载的 `/run/secrets/backup_role_password`，从不落地明文到命令行）执行 `backup-physical-base.sh --output-dir /var/lib/postgresql/base-backups/<UTC 时间戳>Z`，成功后立即链式执行 `verify-physical-base.sh --backup-dir <同一目录>`，任一步失败即中止（heredoc 自带 `set -euo pipefail`）。
- `infra/production-like/docker-compose.yml` 给 postgres 服务新增 5 条挂载：`${X8_BASE_BACKUP_DIR}:/var/lib/postgresql/base-backups`（读写）+ 4 个脚本只读 bind：`wal-retention.sh`、`wal-gc-x8.sh`、`backup-physical-base.sh`、`verify-physical-base.sh`（均挂到 `/app/scripts/db/<name>.sh:ro`，与既有 `archive-wal.sh` 挂载同一约定）。
- `infra/production-like/postgres-entrypoint.sh` 新增一行 `install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/base-backups`（与既有 `wal-archive` 那行同款，解决"宿主绑定目录默认属主不是 postgres"这个真实存在的权限坑）。
- `scripts/lib/x8-production-like-env.sh` 新增 `X8_BASE_BACKUP_DIR="$X8_RUNTIME_DIR/base-backups"`（即 `.tmp/x8-production-like/base-backups`），并入 `prepare_x8_environment()` 的 `mkdir -p`/`chmod 700` 序列与 `x8_export_static_topology()` 的导出列表。
- `tests/backend/database/wal-retention-guards.test.ts`（+94 行）与新文件 `tests/backend/database/wal-gc-x8.test.ts`（346 行，无 Docker，PATH shim）：覆盖 `--force` 只绕过 `delete_surge_guard`、不绕过 `anchor_not_in_archive`/`archiver_failing`/`verified_malformed` 等其它拒绝分支；`wal-gc-x8.sh` 参数白名单本身的拒绝路径。

以上已全部提交。`d102089` 在此基础上追加（Opus 三轮复核 P1-1/P1-2/P2 清单）：两个子命令调用前先 `x8_assert_worktree_stack_binding`（与 `gate` 家族同款）再做挂载预检 `x8_require_wal_retention_mounts`（四个脚本 `test -r` + `mountpoint -q /var/lib/postgresql/base-backups`，不满足以 65 拒绝并提示先 recreate）；`base-backup-now` 成功后打印 `X8_BASE_BACKUP_HOST_DIR=<宿主真实落点>`；校验解包目录改为宿主绑定下的 `.verify-<stamp>`（不落 Docker VM 盘）；`wal-retention.sh` 对既无 `VERIFIED` 也无 `RETIRED` 的合规目录打印 `WAL_RETENTION_WARN=unverified_backup_dir`；`wal-gc-x8.sh` 带 `--force` 时先打印 `WAL_GC_X8_NOTICE=delete_surge_guard_disabled_for_this_run`；静态断言改为只匹配 `target=(…)` 内的字面量（变异证明注释骗不过）。终态：`npx vitest run --project node tests/backend/database/` 19 文件 149 通过，`bash -n` 六个脚本全过。

---

## 3. 仍剩风险

以下按 `docs/operations/WAL_RETENTION_REHEARSAL_2026-09-16.md`"未覆盖项"一节逐条继承，只保留仍然成立、会实际影响上线判断的部分，并补充两条演练报告之外发现的问题：

1. **`would_empty_archive` 不可达**：`anchor_not_in_archive` 先把关（锚点段必须真实在档），而锚点段本身正是 `pg_archivecleanup` 的 `OLDESTKEPTWALFILE`，按其契约永远不会出现在自己的删除计划里——只要前者成立，"计划执行后归档清零"这个条件不可能同时成立。这是防御性兜底，不是独立可达路径，Opus 二轮复核已论证，本轮不再要求补覆盖。
2. **apply 中途 kill 未覆盖**：进程被杀在"已标记 `RETIRED`、还没删 WAL"或"已删 WAL、还没删目录"之间的场景，无单测、演练没有模拟。P1-3 的单测只验证了正常完整跑完时的时序，不等于验证了"中途真的被杀掉"后重跑是安全的（设计上应该是安全的——`RETIRED` 标记先行、有效集合只认标记不认目录是否存在——但没有一次真实的 kill -9 实测）。
3. **`reconcile_mismatch` 完全未实测**：`pg_archivecleanup -d` 之后文件仍残留的场景，无单测、演练未构造。`WAL_RETENTION_HINT` 提示行本身也只经过静态代码走查。
4. **多时间线两种形状之一仍未覆盖**：`timeline_unsupported` 由 (a) `wal_ranges_count != 1`（含 0 和 ≥2）或 (b) `anchor_timeline != "1"` 触发；(a) 的 0 已被 v3 单测覆盖，(a) 的 ≥2 与 (b) 仍完全未验证（6A/6B 用的都是单一时间线 1 号）。
5. **压缩归档（`--archive-ext .gz`）未实测**：脚本支持该参数，演练与线上全程都没有产生过压缩 WAL。
6. **告警链路未接线**：`pg_stat_archiver.failed_count`/`last_failed_time` 超阈值告警、基准备份新鲜度告警都还没有接入 `infra/production-like/alerts/run-all.sh`（Gate 5 要做的事）。
7. **无 timer**：`backup-timer.sh` 目前只跑逻辑备份一步，物理基准备份 + 校验 + 清理 dry-run 三步还没接进循环（Gate 5）。
8. **38 GiB 无锚点**：见第 1.4 节，Gate 3 之前清理器对它完全无能为力，这不是 bug。
9. **宿主机 `df` 陷阱**：宿主机看到的磁盘用量与 Docker Desktop VM 内部实际占用是两回事（VM 独立于 macOS 文件系统），任何容量判断必须在容器内或按字节统计，不能信 `df` 在宿主机上的读数。
10. **单文件 bind mount 不跟随 host 端 rename**：见第 4 节 Gate 2 的实测结果——host 端一次 rename 式编辑（如 `sed -i ''`）会让运行中容器对该文件的 `open()` 直接 `ENOENT`，`stat`/`ls` 却仍报告旧的（已被 unlink 的）元数据；容器不重启，这个不一致不会自愈。
11. **归档写满仍会拖垮 PGDATA**：归档目录目前是具名卷（非独立文件系统/挂载点），与 `postgres_data` 共享同一个 Docker VM 磁盘；`wal_archive` 无限增长到撑爆 VM 磁盘时，受影响的不只是归档——`PGDATA` 本身的写入也会失败。第三批"归档迁宿主绑定"（第 7 节）缓解的是"归档占满连累数据库"这块虚拟盘压力，但**不能替代** §3 的归档器健康信号，也不改变"归档、PGDATA、base-backups 三者目前共享同一存储上限"这个事实。
12. **`wal-gc`/`base-backup-now` 的 worktree 绑定校验**（第 1.2 节已展开）：写作时两个新子命令没有调用 `x8_assert_worktree_stack_binding()`；Opus 三轮复核（P1-2）同时指出 `x8_compose exec` 作用于"谁 `up` 的那个容器"，宿主产物会落到 `up` 时那个 worktree 的 `base-backups` 绑定目录，而不是调用者的。**修复轮已把该 guard 加进两个子命令**（与 `gate` 家族同款，从非拥有栈的 worktree 调用会被拒），并在 `base-backup-now` 成功后打印 `X8_BASE_BACKUP_HOST_DIR=<宿主真实落点>`。Gate 2 的 recreate 仍需按第 1.2 节的二选一处理，因为 `up -d --no-deps postgres` 本身也会被同一个 guard 拦。
13. **正式入口的"强制 archiver health"是入口级控制，不是容器级控制**（Opus 三轮 P2-6）：compose 必然把裸 `wal-retention.sh` 也挂进 postgres 容器，`docker exec` 直接跑它仍可不带 `--require-archiver-healthy`。运维纪律：Gate 3 之后对活栈**只允许**经 `scripts/x8-production-like.sh wal-gc` / `base-backup-now` 操作，禁止在容器内手敲 `wal-retention.sh --apply`。
14. **运行时挂载预检**（Opus 三轮 P1-1）：当前活栈的 postgres 容器没有 `/var/lib/postgresql/base-backups` 挂载和四个新脚本 bind；若在 Gate 2 之前误跑新子命令，修复轮加入的预检（`test -r` 四个脚本 + `mountpoint -q /var/lib/postgresql/base-backups`）会以 65 拒绝并提示先 recreate。更危险的形状是"脚本挂了、目录没挂"——`backup-physical-base.sh` 的 `mkdir -p` 会把整份基准备份写进容器 overlay 层（即 Docker VM 盘），并在下次 recreate 时消失；预检就是为堵这条路。
15. **`-u postgres` 读 `/run/secrets/backup_role_password` 依赖 Docker Desktop for macOS 的 uid 重映射**（Opus 三轮实证：宿主 0600/501:20 的文件在容器内显示为 999:999 可读）。**在原生 Linux Docker（未来海阅生产 VPS）上没有这层重映射**，0600/501 的文件对 uid 999 不可读，`base-backup-now` 会在读密码那一步 fail-closed 退出。生产部署前必须把 secrets 文件属主/权限按 Linux 语义处理（属 postgres uid 或 0640 + 组），这条写进方案 v2 §2.4 的生产前提。

---

## 4. Gate 1～Gate 5

每个 Gate 固定四段：前置条件 / 命令 / PASS 条件 / FAIL 停止条件与回退。**Gate N 未 PASS，禁止执行 Gate N+1 的任何命令**。

### Gate 1 — Codex 合并与发布准备

**前置条件**
- 本文档、`docs/operations/WAL_RETENTION_REHEARSAL_2026-09-16.md`、第 2 节列出的全部改动（含"写作时另一 agent 正在追加"的部分）均已提交为真实 commit。
- Owner 已指定合并目标分支（`main` 或某个 `integration/*`——本文档不代为选择）。

**命令**
```bash
# 在本 worktree（feature/wal-retention-rehearsal）确认树干净、所有改动已提交
cd /Users/chenweifeng/Documents/cps海阅/wal-retention-rehearsal
git status --short   # 必须为空
git log --oneline integration/2026-09-16-night..HEAD   # 应为 10 条，代码终态 d102089

# 交给 Codex 的信息：分支名 + d102089 + Owner 指定的合并目标分支名
# 本文档不执行合并，只消费 Codex 合并之后的结果
```

**PASS 条件**
- `git status --short` 为空。
- Codex 已将 `d102089` 合并进 Owner 指定的目标分支，产出一个新的 `<RELEASE_WORKTREE>`（新工作目录/新 checkout，包含合并后的完整提交历史）。
- 重新按第 2 节逐条 `git show d102089:<path>` 核对本文档描述的每一处文件:行号，确认与合并后的真实内容一致。

**FAIL 停止条件与回退**
- 树不干净、或 Codex 合并产生冲突未解决：停止，不产出 `<RELEASE_WORKTREE>`。
- **本 Gate 不部署、不启停任何容器、不改动任何正在跑的栈。**

---

### Gate 2 — 活栈换 `archive-wal.sh` + 加 `base-backups` 挂载

**前置条件**
- Gate 1 PASS，`<RELEASE_WORKTREE>` 已存在且**包含**代码终态 `d102089`（合并后的 release HEAD 不等于它，用 `git merge-base --is-ancestor` 判）。
- Owner 已就第 1.2 节"重要发现"的二选一做出决定。以下命令按选项 ①（`<RELEASE_WORKTREE>` 复用/接管 `integration-night` 的工作目录路径，使 compose 标签比对通过）撰写；若 Owner 选 ②，把下方"真正的 recreate"一步换成 `scripts/x8-production-like.sh down` 后接 `scripts/x8-production-like.sh up`，并把 PASS 条件里的"其它服务不应被牵连"改为"六容器全部预期重启，逐个验证 healthy"。
- 这是**本轮第一个真正的写操作**（之前全部只读）。

**命令**
```bash
cd <RELEASE_WORKTREE>
git merge-base --is-ancestor d1020897ac53cdc26379229cd944f9b37892d23a HEAD && echo CONTAINS_CODE_FINAL=yes   # 否则立即停止
git show HEAD:scripts/db/archive-wal.sh | shasum -a 256   # 必须 == git show d102089:scripts/db/archive-wal.sh | shasum -a 256

# 1) recreate 前快照：六容器逐个记录 id / image / StartedAt / RestartCount / health
for c in postgres nginx web worker scheduler backup-timer; do
  docker inspect "cps-novel-x8-local-${c}-1" \
    --format "${c} {{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}"
done | tee /tmp/gate2-before.txt

# 2) 计算 <RELEASE_WORKTREE> 里 archive-wal.sh 的期望哈希（macOS 用 shasum；CI/Linux 用 sha256sum）
git show d102089:scripts/db/archive-wal.sh | shasum -a 256

# 3) 只读地验证这个 worktree 自己的环境能否让两份 compose 文件成功解析
#    （source 而非直接执行，不会触发文件末尾的分发 case；下面这步不改变任何容器状态）
bash -c '
set -euo pipefail
source scripts/x8-production-like.sh
prepare_x8_environment
echo "X8_BASE_BACKUP_DIR=$X8_BASE_BACKUP_DIR"
x8_compose config --services
'

# 4) 手动复算并调用 worktree 绑定 guard（wal-gc/base-backup-now 不会自动做这一步，
#    但 up_x8/gate 家族的等价检查就是这样调的——recreate 前必须自己补上）
bash -c '
set -euo pipefail
source scripts/x8-production-like.sh
prepare_x8_environment
x8_assert_worktree_stack_binding "$P1_12_COMPOSE_PROJECT" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)" || exit 65
echo "WORKTREE_BINDING=OK"
'
# 若上面打印 ERROR: compose project ... 已经拒绝 —— 停止，回到"前置条件"的二选一，
# 不要绕过这个 guard。

# 5) 真正的 recreate（唯一一次写操作；--no-deps 只重建 postgres）
bash -c '
set -euo pipefail
source scripts/x8-production-like.sh
prepare_x8_environment
x8_compose up -d --no-deps postgres
'

# 6) recreate 后逐个验证六容器重新 healthy（depends_on: service_healthy 会让
#    web/worker/scheduler/nginx/backup-timer 在 postgres 重启窗口内短暂失联，
#    这里要等它们自己恢复，不要手工重启它们）
for c in postgres nginx web worker scheduler backup-timer; do
  docker inspect "cps-novel-x8-local-${c}-1" \
    --format "${c} {{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}"
done | tee /tmp/gate2-after.txt
diff /tmp/gate2-before.txt /tmp/gate2-after.txt || true   # 期望只有 postgres 一行变化

# 7) PASS 必核的四项
docker exec cps-novel-x8-local-postgres-1 sha256sum /app/scripts/db/archive-wal.sh
# 对比第 2 步的期望哈希，必须一致

docker exec cps-novel-x8-local-postgres-1 sh -c \
  "stat -c '%U:%G %a' /var/lib/postgresql/base-backups"
# 期望：postgres:postgres 700

docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;"
# 期望：0

docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT failed_count FROM pg_stat_archiver;"
# recreate 前后各查一次，期望不增长
```

**PASS 条件**
- `docker exec postgres sha256sum /app/scripts/db/archive-wal.sh` 与 `git show d102089:scripts/db/archive-wal.sh | shasum -a 256` **完全一致**（这不是"文件存在就行"——第 4 节末尾的实验证明单文件 bind mount 在某些编辑方式下会悄悄提供旧内容甚至直接 `ENOENT`，必须每次 recreate 后都做这个哈希核对，不能只看 mount 是否存在）。
- `/var/lib/postgresql/base-backups` 挂载存在，属主 `postgres:postgres`，权限 `0700`。
- `pg_hba_file_rules` 无 `error IS NOT NULL` 的行。
- `pg_stat_archiver.failed_count` recreate 前后不增长。
- 第 6 步的 diff 只显示 `postgres` 一行变化（`Id`/`StartedAt` 必然变，`RestartCount` 预期仍是 0——这是 recreate 不是 restart；其余五个容器的 `Id` 不应该变，它们只是短暂失联后自愈，不是被重建）。若选项 ② 被采用，则六行全部预期变化，改用该分支自己的验收标准。

**FAIL 停止条件与回退**
- 第 4 步 guard 拒绝：停止，不执行第 5 步。回到前置条件二选一。
- 哈希不一致、`base-backups` 属主/权限不对、`pg_hba_file_rules` 有 error、`failed_count` 增长、或有非 `postgres` 之外的容器 `Id` 变化：**立即停止，不进入 Gate 3**。回退：`x8_compose down`（只 down 本 recreate 影响的部分不现实，按 `docs/p1/P1_06_PITR_RUNBOOK.md` 与既有 `down --purge` 的既有语义处理，具体回退动作需 Owner 现场判断，不在本文档展开——本节的定位是"检测到问题就停",不是给出一个未经验证的回退脚本）。

---

### Gate 3 — 首份真实基准备份

**前置条件**
- Gate 2 PASS。

**命令**
```bash
cd <RELEASE_WORKTREE>

# 1) 首份基准备份（容器内 local socket，backup_role，不扩 pg_hba）
scripts/x8-production-like.sh base-backup-now

# 2) 确认 VERIFIED 标记与内容（时间戳目录名由上一步的输出决定，形如 20260917T......Z）
STAMP=$(docker exec cps-novel-x8-local-postgres-1 sh -c \
  "ls -1 /var/lib/postgresql/base-backups | sort | tail -1")
docker exec cps-novel-x8-local-postgres-1 cat "/var/lib/postgresql/base-backups/${STAMP}/VERIFIED"

# 3) 冷启动 dry-run —— 必须是 NOOP，不是 DRY_RUN，更不能是 APPLIED
scripts/x8-production-like.sh wal-gc --json

# 4) 归档器健康 + 白名单生效的独立核验
docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT failed_count FROM pg_stat_archiver;"
docker exec cps-novel-x8-local-postgres-1 sh -c \
  "ls /var/lib/postgresql/wal-archive | grep -E '\.[0-9A-F]{8}\.backup$' | tail -3"
```

**PASS 条件**
- `base-backup-now` 输出含 `PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED` 与 `PHYSICAL_BASE_VERIFY=PASS`。
- `VERIFIED` 文件存在且含 `start_wal`（24 位十六进制）、`start_timeline=1`、`verified_epoch`（纯数字）三个字段，格式必须全部匹配 `wal-retention.sh` 自己的校验正则（`^[0-9A-F]{24}$` / `^[0-9]+$` / `^[0-9]+$`）。
- `wal-gc --json`（不带 `--apply`）输出 `WAL_RETENTION=NOOP reason=insufficient_verified_backups`。**这是正确的冷启动状态——禁止为了让它"动起来"而改传 `--keep 1`**（第 6 节展开）。
- `pg_stat_archiver.failed_count` 在备份前后不增长。
- 归档目录里出现至少一个 `<24hex>.<8hex>.backup` 文件（证明 `077da0a` 的白名单修复在真实生产路径上生效，不只是在一次性 rig 里生效）。

**FAIL 停止条件与回退**
- `base-backup-now` 任一步失败（`backup-physical-base.sh` 或 `verify-physical-base.sh` 非零退出）：停止，不进入 Gate 4。检查 `PGUSER=backup_role` 是否具备 `REPLICATION`（`infra/postgres/roles.sql:36` 已授予，若失败先确认 Gate 2 没有意外改动角色）。
- `wal-gc` 输出不是 `NOOP reason=insufficient_verified_backups`（例如打印了 `DRY_RUN` 或任何 `REFUSED`）：停止，说明"只有一份备份"这个前置条件判断本身出了问题，先排查再继续，不得手工加 `--keep 1` 绕过去看它"能不能删"。
- `failed_count` 增长或找不到 `.backup` 文件：说明白名单修复在这套真实 compose 挂载下没有真正生效（可能是 Gate 2 的哈希核对本身有遗漏），退回 Gate 2 重新核对。

---

### Gate 4 — 真实恢复链验收

**前置条件**
- Gate 3 PASS，B1（Gate 3 产出的首份基准备份）存在且 `VERIFIED`。
- 需要产出 **B2**：在 B1 至少间隔一段时间（不是紧接着再做一次——见第 6 节"不要为了凑 N=2 就连着立刻做两份"）之后，重新执行一次 `scripts/x8-production-like.sh base-backup-now`，得到第二份 `VERIFIED` 基准备份。
- **本 Gate 唯一允许对活库执行的写操作**：`SELECT pg_create_restore_point('X8_GATE4_<ts>')` + `pg_switch_wal()`（创建一条具名恢复点的 WAL 记录并强制切段，使其被归档）——这一步需要 **Owner 批准**，因为它是本文档里第一次、也是唯一一次对活库数据做出真实（虽然极小）写入。
- 所有恢复演练本身必须在**一次性容器**里对**归档的只读副本**进行，绝不直接对 `cps_novel_x8_wal_archive` 卷做写操作。

**命令**
```bash
cd <RELEASE_WORKTREE>

# 0) Owner 批准后，在活库创建具名恢复点并强制切段
RP_NAME="X8_GATE4_$(date -u +%Y%m%dT%H%M%SZ)"
RP_LSN=$(docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc \
  "SELECT pg_create_restore_point('${RP_NAME}');")
docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc \
  "SELECT pg_switch_wal();"
# victim 段 = 含 <RP_NAME> 记录的那个段；pg_walfile_name() 是纯函数，在活库上调用只读、不写
VICTIM=$(docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc \
  "SELECT pg_walfile_name('${RP_LSN}');")
# B1 的 End-LSN 段（来自 B1 的 backup_manifest；同样只读换算）——VICTIM 必须严格大于它，
# 否则 B1 自带的 pg_wal.tar.gz 会补上这段，负向用例不成立（rehearsal Step 6B 同款前提）
B1_END_LSN=$(grep -o '"End-LSN": *"[^"]*"' .tmp/x8-production-like/base-backups/<B1_STAMP>/backup_manifest | head -1 | cut -d'"' -f4)
B1_END_SEG=$(docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc \
  "SELECT pg_walfile_name('${B1_END_LSN}');")
echo "RP_NAME=$RP_NAME RP_LSN=$RP_LSN VICTIM=$VICTIM B1_END_SEG=$B1_END_SEG"
[[ "$VICTIM" > "$B1_END_SEG" ]] || { echo "VICTIM 不在 B1 结束之后，停止"; exit 1; }
# 等 10-15s 让 archive_command 把这一段送进归档
docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT failed_count, last_archived_wal FROM pg_stat_archiver;"   # 确认在推进、没有失败

# 1) 归档只读副本：用一次性容器把具名卷 cps_novel_x8_wal_archive 只读复制到宿主 tmp
WD="$(mktemp -d "${TMPDIR:-/tmp}/wal-retention-rig-gate4.XXXXXX")"
docker run --rm --pull never --network none \
  --name wal-retention-rig-gate4-copy \
  -v cps_novel_x8_wal_archive:/src:ro \
  -v "$WD/archive:/dest" \
  postgres:16.14 sh -c 'mkdir -p /dest && cp -a /src/. /dest/'
ls "$WD/archive" | wc -l   # 应约等于 2408 + Gate 3/4 新产生的段数

# 2) 把 B1（正向）与"B1 之后、目标之前删一段"（负向）两份归档目录分别准备好
cp -a "$WD/archive" "$WD/archive-positive"
cp -a "$WD/archive" "$WD/archive-negative"
# 负向副本删掉 victim 段（第 0 步已算出）。做法与 scripts/db/wal-retention-rehearsal.sh 的
# Step 6B 完全同款（该脚本已在轮 B 用真实 PostgreSQL 日志证明"删掉 victim 段 -> FATAL:
# recovery ended before configured recovery target was reached"这条因果链，本 Gate 只是把
# 输入换成真实 B1/归档副本，不再是 rig 自己生成的合成数据）。
[[ -f "$WD/archive-negative/$VICTIM" ]] || { echo "victim 段尚未归档，等归档推进后重试"; exit 1; }
rm "$WD/archive-negative/$VICTIM"

# 3) 正向：B1（原目录含 base.tar.gz / pg_wal.tar.gz / backup_manifest，restore-pitr.sh 自己解包）
#    + 指向 archive-positive，用 recovery_target_name。restore-pitr.sh 目前只支持 --target-time
#    （P1_06_PITR_RUNBOOK.md 第 5 节），所以准备完 PGDATA 后手工把目标改成 restore point——
#    这是对 runbook 的补充，后续应给 restore-pitr.sh 加 --target-name。
#    全部在一次性容器内执行：restore_command 写进 PGDATA 的是容器内路径，不能用宿主路径。
cp -a ".tmp/x8-production-like/base-backups/<B1_STAMP>" "$WD/b1"    # 复制一份，原目录不动
docker run --rm --pull never --network none --name wal-retention-rig-gate4-pos \
  -v "$WD:/rig" -v "$PWD/scripts/db:/app/scripts/db:ro" -u postgres postgres:16.14 bash -c '
set -euo pipefail
P1_06_ALLOW_DISPOSABLE_PITR=1 P1_06_WAL_ARCHIVE_DIR=/rig/archive-positive \
  bash /app/scripts/db/restore-pitr.sh --base-backup /rig/b1 \
  --pgdata /rig/p1-06-pitr-gate4-positive --target-time "1970-01-01T00:00:00Z"
sed -i "s/^recovery_target_time.*/recovery_target_name = '"'"''"$RP_NAME"'"'"'/" /rig/p1-06-pitr-gate4-positive/postgresql.auto.conf
sed -i "s/^recovery_target_action.*/recovery_target_action = '"'"'promote'"'"'/" /rig/p1-06-pitr-gate4-positive/postgresql.auto.conf
pg_ctl -D /rig/p1-06-pitr-gate4-positive -o "-p 5433" -w -l /rig/gate4-positive.log start
until [ "$(psql -p 5433 -d cps_novel -tAc "SELECT pg_is_in_recovery()")" = f ]; do sleep 1; done
psql -p 5433 -d cps_novel -tAc "SELECT count(*) FROM novel;"        # marker 级证据之一，与活库同刻快照比对
pg_ctl -D /rig/p1-06-pitr-gate4-positive stop -m fast
'
grep -E "recovery stopping at restore point|selected new timeline" "$WD/gate4-positive.log"
# 等待循环在实际执行时要加 SECONDS 上限（macOS 无 timeout），起实例/等回放/查 pg_ctl status/
# 抓 FATAL 行这一整套机制与 wal-retention-rehearsal.sh Step 5/6 同款，细节见该脚本

# 4) 负向：同一份 B1（再拷一份 $WD/b1 → 新 PGDATA /rig/p1-06-pitr-gate4-negative），指向
#    archive-negative（缺 victim 段），同样目标 $RP_NAME，容器名 wal-retention-rig-gate4-neg。
#    期望：pg_ctl -w 可能仍返回 0（"一致恢复点"已达到，与轮 B v3 报告里 6B 的已知现象一致），
#    必须用 pg_ctl status（no server running）+ 日志 FATAL 行判定，不能只看退出码：
grep -E "recovery ended before configured recovery target was reached|could not locate required checkpoint record" "$WD/gate4-negative.log"

# 5) marker 级证据：恢复后查一张已知表的行数/最大 id，与活库同一时刻的快照比对
docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc \
  "SELECT count(*) FROM novel;"   # 表 novel 已核实存在（取证时 79,427 行）；活库与两份恢复实例三方比对

# 6) 清理（精确按名字）
docker rm -f wal-retention-rig-gate4-copy wal-retention-rig-gate4-pos wal-retention-rig-gate4-neg 2>/dev/null || true
rm -rf "$WD"
```

**PASS 条件**
- 正向：B1 + `archive-positive` 恢复到 `<RP_NAME>` 成功 promote，marker/行数与活库在恢复点那一刻的状态一致。
- 负向：B1 + `archive-negative`（缺 victim 段）恢复**必须到不了** `<RP_NAME>`——`pg_ctl status` 显示 no server running，且日志里有 `FATAL: recovery ended before configured recovery target was reached`（或等价的、明确指向"缺段"的 FATAL），不能把"看起来还没失败"当成通过。
- 两组都留下 marker 级证据文件（日志尾行 + 行数比对），不是只看退出码。

**FAIL 停止条件与回退**
- 正向都到不了 `<RP_NAME>`：说明 B1→归档→目标这条链本身有问题，**不得继续 Gate 5**，退回 Gate 3 重新核对 B1 的 `VERIFIED` 是否可信、归档副本复制是否完整。
- 负向也能到达 `<RP_NAME>`（即删掉 victim 段后恢复居然"成功"了）：说明验收本身失真（要么 victim 段选错了、要么归档副本复制时漏了别的东西把它补上了），**这是比正向失败更严重的信号**——意味着这条验收链本身不承重，必须先修好验收再谈是否可以 Gate 5。
- 全程只对活库做了第 0 步一次性的 `pg_create_restore_point`/`pg_switch_wal`；其余所有操作都在一次性容器 + 归档只读副本上进行，不涉及回退活库本身。

---

### Gate 5 — 每日 timer + 告警

**状态**：**5-Dev（代码实现）已完成**，分支 `feature/wal-retention-gate5`（基线
`36234d639d9722e0fd69b1301f7b7ead375c3cf8`），四个 commit，**未 push**，等 Opus 复核后
再由 Owner 决定 push/合并时机。**5-Ops（在活栈上落地执行）仍待人工**——本节下方 5.2
的手工步骤、以及"接线到真实运行的 `cps-novel-x8-local-*` 容器"这一整段都还没有做；
具体执行步骤序列、验收命令另行以 Codex 提示词下发，不在本单范围内跑。

**前置条件**
- Gate 4 PASS（B1/B2 均 `VERIFIED`，恢复链正向/负向均按预期）。

**5-Dev 交付清单**（四个 commit，均在上面的分支）：

1. `scripts/db/wal-retention.sh`：`archive_not_writable` 改为**只在 `--apply` 时检查**
   ——dry-run 从不写归档，之前"任何调用都要求 archive-dir 可写"和"生产给
   `backup-timer` 的归档挂载改成只读 `:ro`"是矛盾的，这条 fix 就是为了解开这个矛盾。
2. `infra/production-like/backup-timer.sh`：`run_backup()` 从一步（逻辑备份）扩成
   四步——逻辑备份（默认路径不变）→ 物理基准备份 → 完整校验 → `wal-gc-x8.sh --json`
   **dry-run**（这个循环里永远不出现 apply 相关的标志，人工授权的单独 apply 动作见
   第 5 节）。每一步各自 `set +e`/`set -e` 隔离，一步失败不影响之前已成功的步骤，
   但整轮仍会通过这个文件本身的 `set -e` 向外传播非零退出（沿用四步扩容前"失败即
   退出、靠 compose `restart: unless-stopped` 重试"的既有语义，没有改）。新增两个
   开关：`X8_BACKUP_PHYSICAL_ENABLED`（默认 `true`）、`X8_BASE_BACKUP_MIN_INTERVAL_SECONDS`
   （默认 `72000` 秒 = 20 小时）。
3. `infra/production-like/docker-compose.yml`：`backup-timer` 服务新增四个脚本的
   只读挂载（与 `postgres` 服务已有的挂载同款）、`base-backups`（读写）与
   `wal_archive`（**只读 `:ro`**）两个卷，以及上面两个开关的 env 透传。
4. `infra/postgres/init-roles.sh`：仅对**全新** `PGDATA`（initdb 阶段脚本，只在
   集群首次初始化时跑一次）幂等追加
   `host replication backup_role <subnet> scram-sha-256`；**不会、也不能触碰任何
   已经初始化过的活库**——那正是下面 5.2 描述的、仍待人工执行的部分。
5. `infra/production-like/alerts/check-wal-archive.sh`：四判据（归档容量/
   `pg_stat_archiver` 健康/基准备份新鲜度/`pg_wal` 体积），接入 `run-all.sh`
   （四条判据）与 `drill.sh`（四个新 keyword-flip 场景）。详见下方 5.3。

**关键语义**（供复核/验收核对，四条都不是"自解释"的行为，容易被误判成 bug）：

- **`SKIPPED_RECENT`**：最新一份 `VERIFIED` 的 `verified_epoch` 距今 <
  `X8_BASE_BACKUP_MIN_INTERVAL_SECONDS`（默认 72000s）→ 跳过本次物理备份。**这是
  健康态，不是失败**——`x8-base-backup-last-success` 标记照样被 touch，因为"已经有
  一份足够新的 VERIFIED 备份"这件事本身就是这个标记想证明的事情。
- **`DISABLED`**：`X8_BACKUP_PHYSICAL_ENABLED=false` → 物理备份/校验两步都不跑。
  **`x8-base-backup-last-success` 不会被 touch**——这是操作员主动关闭，标记不应该
  假装"健康"，否则告警链会被这个标记永久性地捂住。
- **`archive_not_writable` 只门 `--apply`**：dry-run 从不写归档，所以
  `wal_archive:/var/lib/postgresql/wal-archive:ro` 这个只读挂载不会挡住每日的
  `wal-gc-x8.sh --json` dry-run 循环；只有人工授权的真实 `--apply`（见第 5 节，
  且从不在 `backup-timer.sh` 里）才需要归档可写。
- **验收默认不产 B3**：Owner 已拍板，Gate 5 验收要验的是"最近已有一份足够新的
  `VERIFIED`（不管是不是本单常说的 B2）→ timer 正确判定 `SKIPPED_RECENT`"，不是
  每次验收都真去跑一次物理基准备份。`SKIPPED_RECENT` 因此是一等公民，有专门的
  行为测试覆盖（`tests/backend/database/backup-timer-static.test.ts`：四个场景之一
  就是"10 分钟前的 VERIFIED → SKIPPED_RECENT，physical/verify 两个 shim 都不被调用，
  两个成功标记都被 touch"）。

**5.2 跨容器 `pg_hba` 授权 —— 仅当 5-Dev 交付第 2 条的循环需要 `backup-timer` 容器本身发起跨容器复制连接时才需要，仍待 5-Ops 在活栈手工执行**

`base-backup-now`/`wal-gc` 这两个已实现的操作员命令走的是"容器内 `docker exec` + 本地 socket"，**从不需要改 `pg_hba`**（本地 socket 命中的是 `local ... trust` 这一行，已用 `docker exec ... grep -v '^\s*#\|^\s*$' pg_hba.conf` 核对过当前活栈就是这样配的）。只有当 5-Dev 交付清单第 2 条的循环选择让 `backup-timer` 容器**自己**发起 `pg_basebackup --wal-method=stream`（PGHOST=postgres，走 docker 网络 TCP，而不是 `docker exec` 进 postgres 容器）时，才会命中 `host all all all scram-sha-256` 这条泛匹配规则之外、专属 replication 类连接的空白——当前 `pg_hba.conf` 只有 `host replication all 127.0.0.1/32 trust` 与 `::1/128`（回环），docker 网络内的跨容器连接两者都不匹配。

**PostgreSQL 协议层面的事实**（与本项目的部署机制无关）：`hba_file` 显示为 `/var/lib/postgresql/data/pg_hba.conf`，**在 `postgres_data` 这个数据卷内，不是 bind mount**。按 PostgreSQL 官方文档，`pg_hba.conf` 的改动**只需要 `SELECT pg_reload_conf()`（或 `SIGHUP`）即可生效，不需要重启进程，更不需要容器 recreate**——这是 PostgreSQL 协议本身的行为，不依赖本项目怎么部署它。方案 v2 文档 §2.6 里"这是 postgres 的配置变更，需要容器重建才能生效"这句话，写的是**另一件事**：如果要让这条 `pg_hba` 追加规则在**未来每一次容器重启**后都持续存在（即让它成为 `postgres-entrypoint.sh` 或某个初始化脚本的一部分、写进版本控制），那才需要改一个被 bind mount 的脚本文件并让它在下次容器启动时执行——但那是"让改动持久化/可重现"的工程需求，不是"这条 `pg_hba` 规则本身要生效"的必要条件。两件事不要混为一谈。

```bash
# 只在选择"backup-timer 容器自己发起跨容器复制"这条路径时才执行以下步骤：

# 1) 取 runtime 网络子网
docker network inspect cps_novel_x8_runtime --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
# 当前取证值：172.18.0.0/16（每次实际执行前重新取一遍，网络可能已重建）

# 2) 直接在运行中的容器里、对数据卷内的文件做一次性追加（不是 bind mount 改动，不需要 recreate）
docker exec cps-novel-x8-local-postgres-1 sh -c \
  "grep -qxF 'host replication backup_role 172.18.0.0/16 scram-sha-256' /var/lib/postgresql/data/pg_hba.conf \
   || echo 'host replication backup_role 172.18.0.0/16 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"

# 3) 让 PostgreSQL 重新读取（协议层面的标准做法，不是重启）
docker exec -u postgres cps-novel-x8-local-postgres-1 psql -d cps_novel -tAc "SELECT pg_reload_conf();"

# 4) 核验：规则被解析、无 error；backup_role 能走 replication，web_app/worker_app 不能
docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;"   # 期望 0
docker exec cps-novel-x8-local-postgres-1 psql -U postgres -d cps_novel -tAc \
  "SELECT line_number, type, database, user_name, auth_method FROM pg_hba_file_rules WHERE 'replication' = ANY(database);"

# 5) 若要让这条规则在下次容器重启后依然存在（工程化、而非"是否生效"的需求），
#    把同一行追加逻辑写进 infra/production-like/postgres-entrypoint.sh（幂等 grep -qxF 判断，
#    与本 Gate 上面手工做的是同一操作，只是搬进了受版本控制、每次容器启动都会跑一次的脚本），
#    这才需要 Gate 2 同款的 postgres recreate 去让新脚本内容生效——但这是"持久化"这一步单独
#    需要 recreate，不是"pg_hba 本身要生效"需要 recreate。
```

**5.3 告警新判据 —— 已实现（5-Dev 交付第 5 条）**

`infra/production-like/alerts/check-wal-archive.sh` 已交付，沿用
`check-backup-freshness.sh` 同款结构（`source alert-lib.sh`，
`fail_closed_run`/`alert_fire`/`alert_recover`，standalone-execution guard），
覆盖四件事：

1. 归档目录容量（`OK`/`WARN`/`DEGRADED`/`OVER`，与 `wal-retention.sh --max-bytes`
   同一套阈值，默认 20 GiB/70%/85%/100%）——`wal_archive_capacity_warn|degraded|over`，
   读不到（`docker exec du` 失败或输出不可解析）→ `wal_archive_capacity_unreadable`。
2. `pg_stat_archiver` 健康——`last_failed_time IS NOT NULL AND (last_archived_time
   IS NULL OR last_failed_time > last_archived_time)`，与 `wal-retention.sh
   --require-archiver-healthy` 同一条 SQL 谓词、逐字复制，不是另发明一套
   （`wal_archiver_failing`；`ALERT_DATABASE_URL` 未配置或 psql 探测失败 →
   `wal_archiver_unreadable`）。
3. 物理基准备份新鲜度——**独立于**现有 26 小时逻辑备份标记判据（判据③读的是容器内
   `/tmp/x8-backup-last-success`；这一条读的是宿主机上 `ALERT_BASE_BACKUP_DIR`
   （默认解析为 `<repo root>/.tmp/x8-production-like/base-backups`）下最新一份
   `VERIFIED` 的 `verified_epoch`，不依赖 docker）——`base_backup_stale`（默认阈值
   同为 93600s=26h）/`base_backup_missing`。
4. `pg_wal` 目录体积 > `ALERT_PG_WAL_MAX_BYTES`（默认 2 GiB）——`pg_wal_bloat`，读不到
   → `pg_wal_unreadable`。

已接入 `infra/production-like/alerts/run-all.sh`（四条判据串行、`||` 守卫、互不影响）
与 `drill.sh`（四个新 keyword-flip 场景 F/G/H/I）。**注意一处与原计划的偏差**：判据①
和④都要靠 `docker exec <容器> du -sb <路径>` 拿到一个可控的字节数才能真正触发阈值，
但本单的红线禁止对活栈 `cps-novel-x8-local-*` 做任何 `docker exec`（只允许只读
`docker inspect`）——`drill.sh` 的这两个场景因此改用一个完全本地、一次性生成并用完
即删的假 `docker` 可执行文件（塞进临时 `PATH`），从不连接真实 docker daemon 或
真实容器，行为上比依赖某个真实容器当天的实际磁盘占用更确定。单测
（`tests/backend/alerts/check-wal-archive.test.ts`）用同样手法覆盖了四判据各一个
触发场景 + 一个健康场景 + 三个 fail-closed（`_unreadable`）场景，外加一个"全部健康
时 `run_wal_archive_checks()` 零告警"的聚合用例。

**这一条必须在首次启用清理（第一次真实 `--apply`）之前就接好**——理由见风险 6：锚定式保留有一个静默失效方向（没人按时做基准备份，锚点再也不前进），没有新鲜度告警，这个方向没有任何东西能捞回来。**5-Dev 已满足这个前置条件**（代码已实现且有测试覆盖）；仍待 5-Ops 在活栈上实际接线验证。

**PASS 条件**
- `backup-timer.sh` 扩成四步后连续跑满至少一个 `X8_BACKUP_INTERVAL_SECONDS` 周期（默认 86400s），四步均成功；根据 `X8_BASE_BACKUP_MIN_INTERVAL_SECONDS` 的判定，`VERIFIED` 新增或正确 `SKIPPED_RECENT`（验收默认走 `SKIPPED_RECENT` 路径，见上）。
- 若选择了 5.2 的跨容器路径：`pg_hba_file_rules` 显示新规则、无 error；`backup_role` 可复制连接、`web_app`/`worker_app` 不可（用一次性 `psql "host=postgres user=web_app replication=database" ...` 之类的探测确认被拒绝）。
- `check-wal-archive.sh` 四项判据均有对应 `drill.sh` 场景且断言 `alert_fire` 被调用；接入 `run-all.sh` 后 `alert_fire_total` 在正常场景下为 0。**5-Dev 已用单测+drill.sh 验证过这一条**；5-Ops 需要在真实活栈上再跑一遍 `drill.sh` 确认结论不变。

**FAIL 停止条件与回退**
- 四步循环任一步失败：`backup-timer` 容器的 `test -f /tmp/x8-backup-last-success` 健康检查会失败，触发既有 `check-backup-freshness.sh`——这本身就是设计好的失败可见性，不需要额外回退动作，但要排查后再继续。
- `pg_hba` 新规则解析出 error：`pg_reload_conf()` 不会应用一个语法错误的配置（PostgreSQL 会保留旧配置生效、只在日志里报错），核对 `pg_hba_file_rules.error` 列定位具体哪一行错了，修正后重新 `pg_reload_conf()`，不需要 recreate。

---

## 5. 首次真实删除 Owner Gate

**触发条件**：B1、B2 均 `VERIFIED`，且 Gate 4（正向 + 负向）PASS。在此之前，任何 `wal-gc --apply` 都不得执行——即使 `wal-gc`（dry-run）已经打印出一个看起来合理的删除计划。

**执行前报告模板**（提交给 Owner，等明确批准后才能加 `--apply`）：

```text
WAL_RETENTION_APPLY_REQUEST
运行时间（UTC）：
操作者：
保留的基准备份：
  B1: backup time=... timeline=... start_wal=... VERIFIED(verified_epoch=...)
  B2: backup time=... timeline=... start_wal=... VERIFIED(verified_epoch=...)
归档器健康：pg_stat_archiver.failed_count=... last_failed_time=... last_archived_time=...
dry-run 计划（wal-gc --json 的原样输出，不摘要、不改写）：
  删除段数：
  删除字节数：
  最老将被删除段：
  删后最老保留段：
  是否涉及 .history / .backup 文件：
  是否有 gap（当前删除计划与上一次删除计划之间，归档目录是否有连续性缺口）：
Docker VM 容量（容器内 df，不是宿主机 df）：
  总量 / 已用 / 可用：
```

无 Owner 明确批准（书面，不接受"看起来没问题就先删了"），禁止执行 `--apply`。

---

## 6. 38 GB 历史归档处理规则

- **禁止按日期删**：任何形如"删除 X 天前的文件"的规则一律不采用（原则一，方案 §2.1）——日历规则不知道恢复链在哪里断。
- **禁止 `rm -rf`**：无论是对归档目录还是对基准备份目录，本方案全程只通过 `pg_archivecleanup`（WAL 段）与标记后的目录删除（`RETIRED` 后 `rm -rf` 单个已知目录，不是通配符）来清理，运维手册的红线是"保留策略禁止使用宽泛递归删除"。
- **禁止"反正这些历史 WAL 也没人会用到，直接删了省事"这类判断**：这正是上次"按日期删"事故的思路，唯一的区别是这次听起来更有道理——判断"有没有用"的唯一合法依据是"是否在某份 `VERIFIED` 基准备份的有效恢复链锚点之前"，不是主观判断。
- **禁止在 B1 阶段（只有一份 `VERIFIED` 备份）传 `--keep-base 1` 去清理这 38 GiB**：Gate 3 的 PASS 条件明确要求此时 `wal-gc` 必须是 `NOOP reason=insufficient_verified_backups`——这是正确的冷启动状态。方案 v2 §6 提到"冷启动阶段的例外：只有一份合格备份时，允许一个明确记录的 N=1 初始化阶段处理历史无锚归档"，但那是一个**独立于 Gate 3 之外、需要 Owner 单独书面授权**的一次性动作，且必须同时满足该节列出的两条约束——不得声称此时已具备 24–48 小时回溯窗口（只有一份备份，回溯窗口约等于零）；也不得为了凑 N=2 就连着立刻做两份（时间间隔太短，起不到多一份档案的实际作用）。**默认路径是让 N=2 按每日节奏自然积累，等 B2 产生、Gate 4 验完恢复链之后，这 38 GiB 里"早于 B2 锚点"的部分会被同一套 dry-run → Owner → apply 流程自然纳入第一次真实清理**，不需要一个提前的、单独的 N=1 动作。若 Owner 仍然要求提前处理（例如磁盘压力已经到了 L2/L3 档位），必须走第 5 节的完整报告模板，且报告里必须显式写明"这是 N=1 初始化阶段，回溯窗口约为零，不是常态"。
- **禁止用 `--force` 绕过链完整性守卫**：`--force` 只影响 `delete_surge_guard`（本次删除量 > 上次 × 10 时的熔断），代码与单测都已确认它**不**绕过 `anchor_not_in_archive`/`archiver_failing`/`verified_malformed`/`plan_failed`/`timeline_unsupported` 等其它任何一个拒绝分支（第 2 节"写作时另一 agent 正在追加的改动"里新增的测试专门覆盖了这一点）。历史归档体积大、`--force` 熔断更容易被触发，但触发本身是信号不是障碍——按第 5 节的报告模板走人工复核，不要把 `--force` 当成"删得太多所以加个参数让它别管"的开关。
- **只走 dry-run → Owner → apply**：即 Gate 5 里"清理 dry-run 进日常 timer 循环、`--apply` 永远是一次单独的、有报告、有批准的人工动作"这一整套流程，没有例外通道。

---

## 7. 归档迁宿主绑定

归档目录当前是具名卷 `cps_novel_x8_wal_archive`，与 `postgres_data` 共享同一个 Docker VM 磁盘（见风险 11）。迁移到独立的宿主绑定目录是**独立的后续 Gate（暂记为 Gate 6）**，不在本轮 Gate 1～5 范围内，理由：这不是"一行 compose 改动"，而是一次需要校验、需要回退路径的真正迁移，仓促做会制造新的单点故障。

**顺序（每一步都要能独立验证，不能整体一把梭）**：

1. **复制**：一次性容器把具名卷 `cps_novel_x8_wal_archive` 完整只读复制到宿主绑定目录（与 Gate 4 用过的手法一样：`-v cps_novel_x8_wal_archive:/src:ro` + 宿主目标目录），全程不碰原卷。
2. **校验**：逐文件 `sha256sum` 比对复制前后，段数、总字节数、最新/最老段名三项与原卷核对一致。
3. **切换**：改 `infra/production-like/docker-compose.yml` 把 `wal_archive:/var/lib/postgresql/wal-archive` 换成宿主绑定路径，`postgres` 容器 recreate（`--no-deps`，与 Gate 2 同款流程，含同一个 worktree-binding guard 检查）。
4. **验证归档继续推进**：recreate 后观察 `pg_stat_archiver.last_archived_wal` 在新挂载点下是否继续前进、`failed_count` 是否保持 0——这是最容易被忽视但最重要的一步，"挂载点切换成功"不等于"归档器认得新路径下已有的文件、还能继续往后写"。
5. **恢复测试**：至少用一份 `VERIFIED` 基准备份 + 新挂载点做一次 Gate 4 同款的正向恢复演练，确认迁移后的归档目录仍然是一条完整可用的链，不是只是"文件都在但没人验证过能不能用"。
6. **旧副本处置**：确认 4、5 两步都通过之后，原具名卷的旧内容才能考虑清理——处置方式仍然遵循第 6 节的规则（不是"迁移完了旧的就可以随便删"），且这本身是另一次需要 Owner 批准的删除动作。

**明确不承诺的事**：迁移到宿主绑定目录**不会**让"归档写满拖垮数据库"这个风险消失——它只是把归档从"与 `postgres_data` 共享同一块 Docker VM 虚拟盘"变成"独立的文件系统/挂载点"，缓解的是"两者互相挤占同一块盘"这个具体形状；如果宿主本身的磁盘（不再是 Docker VM 内部划分，而是宿主机真实磁盘）被写满，PGDATA 依然会受影响，只是影响路径变了，不是消失了。这也是为什么第 7 节被称为"缓解"而不是"解决"——真正解决靠的是 Gate 5 的容量告警 + 保留策略本身，不是挂载点搬家。

---

## 8. 部署状态取证规范

任何"WAL 相关改动已上线/已生效"的结论，必须同时给出以下八项，缺一不算证据：

1. `container_id`（`docker inspect ... --format '{{.Id}}'`，短 id 也行但要能反查）
2. `image`（digest，不是 tag——tag 可以被复用指向不同 digest）
3. `StartedAt`
4. `RestartCount`
5. `health status`
6. `mounts`（完整 `docker inspect ... --format '{{range .Mounts}}...{{end}}'`，尤其是每个 bind mount 的 `Source` 路径——第 1.2 节已经证明"六容器都 healthy"完全掩盖了"整个栈其实是从另一个 worktree 起的"这个事实）
7. `archive-wal.sh` 哈希（`docker exec postgres sha256sum /app/scripts/db/archive-wal.sh`，与目标 commit 的 `git show <sha>:scripts/db/archive-wal.sh | shasum -a 256` 比对）
8. `HEAD`（发起 recreate 的 worktree 当时的 `git rev-parse HEAD`）

**"六个容器 healthy" 不构成证据**——本文档写作过程中的真实案例：写作时活栈六容器全部 `healthy`、`RestartCount=0`，但归档目录挂的仍是 `integration-night` 分支上未修复的旧版 `archive-wal.sh`（哈希 `440f830c...`，第 1.3 节），`base-backups` 挂载点当时也完全不存在。健康检查测的是"进程在跑、端口有响应"，不测"跑的是不是我以为的那份代码"。

---

## 9. 冻结边界

以下明确排除在本轮范围之外，任何 Gate 都不得触碰：

- **95,860 条 `pending` 冻结任务**：不恢复、不删除、不重新挂起、不改动 `disabled` 父任务状态、不压测。这是另一个独立问题（`project_novel_frozen_task_backlog`），与 WAL 保留策略无关。
- **worker 领取查询修复本身**：已经是独立上线的既成事实（镜像 `cps-novel:0.1.0-da59d13`，含 commit `2705b4d`），本文档只消费"worker 已经停止异常写 WAL"这个前提，不重新验证或改动 worker 代码。
- **短剧 VPS / PulseDrama / NibbleDrama / 其它项目**：本文档全部命令的作用域严格限定在 `cps-novel-x8-local-*`/`cps_novel_x8_*` 这一套容器与资源命名空间内，不涉及任何其它项目的基础设施。
- **未来真实生产环境**：本文档描述的是 X8 本地生产like环境（127.0.0.1-only）的上线路径，不是生产 VPS 的部署方案——生产参数见方案 v2 §2.4，本文档不代为拍板。

---

## 10. 停止条件

本轮工作到 **`READY_FOR_CODEX_RELEASE_GATE`** 为止。之后的每一步都需要人工触发：

1. **第一项需要 Owner 批准的真实操作** = **Gate 2 的 `postgres` recreate**（第 4 节）——这是本文档描述的所有操作里，第一个会对活栈做出实际改动的写操作。在此之前的一切（第 1 节的取证、Gate 1 的合并准备）都只读或只发生在 Codex 的合并流程里，不触碰任何正在跑的容器。
2. Gate 2 之后每一个 Gate 都是前一个的硬前置（Gate N 未 PASS 禁止进入 Gate N+1），第 5 节"首次真实删除"是整条链路里第二个需要 Owner 单独书面批准的动作（第一个是 Gate 4 里的 `pg_create_restore_point`）。
3. 本文档本身不触发、不安排、不倒计时任何一个 Gate 的执行——这些都是后续会话/后续 Owner 决策的事。
