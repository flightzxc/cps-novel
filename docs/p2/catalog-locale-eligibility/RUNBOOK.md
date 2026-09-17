# Catalog locale eligibility v2：发布与 UAT runbook

## 目的与边界

本变更只调整 `novel_materialize` 父任务的枚举准入：新任务使用策略 v2，在派发 `novel.materialize.v1` 子任务前，以核心物化相同口径把空 locale 和产品未支持 locale 计入 `blockedReasonCounts.missing_locale` / `unsupported_locale`。核心物化仍会复核 locale；状态不符合或显式 ID 未找到仍计入 `ineligibleCount`。

不执行数据回填，不扩展 `SITE_LOCALES`，不改 slug 算法，不重写历史任务结果。`19`、`20`、映射冲突熔断产生的 NULL，以及 `fil`、`tr`、`it`、`ms` 都保留当前来源事实。

协议约定如下：

- `enumEligibilityPolicyVersion` 缺失按 v1；值 `1` 明确表示 v1；值 `2` 表示 v2。
- 只有 `novel_materialize` 可以使用 v2；未知值或其他 operation 携带 v2 均以 `catalog_batch_payload_invalid` 拒绝。
- 新建 `novel_materialize` 父任务在持久化 payload/result 和入队、枚举审计中记录值 `2`；其他新批量操作记录值 `1`。
- 版本字段不进入调用者输入，也不进入旧业务输入 fingerprint。使用旧 `requestId` 重放时仍返回原任务；修复来源事实后必须用新 `requestId` 创建新批次。
- blocked 数量大于零时，父任务继续投影为 `completed_with_errors`；这不是执行失败，也不创建 skipped/failed 叶项。

## 发布前证据

1. 对候选构建运行类型检查、lint、相关 node/ui 测试；记录构建提交和制品摘要。此文档本身不宣称发布或 UAT 已通过。
2. 使用 [READ_ONLY_INVENTORY.sql](./READ_ONLY_INVENTORY.sql) 在批准的只读连接运行。保留聚合输出，确认：
   - 缺失版本都被识别为 v1；只有 JSON number `1` / `2` 合法，JSON null、字符串 `"2"` 和其他类型必须落入非法分类；
   - v1 非终态父、子任务及有效 lease 数量；
   - v2 是否已有库存；
   - 目标批次当前的 code/name/locale 分桶，以及 `19`/`20`、NULL、`fil`/`tr`/`it`/`ms` 数量；
   - locale 分桶严格区分 SQL NULL、空白、带首尾空格的非规范值和精确值，不能把 `" en "` 展示或统计成合法 `en`；
   - slug 诊断仅保存伪名和长度/字符类别，不保存标题、raw payload 或错误正文。
3. 单独取得运行平台的旧 Worker 实例清单、制品版本与实例数。数据库库存不能证明旧进程已经退出。
4. 对目标 UAT 的选择条件做一次小批基线记录。SQL 根据当前来源事实重建筛选，不是历史快照；来源在枚举后变化时，以审计时间和同步记录解释差异。

当前 UAT 只读尝试（2026-09-15）：仓库基线为 `166fa53e0a19fc497ea16025fc13a99b1dcfeeed`；本地容器 `cps-novel-x8-local-postgres-1` 显示 `Restarting (1)`。未重启、修复或反复轮询容器，因此本轮没有 UAT 数据库聚合结果。对一次性隔离 PostgreSQL 的语法/结构验证不代表 UAT 库存已核验。

只读 SQL 已在一次性隔离 PostgreSQL `16.14` 上从仓库完整执行 `prisma migrate deploy`，以 `analyst_ro` 角色对合成数据运行。验证覆盖缺失版本、JSON number `2`、JSON null、字符串 `"2"`、非法 number、带搜索词的 `all_filtered`、四类 locale 分桶、父枚举有效 lease、直接 `slug_unhealthy` 和 `finalize_failed` 分类；脚本事务以 `ROLLBACK` 结束，容器已清理。结果为 `READ_ONLY_INVENTORY_SQL=PASS`。这项结果只证明 SQL 与当前迁移后 schema、最小权限及合成边界兼容，不证明 UAT 数据内容、任务库存或发布状态。

## 切换步骤

