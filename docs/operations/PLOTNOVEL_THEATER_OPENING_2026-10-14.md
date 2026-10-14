# PlotNovel 剧场开通手册（v0.6.0，口令码模式）

- 状态：随 v0.6.0 交付的**草稿**，未执行。本文件不代表生产授权；每一步的生产变更档位由主控 / Codex 按"生产变更三档制度"判定，下表的"建议档位"只是起点。
- 背景与设计：`docs/adr/ADR-V060-PLOTNOVEL-CODE-THEATER.md`。
- 前提：v0.6.0 已发布。**发版要点（数据库）**：
  - **1 个迁移**：`20261014120000_code_mode_upstream_code_guard`（迁移数 26 → 27）。内容：`promo_link` 加一列 `upstream_code_present`（`BOOLEAN NOT NULL DEFAULT false`，加列不重写表，只需瞬时的表锁）、一个维护它的触发器与触发器函数、一个 SECURITY DEFINER 取码函数 `public.code_mode_upstream_code(text)`；迁移末尾对有口令码的行做一次"原值写回"的空更新来回填布尔列（只碰 `upstream_code` 非空的行，不改 `updated_at`）。**函数属主是执行迁移的角色，发版必须用 `migration_owner` 跑 `migrate deploy`**（`grants.sql` 也由它重放）。
  - **`infra/postgres/grants.sql` 有改动，必须在迁移之后重放**（发版的数据库准备步骤本来就会重放；重放是幂等的）：`web_app` 对 `promo_link` 的列授权由 `(web_url, app_url, upstream_code)` 改为 `(web_url, app_url, upstream_code_present)`——**`web_app` 从此读不到 `upstream_code`**；新增 `GRANT EXECUTE ON FUNCTION public.code_mode_upstream_code(text) TO web_app`。迁移和重放之间不要让新版 web 对外服务（重放前 `web_app` 没有 `upstream_code_present` 的读权限，公开页会报 `permission denied`）。
  - 无新增环境变量。
  - 发版本身不改变任何线上行为：新剧场尚未登记，MoboReader 的 `config` 里没有 `promoMode`，一律按 link 处理。
- 执行方式：脚本在 worker 容器里跑（`DATABASE_URL` 是 `worker_app`）。命令里的容器名以 `docker ps` 为准；一律加 `</dev/null`，不要让 `docker exec` 吃掉终端输入。
- 🔴 铁律：任何输出、截图、聊天里**不得出现上游口令码**；下面的只读核对一律只数数，不打印 `upstream_code`。

## 总览

| 步骤 | 做什么 | 建议档位 | 可逆性 |
| --- | --- | --- | --- |
| 0 | 发版后只读核对 | L1 | 只读 |
| 1 | 登记 PlotNovel 剧场（默认停用） | L2 | 行是惰性的，不需回关 |
| 2 | **中止**含 1351 书目的在途任务，暂停其余领取 | L2 | 暂停可批次级恢复；中止不可恢复 |
| 3 | 存量改挂（备份 → 预演 → 带数量 apply） | **L3 / P3，Owner Gate** | 以备份为准，不建议数据回滚 |
| 4 | 剧场置 active，**对账分类归属**，打开 `claimPromo` | L2 | 见步骤 8 的警告 |
| 5 | 恢复领取（先金丝雀，再放量） | L2 | 批次级暂停 / 中止 |
| 6 | 试读白名单是否加 `plotnovel` | L2～L3（改环境变量要重建容器） | 回改环境变量 |
| 7 | 批量生成与发布（单批 ≤ 500） | L2 | 撤回受"公开网址冻结"约束 |
| 8 | 回滚方法 | — | — |

**顺序不可调换**，关键的两个因果：

- 步骤 4 的"置 active"必须在步骤 3 的改挂**之后**。目录扫描只把书落到 active 的剧场；如果先置 active，窗口内新扫到的机构 1351 的书会在 PlotNovel 下建档，而存量还在 MoboReader 下——两边都有同一本书，改挂的"唯一键冲突"闸门会拒绝执行。
- 步骤 5 的恢复领取必须在步骤 4 之后：领取批次入队要求剧场 active 且 `claimPromo` 已 enabled，否则整批按"渠道绑定或能力不可用"阻断。

## 步骤 0：发版后只读核对（L1）

