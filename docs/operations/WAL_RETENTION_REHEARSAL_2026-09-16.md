# WAL 保留策略验收演练报告（2026-09-16）

## 结论

- **REHEARSAL_RESULT=PASS**（修复版脚本、轮 B）。
- 轮 A（旧版 `archive-wal.sh` 白名单，作为对照组）在 Step 0/2/4/5A/5B/6A 正例六处按预期 **FAIL**，实证了"归档器卡死"这个缺陷本身真实存在、且会级联破坏后续所有基于归档的能力（校验之外的一切）。
- 轮 B（本次修复版 `archive-wal.sh` + 新增 `verify-physical-base.sh` + `wal-retention.sh`）**22/22 个断言全部 PASS**，含两处"必须真失败"的负例（Step 6A 负例、Step 6B）——均以真实 `pg_ctl`/PostgreSQL 日志中的 `FATAL` 报错收尾，不是靠退出码猜的。
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
- 6A 负例（同上，但 `archive-mutant-a` 缺失 ANCHOR 段 `00000001000000000000000B`）真实日志尾行：
  ```
  cp: cannot stat '/rig/archive-mutant-a/00000001000000000000000B': No such file or directory
  2026-09-16 13:06:29.123 UTC [1048] LOG:  invalid checkpoint record
  2026-09-16 13:06:29.123 UTC [1048] FATAL:  could not locate required checkpoint record
  ```
- 6B（B2→RP_M3，带自带 WAL，`archive-mutant` 缺失 victim 段 `000000010000000000000011` = `pg_walfile_name(RP_M3)`）真实日志尾行：
  ```
  ... 2026-09-16 13:06:33.101 UTC [1117] LOG:  consistent recovery state reached at 0/B03BC20
  2026-09-16 13:06:33.101 UTC [1114] LOG:  database system is ready to accept read-only connections
  ... restored log file "000000010000000000000010" from archive
  cp: cannot stat '/rig/archive-mutant/000000010000000000000011': No such file or directory
  cp: cannot stat '/rig/archive-mutant/000000010000000000000011': No such file or directory
  2026-09-16 13:06:33.236 UTC [1117] LOG:  redo done at 0/100001E8 ...
  2026-09-16 13:06:33.236 UTC [1117] FATAL:  recovery ended before configured recovery target was reached
  2026-09-16 13:06:33.238 UTC [1114] LOG:  database system is shut down
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

## 未覆盖项（本轮明确不做）

- 告警脚本接线（`pg_stat_archiver.failed_count`/`last_failed_time` 超阈值告警）：未覆盖。
- `infra/production-like/backup-timer.sh` 与本次新增的 `verify-physical-base.sh`/`wal-retention.sh` 的定时任务接线：未覆盖，两者目前都是独立可执行脚本，尚未接入任何 cron/timer。
- `pg_hba.conf` 的生产化改造：本次沿用镜像默认（`local replication all trust`），未做生产级认证方案设计或验证。
- 压缩归档（`--archive-ext .gz` 路径）：脚本支持该参数，但本轮全程没有产生任何压缩 WAL，未实测。
- 多时间线（`timeline_unsupported` 拒绝分支）本轮只做了静态代码走查，未在演练里构造出一个真实的多 WAL-Ranges/非 1 号时间线场景去触发它（6A/6B 用的都是单一时间线 1 号）。

## 资源清单（证明未触碰 cps-novel-x8-*）

- 演练前（写本报告前，第一次确认基线）：`docker ps -a --format '{{.Names}}' | grep -c cps-novel-x8` = **6**。
- 轮 A 结束后：**6**。
- 轮 B（最终authoritative 跑法）结束后：**6**。
- 六个容器名称全程未变：`cps-novel-x8-local-backup-timer-1`、`cps-novel-x8-local-nginx-1`、`cps-novel-x8-local-web-1`、`cps-novel-x8-local-worker-1`（Exited(0)，演练前后状态一致）、`cps-novel-x8-local-scheduler-1`、`cps-novel-x8-local-postgres-1`。
- 本次演练创建/删除的 docker 资源：容器 `wal-retention-rig-pg`（两轮各建删一次）、卷 `wal-retention-rig-data`（两轮各建删一次）。两轮结束后 `docker ps -a`/`docker volume ls` 均确认这两个名字不存在。

---

REHEARSAL_RESULT=PASS
