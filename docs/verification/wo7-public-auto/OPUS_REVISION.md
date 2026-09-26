# 工单 7：Opus 复核修订（2026-09-27）

- 原分支 `feat/tagging-public-auto-projection`，从复核 HEAD `3045fe0` 追加；修复/变异检查点 `188deef2f8588fe2f2fbee43dfdc2391cc9207a1`，证据文档另有提交，最终 HEAD 见交付回复。
- worker 的 `initializeMaterializedTaskTags` 关闸直接静默返回，不查询数据库；web 单本和内容批量入口仍各记一条关闸日志。开闸执行路径不变。
- 三个开关分别关闭时，连续 1,000 次观察均为 info=0、error=0、查询/入队=0。原开闸分段、终态判断、失败隔离用例继续通过。
- 未合并、未推送、未开 PR、未部署、未改变开关。

## 本次改动文件

- `src/server/tagging/materialization.ts`
- `tests/backend/tagging/materialization.test.ts`
- `tests/integration/tagging/public-auto-postgres.test.ts`
- `docs/verification/wo7-public-auto/DELIVERY.md`
- `docs/verification/wo7-public-auto/OPUS_REVISION.md`

## 门禁命令和尾行

全量 6,784 passed、0 failed，日志中无 Unhandled Error / Unhandled Rejection / Uncaught Exception。全量默认跳过未启用的真实库套件；独立运行器 26 passed、0 skipped，字典 drift=0。

```bash
npm run typecheck
```

退出码：0。尾行：

```text
> cps-novel@0.4.5 typecheck
> tsc --noEmit
```

```bash
npm test -- --maxWorkers=4 tests/backend/tagging/materialization.test.ts
```

退出码：0。尾行：

```text

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo7-public-auto-tags

 ✓ |node| tests/backend/tagging/materialization.test.ts (10 tests) 7ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  01:52:24
   Duration  236ms (transform 48ms, setup 0ms, collect 64ms, tests 7ms, environment 0ms, prepare 41ms)
```

```bash
bash scripts/run-tagging-public-auto-postgres-verification.sh
```

退出码：0。尾行：

```text
 ✓ |node| tests/integration/tagging/public-auto-postgres.test.ts (11 tests) 41766ms
   ✓ WO7 public auto real roles > records isolated 25-book classification throughput for the future approval checklist  522ms
   ✓ WO7 public auto real roles > EXPLAIN bounds source probes at representative volume with and without small-table statistics  40690ms

 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  01:55:08
   Duration  43.39s (transform 399ms, setup 0ms, collect 700ms, tests 42.34s, environment 0ms, prepare 64ms)

JSON report written to /var/folders/y7/z3lp3zhj21jfby__zf_nf8680000gn/T/cps-novel-tagging-public-auto-secrets.lCCjBq/integration-result.json
WO7_INTEGRATION=PASS passed=26 skipped=0
{"status":"ok","models":53,"recordCount":1235,"activeCount":1165,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
P2_06_5_DICTIONARY_DRIFT=0
P2_06_5_POSTGRES_VERIFICATION=PASS
P2_06_5_DISPOSABLE_DATABASE_CLEANED=yes
```

```bash
npm test -- --maxWorkers=4
```

退出码：0。尾行：

```text
 ✓ |ui| tests/ui/article-rebind-page-wiring.test.ts (3 tests) 1ms
 ✓ |ui| tests/ui/seo/novel-hreflang-regression.test.ts (2 tests) 1ms

 Test Files  453 passed | 35 skipped (488)
      Tests  6784 passed | 348 skipped (7132)
   Start at  01:55:42
   Duration  129.20s (transform 5.16s, setup 0ms, collect 31.02s, tests 377.53s, environment 35.67s, prepare 19.36s)
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
npx eslint src/server/tagging/materialization.ts tests/backend/tagging/materialization.test.ts tests/integration/tagging/public-auto-postgres.test.ts
```

退出码：0。尾行：

```text
（无输出）
```

全量 lint 仍有基线的 3 errors / 15 warnings（与 Opus 复核一致）；此次清理测试中未使用的 `Prisma`、`off` 两项告警，变更文件 eslint 为 0。保留的三个错误为 `promo-link-claim-dialog.tsx` 的 effect 内 setState、`promo-claim-release.ts` 的 prefer-const、`canonical-tag-translation-overlay.test.ts` 的 this-alias；其余基线告警详见本地 `.tmp/wo7-revision/lint-clean.log`。`.tmp` 是运行器产物，显式排除，不变更源码 lint 规则。

## 变异

命令直接指定路径：

```bash
npm test -- --maxWorkers=4 tests/backend/tagging/materialization.test.ts -t '1000 worker observations'
```

将 worker 路径的 `gatesOpen(..., false)` 恢复为默认逐条日志；三个千次调用用例全部变红。每个失败用例观测到 1,000 条 info 调用。测试后从原始字节恢复已提交检查点，`git diff --quiet` 返回 0；未留变异代码。

```text
per-item-log exit= 1 checkpoint= 188deef2f8588fe2f2fbee43dfdc2391cc9207a1
     28|     for (let i = 0; i < 1000; i++) await initializeMaterializedTaskTag…
     29|     expect(console.info).not.toHaveBeenCalled();
       |                              ^
     30|     expect(console.error).not.toHaveBeenCalled();
     31|     expect(createTaggingAutoClassifyTask).not.toHaveBeenCalled();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯


 Test Files  1 failed (1)
      Tests  3 failed | 7 skipped (10)
   Start at  01:54:49
   Duration  325ms (transform 52ms, setup 0ms, collect 70ms, tests 28ms, environment 0ms, prepare 42ms)

restore git diff --quiet exit= 0
```
