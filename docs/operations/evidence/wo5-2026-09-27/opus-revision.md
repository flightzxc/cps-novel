# 工单 5：Opus 复核修订（2026-09-27）

- 原分支 `feat/worker-light-lane-and-schedules`，从复核 HEAD `d96023b` 追加；修复/变异检查点 `a9357b8086ad34028eb2bcc7ec78218409ebddce`。证据文档另有提交，最终 HEAD 见交付回复。
- scheduler 每轮完成后按 `((finished / interval) + 1) * interval + 2 - finished`（整数除法）计算等待秒数。仍每轮启动独立进程，TERM 处理保留；超时跳过已过边界，不连跑。纯函数和实际 shell 循环都覆盖正常、精确边界、超时、90 秒间隔。
- 每日扫描固定同日时间桶，东京 sitemap 为 04:00，入队窗口 `[04:00, 04:15)`。窗口内复用唯一键去重；过窗同日候选持久化 `misfire_skip`，当天时刻以前不枚举前一天。分钟扫描严格当前分钟，首页轮播的到期语义不变。
- PostgreSQL 生产时钟仍在取得任务类型 advisory lock 后核对，窗口内在途任务继续记录 `previous_scan_in_flight`。
- 精确东京时刻使用可控数据库时钟单测，覆盖 04:00:30 + 04:07 仅入队一次、只有 04:09、04:15/04:20 过窗、候选在锁前后跨窗、在途合并和分钟行为。真实库以实际数据库当前时间偏移 9/20 分钟验证相同窗口判定、唯一键、角色及 skip_reason 写入；不修改数据库系统时钟。
- 本轮无 schema/env/compose/开关变更，未合并、未推送、未开 PR、未部署。轻量 handler 工厂移除未使用的 db 形参，同步调用；compose 测试移除六个未使用的解构变量。

## 本次改动文件

- `docs/operations/WO5_LIGHT_LANE_DELIVERY_2026-09-27.md`
- `scripts/lib/scheduler-timing.sh`
- `scripts/run-scheduler-loop.sh`
- `src/lib/tasks/periodic-sweep.ts`
- `src/lib/tasks/scheduler.ts`
- `tests/backend/runtime/worker-light-compose-contract.test.ts`
- `tests/backend/tasks/daily-sweep-window.test.ts`
- `tests/backend/tasks/periodic-sweep.test.ts`
- `tests/backend/tasks/scheduler-loop-timing.test.ts`
- `tests/integration/tasks/worker-light-postgres.test.ts`
- `worker/handlers/sitemap-daily-fallback.ts`
- `worker/index.ts`
- `docs/operations/evidence/wo5-2026-09-27/opus-revision.md`

## 门禁命令与尾行

全量 6,807 passed、0 failed，日志中无 Unhandled Error / Unhandled Rejection / Uncaught Exception。默认全量跳过未启用的真实库套件；三个指定真实库运行器均全绿。没有失败的偶发超时用例，因此没有单独重跑。

```bash
npm run typecheck
```

退出码：0。尾行：

```text
> cps-novel@0.4.5 typecheck
> tsc --noEmit
```

```bash
npm test -- --maxWorkers=4 tests/backend/tasks/scheduler-loop-timing.test.ts tests/backend/tasks/periodic-sweep.test.ts tests/backend/tasks/daily-sweep-window.test.ts tests/backend/tasks/worker-lanes.test.ts tests/backend/runtime/worker-light-compose-contract.test.ts
```

退出码：0。尾行：

```text
   ✓ scheduler interval alignment > actual loop uses the aligned delay and handles TERM: 'overrun skips the elapsed boundary wi…'  719ms
   ✓ scheduler interval alignment > actual loop uses the aligned delay and handles TERM: 'non-minute interval'  603ms

 Test Files  5 passed (5)
      Tests  40 passed (40)
   Start at  01:53:53
   Duration  3.12s (transform 638ms, setup 0ms, collect 2.81s, tests 3.80s, environment 1ms, prepare 213ms)
```

```bash
bash scripts/run-worker-light-postgres-verification.sh
```

退出码：0。尾行：

```text

 ✓ |node| tests/integration/tasks/worker-light-postgres.test.ts (12 tests) 1413ms
   ✓ WO5 real roles, schedule isolation and worker load > light refresh completes in one 1000 ms polling interval behind 20000 claim items  790ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  01:55:27
   Duration  2.44s (transform 226ms, setup 0ms, collect 367ms, tests 1.41s, environment 0ms, prepare 144ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-wo5-secrets.Zq77DQ/integration-result.json
WO5_INTEGRATION=PASS passed=12 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
WO5_DICTIONARY_DRIFT=0
WO5_POSTGRES_VERIFICATION=PASS
WO5_DISPOSABLE_DATABASE_CLEANED=yes
```

```bash
bash scripts/run-sitemap-refresh-postgres-verification.sh
```

退出码：0。尾行：

