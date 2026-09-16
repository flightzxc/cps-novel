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
| STEP0 | 5 个合法 WAL 文件名返回 0 且落地，4 个非法文件名返回 65（轮 A/B 首次演练时为 3；v2 修复轮 P2-17 补充 `../x` 路径逃逸用例后为 4，本表按当前脚本订正） | `.backup`/`.history` 两个合法用例返回 65（LEGAL_BAD） | **FAIL** | 5 legal 全 0、3 illegal 全 65（当轮跑的是 3 用例版本，`../x` 是 v2 修复轮才补的） | **PASS** |
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
- `would_empty_archive`（P0-1）：**正常路径不可达，保留作兜底，不计入独立覆盖**——Opus 二轮复核已论证：只要 `anchor_not_in_archive` 先于它把关（锚点段必须真实在档），锚点自身在 `pg_archivecleanup -n` 的输出里永远不会被列入删除计划（它是 OLDESTKEPTWALFILE 本身，pg_archivecleanup 按契约保留它和更新的），所以"计划执行后归档清零"这个条件在锚点存在的前提下不可能成立；该分支是防御性兜底（防的是 `anchor_not_in_archive` 之外别的假设被打破），不是一条独立可达的代码路径，因此不再要求单独构造用例覆盖它。演练与单测均未构造，这是预期内、不是缺口。
- `archiver_failing` / `archiver_unreadable`（P1-C，`--require-archiver-healthy`）：**本轮（v3）改为时点谓词**（不再是 `failed_count` 基线/增量比较，见下方"二轮复核结论"），且**新增单测覆盖了两个拒绝分支本身**——`tests/backend/database/wal-retention-guards.test.ts`：psql 非零退出 / 返回非数字 `failed_count` → `archiver_unreadable`；`last_failed_time > last_archived_time`（psql 返回 `t`）→ `archiver_failing`；返回 `f` → 不拒绝。演练 Step4 的 dry-run/apply 仍然只覆盖健康路径（rig 内 `pg_stat_archiver.failed_count=0`，走本地 socket，断言"不会被误拒"）——**这一条脚注：演练本身仅覆盖健康路径；两个拒绝分支的失败路径由本轮新增单测覆盖，不是演练证据**。
- `verified_malformed`（P1-D，本轮新增的拒绝分支）：**本轮新增单测覆盖**——`wal-retention-guards.test.ts`：VERIFIED 缺失 `start_wal` → `REFUSED reason=verified_malformed name=<dir>`，退出 65，且该目录本身与其邻居均未被触碰（未打 RETIRED、未被删除）。演练本身未构造这个场景（rig 里的 VERIFIED 全部由 `verify-physical-base.sh` 正常写出，从不缺字段）；**完全未在演练里验证**，只有单测。
- `unexpected_directory`（P1-2）：无单测、演练也没有在 `base-backup-dir` 下放一个不认识的目录去触发它；完全未验证。P2-1（本轮）把这条判定行从 stderr 改到了 stdout，但输出流改动本身也没有专门测试点名它——只在 `wal-retention-guards.test.ts` 的"全部 REFUSED 行都在 stdout"回归里被间接覆盖到同一条通用规则,不是对 `unexpected_directory` 这个具体分支的专门断言。
- `reconcile_mismatch`（P2-12/P2-4，退出 62）：无单测、演练没有构造"`pg_archivecleanup -d` 之后文件仍在"的场景；**完全未验证**，本轮（P2-4）额外在这条警告后加了一行 `WAL_RETENTION_HINT=retired_markers_kept dirs=<列表> action="..."`，同样未经任何自动化测试或演练验证——这是刻意的 fail-closed 设计（详见"改动清单"P2-4），不会自愈，需要人工确认后手动删除 RETIRED 标记；但"这条 HINT 真的会在 mismatch 时打印出来"这件事本身仍然只是静态代码走查，没有构造过真实的 reconcile_mismatch 场景去验证。
- `compressed_files_without_archive_ext` 告警（P2-13）：无单测、演练全程没有产生任何压缩 WAL；完全未验证。
- 容量档位转档（`OK`/`WARN`/`DEGRADED`/`OVER` 四档，P2-7）：演练全程归档目录很小，只报告过 `OK` 档（`WAL_RETENTION_CAPACITY=OK bytes=285213689 max=1073741824`），从未构造真实数据让它转到 `WARN`/`DEGRADED`/`OVER`。复核者曾对旧的三档版本手工验证过，非演练证据；四档新增的 `DEGRADED` 门槛本身未经任何验证。
- 压缩归档（`--archive-ext .gz` 路径）：脚本支持该参数，但本轮全程没有产生任何压缩 WAL，未实测。复核者手工验证过（旧版三档同一轮），非演练证据。
- 多时间线（`timeline_unsupported` 拒绝分支，两个独立触发条件）：该分支实际由两个条件之一触发——(a) `wal_ranges_count != 1`（含 0 和 ≥2 两种形状）、(b) `anchor_timeline != "1"`。**(a) 的 0 这一形状本轮（v3）新增单测覆盖**：`wal-retention-guards.test.ts` 用一份真实 `"WAL-Ranges": []` 的 `backup_manifest` 断言 `REFUSED reason=timeline_unsupported`（这也是 P1-B 修复本身要证明的：`grep -oE '"Timeline"'` 在 0 个 Timeline 键时退出 1，`set -euo pipefail` 下若无 `|| true` 会在这条断言执行前就整体杀死脚本）。**(a) 的 ≥2 形状与 (b) 仍完全未验证**——本轮只做了静态代码走查，未在演练或单测里构造出一个真实的多 WAL-Ranges（≥2 个 Timeline 键）或非 1 号时间线场景（6A/6B 用的都是单一时间线 1 号）。
- apply 中途 kill（进程被杀在"已标记 RETIRED、还没删 WAL"或"已删 WAL、还没删目录"之间）：无单测、演练没有模拟；完全未验证。P1-3 的单测只验证了正常完整跑完时 RETIRED 先于目录删除这个**时序**，不等于验证了"中途真的被杀掉"后重跑是安全的。
- 告警脚本接线（`pg_stat_archiver.failed_count`/`last_failed_time` 超阈值告警）：未覆盖。
- `infra/production-like/backup-timer.sh` 与 `verify-physical-base.sh`/`wal-retention.sh` 的定时任务接线：未覆盖，两者目前都是独立可执行脚本，尚未接入任何 cron/timer。**订正（Opus 三轮复核，P2-8）**：`--require-archiver-healthy` 默认关，指的是 `wal-retention.sh` 这个底层脚本自己的默认值——这是刻意的，供离线单测/rehearsal 这类不需要真实 `pg_stat_archiver` 的场景直接调用。它不代表"正式入口也默认关"：`scripts/db/wal-gc-x8.sh`（唯一受支持的正式 X8 入口，见下方"正式入口与 compose 挂载"一节）把它硬编码为固定开启，任何调用这个入口的路径都不能关掉它。
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