在只读会话里以**特权角色**（`migration_owner` 或只读运维账号）跑（`PGOPTIONS='-c default_transaction_read_only=on'`，SQL 走标准输入；不要用 `web_app` 跑，它本来就读不了其中一些对象）：

```sql
-- 0) 迁移已应用：期望 27 个已完成迁移，最新一条是 20261014120000_code_mode_upstream_code_guard
SELECT count(*) AS applied, max(migration_name) AS latest
FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

-- 1) 列级授权（期望：f / f / f / t / f / f / t / t）——web_app 读不到口令码本身，只读派生布尔列
SELECT has_column_privilege('web_app',       'promo_link', 'upstream_code',         'SELECT') AS web_reads_code,
       has_column_privilege('scheduler_app', 'promo_link', 'upstream_code',         'SELECT') AS scheduler_reads_code,
       has_column_privilege('analyst_ro',    'promo_link', 'upstream_code',         'SELECT') AS analyst_reads_code,
       has_column_privilege('web_app',       'promo_link', 'upstream_code_present', 'SELECT') AS web_reads_present,
       has_column_privilege('scheduler_app', 'promo_link', 'upstream_code_present', 'SELECT') AS scheduler_reads_present,
       has_column_privilege('analyst_ro',    'promo_link', 'upstream_code_present', 'SELECT') AS analyst_reads_present,
       has_column_privilege('scheduler_app', 'channel_app', 'config',               'SELECT') AS scheduler_reads_theater_config,
       has_column_privilege('scheduler_app', 'promo_link',  'channel_app_id',       'SELECT') AS scheduler_reads_promo_app;

-- 2) 取码函数的形状与授权（期望：migration_owner / t / {"search_path=pg_catalog, public"} / t / f / f / f / f；acl 里没有空 grantee）
SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.proconfig AS config,
       has_function_privilege('web_app',       p.oid, 'EXECUTE') AS web_exec,
       has_function_privilege('worker_app',    p.oid, 'EXECUTE') AS worker_exec,
       has_function_privilege('scheduler_app', p.oid, 'EXECUTE') AS scheduler_exec,
       has_function_privilege('analyst_ro',    p.oid, 'EXECUTE') AS analyst_exec,
       has_function_privilege('backup_role',   p.oid, 'EXECUTE') AS backup_exec,
       p.proacl::text AS acl
FROM pg_proc p WHERE p.oid = 'public.code_mode_upstream_code(text)'::regprocedure;
-- 属主不是 migration_owner（例如用超级用户跑了迁移）→ 用超级用户执行 ALTER FUNCTION public.code_mode_upstream_code(text) OWNER TO migration_owner;
-- 并重放 grants.sql，再重读本条

-- 3) 触发器在位且启用（期望：O = 始终启用）
SELECT tgenabled FROM pg_trigger WHERE tgname = 'promo_link_upstream_code_present_sync' AND tgrelid = 'public.promo_link'::regclass;

-- 4) 回填一致（期望三个都是 0；只数数，不打印口令码）。空白口径必须和触发器一模一样：下面这串 U&'…' 就是迁移里触发器函数
--    btrim 用的 25 个字符（与 JS String.prototype.trim 同一套），不能写成 btrim(upstream_code)（那只去空格，会把只含制表符 / NBSP 的口令码误报）
SELECT count(*) FILTER (WHERE upstream_code IS NOT NULL AND coalesce(btrim(upstream_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') <> '' AND NOT upstream_code_present) AS nonblank_but_flag_false,
       count(*) FILTER (WHERE upstream_code IS NOT NULL AND coalesce(btrim(upstream_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') = '' AND upstream_code_present) AS blank_but_flag_true,
       count(*) FILTER (WHERE upstream_code IS NULL AND upstream_code_present) AS null_but_flag_true
FROM promo_link;

-- 5) 改挂前基线：机构 1351 的书目 / 推广链接现在挂在谁名下（期望全在 moboreader，数量与 10-14 的 3,830 / 2,599 同量级）
SELECT sa.code AS theater, count(DISTINCT s.id) AS items, count(p.id) AS promo_links
FROM novel_source_item s
JOIN channel_app ca ON ca.id = s.channel_app_id
JOIN source_app sa ON sa.id = ca.source_app_id
LEFT JOIN promo_link p ON p.novel_source_item_id = s.id
WHERE s.external_agency_id = '1351'
GROUP BY sa.code;
```

