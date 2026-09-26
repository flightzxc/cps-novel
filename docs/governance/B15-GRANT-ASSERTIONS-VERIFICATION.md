# B-15：x6 权限契约修复与 x9 排查交付

日期：2026-09-27。分支：`fix/b15-grant-assertions`。本单为本地待复核交付，未合并、未开 PR、未发版、未操作任何既有部署或远端主机。

## 1. 基线与范围

开工前执行：

```text
git ls-remote origin refs/heads/integration/v0.4.5-2026-09-26
7f9dfe3a9b8122de1375540b08341c9d6e2dda62 refs/heads/integration/v0.4.5-2026-09-26
```

fetch 后以该 ref 新建分支/worktree。Final `ff1d2dd` 为祖先，收官 `7f9dfe3` 为本次起点。
独立 worktree：`/Users/chenweifeng/Documents/cps海阅/b15-grant-assertions`，不在 /tmp；桌面 worktree API 因当前聊天上层目录不是 Git 仓库返回不可用，随后从现有海阅仓库调用 `git worktree add`。
遵循 `docs/governance/AI_WORKFLOW.md`、`CLAUDE.md`，读取相关近期提交与数据库治理、生命周期 ADR。

实施 x6 服务字段清单及派生测试；x9 只调查并提交 [待 Owner 裁决的方案](../adr/ADR-B15-MANUAL-REVIEW-BOUNDARY.md)。未改生命周期逻辑、x9 用例、grants、schema 或 migration；未处理 B-16/B-17。

## 2. x6 逐列核实

**15 列均有受控写入用途，保留全部现有授权；未找到需要收回的悬空授权列。**
`0e9793b`（2026-09-05）扩展站点运营配置时同步更新了静态测试，真实库用例仍保留“四字段”的旧断言，造成 B-15。

以下表格以本次源码行号为准。公共入口缩写：

- **S**：`src/server/site-settings/service.ts:544` `updateAdminSiteSetting`；`:548–558` 校验 `settings:manage` + 当前会话 2FA；`:375–404` 按 `SITE_SETTING_WRITABLE_FIELDS` 生成白名单 patch 并校验；`:606–612` CAS 写入；`:619–627` 同事务 `site_setting.update` 审计（常量 `:191`），`:492–498` 对 IndexNow key 只记录 configured 布尔值。HTTP 路由 `src/app/api/admin/site-settings/route.ts:20–51`，registry `src/server/site-settings/registry.ts:6–10`。
- **C**：`src/server/home-carousel/service.ts:223` `updateHomeCarouselConfig`；`:216–217,:224` 校验 `settings:manage` + 当前会话 2FA；`:247` 写入；`:248` 同事务 `home_carousel.config` 审计。后台 action `src/app/(admin)/home-carousel/_actions.ts:18–19`，registry `src/app/api/admin/_lib/registry.ts:356`。
- **UI-S**：`src/app/(admin)/settings/_components/site-settings-client.tsx`；**UI-C**：`src/app/(admin)/home-carousel/_components/carousel-manager.tsx`。

