# Owner 本地 UAT Runbook（2026-09-03）

> 范围：Owner 在本地 `https://novel.test` production-like 环境（X8 六服务拓扑）上，
> 对 Level UAT（见 `docs/p2/V020_RELEASE_CHECKLIST.md` "## 3. Flag 分级开放" →
> "### Level UAT：Owner 本地真实验收（不对外）"）做一次真实、不对外的端到端验收。
> 本文不是生产发布文档；Level R（收益上线）的字段清单在同一文件的 "### Level R"
> 一节，本轮不涉及生产部署动作。

## 1. 进入条件（四条，全部满足才能开始）

1. RC-1 已合入 `main`（Claim launcher / 领取入口相关改动落地为 `main` 的祖先提交）。
2. C2b 已验收：`docs/p2/V020_RELEASE_CHECKLIST.md` Level 0 的 C2b checkbox 已勾选，
   证据行引用 commit `5a6addf`、`tests/backend/adapters/moboreader.test.ts`
   190-204/206-230 行，本轮已在 HEAD `1b9f82c` 重跑 30/30 通过（见本仓库 RC-2 交付）。
3. 本地环境已按 Level UAT 的值起（flag/allowlist 目标值见
   `infra/production-like/.env.uat.example`；该文件当前是**值参考**，不是脚本会读取的
   注入点——见下文"已知限制"第一条）。
4. claim 相关 `ChannelCapability`（`getbydataid`、`getchapterinfo`、`claimPromo`，
   `projectType=1` 小说 scope）已由 `scripts/set-channel-capability-status.ts`
   置为 `enabled`，且该次 `--apply` 的 `OperationAudit` 行可查（见下文准备阶段）。

## 2. 准备阶段（由 Claude/Codex 完成，Owner 零手工）

### 2.1 起 X8 本地拓扑（Level 0 基线，命令today可用）

以下命令序列今天可直接工作，带来 Level 0（catalog dry-run，claim/sitemap/indexnow 全
false）的六服务拓扑；只列命令，不代表本轮已执行：

```bash
scripts/x8-production-like.sh setup     # 一次性：mkcert 信任 + /etc/hosts，仅 setup 允许改宿主机
scripts/x8-production-like.sh up        # 起六服务，拒绝抢占已被占用的端口
scripts/x8-production-like.sh status    # docker compose ps，确认六服务健康
scripts/x8-production-like.sh verify    # 拓扑/allowlist/nginx 反模式静态校验
```

### 2.2 现状缺口：今天的 CLI 无法把 topology 抬到 Level UAT

`scripts/lib/x8-production-like-env.sh` 的 `prepare_x8_environment()`
（77-84 行）把 `FEATURE_PROMO_LINK_CLAIM`、`PROMO_LINK_CLAIM_ALLOW_WRITE`、
`FEATURE_SITEMAP_AUTO_REFRESH`、`SITEMAP_AUTO_REFRESH_ALLOW_WRITE`、
`FEATURE_INDEXNOW_OUTBOX`、`FEATURE_INDEXNOW_DELIVERY`（及其写闸）硬编码为
`false`，无任何开关——脚本 `usage()` 里目前只有 `gate catalog-write
<on|off|dry-run|status>` 一个 tri-state 维度，没有 claim/sitemap/indexnow 的
对应项。同时：

- `scripts/x8-production-like.sh` 的 `validate_rendered_topology()`
  （80-90 行）硬断言 `WORKER_TASK_ALLOWLIST` 精确等于冻结的 Level 0 三项字符串
  `credential.validate.v1,credential.supersede.v1,catalog_scan`，不等则 `exit 65`。
- `scripts/acceptance/x8-validate-compose.mjs`（32-34 行）对渲染后的
  `docker compose config` 做同样的精确字符串断言，用于 `up` 内部（间接经
  `verify_x8`）与 `accept` 路径。

两处断言的对象都是 Level 0 的**三项**allowlist，而 Level UAT 需要**五项**
（追加 `moboreader.preview_refresh.v1`、`promo_link.claim.v1`）。这意味着
`up` / `verify` / `accept` 今天调用 `prepare_x8_environment()` 后就不可能把
claim 双闸真正置为 `true` 并通过拓扑校验——不是配置遗漏，是这两处校验函数把
Level 0 的具体值硬编码成了唯一合法值。

**本轮不修改 `infra/` 下的 `.sh`/`.mjs`**（属于运维脚本，任务范围排除）。这里
只登记需要的调整，供后续处理：

