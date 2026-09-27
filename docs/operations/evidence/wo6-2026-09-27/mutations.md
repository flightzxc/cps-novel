# 工单 6 变异证明

每次从实现检查点的原始字节开始，单项变异，独立执行，finally 恢复原始字节，再执行全树 `git diff --quiet`。五次均退出 0；其后统一运行最终门禁。

## 01-closed-enqueue

文件：`src/lib/tasks/indexnow-sweep.ts`；命令：`npm test -- --maxWorkers=4 tests/backend/indexnow/sweep-wiring.test.ts`；变异退出码 1；恢复 `git diff --quiet` 退出码 0。

```text
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates false/false have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates false/true have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates true/false have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates undefined/undefined have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates TRUE/true have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates  true/true have no bucket and no database access
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > closed gates true/1 have no bucket and no database access
 Test Files  1 failed (1)
      Tests  7 failed | 3 passed (10)
```

## 02-delivery-not-light

文件：`src/lib/tasks/worker-lanes.mjs`；命令：`bash scripts/run-indexnow-sweep-postgres-verification.sh`；变异退出码 1；恢复 `git diff --quiet` 退出码 0。

```text
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > published first delivery is deduplicated by scan and sent by light with exact protocol
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > 429 retries only after due scan creates a new delivery
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > 500 retries only after due scan creates a new delivery
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > 503 retries only after due scan creates a new delivery
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > 403 is terminal and later scans never retry
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > 422 is terminal and later scans never retry
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > recovers stale processing and delivers the unknown outcome again
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > main backlog of 20000 claims does not delay light delivery beyond a polling cycle
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > alternates delivery backlog with actual sitemap and sweep without starvation
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > real 10 second timeout yields to a newly queued sitemap then retries via scan
 Test Files  1 failed (1)
      Tests  10 failed | 10 passed (20)
```

## 03-no-placeholder

文件：`scheduler/index.ts`；命令：`npm test -- --maxWorkers=4 tests/backend/indexnow/sweep-wiring.test.ts`；变异退出码 1；恢复 `git diff --quiet` 退出码 0。

```text
 FAIL  |node| tests/backend/indexnow/sweep-wiring.test.ts > IndexNow minute sweep wiring > registers the production schedule and throwing scheduler placeholder
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

## 04-no-coalescing

文件：`src/lib/tasks/scheduler.ts`；命令：`bash scripts/run-indexnow-sweep-postgres-verification.sh`；变异退出码 1；恢复 `git diff --quiet` 退出码 0。

```text
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > merges pending control tasks
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > merges processing control tasks
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
```

## 05-no-fairness

文件：`worker/runtime/worker.ts`；命令：`bash scripts/run-indexnow-sweep-postgres-verification.sh`；变异退出码 1；恢复 `git diff --quiet` 退出码 0。

```text
 FAIL  |node| tests/integration/tasks/indexnow-sweep-postgres.test.ts > WO6 real publication, scheduler, lanes and HTTP > alternates delivery backlog with actual sitemap and sweep without starvation
 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
```

移除轻量批准项时，真实链路在正式启动守卫处报 `worker_light_task_unapproved: indexnow_delivery`，不能启动消费、更不能向模拟端点推送。取消轮转时只有真实积压公平性用例变红，恢复后 301 条积压场景通过。
