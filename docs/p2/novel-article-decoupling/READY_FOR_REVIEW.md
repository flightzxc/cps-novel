# READY_FOR_REVIEW · Novel/Article 解耦返修（`fbab06e` 增量）

- 冻结基线：`daafbe472ef9bfd4810ba0f91451bc9a6eb5e941`
- 上一轮已审 HEAD：`fbab06e1d31a1b742e2e5d44bf3b2c112a016fcc`
- 下一轮只审：`fbab06e1d31a1b742e2e5d44bf3b2c112a016fcc..NEW_HEAD`（提交后填 NEW_HEAD）
- 实现分支：`feature/novel-article-decoupling`
- 工作树：`/Users/chenweifeng/Documents/cps海阅/cps-novel-novel-article-decoupling`
- 未带入：`feature/l10n-full-cps-parity` / `fe86b5c`
- 未改：P1 schema 工作区、CPS 仓、schema migration、GRANT、生产开关
- 本轮不 push、不开 PR、不部署、不打真实上游

裁决保持：**Architecture Correct / Release Not Ready**。本轮是返修增量，不是最终 release gate。

## 提交序（已审历史，冻结）

1. **A** `ef88f9f` 纠正耦合协议：新任务类型 / DTO，旧 `content_create` 识别后终端失败
2. **B** `68eaf68` 拆出 `materializeNovelFromSourceItem` 与 `generateArticleFromNovel`
3. **C** `0965fcb` worker / catalog-sync「纳入书目」/ `/articles/generate*` 运营入口
4. **D** `d910923` 写入守卫、T01–T27 矩阵、切换/回退
5. 已审 tip：`fbab06e`

返修尚未单独 commit（`WORKTREE_CLEAN=no`）。需要时再追加 commit，不 rebase / squash / amend 已审历史。

## 本轮策略说明

- Novel 物化不读模板、不建 Article；`linked + 0 Article` 合法。
- 生成时 `resolveReadyPromoLinkForNovel` → 同一 PromoLink 写入 `/go/{code}` 与 `Article.promoLinkId`。
- 活文章 `already_exists`；软删 `article_soft_deleted`，不 undelete。
- 旧 `content.create.v1` / 父 `content_create` 终端失败。
- 旧 `dryRun/applyContentCreation(+Batch)Action` **一律** `retired_protocol`（与是否带 `templateKey` 无关）。新入口：`dryRun/applyNovelMaterializeAction`、`applyNovelMaterializeBatchAction`。
- `all_filtered` 走父任务 `article.generate.batch.v1`，Web 不枚举全库。
- P2002：Novel `FOR UPDATE` 后重查再 Prisma create；真冲突只在事务外收敛。
- 指定目标与候选分页分开：`{ pinned, page }`，禁止 fallback 到 `page[0]`。
- 「生成硬卡推广」是工单收紧，不是历史冻结事实。安全回退不是 `daafbe4` 镜像。详见 `SWITCH_ROLLBACK.md`。不可只升 Web，也不可只升 Worker。

## 本轮命令证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS（0 error） |
| `npm test` | PASS：`4881 passed` / `193 skipped` / `0 failed` |
| 守卫 `tests/ui/admin-secret-boundary.test.tsx` | 原样绿（未豁免 `import type`） |
| 隔离 PG T04 / T16 / T26 / T27 | **NOT RUN** |
| inventory SQL 隔离 PG 只读执行 | **NOT RUN** |
| Owner 登录 UAT / 复核 §9.3 | **未做**；无登录单测不能写成已满足 |

## 待现场（具备独立 PG 后切 A）

- T04 / T16 / T26 / T27：`NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST=1` + `P1_06_{OWNER,WEB,WORKER}_DATABASE_URL`，库名 `cps_novel_article_decouple_*`，`current_user` 为 `web_app` / `worker_app`
- `LEGACY_TASK_INVENTORY.sql` 在同 schema 隔离库只读执行，要求 0 SQL error
- Owner 登录 UAT：指定 Novel、第 201 本批量可达、跨页选择、catalog-sync 无模板、Novel-only「尚未创建文章」
- 生产 allowlist / lease / 旧 worker 镜像（示例 allowlist 已追加，生产开关未改）

矩阵正文：`T01_T27.md`。
