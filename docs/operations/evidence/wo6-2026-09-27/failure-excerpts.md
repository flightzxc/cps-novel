# 未通过门禁的原始错误摘录

日志摘录仅对数据库连接串脱敏并去除行尾空格；未将额外超时归入 B-15/B-16。完整日志仍在本 worktree 的 `.tmp/wo6-verification/`。

## run-p1-05b-postgres-verification

```text
> eslint


/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/scripts/preproduction/image-identity.mjs
  36:53  warning  'EX_UNAVAILABLE' is assigned a value but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/catalog-sync/_components/promo-link-claim-dialog.tsx
  186:84  error  Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/catalog-sync/_components/promo-link-claim-dialog.tsx:186:84
  184 |
  185 |   useEffect(() => {
> 186 |     if (!context || !lifecycleEnabled || !allAccountsChosen || stage !== "form") { setEstimate(null); return; }
      |                                                                                    ^^^^^^^^^^^ Avoid calling setState() directly within an effect
  187 |     let cancelled = false;
  188 |     void readPromoClaimShardEstimateAction({
  189 |       selection: selectionRef.current, channelAccounts: accounts, requestId: crypto.randomUUID(),  react-hooks/set-state-in-effect

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/tasks/_lib/task-copy.ts
  64:38  warning  '_family' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/lib/adapters/moboreader-rate-limit.ts
  439:17  warning  '_endpoint' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/lib/tasks/promo-claim-release.ts
  139:3  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  656:7  error    'admissionBlocked' is never reassigned. Use 'const' instead                    prefer-const

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/database/wal-retention-guards.test.ts
  8:3  warning  'readFileSync' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/indexnow/delivery-handler.test.ts
  99:36  warning  '_input' is defined but never used  @typescript-eslint/no-unused-vars
  99:63  warning  '_init' is defined but never used   @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/indexnow/fake-db.ts
  385:24  warning  '_args' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/tagging/canonical-tag-translation-overlay.test.ts
  78:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/catalog-batch/postgres.test.ts
  1066:9  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1092:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1105:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1118:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts
  198:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

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

```text
> eslint