- `scripts/lib/x8-production-like-env.sh:77-84` 需要新增一个类似
  `X8_GATE_STATE_FILE` 的 claim gate 状态开关（例如 `gate claim
  on|off|status`），仿照既有 `write_x8_gate_state`/`gate_catalog` 的 tri-state
  实现，让 `FEATURE_PROMO_LINK_CLAIM`/`PROMO_LINK_CLAIM_ALLOW_WRITE` 可控。
- `scripts/x8-production-like.sh:85-89`（`validate_rendered_topology`）与
  `scripts/acceptance/x8-validate-compose.mjs:32-34` 需要把"精确等于 Level 0
  三项字符串"的断言改为"按当前 gate 组合校验对应的允许集合"（Level 0 三项 /
  Level UAT 五项二选一），而不是继续假设只有一种合法值。
- 在此之前，任何要在本地真实跑通 Level UAT 六项 claim 步骤（本文第 3 节步骤
  6-8）的人，必须先完成上述一个小改动，或者绕过 wrapper 手工
  `docker compose -p cps-novel-x8-local -f docker-compose.yml -f
  infra/production-like/docker-compose.yml` 直接操作并自行承担 wrapper 原本
  负责的证据/校验职责——本 Runbook 不建议后一种做法。

### 2.3 能力位脚本命令（含 evidence 参数格式）

三个能力键都要走同一个受审计脚本，`--channel-app` 用 MoboReader 小说
`ChannelApp` 的 UUID（从 `/channel-accounts` 页面或数据库查得，不在本文档记录
真实值）。**先 dry-run（不带 `--apply`）确认当前状态和将要发生的变化，再
`--apply`**：

```bash
CHANNEL_CAPABILITY_OPERATOR=<operator-handle> \
  tsx scripts/set-channel-capability-status.ts \
    --channel-app <channelAppId> --capability getbydataid \
    --to enabled --reason "RC-2 Level UAT enablement" \
    --evidence "docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md"
# 确认 dry-run 输出的 currentStatus/proposedStatus 符合预期后：
CHANNEL_CAPABILITY_OPERATOR=<operator-handle> \
  tsx scripts/set-channel-capability-status.ts \
    --channel-app <channelAppId> --capability getbydataid \
    --to enabled --reason "RC-2 Level UAT enablement" \
    --evidence "docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md" --apply
```

对 `getchapterinfo`、`claimPromo` 重复同样的 dry-run→apply 两步（把
`--capability` 换掉）。`--evidence` 是自由文本指针，不是文件路径校验——这里用
本 Runbook 的路径作为"这次启用的依据是什么"的记录，写入
`OperationAudit.afterSnapshot`（见 `src/server/channel-capability/service.ts`
顶部注释）。`CHANNEL_CAPABILITY_OPERATOR` 必填，即使是 dry-run。

### 2.4 如何确认 allowlist 生效

Worker 启动时会打印恰好一条结构化 JSON 日志（`worker/index.ts`
`resolveWorkerStartupAllowlist()`，47-56 行），形如：

```json
{"schemaVersion":1,"event":"worker_task_allowlist","level":"info","requested":[...],"effective":[...],"invalid":[...]}
```

`requested` 是 `WORKER_TASK_ALLOWLIST` 原始拆分结果，`effective` 是命中
已注册 handler 的子集（真正会被消费的任务类型），`invalid` 是未注册、会被
排除且在 `level=error` 时高亮的部分。确认 Level UAT 生效的判定是：
`effective` 恰好等于五项（`credential.validate.v1`、
`credential.supersede.v1`、`catalog_scan`、`moboreader.preview_refresh.v1`、
`promo_link.claim.v1`），`invalid` 为空数组，`level` 为 `info`。查看方式（沿用
`x8_compose()` 同样的 `-p`/`-f` 参数）：

```bash
docker compose -p cps-novel-x8-local \
  -f docker-compose.yml -f infra/production-like/docker-compose.yml \
  logs worker --no-color | grep worker_task_allowlist
```

## 3. Owner 执行 16 步

每步的"证据"默认指管理后台截图；标注"SQL"的额外用只读角色跑
`docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` 对应查询核对，不作为唯一证据来源。

