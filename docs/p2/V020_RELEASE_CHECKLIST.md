# v0.2.0 发布检查单

> 本文只准备发布线。生产变更由 Owner 按 SOP 执行；feature PR 必须先经 Claude 复核并合入 `main`，才能创建 `v0.2.0` tag。

## 1. 合并、migration 与 tag 门禁

- [ ] PR 的 base 是 `main`，head 是 `feature/v0.2.0-acceptance`，且清楚标注“待 Claude 复核”。
- [ ] 本轮 migration 数量零增量；发布的唯一 v0.2.0 migration 仍是 `20260818120000_v020_foundation_shared`。
- [ ] 数据库 schema dictionary / 台账已同步：

  ```bash
  node scripts/check-database-dictionary-drift.mjs
  ```

- [ ] 先在目标环境核对 migration 状态，再执行 deploy：

  ```bash
  npx prisma migrate status
  npx prisma migrate deploy
  npx prisma migrate status
  ```

- [ ] migration deploy 后所有 feature/write flag 仍保持 off，先跑正式 locale dry-run，不允许边 migrate 边开写。
- [ ] Claude 复核 PASS、PR 已合入 `main`、Owner 确认合并 commit 后，由 Owner 在该 `main` commit 上打 tag：

  ```bash
  git switch main
  git pull --ff-only origin main
  git tag -a v0.2.0 -m "v0.2.0"
  git push origin v0.2.0
  ```

- [ ] 已复核 `docs/governance/NPM_AUDIT_REGISTER_2026-08-26.md`；Next/eslint-config-next custodian 安全 PR 与其必过验收已有结论，Prisma/nanoid 限期延期未过期。

## 2. 部署必需环境变量

- [ ] **生产域名 = `https://pulsenovels.com`（冻结，2026-09-03 Owner）。** 唯一输入源是
      `SITE_URL`，唯一解析函数是 `getSiteUrl()`（`src/lib/seo/site-url.ts`），fail-fast、
      无默认值。详见 `docs/operations/PRODUCTION_DOMAIN_2026-09-03.md`。X8 本地
      production-like UAT 不受影响，其域名固定 `https://novel.test`，与本条无关。
- [ ] Web 与 Sitemap refresh Worker 都显式设置真实 `SITE_URL`（生产值即
      `https://pulsenovels.com`）。
- [ ] `SITE_URL` 是无凭证、无 path/query/fragment 的绝对 HTTP(S) origin；不得使用 CPS 域名、localhost 或 fixture 域名。
- [ ] `SITE_URL` 是运行期 fail-closed 契约：缺失或非法时 robots/Sitemap/IndexNow URL 生成必须报错，不得回退到默认域名。
- [ ] Worker 显式设置 CPS v8.3.6 parity 的发布默认：
  `PROMO_LINK_CLAIM_READBACK_ATTEMPTS=3`、
  `PROMO_LINK_CLAIM_READBACK_INTERVAL_MS=2000`，并以 `docker compose config`
  核对生效值；attempts 运行时仍只允许 1–5。
- [ ] 上述三次只覆盖同一账号内 `getlistpc` 的只读 readback；Worker task
  `maxAttempts=1`，`getcode` 仍严格零 retry。不同账号领取到不同 code 是账号隔离事实，
  不得当作 post-claim 可见性延迟处理。

  ```bash
  SITE_URL= npm test -- --project node tests/backend/seo/static-sitemap.test.ts tests/backend/indexnow/eligibility.test.ts
  ```

## 3. Flag 分级开放

**任务消费原子规则：**任务类 flag 与 `WORKER_TASK_ALLOWLIST` 必须在同一次发布变更中一起修改、
一起回滚，禁止分两次部署。该规则至少覆盖 `promo_link.claim.v1` + claim 双闸、
`sitemap_refresh` + Sitemap 写闸、`indexnow_delivery` + delivery 双闸。

### Level 0：部署时全 off

