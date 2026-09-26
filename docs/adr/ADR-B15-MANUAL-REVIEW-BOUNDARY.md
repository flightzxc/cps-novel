# B-15：SideEffectIntent 人工核对出边的数据库防线（待 Owner 裁决）

- 日期：2026-09-27
- 状态：**提案，未裁决、未实施**。本单只排查 x9，不修改其测试、grants、迁移或生命周期逻辑。
- 基线：`origin/integration/v0.4.5-2026-09-26` → `7f9dfe3a9b8122de1375540b08341c9d6e2dda62`，Final `ff1d2dd`。
- 关联：[B-15 验证报告](../governance/B15-GRANT-ASSERTIONS-VERIFICATION.md)、[领推广生命周期 ADR](ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md)。仓外登记为 `产品原型及文档/cps海阅/待办登记_领推广生命周期_2026-09-24.md` B-10/B-15。

## 1. 结论与权限事实

**x9 用例目前为“已知失败、待 Owner 裁决”。**
`tests/integration/task-admin/x9-postgres.test.ts:144–161` 在真实 worker 连接上调用状态机，期望数据库 permission denied，实际先被应用状态机拒绝。
这不是 v0.4.5 回归；主控已在 v0.4.4 `845ca02` 复现相同失败。本单没有再次运行旧版本。

现行 `infra/postgres/grants.sql:316–330,390` 为 worker 提供表级 INSERT/UPDATE/SELECT；`:176` 为 Web 提供 `(status,response_shape,confirmed_at)` UPDATE。
历史 `1b9f82c`（2026-09-03）的 diff **仅新增 worker SELECT**，INSERT/UPDATE 在该提交之前已存在；不能把三种权限都归因于该提交。
`prisma/migrations/20260803090000_p1_initial_schema/migration.sql:1237` 只有状态值域 CHECK，不能表达 OLD → NEW 迁移约束。
全量迁移内的两个 trigger 保护推广短码与追加审计（同文件 `:1318,:1333`），无 side_effect_intent 状态迁移 trigger；x6 live catalog 也确认 `triggerCount=2`。
因此 worker 用原始 SQL 或 Prisma updateMany 直接改这列，在权限/触发器层没有人工核对出边的专属防线；当前代码的应用层拒绝依然有效。

## 2. 所有现有状态写入路径与角色

下表角色是**仓库部署接线**，不是函数自行认证的数据库身份。服务依赖注入/CLI 的 PrismaClient 使用实际 `DATABASE_URL`；不能把 TypeScript 函数名当作角色保证。
Web 接线：`src/app/api/admin/_lib/route.ts:8–10` → `deps.ts:1–2` → `src/lib/db/web-prisma.ts:7`。
Worker 接线：`worker/index.ts:93`；本地受支持配置将 Web/Worker URL 分别设为 web_app/worker_app（`scripts/lib/x8-production-like-env.sh:997–998`）。

