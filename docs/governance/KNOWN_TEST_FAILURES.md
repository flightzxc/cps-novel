# 已知测试失败登记表

本表只登记已在指定干净基线上重复出现的失败。后续验收若完整命中同一编号的
测试文件、用例名、失败断言和通过/失败集，可直接引用本编号；任一项不同都必须重新调查。

- `COVERAGE-GAP-001`：`already_available` 分支无单测覆盖；`grep -rn already_available tests/` 零命中，本轮不补。

## KTF-001 · P1-07 unknown intent 状态机断言

| 字段 | 登记值 |
|---|---|
| 状态 | `RESOLVED_ON_fix/side-effect-intent-blocked-confirm-fence（政策已定：通用图关闭 claim_retry_blocked -> confirmed）` |
| 干净基线 | `e9ee680004debe6be9f1c67d6c3be9deb049005e` |
| 测试文件 | `tests/integration/tasks/p1-07-postgres.test.ts` |
| 用例 | `P1-07 PostgreSQL 16 runtime > commits side-effect intent independently and blocks unknown retry` |
| 失败断言 | 预期 `claim_retry_blocked -> confirmed` 拒绝且抛 `Illegal side-effect transition`，实际 promise 成功并返回 `status=confirmed` |
| 第 1 次 | `25 passed / 1 failed (26)` |
| 第 2 次 | `25 passed / 1 failed (26)` |
| 判定 | 两次失败集完全相同，确认为本轮修改前已存在 |

复现使用独立 PostgreSQL 16 临时数据库，先应用基线的 4 个 migration，然后在干净
detached worktree 中连续执行两次：

```text
P1_07_DATABASE_TEST=1 npx vitest run --project node tests/integration/tasks/p1-07-postgres.test.ts
```

基线实现的 `isAllowedSideEffectTransition` 明确允许
`claim_retry_blocked -> confirmed`，而该基线集成测试期待这一转移非法；本登记只确认时间归属，
不在本补丁中选择或修改状态机政策。

### KTF-001 处置（2026-09-07）

状态机政策已选定并实现：通用 worker 迁移图恢复 P1-07 原始形状（`claim_retry_blocked` 只允许进入
`manual_review_required`）；readback-only recovery 改走专用边界
`confirmSideEffectIntentByReadbackInTransaction`（必须携带 readback 证据、与 PromoLink 写入同一 fenced
事务、只接受 `prepared`/`claim_retry_blocked`）；`manual_review_required` 的出边仍只属于 X9 `resolveManualReview`。
基线集成测试原文未改，回归已在一次性 PostgreSQL 16 容器上转绿；本条不再是既有失败。