## v3 修复轮（本次，Opus 二轮复核收口：4 个 P1 + 若干 P2）

- Commit（本轮 v3，代码 + 测试 + 本节文档）：与本节同一次提交，见 `git log`。

Opus 二轮复核抓到的核心问题是同一族：`set -e` 会在 P1-A/P1-B 的赋值处直接杀死脚本，导致对应的 `REFUSED` 行永远打不出来（不是判断错了，是根本没跑到判断）；P1-C 的 `failed_count` 基线一旦上升就再也回不来，会永久拒绝；P1-D 的 `VERIFIED` 缺字段会被空字符串排序规则悄悄当成"最老备份"静默退休、`rm -rf`。

### 改动清单（file:line，均以本次提交后的文件为准）

- **P1-A** `scripts/db/wal-retention.sh:255`（原 v2 轮的 `:215`）：`archiver_row="$(psql ... 2>/dev/null || true)"` —— psql 连接/查询失败时命令替换整体非零退出，`set -euo pipefail` 下若不加 `|| true` 会在这条赋值本身杀死脚本，`archiver_unreadable` 的判断分支永远执行不到。
- **P1-B** `scripts/db/wal-retention.sh:214`（原 v2 轮的 `:194`）：`wal_ranges_count="$(... | grep -oE '"Timeline"' | wc -l | tr -d ' ' || true)"` —— `|| true` 加在整条 pipe 末尾（不是"grep 后面插入"：那样会写成 `grep ... || true | wc -l | ...`，等价于 `grep ... || (true | wc -l | ...)`，grep 一成功就整条 pipe 提前短路，wc/tr 的计数逻辑反而被跳过；采用与文件里既有 `:202`/`:310`/`:373` 完全同款的"整条 pipe 末尾 `|| true`"写法）。0 个 `"Timeline"` 键时 `grep -oE` 退出 1，`pipefail` 下即使 `wc`/`tr` 都成功，整条 pipeline 的聚合退出码仍是那个 1，不加 `|| true` 会在这条赋值杀死脚本，`timeline_unsupported` 打不出来。
- **P1-C** `scripts/db/wal-retention.sh:228-279`（原 v2 轮 `archiver_failing` 整段 `:208-230` 的重写；state 持久化改动见下）：废弃 `failed_count` 基线/state 比较（一旦 `failed_count` 因为一次瞬时失败升高，state 里的 `last_failed_count` 也会在下一次成功 apply 后被更新为那个更高的值——但只要 Postgres 自己再也不把 `failed_count` 计数器清零，此后只要有第二次失败让 `failed_count` 继续哪怕只涨 1，就会一直拒绝，永远无法在不重启 Postgres 的情况下自愈），改为对 `pg_stat_archiver` 的**时点谓词**：两条独立 `psql --no-psqlrc -tAc` 查询——第一条 `SELECT coalesce(failed_count,0), coalesce(last_failed_time::text,''), coalesce(last_archived_time::text,'') FROM pg_stat_archiver` 取三列判断是否可读（`failed_count` 非数字 → `archiver_unreadable`）；第二条 `SELECT (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) FROM pg_stat_archiver` 让 Postgres 自己做时间戳比较返回单个 t/f，脚本只认字面 `t`/`f`，其余一律 `archiver_unreadable`。`t` → `REFUSED reason=archiver_failing`，并把三列原值（`failed_count=`/`last_failed_time=`/`last_archived_time=`）打在同一行。`psql` 调用前 `export PGCONNECT_TIMEOUT=10`（`:250`，即 P2-5）。state 文件（`:461-472`）不再写 `last_failed_count`；旧 state 文件里若还留着这个键，`read_kv` 已经不再读它，静默忽略。
- **P1-D** `scripts/db/wal-retention.sh:98-129`（枚举循环，取代原 P1-2 范围 `:96-116` 里"只做目录名正则"的部分）：每份候选 `VERIFIED`（`-f "$d/VERIFIED" && ! -f "$d/RETIRED"`）新增三项格式校验——`start_wal` 匹配 `^[0-9A-F]{24}$`、`start_timeline` 匹配 `^[0-9]+$`、`verified_epoch` 匹配 `^[0-9]+$`（`:106-117`），任一不满足 → `REFUSED reason=verified_malformed name=<dir>` 退出 65，不删除/不标记任何东西。修的是真实数据丢失通路：`start_wal` 缺失时 `read_kv` 返回空串，空串在后续 `sort -t'|' -k1,1 -k2,2`（`:128`）里排在所有真实 WAL 名之前，即被当成"最老的备份"，在 apply 时会被静默标记 RETIRED 并 `rm -rf`——即便它可能是唯一一份还没坏的备份。
- **P2-1**（全文件，统一到 stdout）：以下几处从 `>&2` 挪到 stdout——`:102`（`unexpected_directory`）、`:153`（`anchor_verified_missing`）、`:159`（`anchor_verified_malformed`）、`:169`（`anchor_not_in_archive`）、`:180`（`stale_base_backup`，`verified_epoch` 格式错分支——注意同一个 `reason=stale_base_backup` 在另一条"超龄"分支 `:186` 原本就在 stdout，改前两个分支输出流不一致）、`:198`（`timeline_unsupported`，`backup_manifest` 缺失分支——同理，`:217` 的 `wal_ranges_count` 分支原本就在 stdout）。新增的 `:115`（`verified_malformed`）、`:247`/`:258`/`:275`（`archiver_unreadable` 三处）、`:268`（`archiver_failing`）从一开始就写在 stdout。`tests/backend/database/wal-retention-apply-order.test.ts` 里 `anchor_not_in_archive` 的断言（`:246-250`）从 `result.stderr + result.stdout` 改为只看 `result.stdout`，并新增 `expect(result.stderr).not.toContain(...)`。
- **P2-4** `scripts/db/wal-retention.sh:439-452`（`WAL_RETENTION_HINT` 本身在 `:450`）：`reconcile_mismatch`（退出 62）分支新增一行 `WAL_RETENTION_HINT=retired_markers_kept dirs=<retire_set 逗号列表> action="确认这些目录的 WAL 是否仍完整；若要恢复为有效集合成员，人工删除其 RETIRED 标记"`。刻意不做成自愈：退出 62 之后，步骤 3（删除 RETIRED 目录）与步骤 4（持久化 state）都不会再执行，RETIRED 标记原样留着，需要人工判断。
- **P2-5**：见上方 P1-C 的 `PGCONNECT_TIMEOUT=10`（`:250`）。
- **P2-6**：`scripts/db/wal-retention.sh:11` `keep_base="2"`，核对无误，行号未变（本轮没有在这条之前插入任何行）。
- **P2-7**：本文件 STEP0 矩阵行（第 35 行）非法用例数由 3 订正为 4，并加注"轮 A/B 首次演练时为 3"；`--require-archiver-healthy` "不会误伤正常路径"断言已在上方"未覆盖项"对应条目补充脚注"演练本身仅覆盖健康路径；两个拒绝分支的失败路径由本轮新增单测覆盖"。

