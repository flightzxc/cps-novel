# 验证命令与尾行

实现代码树检查点 b33af0b；之后只把提交说明的 trailers 合并到同一段，得到 d502504。`git diff --exit-code b33af0b d502504` 为 0。实现 tree 为 `8ebd1f4463ced0b737befee26923f53ff7cd9b19`。以下最终门禁没有与源码编辑/变异并发执行。

所有下列命令退出码为 0。全量测试日志未出现 Unhandled Error、Unhandled Rejection 或 Uncaught Exception。347 项跳过为仓库自带环境门控；本单指定的真实库套件另行运行，均非跳过。

preproduction-secret-consumers 与 articles-admin 在最终全量运行均通过，未触发工单指定的失败后各重跑两次分支。未改客户端组件；全量测试仍包含 admin-secret-boundary。

初轮只读/运行环境问题：沙盒阻止 Turbopack 绑定本地端口，获本地构建权限后最终 build 通过。初轮旧契约失败均已按新任务归属/服务数修正；最后全量 0 failed。

## 类型检查

```bash
npm run typecheck
```

```text

> cps-novel@0.4.5 typecheck
> tsc --noEmit

```

## 全量测试

```bash
npm test -- --maxWorkers=4
```

```text
 ✓ |ui| tests/ui/article-rebind-page-wiring.test.ts (3 tests) 1ms

 Test Files  454 passed | 35 skipped (489)
      Tests  6789 passed | 347 skipped (7136)
   Start at  00:13:28
   Duration  84.24s (transform 3.74s, setup 0ms, collect 21.59s, tests 243.96s, environment 23.40s, prepare 12.07s)

```

## 生产构建

```bash
npm run build
```

```text
├ ƒ /templates
├ ƒ /two-factor/challenge
└ ƒ /two-factor/setup


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

```

## 真实 scheduler/worker 角色与压力

```bash
bash scripts/run-worker-light-postgres-verification.sh
```

```text

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

stdout | tests/integration/tasks/worker-light-postgres.test.ts > WO5 real roles, schedule isolation and worker load > light refresh completes in one 1000 ms polling interval behind 20000 claim items
WO5_PRESSURE wait_ms=17 execution_ms=73 total_ms=90 poll_ms=1000 remaining=19999 upstream_calls=1

 ✓ |node| tests/integration/tasks/worker-light-postgres.test.ts (10 tests) 928ms
   ✓ WO5 real roles, schedule isolation and worker load > light refresh completes in one 1000 ms polling interval behind 20000 claim items  561ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  00:11:31
   Duration  1.36s (transform 136ms, setup 0ms, collect 219ms, tests 928ms, environment 0ms, prepare 35ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-wo5-secrets.U5ZCQJ/integration-result.json
WO5_INTEGRATION=PASS passed=10 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
WO5_DICTIONARY_DRIFT=0
WO5_POSTGRES_VERIFICATION=PASS
WO5_DISPOSABLE_DATABASE_CLEANED=yes
```

## sitemap 真实库

```bash
bash scripts/run-sitemap-refresh-postgres-verification.sh
```

```text
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

 ✓ |node| tests/integration/tasks/sitemap-refresh-postgres.test.ts (11 tests) 908ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  00:06:42
   Duration  1.53s (transform 247ms, setup 0ms, collect 388ms, tests 908ms, environment 0ms, prepare 41ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-sitemap-refresh-secrets.KmRTxT/integration-result.json
SITEMAP_REFRESH_INTEGRATION=PASS passed=11 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
SITEMAP_REFRESH_DICTIONARY_DRIFT=0
SITEMAP_REFRESH_POSTGRES_VERIFICATION=PASS
SITEMAP_REFRESH_DISPOSABLE_DATABASE_CLEANED=yes
```

## phase-d 真实库

```bash
bash scripts/run-phase-d-postgres-verification.sh
```

```text
P1_07_INDEX_PLANS={"channel_sync_task_item":{"pending":["channel_sync_task_item_pending_global_idx","channel_sync_active_scope_uidx"],"expired":["channel_sync_task_item_expired_lease_idx","channel_sync_type_status_created_idx"]},"generic_task_item":{"pending":["generic_task_item_pending_global_idx","generic_task_active_scope_uidx"],"expired":["generic_task_item_expired_lease_idx","generic_task_origin_key"]}}
 ✓ |node| tests/integration/tasks/p1-07-postgres.test.ts (28 tests) 4441ms
   ✓ P1-07 PostgreSQL 16 runtime > serializes same-parent recompute before taking a fresh aggregate snapshot  307ms
   ✓ P1-07 PostgreSQL 16 runtime > recovers after a real worker child process is killed and restarted  566ms
   ✓ P1-07 PostgreSQL 16 runtime > bounds an abort-ignoring handler and fences its late result  303ms
 ✓ |node| tests/integration/tasks/catalog-finalize-postgres.test.ts (8 tests) 888ms
 ✓ |node| tests/integration/tasks/p1-13-postgres-acceptance.test.ts (6 tests) 729ms

 Test Files  4 passed (4)
      Tests  83 passed (83)
   Start at  00:07:40
   Duration  16.40s (transform 268ms, setup 0ms, collect 498ms, tests 15.10s, environment 0ms, prepare 87ms)

PHASE_D_PG_GATED_TESTS=PASS
PHASE_D_POSTGRES_CLEANUP=PASS
```