| web_app UPDATE 列 | 服务字段 / 受控函数 | 权限位；审计动作 | 后台界面字段及行号 | 处理 |
| --- | --- | --- | --- | --- |
| site_name | siteName；S（`:383–399,:606`） | settings:manage；site_setting.update | UI-S:390 站点名称 | 保留 |
| site_description | siteDescription；S | settings:manage；site_setting.update | UI-S:391 站点描述 | 保留 |
| home_meta_title | homeMetaTitle；S | settings:manage；site_setting.update | UI-S:392 首页 Meta Title | 保留 |
| home_meta_description | homeMetaDescription；S | settings:manage；site_setting.update | UI-S:393 首页 Meta Description | 保留 |
| default_og_image | defaultOgImage；S，非空校验 `:425–427` | settings:manage；site_setting.update | UI-S:427–442 OG 兜底图片地址；`:333–345` 提交 | 保留 |
| google_search_console_verification | googleSearchConsoleVerification；S | settings:manage；site_setting.update | UI-S:394 GSC 验证码 | 保留 |
| footer_copyright_text | footerCopyrightText；S | settings:manage；site_setting.update | UI-S:396 页脚版权 | 保留 |
| footer_disclaimer_text | footerDisclaimerText；S | settings:manage；site_setting.update | UI-S:397 页脚免责声明 | 保留 |
| friend_links | friendLinks；S；`:353–373` JSON 数量、https URL、nofollow 校验 | settings:manage；site_setting.update | UI-S:398 友链 JSON；`:300–302` 解析 | 保留 |
| indexnow_host | indexNowHost；S；`:429–463` 与 SITE_URL/完整三元组校验 | settings:manage；site_setting.update | UI-S:512–518 indexNowHost | 保留 |
| indexnow_key | indexNowKey；S；审计不留原值 | settings:manage；site_setting.update | UI-S:521–530 indexNowKey | 保留 |
| indexnow_key_location | indexNowKeyLocation；S；限定本站 /indexnow-key.txt | settings:manage；site_setting.update | UI-S:533–539 indexNowKeyLocation | 保留 |
| ga4_measurement_id | ga4MeasurementId；S；`:388–392` normalizeGa4MeasurementId | settings:manage；site_setting.update | UI-S:395 GA4 Measurement ID | 保留 |
| carousel_config_json | carouselConfigJson；C（`:247`） | settings:manage；home_carousel.config | UI-C:46–49 提交；`:71–73` Cron/Timezone/启用 cron | 保留 |
| updated_at | S `:583–585,:611` 显式推进 CAS 时间；C 经 Prisma `@updatedAt`（`prisma/schema.prisma:1036`）自动维护 | settings:manage；随 S/C 同事务审计 | UI-S:340,353,370 以 expectedUpdatedAt 提交；`:573` 只读“最近更新”，非可自由编辑字段 | 保留 |

轮播 JSON 的“存在受控入口”不代表 JSON 内每一键都有界面：UI-C:67 明确 slotCount/newSlotCount/newNovelWindowDays 未开放表单，当前 C 接收的是 cron 三项。这是既有产品限制；PG 授权粒度是整列 JSON，不能只撤回其中几个键的授权，本单不扩展其界面或行为。

数据字典 `database-schema-dictionary.jsonl:951–969` 已列明这 15 列的 web_app write_roles，id 仅 migration_owner 可写，故 JSONL 无需改动。
人类治理矩阵仍写“四字段”，本次只修正 `database-governance.md:448` 的过时文字并链接本报告；不改变数据库权限。
Scheduler 现有例外只读 id/carousel_config_json（grants `:164`）；真实库用例继续断言 key 和 SELECT * 被拒，未宣称 Scheduler 连这两个允许列也不能读。

## 3. 派生契约与变异

- 站点设置服务导出并实际用 `SITE_SETTING_WRITABLE_FIELDS` 驱动输入归一化及 request fingerprint；长度、字段语义和幂等指纹的字段顺序保持不变。
- 轮播服务导出并实际使用 `HOME_CAROUSEL_SITE_SETTING_WRITABLE_FIELDS` 决定写入键。
- `tests/backend/database/_lib/site-setting-write-contract.ts` 合并两个清单和 Prisma `isUpdatedAt`，从 DMMF dbName 派生 SQL 列名，避免把 indexNow 错转为 index_now。两个 x6 测试均复用；不在测试内再硬编码 15 个列名。
- 静态测试精确比较 grants 的 UPDATE 列并校验字典 web_app 写列；真实库测试用 `has_column_privilege` 查有效权限，因此表级或继承来的额外授权也不能漏掉。
- 负例为 `UPDATE site_setting SET id=id WHERE id=1`、INSERT、DELETE，均断言具体 permission denied，防止把 CHECK/主键冲突误认成权限拒绝。Worker/Analyst/Scheduler 原有断言原样保留。
- x6 运行器迁移后用 `ON_ERROR_STOP`、`--single-transaction` 重放 grants 两次，输出 `X6_GRANTS_REPLAY=PASS`，再运行真实角色测试与 live drift。

最终版本变异步骤（仅工作副本临时修改，try/finally 恢复）：

1. 保存 `infra/postgres/grants.sql` 原始 bytes。
2. 在 SiteSetting 的原列级授权后追加 `GRANT UPDATE (id) ON site_setting TO web_app;`。
3. 执行 `bash scripts/run-x6-site-setting-postgres-verification.sh`；必须非零且出现期望集合差异 `+ "id"`。
4. finally 恢复原始 bytes 并断言相同；`git diff --exit-code -- infra/postgres/grants.sql` 再确认无交付改动。
5. 再起新 disposable 库跑原命令，必须恢复全绿。

本次记录（完整日志 `.tmp/b15-verification/x6-mutation-final.log`，执行脚本 `.tmp/b15-verification/mutate-x6.py`）：