- [ ] `FEATURE_INDEXNOW_OUTBOX=false`
- [ ] `INDEXNOW_OUTBOX_ALLOW_WRITE=false`
- [ ] `FEATURE_INDEXNOW_DELIVERY=false`
- [ ] `INDEXNOW_DELIVERY_ALLOW_WRITE=false`
- [ ] `FEATURE_SITEMAP_AUTO_REFRESH=false`
- [ ] `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=false`
- [ ] `FEATURE_PROMO_LINK_CLAIM=false`
- [ ] `PROMO_LINK_CLAIM_ALLOW_WRITE=false`
- [ ] Worker Level 0 allowlist 精确为 `credential.validate.v1,credential.supersede.v1,catalog_scan`。
- [x] C2b parser 修复验收前不消费 `moboreader.preview_refresh.v1`；让 preview item 留在 pending，不把可恢复工作消费成 failed。
  - **验收证据**：commit `5a6addf`（`fix(adapter): normalize numeric preview bookId`，
    诊断见 `docs/governance/C2B_GETCHAPTERINFO_SHAPE_DIAGNOSTIC_2026-08-27.md`）；
    修复点 `src/lib/adapters/moboreader.ts:169-173,408`（诊断报告建议时的行号；随本仓库
    后续提交自然漂移，RC-2 复核时 `requiredIdentifier()` 定义位于 184-195 行，调用处
    `bookId: requiredIdentifier("bookId", data.bookId)` 仍在 408 行，逻辑与提交内容一致，
    未发现回退或再放宽）；回归覆盖 `tests/backend/adapters/moboreader.test.ts`
    190-204 行（`it.each` 用例 `"normalizes getchapterinfo bookId %s without changing
    its string contract"`：数字 `998877` 被接受并归一为字符串 `"998877"`，与既有字符串
    bookId 形式结果一致）与 206-230 行（`"rejects invalid bookId %s with field and shape
    diagnostics only"`：`null`/空字符串被拒，抛出
    `MoboreaderAdapterError{code:"malformed_payload",retryable:false}`，错误信息不泄漏
    原值）。RC-2 复核在 HEAD `1b9f82c` 重跑
    `npx vitest run --project node tests/backend/adapters/moboreader.test.ts`，
    30/30 通过（未新增测试文件，既有用例已覆盖）。验收日期：2026-09-03。验收人：
    Fable5（Owner 授权夜间自主推进）。
- [ ] Worker allowlist 不含 `promo_link.claim.v1` / `indexnow_delivery` / `sitemap_refresh`。

### Level UAT：Owner 本地真实验收（不对外）

> Level 0 全部保持已核对，在此基础上仅为 Owner 本地 UAT 打开 catalog 写闸与 claim 双闸；
> IndexNow / Sitemap 仍保持关闭。适用范围仅 `https://novel.test` 本地 production-like
> 环境（见 `docs/operations/X8_LOCAL_PRODUCTION_LIKE_ACCEPTANCE_2026-08-26.md`），
> **不得**用于生产部署。完整操作步骤见
> `docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md`。

- [ ] Level 0 全部已核对（见上）。
- [ ] `FEATURE_NOVEL_CATALOG_SYNC=true` / `NOVEL_CATALOG_SYNC_ALLOW_WRITE=true`（同一次变更
      内一起改，任务消费原子规则见本节开头）。
- [ ] `FEATURE_PROMO_LINK_CLAIM=true` / `PROMO_LINK_CLAIM_ALLOW_WRITE=true`（同一次变更内
      一起改）。
- [ ] `WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan,moboreader.preview_refresh.v1,promo_link.claim.v1`
      与上面两对双闸在**同一次变更**中一起生效；C2b 已验收（见上），
      `moboreader.preview_refresh.v1` 不再需要保持 pending-only。