再做两个公开页冒烟（`curl -sI`，无副作用）：抽一篇 MoboReader 已发布书页应为 200；抽一个 MoboReader 的 `/go/<站内码>` 应 302 到它原来的网址——证明 link 模式未被碰到。

**必过**：迁移数 27；授权与函数读回与期望一致；触发器启用；回填一致（第 4 条三个计数全为 0）；基线数量已记下；冒烟正常。授权不对 → 停，先让发版负责人重放 `grants.sql`，不要继续。

再用 **`web_app` 身份**确认"读不到口令码"确实被拒（会得到 `permission denied`，这正是期望；只是确认，不会返回任何数据）：`SELECT upstream_code FROM promo_link LIMIT 1;`——应报 `ERROR: permission denied for table promo_link`。

## 步骤 1：发版后登记剧场（L2）

登记脚本幂等、默认只读预演，`--apply` 才写库。它做四件事（缺哪件补哪件）：给 MoboReader 的 `config` 补 `promoMode: "link"`、`agencyIds: ["3366"]`；新建 `source_app`（`plotnovel`）和同渠道下的 `channel_app`（`config.promoMode = "code"`、`agencyIds: ["1351"]`、`codeModeLocales: ["en"]`、`appDisplayName: "PlotNovel"`，**初始状态 `registered_disabled`**）；新建 4 条能力记录（`getlistpc`、`getbydataid`、`getchapterinfo`、`claimPromo`，一律 `registered_disabled`）；按参数写商店链接。每一类实际改动各一条 `operation_audit`。

```bash
# 预演（不写库）
docker exec -e PLOTNOVEL_THEATER_OPERATOR=<operator> cps-novel-worker-1 \
  tsx scripts/register-plotnovel-theater.ts \
  --request-id plotnovel-register-20261014 --reason "v0.6.0 登记 PlotNovel 剧场" \
  --app-store-url '<App Store 地址 | none>' --google-play-url '<Google Play 地址 | none>' </dev/null
# 看清预演里"要新建什么"，再加 --apply 执行同一条命令
```

- 商店链接**待 Owner 提供**，只认 `https:` 绝对地址；两个都没有也可以先登记（填 `none` 或不传），中间页会显示 `Search "PlotNovel" in your app store`，以后补链接用同一个脚本、换一个新的 `--request-id`，每次改动一条审计。
- 已有行与登记内容不一致时脚本报 `metadata_drift` 并停下，不会悄悄覆盖。

**必过读回**：

```sql
SELECT sa.code AS theater, ca.status, ca.config->>'promoMode' AS promo_mode, ca.config->'agencyIds' AS agency_ids
FROM channel_app ca JOIN source_app sa ON sa.id = ca.source_app_id ORDER BY sa.code;
-- 期望：moboreader / active / link / ["3366"]；plotnovel / registered_disabled / code / ["1351"]
SELECT sa.code, cc.capability_key, cc.status
FROM channel_capability cc JOIN channel_app ca ON ca.id = cc.channel_app_id JOIN source_app sa ON sa.id = ca.source_app_id
ORDER BY sa.code, cc.capability_key;  -- plotnovel 的 4 条全部 registered_disabled
```

此时线上行为零变化：目录扫描只落到 active 剧场，PlotNovel 还是 `registered_disabled`；那批书仍在 MoboReader 名下，仍不就绪。

**回关**：不需要。登记出来的行是惰性的（外键 `RESTRICT`，也不应删除）。

## 步骤 2：中止含 1351 书目的在途任务，暂停其余领取（L2）

改挂的前置闸门只看**条目状态**：这批书（及其小说、挂在其推广链接上的文章）上不能有 `pending` / `processing` 的任务条目，也不能有进行中的目录扫描。**暂停不改条目状态**——被暂停的批次里条目仍是 `pending`，闸门照样拦。所以：

> **凡是含机构 1351 书目、且条目尚未完成的领取批次，必须"中止"（cancel），不能只"暂停"。** 暂停只对不含 1351 书目的纯 MoboReader 批次有意义。