### 额外发现并修复的一个真实 bug（不在原始 P1/P2 清单里）

编写本轮"`--require-archiver-healthy` 返回 `f`（健康）→ 不拒绝 → 正常 `DRY_RUN`"这个单测时，第一次真实跑出了脚本本身的崩溃，而不是预期的 `WAL_RETENTION=DRY_RUN`：

```
.../scripts/db/wal-retention.sh: line 315: planned_files[@]: unbound variable
```

根因：`scripts/db/wal-retention.sh` 原来有两处 `for f in "${planned_files[@]}"; do ...`（would_empty_archive 段与 apply 后 reconcile 段）没有守卫。在 `set -u` 下，bash < 4.4（含 macOS 系统 `bash` 3.2.57——本轮红线里明确的本机 shell）对**空数组**的 `"${arr[@]}"` 展开会报 "unbound variable"，即便这个数组是用完全正常的 `arr=()` 声明的（bash 4.4 才修了这个不一致）。`planned_files` 为空（"没有任何可回收的 WAL 段"）是完全正常、常见的结果——例如每次健康 dry-run 紧跟在上一次 apply 之后，通常就没有新东西可删——但 v1/v2 两轮演练与既有单测凑巧全部落在"有东西可删"的场景，这条路径此前从未被真正走过一次。修法：两处都补了 `if [[ "${#planned_files[@]}" -gt 0 ]]; then ... fi` 守卫（`scripts/db/wal-retention.sh:319-324`、`:434-438`），不影响非空场景的原有逻辑。

