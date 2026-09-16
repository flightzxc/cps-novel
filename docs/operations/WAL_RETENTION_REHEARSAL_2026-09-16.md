# WAL 保留策略验收演练报告（2026-09-16）

## 结论

- **REHEARSAL_RESULT=PASS**（修复版脚本、轮 B）。
- 轮 A（旧版 `archive-wal.sh` 白名单，作为对照组）在 Step 0/2/4/5A/5B/6A 正例六处按预期 **FAIL**，实证了"归档器卡死"这个缺陷本身真实存在、且会级联破坏后续所有基于归档的能力（校验之外的一切）。
- 轮 B（本次修复版 `archive-wal.sh` + 新增 `verify-physical-base.sh` + `wal-retention.sh`）**23/23 个断言全部 PASS**（`evidence-roundB-final/`，2026-09-16 13:12–13:13 UTC；逐条数 `progress.log` 该轮 STEP0…STEP8 的断言行，STEP0 起算至 STEP8 止共 23 行，此前"22/22"的表述有误，本次一并订正），含两处"必须真失败"的负例（Step 6A 负例、Step 6B）——均以真实 `pg_ctl`/PostgreSQL 日志中的 `FATAL` 报错收尾，不是靠退出码猜的。v2 修复轮（本次，见文末新增一节）额外跑出 30/30 PASS，含新增的 Step4N。
- 全程在一次性 Docker 容器里跑通，未触碰本机 `cps-novel-x8-local-*` 六容器；rig 自身资源（`wal-retention-rig-pg` 容器 + `wal-retention-rig-data` 卷）两轮均在脚本 `trap` 里按精确名字拆除干净。

## 环境与身份

| 项目 | 值 |
|---|---|
| worktree | `/Users/chenweifeng/Documents/cps海阅/wal-retention-rehearsal` |
| 分支 | `feature/wal-retention-rehearsal` |
| Commit 1（白名单修复 + 测试） | `077da0a` fix(db): allow pg_basebackup .backup and timeline .history in archive_command |
| Commit 2（verify-physical-base.sh + wal-retention.sh） | `97ab212` feat(db): add physical base backup verifier and WAL retention tool |
| Commit 3（本报告 + 演练脚本） | 与本文件同一次提交，见 `git log` |
| 镜像 | `postgres:16.14`，`sha256:02ad0fee02aedf51870d43f109a106a7a8f36930ce9b467ee755254470f227d8`（本机已有，`--pull never`） |
| PostgreSQL 版本 | 16.14 (Debian 16.14-1.pgdg13+1) aarch64 |
| 演练脚本 | `scripts/db/wal-retention-rehearsal.sh`（无参数 = 轮 B；`--archive-script <旧版路径>` = 轮 A） |
| 轮 A 使用的旧版 archive-wal.sh | `git show integration/2026-09-16-night:scripts/db/archive-wal.sh`（与 Commit 1 之前的基线逐字节一致，已用 `diff` 核对） |
| 演练日期 | 2026-09-16（UTC 时间戳见下方日志原文） |

演练脚本本身的安全约束：所有 docker 资源前缀 `wal-retention-rig-`；容器一律 `--network none`；镜像 `--pull never`；EXIT trap 按精确名字 `docker rm -f`/`docker volume rm`；所有等待循环基于 `$SECONDS` 计时，macOS 无 `timeout` 命令。

任务前后 `cps-novel-x8-*` 容器计数：**演练前 6，演练后 6**（两轮均验证，详见"资源清单"一节）。

## 两轮 STEP 矩阵

图例：PASS=通过；FAIL=未通过；SKIP=因前置步骤物理阻塞而未执行。

