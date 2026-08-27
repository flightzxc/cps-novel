# 开发日志

按时间倒序或正序均可，本文件用于记录每次实质性开发动作的摘要，供后续任务与审计回溯。

---

## 2026-08-27 · U6 D-7 放行的 backend 补测与 custodian 签收

### 四项阻塞与签收

- 固定接收 `feature/pr-u6-polish@30842b18f6789a0a9890a75d476f69b299e10d73`，
  在其上建立 `fix/u6-backend-acceptance`；保留 U5 与金丝雀分支，不重写原 U6 提交。
- 登记：U6 直接修改了 6 个 Codex 独占的 backend 测试文件：
  `tests/backend/content-creation/publish-gate-e2e.test.ts`、
  `tests/backend/publish-gate/evaluator.test.ts`、
  `tests/backend/indexnow/eligibility.test.ts`、`tests/backend/indexnow/outbox.test.ts`、
  `tests/backend/seo/static-sitemap.test.ts`、
  `tests/backend/seo/novel-hreflang-empty-whitelist.test.ts`。
  **Codex custodian 已复核并 accept 30842b1 的上述内容**；D-7 对 en 放行所需的断言变化保留，
  此处按 X12 / `5459e0b` 先例补登记，不将越界未登记作为后续惯例。
- hreflang 白名单测试改名为 `novel-hreflang-whitelist.test.ts`：保留真实 en 查询一次的断言，
  新增仅在单个测试内 mock 空白名单的零查询回归，结束恢复 mock；同步修正主测试的失效指针。
- sitemap 在真实 refresh → generator 链补测非空子文件数组、零 entries 的失败路径，
  精确断言 `Generated sitemap contains no public URLs`，旧 current 不变且锁释放；
  既有空 routeLocales / 无子文件回归保留，没有用注入 generate 异常替代新门禁。

### 两项建议与影响登记

- outbox 的 `seedEligibleArticle` 增加默认 en 的 locale 参数，删除 es 用例的重复 seed，
  使用相同 helper 配对验证真实白名单下 en 入队、es 被拒；保留原负向断言。
- 仅修正 Codex 领土内 IndexNow eligibility、promo 发布测试、sitemap 多语言测试和
  locale route guard 测试的陈旧注释/用例理由，不改变生产执行语句或既有路由断言。
- **容量观察**：D-7 放行 en 后，触达 hreflang loader 的小说页/章节页请求不再空集短路，
  新增一次 `article.findMany`。外层 `loadHreflangSiblings` 已使用 React `cache`，按 novelId
  复用同次渲染中的调用；不能把每个调用位置都累加为独立查询。本轮不优化查询/缓存，
  未作压测，不据此声称并发容量或延迟已验收；后续容量评估需纳入详情页总查询数。
- Sitemap 已有正式 worker → refresh → generator 调用链，当前运行双闸关闭；
  不是“源码无生产调用点”。本轮不触发业务拓扑中的生成任务，不开放 Sitemap / IndexNow / claimPromo。
- language=5 继续 unknown，不恢复旧诊断产物、不新增探针、不扩上游语种登记。
- 验证按 Node 20 执行；Node project 的 15s 已获 Claude accept，本单仅通过 CLI 指定，
  UI project 维持默认；`vitest.config.ts` 的正式修改仍由后续 X8 合入，不重复改配置。
- 本单不使用 token、不清理 Docker、不重建运行镜像、不发布内容、不 push/tag/部署生产。
  金丝雀分支 `41538ba` 的真实 PG / 凭证阻塞保留，不能将 U6 合入记为金丝雀验收完成。

### 合并前验证（本次实跑）

- Node 20.20.2 / Prisma 6.19.2：npm ci、generate/validate、typecheck、build、静态字典与
  项目隔离 PASS；lint 0 error / 3 条既存 warning。Node 使用 CLI `--testTimeout=15000`，UI 默认不变。
- 定向回归 10 files / 100 tests PASS；完整 Node 123 files passed / 10 skipped、1137 tests passed /
  95 skipped；UI 85 files / 1369 tests PASS。合计 208 files passed / 10 skipped、2506 tests passed /
  0 failed / 95 skipped。数据库套件未启用，本轮不冒称真实 PG 验收通过。
- 首次默认 npm ci 在最后可见的 registry 元数据读取阶段长时间未结束，约七分钟后主动终止
  （exit 143）；随后使用同一锁文件，以 `--prefer-offline --fetch-timeout=30000 --fetch-retries=1`
  重跑成功（10s，491 added / 492 audited）。审计仍为已登记的 8 high；未跳过 audit、未改锁文件。
- 核对 `src/lib/indexnow/eligibility.ts` 去除块注释后的文本逐字一致；修复未改 Claude 实现路径，
  schema/grants、依赖与 Vitest 配置均未改。新增 3 个测试场景，未删除或新增 skip。

## 2026-08-27 · U5 认证 UX 收尾 + 基准图待办

### 本轮做了什么