- [ ] IndexNow / Sitemap 双闸维持 Level 0 原值：`FEATURE_INDEXNOW_OUTBOX=false`、
      `INDEXNOW_OUTBOX_ALLOW_WRITE=false`、`FEATURE_INDEXNOW_DELIVERY=false`、
      `INDEXNOW_DELIVERY_ALLOW_WRITE=false`、`FEATURE_SITEMAP_AUTO_REFRESH=false`、
      `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=false`。
- [ ] `PROMO_CLAIM_ROLES=super_admin`（`PROMO_CLAIM_USER_IDS` 留空）。这是 admin 能力位
      `promo:claim`（`src/lib/auth/capabilities.ts`），**不是**上面的双闸，两者缺一都
      无法真正领取：双闸开着但能力位为空时，`/catalog-sync` 的领取弹窗只能选 `dry_run`，
      `apply` 会被"请切换回 dry_run，或联系管理员授予该能力位"挡下。该能力位
      `defaultRoles: []`（默认谁都没有）且 `requiresTwoFactor: true`，因此 Level 0 与生产
      必须保持为空；X8 本地拓扑由 `X8_LEVEL=uat` 自动置为 `super_admin`
      （`scripts/lib/x8-levels.json` 的 `promoClaimRoles`）。
- [ ] claim 相关 `ChannelCapability`（`getbydataid`、`getchapterinfo`、`claimPromo`，
      `projectType=1` 小说 scope）由受审计脚本 `scripts/set-channel-capability-status.ts`
      置为 `enabled`（先 dry-run 无 `--apply` 预览，再 `--apply` 写入，`--evidence` 必填）；
      Owner 决策 4：脚本先行，管理界面后补，本轮不新建 admin UI 开关
      （`src/server/channel-capability/service.ts` 顶部注释同一决策）。
- [ ] 凭证只经 `/channel-accounts` UI 的 `addOrReplaceCredential` 正式入口录入；**禁用**
      `scripts/x8-import-moboreader-canary-credential.mjs`（或任何绕过 UI 的凭证导入脚本）。
- [ ] `/catalog-sync` 目录同步页区间限制：每次 dry-run/apply 限定 **≤ 3 页、`pageSize=20`**。
      RC-3 合入后 `pageSize` 已是机器强制上限（`MOBOREADER_CATALOG_LIMITS.maxPageSize=20`，
      超限直接以 `page_size_exceeded` 拒绝），页数上限仍无 env 变量承载，由操作人在 UI
      表单中遵守。

### Level R：收益上线（生产）

> Level UAT 全部已核对，在此基础上加开 Sitemap 写闸。IndexNow 双闸仍保持关闭——
> X11（scheduler 每分钟 sweep-control schedule/去重/misfire=`skip`/worker due-sweep）
> 硬前置未满足前不得触碰，与 §3 步骤 7–9 的既有裁决一致。
>
> 生产域名 = `https://pulsenovels.com`（冻结，2026-09-03 Owner）；这是本节起唯一合法的
> `SITE_URL` 值，与本节以上 Level 0 / Level UAT 使用的 `https://novel.test`（X8 本地）
> 无关、互不覆盖。

- [ ] Level UAT 全部已核对（见上）。
- [ ] `SITE_URL=https://pulsenovels.com`（生产域名，见上）。
- [ ] `FEATURE_SITEMAP_AUTO_REFRESH=true` / `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=true`（同一次
      变更内一起改）。
- [ ] `WORKER_TASK_ALLOWLIST` 在 Level UAT 五项基础上追加 `sitemap_refresh`，与上一条
      **同一次发布变更**中一起生效，对应 §3.1 表步骤 6。
- [ ] IndexNow 双闸维持 `false`：`FEATURE_INDEXNOW_OUTBOX`、`INDEXNOW_OUTBOX_ALLOW_WRITE`、
      `FEATURE_INDEXNOW_DELIVERY`、`INDEXNOW_DELIVERY_ALLOW_WRITE`（X11 硬前置未满足）。