1. **先跑一次预演**（步骤 3.3 的只读命令，随时可以重复跑）。看报告里的 `blockers.pendingGenericTaskItems.sample`：每条给出 `task_id`、`task_type`、`task_status`、`item_status`；`pendingSyncTaskItems` 是试读补采，`activeCatalogScans` 是进行中的目录扫描。这些就是要处理的任务。
2. **含 1351 书目的领取批次 → 中止。** 后台任务页（需 `task:manage` + 2FA）二选一：
   - 批次详情页「中止批次」：批次下所有未完成的分片（含仍在排队、从未放行过的 `disabled` 分片）一起终止；
   - 分片详情页「中止」：只终止这一个分片（分片的暂停 / 恢复要去批次页，中止可以在分片页直接做）。

   中止的效果：该任务下 `pending` 条目立刻变为 `skipped`，**正在处理（`processing`）的条目会正常跑完**，不会触发新的领取调用；已成功 / 已失败的历史不改写。中止**不可恢复**，所以只中止含 1351 书目的，被中止批次里还没领的书在步骤 5 重新提交。
3. **不含 1351 书目的纯 MoboReader 领取批次 → 批次级「暂停」即可**（预演的 sample 里不会出现它们）。暂停只阻止放行新分片，已放行的分片会跑完（放行后 90 分钟窗口）；步骤 5 再「恢复」。
4. **其它在途任务**：文章生成叶子、自动打标、文章发布、物化、试读补采，等它们跑完，或在任务页对单个任务「中止任务」（同样是 `pending` → `skipped`，`processing` 跑完）。
5. **目录扫描**只有运营在后台 `/catalog-sync` 手动发起（没有定时扫描）：窗口期不要发起新的，进行中的等它结束或中止。
6. 每处理一轮就重跑预演，直到下面的"必过证据"成立。`processing` 的条目需要几分钟才会收尾，预演里它们消失之前不要急着 apply。

**必过证据**：预演报告里 `blockers.pendingGenericTaskItems.total`、`pendingSyncTaskItems.total`、`activeCatalogScans.total` 全为 0，`blocked: false`，进程退出码 0（有拦截项时是 2）。这一步没有单独的读回，闸门就是预演本身。

**回关**：只能回关「暂停」——对被暂停的批次做批次级「恢复」。「中止」不可恢复。

## 步骤 3：改挂（L3 / P3，需 Owner Gate）

### 3.1 改挂前备份

由 Codex 按生产备份 SOP 执行：读回最近一次基础备份与 WAL 归档的新鲜度，并另做一份受影响表的逻辑导出（`novel_source_item`、`promo_link`、`side_effect_intent`、`source_label`、`novel_source_item_label`、`source_label_mapping`），把备份编号记进下面命令的 `--reason`。**没有备份编号不得 apply。**

### 3.2 `title_normalized` 回填（同名去重的前置）

同名去重对对侧 `title_normalized` 为 NULL 的老书只能退而按"忽略大小写相等"取候选，书名只差标点的会漏判。改挂前先把 NULL 清零（幂等，可重复）：

```bash
docker exec cps-novel-worker-1 tsx scripts/backfill-novel-title-normalized.ts --dry-run </dev/null   # 看会动多少行
docker exec cps-novel-worker-1 tsx scripts/backfill-novel-title-normalized.ts </dev/null              # 默认单次 5000 行，重复跑到 0
```

### 3.3 预演（只读）

```bash
docker exec -e PLOTNOVEL_REHOME_OPERATOR=<operator> cps-novel-worker-1 \
  tsx scripts/rehome-plotnovel-source-items.ts \
  --request-id plotnovel-rehome-20261014 --reason "v0.6.0 PlotNovel 存量改挂；备份 <备份编号>" </dev/null
```

读报告里的 `counts`：`sourceItems`（要挪的书目）、`promoLinks`（含软删除的）及按状态分布、`sideEffectIntents`、`labelLinks`、`sourceLabelsToCreate`、`mappingEdgesToCopy`；`sourceItemsAlreadyAtTarget` 应为 0。生产 10-14 的参考值是书目 3,830、推广链接 2,599（已领 2,009、排队 590）——**以预演为准，与参考值差得多就停下来查**。

`blockers` 必须全为 0：

| 拦截项 | 含义 | 处理 |
| --- | --- | --- |
| `pendingGenericTaskItems` / `pendingSyncTaskItems` / `activeCatalogScans` | 还有未完成的任务条目（目标是这批书目、它们所属的小说、或挂在这批推广链接上的文章：领推广、物化、文章生成、自动打标、文章发布……）/ 试读补采条目 / 进行中的扫描 | 回步骤 2，**中止**（不是暂停）后重跑预演 |
| `uniqueKeyConflicts` / `promoKeyConflicts` | 目标剧场下已有同 (外部书号, 语种码) 的书目 / 推广链接新键撞车 | 查为什么 PlotNovel 下已有数据（通常是窗口期被置 active 过），人工处理后再来 |
| `publishedArticles` | **已有"已发布"文章挂在这批推广链接上**，改挂可能改变已公开页面的可见性（公开网址冻结） | 不得继续，交 Owner 单独决定；预期为 0 |
| `itemsUnderOtherApps` / `promoLinksNotAtSourceApp` | 历史数据不一致 | 人工核对后再来 |

