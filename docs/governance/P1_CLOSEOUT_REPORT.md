# P1 收口报告

> 任务：P1-15 · P1 收口和 P2 交接
> 事实基线：本地 `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668`
> 日期：2026-08-06（Asia/Tokyo）
> 状态：P1-04～P1-14 已完成；P1-15 文档包待 GPT/Notion 更新与 Owner Gate
> 发布状态：未 push、未发布、未部署

## 1. 结论

P1-04～P1-13 的交付已进入本地 `main`，P1-14 已对同一精确树执行最终只读审计并给出
`P1_14_FINAL_AUDIT_PASS`、`REQUIRED_FIXES=NONE`。P1-13 的 PostgreSQL 16.14 真实验收为
PG 71/71、Backend 185/185、UI 469/469、Full 725/725。

本报告只关闭 P1 本地治理记录，不代表远端同步、发布、部署或生产放行。P2 仍须先完成
GPT/Notion 状态更新，并取得 Owner 明确 Gate。

```text
P1_FINAL_LOCAL_MAIN=fb8cddbdf7c8ff6b566169eade4a89258e7db668
P1_14_RESULT=P1_14_FINAL_AUDIT_PASS
P1_14_REQUIRED_FIXES=NONE
P1_15_STATUS=WAITING_FOR_GPT_NOTION_AND_OWNER_GATE
REMOTE_SYNC=NOT_ATTEMPTED_LOCAL_ONLY
RELEASED=NO
DEPLOYED=NO
```

## 2. 事实依据与证据纪律

本报告使用以下可追溯来源：

1. 本地 Git 对象库中的 `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668` 与其完整提交历史；
2. `docs/p1/`、`docs/p1/audit/` 中 P1-05～P1-12 的交付与复核报告；P1-04 以 Git 提交和
   `docs/governance/development-log.md` 为证；
3. Codex 任务 `019fd1fd-cd33-7041-85c5-5c28a0a88d91` 的 P1-13 最终线性集成记录，最终
   turn `019fd269-e3f3-7171-94d4-52b291d18430`；
4. ChatGPT 任务 `6a6cd384-33ec-83ee-8893-e3446c248c61` 的 P1-14 最终聚焦只读审计，报告
   turn `a858836d-c79d-4e78-ac37-e0f61ac5b28b`；
5. 本轮只读核验的本地 refs、文件路径和 CPS 状态。

P1-13 与 P1-14 的最终结果未以独立 Markdown 报告进入 `main`；本报告明确保留上述任务/turn
标识，不把它们伪装成仓库内文件。无法由现有来源证明的事实不得从本报告外推。

## 3. P1-04～P1-14 状态总表

| 任务 | 收口状态 | 最终进入本地 main 的证据 | 交付/验收证据 |
| --- | --- | --- | --- |
| P1-04 | COMPLETE_ON_LOCAL_MAIN | `527a890cf0fec5bdde1654412ee3855e0eb92192` | `docs/governance/development-log.md` 的 P1-04 记录；工程骨架提交 |
| P1-05 | COMPLETE_ON_LOCAL_MAIN | 最终锚点 `d7287729bd02b4f9957485aec6be96118efae864`；P1-05A/05B 提交均为 `main` 祖先 | `docs/p1/P1_05A_CLAUDE_DOMAIN_REREVIEW.md`、`docs/p1/P1_05B_MIGRATION_REPORT.md` |
| P1-06 | COMPLETE_ON_LOCAL_MAIN | `419ac82c8f8646b74b1621733a1954fdd7b12035` | `docs/p1/P1_06_DATABASE_OPERATIONS_REPORT.md`；角色测试与备份/恢复 PASS |
| P1-07 | COMPLETE_ON_LOCAL_MAIN | 最终修复锚点 `36c9ca6e8b39ec3041a845bb55d246412ac0ea79` | `docs/p1/P1_07_WORKER_SCHEDULER_REPORT.md`、`docs/p1/P1_07_REMEDIATION_REPORT.md`、`docs/p1/audit/P1_07_SOL56_FOCUSED_CODE_REVIEW.md` |
| P1-08 | COMPLETE_ON_LOCAL_MAIN | 最终锚点 `93537a054566405ca3b653038e383e112072b023`；P1-08A/08B 全部提交均为 `main` 祖先 | `docs/p1/P1_08A_AUTH_FOUNDATION_REPORT.md`、`docs/p1/P1_08B_BACKEND_REPORT.md`、`docs/p1/P1_08B_CONTRACT_IMPLEMENTATION_REPORT.md`、`docs/p1/P1_08B_SECRET_INGRESS_GATE.md` |
| P1-09 | COMPLETE_ON_LOCAL_MAIN | `e88f38eee78968bfa1e72cf62d9ef263aa2885b4` | `docs/p1/P1_09_ADMIN_UI_REPORT.md`；最终 API/权限复核 `REQUIRED_FIXES=ZERO` |
| P1-10 | COMPLETE_ON_LOCAL_MAIN | P1-10 主提交链 `3be24e4dac0e2c69135b57806da20f9aeadfddb8`～`a18741641e4af000a9f008efd38ba11895f2b0bb`，最终设置默认修复 `350d0ddff953bd46f89df1b174123f2483879c40` | `docs/p1/P1_10_VISUAL_DIRECTION.md`；公共 UI 与视觉基准提交 |
| P1-11 | COMPLETE_ON_LOCAL_MAIN | `4e0a4b9c97d21c127c23475bb0cf99ea7c706397` | `docs/p1/P1_11_READER_REPORT.md`；阅读器实现、浏览器与回归证据 |
| P1-12 | COMPLETE_ON_LOCAL_MAIN | 最终锚点 `9b576dd7b6cde4a3d5c5579357d375dcc0f85f7e` | `docs/p1/P1_12_FINAL_E2E_REPORT.md`；四容器与 Health E2E PASS |
| P1-13 | COMPLETE_ON_LOCAL_MAIN | `23c67deb948c971c85017cf525ee9e0c4dfbc596`～`fb8cddbdf7c8ff6b566169eade4a89258e7db668` 的线性提交链；`main` fast-forward 到 `fb8cddb` | Codex P1-13 最终 turn；PG 71/71、Backend 185/185、UI 469/469、Full 725/725 |
| P1-14 | COMPLETE_READ_ONLY_AUDIT | 无代码提交；审计对象即 `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668` | ChatGPT P1-14 报告 turn；`P1_14_FINAL_AUDIT_PASS`、`REQUIRED_FIXES=NONE`、9 项 `NON_BLOCKING_NOTES` |