| Step | 断言 | 轮 A（旧脚本）实际值 | 轮 A 结果 | 轮 B（修复脚本）实际值 | 轮 B 结果 |
|---|---|---|---|---|---|
| STEP0 | 5 个合法 WAL 文件名返回 0 且落地，3 个非法文件名返回 65 | `.backup`/`.history` 两个合法用例返回 65（LEGAL_BAD） | **FAIL** | 5 legal 全 0、3 illegal 全 65 | **PASS** |
| STEP1 | rig 用 `pg_isready` 可达 | 可达 | PASS | 可达 | PASS |
| STEP2 | B1 备份后 10s，`pg_stat_archiver.failed_count=0` | `failed_count=6`，`last_failed_wal=000000010000000000000006.00000028.backup` | **FAIL** | `failed_count=0` | PASS |
| STEP2_WAIT_ARCHIVE | 120s 内 `last_archived_wal` 追到 RP_M3 对应 segment | 超时，卡在 `000000010000000000000006` 不再前进 | **FAIL** | 追到 `000000010000000000000011` | PASS |
| STEP3（B1/B2/B3） | 真实 `verify-physical-base.sh` 三份都 PASS | 3/3 PASS（校验本身不依赖归档队列，独立于上面的缺陷） | PASS | 3/3 PASS | PASS |
| STEP4_DRYRUN_SET | dry-run 淘汰集合=B1，保留集合=B2,B3 | 淘汰 B1、保留 B2,B3（`planned_delete=6`，因为归档目录里只有卡死前落进去的 6 个文件） | PASS | 淘汰 B1、保留 B2,B3（`planned_delete=10`） | PASS |
| STEP4_DRYRUN_ANCHOR | anchor == B2 的 VERIFIED.start_wal | 一致 | PASS | 一致 | PASS |
| STEP4_APPLY_BASE_DIRS | apply 后 `/rig/base` 只剩 B2,B3 | 只剩 B2,B3 | PASS | 只剩 B2,B3 | PASS |
| STEP4_APPLY_DELETED | apply 实际删除数 >0 | 删除 6 | PASS | 删除 10 | PASS |
| STEP4_CONTINUITY_MIN | 保留归档中最小 24 位十六进制文件名 == anchor | **归档目录清空后为空**（`ls /rig/archive` 只剩 3 个 `.backup`，无任何 24 位段） | **FAIL** | 与 anchor 一致（`00000001000000000000000B`） | PASS |
| STEP4_BACKUP_LEFTOVER | 记录残留 `.backup` 数（预期可能残留，不算 FAIL） | 0（因为归档器从未成功归档过任何 `.backup`，压根没进archive目录） | PASS（信息性） | 3 | PASS（信息性） |
| STEP4_IDEMPOTENT | 二次 dry-run `planned_delete=0` | 0 | PASS | 0 | PASS |
| STEP5A | 恢复 B2→RP_M3 应显示 M0,M1,M2,M3 | `pg_ctl -w` 180s 内未脱离启动（`FATAL: recovery ended before configured recovery target was reached`） | **FAIL** | `M0,M1,M2,M3` | PASS |
| STEP7 | restore-a 自身 archive_command 归档 `00000002.history` 成功 | 因 5A 未 promote，跳过 | SKIP | `00000002.history` 落地，`failed_count=0` | PASS |
| STEP5B | 恢复 B2→RP_M2 应显示 M0,M1,M2（不含 M3） | 同 5A，FATAL 同错 | **FAIL** | `M0,M1,M2` | PASS |
| STEP6A_POSITIVE | 恢复 B2→RP_M3、不带自带 WAL、走真实 `/rig/archive` 应成功 | FATAL 同错（归档目录本就不完整） | **FAIL** | 成功 promote 到 RP_M3 | PASS |
| STEP6A_NEGATIVE | 同上但 archive-mutant-a 缺 ANCHOR 段，必须失败 | 失败（`could not locate required checkpoint record`） | PASS（但此处"失败"的根因和 6A_POSITIVE 是同一个，不是本用例设计要验证的那个缺口，见下方讨论） | 失败（同一报错） | PASS |
| STEP6B_PRECONDITION | victim(RP_M3) 段名 严格大于 B2 End-LSN 段名 | `0x11 > 0x0B` 成立 | PASS | `0x11 > 0x0B` 成立 | PASS |
| STEP6B | 恢复 B2（带自带 WAL）→RP_M3、archive-mutant 缺 victim 段，必须失败 | 失败（`recovery ended before configured recovery target was reached`，但根因仍是归档器早已卡死，victim 段本来就没进过档） | PASS（同上，非本用例设计要验证的缺口） | 失败（`FATAL: recovery ended before configured recovery target was reached`，且日志显示恰好卡在人为删除的 victim 段） | **PASS（真正 load-bearing 的负例）** |
| STEP8 | 拆除前把关键日志复制到 evidence 目录 | 完成 | PASS | 完成 | PASS |
| **总体** | | | **WAL_RETENTION_REHEARSAL=FAIL**（预期内，证明缺陷） | | **WAL_RETENTION_REHEARSAL=PASS** |

