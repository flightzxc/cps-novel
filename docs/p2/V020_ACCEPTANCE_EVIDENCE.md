# P2-12 纵向验收证据

时间：2026-08-19（Asia/Tokyo）
分支：`feature/v0.2.0-acceptance`

> 下列为本 worktree 实际执行的命令和原始输出。生产 migration / HTTP 验收尚未执行，只在发布检查单中保留为 Owner SOP 待办。

## 1. 基线、分支和冻结件

```bash
git branch --show-current
git rev-parse --short HEAD
git rev-parse feature/v0.2.0-p2-seo-round
git merge-base HEAD feature/v0.2.0-p2-seo-round
git status --short -- prisma src
find prisma/migrations -mindepth 1 -maxdepth 1 -type d | sort
git diff --check
```

```text
feature/v0.2.0-acceptance
8975626
8975626d1963f594fe07a44869e0c1f2acf88d5a
8975626d1963f594fe07a44869e0c1f2acf88d5a
prisma/migrations/20260803090000_p1_initial_schema
prisma/migrations/20260804090000_p1_08_credential_status_parity
prisma/migrations/20260804140000_p1_08b_admin_auth_persistence
prisma/migrations/20260818120000_v020_foundation_shared
```

`git status --short -- prisma src` 与 `git diff --check` 均为 0 行输出：本轮未改 `src/`、`prisma/`、谓词族、db-retry、`deps.ts` 或 contracts，且零新增 migration。

## 2. P2-12 定向验收

```bash
npm test -- --project node tests/integration/p2-12-vertical-acceptance.test.ts tests/backend/publication/promo-whitespace-boundaries.test.ts tests/backend/runtime/p2-12-acceptance-safety.test.ts tests/backend/runtime/p2-12-admin-e2e-smoke.test.ts
```

```text
> cps-novel@0.1.0 test
> vitest run --project node tests/integration/p2-12-vertical-acceptance.test.ts tests/backend/publication/promo-whitespace-boundaries.test.ts tests/backend/runtime/p2-12-acceptance-safety.test.ts tests/backend/runtime/p2-12-admin-e2e-smoke.test.ts

 RUN  v3.2.7 /Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel-integration

 ✓ |node| tests/backend/runtime/p2-12-acceptance-safety.test.ts (3 tests) 3ms
 ✓ |node| tests/backend/runtime/p2-12-admin-e2e-smoke.test.ts (3 tests) 4ms
 ✓ |node| tests/backend/publication/promo-whitespace-boundaries.test.ts (1 test) 3ms
 ✓ |node| tests/integration/p2-12-vertical-acceptance.test.ts (1 test) 4ms

 Test Files  4 passed (4)
      Tests  8 passed (8)
   Start at  01:13:08
   Duration  336ms (transform 165ms, setup 0ms, collect 293ms, tests 14ms, environment 0ms, prepare 216ms)
```

## 3. 全量测试

```bash
npm test
```

```text
 Test Files  126 passed | 8 skipped (134)
      Tests  1515 passed | 85 skipped (1600)
   Start at  01:13:32
   Duration  23.76s (transform 2.52s, setup 0ms, collect 12.07s, tests 34.83s, environment 17.19s, prepare 6.04s)
```

全量输出中的 stderr 为既有故障注入用例主动打印（cache invalidation / dispatcher / db-retry）；Vitest 终态为 126 files / 1515 tests PASS。

## 4. CLI safety gate 实跑

```bash
DATABASE_URL='<fixture-postgres-url>' npx --yes tsx scripts/acceptance/p2-12-acceptance-cli.ts \
  --output /tmp/p2-12-acceptance-cli-report.json \
  --database-url-sha256 783f4c2faa69d5dd21e92d2109d2ae5d942b2405877d7074cb9d6b261b6b85de
```

```text
{"status":"pass","reportFile":"/tmp/p2-12-acceptance-cli-report.json"}
```

报告原始结果（未包含 `DATABASE_URL`）：

```text
"mode": "read_only_acceptance",
"status": "pass",
"command": "vitest run --project node tests/integration/p2-12-vertical-acceptance.test.ts",
"exitCode": 0,
"stderr": ""
```

## 5. Lint

```bash
npm run lint
```

```text
> cps-novel@0.1.0 lint
> eslint

tests/backend/indexnow/delivery-handler.test.ts
  99:36  warning  '_input' is defined but never used  @typescript-eslint/no-unused-vars
  99:63  warning  '_init' is defined but never used   @typescript-eslint/no-unused-vars

tests/backend/indexnow/fake-db.ts
  352:24  warning  '_args' is defined but never used  @typescript-eslint/no-unused-vars

✖ 3 problems (0 errors, 3 warnings)
```

退出码 0；无本轮新增 lint error/warning，3 条 warning 均在既有 IndexNow 文件。

## 6. TypeScript 基线

```bash
npm run typecheck
```

```text
> cps-novel@0.1.0 typecheck
> tsc --noEmit

tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(58,34): error TS2345: Argument of type '{ version: any; namedScopeLabels: any; rules: any; byKey: Map<any, any>; }' is not assignable to parameter of type 'null | undefined'.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(64,45): error TS7006: Parameter 'tag' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(77,41): error TS7006: Parameter 'rule' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(78,41): error TS7006: Parameter 'rule' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(79,39): error TS7006: Parameter 'rule' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(84,66): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(95,75): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(109,60): error TS7006: Parameter 'item' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(113,32): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(135,32): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(136,33): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(143,70): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(144,70): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(145,70): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(146,66): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(147,75): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(153,24): error TS2339: Property 'restricted_seed_count' does not exist on type '{ source: string; normalization_for_collision_audit_only: string; active_keyword_count: any; coverage_insufficient_tag_count: any; disabled_seed_count: number; disabled: any[]; tie_break: string; }'.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(204,70): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(227,66): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(237,75): error TS7006: Parameter 'row' implicitly has an 'any' type.
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts(268,7): error TS2322: Type '{ version: string; sha256: "781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4"; }' is not assignable to type 'null | undefined'.
```

退出码 2；精确 21 条，全部仍位于基线已知的 `lexicon-eligibility.test.ts`，本轮文件 0 条。

## 7. Dictionary drift 命令的本地边界

```bash
node scripts/check-database-dictionary-drift.mjs
```

```text
PrismaClientInitializationError:
Invalid `prisma.$queryRawUnsafe()` invocation:
error: Environment variable not found: DATABASE_URL.
  --> schema.prisma:12
Validation Error Count: 1
```

退出码 1。该命令需连接目标 PostgreSQL，当前本地环境未提供 `DATABASE_URL`；本证据不将它写成 PASS。相应 checkbox 保留在 `V020_RELEASE_CHECKLIST.md` 中，由 Owner 在部署 SOP 目标环境执行。

## 8. CPS 只读仓库不变式

```bash
git -C '/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux' status --porcelain
git -C '/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux' rev-parse HEAD
```

```text
d77c3b968285698529cf97c7f0f97b286d7a2a9c
```

`status --porcelain` 为 0 行，HEAD 仍为冻结基线。
