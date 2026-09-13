# READY_FOR_REVIEW · Novel 入库与 Article 生成解耦

- 冻结基线：`daafbe472ef9bfd4810ba0f91451bc9a6eb5e941`（`owner-uat/catalog-sync-daafbe4`）
- 实现分支：`feature/novel-article-decoupling`
- 工作树：`/Users/chenweifeng/Documents/cps海阅/cps-novel-novel-article-decoupling`
- 未带入：`feature/l10n-full-cps-parity` / `fe86b5c`
- 未改：P1 schema 工作区、CPS 仓、schema migration、GRANT、生产开关

## 提交序

1. **A** `ef88f9f` 纠正耦合协议：新任务类型 / DTO，旧 `content_create` 识别后终端失败
2. **B** `68eaf68` 拆出 `materializeNovelFromSourceItem` 与 `generateArticleFromNovel`
3. **C** `0965fcb` worker / catalog-sync「纳入书目」/ `/articles/generate*` 运营入口
4. **D** `d910923` 写入守卫、T01–T27 矩阵、切换/回退、本文件

## 本轮策略说明

「生成硬卡推广」是工单收紧，不是历史冻结事实。安全回退不是 `daafbe4` 镜像。详见 `SWITCH_ROLLBACK.md`。

## 待现场

- `LEGACY_TASK_INVENTORY.sql`
- T04 / T16 / T26 / T27 隔离 PG（`NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST=1`）
- 生产 allowlist / lease / 旧 worker 镜像

本轮不 push、不开生产 PR、不合并、不打 tag。