轮 A 的 6A_NEGATIVE / 6B 两行标 PASS，但不能读成"旧脚本下负例也验证通过"——轮 A 里从 STEP2 开始归档器就已经永久卡死，B2 之后的任何 WAL 从未被真正归档过，所以 6A_POSITIVE 本身就已经 FAIL 了；6A_NEGATIVE / 6B 的"失败"只是同一个上游缺陷的重复表现，不是这两个用例本来要证明的"精确移除某一段会导致精确失败"。这两个用例真正有意义的验证只发生在轮 B（正例先成功，再证明移除特定文件会精确地把它打破）。

## 关键原始输出摘录

### Step 2：`pg_stat_archiver` 两轮对比（B1 备份后 10s）

轮 A（旧脚本）：
```
failed_count=6  last_failed_wal=000000010000000000000006.00000028.backup
```
轮 B（修复脚本）：
```
failed_count=0  last_failed_wal=(空)
```

轮 A 演练结束时（Step 8）的最终 `pg_stat_archiver` 快照，可见归档器在演练全程里对同一个文件重试了 30 次：
```
archived_count=6 | last_archived_wal=000000010000000000000006 | failed_count=30 | last_failed_wal=000000010000000000000006.00000028.backup
```
对照轮 B 的最终快照（`archived_count=20`，含 Step 7 触发的 `00000002.history`，`failed_count=0`）：
```
archived_count=20 | last_archived_wal=000000010000000000000011 | failed_count=0
```

### Step 4：dry-run / apply / 幂等三次输出（轮 B）

```
# dry-run
WAL_RETENTION_RETIRE_BASE=B1
WAL_RETENTION_KEEP_BASE=B2 reason=recent_1_of_2
WAL_RETENTION_KEEP_BASE=B3 reason=recent_2_of_2
WAL_RETENTION_DELETE=/rig/archive/000000010000000000000007
... (共 10 行 DELETE)
WAL_RETENTION_CAPACITY=OK bytes=285213689 max=1073741824
WAL_RETENTION_SUMMARY_JSON={"keepCount":2,"retireList":["B1"],"deleteCount":10,"anchor":"00000001000000000000000B","capacity":{"status":"OK","bytes":285213689,"max":1073741824}}
WAL_RETENTION=DRY_RUN planned_delete=10

# apply（同一批 RETIRE/KEEP/DELETE 计划行之后，真实 pg_archivecleanup -d 的逐行日志）
pg_archivecleanup: keeping WAL file "/rig/archive/00000001000000000000000B" and later
pg_archivecleanup: removing file "/rig/archive/000000010000000000000007"
... (共 10 行 removing)
WAL_RETENTION=APPLIED deleted=10 anchor=00000001000000000000000B

# 幂等重跑（不带 --apply）
WAL_RETENTION_KEEP_BASE=B2 reason=recent_1_of_2
WAL_RETENTION_KEEP_BASE=B3 reason=recent_2_of_2
WAL_RETENTION=DRY_RUN planned_delete=0
```

轮 A 的同一组命令因为归档目录里从一开始就只有 6 个文件（卡死前落地的普通段），`planned_delete=6`，apply 后 `/rig/archive` 里 24 位十六进制段清零。更值得记录的是：由于归档器卡在 B1 的第一个 `.backup` 文件上，B1/B2/B3 各自的 `.backup` 历史文件全部卡在归档队列里、从未真正落地到 `/rig/archive`，所以 apply 之后 `/rig/archive` 目录是**完全空的**（`ls -la` 只剩 `.`/`..`，连一个 `.backup` 残留都没有）。这是本轮暴露出的一个额外事实：旧脚本的缺陷不仅让 PITR 断链，连"退休前 3 份 base backup 唯一还留着的一点点 WAL"也会被保留工具正确但残酷地清空——保留工具本身没有 bug，它只是诚实地反映了上游归档早已空了这个事实。

### Step 5A / 5B / 6A / 6B 的 marker 结果与日志尾行（轮 B）

