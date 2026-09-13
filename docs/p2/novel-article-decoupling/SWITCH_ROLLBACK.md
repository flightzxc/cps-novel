# 切换与回退

## 切换 runbook

1. 部署本分支 worker **之前**，确认 allowlist **追加** `novel.materialize.v1`、`article.generate.v1`、`article.generate.batch.v1`，并**保留** `content.create.v1`（否则旧叶任务会永远 pending）。
2. Web 与 Worker **必须同一次变更**切到本分支。不可只升 Web：旧 Worker 不认识新 type（含 `article.generate.batch.v1`），新父任务会卡住。也不可只升 Worker：旧 Web 仍会打已退役的 ContentCreation Action，或无法提交 `all_filtered` 父任务。
3. 运营入口：`/catalog-sync` 只做「纳入书目」；「创建文章」在 `/articles/generate` 与 `/articles/batch-generate`。旧页若仍提交 `templateKey` / `templateKeysByLocale`，或仍打旧 `dryRun/applyContentCreation(+Batch)Action`，一律 `retired_protocol`，不会静默转成 Novel-only 入库。
4. 能力位不变：读 `content:view`，写 `content:publish`。
5. 生产库存、lease、旧 worker 镜像：先跑 `LEGACY_TASK_INVENTORY.sql`，**待现场核验**。本轮不执行生产处置。

## 回退边界

**不能**写「回退 `daafbe4` 镜像即可」。

`daafbe4` 的 `loadPlan` 会把 Novel-only 判成 `source_item_inconsistent_state`，并可能在旧路径上补建文章。安全回退只有：

1. 保留本分支的兼容补丁（能读 Novel-only + 识别旧协议 + 拒绝隐式建稿），或
2. 停止写入后的 forward-fix。

禁止为迁就旧版批量补 Article。

## 生成硬卡推广

本轮「生成必须先有就绪 PromoLink」是工单收紧策略，不是把历史冻结口径改写成从来如此。若日后要放宽为「有则绑定、无则草稿、发布再拦」，只改 generate 前置，不要回写 v0.2.1。