- R1 follow-up（X8 项 13）：`confirmSetupAction` 成功后不再立刻 `revoke` / 清 cookie。
  `confirmTwoFactorSetup` 仍立刻 bump `sessionVersion`，bootstrap 会话过不了
  `requireAdminSession`，后台 API 不会保持已授权。显式作废 + 清 cookie + `/login`
  挪到「我已保存，继续」触发的 `finishSetupAction`。`/two-factor/setup` 在 cookie
  仍在、context 已 stale 时继续渲染 `SetupFlow`，避免 RSC 刷新把一次性恢复码视图卸掉。
  恢复码只在本次 action 结果与客户端内存里，不进 URL / cookie / localStorage / 日志。
- R3（X12 复核）：`/two-factor/challenge` 与 `/two-factor/setup`（idle/started）补次要
  「退出登录」，走既有 `logoutAction`。恢复码 `done` 步不渲染登出，避免未确认保存就被清页。
- U4-TODO-01 闭环：`/dev-preview/status/{error,not-found,global-error}` 静态展示页，
  与真实 `error.tsx` / `not-found.tsx` / `global-error.tsx` 共用 `PublicErrorStatus` /
  `PublicNotFoundStatus`。补 `not-found-desktop.png` / `error-desktop.png`，清单 13 → 15。
  global-error 只展示面板、不单独截图。kill switch 仍由 `dev-preview/layout.tsx` 管辖。

### 明确没做的

- 未改 `src/lib/auth/` 的 `confirmTwoFactorSetup` / session 端口，未给当前会话补
  `sessionVersion` 回写；未 push、未部署。

## 2026-08-26 · X12 Admin API 会话级 2FA 收口

### 本轮做了什么

- 在所有已登记的 admin Route Handler 与 Admin Server Action 上增加统一会话级门槛：未注册
  2FA 返回 `admin_two_factor_setup_required`，已注册但当前会话未完成挑战返回
  `admin_two_factor_required`；两者均与 capability 的 `requiresTwoFactor` 轴正交；
- 页面访问仍由既有 page guard 引导 setup/challenge，未登记入口仍优先 default-deny 404，缺失或失效
  会话仍返回 401；
- 补充 GET `/api/admin/novels` 的回归覆盖、读写 Route/Action、挑战后放行及错误信封/前端文案回归覆盖；
- X12 从最终候选已合入后的本地 `main@2595e81` 独立分支交付，不改 schema、migration、数据库
  grants、Docker/日志或部署入口；
- 登记：X12 本轮直接修改了 4 个 Claude 领土文件（`registry.ts` 注释、`error-copy.ts`、
  `tests/ui/admin-error-envelope.test.ts`、`tests/ui/admin-secret-boundary.test.tsx`），
  Claude custodian 已复核并 accept，此处留痕以防"跨界随手改"沉淀成惯例。

### 机器排障边界

- 本阶段不创建或复用任何机器 API 身份；SSH、容器日志与 `analyst_ro` 只读数据库链不经过 admin
  session guard，保持原路径；
- 未来若需要机器 API 身份，必须同时满足独立、短时、可审计、默认只读四项属性，并另经 Owner 审批；
- X8 部署输入仍未齐备，本轮不声称生产 SSH/TLS 通达性，不 push、不部署。

## 2026-08-26 · X7 上线前治理收口与 S16

### 本轮做了什么

- 审核并接受 `proposal/p0-s16-typecheck` @ `240bad6`：清除 Lane C 的 21 个 typecheck 基线错误，
  并在 CI 中新增独立全仓 `npm run typecheck`；
- 补齐 `src/lib/indexnow/` / `preview/` / `site/` 唯一 Owner，将违反根目录纪律的
  `src/lib/indexnow-backfill-manifest.ts` 无行为变化地收敛到 `src/lib/indexnow/backfill-manifest.ts`；
- 原样归档 C2 2026-08-21/26 两份只读诊断，8/26 为权威业务结论，8/21 只保留历史链；
- 补登 `ce7f0f1` 的 worker grants，纠正 P1 Gate/P2-01/claim flag 的陈旧状态文字；
- 建立 8 high / 0 critical 的 npm audit 处置台账，禁止 `npm audit fix --force`，
  登记 Next custodian PR、Prisma/nanoid 限期延期和生产镜像裁剪跟进；
- 将 flag + worker allowlist “同次变更/同次回滚”写入发布检查单，并将 X11 登记为
  IndexNow delivery 开闸步骤 8–9 的硬前置；misfire 显式选 `skip`，不留未定义策略。

### 明确没做的

- 本轮不实现 X11 schedule，不开任何 feature/write flag，不修改生产 allowlist；
- 不修改 package/lockfile，Next/eslint-config-next `16.3.3` 升级由 Claude custodian 独立交付；
- 不夹带 S14 `src/lib/site/chrome.ts` locale 修复，本轮只登记 `src/lib/site/` 归 Claude。

## 2026-08-26 · U4 前台防线包

### 本轮做了什么

- B1 公开树错误边界：新增 `src/app/error.tsx`、`src/app/global-error.tsx`、`src/app/not-found.tsx`，
  共用新抽出的 `PublicStatusPanel`（与 `UnavailableScreen` 同一套视觉语言）；两个错误边界各自
  `console.error`——`global-error` 不能依赖 `error.tsx` 落日志，因为布局失败根本到不了那层边界；