```text
MUTATION_EXIT=1
AssertionError: expected [ 'carousel_config_json', …(15) ] to deeply equal [ 'carousel_config_json', …(14) ]
+   "id",
Test Files  1 failed (1)
Tests  1 failed | 3 passed (4)
DISPOSABLE_DATABASE_CLEANED=yes
GRANTS_RESTORED=byte-identical
```

## 4. 门禁与尾行证据

所有命令在本 worktree 根目录执行。原始日志位于 `.tmp/b15-verification/`，只使用本机一次性数据库并由运行器清理；未访问远端部署。

### TypeScript

`npm run typecheck`（即 `tsc --noEmit`），exit 0，无诊断；日志 `tsc-final.log`：

```text
> cps-novel@0.4.5 typecheck
> tsc --noEmit
```

### x6、grants 回放和 live 字典

`bash scripts/run-x6-site-setting-postgres-verification.sh`，变异还原后的最终结果记录于 `x6-final.log`：

```text
X6_GRANTS_REPLAY=PASS
Test Files  1 passed (1)
Tests  4 passed (4)
{"status":"ok","models":53,"recordCount":1235,"activeCount":1165,"tableCount":53,"constraintCount":252,"indexCount":224,"triggerCount":2}
X6_SITE_SETTING_SERVICE=PASS
X6_WEB_MINIMUM_UPDATE_GRANT=PASS
X6_WORKER_READ_ONLY=PASS
X6_ANALYST_SCHEDULER_KEY_READ=DENIED
X6_DICTIONARY_DRIFT=PASS
X6_SITE_SETTING_POSTGRES_VERIFICATION=PASS
DISPOSABLE_DATABASE_CLEANED=yes
```

### 全量测试

`npm test -- --maxWorkers=4`，exit 0，最终日志 `full-test-final.log`。首轮和最终轮均 0 failed、无 Unhandled Error / Unhandled Rejection / Uncaught Exception；未使用 B-6/B-14 超时例外。最终尾行：

```text
Test Files  451 passed | 34 skipped (485)
Tests  6760 passed | 337 skipped (7097)
Start at  01:08:36
Duration  120.64s (transform 6.29s, setup 0ms, collect 37.85s, tests 307.77s, environment 52.42s, prepare 22.95s)
```
按既有环境开关跳过的 34 个文件不能作为真实库 PASS；x6 另跑真实库，x9 已知失败另列如下。B-6 `preproduction-secret-consumers.test.ts` 与 B-14 `articles-admin.test.tsx` 为允许记录并降并发重跑的偶发超时文件，本次未用跳过它们的方式放行。

静态字典复核 `node scripts/check-database-dictionary-drift.mjs --static`，exit 0：

```text
{"status":"ok","models":53,"recordCount":1235,"activeCount":1165}
```

### x9 只读排查复现

`bash scripts/run-x9-postgres-verification.sh`，exit 1，日志 `x9-known-failure.log`：

```text
Expected: /permission denied for table side_effect_intent/i
Received: "Illegal side-effect transition: manual_review_required -> confirmed"
Test Files  1 failed (1)
Tests  1 failed | 2 passed (3)
X9_DISPOSABLE_DATABASE_CLEANED=yes
```

**已知失败、待 Owner 裁决**，不修改、不隐藏、不记为门禁全绿。Web 列授权与双管理员 CAS 两条通过；失败的旧用例挡在首个 worker 错误断言，不能把后续 owner 分支写成此次已执行。
完整路径清单、静态核查、B-10 边界、两方案与实施文件范围见 [x9 ADR 提案](../adr/ADR-B15-MANUAL-REVIEW-BOUNDARY.md)。推荐 (a)，尚未实施。

### 额外运行器与隔离

最终交付没有 grants 改动，phase-d/publication-preview 的条件门禁不适用；变异为 disposable 库中的临时额外授权，已恢复，不是待部署权限变更。
`git diff --exit-code -- infra/postgres/grants.sql tests/integration/task-admin/x9-postgres.test.ts prisma src/lib/tasks worker` 用于确认禁止范围没有改动。
参考 CPS 旧工作区保持 HEAD `d77c3b968285698529cf97c7f0f97b286d7a2a9c` 且 status 0 行；X 系列参考仓保持原有 HEAD/status 字节一致（只读比较，不清理既有改动）。未搬运 CPS 代码。
