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

## 2. 部署必需环境变量

- [ ] Web 与 Sitemap refresh Worker 都显式设置真实 `SITE_URL`。
- [ ] `SITE_URL` 是无凭证、无 path/query/fragment 的绝对 HTTP(S) origin；不得使用 CPS 域名、localhost 或 fixture 域名。
- [ ] `SITE_URL` 是运行期 fail-closed 契约：缺失或非法时 robots/Sitemap/IndexNow URL 生成必须报错，不得回退到默认域名。

  ```bash
  SITE_URL= npm test -- --project node tests/backend/seo/static-sitemap.test.ts tests/backend/indexnow/eligibility.test.ts
  ```

## 3. Flag 分级开放

### Level 0：部署时全 off

- [ ] `FEATURE_INDEXNOW_OUTBOX=false`
- [ ] `INDEXNOW_OUTBOX_ALLOW_WRITE=false`
- [ ] `FEATURE_INDEXNOW_DELIVERY=false`
- [ ] `INDEXNOW_DELIVERY_ALLOW_WRITE=false`
- [ ] `FEATURE_SITEMAP_AUTO_REFRESH=false`
- [ ] `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=false`
- [ ] Worker allowlist 不含 `indexnow_delivery` / `sitemap_refresh`。

### Level 1：只开 IndexNow enqueue 双闸观察

- [ ] 开 `FEATURE_INDEXNOW_OUTBOX=true` + `INDEXNOW_OUTBOX_ALLOW_WRITE=true`。
- [ ] delivery 双闸仍 off，Worker allowlist 仍不消费 `indexnow_delivery`。
- [ ] 抽查 outbox URL/locale/revision/去重和任务量，确认无跨域、无空白 promo、无异常堆积后再进 Level 2。

### Level 2：最后开 IndexNow worker 双闸

- [ ] 单独审批 `FEATURE_INDEXNOW_DELIVERY=true` + `INDEXNOW_DELIVERY_ALLOW_WRITE=true`。
- [ ] 同次变更才将 `indexnow_delivery` 纳入 Worker allowlist，避免 write gate 关闭时把 pending 任务消费成 failed。
- [ ] 观察 HTTP 403/422、终态失败率和 retry/dead-letter；命中 stop condition 立即回关 worker 双闸并人工复核。

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
- [ ] 先只开 enqueue flag 观察 pending/coalesce；单独审批后才同次开 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` 并将 `sitemap_refresh` 加入 Worker allowlist。

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

## 7. 发布证据归档

- [ ] 保留 `npm test`、`npm run typecheck`、`npm run lint`、migration status/deploy、dry-run 和 HTTP route 验收的完整命令与原始输出。
- [ ] 证据仅写 `/tmp` 或 `/private/tmp`，过程输出使用脱敏工具，不得把 URL 签名、JWT、cookie、password 或 `DATABASE_URL` 写入 PR。
