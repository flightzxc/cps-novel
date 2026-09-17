# Catalog EOF / Finalize 受控恢复 Runbook

本 Runbook 只用于已经暂停的 `catalog_scan` 任务。恢复工具默认 dry-run；代码合并、部署、启动 Worker 均不会自动运行恢复。禁止用手工 SQL 替代本流程。

## 当前事故快照

- 任务：`8c6e30bf-81cf-4a75-a716-0b1ae7cc345b`
- 状态：`paused`
- 成功页：1～973，共 973 页
- 历史失败页：974～1096，共 123 页，必须保留
- pending 页：1097～2000，共 904 页
- 上游总数：97,320；候选终端页：974

这些数字只是 2026-09-17 的只读快照。执行时必须由 CLI 重新验证任务状态、processing item、上游总数和缺口指纹，不能把“缺 20 本”当成前提。

## 1. 生成并复核缺口

使用部署版本对应的独立管理环境，确保 `DATABASE_URL`、MoboReader endpoint 和凭证 keyring 指向待恢复环境。不要在活栈 Web/Worker 容器内临时改代码。

```bash
npx tsx scripts/catalog-finalize-recovery.ts \
  --task-id 8c6e30bf-81cf-4a75-a716-0b1ae7cc345b \
  --expected-total 97320 \
  --terminal-page 974 \
  --request-id <stable-request-id> \
  --gap-fingerprint discover
```

CLI 会只读请求第 974 页，以 `(externalBookId, sourceLanguageCode)` 与本地 `NovelSourceItem` 比较，并输出缺失 identity 列表和 SHA-256。保存完整输出并人工复核：

- 任务仍是 `paused`；
- processing item 为 0；
- `historicalFailedPages` 仍为 123；
- 上游总数仍为 97,320；
- 缺口列表符合预期，但数量不预设为 20；
- 不在工单、聊天或日志中粘贴凭证、上游原始响应或小说敏感字段。

## 2. Apply

仅在上述证据复核通过后，以 dry-run 输出的精确 SHA-256 执行：

```bash
npx tsx scripts/catalog-finalize-recovery.ts \
  --task-id 8c6e30bf-81cf-4a75-a716-0b1ae7cc345b \
  --expected-total 97320 \
  --terminal-page 974 \
  --request-id <same-stable-request-id> \
  --gap-fingerprint <reviewed-sha256> \
  --apply \
  --confirm-task-id 8c6e30bf-81cf-4a75-a716-0b1ae7cc345b \
  --confirm APPLY_CATALOG_RECOVERY
```

Apply 会在一个短事务中：

1. 再次锁定并确认父任务仍为 `paused`，且没有 processing item；
2. 终止 974 之后仍 pending 的普通目录页，不改写 974～1096 的历史失败项；
3. 若确有缺口，upsert 唯一的 `catalog_recovery_page`；
4. upsert 唯一的 `catalog_finalize`；
5. 将父任务恢复为可领取的 `pending`，并写入审计记录。

普通页恢复与人工“重新执行目录收尾”都会开启一个单调递增的 finalize generation。同一 generation
内的 worker crash/retry 继续复用同一个 Preview request token；只有人工重新收尾或页面结果发生变化时
才进入新 generation，避免旧的已完成 Preview 被错误当作本轮结果。

Worker 领取恢复页后会再次请求第 974 页、再次校验缺口指纹，只用 `createMany(skipDuplicates)` 插入仍缺失的 identities，不更新已有正常记录。随后 finalizer 汇总原 1～973 页与恢复页结果，并以 generation 稳定 token（首代为 `moboreader.preview_refresh.v1:<catalogTaskId>`，后续为 `...:<catalogTaskId>:g<N>`）分批构建覆盖原批次的 Preview 任务。

## 3. 完成核验

- `catalog_recovery_page` 和 `catalog_finalize` 均已离开 pending/processing；
- 父任务终态预计为 `completed_with_errors`，保留历史 123 页失败证据；
- `batchActualCount`、唯一 source IDs 和上游总数一致；
- 标签汇总来自既有成功页结果加恢复页结果，没有重复累计；
- Preview request token 唯一，任务不处于 `disabled/building`；
- Preview item 数等于最终资格过滤结果，重跑不会增加重复 item；
- 失败书数未知时 API/UI 显示 `null/未知`，同时显示实际失败页数。

如任何状态、总数或指纹漂移，停止执行并重新 dry-run；不得绕过校验，也不得手工修改任务表。

## 4. Finalize 重试耗尽

finalize item 达到重试上限后，任务详情会显示“重新执行目录收尾”。该动作保留页面结果、EOF 围栏和
历史失败证据，只重置 finalize 的新一轮尝试预算并开启新 generation。若失败发生在 Preview staging
中途，系统会把 `disabled/building` shell 及其 pending items 正式终结为 failed；不得手工删除或改写
该残骸。按钮不可用或状态与页面不一致时停止操作，先核对任务与 item 状态。