### 二轮复核结论

- **P1-A**：`scripts/db/wal-retention.sh:255`，psql 结果赋值补 `|| true`，防 `set -e`+`pipefail` 在 psql 失败时于赋值处直接杀死脚本 → 测试：`wal-retention-guards.test.ts` › "psql exiting non-zero prints REFUSED reason=archiver_unreadable on stdout, exit 65"。
- **P1-B**：`scripts/db/wal-retention.sh:214`，`grep -oE '"Timeline"' | wc -l | tr -d ' '` 整条 pipe 末尾补 `|| true`，防 0 个 `"Timeline"` 键时 grep 非零退出在 `pipefail` 下杀死脚本 → 测试：`wal-retention-guards.test.ts` › "anchor backup_manifest with an empty WAL-Ranges array prints REFUSED reason=timeline_unsupported, exit 65"。
- **P1-C**：`scripts/db/wal-retention.sh:228-279`，`archiver_failing` 从 `failed_count` 基线/state 比较整段重写为时点谓词（`last_failed_time`/`last_archived_time` 的先后由 Postgres 自己判，脚本只认返回的 t/f 字面值） → 测试：`wal-retention-guards.test.ts` › "refuses with archiver_failing when Postgres reports the last failure is newer than the last success" 与 "does not refuse (falls through to a normal DRY_RUN) when Postgres reports the archiver is healthy"。
- **P1-D**：`scripts/db/wal-retention.sh:98-129`，枚举循环内对每份 `VERIFIED` 的 `start_wal`/`start_timeline`/`verified_epoch` 三项格式做前置校验，任一不满足即拒且不碰任何文件 → 测试：`wal-retention-guards.test.ts` › "a VERIFIED file missing start_wal prints REFUSED reason=verified_malformed, exit 65, and touches nothing"。
- **`would_empty_archive`**：正常路径不可达，保留作兜底，不计入独立覆盖——Opus 已论证：`anchor_not_in_archive` 先把关（锚点段必须真实在档），而锚点段本身正是 `pg_archivecleanup` 的 `OLDESTKEPTWALFILE` 参数，按其契约永远不会出现在自己的删除计划（`-n` 输出）里；因此"锚点存在"这个前提一旦成立，"计划执行后归档清零"这个条件就不可能同时成立，该分支是防御性兜底而非独立可达路径，不再要求单独构造用例覆盖。