| 路径 / 调用者 | 执行角色 | 是否走通用 transition 状态机 | 能否离开 manual_review_required |
| --- | --- | --- | --- |
| 后台 POST `/api/admin/tasks/manual-reviews/resolve`（`src/app/api/admin/tasks/manual-reviews/resolve/route.ts:6–15`）→ `resolveManualReview`（`src/server/task-admin/service.ts:2769–2856`） | web_app | 否，专用人工裁决 | **唯一现有业务出边**。`:2781` 检查 task:manage + 当前会话 2FA；`:2792` 将 effect_confirmed/no_effect_confirmed 映射为 confirmed/failed；`:2806–2820` 验证当前状态并 CAS updateMany；`:2823` 同事务写 `side_effect_intent.manual_resolve` 审计（reason/requestId/actor）。重放只读审计，不再写状态。 |
| `transitionSideEffectIntent` → `transitionSideEffectIntentInTransaction`（`src/lib/tasks/side-effect-intent.ts:93–149`），调用者为领取 handler（`worker/handlers/promo-link-claim.ts:766–769,940–956,984–989`） | worker_app | 是 | **不能**。`:108–110` 将人工核对视为通用图终点，`:123–126` 先检查再 CAS。handler 仅用该函数写 failed、claim_retry_blocked、manual_review_required。 |
| `markSideEffectUnknown`（同文件 `:220–230`） | 调用者注入角色；当前运行代码无外部调用点 | 是，包装 transition | 不能；目标为 claim_retry_blocked，人工核对无出边。 |
| `writePromoLinkClaimed`（`worker/handlers/promo-link-claim.ts:456–511`）→ `confirmSideEffectIntentByReadbackInTransaction`（`src/lib/tasks/side-effect-intent.ts:191–217`） | worker_app | 否，**有独立状态守卫的专用回读确认边界** | **不能**。`:152–156` 白名单仅 prepared/claim_retry_blocked；`:200–201` 拒绝人工核对；`:210` CAS 写 confirmed。此路径不是违规旁路。 |
| handler 已有意图分支（`worker/handlers/promo-link-claim.ts:778–825`） | worker_app | 人工核对分支不调用任何 intent 状态写函数 | `:791–796` 直接返回人工核对结果，不再请求上游，只在 protectedWrite 写 PromoLink/审计。prepared/blocked 回读成功才走专用确认；旧 confirmed 记录恢复本地业务时省略 intentEffectKey，不再迁移意图。 |
| `prepareSideEffectIntent`（`src/lib/tasks/side-effect-intent.ts:50–89`） | worker_app；测试也注入 owner | 否，独立已提交建意图事务 | 只 find/create；已存在意图返回，不 update/upsert，不重置人工核对。 |
| CLI smoke：`scripts/one-book-promo-claim-smoke.ts:63`、`scripts/book-c-exact-target-claim-smoke.ts:100` 创建 PrismaClient 并执行现有 handler | 由 DATABASE_URL 决定，预期 worker_app；函数本身无硬编码角色限制 | 间接复用上述边界 | 未发现独立人工核对出边。不能因为是 CLI 就允许跳过状态机。 |
| 任意新写入代码、手工 SQL 或高权限维护连接 | worker_app 已有 UPDATE；migration_owner 为对象所有者 | 可绕过 | **权限上可能，当前业务代码未发现**。owner/superuser 可做 DDL/禁用 trigger，属于运维信任边界，不是运行角色保证能覆盖的对象。 |

普通成功领取、结果不明后的即时回读恢复、已有 prepared/blocked 意图恢复，都由 `writePromoLinkClaimed` 在任务的 protectedWrite 内调用专用确认。
`worker/runtime/worker.ts:448–459` → `src/lib/tasks/store.ts:777–936` 的 finalize 将租约围栏、PromoLink、Article 绑定、意图确认、审计与任务收尾置于同一事务。
人工裁决则只改意图与审计，明确 `automaticReconciliation: false`（task-admin service `:2837`）；它不会自动补 PromoLink 或 Article。

## 3. 静态核查

核查范围：全部 `worker/`、`src/lib/tasks/`，再交叉搜索 `src/`、`scheduler/`、`scripts/`、`prisma/migrations/`。
搜索 `sideEffectIntent`/`side_effect_intent` 的全部引用，检查 Prisma create/update/updateMany/upsert、SQL UPDATE/INSERT/CTE 和函数调用，再核对调用点；不只搜索单行 SQL。

```bash
rg -n 'sideEffectIntent|side_effect_intent' worker src/lib/tasks
rg -n 'transitionSideEffectIntent|confirmSideEffectIntentByReadback|markSideEffectUnknown' worker src scripts
rg -n 'sideEffectIntent|side_effect_intent' src scheduler scripts
rg -n 'side_effect_intent|TRIGGER' prisma/migrations
```

- `worker/` 没有直接写 side_effect_intent.status 的 Prisma/SQL 调用。
- `src/lib/tasks/` 只有 `side-effect-intent.ts:126,210` 两个 updateMany：分别为通用状态机和受控的专用回读确认；`:64` 是初次 create。
- 其它任务库引用 `promo-claim-release.ts:275`、`promo-link-status-filter.ts:118,202` 为只读 SQL；未发现原始 UPDATE、upsert、嵌套更新、模型别名或动态模型访问绕过。
- `src/server/task-admin/service.ts:2816` 是预期的 Web 人工裁决专用 CAS。
- smoke 脚本只查询 intent 并调用 handler；恢复演练脚本 `scripts/p1-13-restore-smoke.sh:143` 的 INSERT 为演练种子，不是人工核对出边。

