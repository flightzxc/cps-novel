# CPS 海阅首发后台与 SEO 运营面 · 实现登记

本登记对应基线 `main@f99c25eda519401cac876c3af31bd4e0f090103e`。CPS 语义只从
`v8.3.6`（peeled `16f2e4cfca51f46af0dede899ecf6242a770bbd0`）通过
`git show/git grep/git ls-tree` 读取。本文只登记实现事实；测试、mutation 与 X8 原始证据进入
被忽略的 `.tmp/x8-production-like/evidence/`。

## CPS 语义与最小适配

| 模块 | CPS 原始语义 | Novel/PostgreSQL 最小适配 |
| --- | --- | --- |
| M0–M4 | CPS 管理 UI 不把 2FA 当能力投影；同步页常显 gate；preview enqueue 采用稳定 task token | enforcement=false 仅改变 UI/session 投影；不改服务端授权。创建提交后选择最近 completed scan 账号，回退唯一 active+有效凭据账号；无账号只投影 `no_channel_account`，不回滚内容。 |
| M5 | slot=5、new=1、window=14、scan≤500、去重、无封面过滤；收入分支及 cron/serving/fallback | Drama→Novel/Article；收入分支保留且恒禁用；复用 GenericTask 与 scheduler；business date 幂等。 |
| M6 | 模板 CRUD/启停/软删，fallback template，单篇选择与同 locale 批量固定模板 | 复用既有 fail-closed 六变量引擎；空表写 `system-default-v1`；Article.templateId 持久化。 |
| M7 | 文章编辑/原模板再生成/批量；公开 metadata/body/FAQ 优先文章 | 保留 slug/shortId；批量 ≤50/25s 四态；公开 mapper 不增加 upstreamCode/raw payload。 |
| M8 | category 管理、分页页、CollectionPage/Breadcrumb、sitemap 分片 | 不建第二 taxonomy；CanonicalTag manual FULL_SNAPSHOT 或 mapped read-derived；无书 404、不进 sitemap，auto write 仍 NO。 |
| M10 | 13 字段设置、GA4/GSC、home meta、friend links/footer | 复用 optimistic lock、reason、审计与 `settings:manage`；GA4 exact regex；PostgreSQL jsonb friendLinks。 |
| M12 | disabled/pending/pending_expired/enabled；当前 TOTP 后事务替换恢复码并 sessionVersion++ | 复用现有 setup/TOTP/加密参数；恢复码只在 action 结果中返回一次；无自助禁用，enforcement=false 可自愿设置。 |

## 运行时登记

- Admin routes：既有 `/api/admin/site-settings` 扩展 13 字段；Tagging GET/PUT routes 在组合 registry
  中按 method 绑定 `content:view`/`tag:manage`。
- 新 actions：template 4、article 3、carousel 4（`config`/`manual_upsert`/`manual_delete`/
  `compute`）、security 3；均由
  `P2_04_ADMIN_REGISTRY` 默认拒绝模型登记。业务类写服务继续执行 capability/service ticket 二次
  鉴权与 operation audit；本人安全动作绑定当前 session/identity/request ID。
- 新任务：`home_carousel.compute.v1`，同时登记 Web action、Scheduler、GenericTask Worker handler、
  Level 0/UAT/R allowlist（PR6 fix lane A 前，Scheduler 一项实为空文档——`SCHEDULES`
  恒为空数组、`enqueueHomeCarouselCron` 零调用者；已在 `fix/pr6-lane-a-carousel` 补齐
  首条 `ScheduleDefinition`，见 `tests/backend/home-carousel/cron.test.ts` 与
  `tests/backend/runtime/x8-production-like-contract.test.ts` 的 B-1 #4 断言）；
  `tagging.auto_classify` 保持 explicit-only，不进 Scheduler/X8 allowlist。
- 迁移：`20260905090000_site_setting_carousel_config` 仅增 `jsonb NOT NULL DEFAULT '{}'`；Tagging
  migration 为从冻结的 18 提交历史集成的 additive schema，不含 seed/backfill。
- 导航常驻：`/templates`、`/articles`、`/home-carousel`、`/categories`、`/settings/security`；
  `/tags` 继续表示来源标签字典。

## 冻结边界

未修改 rate-limit、proxy/login host 隔离、promo claim 状态机、publish gate、preview handler、模板
语法或 taxonomy auto-write 边界。UAT 不为验证分类 sitemap 打开既有关闭的 Sitemap/IndexNow
双闸；分类 family 由 generator 与集成测试验收。

## Acceptance / mutation 映射

M0–M12 每行必须至少执行一次真实代码变异并看到目标测试变红，再用逆向补丁恢复并重跑。
目标分别覆盖：M0 projection；M1 publish UI；M2 gate status/warning；M3 claim capability；M4 preview
enqueue；M5 carousel config/merge；M6 template validation/selection；M7 article regenerate/public SEO；
M8 published taxonomy/category sitemap；M9 task center；M10 GA4/GSC/footer consumer；M11 credential
surface；M12 TOTP/recovery rotation。最终数值以 OWNER_PUSH_GATE 报告和忽略目录证据为准。