1. 暂停批量纳入提交入口，并记录暂停时间。等待暂停后新产生的 `catalog_batch.queued` 审计数为零；读取进度和已运行任务可以继续。
2. 停止旧 Worker 领取新任务并完成 drain。平台证据必须显示所有旧制品 Worker 实例数为 `0`；SQL 中父枚举 item、子 item 或 lease 归零都只是数据库侧证据，不能替代这个条件。
3. 部署同时兼容 v1/v2 的新 Worker，但暂不开放提交入口。核对 Worker 的实际制品版本、启动成功和 `batch.materialize.v1` / `novel.materialize.v1` 均在有效 allowlist 中。
4. 在提交入口仍关闭时，部署包含 v2 task factory 的新 Web。Web 与 Worker 必须来自同一候选源码提交和构建版本；分别核对两类实例的实际制品版本，不能让旧 Web 继续创建 v1 父任务。
5. 再运行只读库存：v1 非终态任务可以由新 Worker 按旧语义继续完成；此时不得重新枚举已完成的 v1 父任务，也不得改写历史失败。再次确认入口关闭期间没有新增 `catalog_batch.queued` 审计，并确认运行中的 Web/Worker 都是步骤 3–4 核验过的同一候选版本。
6. 开放提交入口。提交一个新的小型混合批次，确认新父 payload 和入队审计的策略版本为 `2` 后，再扩大 UAT 范围。
7. 对原 UAT 筛选使用新的 `requestId` 创建新批次。保留原任务作为历史证据，不批量 retry、不删除、不重置状态。

切换验收的计数恒等式为：

```text
selectedCount = submittedCount + ineligibleCount + alreadyLinkedCount + blockedCount
blockedCount = sum(blockedReasonCounts)
```

## UAT 验证

先用至少五条明确样本：合法 locale、NULL/空白 locale、未支持 locale、状态不符合、已关联 Novel。预期只有合法项派发子项；两种 locale 原因分别进入 blocked；状态不符合进入 `ineligibleCount`；已关联进入 `alreadyLinkedCount`。

随后验证：

- 全阻断批次生成零个子任务，枚举正常完成，任务中心显示“完成（有异常）”。
- 管理端将两类原因显示为“来源语言缺失”和“来源语言暂不受产品支持”；未知 reason key 不进入读 DTO 或浏览器。
- 父层通过后人为改变 locale 的竞态样本仍被核心拒绝，证明核心复核未被移除。
- 修复被阻断来源后，旧父任务保持原结果；新 `requestId` 的批次重新判断并可提交。
- `fil`、`tr`、`it`、`ms` 继续计为 unsupported；`19`、`20` 和熔断 NULL 继续计为 missing；没有 fallback 到 `en` 或相近语言。
- `slug_unhealthy` 仍作为叶任务个案处理，不进入 locale blocked 计数。
- `finalize_failed` 的数据库记录不能恢复 finalizer 之前的原始 locale/slug 原因；直接 `slug_unhealthy` 查询为零不能证明实际没有 slug 失败，需结合受控运行日志另行诊断。

保存父 result、两条审计的脱敏字段、子任务计数和管理端截图。验收标准是枚举时已知的 locale 不合格来源不再产生必败子项，不要求批次全绿。

## 回滚纪律

在任何代码回滚前先暂停提交并运行只读库存。

- 如果存在任何 v2 `batch.materialize.v1` 父任务处于 `pending`、`processing` 或 `disabled`，不得回滚到不识别 v2 的 Worker。继续使用兼容 Worker 排空，或发布能显式识别并安全拒绝 v2 的前向修复。
- v2 父任务完成并不等于所有子任务完成；同时核对其 `novel.materialize.v1` 子任务和 item lease。
- 回滚不得删除任务、修改 payload/result、重置失败状态或把 v2 改写成 v1。
- 若只回滚 Web，必须维持提交入口关闭，避免继续创建 v2 库存；兼容 Worker 保持运行直到库存满足回滚门禁。
- v1 非终态任务保留原枚举语义并由兼容 Worker 完成。其残余 locale failed 是预期历史行为，需在发布记录中单列。

重新开放入口前，确认运行中的所有 Worker 都与准备开放的 Web 制品协议兼容，并重新执行小批混合样本。
