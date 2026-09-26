# 变异验证

代码检查点：`b33af0b`。每项独立变异，结束后恢复原始 bytes，`git diff --quiet` 返回 0，`git status --porcelain` 为空。

## 1-startup-guard

命令：`npm test -- --maxWorkers=4 tests/backend/tasks/worker-lanes.test.ts`；退出码 1。

```text
 FAIL  |node| tests/backend/tasks/worker-lanes.test.ts > worker lane safety and shared configuration > startup rejects upstream catalog_scan on light
 FAIL  |node| tests/backend/tasks/worker-lanes.test.ts > worker lane safety and shared configuration > startup rejects upstream moboreader.preview_refresh.v1 on light
 FAIL  |node| tests/backend/tasks/worker-lanes.test.ts > worker lane safety and shared configuration > startup rejects upstream promo_link.claim.v1 on light
 FAIL  |node| tests/backend/tasks/worker-lanes.test.ts > worker lane safety and shared configuration > light starts with the approved set and rejects empty or unapproved sets
 Test Files  1 failed (1)
      Tests  4 failed | 11 passed (15)
```

## 2-coalescing

命令：`bash scripts/run-worker-light-postgres-verification.sh`；退出码 1。

```text
 FAIL  |node| tests/integration/tasks/worker-light-postgres.test.ts > WO5 real roles, schedule isolation and worker load > coalesces pending scans, persists reason and does not reenqueue a skipped bucket
 FAIL  |node| tests/integration/tasks/worker-light-postgres.test.ts > WO5 real roles, schedule isolation and worker load > coalesces processing scans, persists reason and does not reenqueue a skipped bucket
 Test Files  1 failed (1)
      Tests  2 failed | 8 passed (10)
```

## 3-misfire-policy

命令：`npm test -- --maxWorkers=4 tests/backend/tasks/periodic-sweep.test.ts`；退出码 1。

```text
 FAIL  |node| tests/backend/tasks/periodic-sweep.test.ts > periodic sweep schedules > uses only Tokyo's current 04:00 minute, with no missed-day catch-up
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

## 4-direct-refresh

命令：`bash scripts/run-worker-light-postgres-verification.sh`；退出码 1。

```text
 FAIL  |node| tests/integration/tasks/worker-light-postgres.test.ts > WO5 real roles, schedule isolation and worker load > fallback coalesces a processing refresh and sets its follow-up marker
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

## 4b-scheduler-direct-refresh

命令：`npm test -- --maxWorkers=4 tests/backend/tasks/periodic-sweep.test.ts`；退出码 1。

```text
 FAIL  |node| tests/backend/tasks/periodic-sweep.test.ts > periodic sweep schedules > uses only Tokyo's current 04:00 minute, with no missed-day catch-up
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

## 5-unregistered-upstream

命令：`npm test -- --maxWorkers=4 tests/backend/tasks/worker-lanes.test.ts`；退出码 1。

```text
 FAIL  |node| tests/backend/tasks/worker-lanes.test.ts > worker lane safety and shared configuration > derives upstream tasks from every handler factory and catches an omitted registration
 Test Files  1 failed (1)
      Tests  1 failed | 14 passed (15)
```

```text
1-startup-guard RED 1
1-startup-guard RESTORED git diff --quiet=0; status empty
2-coalescing RED 1
2-coalescing RESTORED git diff --quiet=0; status empty
3-misfire-policy RED 1
3-misfire-policy RESTORED git diff --quiet=0; status empty
4-direct-refresh RED 1
4-direct-refresh RESTORED git diff --quiet=0; status empty
4b-scheduler-direct-refresh RED 1
4b-scheduler-direct-refresh RESTORED git diff --quiet=0; status empty
5-unregistered-upstream RED 1
5-unregistered-upstream RESTORED git diff --quiet=0; status empty
```