- 5A（B2→RP_M3，带自带 WAL，走 `/rig/archive`）：`marker` 表 `string_agg` = `M0,M1,M2,M3`，四条全在。
- 5B（B2→RP_M2，带自带 WAL）：`marker` 表 = `M0,M1,M2`，**不含 M3**，符合"时点早于 M3 插入"的预期。
- 6A 正例（B2→RP_M3，**不带**自带 WAL，纯走 `/rig/archive`）：成功 promote，证明归档目录本身从 ANCHOR 往后是自足的。
- 6A 负例（同上，但 `archive-mutant-a` 缺失 ANCHOR 段 `00000001000000000000000B`）真实日志尾行，出自 `evidence-roundB-final/step6a-negative-log-tail.txt`（2026-09-16 13:13 UTC；此前版本误引了一份 13:06 的草稿运行日志，已订正为该轮 authoritative 证据）：
  ```
  cp: cannot stat '/rig/archive-mutant-a/00000001000000000000000B': No such file or directory
  2026-09-16 13:13:22.201 UTC [1047] LOG:  invalid checkpoint record
  2026-09-16 13:13:22.201 UTC [1047] FATAL:  could not locate required checkpoint record
  ```
- 6B（B2→RP_M3，带自带 WAL，`archive-mutant` 缺失 victim 段 `000000010000000000000011` = `pg_walfile_name(RP_M3)`）真实日志尾行，出自 `evidence-roundB-final/step6b-restore-d-log-tail.txt`（同一轮，2026-09-16 13:13 UTC，同上订正）：
  ```
  ... 2026-09-16 13:13:26.181 UTC [1117] LOG:  consistent recovery state reached at 0/B03BC20
  2026-09-16 13:13:26.181 UTC [1114] LOG:  database system is ready to accept read-only connections
  ... restored log file "000000010000000000000010" from archive
  cp: cannot stat '/rig/archive-mutant/000000010000000000000011': No such file or directory
  cp: cannot stat '/rig/archive-mutant/000000010000000000000011': No such file or directory
  2026-09-16 13:13:26.295 UTC [1117] LOG:  redo done at 0/100001E8 ...
  2026-09-16 13:13:26.295 UTC [1117] FATAL:  recovery ended before configured recovery target was reached
  2026-09-16 13:13:26.298 UTC [1114] LOG:  database system is shut down
  ```
  这里 `pg_ctl start` 的退出码是 **0**——不是误判，而是 `pg_ctl -w` 在达到"一致恢复点、可接受只读查询"时就返回成功了，真正的失败发生在几十毫秒后异步的 startup process 尝试取 victim 段时；演练脚本据此判 PASS 的依据是 `pg_ctl status` 之后确认"no server running" **且** 日志里出现了上述 `FATAL` 行，而不是单看退出码。

### Step 7：`00000002.history` 归档结果

轮 B：`restore-a` 促升后触发 `pg_switch_wal()`，10s 后：
```
$ ls /rig/archive-tl
00000002.history
tl_history_present=yes tl_failed=0
```
轮 A：5A 从未 promote，Step 7 记为 SKIP（物理上无法执行——没有一个促升成功的实例可以触发这次归档）。

## 与预期不符之处

1. **`.backup` 文件在 `pg_archivecleanup -n` 输出里是完整路径而非裸文件名**（如 `/rig/archive/000000010000000000000007`），不是原计划设想的裸文件名。`wal-retention.sh` 对此没有任何隐含假设（只是原样转发 `pg_archivecleanup` 自己的输出并原样传给后续的 `-d` 调用），不影响功能正确性，只是评审时如果对照原计划文档的裸文件名示例会有出入，特此记录。
2. **`pg_ctl -w` 在到达"一致恢复点"时就返回 0**，即便最终会在到达 `recovery_target_name` 之前失败——这个行为本身是 PostgreSQL 的正常设计（只读连接在一致点之后即可用），但意味着脚本不能只看 `pg_ctl` 退出码判断 6A 负例/6B 是否真的失败，必须结合 `pg_ctl status` 与日志 `FATAL` 行；演练脚本已在 Step 6A 负例/6B 里加了 3 秒结算延迟再抓日志快照，否则会抓到一份"看起来还没失败"的过早快照（本报告草稿阶段真实踩到过这个坑，已修正）。
3. 轮 A 下 `STEP4_CONTINUITY_MIN` 的"预期值"本身不是一个能提前枚举好的具体值——因为归档目录会因为归档器卡死而完全清空，实际观测到的是空字符串而不是某个具体的 24 位段名,已在断言里如实记录为 FAIL（预期内，不是脚本 bug）。