```text
RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo5-light-lane

 ✓ |node| tests/integration/tasks/sitemap-refresh-postgres.test.ts (11 tests) 1118ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  01:56:13
   Duration  2.13s (transform 346ms, setup 0ms, collect 529ms, tests 1.12s, environment 0ms, prepare 98ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-sitemap-refresh-secrets.5VijTK/integration-result.json
SITEMAP_REFRESH_INTEGRATION=PASS passed=11 skipped=0
{"status":"ok","models":53,"recordCount":1236,"activeCount":1166,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
SITEMAP_REFRESH_DICTIONARY_DRIFT=0
SITEMAP_REFRESH_POSTGRES_VERIFICATION=PASS
SITEMAP_REFRESH_DISPOSABLE_DATABASE_CLEANED=yes
```

```bash
bash scripts/run-phase-d-postgres-verification.sh
```

退出码：0。尾行：

```text
   ✓ P2-05 PostgreSQL 16.14 write paths > failed and empty refreshes retain old valid preview state  630ms

 Test Files  4 passed (4)
      Tests  83 passed (83)
   Start at  01:56:26
   Duration  29.21s (transform 635ms, setup 0ms, collect 1.14s, tests 26.83s, environment 0ms, prepare 160ms)

PHASE_D_PG_GATED_TESTS=PASS
PHASE_D_POSTGRES_CLEANUP=PASS
```

```bash
npm test -- --maxWorkers=4
```

退出码：0。尾行：

```text
 ✓ |ui| tests/ui/seo/novel-hreflang-regression.test.ts (2 tests) 2ms
 ✓ |ui| tests/ui/article-rebind-page-wiring.test.ts (3 tests) 1ms

 Test Files  456 passed | 35 skipped (491)
      Tests  6807 passed | 349 skipped (7156)
   Start at  01:57:52
   Duration  118.17s (transform 5.84s, setup 0ms, collect 36.11s, tests 321.26s, environment 37.85s, prepare 20.57s)
```

```bash
npm run lint -- --ignore-pattern '.tmp/**'
```

退出码：1。尾行：

```text
  206:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

✖ 18 problems (3 errors, 15 warnings)
  1 error and 7 warnings potentially fixable with the `--fix` option.
```

```bash
npx eslint src/lib/tasks/periodic-sweep.ts src/lib/tasks/scheduler.ts tests/backend/tasks/periodic-sweep.test.ts tests/backend/tasks/daily-sweep-window.test.ts tests/backend/tasks/scheduler-loop-timing.test.ts tests/integration/tasks/worker-light-postgres.test.ts tests/backend/runtime/worker-light-compose-contract.test.ts worker/handlers/sitemap-daily-fallback.ts worker/index.ts
```

退出码：0。尾行：

```text
（无输出）
```

双 worker / 20,000 条主队列压力结果：

```text
WO5_PRESSURE wait_ms=26 execution_ms=108 total_ms=134 poll_ms=1000 remaining=19999 upstream_calls=1
```

`bash -n scripts/run-scheduler-loop.sh scripts/lib/scheduler-timing.sh` 退出 0。

两单新增的九项 lint 告警已经分别清理（本分支七项、工单 7 两项）。本分支完整源码 lint 为基线的 3 errors / 15 warnings，变更文件 eslint 为 0。保留的三个错误为 `promo-link-claim-dialog.tsx` 的 effect 内 setState、`promo-claim-release.ts` 的 prefer-const、`canonical-tag-translation-overlay.test.ts` 的 this-alias，其余基线告警见 `.tmp/wo5-revision/lint-clean.log`。首次不带 ignore 的 lint 扫入旧 `.tmp/npm-install-incomplete` 依赖副本，已终止该进程；最终命令只排除临时产物，不修改源码规则。

## 变异与恢复

1. 实际循环替换为 `sleep "$interval"`，运行下面第一个命令：4 个实际循环对齐用例变红，4 个纯函数用例仍绿，证明测试覆盖接线。
2. 每日构造器的 `dailySweepWindowMinutes: 15` 改为 `1`，移除扩展窗口，运行第二个命令：仅 04:09 触发用例变红。

```bash
npm test -- --maxWorkers=4 tests/backend/tasks/scheduler-loop-timing.test.ts
npm test -- --maxWorkers=4 tests/backend/tasks/daily-sweep-window.test.ts -t 'only 04:09'
```

每次变异均恢复已提交检查点的原始字节，`git diff --quiet` 返回 0，之后再执行真实库和全量门禁。

```text
fixed-sleep exit= 1 checkpoint= a9357b8086ad34028eb2bcc7ec78218409ebddce
     34|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯


 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)
   Start at  01:54:48
   Duration  2.12s (transform 21ms, setup 0ms, collect 10ms, tests 1.94s, environment 0ms, prepare 36ms)

restore git diff --quiet exit= 0
remove-window exit= 1 checkpoint= a9357b8086ad34028eb2bcc7ec78218409ebddce
     48|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
   Start at  01:54:50
   Duration  362ms (transform 134ms, setup 0ms, collect 201ms, tests 7ms, environment 0ms, prepare 31ms)

restore git diff --quiet exit= 0
```

参考工作区只读核对：旧 CPS 冻结工作区 HEAD 仍为 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`，`git status --porcelain` 0 行。本轮不读取或操作 X 系列参考仓。
