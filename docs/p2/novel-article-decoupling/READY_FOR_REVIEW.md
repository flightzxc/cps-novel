# READY_FOR_INCREMENTAL_REVIEW · `d908041` T24-c 证据诚实

- 冻结基线：`daafbe472ef9bfd4810ba0f91451bc9a6eb5e941`
- 上一轮已审 HEAD（`PREVIOUS_REVIEW`）：`d9080416138db3e14cd517ef81fa1c7d70a813a4`
- 下一轮只审：`d9080416138db3e14cd517ef81fa1c7d70a813a4..NEW_HEAD`（本轮纯 Markdown）
- 实现分支：`feature/novel-article-decoupling`
- 工作树：`/Users/chenweifeng/Documents/cps海阅/cps-novel-novel-article-decoupling`
- 未带入：`feature/l10n-full-cps-parity` / `fe86b5c`
- 未改：业务代码、schema、GRANT、生产开关；不补 Preview/channel_sync 测试
- 本轮 fast-forward push `review/novel-article-decoupling`；不开 PR、不部署、不打真实上游

本轮不是 RELEASE_READY。不得因本地全量测试绿而改写成发布闸已过。
独立复核方可判 **CODE_INCREMENT_PASS / RELEASE_GATE_PENDING**。

## 提交序（已审历史，冻结）

1. **A** `ef88f9f` 纠正耦合协议
2. **B** `68eaf68` 拆出物化与生成
3. **C** `0965fcb` 运营入口
4. **D** `d910923` 写入守卫与回退
5. 第一轮已审 tip：`fbab06e`
6. 第二轮已审 tip：`1901880`
7. 第三轮已审 tip：`90f6ab7`
8. 第四轮已审 tip：`d908041`（`fix(decoupling): canonicalize batch generate filter snapshots`）

本轮追加一个文档 commit（T24-c 诚实 NOT RUN）。只追加，不 rebase / squash / amend。

## 本轮范围

- **只改文档**：T24-c 不得再用 GenericTask fencing 冒充 Preview/channel_sync fencing。`moboreader.preview_refresh.v1` 落在 `channelSyncTask`，T24-c = **NOT RUN**。
- **EXT-24**：平台 GenericTask fencing 回归 = **PASS**；Preview/channel_sync 专项 fencing = **NOT RUN**。
- **不做**：不改 `store.ts`、Preview handler、不补 channel_sync 测试、不重跑 R2-01/R2-03、不重跑全量 `npm test`。

## 冻结策略（未改）

- Novel-only 物化；显式建稿；活文章 `already_exists`；软删不 undelete。
- 旧 `content.create.v1` / `content_create` / 旧 ContentCreation Action 一律 retired。
- 不改 `tests/ui/admin-secret-boundary.test.tsx`。

## 本轮命令证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **PASS**（0 error） |
| `npm run lint` | **PASS**（0 error；4 条既有 warning，非本轮引入） |
| `npm test` | **4905 passed / 193 skipped / 0 failed**（沿用 `d908041`；本轮纯 Markdown，未重跑） |
| 守卫 `tests/ui/admin-secret-boundary.test.tsx` | **PASS**（未改该文件；未豁免 `import type`） |
| `PG_T04_T16_T26_T27` | **NOT RUN** |
| `INVENTORY_SQL_EXECUTION` | **NOT RUN** |
| `OWNER_UAT` | **NOT RUN** |

矩阵正文：`T01_T27.md`。