预演有拦截项时退出码为 2；打印的 `sample` 是前 50 条明细。

### 3.4 执行

把**预演里读到的**数量填进来（不要抄本文的参考值）：

```bash
docker exec -e PLOTNOVEL_REHOME_OPERATOR=<operator> cps-novel-worker-1 \
  tsx scripts/rehome-plotnovel-source-items.ts \
  --request-id plotnovel-rehome-20261014 --reason "v0.6.0 PlotNovel 存量改挂；备份 <备份编号>" \
  --apply --confirm REHOME_PLOTNOVEL_SOURCE_ITEMS \
  --expected-source-items <预演的 sourceItems> --expected-promo-links <预演的 promoLinks> </dev/null
```

数量不符、确认短语不对、任一拦截项非 0 都直接拒绝且一行不写。成功时单事务完成并写一条 `operation_audit`（动作 `plotnovel.rehome.apply`）。

### 3.5 读回（必过）

- 再跑一次预演：应得到 `noop: true`、`sourceItems: 0`、`sourceItemsAlreadyAtTarget` = 刚才改挂的数量（重复执行改挂 0 行、不写审计）。
- 步骤 0 的基线 SQL 再跑一次：机构 1351 的书目 / 推广链接全部在 `plotnovel` 名下。
- 抽 3 条推广链接确认：`public_redirect_code` 没变（站内码不变，`/go/<码>` 不受影响），已领取的仍是 `fetched`。
- `side_effect_intent` 里原先 `target_type = 'promo_link'` 的行状态不变、`channel_app_id` 已跟到 PlotNovel。

**回关**：没有逆向脚本。数据层回滚只能以 3.1 的备份为准，且改挂之后一旦已经领取 / 发文就不建议回滚（会丢掉之后的领取结果）。发现问题优先向前修。

## 步骤 4：剧场置 active，打开 `claimPromo`（L2）

```bash
# 4a 剧场置 active（改挂完成之后！）
docker exec -e PLOTNOVEL_THEATER_OPERATOR=<operator> cps-novel-worker-1 \
  tsx scripts/register-plotnovel-theater.ts \
  --request-id plotnovel-activate-20261014 --reason "v0.6.0 改挂完成，PlotNovel 剧场置 active" \
  --set-app-status active --apply </dev/null

# 4b 打开领取能力（先预演；--evidence 填改挂读回记录，--reason 必填）
docker exec -e CHANNEL_CAPABILITY_OPERATOR=<operator> cps-novel-worker-1 \
  tsx scripts/set-channel-capability-status.ts \
  --channel-app <PlotNovel 的 channel_app.id> --capability claimPromo --to enabled \
  --reason "v0.6.0 改挂完成，继续领取排队的 PlotNovel 书" --evidence "<改挂读回记录>" [--apply] </dev/null
```

- **`getlistpc` 保持 `registered_disabled`。** 目录扫描按任务剧场绑定，运营继续在 MoboReader 名下发起扫描即可（书会按机构自动落到 PlotNovel）；打开 PlotNovel 的 `getlistpc` 只会多出一条"在 PlotNovel 名下扫同一份上游目录"的路径，浪费上游额度，没有收益。
- 试读两项（`getbydataid`、`getchapterinfo`）留到步骤 6 决定。
- 领取的全局环境闸（`FEATURE_PROMO_LINK_CLAIM`、`PROMO_LINK_CLAIM_ALLOW_WRITE`）是两个剧场共用的，不按剧场区分：MoboReader 的领取一直在跑就说明它们已经是开的，**不需要改**；读回确认即可，不要为此动环境变量。

