# READY_FOR_INCREMENTAL_REVIEW · 1901880 定点返修

- 冻结基线：`daafbe472ef9bfd4810ba0f91451bc9a6eb5e941`
- 上一轮已审 HEAD（`PREVIOUS_REVIEW`）：`190188018ebac7bcb3982e5f27b7fe5b629ee065`
- 下一轮只审：`190188018ebac7bcb3982e5f27b7fe5b629ee065..NEW_HEAD`（提交后填 NEW_HEAD）
- 实现分支：`feature/novel-article-decoupling`
- 工作树：`/Users/chenweifeng/Documents/cps海阅/cps-novel-novel-article-decoupling`
- 未带入：`feature/l10n-full-cps-parity` / `fe86b5c`
- 未改：P1 schema 工作区、CPS 仓、schema migration、GRANT、生产开关
- 本轮不 push、不开 PR、不部署、不打真实上游

裁决保持：**Architecture Correct / CHANGES_REQUIRED**。
本轮是对 `1901880` 终审（2026-09-14）的定点返修，**不是**增量 PASS，也**不是** RELEASE_READY。
不得把 `1901880` 或本轮 NEW_HEAD 写成已经通过增量终审。

## 提交序（已审历史，冻结）

1. **A** `ef88f9f` 纠正耦合协议：新任务类型 / DTO，旧 `content_create` 识别后终端失败
2. **B** `68eaf68` 拆出 `materializeNovelFromSourceItem` 与 `generateArticleFromNovel`
3. **C** `0965fcb` worker / catalog-sync「纳入书目」/ `/articles/generate*` 运营入口
4. **D** `d910923` 写入守卫、T01–T27 矩阵、切换/回退
5. 第一轮已审 tip：`fbab06e`
6. 第二轮已审 tip：`1901880`（`fix(decoupling): remediate novel article review blockers`）

本轮返修尚未单独 commit（提交前 `WORKTREE_CLEAN=no`）。需要时再追加 commit，不 rebase / squash / amend 已审历史。

## 本轮范围（R2）

- R2-01：`PARENT_BATCH_TASK_TYPES` 把 `article.generate.batch.v1` 接入 list / detail / progress / 子任务入口 / retry 409
- R2-02 / R2-03：批量 form 分开 draft/applied filter；冻结整次请求；成功换 requestId；factory 真 fingerprint
- R2-04：页面出现新语种时补取该语种模板并缓存（不预拉全库）
- R2-05：三连接同一隔离库名 + 一条负例单测（不做 rolsuper / 不搭库）
- R2-06：恢复原工单 T01–T27 题目；历史改写主题改挂 EXT / 别名；诚实 NOT RUN

未做：N1、N2、N3、登录 UAT、共享 X8/UAT/生产。

## 冻结策略（未改）

- Novel 物化不读模板、不建 Article；`linked + 0 Article` 合法。
- 生成时按 Novel 重读 PromoLink；活文章 `already_exists`；软删 `article_soft_deleted`，不 undelete。
- 旧 `content.create.v1` / 父 `content_create` / 旧 ContentCreation Action 一律 retired。
- `all_filtered` 走父任务 `article.generate.batch.v1`，Web 不枚举全库。
- 指定目标与候选分页分开：`{ pinned, page }`，禁止 fallback 到 `page[0]`。
- 安全回退不是 `daafbe4` 镜像。详见 `SWITCH_ROLLBACK.md`。

## 本轮命令证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS**（0 error；4 条既有 warning） |
| `npm test` | **PASS**：`4901 passed` / `193 skipped` / `0 failed` |
| 守卫 `tests/ui/admin-secret-boundary.test.tsx` | 原样绿（未豁免 `import type`；本轮未改该文件） |
| 隔离 PG T04 / T16 / T26 / T27 | **NOT RUN** |
| inventory SQL 隔离 PG 只读执行 | **NOT RUN** |
| Owner 登录 UAT / 复核 §9.3 | **未做** |

## 待现场（具备独立 PG 后切 A）

- T04 / T16 / T26 / T27：`NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST=1` + `P1_06_{OWNER,WEB,WORKER}_DATABASE_URL`，库名 `cps_novel_article_decouple_*`，三连接同一库，`current_user` 为 `web_app` / `worker_app`
- `LEGACY_TASK_INVENTORY.sql` 在同 schema 隔离库只读执行
- Owner 登录 UAT：指定 Novel、第 201 本批量可达、跨页选择、catalog-sync 无模板、Novel-only「尚未创建文章」
- 生产 allowlist / lease / 旧 worker 镜像（示例 allowlist 已追加，生产开关未改）

矩阵正文：`T01_T27.md`。