## 未覆盖项（如实登记：演练本身没走到的分支）

以下按 `wal-retention.sh` 的拒绝/分支逐条登记：演练脚本（`wal-retention-rehearsal.sh`）本身是否执行过该分支，以及有没有其它证据形式补上。**"演练证据"特指本文件引用的、来自一次性 Docker rig 的 STEP 矩阵输出；不是演练证据的，一律如实标注来源，不得混同。**

- `LOCKED`（`.wal-retention.lock` 已存在）：演练本身未触发（演练每轮只跑一个 `wal-retention.sh` 进程，从不并发）。复核者手工验证过，非演练证据。P2-11（锁年龄提示）同样只经复核者手工验证。
- `NOOP reason=insufficient_verified_backups`：演练本身未触发（`--keep-base 2` 而演练一开始就有 B1/B2/B3 三份，从未低于门槛）。未见任何单测或手工验证覆盖，完全未验证。
- `stale_base_backup`：演练本身未触发（演练里 base backup 都是刚验证完就用）。复核者手工验证过，非演练证据。P2-8 把判据从 `verified_at`/`date -d` 改成 `verified_epoch` 后，这条复核结论未重新跑过，需要下一轮补验。
- `delete_surge_guard`：演练本身未触发（每轮只 apply 一次，没有"上一轮删得少、这一轮暴增"的历史状态）。复核者手工验证过，非演练证据。
- `archive_not_writable`：演练本身未触发（rig 内归档目录权限始终正常）。复核者手工验证过，非演练证据。
- `--force`（绕过 `delete_surge_guard`）：演练从未传这个参数。复核者手工验证过，非演练证据。
- `plan_failed`（P1-1，`pg_archivecleanup -n` 非零退出）：演练本身未构造这个场景。**本轮新增单测覆盖**：`tests/backend/database/wal-retention-apply-order.test.ts`（PATH shim 的 `-n` 返回非零，断言 `REFUSED reason=plan_failed` 且退出 65、目录/RETIRED 均未被触碰）。
- `anchor_not_in_archive`（P0-1，本轮修复的核心项）：**本轮新增双重覆盖**——单测（同一测试文件，锚点文件不落地）与演练新增的 Step4N（临时把真实 `$ANCHOR` 移出 `/rig/archive` 再 dry-run，断言 `REFUSED reason=anchor_not_in_archive` 且退出 65，之后移回）。
- `would_empty_archive`（P0-1）：本轮新增的单测三个场景都不构造"计划执行后归档清空"的情形，演练也没有专门构造；**完全未验证**，只有静态代码走查。
- `archiver_failing` / `archiver_unreadable`（P0-1，`--require-archiver-healthy`）：演练 Step4 的 dry-run 与 apply 都加了该开关并断言"健康路径不会被误拒"（rig 内 `pg_stat_archiver.failed_count=0`，走本地 socket）；但没有构造 `failed_count` 真实上升、或 `psql` 不可达/查询失败的负例——**两个拒绝分支本身会不会真的拒绝，仍未验证**，只验证了它不会误伤正常路径。
- `unexpected_directory`（P1-2）：无单测、演练也没有在 `base-backup-dir` 下放一个不认识的目录去触发它；完全未验证。
- `reconcile_mismatch`（P2-12，退出 62）：无单测、演练没有构造"`pg_archivecleanup -d` 之后文件仍在"的场景；完全未验证。
- `compressed_files_without_archive_ext` 告警（P2-13）：无单测、演练全程没有产生任何压缩 WAL；完全未验证。
- 容量档位转档（`OK`/`WARN`/`DEGRADED`/`OVER` 四档，P2-7）：演练全程归档目录很小，只报告过 `OK` 档（`WAL_RETENTION_CAPACITY=OK bytes=285213689 max=1073741824`），从未构造真实数据让它转到 `WARN`/`DEGRADED`/`OVER`。复核者曾对旧的三档版本手工验证过，非演练证据；四档新增的 `DEGRADED` 门槛本身未经任何验证。
- 压缩归档（`--archive-ext .gz` 路径）：脚本支持该参数，但本轮全程没有产生任何压缩 WAL，未实测。复核者手工验证过（旧版三档同一轮），非演练证据。
- 多时间线（`timeline_unsupported` 拒绝分支）：本轮只做了静态代码走查，未在演练里构造出一个真实的多 WAL-Ranges/非 1 号时间线场景去触发它（6A/6B 用的都是单一时间线 1 号）。完全未验证。
- apply 中途 kill（进程被杀在"已标记 RETIRED、还没删 WAL"或"已删 WAL、还没删目录"之间）：无单测、演练没有模拟；完全未验证。P1-3 的单测只验证了正常完整跑完时 RETIRED 先于目录删除这个**时序**，不等于验证了"中途真的被杀掉"后重跑是安全的。
- 告警脚本接线（`pg_stat_archiver.failed_count`/`last_failed_time` 超阈值告警）：未覆盖。
- `infra/production-like/backup-timer.sh` 与 `verify-physical-base.sh`/`wal-retention.sh` 的定时任务接线：未覆盖，两者目前都是独立可执行脚本，尚未接入任何 cron/timer——这也是为什么 `--require-archiver-healthy` 默认关：接线时的 timer/操作员必须显式打开它。
- `pg_hba.conf` 的生产化改造：本次沿用镜像默认（`local replication all trust`），未做生产级认证方案设计或验证。