```bash
# 4c 对账分类归属（置 active 之后立刻做；L2）
docker exec cps-novel-worker-1 tsx scripts/ops/effective-tag-projection.ts check </dev/null      # 此刻 missing 非 0 是预期：这批书的归属还没按 PlotNovel 重算
docker exec cps-novel-worker-1 tsx scripts/ops/effective-tag-projection.ts reconcile --apply --confirm RECONCILE-EFFECTIVE-TAGS </dev/null
docker exec cps-novel-worker-1 tsx scripts/ops/effective-tag-projection.ts check </dev/null      # 必须 missing=0 extra=0 changed=0
```

**为什么要对账**：分类归属（`novel_effective_tag`）只认 `active` 的剧场名下的标签与映射。改挂时 PlotNovel 还是 `registered_disabled`，这批书暂时没有归属；置 active 之后必须对账一次，归属才回到改挂前的样子（真实库用例钉着：对账后与改挂前逐行相同）。步骤 3 与步骤 4 之间不要停太久——这段窗口里站点地图每次刷新前的兜底对账会把这批书的归属清掉，置 active 后再对账补回来；这批书此时尚未公开，没有可见影响，但不要在窗口里做分类 / 映射的编辑。

**必过读回**：步骤 1 的两条读回 SQL——`plotnovel` 为 `active`，`claimPromo` 为 `enabled`，其余三条仍 `registered_disabled`；上面最后一次 `check` 为 `missing=0 extra=0 changed=0`。

此时目录扫描开始按机构分流：新扫到的机构 1351 的书落到 PlotNovel，机构 3366 的落到 MoboReader；扫描结果里 `agencyRouting` 记录每个剧场分到多少本、`unmappedBooks` / `unmappedAgencies` 记录退回任务剧场的（新机构）。

## 步骤 5：恢复领取（L2）

1. 对步骤 2 里被"暂停"（未中止）的 MoboReader 批次做批次级恢复。
2. 在后台 `/catalog-sync` 为 PlotNovel 剧场提交领推广批次（`channelAccounts` 里给 PlotNovel 剧场选与 MoboReader 同一个渠道账号）。**先金丝雀**：选 20～50 本排队的，等跑完看结果；上游 `getcode` **不幂等**，所以不要重复提交同一批。
3. 金丝雀正常再放量。剩下的约 590 条由 PlotNovel 剧场继续领；批次页给出预计完成时间。

**必过读回**：

```sql
SELECT p.status, count(*) FROM promo_link p
JOIN channel_app ca ON ca.id = p.channel_app_id JOIN source_app sa ON sa.id = ca.source_app_id
WHERE sa.code = 'plotnovel' GROUP BY p.status;           -- fetched 持续增加，failed 很少
SELECT count(*) FROM side_effect_intent i
JOIN channel_app ca ON ca.id = i.channel_app_id JOIN source_app sa ON sa.id = ca.source_app_id
WHERE sa.code = 'plotnovel' AND i.status = 'manual_review_required';   -- 与改挂前同一批，不应因领取而新增
```

**回关**：批次级暂停（出现大量 failed 或 `manual_review_required` 新增时先暂停再查）。

## 步骤 6：试读白名单是否加 `plotnovel`（L2～L3，需 Owner 决定）

背景：试读补采只处理来源应用代码在 `MOBOREADER_PREVIEW_SOURCE_APP_CODES`（逗号分隔，缺省 `moboreader`，compose 已向 web / worker / worker-light 透传）里的书，并且要求该剧场的 `getbydataid` 与 `getchapterinfo` 都是 `enabled`。PlotNovel 的书**不在白名单里就没有试读章节**；没有试读**不阻断发布**（试读缺失只是发布前的警告）。

我们**没有**验证过上游对机构 1351 的书是否返回章节内容（本版不访问上游）。所以建议：

1. 默认**先不加**，先走步骤 7 的金丝雀，确认口令码链路正常；
2. Owner 决定要试读时：把环境变量改为 `MOBOREADER_PREVIEW_SOURCE_APP_CODES=moboreader,plotnovel`，打开 PlotNovel 的 `getbydataid`、`getchapterinfo` 两条能力（同步骤 4b 的命令，`--capability` 换名），重建 web / worker / worker-light 容器；
3. **先对 5～10 本做试读**，读回 `preview` 成功率；失败（上游不给内容）就回关：从白名单里去掉 `plotnovel`、两条能力回 `registered_disabled`，已发布的书继续只有口令码入口，不受影响。

## 步骤 7：批量生成与发布（L2，单批 ≤ 500 篇）