| # | 动作 | 页面路径 | 通过标准 | 证据 |
|---:|---|---|---|---|
| 1 | 登录 + 2FA | `/login`（管理后台入口） | 二次验证通过，进入管理后台首页，会话建立 | 截图 |
| 2 | 录入 MoboReader 凭证；校验任务转绿 | `/channel-accounts` | `addOrReplaceCredential` 保存成功；credential validation 任务状态变为 completed/success（页面转绿） | 截图（任务状态） |
| 3 | 小页区间 dry-run→apply | `/catalog-sync`（page ≤ 3、pageSize=20，见"已知限制"） | dry-run 预览无报错后 apply；对应 `NovelSourceItem` 行出现在数据库/后台列表 | 截图 + SQL：`SELECT count(*) FROM novel_source_item WHERE created_at > ...` |
| 4 | 确认 preview 任务被消费 | `/tasks` | `moboreader.preview_refresh.v1` 对应 item 状态不再是 `pending`（success 或带诊断的 failed） | 截图（任务详情） |
| 5 | 单本 dry-run + apply 创建内容 | `/catalog-sync`（针对步骤 3 产出的某一 source） | 创建成功后 `/novels` 出现新 Novel（`draft`）+ Article（`draft`，`locale=en`）；章节在后台可见 | 截图（`/novels` 详情页） |
| 6 | 对**无 promo** 的书发起领取（apply） | `/catalog-sync` 勾选该书 → 发起 claim | `/tasks` 对应 item 变为 `completed`；`PromoLink.status=fetched`；`SideEffectIntent.status=confirmed`；本次 `getcode` 调用计数 = 1（decision=`claimed`，见 `worker/handlers/promo-link-claim.ts:434`） | 截图 + SQL：查 §3 side_effect_intent（此步应为 0 条 manual_review，不用该查询验证 fetched，仅作交叉核对） |
| 7 | 对**已有 promo** 的书发起领取 | `/catalog-sync` 勾选该书 → 发起 claim | 结果为 `already_available`（同一 handler 的第二个 decision 分支）；本次 `getcode` 调用计数 = 0；无新增上游写 | 截图（任务详情里的 decision 字段） |
| 8（可选，需 fixture） | 制造 readback 不确定场景 | `/tasks`（对应 item） | 结果落 `manual_review_required`（`worker/handlers/promo-link-claim.ts:374/709/711`），且不发生自动重试 | 截图 |
| 9 | 发布已具备 promo 的书 | `/novels/{novelId}` | `applyPublishTransition` 成功；Novel/Article 终态为 `published` | 截图（发布后状态） |
| 10 | 对**缺 promo** 的书尝试发布 | `/novels/{novelId}` | 被发布门禁拒绝，唯一/主要 reason 为 `promo_link_missing` | 截图（拒绝原因） |
| 11 | 前台三个路径返回 200 | `/`、`/browse`、`/novel/{slug}` | 三个路径 HTTP 200 | 截图或 `curl -I` 输出 |
| 12 | 章节可读、CTA 可见 | `/novel/{slug}/chapter/{n}` | 正文可读；章末 CTA（跳转按钮/链接）渲染出来 | 截图 |
| 13 | 点击 CTA，确认 302 与 TrackingEvent | 由步骤 12 页面跳转到 `/go/{code}` | HTTP 302；`Location` 指向上游 web/app 目标；数据库新增 1 条 `TrackingEvent{eventType:"go_redirect"}` | 截图（网络面板 302）+ SQL：`SELECT count(*) FROM tracking_event WHERE event_type='go_redirect' AND created_at > ...` |
| 14 | 无效码与软删码返回 404 | `/go/{不存在的码}`、`/go/{已软删的码}` | 两者均 HTTP 404（`src/app/go/[code]/route.ts` 对 `deletedAt != null` 和未命中记录均返回 `notFound()`） | 截图或 `curl -I` |
| 15（Claude/Codex 操作） | 停止 postgres 容器，验证故障可见性 | `/api/health`；再次点击步骤 13 的 CTA | `/api/health` 返回 503（`src/app/api/health/route.ts` 对 `report.ok=false` 返回 503，已核实）。**关于 CTA 302 的说明见下方脚注** | 截图 + `/api/health` 响应体 |
| 16 | 下架并 takedown | `/novels/{novelId}`（发布生命周期面板，`publish-lifecycle-panel`） | 公开页 `/novel/{slug}` 返回 404 且响应头 `X-Robots-Tag`/meta 带 `noindex`；已物化章节被撤回（不可读） | 截图（公开页 404）+ 截图（后台撤回状态） |