### 验证结果（v3）

- 单测：`npx vitest run --project node tests/backend/database/` → **18 files passed, 130 tests passed**（含新文件 `wal-retention-guards.test.ts` 7 个用例，以及 `wal-retention-apply-order.test.ts` 3 个用例——其中 `anchor_not_in_archive` 一条的断言本轮改为只看 stdout）。
- `bash -n`：`scripts/db/wal-retention.sh`、`scripts/db/verify-physical-base.sh`、`scripts/db/wal-retention-rehearsal.sh` 均通过。
- 演练轮 B v3：`WAL_RETENTION_REHEARSAL=PASS`，退出 0，**30/30 断言 PASS**（与 v2 同一组 30 条断言；本轮未新增 STEP，`STEP4_DRYRUN_ARCHIVER_HEALTHY`/`STEP4_APPLY_ARCHIVER_HEALTHY` 这两条现在实际跑的是 P1-C 的时点谓词而不是旧的 `failed_count` 基线逻辑），证据存于 `.tmp/wal-retention-rehearsal/evidence-roundB-v3/`（未提交，仅本机留存），运行区间 2026-09-16 15:06:35–15:08:00 UTC。
- 容器计数：v3 运行前 `docker ps -a --format '{{.Names}}' | grep -c cps-novel-x8` = **6**；运行后 = **6**；运行前后均确认无 `wal-retention-rig-*` 残留（`docker ps -a`/`docker volume ls` 均为空）。

## v4 修复轮（本次，Opus 三轮复核收口）

- Commit（本轮 v4，代码 + 测试 + 本节文档）：与本节同一次提交，见 `git log`。

本轮修的不是 `wal-retention.sh` 本身的判断逻辑（v2/v3 两轮已收口），而是 `scripts/x8-production-like.sh` 的 `wal-gc`/`base-backup-now` 两个正式 X8 入口——Opus 三轮复核指出它们写作时缺了与 `up`/`gate` 家族同款的两项前置检查，以及 `wal-gc-x8.sh` 包装器本身两处可加固的地方。

### 正式入口与 compose 挂载

`scripts/x8-production-like.sh` 对外只暴露两个子命令触达 WAL 保留/基准备份机制——绝不支持在活栈容器内手敲裸 `wal-retention.sh`（那条路径没有强制的 archiver 健康闸）：