## 资源清单（证明未触碰 cps-novel-x8-*）

- 演练前（写本报告前，第一次确认基线）：`docker ps -a --format '{{.Names}}' | grep -c cps-novel-x8` = **6**。
- 轮 A 结束后：**6**。
- 轮 B（最终authoritative 跑法）结束后：**6**。
- 六个容器名称全程未变：`cps-novel-x8-local-backup-timer-1`、`cps-novel-x8-local-nginx-1`、`cps-novel-x8-local-web-1`、`cps-novel-x8-local-worker-1`（Exited(0)，演练前后状态一致）、`cps-novel-x8-local-scheduler-1`、`cps-novel-x8-local-postgres-1`。
- 本次演练创建/删除的 docker 资源：容器 `wal-retention-rig-pg`（两轮各建删一次）、卷 `wal-retention-rig-data`（两轮各建删一次）。两轮结束后 `docker ps -a`/`docker volume ls` 均确认这两个名字不存在。

---

## v2 修复轮（本次，复核清单收口）

- Commit 1（`wal-retention.sh` + `verify-physical-base.sh` 修复）：`0c3ae6b` `fix(db): fail-closed guards for wal-retention (anchor/plan/archiver/dir-name)`
- Commit 2（本节 + 测试 + 演练脚本改动，含本文件）：与本节同一次提交，见 `git log`

针对上面"未覆盖项"里最关键的一条——`anchor_not_in_archive` 缺失导致锚点段从未归档也照样打印 `APPLIED`（`evidence-roundA-final/step4-apply.log` 的原始实证：删光 `01–06` 六段、锚点 `00000001000000000000000B` 从未出现在任何一次 `pg_archivecleanup` 输出里）——本轮按复核清单逐条修复并重新跑通演练。

### 改动清单（P0/P1/P2 逐条，文件:行）

