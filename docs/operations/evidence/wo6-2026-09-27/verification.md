# 工单 6 验证命令与尾行

实现检查点 `d1e6769bf80fdf99e42f535bf8c831656fc74bef`。后续仅整理证据与交付文档；门禁与变异不并发。测试路径在命令中直接给出。

原始完整日志保留在本 worktree 的 `.tmp/wo6-verification/`，以下脱敏摘录保留命令、退出码与尾行。

## typecheck

命令：`npm run typecheck`；退出码 **0**；耗时 1.86 秒。

```text

> cps-novel@0.4.5 typecheck
> tsc --noEmit

```

## full-test-final

命令：`npm test -- --maxWorkers=4`；退出码 **1**；耗时 297.74 秒。

```text
 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
 ❯ tests/ui/articles-admin.test.tsx:1146:5
    1144|      * far cheaper under jsdom.
    1145|      */
    1146|     it("勾选超过上限（200 篇）时展示提示并禁用批量发布按钮", () => {
       |     ^
    1147|       const many = Array.from({ length: 201 }, (_, index) => ({
    1148|         ...DRAFT_ROW,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 460 passed | 37 skipped (498)
      Tests  1 failed | 6868 passed | 392 skipped (7261)
   Start at  03:26:25
   Duration  296.98s (transform 17.86s, setup 0ms, collect 126.35s, tests 654.51s, environment 149.38s, prepare 72.92s)

```

Unhandled Error / Rejection / Uncaught Exception 检索：False。

## run-add-admin-identity-postgres-verification

命令：`bash scripts/run-add-admin-identity-postgres-verification.sh`；退出码 **0**；耗时 16.41 秒。

```text

 ✓ |node| tests/integration/auth/add-admin-identity-postgres.test.ts (2 tests) 2810ms
   ✓ add admin identity with real PostgreSQL and web_app grants > uses web_app to create, independently enroll, replay and deactivate admin2  2320ms
   ✓ add admin identity with real PostgreSQL and web_app grants > serializes two overlapping web_app transactions for one username  445ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  03:31:33
   Duration  4.61s (transform 283ms, setup 0ms, collect 413ms, tests 2.81s, environment 0ms, prepare 251ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-add-admin-identity-secrets.mCjzej/integration-result.json
ADD_ADMIN_IDENTITY_INTEGRATION=PASS passed=2 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
ADD_ADMIN_IDENTITY_DICTIONARY_DRIFT=0
ADD_ADMIN_IDENTITY_POSTGRES_VERIFICATION=PASS
ADD_ADMIN_IDENTITY_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-catalog-batch-postgres-verification

命令：`bash scripts/run-catalog-batch-postgres-verification.sh`；退出码 **0**；耗时 44.9 秒。

```text
   ✓ catalog batch on disposable PostgreSQL 16.14 > projects parent-only status filters, detail, and progress from child task counters  304ms
   ✓ catalog batch on disposable PostgreSQL 16.14 > content success queues no preview (publication-triggered since v0.4.5); CAS loser and retired protocol leave no partial business rows  473ms
   ✓ catalog batch on disposable PostgreSQL 16.14 > 推广链接状态三态互斥、覆盖全部，并与 status/sourceLocale 取交集 (web_app role)  406ms
   ✓ catalog batch on disposable PostgreSQL 16.14 > 全选一致性：全选 + 未领取 + en 提交后，worker 枚举入片的书恰好等于界面筛选结果（有码书/人工核对书零入片）(worker_app role)  430ms
   ✓ catalog batch on disposable PostgreSQL 16.14 > 旧的 selection 负载（没有 promoLinkStatus 字段）向后兼容——等价于'全部'，枚举不做任何推广链接状态 narrowing  336ms
   ✓ catalog batch on disposable PostgreSQL 16.14 > 规模回归：3.6 万+ 已领取书目下，三态筛选与'全选+未领取'枚举均不报错、计数与集合精确（web_app/worker_app role）  13219ms

 Test Files  1 passed | 2 skipped (3)
      Tests  24 passed | 5 skipped (29)
   Start at  03:31:47
   Duration  34.53s (transform 2.16s, setup 0ms, collect 4.94s, tests 30.38s, environment 1ms, prepare 760ms)