- [ ] 上线日验证 sitemap 首刷成功，并对 `${SITE_URL}/sitemap.xml` 执行 §4 的 HTTP route
      验收命令，确认 200。
- [ ] 结算账号口径 = **admin1**（Owner 2026-09-03 决定）。
- [ ] 告警三条复用短剧通道：`/api/health` 503、worker 过期锁（见
      `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2）、备份 last-success > 26h。

### Level 1：只开 IndexNow enqueue 双闸观察

- [ ] 开 `FEATURE_INDEXNOW_OUTBOX=true` + `INDEXNOW_OUTBOX_ALLOW_WRITE=true`。
- [ ] delivery 双闸仍 off，Worker allowlist 仍不消费 `indexnow_delivery`。
- [ ] 抽查 outbox URL/locale/revision/去重和任务量，确认无跨域、无空白 promo、无异常堆积后再进 Level 2。

### Level 2：最后开 IndexNow worker 双闸

- [ ] **X11 硬前置已验收；未满足时本 Level 不得开始。**
- [ ] 单独审批 `FEATURE_INDEXNOW_DELIVERY=true` + `INDEXNOW_DELIVERY_ALLOW_WRITE=true`。
- [ ] 与上述双闸在**同一次发布变更**中将 `indexnow_delivery` 纳入 Worker allowlist，避免 write gate 关闭时把 pending 任务消费成 failed。
- [ ] 观察 HTTP 403/422、终态失败率和 retry/dead-letter；命中 stop condition 立即回关 worker 双闸并人工复核。

### 3.1 开闸顺序表（步骤 8–9 受 X11 硬门禁）

| 步骤 | 操作 | 必过证据 / 失败处置 |
| ---: | --- | --- |
| 0 | **Level UAT**（本地 `https://novel.test`，不对外）：Owner 16 步验收全过，claim 双闸 + 五项 allowlist 在同一次本地变更中一起开、一起关 | `docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md` 16 步全过且 Owner 未改 env / 未跑脚本 / 未改库；未过之前不得进入步骤 1 的生产部署 |
| 1 | 以全 flag off + Level 0 allowlist 部署 | compose config 确认 allowlist 非空、无未注册 taskType；worker 启动日志已打印 requested/effective/invalid |
| 2 | 验证 `SiteSetting` 与 `/indexnow-key.txt` | host 与 `SITE_URL` 一致，key 不进日志/证据 |
| 3 | 打开 IndexNow outbox enqueue 双闸 | delivery 双闸仍 off，allowlist 仍不含 `indexnow_delivery` |
| 4 | 观察 outbox URL/locale/revision/去重/任务量 | 异常即回关 outbox 双闸，不进后续步骤 |
| 5 | 完成 Sitemap fixture、正式 locale dry-run 与 HTTP route 验收 | D-7 / 目录权限 / 分片 / `lastmod` 全部 PASS |
| 6 | 同次变更开 Sitemap 写闸并加 `sitemap_refresh` allowlist——即 **Level R**（收益上线）的开闸动作：`FEATURE_SITEMAP_AUTO_REFRESH` + `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` + allowlist 三者同一次变更 | 任一侧不能同时生效即整体回滚 |
| 7 | 验收 X11 首个生产 schedule | scheduler 每分钟只入队 sweep-control generic task；去重有效；misfire=`skip`；scheduler 无凭证/无外部调用；worker 能执行现有 due sweep |
| 8 | 在 X11 PASS 后，于一次发布变更中打开 delivery 双闸 | **X11 未 PASS 时严禁改为 true**；步骤 8 不得单独部署；Level R 明确 IndexNow 仍 `false`，此步骤晚于 Level R 独立审批 |
| 9 | 在与步骤 8 同一次变更中加入 `indexnow_delivery` allowlist 并验证 sweep/delivery | 步骤 8–9 必须原子同发/同回滚；403/422/终态失败率越线即同时回关双闸并移除 allowlist |

