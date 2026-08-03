# P1-07 SOL 5.6 聚焦代码审计归档

## 审计结论

```text
RESULT=P1_07_FOCUSED_REVIEW_REVISE
REVIEWED_BRANCH=feature/v0.1.0-p1-worker-runtime
REVIEWED_HEAD=1342f93118ab9a05d6a6e6f9168b65e844ab2d28
BASE_MAIN=419ac82c8f8646b74b1621733a1954fdd7b12035
```

本文件忠实归档合入后执行的 SOL 5.6 只读审计结论，不将原结论改写为 PASS。审计确认原有 claim、lease、fencing、Scheduler、side-effect intent 和索引计划主体语义成立，同时发现以下三项修复要求。

## 必须修复的问题

### P1：并发 parent 聚合可被陈旧结果覆盖

`recomputeParentTask` 在聚合 item 之前没有串行化同一 parent。两个独立事务可分别完成不同 item，并基于不完整的 statement snapshot 计算；后提交事务可能覆盖正确计数。PostgreSQL 16.14 稳定复现结果为两个 item 均 `success`，但 parent 仍为 `processing`、`success_count=1`、`completed_at=NULL`。

最小修复要求：在 item 受 fencing 成功更新后、同一事务内先锁定对应 parent 行，再获取新的 statement snapshot 聚合全部 item 并更新 parent；增加双连接 barrier 回归测试，并证明不同 parent 不被全局串行化。

### P1：持久化 handler 错误未统一脱敏和限长

Worker 将原始 `Error.message` 放入 outcome，而 finalize 直接把任意 error JSON 写入 item。错误可能包含 Bearer token、JWT、API key、credential、cookie、连接串或无界文本。

最小修复要求：在统一数据库持久化边界仅保留安全 code/message，集中脱敏并施加确定长度上限；不得持久化 stack、cause、headers、response body 或完整 payload；增加对 Error、字符串 throw、未知对象及数据库 JSONB 的测试。

### P2：graceful shutdown 缺少有限 drain deadline

忽略 AbortSignal 的 handler 会让 Worker 无限等待并持续 heartbeat，阻止退出与 lease recovery。

最小修复要求：增加可配置且有默认值的 drain timeout。deadline 前允许正常结束并保持 fencing；超时后停止 heartbeat、返回 runtime、不提交迟到结果，让 lease 自然过期并由新 owner 接管。增加 abort-aware 与 abort-ignoring 两类真实测试。

## 原审计验证摘要

- build、typecheck、lint：PASS。
- backend：21/21 PASS。
- PostgreSQL `16.14-1.pgdg13+1`：原 P1-07 integration 11/11 PASS。
- 六条 pending/expired 查询均通过真实 `EXPLAIN (ANALYZE, FORMAT JSON)` 命中目标索引。
- disposable 容器和 volume 已清理。
- CPS：`clean@d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

```text
PARENT_STATE=REVISE_CONCURRENT_STALE_AGGREGATE_REPRODUCED
GRACEFUL_SHUTDOWN=REVISE_NO_FINITE_DRAIN_DEADLINE
SECURITY_BOUNDARY=REVISE_UNBOUNDED_UNREDACTED_HANDLER_ERRORS
REQUIRED_FIXES=SERIALIZE_PARENT_RECOMPUTE;SANITIZE_AND_BOUND_PERSISTED_ERRORS;ADD_BOUNDED_DRAIN_POLICY
NEXT_GATE=P1_07_FIX_AND_RERUN_FOCUSED_SOL56_REVIEW
```