{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
CATALOG_BATCH_DICTIONARY_DRIFT=0
CATALOG_BATCH_POSTGRES_VERIFICATION=PASS
CATALOG_BATCH_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-indexnow-sweep-postgres-verification

命令：`bash scripts/run-indexnow-sweep-postgres-verification.sh`；退出码 **0**；耗时 54.36 秒。

```text
WO6_RETRY http=429 delay_ms=352939 attempt=1
WO6_RETRY http=500 delay_ms=309178 attempt=1
WO6_RETRY http=503 delay_ms=312854 attempt=1
WO6_PRESSURE wait_ms=931 http_ms=970 poll_ms=1000 remaining=19996 main_calls=4
WO6_FAIRNESS scan_completion_position=3 delivered_before_scan=1 backlog=301
WO6_TIMEOUT sitemap_wait_ms=10296 http_timeout_ms=10000
   ✓ WO6 real publication, scheduler, lanes and HTTP > limits due work to 200 and empty outbox still admits recovery scans  2854ms
   ✓ WO6 real publication, scheduler, lanes and HTTP > main backlog of 20000 claims does not delay light delivery beyond a polling cycle  1842ms
   ✓ WO6 real publication, scheduler, lanes and HTTP > alternates delivery backlog with actual sitemap and sweep without starvation  6373ms
   ✓ WO6 real publication, scheduler, lanes and HTTP > real 10 second timeout yields to a newly queued sitemap then retries via scan  10714ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  03:32:46
   Duration  31.06s (transform 1.51s, setup 0ms, collect 3.56s, tests 25.84s, environment 0ms, prepare 199ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-wo6-secrets.S2qkoE/integration-result.json
WO6_INTEGRATION=PASS passed=20 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
WO6_DICTIONARY_DRIFT=0
WO6_POSTGRES_VERIFICATION=PASS
WO6_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-p1-05b-postgres-verification

命令：`bash scripts/run-p1-05b-postgres-verification.sh`；退出码 **1**；耗时 162.84 秒。

```text

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/preview-opening-postgres.test.ts
   23:10  warning  'Prisma' is defined but never used           @typescript-eslint/no-unused-vars
  439:11  warning  'second' is assigned a value but never used  @typescript-eslint/no-unused-vars
  497:11  warning  'held' is assigned a value but never used    @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/promo-claim-batch-control-postgres.test.ts
  47:3  warning  'TaskAdminError' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/promo-claim-release-postgres.test.ts
  206:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

✖ 21 problems (3 errors, 18 warnings)
  1 error and 7 warnings potentially fixable with the `--fix` option.

P1_05B_DATABASE_CLEANED=yes
```

## run-p1-06-postgres-verification

命令：`bash scripts/run-p1-06-postgres-verification.sh`；退出码 **1**；耗时 152.96 秒。

```text

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/preview-opening-postgres.test.ts
   23:10  warning  'Prisma' is defined but never used           @typescript-eslint/no-unused-vars
  439:11  warning  'second' is assigned a value but never used  @typescript-eslint/no-unused-vars
  497:11  warning  'held' is assigned a value but never used    @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/promo-claim-batch-control-postgres.test.ts
  47:3  warning  'TaskAdminError' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/tasks/promo-claim-release-postgres.test.ts
  206:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

✖ 21 problems (3 errors, 18 warnings)
  1 error and 7 warnings potentially fixable with the `--fix` option.

DISPOSABLE_DATABASE_CLEANED=yes
```

## run-p1-08b-postgres-verification

命令：`bash scripts/run-p1-08b-postgres-verification.sh`；退出码 **0**；耗时 168.83 秒。

```text
   ✓ P1-08B Credential Worker > returns account_inactive and prevents ambiguous active rows at the database boundary  972ms
   ✓ P1-08B Credential Worker > uses the database UNIQUE constraint as final fingerprint arbitration  690ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  03:40:52
   Duration  29.05s (transform 1.39s, setup 0ms, collect 2.17s, tests 24.66s, environment 0ms, prepare 501ms)

POSTGRES_VERSION=16.14 (Debian 16.14-1.pgdg13+1)
MIGRATION_DEPLOY=PASS
MIGRATION_REAPPLY=PASS
SCHEMA_DIFF=PASS
P1_06_REGRESSION=PASS
P1_07_REGRESSION=PASS
P1_08B_POSTGRES_VERIFICATION=PASS
DISPOSABLE_DATABASE_CLEANED=yes
```

## run-phase-b-entity-fix-postgres-verification

命令：`bash scripts/run-phase-b-entity-fix-postgres-verification.sh`；退出码 **0**；耗时 42.04 秒。

```text

 ✓ |node| tests/integration/entity-fix/moboreader-foundation-swap.test.ts (6 tests) 8494ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > dry-run: reports the pre-fix rows, the apply target, readyToRun=true, and writes nothing  1807ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > apply: swaps code/name by id, keeps every id and foreign-key count identical, and commits  1472ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > rollback: reverses a committed apply exactly, round-tripping ids and counts  1538ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > rejects with row_not_found and writes nothing when neither known code exists  1106ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > rejects with multiple_rows_found and writes nothing when a second row shares a candidate code  1380ms
   ✓ Phase B entity fix — Channel/SourceApp swap (Postgres) > targets the UPDATE by id: an unrelated row is never touched, and the real row's id never changes  1134ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  03:41:52
   Duration  11.13s (transform 245ms, setup 0ms, collect 236ms, tests 8.49s, environment 2ms, prepare 202ms)

PHASE_B_ENTITY_FIX_INTEGRATION_TESTS=PASS
PHASE_B_ENTITY_FIX_POSTGRES_CLEANUP=PASS
```

## run-phase-d-postgres-verification

命令：`bash scripts/run-phase-d-postgres-verification.sh`；退出码 **0**；耗时 117.21 秒。

```text
   ✓ catalog finalize PostgreSQL state machine > does not claim finalize until every page has left pending/processing  745ms
   ✓ catalog finalize PostgreSQL state machine > rejects a stale execution token with the real fencing predicate  572ms
   ✓ catalog finalize PostgreSQL state machine > rejects a stale lease epoch with the real fencing predicate  564ms
   ✓ catalog finalize PostgreSQL state machine > rejects a stale worker owner with the real fencing predicate  688ms
   ✓ catalog finalize PostgreSQL state machine > rejects a lease whose locked_until has expired  639ms
   ✓ catalog finalize PostgreSQL state machine > terminalizes an expired exhausted finalize lease and marks finalization failed  596ms
   ✓ catalog finalize PostgreSQL state machine > lets web_app formally re-finalize with a full budget, monotonic epoch, and idempotent replay  682ms
   ✓ catalog finalize PostgreSQL state machine > retries failed pages without erasing EOF evidence and rearms exactly one new finalize generation  795ms

 Test Files  4 passed (4)
      Tests  83 passed (83)
   Start at  03:42:32
   Duration  88.37s (transform 1.52s, setup 0ms, collect 2.71s, tests 82.66s, environment 1ms, prepare 453ms)

PHASE_D_PG_GATED_TESTS=PASS
PHASE_D_POSTGRES_CLEANUP=PASS
```

## run-phase-d-role-password-postgres-verification

命令：`bash scripts/run-phase-d-role-password-postgres-verification.sh`；退出码 **0**；耗时 30.44 秒。

```text
ERROR: network-side scram-sha-256 verification failed for PostgreSQL role 'migration_owner' -- its password file no longer matches the database (run 'up' again to re-align, or check $P1_12_MIGRATION_OWNER_PASSWORD_FILE)
PHASE_D_ROLE_STEP=verify_before_align
PHASE_D_ROLE_VERIFY_BEFORE_ALIGN=FAILED_AS_EXPECTED
psql: error: connection to server at "postgres" (172.23.0.2), port 5432 failed: FATAL:  password authentication failed for user "migration_owner"
ERROR: network-side scram-sha-256 verification failed for PostgreSQL role 'migration_owner' -- its password file no longer matches the database (run 'up' again to re-align, or check $P1_12_MIGRATION_OWNER_PASSWORD_FILE)
PHASE_D_ROLE_STEP=align
PHASE_D_ROLE_ALIGN=DONE
PHASE_D_ROLE_STEP=align_is_idempotent
PHASE_D_ROLE_ALIGN_REPEAT=DONE
PHASE_D_ROLE_STEP=verify_after_align
PHASE_D_ROLE_VERIFY_AFTER_ALIGN=PASSED
PHASE_D_ROLE_PASSWORD_SELF_HEAL=PASS
PHASE_D_ROLE_POSTGRES_CLEANUP=PASS
```

## run-preview-account-hold-postgres-verification

命令：`bash scripts/run-preview-account-hold-postgres-verification.sh`；退出码 **0**；耗时 18.83 秒。

```text

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep

 ✓ |node| tests/integration/tasks/preview-account-hold-postgres.test.ts (5 tests) 568ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  03:44:47
   Duration  3.07s (transform 719ms, setup 0ms, collect 1.12s, tests 568ms, environment 0ms, prepare 294ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-preview-hold-secrets.Ia6f2E/integration-result.json
PREVIEW_HOLD_INTEGRATION=PASS passed=5 skipped=0 filtered=false
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PREVIEW_HOLD_DICTIONARY_DRIFT=0
PREVIEW_HOLD_POSTGRES_VERIFICATION=PASS
PREVIEW_HOLD_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-preview-opening-postgres-verification

命令：`bash scripts/run-preview-opening-postgres-verification.sh`；退出码 **0**；耗时 17.54 秒。

```text
   ✓ preview-opening · enqueue-published (real Postgres) > stats is read-only and matches article-level admission/grouping exactly  486ms
   ✓ preview-opening · enqueue-published (real Postgres) > apply produces the exact same task shape a live publish-time trigger would produce for the same article  544ms
   ✓ preview-opening · enqueue-published (real Postgres) > already-fresh, account-held, and in-flight books are skipped -- matching what a live trigger would also skip  305ms
   ✓ preview-opening · clearing the backlog unblocks publish-triggered previews > a book stuck behind a backlog task is skipped as in-flight before cancel-backlog, and enqueues cleanly after  456ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
   Start at  03:45:00
   Duration  7.46s (transform 1.09s, setup 0ms, collect 1.72s, tests 4.26s, environment 0ms, prepare 400ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-preview-opening-secrets.XAlEnP/integration-result.json
PREVIEW_OPENING_INTEGRATION=PASS passed=26 skipped=0 filtered=false
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PREVIEW_OPENING_DICTIONARY_DRIFT=0
PREVIEW_OPENING_POSTGRES_VERIFICATION=PASS
PREVIEW_OPENING_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-promo-claim-batch-control-postgres-verification

命令：`bash scripts/run-promo-claim-batch-control-postgres-verification.sh`；退出码 **0**；耗时 19.86 秒。

```text
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 3.3 重新批准 > 批次停在 system_hold:approval_expired 且从未放行过任何分片时，真实 web_app 角色可以重新批准；恢复后 scheduler 能正常放行  420ms
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 3.4 枚举盲区：同一本书挂在另一个批次排队分片下 > 批次 A 枚举出排队分片；批次 B 选中重叠书被 queued_in_other_batch 挡住，不重叠部分正常入片；中止 A 后重叠书可以入片  494ms
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 3.4 枚举盲区：同一本书挂在另一个批次排队分片下 > 批次 A 的分片因批次级暂停而处于 paused 时，批次 B 的重叠书同样被 queued_in_other_batch 挡住  455ms
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 3.5 批次详情 DTO：分片列表 / 领取统计 / 预计完成时间 / parentRawStatus > 生命周期批次：getAdminTaskDetail 返回 promoClaimLifecycle（分片列表+统计+ETA）与 parentRawStatus（用于旧路径按钮可点性判定）  388ms
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 3.5 批次详情 DTO：分片列表 / 领取统计 / 预计完成时间 / parentRawStatus > 六分类口径：混合 decision 的真实条目聚合出正确的六桶计数，互斥且加总等于总数  453ms
   ✓ promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres) > 真实角色边界（D7） > web_app 角色能完成批次级暂停/恢复/中止；同一角色仍然读不到凭据密文列  307ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  03:45:18
   Duration  9.78s (transform 987ms, setup 0ms, collect 1.57s, tests 6.79s, environment 0ms, prepare 310ms)

{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PROMO_CLAIM_BATCH_CONTROL_DICTIONARY_DRIFT=0
PROMO_CLAIM_BATCH_CONTROL_POSTGRES_VERIFICATION=PASS
PROMO_CLAIM_BATCH_CONTROL_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-promo-claim-release-postgres-verification

命令：`bash scripts/run-promo-claim-release-postgres-verification.sh`；退出码 **0**；耗时 24.7 秒。

```text
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > 首次放行：awaiting_release 分片被放行为 pending，写 deadlineAt/releaseCount/firstReleasedAt，并留下一条审计  417ms
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > 回退开关：关闭时批次进入 lifecycle_disabled（分片不动、零条目写入）；重新开启后自动恢复并放行  315ms
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > D5 凭据三条件 > 缺少有效凭据（无 active 行）→ credential_not_ready；补上就绪凭据后自动恢复并放行  338ms
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > D5 凭据三条件 > 凭据存在但从未校验（last_validated_at 为空）→ not_validated；校验后自动恢复  333ms
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > D4/§5.7 错过截止时间 > 连续两次单纯超时（无意图记录）→ deadline_missed_twice；此后不再被 select-next 选中（需要人工处理）  322ms
   ✓ promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres) > 并发放行：同一账号 100 次并发触发，任意时刻至多一个分片处于 pending/processing > 100 次并发放行只有恰好一次成功，其余全部 admission_blocked  1231ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  03:45:38
   Duration  8.48s (transform 624ms, setup 0ms, collect 1.01s, tests 6.13s, environment 0ms, prepare 496ms)

{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PROMO_CLAIM_RELEASE_DICTIONARY_DRIFT=0
PROMO_CLAIM_RELEASE_POSTGRES_VERIFICATION=PASS
PROMO_CLAIM_RELEASE_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-publication-preview-postgres-verification

命令：`bash scripts/run-publication-preview-postgres-verification.sh`；退出码 **1**；耗时 228.42 秒。

```text
 FAIL  |node| tests/integration/tasks/publication-preview-postgres.test.ts > publication preview real roles > mixed local adapter load N=500 through real worker and legal <=200 publish batches
Error: Test timed out in 180000ms.
    231|
    232|   for (const size of [50, 500]) it(`mixed local adapter load N=${size}…
       |                                 ^
    233|     const rows = [];
    234|     for (let i = 0; i < size; i++) rows.push(await seed(i));

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
   Start at  03:46:01
   Duration  190.57s (transform 973ms, setup 0ms, collect 1.51s, tests 188.29s, environment 0ms, prepare 150ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-publication-preview-secrets.75yjCG/integration-result.json
PUBLICATION_PREVIEW_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-sitemap-refresh-postgres-verification

命令：`bash scripts/run-sitemap-refresh-postgres-verification.sh`；退出码 **0**；耗时 23.42 秒。

```text
   ✓ sitemap refresh on disposable PostgreSQL 16.14 > covers processing-time publications with exactly one queued follow-up  478ms
   ✓ sitemap refresh on disposable PostgreSQL 16.14 > authorizes real web_app sessions, coalesces concurrent clicks and audits in one transaction  668ms
   ✓ sitemap refresh on disposable PostgreSQL 16.14 > CLI dry-run computes locale counts with zero database and file writes  1073ms
   ✓ sitemap refresh on disposable PostgreSQL 16.14 > CLI apply enqueues as web_app; worker publishes atomically and status reports pending/processing/failure  613ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  03:49:56
   Duration  7.76s (transform 1.09s, setup 0ms, collect 1.68s, tests 4.60s, environment 0ms, prepare 319ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-sitemap-refresh-secrets.zXqyi0/integration-result.json
SITEMAP_REFRESH_INTEGRATION=PASS passed=11 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
SITEMAP_REFRESH_DICTIONARY_DRIFT=0
SITEMAP_REFRESH_POSTGRES_VERIFICATION=PASS
SITEMAP_REFRESH_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-tagging-public-auto-postgres-verification

命令：`bash scripts/run-tagging-public-auto-postgres-verification.sh`；退出码 **0**；耗时 151.51 秒。

```text

 ✓ |node| tests/integration/tagging/public-auto-postgres.test.ts (11 tests) 138115ms
   ✓ WO7 public auto real roles > records isolated 25-book classification throughput for the future approval checklist  1368ms
   ✓ WO7 public auto real roles > EXPLAIN bounds source probes at representative volume with and without small-table statistics  135479ms

 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  03:50:14
   Duration  142.17s (transform 1.05s, setup 0ms, collect 1.84s, tests 139.52s, environment 0ms, prepare 151ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-tagging-public-auto-secrets.4fu6gV/integration-result.json
WO7_INTEGRATION=PASS passed=26 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
P2_06_5_DICTIONARY_DRIFT=0
P2_06_5_POSTGRES_VERIFICATION=PASS
P2_06_5_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-worker-light-postgres-verification

命令：`bash scripts/run-worker-light-postgres-verification.sh`；退出码 **0**；耗时 15.35 秒。

```text
WO5_PRESSURE wait_ms=74 execution_ms=396 total_ms=470 poll_ms=1000 remaining=19998 upstream_calls=2

 ✓ |node| tests/integration/tasks/worker-light-postgres.test.ts (12 tests) 3391ms
   ✓ WO5 real roles, schedule isolation and worker load > light refresh completes in one 1000 ms polling interval behind 20000 claim items  2176ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  03:52:46
   Duration  5.44s (transform 500ms, setup 0ms, collect 830ms, tests 3.39s, environment 0ms, prepare 291ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-wo5-secrets.XIQgeV/integration-result.json
WO5_INTEGRATION=PASS passed=12 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
WO5_DICTIONARY_DRIFT=0
WO5_POSTGRES_VERIFICATION=PASS
WO5_DISPOSABLE_DATABASE_CLEANED=yes
```

## run-x6-site-setting-postgres-verification

命令：`bash scripts/run-x6-site-setting-postgres-verification.sh`；退出码 **2**；耗时 3.53 秒。

```text
psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory
	Is the server running locally and accepting connections on that socket?
DISPOSABLE_DATABASE_CLEANED=yes
```

## run-x9-postgres-verification

命令：`bash scripts/run-x9-postgres-verification.sh`；退出码 **1**；耗时 11.03 秒。

```text
 FAIL  |node| tests/integration/task-admin/x9-postgres.test.ts > X9 disposable PostgreSQL enforcement > keeps the generic worker transition unable to exit manual_review_required
AssertionError: expected [Function] to throw error matching /permission denied for table side_eff…/i but got 'Illegal side-effect transition: manua…'
    146|     // read/write. Then use the owner connection only to reach (and ve…
    147|     // generic transition graph itself rather than letting role denial…
    148|     await expect(transitionSideEffectIntent(worker, {
       |     ^
    149|       effectKey: keys.worker,
    150|       status: "confirmed",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  03:53:03
   Duration  2.60s (transform 828ms, setup 0ms, collect 1.27s, tests 277ms, environment 0ms, prepare 332ms)

X9_DISPOSABLE_DATABASE_CLEANED=yes
```

## build

命令：`npm run build`；退出码 **0**；耗时 82.24 秒。

```text
├ ƒ /sitemap/[fileName]
├ ƒ /tags
├ ƒ /tags/canonical
├ ƒ /tags/mappings
├ ƒ /tasks
├ ƒ /tasks/[id]
├ ƒ /templates
├ ƒ /two-factor/challenge
└ ƒ /two-factor/setup


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

```

## compose-root

命令：`docker compose -f docker-compose.yml config --format json`；退出码 **0**；耗时 0.21 秒。

配置摘要见 `compose-root.json`；三套均为本地无真实秘密的 fixture env。

## compose-preproduction

命令：`docker compose -f docker-compose.yml -f infra/preproduction/docker-compose.yml config --format json`；退出码 **0**；耗时 0.26 秒。

配置摘要见 `compose-preproduction.json`；三套均为本地无真实秘密的 fixture env。

## compose-production-like

命令：`docker compose -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json`；退出码 **0**；耗时 0.26 秒。

配置摘要见 `compose-production-like.json`；三套均为本地无真实秘密的 fixture env。

## articles-admin-rerun-1

命令：`npm test -- --maxWorkers=4 tests/ui/articles-admin.test.tsx`；退出码 **1**；耗时 13.34 秒。

```text
 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
 ❯ tests/ui/articles-admin.test.tsx:1146:5
    1144|      * far cheaper under jsdom.
    1145|      */
    1146|     it("勾选超过上限（200 篇）时展示提示并禁用批量发布按钮", () => {
       |     ^
    1147|       const many = Array.from({ length: 201 }, (_, index) => ({
    1148|         ...DRAFT_ROW,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 100 passed (101)
   Start at  03:54:44
   Duration  12.27s (transform 539ms, setup 0ms, collect 938ms, tests 10.30s, environment 648ms, prepare 108ms)

```

## articles-admin-rerun-2

命令：`npm test -- --maxWorkers=4 tests/ui/articles-admin.test.tsx`；退出码 **1**；耗时 15.0 秒。

```text
 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
 ❯ tests/ui/articles-admin.test.tsx:1146:5
    1144|      * far cheaper under jsdom.
    1145|      */
    1146|     it("勾选超过上限（200 篇）时展示提示并禁用批量发布按钮", () => {
       |     ^
    1147|       const many = Array.from({ length: 201 }, (_, index) => ({
    1148|         ...DRAFT_ROW,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 100 passed (101)
   Start at  03:54:58
   Duration  13.63s (transform 553ms, setup 0ms, collect 1.05s, tests 11.20s, environment 834ms, prepare 138ms)

```

## publication-preview-rerun

命令：`bash scripts/run-publication-preview-postgres-verification.sh`；退出码 **0**；耗时 81.98 秒。

```text
   ✓ publication preview real roles > an unexpected middle publish SQL failure still queues only the committed prefix  334ms
   ✓ publication preview real roles > concurrent overlapping requests and different source/account aliases reserve each novel once  683ms
   ✓ publication preview real roles > mixed local adapter load N=50 through real worker and legal <=200 publish batches  6649ms
   ✓ publication preview real roles > mixed local adapter load N=500 through real worker and legal <=200 publish batches  60423ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  03:55:19
   Duration  73.69s (transform 1.27s, setup 0ms, collect 1.98s, tests 70.47s, environment 0ms, prepare 220ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-publication-preview-secrets.tF2RSx/integration-result.json
PUBLICATION_PREVIEW_INTEGRATION=PASS passed=12 skipped=0 filtered=false
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PUBLICATION_PREVIEW_DICTIONARY_DRIFT=0
PUBLICATION_PREVIEW_POSTGRES_VERIFICATION=PASS
PUBLICATION_PREVIEW_DISPOSABLE_DATABASE_CLEANED=yes
```

## full-test-confirmation

命令：`npm test -- --maxWorkers=4`；退出码 **1**；耗时 845.16 秒。

```text
 FAIL  |node| tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts > one-off 应用容器的真实运行时行为
 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
 FAIL  |ui| tests/ui/use-server-exports-guard.test.ts > "use server" files export only async actions (module-eval ReferenceError guard) > never lets a "use server" file export a type re-export list, interface, enum, class, or non-async const
Error: Test timed out in 5000ms.
 FAIL  |node| tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > PASS：全部未设置
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL：地板配成 0（必改1修正后，正整数不再允许 0）
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL：min>max
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-secret-consumers.test.ts > secret consumer preflight model > fails closed when a traverse directory grants any access to others
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > sitemap bash 5 registration, single-side and invalid checks
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > PASS：全关未登记
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL catalog_write：未登记但 catalog 打开
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL unknown：登记了枚举外的值
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL invalid：已登记但值不是严格 true/false
Error: Test timed out in 15000ms.
 FAIL  |node| tests/backend/runtime/x8-gate-catalog.test.ts > X8 gate command: `gate catalog-write status` against the REAL docker compose binary (group 4) > runs to completion in a clean shell -- no ambient compose env beyond PATH/HOME, and no stub
Error: Test timed out in 15000ms.
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  8 failed | 453 passed | 37 skipped (498)
      Tests  12 failed | 6855 passed | 394 skipped (7261)
     Errors  5 errors
   Start at  03:56:35
   Duration  842.91s (transform 23.19s, setup 0ms, collect 209.34s, tests 2142.43s, environment 143.92s, prepare 55.38s)

```

Unhandled Error / Rejection / Uncaught Exception 检索：True。


## targeted

命令：`npm test -- --maxWorkers=4 tests/backend/indexnow/sweep-wiring.test.ts tests/backend/tasks/worker-lanes.test.ts tests/backend/tasks/scheduler-boundary.test.ts tests/backend/tasks/worker-light-fairness.test.ts tests/backend/tasks/worker-startup.test.ts`；退出码 **0**。

```text

 Test Files  5 passed (5)
      Tests  42 passed (42)
   Start at  03:24:21
   Duration  2.35s (transform 700ms, setup 0ms, collect 3.03s, tests 494ms, environment 0ms, prepare 183ms)

```