**步骤 15 脚注（核实结论，非假设）**：`src/app/go/[code]/route.ts` 对每次请求
都直接 `prisma.promoLink.findUnique(...)`，文件顶部显式 `export const dynamic =
"force-dynamic"`，且 `infra/production-like/nginx/snippets/capacity-locations.conf`
对 `/go/` 只设置限流和 `Cache-Control: no-store`，未见任何 `proxy_cache` 或
stale-if-error 配置。据此代码路径，PostgreSQL 真的停止后，`/go/{code}`
大概率不会返回 302（会话失败/5xx），因为它没有绕过数据库的缓存或回退分支。
本步骤按原计划执行并如实记录**真实观察结果**；如果实测确为非 302，这不是新
发现的回归，而是与当前实现一致的预期行为，请据实填写而不要为了凑"通过"而
更改判定标准。`/api/health` 503 这一半的判定已通过代码核实，可直接作为通过
标准。

## 4. 通过判定

16 步全部完成，且过程中：

- Owner 没有手工改任何 `.env`/compose 覆盖值；
- Owner 没有直接执行任何脚本（`scripts/*.ts`、`scripts/*.sh`）——脚本类操作
  全部由 Claude/Codex 在准备阶段完成，Owner 只在管理后台点击；
- Owner 没有直接改数据库（无手工 SQL 写操作；SQL 只用于步骤 3/6/13 的只读核
  对，走 `analyst_ro` 等只读角色，符合
  `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` 的执行纪律）。

三条任一不满足，本轮 UAT 记为不通过，需要重新走一遍受审计路径而不是补记录。

## 5. 证据归档位置与健康检查 SQL 执行时点

- 截图、命令输出等证据统一放在 `.tmp/x8-production-like/evidence/` 下（与
  `scripts/x8-production-like.sh accept` 现有的证据落盘目录一致），不进
  `docs/`、不进 Git；本轮结束后按当时的操作纪律清理或归档到 Owner 指定的
  外部位置。
- `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` 的五组 SQL 建议在以下时点各跑
  一次，形成前后对比：
  1. 步骤 2（凭证录入）完成后，跑第 1 组（task/item 状态分布），确认起点是
     干净的（无异常 pending 堆积）。
  2. 步骤 6/7（两次领取）完成后，跑第 1 组与第 3 组
     （`side_effect_intent` 待人工复核聚合），确认没有意外的
     `manual_review_required` 堆积。
  3. 步骤 8（若执行）完成后，单独跑第 3 组，确认这次人工复核确实出现且仅有
     这一条。
  4. 步骤 13 之后跑第 4 组（`promo_link` 超过 15 分钟未更新的 pending 行），
     确认没有卡住的 claim。
  5. 步骤 15（停 PG）恢复后，跑第 2 组（过期 processing 锁）与第 5 组
     （近 24 小时 `task_item.failed` 审计），确认停机期间产生的锁/失败已被
     Worker 正常回收/记录，而不是静默丢失。
  每组 SQL 都在只读事务里执行（`BEGIN TRANSACTION READ ONLY; ... COMMIT;`），
  不修复、不重试、不手工改行，这是该文件本身的既定纪律。

## 6. 已知限制

- **RC-3 合入前**：`/catalog-sync` 目录同步的页区间必须手动限定 **≤ 3 页、
  `pageSize=20`**；没有更宽范围的批量同步。
- **RC-4 前**：内容创建（source → Novel/Article）只能单条进行，没有批量创建
  流程；步骤 5 因此是"对某一个 source 单独走一次 dry-run+apply"，不能对
  步骤 3 产出的全部 source 一次性创建。
- **Sitemap 在 UAT 不开**：Level UAT 明确保持
  `FEATURE_SITEMAP_AUTO_REFRESH=false`；`${SITE_URL}/sitemap.xml` 在本轮预期
  返回非 200（例如 503 或等价的"未生成"响应），这是预期行为，不是本轮要修的
  缺陷。Sitemap 的验证只在 Level R（生产）阶段做。
- **本 Runbook 第 2.2 节登记的脚本缺口**：今天的 `scripts/x8-production-like.sh`
  / `scripts/lib/x8-production-like-env.sh` / `scripts/acceptance/x8-validate-compose.mjs`
  无法把六服务拓扑真正抬到 Level UAT（claim 双闸 true + 五项 allowlist）——
  只能抬到 Level 0。在那三处的小改动（新增 claim gate 维度、把allowlist 断言
  参数化）落地前，第 2.1-2.4 节描述的是**目标操作序列**，不是"本轮已验证可
  执行"的序列；哪怕环境包（`infra/production-like/.env.uat.example`）里的值
  是对的，脚本今天也会在 `validate_rendered_topology()`/
  `x8-validate-compose.mjs` 那一步拒绝启动。
- **步骤 15 的 CTA 302 说明**：见第 3 节步骤 15 的脚注，基于代码核实，
  `/go/{code}` 在 PostgreSQL 停止时预期不会返回 302；本项以真实观测结果为准。