这是本基线的静态核查结论，不是已新增 CI 防线，也不能证明未来任意动态代码都安全。本单没有添加 x9 静态守卫。

## 4. B-10 第①项：只回读核查是否需要离开人工核对

**仅核查不需要。** 可以由持有凭据的 worker 或 worker 层 CLI 调只读上游接口，收集精确目标、码、web/app URL、观测时间等证据，输出待人工确认清单；现有人工核对状态保持不变。禁止 getcode 或重建可领取任务；不能因回读一次未见码就断言 no_effect_confirmed。
当前普通领取 handler 遇到人工核对会在回读前返回，因此 B-10 需要单独的核查入口，不能把现有任务重新运行当作核查。

如果 Owner 的意图是“回读发现有效结果后**自动完成对账**”，则必须新增允许从 manual_review_required 出发的专用受控确认设计；当前 READBACK_CONFIRMABLE_STATUSES 不包含它，不能直接复用或暗中扩张。
在方案 (a) 下 worker/CLI 仅提供证据，Web 由人工裁决；在方案 (b) 下也不意味着默认允许 worker 出边，仍需另单裁决。
若未来要同一事务写 PromoLink、Article 和 confirmed，当前只更新意图的 X9 裁决不够，需要专门设计原子对账，且必须保留准确对象证据、围栏/并发控制、审计和无第二次 getcode。
后台 Web 不持有解密密钥，不应为了方案 (a) 将上游凭据读取搬到 Web。

## 5. 方案比较

| 项目 | (a) 增加数据库 BEFORE UPDATE 防线 | (b) 明确接受应用层保证 |
| --- | --- | --- |
| 保证 | OLD.status 为 manual_review_required 且 NEW.status 与之不同，仅允许 web_app；worker 原始 SQL/Prisma 绕过也拒绝 | worker 调用现有状态机被拒；静态 CI 禁止未批准状态写入。已部署 worker 的直接 SQL 权限仍可离开人工核对 |
| 实施规模 | 中：新增增量 migration、trigger/function 字典、数据库治理与 replay/真实库测试 | 小至中：改 x9 错误断言、新增有变异验证的静态守卫、更新边界文档与 ADR |
| 当前 worker 正常领取/回读恢复 | 不影响 prepared/claim_retry_blocked 出边；保持应用状态机不变 | 不改变 |
| 后台人工裁决 | web_app CAS 与同事务审计仍有效 | 不改变 |
| B-10 仅核查 | worker/CLI 只提供证据，不出人工核对状态 | 同样不需要出边 |
| 绕过与局限 | 不防可信 owner/superuser 通过 DDL 禁用防线；也不证明 Web 的直接 SQL 一定经过服务审计 | 静态扫描不能等价于数据库约束，对别名、动态 SQL、脚本、后续新增目录要持续维护 |

### (a) 待批准后的实施清单