- `wal-gc [--apply] [--keep N] [--json] [--force]`：`x8_compose exec` 到 postgres 容器内的 `postgres` 系统用户，执行 `bash /app/scripts/db/wal-gc-x8.sh`。
- `base-backup-now`：同样 `exec` 到 postgres 容器，以 `backup_role`（走 compose secret，从不明文 `PGPASSWORD`）跑 `pg_basebackup` + `verify-physical-base.sh`，写入 `/var/lib/postgresql/base-backups/<UTC 时间戳>`。

两者都依赖 `infra/production-like/docker-compose.yml` postgres 服务的五处新挂载（commit `bbec454`）：

1. `${X8_BASE_BACKUP_DIR:?...}:/var/lib/postgresql/base-backups`（宿主 bind，`X8_BASE_BACKUP_DIR` 派生自 `scripts/lib/x8-production-like-env.sh:16` 的 `"$X8_RUNTIME_DIR/base-backups"`）
2. `./scripts/db/wal-retention.sh:/app/scripts/db/wal-retention.sh:ro`
3. `./scripts/db/wal-gc-x8.sh:/app/scripts/db/wal-gc-x8.sh:ro`
4. `./scripts/db/backup-physical-base.sh:/app/scripts/db/backup-physical-base.sh:ro`
5. `./scripts/db/verify-physical-base.sh:/app/scripts/db/verify-physical-base.sh:ro`

`infra/production-like/postgres-entrypoint.sh:6` 新增一行 `install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/base-backups`（与既有的 `wal-archive` 那行同款）。这些都是 compose 文件/entrypoint 改动，只有当前活跑的 postgres 容器**被下一次 recreate**才会真正获得这些挂载——写作时本机活栈（`cps-novel-x8-local-postgres-1`）就是先于这次提交起来的，还没有它们。

**P2-6：这是入口级控制，不是容器级控制。** compose 必然把裸 `wal-retention.sh` 本身也 `:ro` 挂进了 postgres 容器（供 `wal-gc-x8.sh` 自己 exec），这意味着任何能 `docker exec` 进容器的人仍然可以直接手敲 `bash /app/scripts/db/wal-retention.sh --apply`（不带 `--require-archiver-healthy`）,绕开 `wal-gc-x8.sh` 强加的那道闸——容器内没有第二层机制阻止这件事。这是运维纪律问题，不是可以用代码堵死的口子：对活栈的一切 WAL 保留/基准备份操作**只允许**经 `scripts/x8-production-like.sh wal-gc` / `base-backup-now` 两个入口，禁止在容器内手敲 `wal-retention.sh`。

### 改动清单（file:line）