- **P0-1** `scripts/db/wal-retention.sh:152-159`（`anchor_not_in_archive`，$archive_dir/$anchor$archive_ext 不存在即拒）、`:252-269`（`would_empty_archive`，计划执行后 24-hex 段清零即拒）、`:31`+`:208-230`+`:389`（新增 `--require-archiver-healthy` 开关 + `archiver_failing`/`archiver_unreadable`，走 `psql --no-psqlrc -tAc "SELECT failed_count FROM pg_stat_archiver"` 与 state 里的 `last_failed_count` 比较）。
- **P1-1** `scripts/db/wal-retention.sh:235-242`：`pg_archivecleanup -n` 不再用进程替换，`>plan_tmp 2>plan_err` 后显式 `|| plan_rc=$?` 判非零 → `REFUSED reason=plan_failed`（`set -e` 陷阱：原地 `plan_rc=$?` 若不加 `||` 会被 `set -e` 在失败命令本身处杀死进程，改用 `cmd || plan_rc=$?`）。
- **P1-2** `scripts/db/wal-retention.sh:96-116`：目录名正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 校验（不匹配 → `REFUSED reason=unexpected_directory`），有效集合改按各自 `VERIFIED` 的 `start_wal` 升序排序（`sort -t'|' -k1,1 -k2,2`，无关联数组以兼容 macOS 系统 bash 3.2.57），并打印 `WAL_RETENTION_BASE_START_WAL=<dir> start_wal=<wal>`。
- **P1-3** 新增 `tests/backend/database/wal-retention-apply-order.test.ts`（3 个用例，无 Docker，纯 PATH shim）+ 演练新增 **Step4N**（`scripts/db/wal-retention-rehearsal.sh:373-407`）。
- **P1-4** 本文件"未覆盖项"一节整段重写（见上）。
- **P2-1** 本文件"关键原始输出摘录"6A 负例/6B 两处日志改引 `evidence-roundB-final/`（13:13 UTC），并注明此前误引了 13:06 的草稿运行。
- **P2-2** "22/22" 订正为 **23/23**（逐行数 `progress.log` 该轮 `REHEARSAL_STARTED`=13:12:00…`REHEARSAL_FINISHED`=13:13:29 区间的 STEP 断言行，见上方结论一节）。
- **P2-3** `scripts/db/wal-retention-rehearsal.sh:451-466`：Step4 新增 `STEP4_CONTINUITY_COUNT` 断言，真实按 `(hi_log-lo_log)*256 + (hi_seg-lo_seg) + 1`（`$((16#...))`）计算期望段数并与实际 `ls | grep -c` 比对，不再只是注释里说说。
- **P2-4** `scripts/db/wal-retention-rehearsal.sh:280,296,306`：`STEP2_B1_RC`/`STEP2_B2_RC`/`STEP2_B3_RC` 三条独立断言 `backup-physical-base.sh` 退出码为 0。
- **P2-5** `scripts/db/wal-retention-rehearsal.sh:134`：建目录用的 `docker run --rm --pull never ...` 补 `--network none`。
- **P2-6** `scripts/db/wal-retention.sh:11`：`keep_base` 默认值改为 `"2"`（此前必须显式传参）。
- **P2-7** `scripts/db/wal-retention.sh:308-317`：容量四档 `OK`(<70%)/`WARN`(≥70%)/`DEGRADED`(≥85%)/`OVER`(≥100%)，仍只报告不改 N。
- **P2-8** `scripts/db/verify-physical-base.sh:139-148`：新增 `verified_epoch=$(date -u +%s)` 写入 `VERIFIED`；`scripts/db/wal-retention.sh:164-173`：判新鲜度只读 `verified_epoch`，去掉 `date -u -d`（GNU-only），缺该键即视为 stale。
- **P2-9** `scripts/db/wal-retention.sh`（`anchor_manifest` 段）与 `scripts/db/verify-physical-base.sh:105`：manifest 解析改 `sed -n '/WAL-Ranges/,$p' | tr -d '\n'` 后再正则，两处都改。
- **P2-10** `scripts/db/verify-physical-base.sh:29-40`：`require_command pg_verifybackup`/`tar`/(`sha256sum` 或 `shasum`)；`:88` `cp backup_manifest` 失败显式 `PHYSICAL_BASE_VERIFY=FAIL`；`:112-126` 新增 Start-LSN→段名交叉核对（用真实 B2 备份的 `0/B000028` 验证过公式，见下）。
- **P2-11** `scripts/db/wal-retention.sh:71-79`：锁已存在时打印锁目录 mtime 距今秒数（`stat_mtime_flag` 探测 GNU/BSD `stat`）与手工 `rmdir` 提示，仍退出 75，不自愈。
- **P2-12** `scripts/db/wal-retention.sh:362-378`：apply 后对账，`pg_archivecleanup -d` 声称删除的每条路径逐一 `[[ -e ]]` 复查，不等 → `WAL_RETENTION_WARN=reconcile_mismatch deleted=<n> planned=<n>`，退出 62（且不再继续删 RETIRED 目录、不持久化 state）。
- **P2-13** `scripts/db/wal-retention.sh:322-329`：归档里存在 `^[0-9A-F]{24}\.(gz|lz4|zst)$` 但未传 `--archive-ext`，或传了但一个都没有，两种情形都打印同一个 `WAL_RETENTION_WARN=compressed_files_without_archive_ext`，只警告不拒绝。
- **P2-14** `scripts/db/wal-retention-rehearsal.sh:121-126`：`trap on_interrupt INT TERM`，收到信号打印 `WAL_RETENTION_REHEARSAL=ABORTED` 后 `exit 130`（仍会触发既有 `cleanup` EXIT trap）。
- **P2-15** `tests/backend/database/p1-06-static.test.ts`：`bash -n` 清单加入 `scripts/db/wal-retention-rehearsal.sh`。
- **P2-16** `tests/backend/database/archive-wal-filename.test.ts`：新增 `mkTestDir` 助手 + `afterEach` 统一 `rmSync` 清理，四个 `mkdtempSync` 调用点全部切换。
- **P2-17** `scripts/db/wal-retention-rehearsal.sh:153,187-198`：Step0 非法名单补 `../x`，除断言退出 65 外，额外核对 `/rig/work/step0/{x,out/x,out/../x}` 均未落地任何文件。