- B2 favicon：`src/app/icon.tsx` 用 `next/og` 代码生成，图形复刻 `BrandMark` 的几何占位；
- B3 dev-preview kill switch：`DEV_PREVIEW_ENABLED !== "true"` 时 `notFound()`，并从 preview 页
  去掉内部文档路径；
- B15 JSON-LD：`<` 转义为 `\u003c`，堵住 `</script>` 逃逸；
- N5 后台时区：`src/features/admin-ui/datetime.ts` 显式 `timeZone: Asia/Shanghai`，时区由
  `AdminTimeZoneNote` 每页声明一次，值本身不带后缀；
- B14 `lang`：根 `<html>` 保持 `lang="en"`，`(admin)` / `(admin-auth)` 包裹层标 `lang="zh-CN"`，
  并由 `AdminDocumentLang` 同步 `document.documentElement.lang`。

### 视觉偏离登记（P1-10）

- **§10 状态页形态例外**：`PublicStatusPanel` 的 `bare` 模式不渲染页头页脚，偏离「页头 → 状态说明块
  → 返回入口 → 页脚」。root 404 / error 没有 chrome 数据可喂页脚，且品牌槽位当前仍是
  `BRAND_PLACEHOLDER` 文本，不能出现在公开错误页。`UnavailableScreen` 仍走 `SiteShell`，不受影响。
- **§13 品牌标记同步义务**：`src/app/icon.tsx` 与 `src/components/BrandMark.tsx` 是同一个几何占位的
  两份实现（Satori 不支持 SVG 与 CSS 变量，favicon 只能用 div 重画）。🔴 正式 Logo 到位时两者必须
  一起替换；favicon 不得引入第二套品牌识别。

### 明确没做的（本轮范围外）

- 错误页没有使用 `--novel-danger`：错误态与下架态的区分靠「重试」这个纸色主动作，不靠色彩。

### 待办登记 · U4-TODO-01 · root 404 / error 缺基准图

- **状态**：已闭环（U5，2026-08-27）。`/dev-preview/status/not-found` 与
  `/dev-preview/status/error` 承载路由已建，`not-found-desktop.png` /
  `error-desktop.png` 已入库，清单 13 → 15。`DEV_PREVIEW_ENABLED` 关闭态仍由
  `dev-preview/layout.tsx` 整树 `notFound()`。

## 2026-08-06 · P1-15 收口文档与 P2 交接输入包

### 事实基线

- P1 最终本地 `main`：`fb8cddbdf7c8ff6b566169eade4a89258e7db668`；
- P1-04～P1-13 的交付提交均已进入本地 `main`；
- P1-13 PostgreSQL 16.14 最终门禁：PG 71/71、Backend 185/185、UI 469/469、Full 725/725；
- P1-14 对 `fb8cddb` 的最终聚焦只读审计：`P1_14_FINAL_AUDIT_PASS`、
  `REQUIRED_FIXES=NONE`、9 项 `NON_BLOCKING_NOTES`；
- CPS 本轮只读核验：clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

### 本轮做了什么

- 新增 `docs/governance/P1_CLOSEOUT_REPORT.md`：登记 P1-04～P1-14 的本地完成状态、进入 main
  的 commit 证据、P1-12/P1-13/P1-14 结果、三条硬前置与待决项状态；
- 新增 `docs/governance/P1_RISK_AND_DEBT_REGISTER.md`：逐条登记 P1-14 的 9 项
  `NON_BLOCKING_NOTES`，不把任何 note 改写为 P1 required fix；
- 新增 `docs/governance/P2_HANDOFF_INPUT.md`：整理 P1 可复用基础、不得重做的冻结边界、
  多语/URL/SEO/上游 probe 前置、运维债务和 P2 首批建议工作包；
- 更新版本台账与本开发日志；
- D-2/D-7/D-8/W6/W9/R3 仍按正式文档登记为 OPEN；D-12 以详情页嵌入真实试读章节、
  不建独立目录路由的代码与测试证据登记为 RESOLVED。

### 特别前置

- 首次正式远端 CI 配置前，必须显式运行 `scripts/p1-13-postgres-verification.sh` 或等价
  PostgreSQL 16 门禁；默认 `npm test` 不代表 PG 71/71；
- 实际启用 365 天 `operation_audit` 清理任务前，必须设计受控特权清理路径；
- locale upstream registry 与 publish whitelist 当前均为空，D-7 和上游枚举证据齐备前继续
  fail-closed。

### 状态与下一门

```text
P1_04_TO_P1_14=COMPLETE
P1_14=P1_14_FINAL_AUDIT_PASS
P1_14_REQUIRED_FIXES=NONE
P1_15=WAITING_FOR_GPT_NOTION_AND_OWNER_GATE
REMOTE_SYNC=NOT_ATTEMPTED_LOCAL_ONLY
RELEASED=NO
DEPLOYED=NO
NEXT_GATE=GPT_NOTION_UPDATE_THEN_OWNER_RELEASE
```

P1-15 的本地文档提交不构成 Owner 放行，不得据此登记为已发布、已部署或 P2 已开工。

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