- **P1-1**（运行时挂载预检）`scripts/x8-production-like.sh`：新增 `x8_require_wal_retention_mounts()`（`wal_gc()` 定义之前），用 `x8_compose exec -T postgres sh -c 'test -r ... && mountpoint -q /var/lib/postgresql/base-backups'` 探测四个脚本 bind + base-backups 挂载点是否都已就位；`wal_gc()`/`base_backup_now()` 各自在 `prepare_x8_environment` 之后、真正 `exec` 之前调用它，失败即 `ERROR: running postgres container predates the WAL-retention mounts ...` 并 `return 65`。堵的是"脚本挂了、目录没挂"这种更危险的中间态——`backup-physical-base.sh` 的 `mkdir -p` 若落在没挂 `base-backups` 的容器里，会把整份基准备份写进容器自己的 overlay 层（Docker VM 盘），且在下次 recreate 时连带那次备份一起消失。
- **P1-2**（worktree 绑定 + 宿主落点可见）`scripts/x8-production-like.sh`：`wal_gc()`/`base_backup_now()` 各自在 `prepare_x8_environment` 之后调用 `x8_assert_worktree_stack_binding "$P1_12_COMPOSE_PROJECT" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)" || return 65`——与 `up_x8()`/`gate_catalog_recreate()`/`gate_catalog_status()` 完全同款的前置检查，写作时这两个新子命令是唯一没有它的（会静默对另一个 worktree `up` 起来的栈生效，宿主产物落进那个 worktree 的 `base-backups` 绑定目录而不是调用者自己的）。`base_backup_now()` 成功后新增一行 `X8_BASE_BACKUP_HOST_DIR=<宿主真实落点>`（`docker inspect <postgres 容器> --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/base-backups"}}{{.Source}}{{end}}{{end}}'`，与 `restore_smoke()` 等处读容器实际状态同一手法），让操作员不用死记 `$X8_BASE_BACKUP_DIR` 也能知道这次备份落在宿主的哪个目录。
- **P2-1**（静态断言防注释欺骗）`tests/backend/database/wal-gc-x8.test.ts`、`tests/backend/database/p1-06-static.test.ts`：两处 `expect(content).toContain("--require-archiver-healthy")` 改为 `expect(content).toMatch(/target=\([\s\S]*?--require-archiver-healthy[\s\S]*?\)/)`——`wal-gc-x8.sh` 自己的头部注释里也有一句英文散文提到这个 flag 名字，纯 `toContain` 哪怕真的把 `target=()` 数组里那一行删掉、只留注释，测试依然会通过；改后的正则钉死在 `target=(` 到其自身闭合 `)` 之间。变异验证：手动删掉 `target=()` 里的 `--require-archiver-healthy` 那一行（注释原样保留），两个静态测试均从 PASS 转 FAIL（`wal-gc-x8.test.ts` 的静态契约用例报 `expected null to be truthy`，且级联导致四个运行时拒绝用例本身也转 FAIL——因为少了这个 flag，`archiver_unreadable`/`archiver_failing` 两条拒绝路径本身就不会再触发），随后 `mv` 恢复原文件，`git diff --quiet -- scripts/db/wal-gc-x8.sh` 相对本轮改动后的版本为空。
- **P2-2/P2-3**（测试承重）`tests/backend/database/wal-gc-x8.test.ts`：四个"archiver 拒绝"用例新增 `expect(existsSync(path.join(baseDir, "B1"))).toBe(true)`（只查 `RETIRED` 标记不够——真实 bug 可能整个目录被删而不留下一个假的"未打标记"状态）；其中一个用例（psql 非零退出那条）把默认的 `PG_ARCHIVECLEANUP_NOOP_SHIM` 换成会真删文件的 `PG_ARCHIVECLEANUP_REAL_SHIM`，让"归档文件数不变"这条断言从"无论如何都为真"变成真正能在回归时失败。`mkWrapperCopyWithMarkerStub` 新增一条正向对照用例："合法参数集（`--apply --keep-base 2 --json --force`）下 marker 必须被创建"——此前四条 `it.each` 拒绝用例只证明了 marker 不存在，单独看这也可能是"包装器压根没接到 wal-retention.sh"这种坏掉的形状，正向对照补上另一半。
- **P2-4**（校验解包目录不落 VM 盘）`scripts/x8-production-like.sh` 的 `base_backup_now()`：调用 `verify-physical-base.sh` 时新增 `--work-dir "/var/lib/postgresql/base-backups/.verify-$stamp"`（点号前缀，`wal-retention.sh` 枚举有效集合的 `find ... ! -name '.*'` 会原样跳过，不会被误当成候选备份目录）。`scripts/db/verify-physical-base.sh`：原先只有脚本自己 `mktemp -d` 生成的 work_dir 才会被 EXIT/INT/TERM 陷阱 `rm -rf`，调用方显式传入的 `--work-dir` 此前完全不会被清理——这在 `.tmp/`/`/rig` 这类一次性演练目录下无所谓（整体会被随后一并拆除），但换成 `base_backup_now()` 这种指向持久 bind 挂载、每次调用都会用到的场景后，会导致每跑一次就在 `base-backups` 里留下一份解包出来的完整基准备份副本，永久攒着。修复：去掉 `cleanup_work_dir` 这个条件位，两处 trap 一律 `rm -rf "$work_dir"`——无论调用方自己传的还是脚本自造的，成功/`fail()` 的每条退出路径/信号都会清理。
- **P2-5**（孤儿备份目录可见）`scripts/db/wal-retention.sh` 枚举循环：新增 `elif [[ ! -f "$d/VERIFIED" && ! -f "$d/RETIRED" ]]` 分支，打印 `WAL_RETENTION_WARN=unverified_backup_dir name=<dir>`（stdout，只警告，不计入有效集合也不触发拒绝）——覆盖的是"合法命名的目录，两个标记都没有"（典型形状：`backup-physical-base.sh` 还没跑完、或跑完了但从没到 `verify-physical-base.sh` 那一步）此前完全不会出现在任何输出里的问题。`tests/backend/database/wal-retention-guards.test.ts` 新增两条：一条证明这个警告真的打印且不影响下面正常的 `DRY_RUN`,一条证明"只有 `RETIRED`、没有 `VERIFIED`"（正常退休流程的中间态，不是孤儿）不会被误警告。
- **P2-6**：见上方"正式入口与 compose 挂载"一节末段——入口级而非容器级控制，运维纪律条款，本轮未改代码。
- **P2-7**（包装器头注释）`scripts/db/wal-gc-x8.sh`：头部新增一段，点名 `X8_WAL_ARCHIVE_DIR`/`X8_BASE_BACKUP_DIR_IN_CONTAINER`/`X8_WAL_ARCHIVE_MAX_BYTES` 三个 env 覆盖仅供 `tests/backend/database/wal-gc-x8.test.ts` 无 Docker 单测用，正式入口经 `x8_compose exec` 从不传 `-e`，这三个变量在真实调用里不可达，始终吃 `:-` 右侧的硬编码默认值。
- **P2-9**（`--force` 通知）`scripts/db/wal-gc-x8.sh`：解析到 `--force` 时置 `force_requested=1`，在 `exec` 进 `wal-retention.sh` 之前（早于它自己任何 `WAL_RETENTION*=` 输出行）打印 `WAL_GC_X8_NOTICE=delete_surge_guard_disabled_for_this_run` 到 stdout——无论这次运行 `delete_surge_guard` 实际上会不会触发，都先把"这次调用整体解除了这道闸"这件事落进同一条日志/证据流。`tests/backend/database/wal-gc-x8.test.ts` 新增两条：`--force` 时通知先于 `WAL_RETENTION=APPLIED` 出现；不带 `--force` 时完全不打印这行。