## 领取放行真实库

```bash
bash scripts/run-promo-claim-release-postgres-verification.sh
```

```text

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

 ✓ |node| tests/integration/tasks/promo-claim-release-postgres.test.ts (18 tests) 1220ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  00:08:42
   Duration  1.58s (transform 116ms, setup 0ms, collect 178ms, tests 1.22s, environment 0ms, prepare 23ms)

{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
PROMO_CLAIM_RELEASE_DICTIONARY_DRIFT=0
PROMO_CLAIM_RELEASE_POSTGRES_VERIFICATION=PASS
PROMO_CLAIM_RELEASE_DISPOSABLE_DATABASE_CLEANED=yes
```

## 启动与 preflight 守卫

```bash
npm test -- --maxWorkers=4 tests/backend/tasks/worker-lanes.test.ts
```

```text
> vitest run --maxWorkers=4 tests/backend/tasks/worker-lanes.test.ts


 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

 ✓ |node| tests/backend/tasks/worker-lanes.test.ts (15 tests) 313ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  00:09:53
   Duration  1.64s (transform 301ms, setup 0ms, collect 1.20s, tests 313ms, environment 0ms, prepare 21ms)

```

## 调度挂载与原轮播回归

```bash
npm test -- --maxWorkers=4 tests/backend/tasks/periodic-sweep.test.ts tests/backend/tasks/scheduler-boundary.test.ts tests/backend/home-carousel/cron.test.ts
```

```text
> vitest run --maxWorkers=4 tests/backend/tasks/periodic-sweep.test.ts tests/backend/tasks/scheduler-boundary.test.ts tests/backend/home-carousel/cron.test.ts


 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

 ✓ |node| tests/backend/tasks/scheduler-boundary.test.ts (1 test) 1ms
 ✓ |node| tests/backend/tasks/periodic-sweep.test.ts (6 tests) 3ms
 ✓ |node| tests/backend/home-carousel/cron.test.ts (14 tests) 7ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
   Start at  00:11:11
   Duration  557ms (transform 284ms, setup 0ms, collect 788ms, tests 11ms, environment 0ms, prepare 91ms)

```

## 部署身份与配置

```bash
npm test -- --maxWorkers=4 tests/backend/runtime/x8-identity-lifecycle.test.ts tests/backend/runtime/x8-production-like-contract.test.ts tests/backend/tasks/worker-lanes.test.ts
```

```text
 ✓ |node| tests/backend/runtime/x8-identity-lifecycle.test.ts (11 tests) 2965ms
   ✓ X8 release identity lifecycle: candidate write -> health check -> promote (group 1) > promotes the candidate to the committed identity once every service reports healthy  467ms
   ✓ X8 release identity lifecycle: candidate write -> health check -> promote (group 1) > a service that never even started (no container at all) fails the same way as one that started but never became healthy  321ms
   ✓ X8 release identity lifecycle: candidate write -> health check -> promote (group 1) > D-9b §4.3: the previous-identity ledger > archives the pre-existing committed identity to the previous ledger before promoting the new one  327ms

 Test Files  3 passed (3)
      Tests  55 passed (55)
   Start at  00:09:31
   Duration  3.10s (transform 383ms, setup 0ms, collect 1.56s, tests 5.84s, environment 0ms, prepare 69ms)

```

## 三套 compose

无真实秘密的 fixture env；以下命令均返回 0。提取渲染 JSON 的 `services["worker-light"]` 保存在本目录三份 compose JSON 中。实际 env 透传、共同配置相等、预生产禁止现场构建由 worker-light-compose-contract 及 preproduction-deployment-contract 覆盖，最终全量均通过。

```bash
docker compose -f docker-compose.yml config --format json
docker compose -f docker-compose.yml -f infra/preproduction/docker-compose.yml config --format json
docker compose -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json
```

## CPS 参考隔离

未使用或修改 CPS 参考代码。交付检查旧冻结参考 worktree HEAD 为 d77c3b968285698529cf97c7f0f97b286d7a2a9c，status 为 0 行。
