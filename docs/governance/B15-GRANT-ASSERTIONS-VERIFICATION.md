# B-15：x6 权限契约与 x9 人工核对数据库防线

日期：2026-09-27。分支：`fix/b15-grant-assertions`。当前 x9 已按 Owner 裁决实现方案 (a)，真实库通过，待发布。**全量门禁仍未通过：非白名单 Docker Bash 5 对照用例在两轮全量和单文件复核中持续超时，且产生 Vitest 通信错误；未按例外放行。**已将指定开发线合入本工作分支；未将本分支合回开发线，未推送、未开 PR、未发版、未操作任何既有部署或远端主机。

第 1–4 节保留 `f406f4b` 的 x6 已复核交付与当时的 x9 调查证据，其中“待裁决 / 未实施 / 已知失败”均为历史状态。当前实现与验证见第 5 节。

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

**历史状态（f406f4b）：已知失败、待 Owner 裁决**，当时不修改、不隐藏、不记为门禁全绿。Web 列授权与双管理员 CAS 两条通过；失败的旧用例挡在首个 worker 错误断言，不能把后续 owner 分支写成此次已执行。
完整路径清单、静态核查、B-10 边界、两方案与实施文件范围见 [x9 ADR 提案](../adr/ADR-B15-MANUAL-REVIEW-BOUNDARY.md)。推荐 (a)，尚未实施。

### 额外运行器与隔离

最终交付没有 grants 改动，phase-d/publication-preview 的条件门禁不适用；变异为 disposable 库中的临时额外授权，已恢复，不是待部署权限变更。
`git diff --exit-code -- infra/postgres/grants.sql tests/integration/task-admin/x9-postgres.test.ts prisma src/lib/tasks worker` 用于确认禁止范围没有改动。
参考 CPS 旧工作区保持 HEAD `d77c3b968285698529cf97c7f0f97b286d7a2a9c` 且 status 0 行；X 系列参考仓保持原有 HEAD/status 字节一致（只读比较，不清理既有改动）。未搬运 CPS 代码。

## 5. x9 方案 (a) 实施（Owner 2026-09-27 裁决）

### 基线、合并与交付定位

- 同一 worktree / 分支继续，保留已复核的 `f406f4b27f8369964e993586ccccae23cdc7c606`。
- `git fetch origin` 后确认 `origin/integration/v0.5.0-2026-09-27` 为 `17d07ccb588358f18fd32191cfc26ac2170fe30c`，执行 `git merge --no-ff --no-commit origin/integration/v0.5.0-2026-09-27`。
- 实际没有冲突；`database-governance.md` 自动合并。开发线的 `schedule_run.skip_reason`、字典记录、治理说明和 x6 的派生契约均保留；没有冲突文件需要手工取舍。
- 独立 node_modules 目录，非符号链接；重新 `npx prisma generate` 后客户端含 `skipReason`。
- 合并暂存状态的 `npm run typecheck`、x6（4）、worker-light（12）、phase-d（83）全通过，随后独立提交 `351d2d39ce3e8a91e67d6167fab11ea0ba2bf911`，中文说明及 `Agent: codex` / `Model: GPT-6`。
- 实现提交是本报告所在的后续提交；最终交付回复给出完整实现 HEAD，避免在提交内容内自引用尚未生成的 SHA。未 push / PR / 发版。

### 实现边界

**x9 当前为真实库通过，不再是已知失败。** 应用层拒绝与数据库层拒绝分别断言：前者仍为 `Illegal side-effect transition`；后者检查专用消息与 SQLSTATE `42501`。

新迁移 `20260927090000_side_effect_manual_review_guard` 的 SQL 全文如下；没有修改历史迁移、Prisma schema 或 grants：

```sql
CREATE FUNCTION public.reject_side_effect_manual_review_exit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user <> 'web_app' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'side_effect_manual_review_exit_requires_web_app';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  public.reject_side_effect_manual_review_exit()
  FROM PUBLIC;

CREATE TRIGGER side_effect_manual_review_exit_guard
BEFORE UPDATE ON public.side_effect_intent
FOR EACH ROW
WHEN (
  OLD.status = 'manual_review_required'
  AND NEW.status IS DISTINCT FROM OLD.status
)
EXECUTE FUNCTION public.reject_side_effect_manual_review_exit();
```

触发器只对人工核对状态出边执行。`current_user` 必须为 web_app；同状态更新及其它起点无新增限制。migration_owner 的 schema 迁移照常，但直接改走人工核对状态也被拒；特殊修复必须另走显式、审计化维护决策。没有 owner 白名单、GUC/actor 旁路或 SECURITY DEFINER。

