# 开发日志

按时间倒序或正序均可，本文件用于记录每次实质性开发动作的摘要，供后续任务与审计回溯。

---

## 2026-08-05 · P1-11 阅读器功能

### 本轮做了什么

- 章节页改为动态路由 `/dev-preview/chapter/[chapterNumber]`，删掉原先两个各自写死的静态章节页；dev-preview 地址集中到 `src/features/public-ui/fixtures/preview-paths.ts` 一个 helper，页面与假数据都从那里取；
- 阅读偏好落 `localStorage` 并跨会话保持：新增 `chapter/reader-storage.ts`（永不抛异常、读回一律过收敛层、SSR 安全）与 `chapter/ReaderSettingsProvider.tsx`（挂在 `chapter/layout.tsx`，切章不重挂，设置因此跨章存活）；
- `ChapterScreen` 改为「有 Provider 就受控，没有就自持」双模，P1-10 的 24 个既有用例一行未改继续通过；
- 阅读位置按 `novel + chapter` 粒度记忆与恢复，存段落锚点 `{paragraphIndex, ratio}` 而非像素，换字号/行高/页宽后仍对得上；`ChapterNovelRef` 相应新增 `id`（永不渲染，只作存储键）；
- 章节导航换客户端路由并带 `scroll={false}`——App Router 的滚动重置在章节页祖先的 commit 回调里执行，不关掉会盖掉位置恢复；随之由阅读器负责「没存过位置的章节显式滚到顶」；
- 首帧不闪：`chapter/layout.tsx` 加阻塞式内联脚本把偏好（主题 + 排版三项）在补水前写到 `<html>`，`globals.css` 加 `--reader-pref-*` 兜底层与两条主题回放规则，阅读区在补水前不写内联排版变量；
- 顺带修正 P1-10 的 `clampIndex`：非整数原本回落到中间档（字号 20px）而非默认档（18px），已改为回默认档；
- 测试净增 40 条（216 → 256），新增 `reader-persistence` / `reader-position` / `chapter-navigation` / `reader-no-flash` 四个文件；`setup-cleanup.ts` 补 localStorage 清理、`<html>` 属性清理与 `window.scrollTo` 实现；
- 三张章节视觉基线重出（其中桌面版与移动版与 P1-10 逐字节相同，新增段落都在首屏之下）；
- 浏览器实测九项验收，含「切章前打的 `window` 标记切章后仍存活、navigation 条目恒为 1」与「滚到 900 刷新后回到 900 误差 0px」。

### 明确没做的（本轮范围外）

- 未建正式章节路由，未设 self-canonical，未进 sitemap / IndexNow，未写入正式 SEO URL 契约（`src/lib/seo/` 仍为空）；
- **未借本轮冻结 D-8**（前台 URL 是否带语种段）；
- 未做跨标签页设置同步；未做切章后的焦点转移（与 P1-10 整页跳转行为相当，非回归）；
- 无数据库改动，未新增任何 npm 依赖，未修改 Codex 独占目录。

详见 `docs/p1/P1_11_READER_REPORT.md`。

## 2026-08-03 · P1-05B 初始 PostgreSQL Migration

### 本轮做了什么

- 使用已固定的 Prisma CLI/Client 6.19.2，从 37-model Schema 生成并审查 `20260803090000_p1_initial_schema`；
- 在同一 Migration 中补齐 66 个状态/数值/跨字段 CHECK、active scope/identity 部分唯一索引、三类 Item 的 pending/recovery 独立索引，以及公开码不可变和 operation audit append-only trigger；
- Article → PromoLink 复合 FK 使用 PostgreSQL 默认 MATCH SIMPLE，并通过 `pg_constraint.confmatchtype='s'` 实测；
- 将 825 条数据库字典记录激活，记录 `managed_by`、`physical_name`、Migration ID 和 evidence；
- 新增 Schema/字典/pg_catalog 双向 drift 检查，以及一次性 PostgreSQL 16 Docker 验证脚本；
- PostgreSQL 16.14 空库部署、重复部署、双向 drift、16 个负向场景、5 类正向场景和六条索引执行计划全部通过；完整测试 12/12 PASS；
- 所有 disposable 容器与 volume 已清理，CPS 参考仓库保持 clean@`d77c3b9`。

### 明确没做的（本轮范围外）

- 未创建数据库角色、GRANT/REVOKE、备份或 PITR；
- 未实现 Worker、Scheduler、Auth、Credential、Adapter；
- 未创建正式数据库或 Compose，未连接生产、预生产或 CPS 数据库；
- 未修改 `package.json`、lockfile、`src/app/**`、`src/components/**` 或 `src/contracts/**`。

## 2026-08-02 · P1-04 工程骨架

### 本轮做了什么

- 建立 Codex 独占写入目录的占位结构：`prisma/`、`src/server/`、`src/lib/db/`、`src/lib/auth/`、`src/lib/credentials/`、`src/lib/tasks/`、`src/lib/adapters/`、`worker/`、`scheduler/`、`infra/`、`scripts/`、`tests/backend/`、`tests/integration/`，每个目录含 `README.md`（Owner、用途、本轮范围、填充任务、特别纪律）与 `.gitkeep`；
- 建立 Claude 独占写入目录的占位结构：`src/components/`、`src/design/`、`src/features/admin-ui/`、`src/features/public-ui/`，同样含 `README.md` + `.gitkeep`；
- 建立共享路径 `src/contracts/`（Claude 为 merge custodian）与 `src/domain/`（Codex 为 merge custodian）的占位说明，未写任何类型定义；
- 建立 `docs/governance/` 下四份治理文档：`port-registry.md`（空表头）、`database-governance.md`（骨架）、`version-registry.md`（首条记录）、`development-log.md`（本文件）；
- 建立仓库根 `CLAUDE.md` 作为架构事实唯一权威源。

### 明确没做的（本轮范围外）

- 无 Prisma Schema / migration（留给 P1-05）；
- 无 Worker / Scheduler 实现（留给 P1-07）；
- 无 Adapter 实现（留给 P1-07 前后，具体任务编号待 Notion 台账明确）；
- 无 Auth / Credential 实现（留给 P1-08）；
- 无数据库连接、角色、备份方案（留给 P1-05 / P1-06）；
- 无 Docker Compose 配置（留给 P1-12）；
- 无 CI workflow（本轮不创建 `.github/` 任何内容）；
- `src/contracts/` 内无任何业务 DTO / 类型定义，仅有目录说明。