1. 新增 `prisma/migrations/<新时间戳>_side_effect_manual_review_guard/migration.sql`，不修改历史迁移。创建 `BEFORE UPDATE` 行级 trigger，条件是 `OLD.status = 'manual_review_required' AND NEW.status IS DISTINCT FROM OLD.status`。用 SECURITY INVOKER 函数检查真实 `current_user = 'web_app'`，否则抛专用错误（建议 SQLSTATE 42501）。不要用可由应用设置的 GUC/actor 字段判断，不使用会把 current_user 变成 owner 的 SECURITY DEFINER。
2. 同状态更新允许；所有非人工核对起点保持原语义。worker 不应有 SET ROLE web_app/migration_owner 成员资格或禁用 trigger 的能力，真实库测试覆盖角色关系。维护迁移用 owner 改 schema 不受影响；owner 若直接迁移人工核对状态也会被 trigger 拒绝，特殊修复需要显式、审计化的维护决策，不能悄悄加 owner 白名单。
3. 同步 `docs/governance/database-schema-dictionary.jsonl` 的 trigger 记录与相应证据、`database-governance.md` 权限矩阵及 §12；按字典工具约定登记 routine/trigger，现行 drift 计数中 trigger 预计 2 → 3，记录数量断言同步 `tests/backend/database/p1-06-static.test.ts`。Prisma 无触发器声明，不伪造 schema model。
4. 核对 `infra/postgres/grants.sql` 的现有全函数 EXECUTE revoke 与新 trigger function 的最小调用权限；不收回 worker 正常领取必需 INSERT/UPDATE/SELECT，也不扩展 Web 的三列 UPDATE。新旧数据库迁移后均重放 grants 两次，验证 trigger 保留且有效；如需改变函数授权，必须同步字典与 grants 静态测试。
5. x9 将“应用拒绝”和“数据库拒绝”拆开：通过 transition 调用仍应是 Illegal transition；用真实 worker 直接 SQL/Prisma 更新 confirmed、failed，以及其它合法状态均须被 trigger 拒绝，且不改变 response_shape/confirmed_at。不能只加 trigger 却保留旧错误断言——旧调用在触发 SQL 前已被应用层挡住。
6. 正向覆盖 Web 两种裁决、CAS 竞争、审计失败整笔回滚、幂等；worker prepared/blocked 回读确认成功和人工核对回读确认拒绝；原子确认事务遇拒绝时 PromoLink/Article/intent/审计/任务不得半写。增加移除 trigger 后数据库负例变红的变异验证。
7. 真实库范围至少 x9、x6、phase-d、publication-preview，加领取 lifecycle/catalog-batch、batch-control、release 运行器；全量 npm test、tsc、静态与 live drift、migration 空库/存量迁移、grants 两次回放。除 B-6/B-14 经记录的超时例外，不把应用拒绝当作数据库拒绝通过。

预计主要文件：新迁移；数据库字典/治理文档；`tests/integration/task-admin/x9-postgres.test.ts`；`tests/backend/database/p1-06-static.test.ts`；`scripts/run-x9-postgres-verification.sh`；按函数权限需要评估 grants 与对应静态测试。**不需要改领取 handler 或状态机业务图。**

### (b) 待批准后的实施清单

1. `tests/integration/task-admin/x9-postgres.test.ts` 改为在真实 worker_app 连接上断言 confirmed/failed 均被 Illegal transition 拒绝，检查状态与证据未变；增加 worker 对专用 readback 边界也不能离开人工核对的负例。保留 Web 三列权限及 CAS/审计覆盖。
2. 新增 `tests/backend/tasks/side-effect-intent-write-boundary.test.ts`（建议 TypeScript AST）：worker/ 与 src/lib/tasks/ 除 `side-effect-intent.ts` 外禁止模型写入、嵌套写入和引用逃逸；原始 SQL 检查带引号/跨行/CTE 写入该表，动态 SQL 或动态模型访问不能识别时 fail closed，而不是自动放行。专用回读确认为明确例外边界，不能简单“只有函数名 transition 才合法”。把 server 的人工裁决作为独立批准边界，不允许 worker 引入 task-admin 裁决服务。
3. 以直接 updateMany、别名写入、原始 SQL UPDATE 三类变异证明静态守卫会变红；现有回读确认必须继续通过。静态测试是工程纪律，不宣传为可抵御任意动态代码的权限边界。
4. 在数据库治理与 ADR 明确“worker 具备直接 UPDATE，人工核对出边仅由应用代码约束”；schema/grants 不变、无需 migration。运行 x9/相关单测/全量/tsc 与字典 drift。

预计主要文件：x9 真实库用例、新静态守卫测试、数据库治理文档、本 ADR。没有新增数据库触发器。

## 6. 推荐及生命周期红线

**推荐 (a)，待 Owner 批准。** 人工核对意味着上游结果不明，通用 worker 已有较宽 UPDATE，数据库拒绝可防后续脚本或代码遗漏状态机守卫；这与当前“只有 X9 人工裁决能出边”的应用规则一致，且无需改变领取流程。
(b) 可作为 Owner 明确接受风险后的选择，不能把只改报错文本描述成恢复数据库保证。

两方案均不改变预读保留、独立提交意图、maxAttempts=1、结果不明只回读、租约围栏、原子确认。方案 (a) 的 trigger 只检查人工核对起点，对 prepared/blocked 的正常确认无影响。
数据库 trigger 不能代替预读/精确回读证据，也不能替代同事务确认；未来 B-10 若提出自动出边/自动对账，必须单独裁决并重验这些红线。