现有全函数 EXECUTE revoke 继续有效，运行角色没有新增函数授权；真实库证明函数 EXECUTE 被撤销时触发器仍工作。worker 保留 INSERT/UPDATE/SELECT，Web 精确保持 status/response_shape/confirmed_at 三列 UPDATE。角色关系与 SET ROLE/禁用触发器的负例使用真实 worker 连接；bootstrap 的角色切换仅用于一次性库测试，不给 worker 新增成员资格。

字典新增函数与触发器两个 constraint / migration_sql 记录，data_type 分别为 function / permission_trigger；记录 1236→1238，active 1166→1168，trigger 2→3，表数仍 53。检查器只对已登记函数校验 schema、名称、零参数签名、trigger 返回类型和 invoker 属性；没有要求补登记历史函数。

### 测试覆盖和迁移证据

x9 共 27 条真实库用例，每个库两次 grants 回放后各执行一次。包括：

- worker 通用 transition 与专用 readback 对人工核对出边的应用拒绝；prepared / claim_retry_blocked 回读确认成功。
- 原始 SQL / Prisma updateMany × confirmed / failed / prepared / claim_retry_blocked 共 8 个数据库拒绝用例，比较整行确保 status、response_shape、confirmed_at 等不变。
- owner 出边拒绝；worker 无 Web/owner 成员资格，不能 SET ROLE 或禁用 trigger；bootstrap SET LOCAL ROLE 的 current_user/session_user 区分。
- worker 同状态更新、其它四种起点成功；Web effect_confirmed / no_effect_confirmed 两裁决、双管理员 CAS 单赢家、重放只留一条审计。
- 临时撤销 Web 审计 INSERT 后人工裁决整笔回滚，finally 恢复权限；真实 finalizeTaskItem/protectedWrite 内先写 PromoLink、Article、审计及任务/任务条目，随后注入违规状态写，整笔事务回滚，所有快照不变。

空库从零执行全部 20 条迁移；存量路径在独立数据库执行原 19 条迁移，插入五种状态意图及 `schedule_run.skip_reason` 样本，再执行新迁移。历史迁移名称/校验和/完成时间和样本整行摘要保持一致；两库各两次原子 grants 回放通过，再 deploy 无待执行迁移。静态及 live drift 为 0。

全部 18 个原运行器、最终门禁、迁移与回放标记、每条命令尾行、变异和清理记录见 [本次完整证据](evidence/b15-x9-2026-09-27.md)。原 catalog-batch 的 5 skipped 未计作通过，另在真实库开启三个生命周期开关补跑 11 条，0 skipped。

p1-05b / p1-06 按 Owner 要求不修改：原始退出码均 1，实际分别在第 79 / 196 行 lint 命中 B-16 的 3 个旧错误。p1-06 的 43 表、3 迁移旧断言及 Bash 3.2 的失败不中止问题单列交接，不能记作通过；已执行的源库/恢复库 drift 与真实库测试如实记录，未执行的后续步骤不倒填。

### 全量首轮与复跑

`npm test -- --maxWorkers=4` 首轮 exit 1：3 个文件、4 条用例失败，另有 2 个 Vitest `onTaskUpdate` Unhandled Error。失败包括 B-14 的文章列表 5s 超时，以及非白名单的 Lane B sampler 两条 90s 超时、sitemap Bash 5 用例 15s 超时；这些不能直接按 B-6/B-14 例外算通过。
保留首轮日志，依 B-14 例外以 `npm test -- --maxWorkers=2` 完整重跑；没有跳过用例、提高超时阈值或修改相关测试。第二轮 exit 1，剩余 Docker Bash 5 文件 3 条超时及 2 个通信超时；sampler 与 B-14 均通过。随后以单 worker 隔离复核该文件，仍 3 failed / 65 passed / 1 Unhandled Error，因此没有启动原计划的第三轮串行全量。该文件及执行脚本相对合并基线完全相同；当前保留门禁阻断，不擅自扩大例外白名单。各轮结果与错误检查列在完整证据中。`npm run build` exit 0，静态 drift exit 0。

### 改动文件与红线

- `prisma/migrations/20260927090000_side_effect_manual_review_guard/migration.sql`：唯一新增数据库防线。
- `scripts/run-x9-postgres-verification.sh`、`tests/integration/task-admin/x9-postgres.test.ts`：双迁移路径、双回放与 27 条分层断言。
- `scripts/check-database-dictionary-drift.mjs`、`tests/backend/database/p1-06-static.test.ts`、`docs/governance/database-schema-dictionary.jsonl`：函数精确 catalog 校验与数量/对象登记。
- `docs/governance/database-governance.md`、`docs/adr/ADR-B15-MANUAL-REVIEW-BOUNDARY.md`、本报告和证据文件：Owner 决策、权限边界与验证记录。

相对合并提交核对 `src/`、`worker/`、grants、Prisma schema、历史迁移和 p1-05b/p1-06 运行器无差异。生命周期业务逻辑和状态机业务图未改。参考 CPS 两工作区保持执行前 HEAD/status 字节一致。