### 验证结果（v4）

- 单测：`npx vitest run --project node tests/backend/database/` → **19 files passed, 149 tests passed**（较 v3 的 18 files/130 tests 新增：`wal-retention-guards.test.ts` +2、`wal-gc-x8.test.ts` +5 净增,其中 1 条替换为正向对照）。
- `bash -n`：`scripts/x8-production-like.sh`、`scripts/db/wal-gc-x8.sh`、`scripts/db/wal-retention.sh`、`scripts/db/verify-physical-base.sh` 均通过。
- 变异验证（P2-1）：见上方 P2-1 条目，静态断言从"注释也能骗过"改为"钉死在 `target=(...)` 数组内"，删除真实 flag（保留注释）后两个静态测试均转 FAIL，恢复后 `git diff --quiet` 为 0（相对本轮提交前的工作区状态；未跟踪的 `docs/audits/` 不计入)。
- 本轮**未**重新跑 `wal-retention-rehearsal.sh` 一次性 Docker rig（这轮改的是 `scripts/x8-production-like.sh` 这个更上层的正式入口 + 包装器本身,rig 演练脚本走的是另一条路径，直接调用 `verify-physical-base.sh`/`wal-retention.sh`，不经过 `wal-gc-x8.sh`/`x8-production-like.sh` 这两层；`mountpoint`/worktree 绑定这两项新前置检查也只在真实 compose 栈里才有意义）——这是本轮如实登记的缺口，不是演练证据，留给"WAL 保留策略 X8 上线路线图（2026-09-17）"（`docs/audits/WAL_RETENTION_X8_ROLLOUT_PLAN_2026-09-17.md`）里 Gate 2 之后的真实 recreate 去补。

---

REHEARSAL_RESULT=PASS