### 一个真实踩到的 bash 3.2 坑（记录以免复现）

`wal-retention-rehearsal.sh` 本身跑在 macOS 系统 `bash`（`/bin/bash`，3.2.57，2006 年代版本，无关联数组、且 `$(...)` 命令替换解析器会对内嵌的 `<<'INNER'`（哪怕是单引号界定符、理应是字面量）heredoc 正文里的引号/括号做朴素配对扫描）。给 Step0 的 `../x` 用例写注释时，一行注释里的撇号（"didn't"）与跨行未闭合的括号（"(both ... itself)."）分别独立触发了 `bash -n: unexpected EOF while looking for matching` `` ` ' '` — 用最小复现反复二分定位到：只要 heredoc 嵌在 `$(...)` 里，heredoc 正文里出现奇数个单引号，或者括号跨行才闭合，就会让 bash 3.2 的扫描器"迷路"。修法是把这两行注释改写成不含撇号、且括号在同一行闭合，`bash -n` 才转绿。改动前后对比已存证于本轮 `.tmp/wal-retention-rehearsal/progress.log`。

### 验证结果

- 单测：`npx vitest run --project node tests/backend/database/` → **17 files passed, 123 tests passed**（含新文件 3 个用例、`archive-wal-filename.test.ts` 12 个用例、`p1-06-static.test.ts` 5 个用例）。
- `bash -n`：`scripts/db/wal-retention.sh`、`scripts/db/verify-physical-base.sh`、`scripts/db/wal-retention-rehearsal.sh` 均通过。
- 演练轮 B v2：`WAL_RETENTION_REHEARSAL=PASS`，退出 0，**30/30 断言 PASS**（含新增 `STEP4N`、`STEP2_B1_RC`/`_B2_RC`/`_B3_RC`、`STEP4_DRYRUN_ARCHIVER_HEALTHY`/`STEP4_APPLY_ARCHIVER_HEALTHY`、`STEP4_CONTINUITY_COUNT`），证据存于 `.tmp/wal-retention-rehearsal/evidence-roundB-v2/`（未提交，仅本机留存），运行区间 2026-09-16 14:16:56–14:18:21 UTC。
- Step4N 关键行（`evidence-roundB-v2/step4n-dry-run.log`）：
  ```
  WAL_RETENTION_BASE_START_WAL=B1 start_wal=000000010000000000000006
  WAL_RETENTION_BASE_START_WAL=B2 start_wal=00000001000000000000000B
  WAL_RETENTION_BASE_START_WAL=B3 start_wal=000000010000000000000010
  WAL_RETENTION=REFUSED reason=anchor_not_in_archive
  ```
- Start-LSN→段名公式核对（P2-10）：拿本轮真实 B2 备份的 `backup_manifest`（`Start-LSN=0/B000028`）与 `backup_label`（`file 00000001000000000000000B`）分别用 Python 与 bash `$((16#...))` 独立算了一遍公式，两者都得到 `00000001000000000000000B`，与 `backup_label` 完全一致。
- 容器计数：v2 运行前 `docker ps -a --format '{{.Names}}' | grep -c cps-novel-x8` = **6**；运行后 = **6**；运行前后均确认无 `wal-retention-rig-*` 残留（`docker ps -a`/`docker volume ls` 均为空）。

---

REHEARSAL_RESULT=PASS