1. 在后台"生成"页确认：PlotNovel 的英语书出现在候选里；与 MoboReader 同语种同名、且 MoboReader 那本有就绪推广的（约 20 本）显示不可生成原因"MoboReader 已有同名书"（MoboReader 那本没有就绪推广——还没领到码、没有网址——的，PlotNovel 这本照常可生成）；非英语书不在候选里（就绪规则挡住）。
2. **金丝雀**：先生成并发布 20～50 篇，抽 5 篇做下面的只读核对，全部通过再按每批 **≤ 500 篇** 放量（IndexNow 已开，发布即推送，批量也别一次性太大）。

每篇抽查（`curl`，无副作用；站内码取文章正文里的 `/go/<码>`，**不要**取库里的口令码）：

| 检查 | 期望 |
| --- | --- |
| 书页 / 章节页 / 文章页 | 200；按钮写 `Read on PlotNovel App`，下一行小字 `Free app · your book code is on the next page` |
| 页面 HTML 与 `sitemap` | **不含上游口令码**（把口令码从库里读出来在本机 `grep -c`，只看计数，不贴出来；期望 0） |
| `curl -sI /go/<站内码>` | 302，`Location` 是 `/go/<站内码>/app`（相对路径）|
| `curl -sI /go/<站内码>/app` | 200，`Cache-Control` 含 `no-store`；HTML 里 `meta robots` 为 `noindex, nofollow, nocache` |
| MoboReader 的某个 `/go/<站内码>` | 仍 302 到原网址（link 模式不变） |
| 中间页 | 大号口令码 + 复制按钮 + 三步说明 + 商店按钮（链接没配则显示 `Search "PlotNovel" in your app store`）；页面上**没有**免责小字（运营 10-14 去掉）；首页轮播里**没有** PlotNovel 的书 |

## 步骤 8：回滚方法

按"已经走到哪一步"选，**越靠前越容易**：

| 走到哪 | 怎么回 |
| --- | --- |
| 只做了步骤 1（登记） | 不用回。惰性行不影响任何行为 |
| 步骤 2（暂停 / 中止了领取） | 批次级恢复被暂停的批次；被中止的批次不可恢复，把还没领的书重新提交 |
| 步骤 3（已改挂）、还没开能力 | **不建议回滚数据**，向前修。必须回滚时 = 以 3.1 的备份恢复（L3 / Owner Gate），且要先确认改挂之后没有新的领取 / 发文；恢复后同样要 `effective-tag-projection.ts check`，不为 0 就 `reconcile` |
| 步骤 4～5（已 active、已开 `claimPromo`） | 能力回关：`set-channel-capability-status.ts --capability claimPromo --to registered_disabled --reason … --apply`；领取批次批次级暂停 / 中止。**⚠ 不要把 PlotNovel 置回 `registered_disabled`，除非同时保证目录扫描一直暂停**——改挂之后书目已在 PlotNovel 名下，目录分流一旦退回任务剧场，下一次扫描会在 MoboReader 名下重建同一批书（唯一键按剧场分开），造成重复档和重复领取 |
| 步骤 6（加了试读白名单） | 环境变量去掉 `plotnovel`，两条能力回 `registered_disabled`，重建容器 |
| 步骤 7（已发布） | 停止后续批次。**已发布页面的撤回 / 下线受"公开网址冻结"约束，必须 Owner 单独批准**；批准后用现有"批量撤回"工具。不要用改配置的方式偷偷让页面 404 |
| 整体退回 v0.5.15 镜像 | 迁移是加法（一列、一个触发器、两个函数）且没有逆向脚本，旧代码不读它们，留着无害；`grants.sql` 若重放成旧版也无害（旧代码用不到新列与函数）。⚠ 旧代码不分剧场：**退回期间必须保持目录扫描暂停**，否则机构 1351 的书又会被记到 MoboReader 名下并与已改挂的存量重复；旧代码要求推广有网址，已发布的 PlotNovel 页面会因"不就绪"变 404，同样属于冻结影响，需 Owner 批准 |

**紧急止血**（需要立刻让口令码模式的书从公开列表 / 站点地图消失）：把 PlotNovel 剧场 `config.codeModeLocales` 置为 `[]`（Codex 的 SQL，L3；下一次站点地图刷新后生效）。这会让这些页面变 404，属于冻结影响，必须 Owner 批准；事后该剧场的登记脚本会报 `metadata_drift`，恢复时要把配置改回登记值。本版没有给这件事做脚本开关（ADR 已知限制 L3 / L4）。