/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/scripts/preproduction/image-identity.mjs
  36:53  warning  'EX_UNAVAILABLE' is assigned a value but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/catalog-sync/_components/promo-link-claim-dialog.tsx
  186:84  error  Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/catalog-sync/_components/promo-link-claim-dialog.tsx:186:84
  184 |
  185 |   useEffect(() => {
> 186 |     if (!context || !lifecycleEnabled || !allAccountsChosen || stage !== "form") { setEstimate(null); return; }
      |                                                                                    ^^^^^^^^^^^ Avoid calling setState() directly within an effect
  187 |     let cancelled = false;
  188 |     void readPromoClaimShardEstimateAction({
  189 |       selection: selectionRef.current, channelAccounts: accounts, requestId: crypto.randomUUID(),  react-hooks/set-state-in-effect

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/app/(admin)/tasks/_lib/task-copy.ts
  64:38  warning  '_family' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/lib/adapters/moboreader-rate-limit.ts
  439:17  warning  '_endpoint' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/src/lib/tasks/promo-claim-release.ts
  139:3  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  656:7  error    'admissionBlocked' is never reassigned. Use 'const' instead                    prefer-const

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/database/wal-retention-guards.test.ts
  8:3  warning  'readFileSync' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/indexnow/delivery-handler.test.ts
  99:36  warning  '_input' is defined but never used  @typescript-eslint/no-unused-vars
  99:63  warning  '_init' is defined but never used   @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/indexnow/fake-db.ts
  385:24  warning  '_args' is defined but never used  @typescript-eslint/no-unused-vars

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/backend/tagging/canonical-tag-translation-overlay.test.ts
  78:11  error  Unexpected aliasing of 'this' to local variable  @typescript-eslint/no-this-alias

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/catalog-batch/postgres.test.ts
  1066:9  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1092:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1105:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  1118:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

/Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep/tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts
  198:7  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

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

## run-x6-site-setting-postgres-verification

```text
psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory
	Is the server running locally and accepting connections on that socket?
DISPOSABLE_DATABASE_CLEANED=yes
```

## run-x9-postgres-verification

```text

 RUN  v3.2.7 /Users/chenweifeng/Documents/cps海阅/wo6-indexnow-sweep

 ❯ |node| tests/integration/task-admin/x9-postgres.test.ts (3 tests | 1 failed) 277ms
   ✓ X9 disposable PostgreSQL enforcement > lets web update only status, response_shape, and confirmed_at 102ms
   ✓ X9 disposable PostgreSQL enforcement > gives two concurrent admins one CAS winner and commits exactly one audit 75ms
   × X9 disposable PostgreSQL enforcement > keeps the generic worker transition unable to exit manual_review_required 42ms
     → expected [Function] to throw error matching /permission denied for table side_eff…/i but got 'Illegal side-effect transition: manua…'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |node| tests/integration/task-admin/x9-postgres.test.ts > X9 disposable PostgreSQL enforcement > keeps the generic worker transition unable to exit manual_review_required
AssertionError: expected [Function] to throw error matching /permission denied for table side_eff…/i but got 'Illegal side-effect transition: manua…'

- Expected:
/permission denied for table side_effect_intent/i

+ Received:
"Illegal side-effect transition: manual_review_required -> confirmed"

 ❯ tests/integration/task-admin/x9-postgres.test.ts:148:5
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

## full-test-final

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
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

## full-test-confirmation

```text
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |node| tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts > one-off 应用容器的真实运行时行为
Error: Hook timed out in 10000ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".
 ❯ tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts:340:3
    338|   }, 300_000);
    339|
    340|   afterAll(async () => {
       |   ^
    341|     for (const tag of [PRESENT_TAG, ABSENT_TAG, BUILT_TAG]) untag(tag);
    342|     spawnSync("docker", ["network", "rm", PROBE_NETWORK, BYPASS_NETWOR…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/13]⎯


⎯⎯⎯⎯⎯⎯ Failed Tests 12 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |ui| tests/ui/articles-admin.test.tsx > ArticleList · 列表与批量 > 列表批量发布（C-21） > 勾选超过上限（200 篇）时展示提示并禁用批量发布按钮
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/ui/articles-admin.test.tsx:1146:5
    1144|      * far cheaper under jsdom.
    1145|      */
    1146|     it("勾选超过上限（200 篇）时展示提示并禁用批量发布按钮", () => {
       |     ^
    1147|       const many = Array.from({ length: 201 }, (_, index) => ({
    1148|         ...DRAFT_ROW,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/13]⎯

 FAIL  |ui| tests/ui/use-server-exports-guard.test.ts > "use server" files export only async actions (module-eval ReferenceError guard) > never lets a "use server" file export a type re-export list, interface, enum, class, or non-async const
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/ui/use-server-exports-guard.test.ts:226:3
    224|
    225| describe('"use server" files export only async actions (module-eval Re…
    226|   it('never lets a "use server" file export a type re-export list, int…
       |   ^
    227|     const files = await collectSourceFiles(".");
    228|     expect(files.length).toBeGreaterThan(0);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > PASS：全部未设置
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts:489:3
    487|   }
    488|
    489|   maybeIt("PASS：全部未设置", () => {
       |   ^
    490|     const r = runGateBash5({});
    491|     expect(r.status).toBe(0);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL：地板配成 0（必改1修正后，正整数不再允许 0）
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts:513:3
    511|   });
    512|
    513|   maybeIt("FAIL：地板配成 0（必改1修正后，正整数不再允许 0）", () => {
       |   ^
    514|     const r = runGateBash5({ MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETL…
    515|     expect(r.status).toBe(65);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL：min>max
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts:433:3
    431|   });
    432|
    433|   maybeIt("FAIL：min>max", () => {
       |   ^
    434|     const r = runGateBash5({ PROMO_CLAIM_SHARD_SIZE_MIN: "2000" });
    435|     expect(r.status).toBe(65);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-secret-consumers.test.ts > secret consumer preflight model > fails closed when a traverse directory grants any access to others
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-secret-consumers.test.ts:339:3
    337|   });
    338|
    339|   it("fails closed when a traverse directory grants any access to othe…
       |   ^
    340|     const { fixture, env } = await fullStubFixture();
    341|     // 🔴 只把一个 traverse 目录的 other 位放开，其余一切不变：named ACL 仍然

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > sitemap bash 5 registration, single-side and invalid checks
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-write-gates.test.ts:418:3
    416|   }
    417|
    418|   maybeIt("sitemap bash 5 registration, single-side and invalid checks…
       |   ^
    419|     for (const feature of ["false", "true"]) for (const write of ["fal…
    420|       const flags = { FEATURE_SITEMAP_AUTO_REFRESH: feature, SITEMAP_A…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > PASS：全关未登记
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-write-gates.test.ts:427:3
    425|   });
    426|
    427|   maybeIt("PASS：全关未登记", () => {
       |   ^
    428|     const r = runGateBash5({});
    429|     expect(r.status).toBe(0);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL catalog_write：未登记但 catalog 打开
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-write-gates.test.ts:433:3
    431|   });
    432|
    433|   maybeIt("FAIL catalog_write：未登记但 catalog 打开", () => {
       |   ^
    434|     const r = runGateBash5({ FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL…
    435|     expect(r.status).toBe(65);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[10/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL unknown：登记了枚举外的值
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-write-gates.test.ts:439:3
    437|   });
    438|
    439|   maybeIt("FAIL unknown：登记了枚举外的值", () => {
       |   ^
    440|     const r = runGateBash5({ PREPROD_APPROVED_OPEN_WRITE_GATES: "index…
    441|     expect(r.status).toBe(65);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[11/13]⎯

 FAIL  |node| tests/backend/runtime/preproduction-write-gates.test.ts > bash 5 下的行为对照（docker bash:5.2，不可用则跳过） > FAIL invalid：已登记但值不是严格 true/false
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/preproduction-write-gates.test.ts:445:3
    443|   });
    444|
    445|   maybeIt("FAIL invalid：已登记但值不是严格 true/false", () => {
       |   ^
    446|     const r = runGateBash5({
    447|       PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/13]⎯

 FAIL  |node| tests/backend/runtime/x8-gate-catalog.test.ts > X8 gate command: `gate catalog-write status` against the REAL docker compose binary (group 4) > runs to completion in a clean shell -- no ambient compose env beyond PATH/HOME, and no stub
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/backend/runtime/x8-gate-catalog.test.ts:1275:36
    1273|   const dockerComposeAvailable = spawnSync("docker", ["compose", "vers…
    1274|
    1275|   it.skipIf(!dockerComposeAvailable)("runs to completion in a clean sh…
       |                                    ^
    1276|     writeIdentity({
    1277|       composeProject: "cps-novel-x8-gate-status-realdocker-test",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/13]⎯

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 5 unhandled errors during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../cps%E6%B5%B7%E9%98%85/wo6-indexnow-sweep/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7


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