表中所有 commit 均已在本地对象库解析，并已验证为 `main` 祖先；P1-14 是只读审计，故没有也
不应制造“进入 main 的审计代码提交”。

## 4. 当前本地 main、远端与 CPS

### 4.1 本地 main

```text
refs/heads/main=fb8cddbdf7c8ff6b566169eade4a89258e7db668
```

### 4.2 remote 未同步

本轮未 fetch、未 push。只读观察到本地缓存的 `origin/main` 为
`36c9ca6e8b39ec3041a845bb55d246412ac0ea79`，本地 `main` 相对该缓存 ref 为 ahead 52、behind 0。
缓存 remote-tracking ref 不是远端实时证明，因此本报告只声明：**本地 P1 提交尚未同步到已观察
的 `origin/main`，远端服务器实时状态 NOT_VERIFIED**。

### 4.3 CPS

只读参考仓库：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`

```text
CPS_HEAD=d77c3b968285698529cf97c7f0f97b286d7a2a9c
CPS_PORCELAIN=0
```

P1-14 审前/审后与 P1-15 本轮核验一致；CPS 未被修改。

## 5. P1-13 PostgreSQL 16.14 最终验收

P1-13 最终线性集成记录给出的门禁结果：

| 门禁 | 结果 |
| --- | --- |
| PostgreSQL 16.14 gated integration | **71/71 PASS** |
| Backend | **185/185 PASS** |
| UI | **469/469 PASS** |
| Full | **725/725 PASS** |
| locale-related skipped | **0** |
| Restore smoke | PASS |
| Project isolation | PASS（脚本及 6/6 测试） |

执行入口与证据文件为 `scripts/p1-13-postgres-verification.sh`、
`tests/integration/tasks/p1-13-postgres-acceptance.test.ts`、
`tests/integration/tasks/p1-07-postgres.test.ts`、
`tests/backend/p1-13-locale-single-source.test.ts`。P1-15 按任务边界未重新运行这些门禁。

## 6. P1-12 四容器与 Health E2E 摘要

`docs/p1/P1_12_FINAL_E2E_REPORT.md` 记录的精确验收树为
`dbede54cac2a8bf1b367cfca9dbb0e5d4060ba72`，后续 closeout 提交
`9b576dd7b6cde4a3d5c5579357d375dcc0f85f7e` 删除过期阻断提示并进入 `main`。

- Compose 仅含 postgres、web、worker、scheduler 四服务；
- Postgres 不暴露宿主端口，Web 仅绑定 `127.0.0.1`，长期进程不使用 migration owner；
- 四容器正常态均 running/healthy，restart=0；
- `/api/health` 正常态 HTTP 200，`Cache-Control: no-store`；
- runtime version/commit 错配返回 503 并使 Web unhealthy，恢复 claims 后恢复 200；
- Postgres 停机返回 503 `database_unreachable`，恢复同一数据库后 Web 自动回到 200；
- Scheduler 环境零 credential key；日志与响应未暴露 secret；
- 容器、network、volume 与临时 migration env 清理残留均为 0；
- 报告结论为 `P1_12_FINAL_E2E_PASS`、`REQUIRED_FIXES=NONE`。

## 7. 三条硬前置证据

### 7.1 Worker 原子领取、exactly-once 与 fencing

**实现证据**

- `src/lib/tasks/store.ts` 的三类 pending claim 都使用
  `FOR UPDATE OF i SKIP LOCKED`，并在同一事务中将 item 转为 processing；
- 每次 claim 生成新的 `execution_token` 并令 `lease_epoch + 1`；
- heartbeat/finalize 的写谓词同时校验 `execution_token`、`lease_epoch`、owner 与有效租约；
- stale recovery 只处理已过期 processing item，清空旧 token，回 pending 或 terminal failed；
- `worker/runtime/worker.ts` 将 `lease.mode` 传给 handler；dry-run 在 finalize 前移除
  `protectedWrite`，apply 路径保持业务写入。

**测试证据**

- `tests/integration/tasks/p1-07-postgres.test.ts`：
  - `gives one pending item to only one of two concurrent workers`；
  - `recovers expired lease through pending and fences the old owner`；
  - `recovers after a real worker child process is killed and restarted`；
  - 六条 pending/expired 独立索引路径，均含 `SKIP LOCKED`；
- `tests/integration/tasks/p1-13-postgres-acceptance.test.ts`：
  - `rejects a stale execution_token and a stale lease_epoch independently`；
  - `keeps dry-run free of upstream and business writes while retaining audit semantics`；
  - `keeps apply mode executing upstream and protected business writes`；
- `tests/backend/tasks/runtime-contract.test.ts` 验证三类 lease 的 mode 传播与 dry-run 仅抑制
  `protectedWrite`。

**结果证据**

P1-13 PostgreSQL 16.14 门禁 71/71：双 Worker exactly-once PASS；token 与 epoch 独立 fencing
PASS；stale/kill-restart recovery PASS；dry-run upstream calls=0、business writes=0，任务 result
与 audit 保留；apply upstream calls=1、business write=1。

### 7.2 locale 单一真源与 fail-closed

**实现证据**

- 唯一实现文件：`src/lib/locale/locale-canonical.ts`；
- 三个冻结 API：`resolveSiteLocale`、`isPublishableLocale`、`listPublishableLocales`；
- `UPSTREAM_LANGUAGE_REGISTRY=[]`；
- `PUBLISHABLE_LOCALES=[]`；
- 映射不到只返回 `unknown`，不猜测、无区域回退；映射成功与可发布是两道独立门禁。

**测试证据**

`tests/backend/p1-13-locale-single-source.test.ts` 验证三个导出 API，并扫描
`src/`、`worker/`、`scheduler/`，确保其他 runtime 文件不存在第二份语种映射实现。

**结果证据**

P1-13 backend 185/185，两个 locale 用例从 skipped 转为 PASS，locale-related skipped=0。
在 D-7 未关闭、上游 language 枚举没有正式证据、五项发布准入未齐备前，当前正确状态是
`resolveSiteLocale(*)="unknown"`、`isPublishableLocale(*)=false`、
`listPublishableLocales()=[]`，即 fail-closed。

### 7.3 章节表定稿与冻结边界

**Schema 与 migration 证据**

- `prisma/schema.prisma`：`Novel`、`NovelChapter`、`NovelChapterContent`；物理表分别为
  `novel`、`novel_chapter`、`novel_chapter_content`；
- `Novel.id`、`NovelChapter.id`、`NovelChapterContent.id` 为 UUID 主键；
- `novel_chapter.novel_id -> novel.id` 为 `ON DELETE RESTRICT`；
- `novel_chapter_content.novel_chapter_id -> novel_chapter.id` 为 `ON DELETE CASCADE`，且
  `novel_chapter_content_novel_chapter_id_key` 保证一章至多一份正文；
- `novel_chapter_content.source_fetch_id -> channel_sync_task_item.id` 为 `ON DELETE SET NULL`；
- Novel 状态为 `draft/ready/published/unpublished/takedown`；章节状态为
  `preview/locked/stale/withdrawn`；章节号必须大于 0，正文 `char_count >= 0`；
- 真实 DDL 位于 `prisma/migrations/20260803090000_p1_initial_schema/migration.sql`。

**PostgreSQL 测试证据**

- `tests/integration/database/p1-05b-postgres.test.ts` 在 PostgreSQL 16.14 上验证 migration、
  状态约束，并实际插入 `stale`/`withdrawn` 章节；
- `tests/integration/tasks/p1-13-postgres-acceptance.test.ts` 从 `pg_constraint` 读取并验证
  `novel_status_check`、`novel_chapter_status_check`、
  `novel_chapter_source_item_status_check` 等冻结 CHECK 均存在且 validated；
- P1-05B 报告记录 schema↔migration↔pg_catalog drift 为 0；P1-13 最终 PG 71/71 回归通过。

**不允许重新解释的边界**

- `docs/architecture/candidate-v0.2.1/novel-v1-evidence-reconciliation.md`：
  `allEpis` 只保存为 Novel 的总章数标量，不展开成章节行，不生成无标题占位；
- 当前可信且非空 `chapterList[]` 才是可物化/展示的章节集合；
- 旧章未再出现在可信列表中时立即转 `stale`（公开面 hidden/停展并退出 sitemap）；
- `stale` 章节重新出现时自动恢复 `preview` 并写审计；
- 请求失败、异常响应或异常空列表不得改变现有可见状态；
- 正文保留，不自动硬删；只有人工版权撤回可删除正文。

上述证明的是已冻结的数据模型、数据库约束与 P2 必须消费的行为边界；P1 没有伪称已经完成
真实上游章节同步或正式发布链路。

## 8. P1-14 最终审计

P1-14 使用 `git archive fb8cddb` 审计精确基线树，并复用已有 PostgreSQL/E2E 证据，没有重跑
容器、没有写入两个仓库。正式结论：

```text
RESULT=P1_14_FINAL_AUDIT_PASS
REVIEWED_HEAD=fb8cddbdf7c8ff6b566169eade4a89258e7db668
REQUIRED_FIXES=NONE
NON_BLOCKING_NOTES=9
CPS_STATUS=CLEAN@d77c3b968285698529cf97c7f0f97b286d7a2a9c
```

9 项 notes 的原意、触发点、建议 Owner 与 P2 优先级登记在
`docs/governance/P1_RISK_AND_DEBT_REGISTER.md`。任何一项都不得改写为 P1 required fix。

## 9. 待决项状态

状态只使用规定枚举。依据为
`docs/architecture/candidate-v0.2.1/novel-v1-open-decisions.md`、当前产品代码与测试。

| 项 | 状态 | 核查结论与证据 |
| --- | --- | --- |
| D-2 | OPEN | 正式文档仍只证实 `getlistpc` 请求体含 name/orderType/pageIndex/pageSize/projectType；是否支持 agency/app/language 服务端筛选未证。当前可按页码区间扫描，故不阻断已完成 P1 |
| D-7 | OPEN | 首发公开语种白名单仍需 Owner 决；`PUBLISHABLE_LOCALES=[]` 明确 fail-closed |
| D-8 | OPEN | 正式 URL 是否含 locale 段未定；`docs/p1/P1_11_READER_REPORT.md` 与 dev-preview path helper 明确不借 P1 冻结正式 URL |
| D-12 | RESOLVED | `src/features/public-ui/novel/NovelDetailScreen.tsx` 与 `PreviewChapterList.tsx` 明确把真实试读章节区域嵌入详情页，不建独立目录路由；`tests/ui/novel-detail.test.tsx` 验证锚点、列表逐条来自 `previewChapters`、无“完整目录/全部章节”宣称；`src/app` 无独立 catalog/chapters 目录路由 |
| W6 | OPEN | 域名独立已定；品牌文案/视觉口径仍待 Owner 与运营商定，P2 前台上线前必须关闭 |
| W9 | OPEN | 正式文档状态仍为“暂不”；阻塞有副作用 `claimPromo` 的受控首测与后续实现，不阻塞 P1/P2 已有资源读取链路 |
| R3 | OPEN | `PENDING_R3`；书籍/推广码收益归因维度尚未取得稳定样本，阻塞归因键和 P4 看板，不阻塞 P1/P2 |

## 10. P1 遗留与 P2 入口

- P1-14 的 9 项均为非阻断债务，详见 `docs/governance/P1_RISK_AND_DEBT_REGISTER.md`；
- P2 可复用基础、冻结边界、未决决策和首批建议工作见
  `docs/governance/P2_HANDOFF_INPUT.md`；
- `P1-15` 尚未完成 GPT/Notion 更新，也未取得 Owner release；
- 本地 `main` 不得仅凭本报告登记为已发布或已部署。

```text
NEXT_GATE=GPT_NOTION_UPDATE_THEN_OWNER_RELEASE
```