Level UAT（步骤 0）与 Level R（步骤 6 的收益上线开闸）分别在“## 3. Flag 分级开放”中有完整字段清单，
本表只标注它们在整体开闸顺序里的位置，不重复列出每个字段。

**X11 misfire 裁决：**显式采用 `skip`，只生成当前时间桶。sweep 本身扫描数据库中全部当前到期行，
历史桶 `bounded_catch_up` 只会重复扫描并增加开闸压力。X11 未落地前，
`FEATURE_INDEXNOW_DELIVERY` / `INDEXNOW_DELIVERY_ALLOW_WRITE` 必须保持 `false`，且 allowlist 必须排除 `indexnow_delivery`。

## 4. D-7 与 Sitemap 开放时序

- [ ] fixture 验收已 PASS：

  ```bash
  npm test -- --project node tests/backend/seo/static-sitemap-acceptance.test.ts tests/integration/p2-12-vertical-acceptance.test.ts
  ```

- [ ] 仅在 fixture PASS 后，由 Owner 正式关闭 D-7，将首发 locale 写入唯一白名单真源。
- [ ] D-7 关闭后，在 Sitemap flags 仍全 off 时跑正式 locale dry-run，核对分片、`lastmod`、真实 `SITE_URL` 和目录权限。
- [ ] dry-run PASS 后做 HTTP route 验收：

  ```bash
  curl -fsS -D /tmp/v020-sitemap-index.headers "${SITE_URL}/sitemap.xml" -o /tmp/v020-sitemap-index.xml
  curl -fsS -D /tmp/v020-sitemap-family.headers "${SITE_URL}/sitemap/site_novelpage_en.xml" -o /tmp/v020-sitemap-family.xml
  ```

- [ ] 只有“fixture PASS → Owner 关 D-7 → 正式 locale dry-run PASS → HTTP route PASS”全部完成后，才允许开 `FEATURE_SITEMAP_AUTO_REFRESH`。
- [ ] 先只开 enqueue flag 观察 pending/coalesce；单独审批后才在**同一次发布变更**中开 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` 并将 `sitemap_refresh` 加入 Worker allowlist。

## 5. IndexNow SiteSetting 前置

- [ ] 开 IndexNow 任何写闸前，已在 `SiteSetting` 单例行写入并复核 `indexNowHost` / `indexNowKey` / `indexNowKeyLocation`。
- [ ] `indexNowHost` 与 `SITE_URL` host 一致，`indexNowKeyLocation` 指向本站 key route。
- [ ] 配置完成后 `key.txt` route 才能返 200；未配置时必须保持 404：

  ```bash
  curl -fsS -D /tmp/v020-indexnow-key.headers "${SITE_URL}/indexnow-key.txt" -o /tmp/v020-indexnow-key.txt
  ```

- [ ] 仅核对 key 文本与 `SiteSetting.indexNowKey` 一致；证据和日志不得打印其他凭证或完整 `DATABASE_URL`。

## 6. 已登记跟进（本轮不做）

- [ ] `OperationAudit.requestId` 唯一索引（解决真并发同 requestId 的审计/派发双写窗口）。
- [ ] 开缓存轮的有界 TTL 兜底。
- [ ] 章节物化写口接入失效矩阵。
- [ ] X11：落地 scheduler 每分钟 sweep-control schedule、去重、misfire=`skip` 与 worker due-sweep 验收；它是上表步骤 8–9 的硬前置。

## 7. 发布证据归档

- [ ] 保留 `npm test`、`npm run typecheck`、`npm run lint`、migration status/deploy、dry-run 和 HTTP route 验收的完整命令与原始输出。
- [ ] 证据仅写 `/tmp` 或 `/private/tmp`，过程输出使用脱敏工具，不得把 URL 签名、JWT、cookie、password 或 `DATABASE_URL` 写入 PR。
