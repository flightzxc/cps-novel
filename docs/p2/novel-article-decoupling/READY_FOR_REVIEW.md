# READY_FOR_INCREMENTAL_REVIEW · `90f6ab7` P1-1 canonical filter

- 冻结基线：`daafbe472ef9bfd4810ba0f91451bc9a6eb5e941`
- 上一轮已审 HEAD（`PREVIOUS_REVIEW`）：`90f6ab765242200c7c2a9e6877ff1279cbb45db9`
- 下一轮只审：`90f6ab765242200c7c2a9e6877ff1279cbb45db9..NEW_HEAD`（提交后填 NEW_HEAD）
- 实现分支：`feature/novel-article-decoupling`
- 工作树：`/Users/chenweifeng/Documents/cps海阅/cps-novel-novel-article-decoupling`
- 未带入：`feature/l10n-full-cps-parity` / `fe86b5c`
- 未改：P1 schema 工作区、CPS 仓、schema migration、GRANT、生产开关
- 本轮 fast-forward push `review/novel-article-decoupling`；不开 PR、不部署、不打真实上游

裁决保持：**Architecture Correct / CHANGES_REQUIRED（范围已收窄到 P1-1 + 文档诚实）**。
本轮不是 RELEASE_READY。不得因本地全量测试绿而改写成发布闸已过。

达到代码增量终审条件后，独立复核方可判 **CODE_INCREMENT_PASS / RELEASE_GATE_PENDING**，不是 RELEASE_READY。

## 提交序（已审历史，冻结）

1. **A** `ef88f9f` 纠正耦合协议
2. **B** `68eaf68` 拆出物化与生成
3. **C** `0965fcb` 运营入口
4. **D** `d910923` 写入守卫与回退
5. 第一轮已审 tip：`fbab06e`
6. 第二轮已审 tip：`1901880`
7. 第三轮已审 tip：`90f6ab7`（`fix(decoupling): close R2 parent aggregation and batch request freeze`）

本轮追加一个 commit（P1-1 canonical filter + 文档诚实拆项）。只追加，不 rebase / squash / amend。

## 本轮范围（Fable 5）

- **唯一 P1 代码**：canonical filter。`draftFilter` 只是编辑态；点「应用筛选」时用 `normalizeArticleGenerateFilter()` 生成唯一 `canonicalAppliedFilter`；list / total / paging / `all_filtered` / fingerprint 共用。
- **文档**：T10/T11/T18/T24 拆子项；有证据 PASS，无直接证据 NOT RUN；EXT-06 标明假数据 handler，不是 PG。
- **不做**：重做 R2-01 任务中心、重做 R2-03 request freeze、rolsuper、确认弹窗、共享 X8/UAT/生产、登录 UAT。

## 冻结策略（未改）

- Novel-only 物化；显式建稿；活文章 `already_exists`；软删不 undelete。
- 旧 `content.create.v1` / `content_create` / 旧 ContentCreation Action 一律 retired。
- 不改 `tests/ui/admin-secret-boundary.test.tsx`。

## 本轮命令证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **PASS**（0 error） |
| `npm run lint` | **PASS**（0 error；4 条既有 warning，非本轮引入） |
| `npm test` | **4905 passed / 193 skipped / 0 failed** |
| 守卫 `tests/ui/admin-secret-boundary.test.tsx` | **PASS**（未改该文件；未豁免 `import type`） |
| `PG_T04_T16_T26_T27` | **NOT RUN** |
| `INVENTORY_SQL_EXECUTION` | **NOT RUN** |
| `OWNER_UAT` | **NOT RUN** |

矩阵正文：`T01_T27.md`。
