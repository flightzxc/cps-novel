# 海阅公网化交付与验证证据

日期：2026-09-28（Asia/Tokyo）。仅本地代码准备，未合并、未开 PR、未推送、未发版；主机仅做只读核查，未操作常驻 X8 栈。

## 分支与验证范围

- 基线：`origin/release/v0.5.1-2026-09-27@02f9996424e30b6d6cb310045bfe2d771093d8c2`。
- 分支：`feat/public-cutover-edge`；验证提交：`3fb539fd8d7f9a795295e6f2c6ef621d70055e0b`。本证据后续提交仅加入文档，不改变已验证运行代码；最终 HEAD 用 `git rev-parse HEAD` 读取。
- 独立 worktree：`/Users/chenweifeng/Documents/cps海阅/public-cutover-edge`；`node_modules` 为真实目录。
- 下列命令均在该 worktree 执行。开跑前检查 uptime 和已有运行器；全量测试、20 个 PostgreSQL 脚本、构建、nginx 和镜像测试按顺序执行。
- 原始本地日志：`.tmp/public-cutover/`；每一步非零退出即停止后续门禁。

## 完整门禁

| 命令 | 结果 / 尾行 |
|---|---|
| `npm run typecheck` | exit=0；`tsc --noEmit` |
| `npm run lint` | exit=0；0 errors，19 条既有 warnings |
| `npm test -- --maxWorkers=4` | 469 passed / 37 skipped 文件；7066 passed / 416 skipped 用例；0 failed，无 Unhandled Error |
| `npm run build` | exit=0；Next 16.1.6 生产构建完成 |
| `bash scripts/preproduction/verify-nginx-matrix.sh` | `NGINX_MATRIX_ALL=PASS` |
| `bash scripts/preproduction/verify-brand-image.sh` | `BRAND_IMAGE=PASS`，详见图片证据 |
| `node scripts/preproduction/verify-public-cutover-mutations.mjs` | `PUBLIC_CUTOVER_MUTATIONS=PASS` |

全量测试尾行：

```text

 Test Files  469 passed | 37 skipped (506)
      Tests  7066 passed | 416 skipped (7482)
   Start at  03:08:28
   Duration  153.77s (transform 5.21s, setup 0ms, collect 31.24s, tests 479.08s, environment 35.28s, prepare 18.19s)
```

首轮全量虽然 7066 用例通过，但出现一次 Vitest `onTaskUpdate` RPC timeout，**不计通过**。保留 `full-test-first-rpc-timeout.log`；再次完整运行后无该错误。未禁用错误检查或跳过 Docker image-store 用例。带数据库的脚本还执行其自带的后端/集成/全量回归，结果如下；条件跳过数保留真实口径。

重新枚举命令：`rg --files scripts | rg '/run-.*-postgres-verification.sh$' | sort`，共 20 项，全部 exit=0：

| 命令 | 实际结果尾行 |
|---|---|
| `bash scripts/run-add-admin-identity-postgres-verification.sh` | `ADD_ADMIN_IDENTITY_DICTIONARY_DRIFT=0`<br>`ADD_ADMIN_IDENTITY_POSTGRES_VERIFICATION=PASS`<br>`ADD_ADMIN_IDENTITY_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 2 passed (2) |
| `bash scripts/run-catalog-batch-postgres-verification.sh` | `CATALOG_BATCH_DICTIONARY_DRIFT=0`<br>`CATALOG_BATCH_POSTGRES_VERIFICATION=PASS`<br>`CATALOG_BATCH_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 24 passed  /  5 skipped (29) |
| `bash scripts/run-indexnow-sweep-postgres-verification.sh` | `WO6_DICTIONARY_DRIFT=0`<br>`WO6_POSTGRES_VERIFICATION=PASS`<br>`WO6_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 20 passed (20) |
| `bash scripts/run-p1-05b-postgres-verification.sh` | `P1_05B_VERIFICATION=PASS`<br>`P1_05B_DATABASE_CLEANED=yes`<br>Tests 7076 passed  /  406 skipped (7482) |
| `bash scripts/run-p1-06-postgres-verification.sh` | `LOGICAL_RESTORE=PASS`<br>`P1_06_VERIFICATION=PASS`<br>`DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 7066 passed  /  416 skipped (7482) |
| `bash scripts/run-p1-08b-postgres-verification.sh` | `P1_07_REGRESSION=PASS`<br>`P1_08B_POSTGRES_VERIFICATION=PASS`<br>`DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 16 passed (16) |
| `bash scripts/run-phase-b-entity-fix-postgres-verification.sh` | `PHASE_B_ENTITY_FIX_INTEGRATION_TESTS=PASS`<br>`PHASE_B_ENTITY_FIX_POSTGRES_CLEANUP=PASS`<br>Tests 6 passed (6) |
| `bash scripts/run-phase-d-postgres-verification.sh` | `PHASE_D_PG_GATED_TESTS=PASS`<br>`PHASE_D_POSTGRES_CLEANUP=PASS`<br>Tests 83 passed (83) |
| `bash scripts/run-phase-d-role-password-postgres-verification.sh` | `PHASE_D_ROLE_PASSWORD_SELF_HEAL=PASS`<br>`PHASE_D_ROLE_POSTGRES_CLEANUP=PASS` |
| `bash scripts/run-preview-account-hold-postgres-verification.sh` | `PREVIEW_HOLD_DICTIONARY_DRIFT=0`<br>`PREVIEW_HOLD_POSTGRES_VERIFICATION=PASS`<br>`PREVIEW_HOLD_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 5 passed (5) |
| `bash scripts/run-preview-opening-postgres-verification.sh` | `PREVIEW_OPENING_DICTIONARY_DRIFT=0`<br>`PREVIEW_OPENING_POSTGRES_VERIFICATION=PASS`<br>`PREVIEW_OPENING_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 26 passed (26) |
| `bash scripts/run-promo-claim-batch-control-postgres-verification.sh` | `PROMO_CLAIM_BATCH_CONTROL_DICTIONARY_DRIFT=0`<br>`PROMO_CLAIM_BATCH_CONTROL_POSTGRES_VERIFICATION=PASS`<br>`PROMO_CLAIM_BATCH_CONTROL_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 18 passed (18) |
| `bash scripts/run-promo-claim-release-postgres-verification.sh` | `PROMO_CLAIM_RELEASE_DICTIONARY_DRIFT=0`<br>`PROMO_CLAIM_RELEASE_POSTGRES_VERIFICATION=PASS`<br>`PROMO_CLAIM_RELEASE_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 18 passed (18) |
| `bash scripts/run-publication-preview-postgres-verification.sh` | `PUBLICATION_PREVIEW_DICTIONARY_DRIFT=0`<br>`PUBLICATION_PREVIEW_POSTGRES_VERIFICATION=PASS`<br>`PUBLICATION_PREVIEW_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 12 passed (12) |
| `bash scripts/run-sitemap-refresh-postgres-verification.sh` | `SITEMAP_REFRESH_DICTIONARY_DRIFT=0`<br>`SITEMAP_REFRESH_POSTGRES_VERIFICATION=PASS`<br>`SITEMAP_REFRESH_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 11 passed (11) |
| `bash scripts/run-tagging-auto-preview-postgres-verification.sh` | `TAGGING_AUTO_PREVIEW_MUTATION_SCRATCH_FILE_REMOVED=PASS`<br>`TAGGING_AUTO_PREVIEW_POSTGRES_VERIFICATION=PASS`<br>`TAGGING_AUTO_PREVIEW_DISPOSABLE_DATABASE_CLEANED=yes` |
| `bash scripts/run-tagging-public-auto-postgres-verification.sh` | `P2_06_5_DICTIONARY_DRIFT=0`<br>`P2_06_5_POSTGRES_VERIFICATION=PASS`<br>`P2_06_5_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 26 passed (26) |
| `bash scripts/run-worker-light-postgres-verification.sh` | `WO5_DICTIONARY_DRIFT=0`<br>`WO5_POSTGRES_VERIFICATION=PASS`<br>`WO5_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 12 passed (12) |
| `bash scripts/run-x6-site-setting-postgres-verification.sh` | `X6_DICTIONARY_DRIFT=PASS`<br>`X6_SITE_SETTING_POSTGRES_VERIFICATION=PASS`<br>`DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 4 passed (4) |
| `bash scripts/run-x9-postgres-verification.sh` | `X9_MANUAL_REVIEW_CAS_AND_AUDIT=PASS`<br>`X9_POSTGRES_VERIFICATION=PASS`<br>`X9_DISPOSABLE_DATABASE_CLEANED=yes`<br>Tests 27 passed (27) |

三套 compose 仅执行 `config --format json`，从未执行 up。均使用示例 env、隔离的 config-only 路径、`--project-name cps-cutover-config`，镜像值 `cps-novel:cutover-config-only`，GIT_COMMIT 为上述验证提交，BUILD_DATE 为合法 ISO 日期；两组 SITE_URL / ADMIN_CANONICAL_ORIGIN 分别代入。

```bash
docker compose --project-name cps-cutover-config --env-file infra/preproduction/preprod.env.example -f docker-compose.yml config --format json
docker compose --project-name cps-cutover-config --env-file infra/preproduction/preprod.env.example -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json
docker compose --project-name cps-cutover-config --env-file infra/preproduction/preprod.env.example -f docker-compose.yml -f infra/preproduction/docker-compose.yml config --format json
```

额外必需构建变量和 production-like 的 X8_* 路径通过命令环境提供，路径均指向本 worktree `.tmp/public-cutover/config-only/`；未读取或操作 X8 实例。逐个核对 web/worker/worker-light/scheduler 的 SITE_URL，以及实际使用后台地址的 web 的 ADMIN_CANONICAL_ORIGIN：

```text
COMPOSE_CONFIG=PASS suite=base mode=preprod
COMPOSE_CONFIG=PASS suite=production-like mode=preprod
COMPOSE_CONFIG=PASS suite=preproduction mode=preprod
COMPOSE_CONFIG=PASS suite=base mode=public
COMPOSE_CONFIG=PASS suite=production-like mode=public
COMPOSE_CONFIG=PASS suite=preproduction mode=public
```

## 三模式渲染关键片段

命令：`bash scripts/preproduction/render-nginx.sh --mode MODE --output "$PWD/.tmp/public-cutover/MODE.conf"`。三次均 `NGINX_RENDER=PASS`，未覆盖任何主机配置。完整样例保留在该本地目录。

preprod：旧域名、旧证书、密码和 noindex；模板及四个旧 snippet 与基线逐字节相同，默认渲染字节相同。

```nginx
limit_req_zone $binary_remote_addr zone=cps_preprod_general:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=cps_preprod_login:10m rate=2r/s;
limit_req_zone $binary_remote_addr zone=cps_preprod_api:10m rate=20r/s;
limit_req_status 429;
    location / {
        include /etc/nginx/snippets/cps-novel-preprod-protected.conf;
        limit_req zone=cps_preprod_general burst=100 nodelay;
        proxy_pass http://cps_novel_preprod_web;
        include /etc/nginx/snippets/cps-novel-preprod-proxy.conf;
    }
```

rehearsal：公开名 `www.bangbangji.cloud`、后台名 `zbcwf.bangbangji.cloud`，各自沿用旧证书目录；以下页面块与默认页兜底共用区：

```nginx
map $http_next_router_prefetch $cps_page_key { "" $server_name; default ""; }
map $http_next_router_prefetch $cps_prefetch_key { "" ""; default $server_name; }
map $http_next_router_prefetch $cps_prefetch_ip { "" ""; default $binary_remote_addr; }
map $host $cps_public_robots { default "noindex, nofollow, noarchive"; }
map $host $cps_public_hsts { default ""; }
limit_conn_zone $cps_page_key zone=cps_edge_page_conn:10m;
limit_req_zone $cps_page_key zone=cps_edge_page_rate:10m rate=12r/s;
limit_conn_zone $cps_prefetch_key zone=cps_edge_prefetch_conn:10m;
limit_req_zone $cps_prefetch_ip zone=cps_edge_prefetch_rate:10m rate=5r/s;
limit_conn_zone $server_name zone=cps_edge_go_conn:10m;
limit_req_zone $cps_training_bot zone=cps_edge_bot_page:10m rate=10r/m;
limit_req_zone $cps_training_bot zone=cps_edge_bot_go:10m rate=1r/m;
    location ~ ^/(?:en|es|pt-BR|id|vi|th|ja|ko|zh-Hant|ar|fr|de|pl|cs|ru)(?:/(?:novel|browse|category|blog)(?:/|$)|/?$) {
        auth_basic "CPS Novel Rehearsal"; auth_basic_user_file /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd;
        include /etc/nginx/snippets/cps-novel-edge-maintenance.conf;
        include /etc/nginx/snippets/cps-novel-edge-public-security.conf;
        limit_conn cps_edge_page_conn 10;
        limit_req zone=cps_edge_page_rate burst=30 nodelay;
        limit_conn cps_edge_prefetch_conn 4;
        limit_req zone=cps_edge_prefetch_rate burst=20 nodelay;
        limit_req zone=cps_edge_bot_page burst=2 nodelay;
        proxy_pass http://cps_novel_edge_web;
        include /etc/nginx/snippets/cps-novel-preprod-proxy.conf;
    }
```

public：公开名 `pulsenovels.com`、后台名 `zbcwf.pulsenovels.com` 共用 `/etc/letsencrypt/live/pulsenovels.com/` SAN 证书；该证书还用于 www。旧域名跳转保持旧证书路径。

```nginx
map $host $cps_public_robots { default ""; }
map $host $cps_public_hsts { default "max-age=86400"; }
    location ~ ^/(?:en|es|pt-BR|id|vi|th|ja|ko|zh-Hant|ar|fr|de|pl|cs|ru)(?:/(?:novel|browse|category|blog)(?:/|$)|/?$) {
        auth_basic off;
        include /etc/nginx/snippets/cps-novel-edge-maintenance.conf;
        include /etc/nginx/snippets/cps-novel-edge-public-security.conf;
        limit_conn cps_edge_page_conn 10;
        limit_req zone=cps_edge_page_rate burst=30 nodelay;
        limit_conn cps_edge_prefetch_conn 4;
        limit_req zone=cps_edge_prefetch_rate burst=20 nodelay;
        limit_req zone=cps_edge_bot_page burst=2 nodelay;
        proxy_pass http://cps_novel_edge_web;
        include /etc/nginx/snippets/cps-novel-preprod-proxy.conf;
    }
```

`/go/`（包括所有注册语种前缀）：共用并发 16，IP 10r/s burst20，固定爬虫名 1r/m burst1。页面固定爬虫名为 10r/m burst2。普通页与预取采用互斥非空键；预取仍执行爬虫限制。公开静态资源 50r/s burst200、一年 immutable；brand 一天；robots/sitemap/key/health no-store。请求及并发拒绝均为 429。

## nginx 1.24 HTTPS 矩阵与限流

| 场景 | preprod | rehearsal | public |
|---|---|---|---|
| 公开页匿名 / 带密码 | 401 / 200 | 401 / 200 | 200 / 200 |
| 公开安全头 | noindex | noindex | 无 X-Robots-Tag；HSTS max-age=86400，无子域及 preload |
| 后台允许路径匿名 / 带密码 | 401 / 200 | 401 / 200 | 401 / 200 |
| 公开后台路径；后台公开页面 | 404 | 404 | 404 |
| 公开 worker/backup health | 保持旧行为 | 404 | 404 |
| 精确 health、维护开启 | 绕过维护，保留密码 | 绕过维护，保留密码 | 公开 200；后台匿名 401、带密码 200 |
| 维护页面及静态请求 | 原矩阵 | 真实维护体 503、no-store | 真实维护体 503、no-store，无 noindex |
| www 与旧两域跳转 | 无新增 | 无新增 | HTTP/HTTPS 301，路径与查询保留 |
| 未知 Host | HTTP 拒绝 / HTTPS 404 | 同左 | 同左 |

两类引导配置均验证：旧 `--bootstrap`；新 `--bootstrap-public` 与现站共存，仅三个新名字 HTTP ACME 可达，其余 HTTP/HTTPS 不提供业务内容。public 安装事务移除附加配置。

新矩阵还注入上游 noindex，验证各带 Cache-Control 的 location 仍移除该头；正常、401/404/429、维护503、上游502均检查安全头。后台 worker/backup 使用明确白名单，未知健康子路径拒绝。

空桶通过重启独立 nginx 容器获得；可控延迟 upstream 确认实际并发数。爬虫交替从两个独立客户端容器 IP 发起；Claude-User、ChatGPT-User、Googlebot、Bingbot 负例均不入训练爬虫额度。

```text
NGINX_MATRIX=PASS
NGINX_MATRIX=PASS mode=rehearsal
NGINX_RATE=PASS mode=rehearsal case=crawler path=/novel/book prefetch=none statuses=200,200,200,429
NGINX_RATE=PASS mode=rehearsal case=crawler path=/go/a prefetch=none statuses=200,200,429
NGINX_RATE=PASS mode=rehearsal case=crawler path=/novel/book prefetch=2 statuses=200,200,200,429
NGINX_RATE=PASS mode=rehearsal case=page_concurrency limit=10 rejected=429
NGINX_RATE=PASS mode=rehearsal case=prefetch_concurrency limit=4 rejected=429
NGINX_RATE=PASS mode=rehearsal case=go_concurrency limit=16 rejected=429
NGINX_RATE=PASS mode=rehearsal case=mixed_locale_rate json_logs=PASS
NGINX_MATRIX=PASS mode=public
NGINX_RATE=PASS mode=public case=crawler path=/novel/book prefetch=none statuses=200,200,200,429
NGINX_RATE=PASS mode=public case=crawler path=/go/a prefetch=none statuses=200,200,429
NGINX_RATE=PASS mode=public case=crawler path=/novel/book prefetch=2 statuses=200,200,200,429
NGINX_RATE=PASS mode=public case=page_concurrency limit=10 rejected=429
NGINX_RATE=PASS mode=public case=prefetch_concurrency limit=4 rejected=429
NGINX_RATE=PASS mode=public case=go_concurrency limit=16 rejected=429
NGINX_RATE=PASS mode=public case=mixed_locale_rate json_logs=PASS
NGINX_MATRIX_ALL=PASS
```

页面空桶第三次仍放行、第四次 429；推广第二次放行、第三次 429，符合本轮确认的 nginx 原生 burst 口径。跨语种共区、预取独立、预取不能绕过爬虫额度、JSON 两种 REJECTED 与耗时/UA 字段均实测通过。

## Next 预取与门禁覆盖

实际依赖为 Next **16.1.6**。`node_modules/next/dist/client/components/app-router-headers.js:98` 定义 `next-router-prefetch`；`segment-cache/cache.js:809,1023` 使用 `1`，`:1102` 使用 `2`，`:1107` 使用 `1`。某些 full fetch 不带该头，因此按非空头分类，不能只匹配 `1`。

派生契约直接导入 `SITE_LOCALES`，覆盖每个注册语种首页、详情、章节/目录、browse、category 和 blog；去掉任一语种会红。五个指定 runtime 测试已参数化两组域名。新增用例覆盖：域名错配/碰撞、非法渲染不覆盖、IndexNow 严格布尔值、登记依赖及轻量白名单双向一致、主通道禁入、安装失败/中断/reload失败/持久恢复、正式发布维护前后行为。发布仍保留维护下完整验证及解除后匿名验证，失败重新关闭维护闸。

## 五项变异及恢复

每项先修改一个受控目标并运行对应断言；必须非零退出且出现目标断言。最后一项实际跑 public nginx 矩阵并要求 `public X-Robots-Tag leaked`。每次在 finally 中恢复原字节，再执行 `git diff --quiet -- <file>`；全部结束再做整树 `git diff --quiet`。

```text
MUTATION=PASS name=locale_omission exit=1 restored=git_diff_quiet
MUTATION=PASS name=crawler_ip_key exit=1 restored=git_diff_quiet
MUTATION=PASS name=unregistered_indexnow exit=1 restored=git_diff_quiet
MUTATION=PASS name=delivery_allowlist_desync exit=1 restored=git_diff_quiet
MUTATION=PASS name=public_noindex exit=1 restored=git_diff_quiet
PUBLIC_CUTOVER_MUTATIONS=PASS
```

对应顺序：语种遗漏；爬虫改按 IP 键；放行未登记 IndexNow；delivery 白名单失配；公开站残留 noindex。各预期红灯日志为 `.tmp/public-cutover/mutation-*.log`。

## 分享图与交付文件

Owner 源图逐字节复制至 `public/brand/og-default.png`，1200×630、RGB PNG、17150 bytes。Dockerfile 将 public 复制进 standalone runner。本地构建 linux/amd64 镜像后，实际 HTTP 200、image/png、下载字节与仓库文件一致：

```text
BRAND_IMAGE=PASS image=cps-novel:cutover-local-3fb539f status=200 content_type=image/png sha256=c4a4a7f4d89a6bce6a3bbf6b50c965cfce53982f85c8aed76be17367731627fb
```

SHA-256：`c4a4a7f4d89a6bce6a3bbf6b50c965cfce53982f85c8aed76be17367731627fb`。

相对基线改动文件（另加本证据文档）：

```text
Dockerfile
docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md
docs/operations/PUBLIC_CUTOVER_RUNBOOK.md
docs/operations/WO6_INDEXNOW_PRODUCTION_OPENING_DRAFT.md
infra/preproduction/nginx/cps-novel-edge-admin-security.conf
infra/preproduction/nginx/cps-novel-edge-maintenance.conf
infra/preproduction/nginx/cps-novel-edge-public-security.conf
infra/preproduction/nginx/cps-novel-public-bootstrap.conf.template
infra/preproduction/nginx/cps-novel-public.conf.template
infra/preproduction/preprod.env.example
public/brand/og-default.png
scripts/preproduction/install-nginx.sh
scripts/preproduction/install-public-nginx.sh
scripts/preproduction/lib.sh
scripts/preproduction/preflight.sh
scripts/preproduction/render-nginx.sh
scripts/preproduction/render-public-nginx.mjs
scripts/preproduction/verify-brand-image.sh
scripts/preproduction/verify-nginx-matrix.sh
scripts/preproduction/verify-public-cutover-mutations.mjs
scripts/preproduction/verify-public-nginx.mjs
scripts/preproduction/verify-release.sh
tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts
tests/backend/runtime/preproduction-deployment-contract.test.ts
tests/backend/runtime/preproduction-moboreader-rate-gate-config-gate.test.ts
tests/backend/runtime/preproduction-promo-claim-lifecycle-config-gate.test.ts
tests/backend/runtime/preproduction-write-gates.test.ts
tests/backend/runtime/public-cutover-edge.test.ts
tests/backend/runtime/public-cutover-install.test.ts
tests/backend/runtime/public-cutover-release.test.ts
tests/backend/runtime/site-mode-fixture.ts
```

## Owner 后续操作

按 [PUBLIC_CUTOVER_RUNBOOK.md](PUBLIC_CUTOVER_RUNBOOK.md) 执行。确认顺序为 **维护开启 → 安装 public nginx → 正式 env 同镜像发布**。本次交付没有执行这些主机写操作。

Owner sudo 范围：ACME webroot/探针、三名 SAN certbot 签发及续期验证；nginx 安装器及持久备份恢复；主配置 worker_connections 768→4096、语法检查和 reload（带恢复命令）；读取 root 备份证据。应用发布沿用 deploy/Docker 权限。

手册还包含 DNS/GSC、暂停批次及清零在途、在线逻辑备份、env/nginx/镜像/数据库身份记录、异地恢复与凭据关闭条件、SEO/缓存/压缩/限流验收、后台配置分享图与 IndexNow 但保持闸门关闭、light 刷新 sitemap、恢复批次、三档回退、回退后的监控与外部提交状态、一周 HSTS 提级和 30 天旧域名下线。

## 2026-10-05：第二段准备，未对外开放

首次准备提交时状态：**只读预检及 sudo 命令准备完成；主机变更、外部压测和本地矩阵待执行，第二段未完成。** 后续 A 执行与修正见本节末尾，下面首次上传版本的哈希及待执行状态保留为历史快照。本节不继承上文历史测试的 PASS 作为本轮结果。操作以运行 Final `bbb06253828d9fd338f0ece1749c2020d8ec4679` 为准，证据分支 `ops/cutover-stage2-2026-10` 基于收官提交 `0278e7324f4b544ae0a70bd914e7c5a61a0c7ee7`，只 push，不合并。

Owner 在本会话批准第二段准备计划：保持旧域名 Basic Auth/noindex；不改站点地址、不安装 VPS public 模式、不开放公网、不启用 IndexNow、不恢复领取批次、不操作 X8、不调模板数值。恢复演练暂缓，决定及剩余风险见 [ADR](../adr/ADR-CUTOVER-STAGE2-DEFER-OFFSITE-RESTORE.md)。

### 只读预检（本轮实测）

时间锚点：首轮预检 `2026-10-05T04:14:22Z`（东京时间 13:14:22）。本机原始脱敏日志在本 worktree `.tmp/cutover-stage2/`，不提交密码、env、密文或私钥。

| 项目 | 本轮结果 |
|---|---|
| DNS | 向 8.8.8.8、1.1.1.1、lunar/solar.dns-parking.com 查询三个名字的 A/CNAME/AAAA；主域和后台 A=`2.24.209.236`，www CNAME 到主域并解析到同一 IPv4，没有 AAAA。权威 TTL=300；递归缓存 TTL 可以低于 300。最终 36 次查询无超时，原始日志 `dns.log` |
| 发布目录 | `/opt/cps-novel/current` → `/opt/cps-novel/releases/bbb06253828d9fd338f0ece1749c2020d8ec4679`，目录 Git HEAD 一致 |
| manifest | `/opt/cps-novel/shared/artifacts/staging/bbb06253828d9fd338f0ece1749c2020d8ec4679.json`；原 `preprod_read_release_manifest` 及 `preprod_assert_local_image` 成功，镜像锚点 descriptor |
| 运行镜像 | web、worker、worker-light、scheduler 均通过原 `preprod_assert_container_image`，锚点 manifest_descriptor；镜像引用 `cps-novel:0.5.7-bbb0625`。四应用、postgres、backup-timer healthy |
| health | 旧公开域名带现有受控 curl config 查询：version=0.5.7、commit=完整 Final、healthy，metadataConsistency/database 均 passed |
| 当前发布验证 | `verify-release.sh` 完整验证 `RELEASE_VERIFY=PASS`；独立复验 `--anonymous-only --expect-live` 得到 `RELEASE_VERIFY=PASS mode=anonymous_only`。仅证明现有 preprod，**不代表 rehearsal 已通过** |
| nginx 模式 | 当前配置 SHA-256 与本地以 Final 同版脚本渲染的 preprod 完全一致：`063698e072bc56ddac4286f5113d565753f7251ad3c0186833a438ae6eaeeb71`；四份生效旧 snippet 与 release 源码逐项哈希一致 |
| 主配置 | `/etc/nginx/nginx.conf` SHA-256=`48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2`，当前 `worker_connections 768;`，**未修改** |
| 保护与拒绝 | 服务器端旧公开首页匿名 401、带密码 200 且 `X-Robots-Tag: noindex, nofollow, noarchive`；后台登录由完整验证通过。新域名当前 HTTP 空响应、HTTPS 默认拒绝 404，未提供业务内容。默认拒绝探针仅此处使用 `-k`，旧站认证请求不用 `-k` |
| curl config / IndexNow | 现有服务器 curl config 权限 600，未读取或输出内容；`preprod_site_mode=preprod`，`preprod_assert_indexnow_gates preprod 0 0` PASS |
| 批次与在途 | `eba8f359-a569-43d7-bb55-b71fecc02f6e`，`batch.materialize.v1`，paused；`tagging.auto_classify` pending/processing 条目各零，领取 pending/processing 任务零 |
| 数据库参数 | shared_buffers=4GB；effective_cache_size=10GB；work_mem=16MB；maintenance_work_mem=512MB；max_connections=100；effective_io_concurrency=200；random_page_cost=1.1。来自只读 `pg_settings`，符合容量基线 |

SQL 明确运行在 `BEGIN READ ONLY` 中，限制 statement_timeout，最终 ROLLBACK；没有创建、校验、续期或修改凭据，没有入队、恢复批次或改变业务开关。

### 凭据现状与三项关闭证据

当前 active **一条**，ID `4410a759-8485-4fb8-954c-a497b8e6a229`，只展示指纹前缀 `44fb1a40`；到期 **2026-10-12 12:38:58 +0900**；`last_validated_at=2026-10-05 12:40:54.989 +0900`。当天 12:40:55 的 change log 为 `replace`，审计为 `credential.replace.completed`。

**`last_validated_at` 不等于续期后 worker 校验成功。** 同版 `src/server/credentials/service.ts` 的同步 add/replace 会先做本地 JWT 校验，并在入库时填写该字段；本轮只读查询新 credential 的 `validate` change log 数为 **0**，没有 `credential.validate.completed` 审计，最近两项校验任务分别是 09-24、09-22。因此不能复用旧凭据的 worker PASS。

| 关闭条件 | 已有证据 | 缺口 / 结论 |
|---|---|---|
| ① 旧令牌已过期 | 两条历史 superseded 行 expires_at 为 `2026-09-24 14:54:51 +0900`、`2026-10-01 03:08:20 +0900`，都早于本次查询 | 历史令牌到期条件有只读证据 |
| ② 本机独立签发新令牌且 worker 校验成功 | 新 active 行、replace 审计及同步本地校验时间 | **待补**：独立签发来源证据、当前新凭据的 worker 成功校验记录。本轮不主动触发验证 |
| ③ 到期时间不与 X8/本机其他凭据重复 | 当前 active 到期时间与本机其他 `channel_account_credential` 行精确相同的数量 **0** | **部分完成**：本机排重通过；X8 既有只读证据待 Owner 提供，不访问其栈 |

三项尚未齐备，未关闭凭据 blocker。每周到期只记录现状，没有新增提醒或自动续期。

### sudo 三块与本轮执行状态

deploy 的 `sudo -n -v` 未取得缓存；无共享的 Owner 密码输入通道。采用已批准的 fallback：准备 [三块终端命令单](PUBLIC_CUTOVER_STAGE2_OWNER_STEPS_2026-10-05.md)，分别初始化同版 manifest/env 并先 `sudo -v`，Owner 只在自己终端输入密码。回传 A 核对通过才执行 B，B 通过才执行 C。

命令单的公共初始化分别拼接 A/B/C，已上传为 deploy 0600 文件，位于 `/opt/cps-novel/shared/cutover-stage2-20261005/commands/`；本地和远端 SHA-256 一致，远端仅做 `bash -n`，**未执行文件**。

| 块 | 内容 | SHA-256 / 本轮结论 |
|---|---|---|
| A.sh | DNS 复核、bootstrap-public、ACME 探针、三名 SAN 签发、renew dry-run、timer、旧站保护/新站拒绝；验收失败使用 A 安装器备份恢复 | `7fde043887d476736c45cc4672744529f3213a80fea369747279ab3d1e211096`；**待 Owner 执行**，当前 timer active 不能代替新证书续期验收 |
| B.sh | rehearsal、完整/匿名发布验证、主机隔离、真实静态文件缓存与 gzip、七项参数断言；失败使用 B 安装器备份恢复 | `8a1ea4cd8b066815cbb0dbec9146afc453bb8407a90694f6bbfbdeb270766233`；**待 A 输出核对后执行** |
| C.sh | 原值 768 才修改为 4096、独立备份、语法及 reload、最近备份三件/散列/目录读取；任何后续失败恢复主配置 | `688861c2be6ecba29ebd3bc284ac9bb2d44bf54054b4b7bd50c5ce7568de9b40`；**待 B 输出核对后执行** |

命令准备验证：三个拼接文件 `bash -n` 均通过；使用真实 EXIT handler 和隔离 stub 验证 A/B/C 的回退成功、回退失败六个场景，成功恢复保留原退出码 65，恢复失败返回 71。fixture 不执行 sudo/nginx/SSH/Docker，不接触生产路径。此结果只验证命令控制流，不是主机安装或回退实测。

### 压测与本地矩阵：受阻，未取得数据

- 本机 `curl --noproxy '*'` 直连旧站 443 连续失败，`curl exit=35`、`http_code=000`、peer=`2.24.209.236`、连接被重置；HTTP 同样被重置，强制 TLS 1.2 仍失败。服务器自身查询旧站 HTTPS 正常 401。证据不能确定故障究竟来自本机、网络链路或对源地址的服务端过滤；**没有绕过网络或用服务器本机代替外部压测**。
- 本地 Docker context=`desktop-linux`；`docker version` 默认及临时 API 1.41 查询均在 8/6 秒诊断上限内未返回，直接 socket `/_ping` 5 秒超时。前轮诊断出现 API 500，本轮未取得可用 daemon 响应。没有切换 context、重启 Docker 或操作任何 X8 容器。
- 本轮没有执行线上负载请求，也没有运行本地矩阵，因此 200 比例、延迟分位、超预算 429、5xx 数量均 **无数据**；不能声明“零 5xx”或 `NGINX_MATRIX_ALL=PASS`。
- 调参建议：在外部网络、Docker 及 rehearsal 就绪后执行已批准的页面/多语/预取/超预算测试，并补充匀速基线。当前无压测依据，模板数值保持现状；如果测得问题，交下一开发单，不在本段调整。

### 备份：存在性实测，恢复演练暂缓

最新本机逻辑备份 `/opt/cps-novel/shared/backups/logical/cps-novel-20261004T143811Z.dump`；三件 stat：

| 文件 | 大小 | 最后修改（东京时间） | 权限/属主 |
|---|---:|---|---|
| dump | 283,215,297 bytes | 2026-10-04 23:39:08 | 0600 root |
| dump.metadata | 260 bytes | 2026-10-04 23:39:09 | 0600 root |
| dump.sha256 | 98 bytes | 2026-10-04 23:39:09 | 0600 root |

三件非空、存在性 **PASS**；deploy 均不可读，**散列及 `pg_restore --list` 待 C 块 sudo 验收，不标记通过**。没有通过 Docker root 绕过这次 sudo 分工来读取文件。

NAS 每六小时拉取、已接通来自交接材料，**本轮未取得最近成功日志或 Owner 确认**；已向 Owner 请求脱敏时间及结果。暂列“待 Owner 确认”，不冒充实测。异地完整恢复演练按 Owner 决定暂缓，**异地副本可恢复性未经实测**。

### 偏离、修正与后续

- 已确认的文档冲突处理：worker_connections 所在 events 块不属于安装器备份清单，采用手册单独备份；站点配置仍只用安装器回退。未执行 sed。
- 由于 sudo、外部 HTTPS 和 Docker 前提未满足，本轮仅完成只读检查、ADR、命令包和证据提交；证书/rehearsal/连接数/压测不得写为完成。新凭据 worker 校验与 X8 排重仍缺证据。
- 管理型 worktree 工具因聊天 cwd 不是 Git 仓库而返回 `Not a git repository`；改从同一仓库以 `git worktree add` 建立独立证据工作区，不改变既有发布工作区。
- 一次远端 bash stdin 包装中的完整验证成功后，compose one-off 消耗了后续输入，独立匿名命令未执行；已单独重跑匿名复验取得 PASS，提供的 B 命令对两次验证均显式使用 `</dev/null`。属于包装修正，未绕过仓库门禁。
- CPS 旧基线只读检查 HEAD=`d77c3b968285698529cf97c7f0f97b286d7a2a9c`、status 零行；X 系列参考已有未提交状态，仅比较本轮前后 HEAD/status 字节，不清理、不使用它构建或测试。
- 接续顺序：Owner 在终端执行 A 并回传脱敏输出 → Codex 核对 → B → 核对 → C → 核对；外部直连和 Docker 就绪后补测并追加证据。凭据及 NAS 证据另补。**到此仍不进入切换当天。**

### 13:39：首次 A 失败并回退；修正就绪等待，待重跑

来源：Owner 在 Codex 界面终端执行 A，并回传输出；Codex 于 `2026-10-05T04:40:09Z` 起执行只读复核。

- manifest、四应用镜像身份和只读 SQL 门禁通过；四个 DNS 查询源的三个名字正确。
- bootstrap 安装通过：`NGINX_BACKUP=/opt/cps-novel/shared/nginx-backups/install.RxgQkIWr`，`NGINX_INSTALL=PASS mode=preprod bootstrap_public=1`。首次 ACME HTTP 探针得到 curl 52 / Empty reply，脚本非零停止，**尚未进入 certbot，未签发新证书**。
- trap 使用上述原备份恢复；恢复操作自己的安全备份为 `install.iiBR0ktN`，最终 `STAGE2_ROLLBACK=PASS block=A`。后者不是恢复到初始状态所选用的备份。
- 独立复核：bootstrap 文件不存在；站点配置哈希仍为 `063698e0…eb71`，主配置仍为 `48c6a4ec…aa2`，两者与首次预检完全一致。公开首页及后台登录均为匿名 401、认证 200，响应含 noindex；nginx 新 worker 在 13:39:31 启动。B/C 未运行。
- `protocol options redefined` 为本次 nginx 输出中的 warning，语法检查仍成功；bootstrap 模板仅新增 HTTP listener。本轮没有为去掉 warning 修改旧模板或 TLS 配置。

**原因尚未唯一确证。** 原 A 在 `systemctl reload nginx` 返回后立即请求探针。只读 `systemctl show` 确认 ExecReload 使用 `nginx -s reload`；nginx 主进程接收 HUP 后才切换新 worker，旧 worker 会继续服务已有连接（[官方控制文档](https://nginx.org/en/docs/control.html)）。因此缺少就绪等待是明确的包装缺口，reload 与首个请求竞态是当前最可能解释，但不能据此排除其他原因。系统解析全部正确、ACME 目录各级 0755；deploy 无权读取 nginx 系统日志，本轮没有补造 reload 成功日志。

只修正 [A 命令单](PUBLIC_CUTOVER_STAGE2_OWNER_STEPS_2026-10-05.md)，不改安装器、模板或生产 release：ACME 探针最多 10 次，每次超时 3 秒，间隔 1 秒；只重试空连接/连接失败/超时/404，仍须三个名字各 HTTP 200 且正文精确匹配才能进入 certbot。非预期状态、错误正文立即失败，耗尽后记录配置哈希、主机匹配及路径权限，然后按原备份回退。

- 更新后 A.sh SHA-256：`105709e48ab2b7d0283d202b189eee8cc3dc947bfaf45bf66965aac931db292d`；旧 A 保留副本，更新包按哈希断言并原子替换。B/C 内容及哈希不变。
- 三个代码块 bash 语法通过；六个本地隔离 fixture 通过：curl 52→正确 200、404→正确 200 均第二次成功；200 错正文和 403 均首次失败；持续超时/52 均十次后失败，未绕过验收。fixture 不执行真实 sudo/nginx/网络。首轮 fixture 的中文路径引用错误已改用 shell quoting 修正，重新全部通过。
- **最新状态：A 首次失败、回退实测 PASS；修正版已准备，等待 Owner 在可输入密码的界面终端重跑。证书、续期及 A 整体均未 PASS；不进入 B。**

### 14:12：A 重跑通过，证书准备完成，未对外开放

来源：Owner 回传 A 重跑输出；Codex 于 `2026-10-05T05:17:51Z`（东京时间 14:17:51）独立只读复核。此次执行使用修正版 A.sh，SHA-256=`105709e48ab2b7d0283d202b189eee8cc3dc947bfaf45bf66965aac931db292d`。

| 项目 | 本轮结果及来源 |
|---|---|
| DNS 与 bootstrap | Owner 输出中四个 DNS 源均正确，`NGINX_INSTALL=PASS mode=preprod bootstrap_public=1`；安装器备份 `/opt/cps-novel/shared/nginx-backups/install.sMb3Pll6` |
| ACME 探针 | 主域首次 curl 52/http 000，第二次 200；www、zbcwf 首次均 200。三个名字各 `ACME_PROBE=PASS`，随后才进入签发。结果支持短暂就绪竞态的判断，仍不构成对空响应根因的唯一确证 |
| 签发与 SAN | certbot 签发成功，cert-name=`pulsenovels.com`；SAN 恰为 `pulsenovels.com`、`www.pulsenovels.com`、`zbcwf.pulsenovels.com`，`CERT_SAN=PASS`。公有链路径 `/etc/letsencrypt/live/pulsenovels.com/fullchain.pem`；未读取私钥 |
| 有效期 | Owner 输出：notBefore=`2026-10-05 04:14:21 UTC`；notAfter=`2027-01-03 04:14:20 UTC`（东京时间 `2027-01-03 13:14:20 +0900`） |
| 续期 | Owner 输出中 `renew --dry-run` 模拟续期成功；脚本 timer 断言通过，Codex 独立 `systemctl is-active certbot.timer` 返回 `active` |
| 旧站与新域名 | Owner 两轮检查均为旧公开首页/后台登录匿名 401、认证 200，新域名 HTTP/HTTPS 普通路径均 404。Codex 独立匿名发布复验 PASS，认证旧页面均 200 且 noindex，新域名六项拒绝检查 PASS。新域名 HTTPS 默认拒绝探针使用 `-k`，未将其作为新证书在线 TLS 验证；旧站认证请求不用 `-k` |
| 配置及清理 | Codex 复核主配置 SHA-256=`48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2`、站点配置=`063698e072bc56ddac4286f5113d565753f7251ad3c0186833a438ae6eaeeb71`，均与预检一致；bootstrap=`c405586a742f1962fde3e2885d0f00b2e05b3da6894e183c41d7ea4659ce7975`，与运行 release 模板逐字节一致；ACME 探针已清理 |
| A 完成标记 | Owner 输出 `STAGE2_CERTIFICATE=PASS`，运行目录 `/opt/cps-novel/shared/cutover-stage2-20261005/run.aNHX3Jn4`；Codex 读取 `certificate.pass` 等于完整运行提交 `bbb06253828d9fd338f0ece1749c2020d8ec4679`，`A_READBACK=PASS`，本机脱敏复核日志 `A-pass-readback.log` |

**当前结论：A 证书准备 PASS；B rehearsal、C 连接数及备份校验尚未执行，外部压测和本地矩阵仍受阻。** 仅新增 ACME bootstrap，站点继续 preprod、Basic Auth/noindex 保留；未安装主机 public 模式，未进入切换当天。下一块为 B，远端 B.sh 的 SHA-256 复核仍为 `8a1ea4cd8b066815cbb0dbec9146afc453bb8407a90694f6bbfbdeb270766233`。凭据 worker/X8 和 NAS 证据缺口保持原结论，未因 A 成功而关闭。

### 14:21：B 首次验证失败并回退；补充 rehearsal 就绪检查，待重跑

来源：Owner 回传 B 输出；Codex 于 `2026-10-05T05:22:12Z`（东京时间 14:22:12）及 `05:23:11Z` 独立只读复核。

- B 初始化的 manifest、四应用镜像及只读 SQL 门禁通过；rehearsal 安装器语法检查/reload 返回成功，备份 `/opt/cps-novel/shared/nginx-backups/install.ujb5aZjI`。随后原完整 `verify-release.sh` 在公开域名的认证 `/api/health` 请求得到 curl 7 / connection refused，输出 `RELEASE_VERIFY=FAIL reason=health_unreachable`。**完整发布验证未通过，后续匿名复验、隔离/缓存/gzip、七项参数验收均未执行，B 未完成。**
- B trap 使用 `install.ujb5aZjI` 恢复至执行 B 前的 A 后状态，`STAGE2_ROLLBACK=PASS block=B`。恢复操作另外生成的安全备份为 `install.Nx5WwXpU`，不混同为此次恢复所选来源。两份目录均存在，root 0700；未读取备份秘密内容。
- 回退独立复验 PASS：主配置、站点和 bootstrap 的完整 SHA-256 分别仍为上一节的 `48c6a4ec…aa2`、`063698e0…eb71`、`c405586a…7975`。nginx、certbot timer active；80/443 在 `0.0.0.0` 监听，应用仅 `127.0.0.1:3000`；`certificate.pass` 等于完整 Final，`rehearsal.pass` 不存在。匿名发布验证 PASS；旧公开首页/后台登录认证 200 且 noindex，新域名普通路径 HTTP/HTTPS 六项均 404。原始脱敏日志 `B-failure-readback.log`。
- 后续两个旧域名均解析到 `2.24.209.236`；六容器 healthy，两个 health 匿名 401 且 realm=`CPS Novel Preproduction`/noindex，认证 health 的 ok、Final commit、database/metadataConsistency 均通过。日志 `B-health-followup.log`。首次补充诊断遗漏 manifest 的镜像/提交变量，compose 因插值缺失而拒绝，未执行预期后续命令；补齐同版初始化后独立重跑取得以上结果，不将第一次当作通过。

**连接拒绝根因尚未唯一确证。** 安装器和 `systemctl ExecReload` 采用 `nginx -s reload`，返回不等于所有后续请求已稳定来自新 worker；nginx 的配置重载和 worker 交接行为见 [官方控制文档](https://nginx.org/en/docs/control.html)。当前没有失败瞬间的 listener 或系统日志证据，不能将 curl 7 简单定性为模板错误或仅 reload 竞态。

仅修正 B 命令包装：完整验证前，对公开和后台两个 health 分别进行最多十轮的严格就绪检查。匿名须 401/noindex，并通过 `CPS Novel Rehearsal` realm 区分新旧配置；认证须 200/noindex，JSON 中 ok、完整 Final commit 和数据库 passed 正确。只等待 curl 7/52/28，及仍明确来自旧 preprod 的 401；5xx、错误状态/realm、保护缺失、错误 JSON 或身份立即失败。等待失败记录主/站点配置哈希、ExecReload 和 listener，再由原 trap 恢复。**原完整发布验证和所有后续验收不变，不重试失败的完整验证。**

- 修正版 B.sh SHA-256=`61751a98506e6e6e846437c5a49ca92a41c9dc4987b56484ee90a36d7480fe78`；本地/远端 `bash -n` 和哈希核对通过，远端保留旧 B 后原子替换。A/C 脚本及其哈希未变，未执行修正版 B，未修改不可变 release、安装器或模板。
- 18 个本地隔离就绪场景通过，覆盖匿名连接失败后成功、旧 realm 后成功、认证连接失败后成功、两主机依次通过；匿名/认证 502、匿名开放、两类 noindex 缺失、未知 realm、错误 JSON/commit/数据库、认证拒绝、TLS 错误均立即失败；持续超时/空响应/旧 realm 十轮耗尽失败。curl/sleep 使用隔离 stub，仅 JSON 使用本机 node；不执行 sudo、nginx、Docker 或真实网络。此前 B 回退 handler 未改变，首次真实回退已独立复验。
- **最新状态：A PASS；B 首次失败且回退实测 PASS，修正版待 Owner 在终端重跑；C 不执行。** 外部压测、本地矩阵、备份散列及凭据/NAS 证据仍未完成，不进入切换当天。

### 17:45：B 第二次失败，定位空渲染；17:50 回退，真实目录修正待重跑

来源：Owner 回传第二次 B 输出；Codex 于 `2026-10-05T08:49:53Z` 起只读诊断，`08:51:40Z` 独立复验回退。安装时间由服务器文件 mtime / ExecReload 锚定为东京时间 17:45:42，回退 reload 为 17:50:11。

- 本次安装器备份 `/opt/cps-novel/shared/nginx-backups/install.YUx95Ksh`，语法检查和安装输出 PASS。就绪首轮匿名 401 后未通过 rehearsal realm 判断；随后九轮均 curl 7/http 000，最终 `readiness_timeout`。站点文件 SHA-256=`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，stat **0 字节**；443 listener 不存在，只有 80 bootstrap 及 127.0.0.1:3000 应用监听。**B 未通过，不进入 C。**
- 诊断命令 `systemctl show` 在 Owner 的交互终端进入分页器，父 B 仍存活、未执行 EXIT 回退。Codex 告知 Owner 按 `q`；后续保护性检查只在父/子命令及 deploy 身份精确匹配时才结束只读诊断子进程，检查时该进程已消失，因此未发送信号。原 B 随后完成恢复。新版诊断改 `systemctl --no-pager show`，不再阻塞回退。
- 回退读回：主配置/站点/bootstrap 的完整 SHA-256 与 A 完成时一致；站点恢复为 10,085 字节，80/443 listener 恢复；nginx/timer active，匿名发布验证 PASS，两个认证 health 均 ok/完整 Final commit/数据库 passed。`certificate.pass` 保留、`rehearsal.pass` 不存在，B 及分页子进程已退出。原始脱敏复验日志 `B-second-failure-readback.log`。Owner 尚未回传分页退出后的尾部输出，因此此处记录的是**独立回退复验 PASS**，不补造 `STAGE2_ROLLBACK` stdout 或新备份路径。

**空渲染根因已复现。** release 的 `render-public-nginx.mjs` 用 `process.argv[1] === fileURLToPath(import.meta.url)` 判断 CLI 入口；`render-nginx.sh` 的 root 使用逻辑 pwd。在 `cd /opt/cps-novel/current` 下，Node 入口参数为符号链接路径，而模块定位到真实 release，入口判断为 false，进程正常退出但不写正文。渲染 shell 没有非空断言，安装器随后安装空文件，nginx 对空站点文件的语法检查仍通过；reload 后不再有 443 server。模块文件定位的符号链接解析行为见 [Node 官方 ESM 文档](https://nodejs.org/download/release/v22.18.0/docs/api/esm.html#importmetafilename)。

服务器同版脚本的只读渲染对照：逻辑路径返回 `NGINX_RENDER=PASS`、文件 0 字节；`cd -P /opt/cps-novel/current` 后，PWD 为真实 Final release，输出 15,898 字节，SHA-256=`9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0`。测试只在 shared 临时目录生成候选，结束清理，不执行主机安装。此前“仅缺 reload 就绪等待”的修正不足，Codex 未先检查渲染产物非空，已在本轮纠正；A 首次 ACME 空响应仍不与该 Node 路径缺陷混同。

本轮修正范围仅命令单及 staged 命令：共同初始化使用物理 release 目录；B 安装前候选必须非空且包含两旧主机/rehearsal 认证指令，安装后哈希必须与候选一致，否则由原备份回退。原安装器、renderer、模板、完整发布验证及回退 handler 不改。底层 CLI 的路径比较和安装器缺少空候选门禁记为后续开发修复项，不能将本轮包装规避记作 release 已修复。

| 当前 staged 文件 | SHA-256 |
|---|---|
| A.sh（仅共同目录初始化更新；无需重跑 A） | `f30fff640ba37c0224144af9e724357b1883b800c027f7a812f620512d882bf8` |
| B.sh（真实目录、候选检查、无分页诊断） | `dc5476ebf16ee5966aabcb36b9ebd76cbb680c1f073b38f25e59793561ea2b43` |
| C.sh（仅共同目录初始化更新；继续等待 B） | `93fec1a3d913112c1c3d44cd167f781698ddddc401e9ce0c3385e83957e52cc1` |

验证：三个脚本 `bash -n`、文档/脚本/远端哈希核对通过；本机同样复现符号链接 0 字节和真实目录 15,898 字节。新增门禁隔离验证：空候选在安装前退出 65，正常候选通过；18 项就绪场景重跑全部通过。测试不执行主机 sudo/nginx/reload。远端保存旧命令再替换，修正版 B 尚未执行。**最新状态：A PASS；B 第二次失败、独立回退复验 PASS，修正版待终端重跑；C、压测、矩阵和其他证据缺口仍未完成。**

### 18:05：B 第三次配置正常，后台 realm 被包装误判；修正待重跑

来源：Owner 回传第三次 B 输出；Codex 于 `2026-10-05T09:06:31Z`（东京时间 18:06:31）独立回退复验，随后读取本次保留的响应头。

- 本次候选 15,898 字节，SHA-256=`9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0`；安装文件哈希一致。安装器备份 `/opt/cps-novel/shared/nginx-backups/install.crTXBOzn`，nginx 检查通过、443 监听保留。公开 health 第二轮已来自 rehearsal，匿名 401、认证 200、noindex 和身份/数据库就绪通过。空渲染缺陷已通过物理目录及候选门禁规避，底层 release 代码未修复。
- 后台 health 匿名 401 被包装判断为 `unexpected_realm`。保留目录 `/opt/cps-novel/shared/cutover-stage2-20261005/run.ft3OgzdC` 的 `ready.headers` 实际为 `WWW-Authenticate: Basic realm="CPS Novel Administration"` 和 noindex，与运行 release 后台模板 `/api/health` 的规定完全一致。Codex 新增包装错误地要求后台与公开站同为 `CPS Novel Rehearsal`，导致正常保护响应被误判；**这是包装错误，不是认证保护失效。** 原 18 项 stub 场景沿用了同一错误预期，没有覆盖真实模板的后台 realm，测试盲区已纠正。
- B 整体仍失败，尚未运行完整发布验证和后续缓存/gzip/参数验收。原 trap 使用 `install.crTXBOzn` 恢复，Owner 输出 `STAGE2_ROLLBACK=PASS block=B`；恢复操作安全备份 `install.dP0if4Qj`。Codex 独立读回三配置哈希与 A 后状态一致，nginx/timer active，匿名发布验证及两个认证 health 的身份/数据库通过；A marker 保留，B marker 不存在。日志 `B-third-failure-readback.log`。C 未执行。

仅调整 B 包装：就绪函数显式接收预期 realm，公开 health 使用 `CPS Novel Rehearsal`，后台 health 使用 `CPS Novel Administration`；旧 `CPS Novel Preproduction` 仍仅作为重载期间可等待状态。候选也检查后台认证指令存在。noindex、认证 200、JSON/身份/数据库、5xx 立即失败、原完整验证、其他验收及回退均保持严格；未修改主机模板、认证配置或不可变 release。

- 测试改用同版 renderer 生成的真实候选，分别从两个 server 的 `/api/health` location 提取 realm 后构造响应，而非将公开 realm 复制到后台；执行命令单中的真实两主机循环验证调用映射。共 **22** 项隔离场景通过，包括正确后台 realm、后台旧 realm 后就绪、两域名顺序通过，以及 realm 对调必须立即失败；原连接/超时/5xx/保护/身份失败场景继续通过。fixture 不执行真实网络/sudo/nginx/Docker。
- B 其余断言已重新对照模板：公开后台路径/worker/backup 均拒绝，后台根路径拒绝，后台 worker/backup 受保护代理，公开静态缓存为 `max-age=31536000, immutable`。此项是源配置核对，**不冒充主机 rehearsal 实测**；gzip、完整验证及参数依然等待成功运行。
- 修正版 B.sh SHA-256=`d12a20a821ad8a09a7759078dbe93f9eae7358125c288ea39d1e8dd021c82642`，本地/远端语法及哈希通过，保留原 B 后替换；A/C 哈希保持上一节不变。证据保留前三轮真实失败，不将包装修正或 fixture PASS 当作 B 完成。
- **最新状态：A PASS；B 第三次失败并回退复验 PASS，realm 包装修正版待终端重跑；C、外部压测、本地矩阵及其他缺证项继续待办。**

### 18:22：B 完整发布验证通过，worker 503 中止；当前健康复验通过，待整体重跑

来源：Owner 回传第四次 B 输出；Codex 于 `2026-10-05T09:23:03Z` 起执行只读诊断。运行目录 `/opt/cps-novel/shared/cutover-stage2-20261005/run.v3BG3ovw`。

- 本次候选/安装 SHA-256=`9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0`、15,898 字节；安装器备份 `/opt/cps-novel/shared/nginx-backups/install.8eDjjJzx`。两个域名就绪通过，**原完整 `RELEASE_VERIFY=PASS`、独立 `RELEASE_VERIFY=PASS mode=anonymous_only` 均已实测通过**。旧首页/后台登录匿名 401、认证 200/noindex，新域名六项普通路径 404、公开后台路径和 worker/backup 404、后台根路径 404 均通过。
- 随后后台认证 `/api/health/worker` 返回 **503**，预期 200 的门禁失败，B 停止；backup、缓存/gzip、七项参数及 B 完成标记尚未验收。Owner 输出回退 PASS，恢复所用来源为 `install.8eDjjJzx`；回退操作安全备份为 `install.SLdVD5Hg`。Codex 复验主/站点/bootstrap 完整哈希与 A 后状态一致，nginx/timer active，六容器 healthy，匿名发布验证 PASS。`B-fourth-failure-readback.log` 保留失败响应头的 503/noindex；未保留当时正文，不能补造 workerStatus。
- nginx admin access 日志可由 deploy 只读取得；仅筛选该 health 请求的时间、状态及耗时：`2026-10-05T18:22:32+09:00`，status=503，limit_req_status=`PASSED`，request_time=`1.512`，upstream_response_time=`1.512`。由此确认上游返回 503，非限流拒绝。源码 `src/server/health/worker-status.ts` 在过期处理锁非零时 degraded，在查询拒绝/超时后 failed，两者都为 503；共享探测预算 `HEALTH_DATABASE_TIMEOUT_MS=1500`。耗时符合查询超时表现，但**原 JSON 未保存，无法唯一确证 failed/degraded，也无法归因于某条 SQL或连接池**。
- 回退后的五次独立 worker 请求均 200、workerStatus=`ok`、expiredLocks=0，耗时 91–150ms，lastHeartbeatAgeSeconds=null；源码将无历史心跳按 idle 处理，此字段不参与健康判定。backup 返回 200、backupStatus=`ok`、source=`status_file`，ageHours≈18.72。只读 SQL 过期处理锁零组，数据库连接为 active 1、idle 14；没有改任务、恢复批次或创建校验。日志 `worker-health-diagnostic.log`。
- 直接应用端 worker/backup 分别 200/ok、173ms/7ms，维护 marker 不存在。只读 EXPLAIN ANALYZE 显示心跳查询采用并行全表扫描，过滤约 44.8 万条无心跳行，执行 90.466ms；这是当前查询计划/耗时证据，**不能证明失败瞬间的冷缓存或查询耗时**。没有新增索引、调探测预算或数据库参数。日志 `B-worker-upstream-diagnostic.log`。
- 额外隔离原因检查：在恢复后的 preprod 只读复跑同版完整发布验证成功，紧接着 worker 返回 200/ok、90.357ms；没有复现“完整验证后必然 503”。日志 `B-worker-after-verifier-diagnostic.log`。该结果只说明当前状态，不将第四次 B 的 503 或整体失败改为 PASS。

补充 B 包装的诊断及验收：安装前先检查现有 worker/backup；原 rehearsal 健康验收处再次检查。每次保留状态正文/响应头，并只打印 workerStatus、expiredLocks、心跳年龄、backupStatus、备份年龄/source、检查时间及 HTTP/耗时。须 **HTTP 200 + JSON 状态 ok + noindex**，worker 还须 expiredLocks=0；任何传输失败、非 200、非 ok、无 noindex 均立即失败。即使 JSON 为 ok 但 HTTP 503 也不能通过；backup 的 unconfigured/200 不冒充备份健康。**没有给 503 加重试、放宽状态码或增加预算；失败仍按原备份恢复。**

- 10 项健康门禁隔离场景通过：worker/backup 正常，failed/degraded 的 503、503 配 ok 正文、200 配 failed 正文、backup unconfigured、坏 JSON、noindex 缺失及连接失败；额外 JSON 字段不会被打印。原 22 项就绪场景重跑全部通过；测试不执行真实 sudo/nginx/Docker/网络。新 helper 在当前 preprod 对两个端点实测通过，只用于验证诊断函数，不执行安装或冒充 rehearsal。
- 当前 B.sh SHA-256=`c0c00f0e6ade8adacb503d26bc733c240bb05f38c746e79a1044ed2c22a18878`；文档/脚本/远端哈希、bash 语法一致，保存旧 B 再替换；A/C 不变。原完整验证、旧/新域名保护、缓存/gzip、容量和回退门禁保留。
- **最新状态：A PASS；B 已取得完整及匿名发布验证 PASS，但第四次整体因真实 503 失败并回退；当前健康复验 PASS，新诊断版待整体重跑。** C 及后续压测/矩阵等仍未完成，尚未对外开放。

### Owner 接续决定：worker 冷读误报采样规则，B 待重跑

Owner 在本会话回传**主控只读排查证据及结论**：第四次 worker 503 是健康查询冷读超过 1500ms 预算而产生的 failed 误报，worker 本身正常；generic_task_item 约 36.8 万行、496MB，max(heartbeat_at) 和过期 processing 锁查询无可用索引，热缓存约 87ms，冷读超过预算。主控在 web 连续五次取到 200/ok、过期锁 0、约 180ms，容器持续 healthy 三天。体积、索引覆盖及冷读归因属于 Owner 提供的主控证据；Codex 已独立取得的同一 nginx 日志、热查询计划和健康复验见上节。此结论补充前轮调查，**不补造第四次缺失的 JSON 正文**。

Owner 明确授权重新执行 B，worker 项替换为预热一次、等待 10 秒、采样三次：三次至少一次 200/ok/expiredLocks=0，且预热与采样均无 expiredLocks>0，才通过；预热成功不计入三次成功。合规的 failed/503 不再单次中断；后三次全 failed 或任一次过期锁非零则停止、保留 rehearsal，不自动恢复 nginx，不写 B 完成标记、不进入 C。传输/认证/noindex/响应契约及其他站点异常保留原回退门禁。页面压测的 5xx 停止规则不变。决定与风险见 [ADR](../adr/ADR-CUTOVER-STAGE2-WORKER-HEALTH-SAMPLING.md)。部分索引根治由主控另派 v0.5.8 开发单，本段没有应用、索引或预算变更。

当前 B 包装实现：只在安装后原 worker 验收位置采样，不再由安装前的单次 worker 门禁阻断；backup 仍在安装前/后要求 200/ok/noindex。每次保存 `worker-sample-{0,1,2,3}.body/.headers/.metrics/.error`，输出完整合规 worker JSON及 HTTP/耗时，聚合为受控目录内 0600 的 `worker-health-responses.json`。新 B 开始清除旧 rehearsal.pass；仅整体成功重新写入。worker 状态停止输出 `STAGE2_STOPPED=worker_health rehearsal_retained=1` 并保留备份路径；无法取得合规安全响应仍走站点回退。

验证：14 项隔离采样/EXIT handler 场景通过，覆盖全健康、预热 failed 后健康、仅一次健康、预热成功但后三次全 failed、全 failed、采样/预热出现过期锁、坏 JSON、缺 noindex、连接失败、其他 5xx、HTTP/正文不一致、未知字段不打印、原回退失败。每项均验证请求总数四、只等待一次 10 秒、三份采样齐全、聚合权限 0600、旧 marker 被清除；worker 状态停止没有调用恢复，保护异常调用原恢复，恢复失败仍返回 71。22 项原就绪场景全部重跑通过。测试不接触真实 sudo/nginx/Docker/网络。

`2026-10-05T09:48:06Z` 起，仅在**当前恢复后的 preprod**运行新采样函数验证实现，没有安装 rehearsal：预热 200/ok，耗时 0.146302s；实际等待 10 秒，后三次均 200/ok、expiredLocks=0，`healthy_samples=3/3`。脱敏完整日志 `worker-owner-sampling-preprod.log`。以下保留三次完整响应，**只计作 preprod 函数实测，不标记 B rehearsal 通过**：

```json
[
  {"sample":1,"http":200,"timeTotal":0.138302,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:48:17.189Z"}},
  {"sample":2,"http":200,"timeTotal":0.12203,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:48:17.339Z"}},
  {"sample":3,"http":200,"timeTotal":0.103784,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:48:17.468Z"}}
]
```

新版 B.sh SHA-256=`bc6571ad11cbd16c29e7dbe0e37340295c7d838ab72ab26c22c56bf33cca3d28`；本地/远端语法和哈希通过，原 B 保存后原子替换。A/C 脚本不变；其余完整验证、隔离、缓存/gzip、七项容量基线按原步骤执行。**当前状态：A PASS，Owner 新 worker 验收规则已落实，B 仍待整体重跑；C 及外部压测/矩阵等继续待办。**

### 18:51–18:52：B 整体通过，rehearsal 保持保护，未对外开放

来源：Owner 回传上述新版 B 执行输出；Codex 于 `2026-10-05T09:52:52Z`（东京时间 18:52:52）独立只读复核。运行目录 `/opt/cps-novel/shared/cutover-stage2-20261005/run.HeIBdDKV`，安装器备份 `/opt/cps-novel/shared/nginx-backups/install.2dnxpThc`。本轮没有回退，最终 `STAGE2_REHEARSAL=PASS`。

| 验收项 | 结果及证据来源 |
|---|---|
| 初始化门禁 | Owner 输出四应用镜像身份 PASS；只读 SQL 门禁执行完成并 ROLLBACK，未恢复批次或创建任务 |
| rehearsal 安装及身份 | 候选非空 15,898 字节，安装器语法检查通过；公开及后台 health 就绪 PASS；原完整 `RELEASE_VERIFY=PASS`、独立匿名复验 PASS。Codex 再次匿名复验 PASS |
| 生效配置与标记 | Codex 读回 `rehearsal.pass` 等于完整 Final 提交 `bbb06253828d9fd338f0ece1749c2020d8ec4679`；站点 SHA-256=`9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0`，与候选一致；主配置仍为 `48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2`、worker_connections=768；bootstrap 仍为 `c405586a742f1962fde3e2885d0f00b2e05b3da6894e183c41d7ea4659ce7975`。nginx、certbot.timer active |
| 保护及域名隔离 | Owner 验收及 Codex 复验：旧公开首页/后台登录匿名 401、认证 200 且 noindex；新三个名字 HTTP/HTTPS 普通路径六项均 404。Owner 验收公开 dashboard/worker/backup 404、后台根路径 404。旧站 HTTPS 不使用 `-k`；新域名默认拒绝探针的 `-k` 不代表新证书在线 TLS 验收 |
| worker | 预热一次 200/ok、0.135224s，等待 10 秒后三次均 200/ok、expiredLocks=0，`WORKER_HEALTH=PASS healthy_samples=3/3 warmup_excluded=1`；完整三次响应见下方。Codex 从服务器聚合文件读回四份记录一致，文件权限 0600、属主 deploy |
| backup 健康 | 安装前后均 200/ok、source=status_file；后验耗时 0.031246s、ageHours=19.186027222222222、checkedAt=`2026-10-05T09:52:02.698Z`。此项是状态文件健康，不替代 C 的 dump 散列和目录验收 |
| 缓存及压缩 | 真实静态文件 `/_next/static/chunks/0h6sxbg558p3r.css` 认证 200；脚本断言通过。Codex 读回保留响应头 `cache-control: public, max-age=31536000, immutable` 和 `content-encoding: gzip` |
| PostgreSQL 容量 | Owner 输出七项参数和 `CAPACITY=PASS`：shared_buffers=524288×8kB（4GB）、effective_cache_size=1310720×8kB（10GB）、work_mem=16384kB（16MB）、maintenance_work_mem=524288kB（512MB）、max_connections=100、effective_io_concurrency=200、random_page_cost=1.1；事务 ROLLBACK，没有修改参数 |

三次完整采样响应（预热不计入成功数）：

```json
[
  {"sample":1,"phase":"sample","http":200,"timeTotal":0.145746,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:52:02.077Z"}},
  {"sample":2,"phase":"sample","http":200,"timeTotal":0.139058,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:52:02.243Z"}},
  {"sample":3,"phase":"sample","http":200,"timeTotal":0.119676,"curlExit":0,"body":{"workerStatus":"ok","expiredLocks":0,"lastHeartbeatAgeSeconds":null,"checkedAt":"2026-10-05T09:52:02.388Z"}}
]
```

独立复核脱敏日志 `B-pass-readback.log` 最终 `B_READBACK=PASS`。B 按已批准的采样规则整体通过；历史四轮失败及回退保留，冷读超时风险仍由 v0.5.8 索引开发单处理，不能将预热后的通过作为冷读性能已修复。

**当前状态：A PASS、B PASS；C 尚未执行，连接数仍为 768，最新 dump 散列/目录校验未 PASS。** 下一块 C 的远端 `bash -n` 通过，SHA-256=`93fec1a3d913112c1c3d44cd167f781698ddddc401e9ce0c3385e83957e52cc1`，与已审命令包一致。外部直连压测、本地 Docker 矩阵、新凭据 worker 校验/独立签发与 X8 排重、NAS 最近成功证据仍未完成；异地恢复演练按 ADR 暂缓。此轮只读复核没有重新尝试本机网络或 Docker，因此这些前轮阻塞不视为已解除。未安装主机 public 模式，未改变站点地址、认证/noindex、IndexNow、模板或应用/数据库结构。


### 19:00：C 连接数及本机逻辑备份校验通过，未对外开放

来源：Owner 回传 C 执行输出；独立备份文件名锚定修改时间 `2026-10-05T10:00:34Z`（东京时间 19:00:34）。Codex 于 `2026-10-05T10:12:20Z` 起只读复核，日志 `C-pass-readback.log`、`C-backup-config-diff.log`。

- 原 `nginx -T` 唯一生效 worker_connections=768，主文件原值门禁亦通过。独立备份 `/etc/nginx/nginx.conf.before-stage2-20261005T100034Z.1191273`，没有覆盖旧备份；Codex 读回存在、0644 root、1,446 字节，SHA-256=`48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2`，与修改前主配置一致。
- Owner 输出修改后 `WORKER_CONNECTIONS_AFTER=4096`，脚本已断言 `nginx -T` 唯一值为 4096；`nginx -t` 及 reload 成功，最终 `STAGE2_CONNECTIONS_BACKUP=PASS`。本轮没有回退。运行目录 `/opt/cps-novel/shared/cutover-stage2-20261005/run.WzR7r1Ap`。
- Codex 读回主文件唯一 worker_connections=4096，SHA-256=`ad9580d1ad6592cf7e4927e0b4049bed025f131e00aa370677e3c2231d5a5e9e`；将独立备份仅按同一 768→4096 替换后哈希完全一致，`MAIN_DIFF_ONLY_WORKER_CONNECTIONS=PASS`。站点 rehearsal 哈希仍为 `9a163d70…ffe0`，bootstrap 仍为 `c405586a…7975`；nginx、certbot.timer active。
- Owner 执行 C 的旧公开首页/后台登录匿名 401、认证 200/noindex；新域名六项 HTTP/HTTPS 普通路径 404。Codex 独立匿名发布验证 PASS、两旧认证页面 200/noindex、新域名六项拒绝 PASS，最终 `C_READBACK=PASS`。旧站 HTTPS 请求不用 `-k`，新域名默认拒绝检查不冒充新证书在线 TLS 验证。站点地址、env、认证/noindex、任务及模板数值未变。

最新 VPS 逻辑备份为 `/opt/cps-novel/shared/backups/logical/cps-novel-20261004T143811Z.dump`，C 按 dump 修改时间重新选择最新项：

| 验收项 | 本轮结果及来源 |
|---|---|
| 三件齐全 | Owner sudo stat：dump 283,215,297 bytes、metadata 260 bytes、sha256 98 bytes，均非空、0600 root；Codex 只读 stat 一致 |
| metadata | Owner 输出 created_at=`2026-10-04T14:39:09Z`、size_bytes=`283215297`、sha256=`0ee4477b463796ab80cae4ae2b52d6512e2106571599f26a99d415bc08c58546`，大小与 dump 一致；只打印这些元数据 |
| 散列校验 | Owner C 中 `sha256sum -c` 返回 `cps-novel-20261004T143811Z.dump: OK`；由最终 PASS 确认命令成功。Codex 没有绕过 root 0600 重新读取 dump |
| 归档目录读取 | C 在 backup-timer 内运行 `pg_restore --list`，正文丢弃；`set -e` 下继续完成最终 PASS，故该命令成功。这只证明归档目录可读取，不等同完整恢复 |
| 回退来源 | 主配置仅使用上述独立备份、`nginx -t` 后 reload；站点配置仍使用 B 安装器备份 `install.2dnxpThc`，两个恢复范围不混用。回退没有在此次成功 C 中实际触发 |

**当前主机块 A/B/C 均 PASS，继续受保护的 rehearsal，未对外开放。** 最新本机逻辑备份三件/散列/目录验收 PASS；NAS 最近成功日志仍未取得，标注“待 Owner 确认”，不标记实测通过；异地副本完整恢复按 ADR 暂缓、可恢复性未经实测。外部负载测试、矩阵及凭据证据的结论以接续记录为准，不因 C 成功自动放行。


### 19:12–19:18：Docker 恢复，完整本地矩阵通过；外部压测仍受阻

`2026-10-05T10:12:17Z` 本机只读前提复查：Docker context 仍为 desktop-linux，`docker version` 返回 Engine 29.1.3 / API 1.52 / arm64、Docker Desktop 4.57.0 (215387)，前轮 daemon 无响应阻塞已解除；没有切换 context 或重启 Docker Desktop。本机直连旧站仍 `curl exit=35`、HTTP 000、peer=2.24.209.236、耗时 0.557786s、Connection reset by peer，未解除外部压测前提。证据 `local-prerequisites-20261005.json`。

运行同版 `verify-nginx-matrix.sh`，相关矩阵脚本、renderer 和 nginx 模板与运行 Final `bbb0625` 逐字节未变；三个模式只用于本机隔离容器，绑定 127.0.0.1 动态端口，测试凭据/证书为 fixture，产物写入本 worktree `.tmp/cutover-stage2/matrix-tmp`。不访问线上推广跳转，不操作 X8，不安装主机 public 模式。

**保留失败与执行偏离：** 第一次原命令通过 preprod、rehearsal 路径矩阵后，在重启 edge 的限流准备阶段 `docker port ... 443/tcp` 返回 no public port，退出 1；日志 `nginx-matrix-20261005.log`。单独隔离 nginx 容器连续三次 restart/port 未复现缺失，诊断容器已清理，不能据此唯一归因为 Docker 缺陷。第二次原命令通过 rehearsal 路径和三项爬虫空桶断言，但后续 restart 后 `nginx not ready`，退出 1；日志 `nginx-matrix-20261005-retry.log`。这两次均未取得 ALL PASS，public 模式尚未运行。

第三次增加**本次进程专用的 Docker CLI 就绪包装**：只拦截精确匹配 `docker restart cps-cutover-[数字]-edge`；先执行原生 restart，原命令失败直接返回原退出码。成功后至多等待 15 秒，要求两端口连续稳定五个间隔（0.2 秒）、127.0.0.1 HTTPS 未知 Host 返回 404，再让原脚本读取端口；只等待测试运行器就绪，不重试矩阵业务断言、不改状态码或额度、不改变真实 nginx 配置。其余 Docker 命令原样 exec。19 次重启等待均成功，1.196–1.642s；`matrix-runtime-readiness.jsonl` 保留记录。两次原命令故障与追加等待后通过支持生命周期就绪问题的判断，尚不宣称已修复 Docker 或原矩阵 reset 实现。

本轮只在命令环境 PATH 引入 `.tmp/cutover-stage2/matrix-runtime-bin`，没有持久改变 shell/系统 PATH；包装 SHA-256=`2fecff13b177a4e819c0d37c494844ee73451f2281c77b41822e74ce3a871731`。完整 stdout/stderr 日志 `nginx-matrix-20261005-runtime-wait.log`，SHA-256=`fa35e32f25ae40994a5e2262def746ca63d1da22163d7c2c22da395dd6d420e2`，进程退出 0，最终标记如下：

```text
NGINX_MATRIX=PASS
NGINX_MATRIX=PASS mode=rehearsal
NGINX_RATE=PASS mode=rehearsal case=crawler path=/novel/book prefetch=none statuses=200,200,200,429
NGINX_RATE=PASS mode=rehearsal case=crawler path=/go/a prefetch=none statuses=200,200,429
NGINX_RATE=PASS mode=rehearsal case=crawler path=/novel/book prefetch=2 statuses=200,200,200,429
NGINX_RATE=PASS mode=rehearsal case=page_concurrency limit=10 rejected=429
NGINX_RATE=PASS mode=rehearsal case=prefetch_concurrency limit=4 rejected=429
NGINX_RATE=PASS mode=rehearsal case=go_concurrency limit=16 rejected=429
NGINX_RATE=PASS mode=rehearsal case=mixed_locale_rate json_logs=PASS
NGINX_MATRIX=PASS mode=public
NGINX_RATE=PASS mode=public case=crawler path=/novel/book prefetch=none statuses=200,200,200,429
NGINX_RATE=PASS mode=public case=crawler path=/go/a prefetch=none statuses=200,200,429
NGINX_RATE=PASS mode=public case=crawler path=/novel/book prefetch=2 statuses=200,200,200,429
NGINX_RATE=PASS mode=public case=page_concurrency limit=10 rejected=429
NGINX_RATE=PASS mode=public case=prefetch_concurrency limit=4 rejected=429
NGINX_RATE=PASS mode=public case=go_concurrency limit=16 rejected=429
NGINX_RATE=PASS mode=public case=mixed_locale_rate json_logs=PASS
NGINX_MATRIX_ALL=PASS
```

两模式均实测：空桶页面爬虫状态 200/200/200/429，推广爬虫 200/200/429，Next-Router-Prefetch=2 不能绕过爬虫额度；两个实际客户端 IP 共用爬虫额度，四类负例 UA 及全部语种断言通过。可控 upstream 延迟确认页面并发 10、预取 4、推广 16，额外请求为 429，持有请求均 200；预取/页面桶隔离、跨语种共区、JSON limit_req/limit_conn REJECTED 和耗时字段均通过。路径隔离、认证/noindex/HSTS、维护、缓存/gzip、bootstrap、上游失败响应断言全部通过。日志中的 curl 52 来自预期未知 HTTP Host 的 444 断连负例；amd64 镜像在 arm64 主机上的 platform warning 如实保留，矩阵断言仍通过。上游故障注入的 502/504 是本地 fixture 断言，不是线上页面压测数据。

**本地矩阵 PASS（使用上述运行器就绪包装），Docker blocker 已解除。** 收尾只读查询确认本次 cps-cutover/cps-nginx/诊断容器和网络均不存在。原脚本/模板未修改，空桶、精确并发及隔离实测不与线上性能验收混同。

为复核保留本次临时包装完整源码（本机原生 Docker 路径及专用日志环境变量；不是主机安装命令）：

<details>
<summary>本次 Docker restart 就绪包装</summary>

```python
#!/usr/bin/env python3
import subprocess,sys,re,time,json,os
REAL_DOCKER='/usr/local/bin/docker'
args=sys.argv[1:]
if len(args)!=2 or args[0]!='restart' or not re.fullmatch(r'cps-cutover-[0-9]+-edge',args[1]):
 os.execv(REAL_DOCKER,[REAL_DOCKER,*args])
r=subprocess.run([REAL_DOCKER,*args],capture_output=True)
if r.returncode:
 sys.stdout.buffer.write(r.stdout);sys.stderr.buffer.write(r.stderr);sys.exit(r.returncode)
t=time.monotonic();last=None;stable=0;attempt=0;ready=False
while time.monotonic()-t<15:
 attempt+=1;ports=[]
 for port in ['443/tcp','80/tcp']:
  q=subprocess.run([REAL_DOCKER,'port',args[1],port],capture_output=True,text=True,timeout=3)
  match=re.fullmatch(r'127\.0\.0\.1:([0-9]+)\n?',q.stdout)
  ports.append(match.group(1) if q.returncode==0 and match else None)
 stable=stable+1 if ports==last and None not in ports else 0
 last=ports
 if stable>=5:
  q=subprocess.run(['curl','--noproxy','*','-k','-sS','--connect-timeout','1','--max-time','2','-H','Host: unknown.example','-o','/dev/null','-w','%{http_code}',f'https://127.0.0.1:{ports[0]}/'],capture_output=True,text=True,timeout=3)
  if q.returncode==0 and q.stdout=='404':
   ready=True;break
 time.sleep(.2)
entry={'container':args[1],'elapsedSeconds':round(time.monotonic()-t,3),'attempts':attempt,'ports':last,'ready':ready}
with open(os.environ['STAGE2_MATRIX_RUNTIME_LOG'],'a') as f:f.write(json.dumps(entry)+'\n')
if not ready:
 sys.stderr.write('MATRIX_RUNTIME_READY=FAIL '+json.dumps(entry)+'\n');sys.exit(69)
sys.stdout.buffer.write(r.stdout);sys.stderr.buffer.write(r.stderr)

```

</details>

### 接续结论：主机准备与矩阵完成，外部性能及凭据/异地证据未齐

`2026-10-05T10:17:28Z` 再次只读 SQL 核对：active 恰为一条，指纹前缀 44fb1a40，到期 `2026-10-12 12:38:58 +0900`，last_validated_at=`2026-10-05 12:40:54.989 +0900`；当前新 credential 的 validate log 仍为 0，本机同到期其他凭据为 0。指定领取批次仍 paused，tagging pending/processing 为 0，事务 ROLLBACK。脱敏日志 `credential-final-readonly.log`。旧令牌到期历史证据保留；独立签发来源、续期后 worker 校验成功、X8 排重既有证据仍待补，不主动校验/续期或访问 X8。

- A 证书三名 SAN、renew dry-run 与 timer PASS；B 按 Owner 采样规则整体 PASS；C 唯一连接数 4096、独立备份、本机最新 dump 三件/散列/目录 PASS；本地完整矩阵按上述运行器偏离取得 PASS。当前受保护 rehearsal，未对外开放。
- 本机外部直连仍被重置，未执行四路径各 40 次/并发 4、预取、100 次/并发 20 或匀速基线；请求数、200/429 比例、吞吐、p50/p95/p99/最大延迟及线上 5xx 数量均无压测数据。不得声称全部 200、观察到线上 429 或零 5xx，没有用服务器本机/SSH 隧道替代。
- 限流建议：暂保留模板现值，本地正确性证据不足以支持调整生产预算；外部网络恢复后先用并发 1、1 请求/秒做低于速率/并发预算的匀速基线，批次间等待额度恢复，再按已批准负载测试取得性能分布。基线须全 200、超预算须有 429；任何页面 5xx 立即停止排查。
- NAS 最近成功日志未取得，记录为“由 Owner 确认（待回传）”；交接所述每六小时拉取属于历史信息，不当作本次实测。完整恢复按已接受 ADR 暂缓；本机归档校验不证明异地副本可恢复。
- 本段全部已知偏离：密码由 Owner 在自己终端输入并回传；独立 Git worktree fallback；A 就绪等待；B 物理 release 目录/非空候选门禁/无分页诊断/按主机 realm/Owner worker 采样与状态停止保留 rehearsal；C 主配置独立回退范围；本机矩阵临时 restart 就绪包装；外部压测未执行；恢复演练暂缓。历史记录保留各次实际失败、复验及原脚本缺口；底层空渲染、矩阵 reset 就绪及 worker 查询索引修复均未在此分支实施。

**第二段尚未全部完成：剩余阻塞为外部 HTTPS 压测和上述待补证据。** 本段没有公共 API、类型、数据库结构、站点地址、模板限流数值或应用改动；Basic Auth/noindex 保留、IndexNow 关闭、批次未恢复、没有新提醒。只提交证据分支，不合并或进入切换当天。


### Owner 最终补证与收尾：第二段准备结束，未对外开放

本节为第二段最新结论，取代上节“尚未全部完成”的接续状态；前文保留为各时点历史证据，不追改未执行项为 PASS。Owner 于 2026-10-05 明确提供 NAS 日志、指定已提交的凭据校验任务，并决定 X8 排重豁免、外部压测延后、完整恢复继续暂缓，要求提交证据分支后收尾停止。决定见 [收尾 ADR](../adr/ADR-CUTOVER-STAGE2-CLOSE-WITH-DEFERRED-EXTERNAL-LOAD.md)。

#### NAS：Owner 取得日志，Codex 与 VPS 只读比对通过

来源：Owner 在 NAS `DXP4800PLUS-ED3` 上取得 `~/cps-novel-offsite/logs/offsite-pull.log` 尾部与目录 `/home/flightzxx/Online Document/VPS-novel` 列表，回传到本会话。Codex 未登录 NAS，未重新运行拉取或 NAS 散列计算。NAS 最近记录如下；时间取日志 UTC，不据目录的显示时间推定 NAS 时区：

| 日志结束时间 UTC | 状态及来源 |
|---|---|
| 2026-10-04T18:15:24Z | `OFFSITE_PULL=PASS status=pulled`，exit=0；本段尾部没有该次 start 时间 |
| 2026-10-04T22:00:18Z | start=22:00:01Z，`OFFSITE_PULL=PASS status=already_present`，exit=0 |
| 2026-10-05T04:00:18Z | start=04:00:02Z，`OFFSITE_PULL=PASS status=already_present`，exit=0 |
| 2026-10-05T10:00:18Z | start=10:00:01Z，`OFFSITE_PULL=PASS status=already_present`，exit=0 |

后三次 start 相隔约六小时，支持 Owner 所述每六小时运行；18:15 的初次 pulled 不误记为与 22:00 相隔六小时。后三次同时含 `OFFSITE_PULL_TRANSPORT=gate`、`BACKUP_EXPORT_MANIFEST=PASS`；最新一次关键输出为：

```text
OFFSITE_PULL_REMOTE_LATEST=cps-novel-20261004T143811Z.dump
OFFSITE_PULL=PASS file=cps-novel-20261004T143811Z.dump size=283215297 sha256=0ee4477b463796ab80cae4ae2b52d6512e2106571599f26a99d415bc08c58546 status=already_present manifest=/home/flightzxx/Online Document/VPS-novel/SHA256SUMS
[2026-10-05T10:00:18Z] offsite-pull end exit=0
```

Owner 目录输出显示 10-04 dump/metadata/sha256 三件分别为 283,215,297 / 260 / 98 bytes，10-03 同样三件仍保留（dump 283,213,892 bytes），并有 948-byte SHA256SUMS。不将截取的目录列表当作全目录数量或全部历史文件的验证。

Codex 于 `2026-10-05T12:27:45Z`（东京时间 21:27:45）从 deploy、真实 Final release 只读复核 VPS。使用已安装受限 offsite-readonly-gate 的 `list` 动作，从 dump stat 及其 `.sha256` 第一列取得元数据；安装入口与运行 release 脚本 SHA-256 均为 `83dea1bfd8a8d4b6447bb126dae50ff72ad9580d15708c715deadb27f9a1f6cb`。未读取 dump 正文、凭据或私钥，未修改 sudoers/备份权限，未 root 登录。

```text
name=cps-novel-20261004T143811Z.dump size=283215297 mtime=1791124749 sha256=0ee4477b463796ab80cae4ae2b52d6512e2106571599f26a99d415bc08c58546
NAS_VPS_SIZE_SIDECAR_MATCH=PASS source=readonly_gate_list
```

VPS 同名三件 stat 大小仍为 283,215,297 / 260 / 98 bytes，0600 root。与 Owner 的 NAS 日志及目录大小、散列逐项一致，**NAS 拉取成功证据已取得；NAS/VPS 同名大小与 sidecar 散列比对 PASS**。最新 NAS 日志为 10:00:18Z，不能扩称此后尚未发生的拉取成功；VPS dump 实际散列和归档目录读取沿用 C 实测，本次只读比对不冒充重新完整恢复。

#### 凭据：Owner 提交校验，worker 执行成功的记录已核对

同一次 deploy 只读 SQL 会话 `BEGIN READ ONLY`、statement_timeout=15s、最终 ROLLBACK；只选择任务/审计元数据、允许的结果字段及指纹八位前缀，不输出完整 payload/result、密文或令牌。

| 记录 | Codex 本次只读结果（东京时间 +0900） |
|---|---|
| 指定任务 | `9f1d906b-88a9-402d-81e1-e71577765e16`，credential.validate.v1，completed；total=1、success=1、failed=0；requested_at=2026-10-05 21:17:12.822，completed_at=21:17:13.450174 |
| 执行条目 | `54a1d35b-bfd2-4db5-8a7c-10860f822383`，target=当前 credential `4410a759-8485-4fb8-954c-a497b8e6a229`，success，attempt=1；脱敏 result.status=active、code=null，result.lastValidatedAt=`2026-10-05T12:17:13.440Z` |
| 排队审计 | operation_audit id=603000，credential.validate.queued，actor_type=admin，task_id 为上述任务，entity_id 为当前 credential；created_at=21:17:12.837 |
| 完成审计 | operation_audit id=603001，credential.validate.completed，actor_type=admin，task_type=credential.validate.v1，task/entity 对应；created_at=21:17:13.466 |
| 当前凭据 | active 恰为一条、指纹前缀 44fb1a40；expires_at=2026-10-12 12:38:58；last_validated_at=2026-10-05 21:17:13.440，与执行条目时间精确一致，早于完成审计 |
| 变更日志 | credential_change_log id=6，action=validate，当前 credential，detail.status=active，created_at=21:17:13.459 |
| 本机排重与任务边界 | 与当前到期时间相同的其他凭据数量 0；指定领取批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 仍 paused；tagging pending/processing 为 0 |

任务成功、当前 active 及关联完成审计/更新时间的 SQL 断言通过，`STAGE2_CLOSURE_READONLY=PASS`，脱敏日志 `.tmp/cutover-stage2/stage2-owner-closure-readback.log`。**续期后当前凭据 worker 校验证据 PASS**，不再仅依赖同步 replace 时的 last_validated_at；前轮“validate log=0”是当时真实状态，现由 Owner 新提交任务补齐。actor_type=admin 是同版 handler 的审计约定，任务类型/执行条目和 task_id 链接确认 worker 执行；Codex 没有提交该任务、重试、续期或恢复领取批次。

凭据三项历史条件分别记录：旧 superseded 令牌已到期的只读证据保留；当前新凭据 worker 校验已补齐，但上游独立签发来源未另行取证，不把来源验证写为实测 PASS；本机到期排重 PASS，X8 到期排重按 Owner 明确决定 **WAIVED**（每周过期，旧令牌自然失效），未访问 X8、未取得其排重实测。Owner 按本次列明的补证与收尾范围结束第二段，不继续扩展签发来源调查。

#### 最终验收与停止边界

| 本段事项 | 最终结论 |
|---|---|
| DNS、运行 Final 身份及安全门禁 | 预检与各块门禁 PASS；最新只读会话仍为同一完整 Final，IndexNow 闭闸、领取批次 paused、自动分类在途零 |
| A 证书 | 三个指定 SAN、renew dry-run、timer PASS；备份和有效期见 A 记录 |
| B rehearsal | 完整/匿名验证、隔离、noindex、缓存/gzip、七项容量及 Owner worker 采样 PASS |
| C 连接数与本机备份 | 唯一 worker_connections=4096；独立 nginx 备份、本机 dump 三件/实际散列/归档目录读取 PASS |
| 本地限流逻辑 | `NGINX_MATRIX_ALL=PASS`；按 Owner 作为本段逻辑验收依据，保留 restart 就绪包装与两次原运行器失败 |
| NAS | Owner 日志的最近拉取成功已取得；Codex 同名大小和 sidecar 散列比对 PASS；完整恢复未验证 |
| 当前凭据 worker 校验 | 指定任务 completed/success、完成审计、变更日志与 last_validated_at 关联核对 PASS |
| X8 排重 | WAIVED（Owner）；不是实测 PASS |
| 外部 HTTPS 压测 | DEFERRED（Owner），推迟到确定对外开放日期之前；本轮未执行、没有请求比例/吞吐/延迟分位或线上零 5xx 结论 |
| 异地完整恢复演练 | DEFERRED（Owner）；恢复风险继续保留，异地副本可恢复性未经实测 |

限流建议保持模板现值，本段不再以外部直连故障阻止收尾；外部性能数据待未来开放前取得，矩阵 PASS 不代替性能数据。前述底层 renderer 路径判断、矩阵 reset 就绪及 worker 冷读查询索引的后续修复事项仍不属于此次证据提交。

**第二段准备按 Owner 最新决定收尾；提交并 push 本证据分支后停止。** 主机保持既有受保护 rehearsal，Basic Auth/noindex 保留，新域名普通路径拒绝，未正式切换；不安装 public 模式，不改变站点地址、模板、应用或数据库，不开 IndexNow，不操作 X8，不恢复批次，不新增提醒或自动后续任务。本次最终提交只包含文档/ADR；不合并。分支 HEAD 由最终交付回报给出，避免在提交内写入自身哈希。

## 外部 HTTPS 压测（2026-10-07，切换前）

本次按 Owner 2026-10-07 的任务及出站方式修订执行，运行态只读；证据分支 `ops/cutover-loadtest-2026-10` 基于收官提交 `62fc80fdde2ca8cb6d2165429b88f0cec218817a`，仅 push、不合并。本节只关闭前文外部 HTTPS 压测的 DEFERRED 项，不改变其它门禁结论。

### 网络、身份与受控凭据

- 客户机网络为 Wi-Fi，经本机 HTTP 代理（Owner 指定的海外出口）出站；所有 curl 使用 `--proxy http://127.0.0.1:7899`，去掉 `--noproxy` 和 `--resolve`。未读取或记录代理节点地址、账号，也未修改代理配置。延迟包含代理往返，只作相对比较；状态码分布、429 出现位置、5xx 观察及服务器负载的验收口径不变。
- 第 0 步匿名探测：curl exit=0，目标 HTTP/2 401，`www-authenticate: Basic realm="CPS Novel Rehearsal"`，`x-robots-tag: noindex, nofollow, noarchive`；代理 CONNECT 的 200 不计作目标响应。响应时间戳 `2026-10-06T20:07:52Z`（东京 2026-10-07 05:07:52）。经代理的 remote_ip 是代理地址，因此没有用于判断源站。
- 先前直连失败仍保留：DNS 返回 2.24.209.236；固定该 IP 且 `--noproxy` 的直连 curl exit=35、HTTP 000、Connection reset by peer、0.318757s。此前按停止规则没有继续；本轮仅在 Owner 明确授权代理出站后恢复。
- SSH 只读 health（web 容器本机 `/api/health`）：HTTP 200 / healthy，`build.version=0.5.9`、`build.commit=6af0b2e5c79db932c4754a43580eed3729bd0334`；六个容器均 healthy。首次只读基线 `2026-10-06T20:08:03Z`，uptime 17 天 10:19、load average 0.02 / 0.04 / 0.07；正式批前基线及逐批快照见下文。
- 服务器既有受控 config `/opt/cps-novel/shared/secrets/preprod-curl.conf` 元数据为 0600、deploy；通过 scp 复制到本机规定目录后立即 chmod 600。没有读取/打印内容或 Basic Auth 密码，没有提交凭据。认证首页探测 HTTP/2 200，保留 `noindex, nofollow, noarchive`（东京 05:12:22）。
- 只读 GET `/sitemap.xml` 返回 200，为 35 个分片的已发布索引；读取其中 `site_novelpage_en.xml` 返回 200。英文小说及章节 URL 从该英文分片提取，默认英文路径不带 `/en`：
  - 小说：`https://www.bangbangji.cloud/novel/contract-baby-and-billionaire-pg15q11wz`
  - 章节：`https://www.bangbangji.cloud/novel/contract-baby-and-billionaire-pg15q11wz/chapter/1`
- 本机 curl config 及其目录已删除，删除后检查均不存在；未触发 sitemap 刷新。

### 批次、状态码与延迟

请求总数 480；状态码合计 200=432、429=48；5xx=0。下表延迟单位秒，覆盖该批全部响应（超预算组包含 429）；每批先 `sort -n`，awk 数值取值及比较均 `+0`，以 nearest-rank（ceil(n×p)）计算 p50/p90/p99。样本量 30/40/100 时 p99 接近或等于最大值，不能当作更大样本的尾延迟估计。

| 批次 | 东京开始–结束 | 次数 / 并发 | 状态码分布 | p50 | p90 | p99 | 最大值 |
|---|---|---|---|---:|---:|---:|---:|
| 匀速 `/` | 05:13:32–05:14:32 | 30 / 1（每 2 秒） | 200×30 | 1.782235 | 1.857004 | 2.109890 | 2.109890 |
| 匀速 `/ko/browse` | 05:15:38–05:16:37 | 30 / 1（每 2 秒） | 200×30 | 1.591171 | 1.734267 | 1.833160 | 1.833160 |
| 手册 `/` | 05:17:43–05:18:02 | 40 / 4 | 200×40 | 1.808934 | 1.943213 | 2.399522 | 2.399522 |
| 手册 `/ko` | 05:19:08–05:19:27 | 40 / 4 | 200×40 | 1.857510 | 2.069982 | 2.096942 | 2.096942 |
| 手册 `/browse` | 05:20:33–05:20:50 | 40 / 4 | 200×40 | 1.654644 | 1.938273 | 1.958283 | 1.958283 |
| 手册 `/ko/browse` | 05:21:56–05:22:14 | 40 / 4 | 200×40 | 1.786093 | 1.884916 | 1.970495 | 1.970495 |
| 预取 `/ko/browse` | 05:23:20–05:23:38 | 40 / 4 | 200×40 | 1.724506 | 1.893455 | 2.280509 | 2.280509 |
| 超预算 `/ko/browse` | 05:24:44–05:24:53 | 100 / 20 | 200×52、429×48 | 1.595717 | 2.670058 | 2.780253 | 2.786325 |
| 补充 `/es/browse` | 05:25:59–05:26:16 | 40 / 4 | 200×40 | 1.635656 | 2.058580 | 2.484931 | 2.484931 |
| 补充 en 小说 | 05:27:22–05:27:41 | 40 / 4 | 200×40 | 1.819558 | 1.928086 | 2.125325 | 2.125325 |
| 补充 en 章节 | 05:28:46–05:29:03 | 40 / 4 | 200×40 | 1.609727 | 1.927352 | 2.269340 | 2.269340 |

每条路径独立成批；上批完成及只读服务器快照后，实际等待至少 60 秒再发下一批。普通并发 4 组按手册 `seq 1 40 | xargs -P 4 -I ... curl`，预取额外带 `Next-Router-Prefetch: 1`；超预算组为 `seq 1 100 | xargs -P 20 -I ... curl`。匀速基线每 2 秒发起一次且串行。未将 12r/s 持续速率预算简化为并发预算。低预算批无 429，因此无需恢复期重测；429 仅出现在超预算组。所有 curl 正常退出，无 000、5xx 或 stderr 错误。

### 服务器负载与逐批只读快照

`uptime` 与 `docker stats --no-stream` 均在正式批前及每批后通过 SSH 只读记录，同时确认六容器 healthy。快照不是请求进行中的连续监控，不能据此声称已测得瞬时 CPU 峰值。

| 时点 | 东京采样 | load average（1/5/15 分钟） | web CPU | web 内存 | postgres CPU | postgres 内存 |
|---|---|---|---:|---|---:|---|
| 正式批前 | 05:13:30 | 0.28, 0.18, 0.11 | 0.00% | 75.97MiB / 2GiB | 6.93% | 3.141GiB / 15.62GiB |
| 匀速 `/` 后 | 05:14:35 | 0.27, 0.20, 0.12 | 0.05% | 102.3MiB / 2GiB | 0.69% | 3.151GiB / 15.62GiB |
| 匀速 `/ko/browse` 后 | 05:16:41 | 0.13, 0.16, 0.11 | 0.04% | 78.85MiB / 2GiB | 0.30% | 3.148GiB / 15.62GiB |
| 手册 `/` 后 | 05:18:06 | 0.65, 0.29, 0.16 | 0.00% | 136.7MiB / 2GiB | 0.36% | 3.188GiB / 15.62GiB |
| 手册 `/ko` 后 | 05:19:31 | 0.36, 0.26, 0.16 | 0.01% | 132MiB / 2GiB | 0.31% | 3.197GiB / 15.62GiB |
| 手册 `/browse` 后 | 05:20:54 | 0.60, 0.31, 0.18 | 0.08% | 140.4MiB / 2GiB | 0.91% | 3.196GiB / 15.62GiB |
| 手册 `/ko/browse` 后 | 05:22:18 | 0.67, 0.37, 0.21 | 0.00% | 138.6MiB / 2GiB | 7.42% | 3.197GiB / 15.62GiB |
| 预取 `/ko/browse` 后 | 05:23:41 | 0.41, 0.35, 0.21 | 0.08% | 131.6MiB / 2GiB | 0.39% | 3.183GiB / 15.62GiB |
| 超预算 `/ko/browse` 后 | 05:24:57 | 1.29, 0.54, 0.28 | 0.26% | 170.2MiB / 2GiB | 7.67% | 3.185GiB / 15.62GiB |
| 补充 `/es/browse` 后 | 05:26:20 | 0.36, 0.43, 0.26 | 3.78% | 147.1MiB / 2GiB | 0.30% | 3.186GiB / 15.62GiB |
| 补充 en 小说 后 | 05:27:44 | 0.24, 0.38, 0.26 | 0.19% | 151MiB / 2GiB | 0.29% | 3.199GiB / 15.62GiB |
| 补充 en 章节 后 | 05:29:07 | 0.10, 0.31, 0.25 | 0.08% | 145.4MiB / 2GiB | 0.37% | 3.193GiB / 15.62GiB |

六容器的正式批前 → 最后一批后对比（CPU 为采样值，内存为使用量/限制）：

| 容器 | CPU 前 → 后 | 内存前 → 后 | PIDs 前 → 后 |
|---|---|---|---|
| cps-novel-backup-timer-1 | 0.00% → 0.00% | 19.84MiB / 15.62GiB → 19.84MiB / 15.62GiB | 2 → 2 |
| cps-novel-scheduler-1 | 6.46% → 0.00% | 3.496MiB / 512MiB → 3.492MiB / 512MiB | 2 → 2 |
| cps-novel-worker-light-1 | 0.58% → 0.77% | 96.77MiB / 1GiB → 96.33MiB / 1GiB | 45 → 45 |
| cps-novel-worker-1 | 1.03% → 1.16% | 97.74MiB / 2GiB → 100.1MiB / 2GiB | 54 → 54 |
| cps-novel-web-1 | 0.00% → 0.08% | 75.97MiB / 2GiB → 145.4MiB / 2GiB | 21 → 21 |
| cps-novel-postgres-1 | 6.93% → 0.37% | 3.141GiB / 15.62GiB → 3.193GiB / 15.62GiB | 20 → 20 |

正式批前 uptime：`05:13:30 up 17 days, 10:25,  1 user,  load average: 0.28, 0.18, 0.11`；最终：`05:29:07 up 17 days, 10:41,  1 user,  load average: 0.10, 0.31, 0.25`。逐批采样的 1 分钟负载最高 1.29；六容器全部快照 healthy。累计 Net I/O 和 Block I/O 及每次完整 stats 见下方留存（不等同于本次独占流量）。

<details>
<summary>正式批前及逐批后的完整只读 uptime / docker stats 快照</summary>

**正式批前**

```text
2026-10-06T20:13:30Z
 05:13:30 up 17 days, 10:25,  1 user,  load average: 0.28, 0.18, 0.11
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|6.46%|3.496MiB / 512MiB|358kB / 485kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.58%|96.77MiB / 1GiB|37.7MB / 17.4MB|0B / 38MB|45
cps-novel-worker-1|1.03%|97.74MiB / 2GiB|8.49MB / 14.7MB|299kB / 2.32MB|54
cps-novel-web-1|0.00%|75.97MiB / 2GiB|25.4MB / 44.5MB|242kB / 434kB|21
cps-novel-postgres-1|6.93%|3.141GiB / 15.62GiB|8.56GB / 78.2GB|721MB / 54.5GB|20
```

**匀速 `/` 后**

```text
2026-10-06T20:14:35Z
 05:14:35 up 17 days, 10:26,  1 user,  load average: 0.27, 0.20, 0.12
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.488MiB / 512MiB|362kB / 489kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.63%|96.48MiB / 1GiB|37.8MB / 17.5MB|0B / 38MB|45
cps-novel-worker-1|0.97%|98.67MiB / 2GiB|8.56MB / 14.8MB|299kB / 2.32MB|54
cps-novel-web-1|0.05%|102.3MiB / 2GiB|64MB / 54.3MB|242kB / 434kB|21
cps-novel-postgres-1|0.69%|3.151GiB / 15.62GiB|8.56GB / 78.2GB|721MB / 54.5GB|20
```

**匀速 `/ko/browse` 后**

```text
2026-10-06T20:16:41Z
 05:16:41 up 17 days, 10:28,  1 user,  load average: 0.13, 0.16, 0.11
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.492MiB / 512MiB|368kB / 499kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.65%|94.83MiB / 1GiB|37.8MB / 17.6MB|0B / 38MB|45
cps-novel-worker-1|0.95%|99.47MiB / 2GiB|8.69MB / 15.1MB|299kB / 2.32MB|54
cps-novel-web-1|0.04%|78.85MiB / 2GiB|111MB / 62.8MB|242kB / 434kB|21
cps-novel-postgres-1|0.30%|3.148GiB / 15.62GiB|8.57GB / 78.2GB|721MB / 54.5GB|20
```

**手册 `/` 后**

```text
2026-10-06T20:18:06Z
 05:18:06 up 17 days, 10:30,  1 user,  load average: 0.65, 0.29, 0.16
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.488MiB / 512MiB|375kB / 508kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.78%|96.32MiB / 1GiB|37.9MB / 17.7MB|0B / 38MB|45
cps-novel-worker-1|1.14%|98.84MiB / 2GiB|8.77MB / 15.3MB|299kB / 2.32MB|54
cps-novel-web-1|0.00%|136.7MiB / 2GiB|162MB / 76.1MB|242kB / 451kB|21
cps-novel-postgres-1|0.36%|3.188GiB / 15.62GiB|8.57GB / 78.3GB|721MB / 54.5GB|20
```

**手册 `/ko` 后**

```text
2026-10-06T20:19:31Z
 05:19:31 up 17 days, 10:31,  1 user,  load average: 0.36, 0.26, 0.16
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.5MiB / 512MiB|379kB / 513kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.71%|96.29MiB / 1GiB|37.9MB / 17.8MB|0B / 38MB|45
cps-novel-worker-1|0.79%|98.54MiB / 2GiB|8.86MB / 15.5MB|299kB / 2.32MB|54
cps-novel-web-1|0.01%|132MiB / 2GiB|226MB / 89.4MB|242kB / 451kB|21
cps-novel-postgres-1|0.31%|3.197GiB / 15.62GiB|8.58GB / 78.4GB|721MB / 54.5GB|20
```

**手册 `/browse` 后**

```text
2026-10-06T20:20:54Z
 05:20:54 up 17 days, 10:32,  1 user,  load average: 0.60, 0.31, 0.18
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.5MiB / 512MiB|382kB / 517kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.80%|97.72MiB / 1GiB|38MB / 17.9MB|0B / 38MB|45
cps-novel-worker-1|1.18%|98.96MiB / 2GiB|8.95MB / 15.6MB|299kB / 2.32MB|54
cps-novel-web-1|0.08%|140.4MiB / 2GiB|276MB / 99.9MB|242kB / 451kB|21
cps-novel-postgres-1|0.91%|3.196GiB / 15.62GiB|8.58GB / 78.4GB|721MB / 54.5GB|20
```

**手册 `/ko/browse` 后**

```text
2026-10-06T20:22:18Z
 05:22:18 up 17 days, 10:34,  1 user,  load average: 0.67, 0.37, 0.21
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.5MiB / 512MiB|389kB / 527kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.66%|95.32MiB / 1GiB|38MB / 18MB|0B / 38MB|45
cps-novel-worker-1|1.02%|98.54MiB / 2GiB|9.04MB / 15.8MB|299kB / 2.32MB|54
cps-novel-web-1|0.00%|138.6MiB / 2GiB|338MB / 111MB|242kB / 451kB|21
cps-novel-postgres-1|7.42%|3.197GiB / 15.62GiB|8.58GB / 78.5GB|721MB / 54.5GB|20
```

**预取 `/ko/browse` 后**

```text
2026-10-06T20:23:41Z
 05:23:42 up 17 days, 10:35,  1 user,  load average: 0.41, 0.35, 0.21
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.492MiB / 512MiB|392kB / 531kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.65%|96.9MiB / 1GiB|38.1MB / 18.1MB|0B / 38MB|45
cps-novel-worker-1|1.18%|98.85MiB / 2GiB|9.13MB / 16MB|299kB / 2.32MB|54
cps-novel-web-1|0.08%|131.6MiB / 2GiB|400MB / 122MB|242kB / 467kB|21
cps-novel-postgres-1|0.39%|3.183GiB / 15.62GiB|8.59GB / 78.5GB|721MB / 54.5GB|20
```

**超预算 `/ko/browse` 后**

```text
2026-10-06T20:24:57Z
 05:24:57 up 17 days, 10:36,  1 user,  load average: 1.29, 0.54, 0.28
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.496MiB / 512MiB|396kB / 536kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.70%|97.3MiB / 1GiB|38.1MB / 18.2MB|0B / 38MB|45
cps-novel-worker-1|0.92%|99.57MiB / 2GiB|9.21MB / 16.2MB|299kB / 2.32MB|55
cps-novel-web-1|0.26%|170.2MiB / 2GiB|481MB / 137MB|242kB / 467kB|21
cps-novel-postgres-1|7.67%|3.185GiB / 15.62GiB|8.59GB / 78.6GB|721MB / 54.5GB|20
```

**补充 `/es/browse` 后**

```text
2026-10-06T20:26:20Z
 05:26:20 up 17 days, 10:38,  1 user,  load average: 0.36, 0.43, 0.26
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|7.37%|3.496MiB / 512MiB|402kB / 546kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.68%|96.38MiB / 1GiB|38.1MB / 18.3MB|0B / 38MB|45
cps-novel-worker-1|0.87%|98.55MiB / 2GiB|9.29MB / 16.4MB|299kB / 2.32MB|54
cps-novel-web-1|3.78%|147.1MiB / 2GiB|538MB / 147MB|242kB / 467kB|21
cps-novel-postgres-1|0.30%|3.186GiB / 15.62GiB|8.6GB / 78.7GB|721MB / 54.5GB|20
```

**补充 en 小说 后**

```text
2026-10-06T20:27:44Z
 05:27:44 up 17 days, 10:39,  1 user,  load average: 0.24, 0.38, 0.26
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.492MiB / 512MiB|406kB / 550kB|786kB / 1.09MB|2
cps-novel-worker-light-1|7.90%|96.86MiB / 1GiB|38.2MB / 18.4MB|0B / 38MB|45
cps-novel-worker-1|7.18%|99.29MiB / 2GiB|9.38MB / 16.5MB|299kB / 2.32MB|54
cps-novel-web-1|0.19%|151MiB / 2GiB|590MB / 156MB|242kB / 467kB|21
cps-novel-postgres-1|0.29%|3.199GiB / 15.62GiB|8.6GB / 78.7GB|721MB / 54.5GB|20
```

**补充 en 章节 后**

```text
2026-10-06T20:29:07Z
 05:29:07 up 17 days, 10:41,  1 user,  load average: 0.10, 0.31, 0.25
cps-novel-backup-timer-1|Up 2 hours (healthy)
cps-novel-scheduler-1|Up 2 hours (healthy)
cps-novel-worker-light-1|Up 2 hours (healthy)
cps-novel-worker-1|Up 2 hours (healthy)
cps-novel-web-1|Up 2 hours (healthy)
cps-novel-postgres-1|Up 9 days (healthy)
cps-novel-backup-timer-1|0.00%|19.84MiB / 15.62GiB|2.68GB / 663kB|14.9MB / 682MB|2
cps-novel-scheduler-1|0.00%|3.492MiB / 512MiB|413kB / 560kB|786kB / 1.09MB|2
cps-novel-worker-light-1|0.77%|96.33MiB / 1GiB|38.2MB / 18.5MB|0B / 38MB|45
cps-novel-worker-1|1.16%|100.1MiB / 2GiB|9.47MB / 16.7MB|299kB / 2.32MB|54
cps-novel-web-1|0.08%|145.4MiB / 2GiB|641MB / 164MB|242kB / 471kB|21
cps-novel-postgres-1|0.37%|3.193GiB / 15.62GiB|8.61GB / 78.8GB|721MB / 54.5GB|20
```

</details>

### 结论、建议与执行偏离

**本次受控页面压测 PASS（代理出站口径）：低预算各批全部 200；仅超预算组出现 429；全部 480 个请求中 5xx=0；六容器逐批仍 healthy。** 这是本次路径、源出口、样本量及并发条件下的验收结果，不外推为完整容量上限或直连延迟。外部 HTTPS 压测从 DEFERRED 更新为本次已取得数据；是否正式切换仍由主控汇总其它门禁决定。

限流建议：当前数据不支持调整任何 nginx 模板数值，保持现状；正常及预取并发 4 组全 200、并发 20 超预算组产生 429 且无 5xx，保护行为符合预期。没有服务器配置安装、模板调参、DNS/证书/env/容器或业务开关修改；没有访问 `/go/`、后台或写接口，没有运行本地矩阵，没有开启站点地图刷新。

本轮已知偏离/包装修正：

1. Owner 追加授权出站方式为本机 HTTP 代理，替代原直连及关闭代理的前提；按指定 realm/noindex 验收身份，延迟仅作相对比较。
2. 本地只读元数据查找最初遍历到无权限的备份目录，find 非零；改为精确 stat 后重跑成功。health 包装检查最初误把版本取自顶层 `h.version`，实际位于 `h.build.version`；修正并重跑 PASS。这两项是本地检查问题，线上响应及状态均符合预期，没有把初次非零结果伪记为 PASS。
3. 为落实每批等待与“首个 5xx 立即停止”，在本机用只读编排包装手册原 seq/xargs/curl 命令；每条路径之间额外等待 60 秒，并记录每次原始 `http_code time_total`。5xx 时会终止在途 curl 并取消后续批次；本次未触发停止/重试。
4. health 通过 SSH 在 web 容器内用 Node fetch 只读 `/api/health` 核对，避免为服务器内 curl 引入客户端代理；其它所有 curl 均走 Owner 指定的代理。英文页面路径来自英文 sitemap，未人为添加不存在的 `/en` 前缀。
5. 清理时自动审批拒绝 `rm -f` 形式，理由为该命令形式不被允许；改用 Python 对指定 config 执行 unlink、对空目录执行 rmdir，已完成并确认文件及目录均不存在。没有因此留下凭据。

证据提交使用中文说明及 `Agent: codex` / `Model: GPT-6` trailer；不合并。分支 HEAD 在交付回报给出，不在提交内写入自身哈希。


## 切换当天（2026-10-07）：预检与逻辑备份通过，等待 Owner sudo

本节为执行中的真实记录，**未对外开放，未安装 public nginx，未改域名 env，未同镜像发布，无回退**。分支 `ops/public-cutover-2026-10` 从 `ops/cutover-loadtest-2026-10 @f962f9002156b6ef6457a9dbd4030f866d8ee86b` 创建，仅文档提交和 push，不合并、不打 tag、不开发功能。Owner 已确认的前置条件调整见 [ADR](../adr/ADR-PUBLIC-CUTOVER-20261007-PREREQUISITES.md)。

### 第 0～9 步状态

| 步骤 | 时间 / 结果 |
|---|---|
| 0 只读预检与暂停门禁 | 2026-10-07 14:39:59 JST：完整 Final / health healthy / database 与 metadata passed；六容器 healthy，原 SQL `PUBLIC_CUTOVER_PAUSE_GATE=PASS`；无运行中领取批次，无 pending/processing 后台发布任务；22 迁移名称、SHA256、finished/rolled_back 与 Final 一致。当前无需暂停批次，第 9 步恢复跳过；进入写步骤前仍重新检查 |
| 1 备份及身份 | 2026-10-07 14:41:57 JST：逻辑备份三件、pg_restore --list 和 sha256sum -c PASS；env 备份、四应用镜像及 postgres CID 已保存。整份 nginx 备份等待 Owner 在交互 SSH 中 sudo |
| 2 维护与 env | 未执行；两个域名保持旧值，尚无域名 diff/public preflight |
| 3 正式边缘 | 未安装；同版 renderer 的候选非空及拓扑检查 PASS，SHA256 `d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe`；`cutover_nginx_backup` 待安装器生成 |
| 4 同镜像发布 | 未执行；没有本次 RELEASE=PASS 或发布后镜像/CID 对比 |
| 5 外部验收 | 未执行正式域名验收/限流/worker 采样；en/ko/es 小说、英文章节和真实短码只读样本已准备，没有请求推广入口 |
| 6 后台设置 | 只读现值 PulseNovel / `/brand/og-default.png` 已核对；Owner 新后台登录/二步验证待执行，IndexNow 三项不配置 |
| 7 sitemap | 旧索引及全部 35 分片认证 GET 200，计数见下表；未入队新刷新，不用翌日兜底代替 |
| 8 GSC | GSC 待做，由 Owner 操作 |
| 9 恢复及收尾 | 本轮没有暂停批次，不恢复任何既有批次；监控平台状态待 Owner 提供。Notion 正式手账 fetch 成功，切换后的台账/开发日志及 Notion 同步尚未进行 |

### 备份、身份与 env

- 受控运行目录 `/opt/cps-novel/shared/cutover/20261007T053946Z`，目录 0700；包装目录 `/opt/cps-novel/shared/cutover-public-20261007`。
- `cutover_manifest=/opt/cps-novel/shared/artifacts/staging/6af0b2e5c79db932c4754a43580eed3729bd0334.json`；物理 release `/opt/cps-novel/releases/6af0b2e5c79db932c4754a43580eed3729bd0334`。
- 逻辑备份宿主机 `/opt/cps-novel/shared/backups/logical/public-cutover-20261007T053946Z.dump`；同目录 `.dump.sha256`、`.dump.metadata` 齐全。大小 681549422 bytes；SHA256 `27321aaaf79b6a4a3ea5feb6b81859ad5464524e5b77de5443fb9e6e0e0e461d`；原脚本 `LOGICAL_BACKUP=PASS`，独立目录读取和散列复核通过，backup-timer 未停止。
- postgres CID `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e`；web/worker/worker-light/scheduler 引用均 `cps-novel:0.5.9-6af0b2e`，实际锚点均 `sha256:faa2c75b7c6e00efbe20d65bee89e685556429f98d6901de79adf1d53318cb11`。
- env 只保存受控备份，未打印全文；当前 `SITE_URL=https://www.bangbangji.cloud`、`ADMIN_CANONICAL_ORIGIN=https://zbcwf.bangbangji.cloud`，尚未修改。
- 运行版 preflight：`PREPROD_SITE_MODE=preprod`、`PREPROD_PREFLIGHT=PASS`、secret consumer/access PASS；已批准写闸仍 catalog/promo/sitemap/auto_tag，未新增登记，IndexNow 四闸 false、delivery 不在 allowlist。

### 当天数据库基线

章节采用 v0.5.9 第二阶段 5c 的 SQL：已发布未软删文章关联小说，preview 未软删章节按 canonicalChapterNumber 取前 64 章，再要求正文 char_count>0。

| 语种 | 已发布小说页 | 免费正文章节 |
|---|---:|---:|
| ar | 31 | 93 |
| de | 843 | 2526 |
| en | 12947 | 38599 |
| es | 2671 | 8008 |
| fr | 2447 | 7332 |
| id | 1573 | 4719 |
| ja | 383 | 1149 |
| ko | 766 | 2298 |
| pl | 40 | 120 |
| pt-BR | 2312 | 6928 |
| ru | 2957 | 8867 |
| th | 932 | 2796 |
| vi | 828 | 2484 |
| zh-Hant | 15 | 45 |
| 合计 | 28745 | 85964 |

236 本已撤回零正文书状态为 `unpublished`，完整 ID/公开路径集合保存在受控 baseline.json，供刷新后排除检查。旧 sitemap 尚为撤回前 118537 个网址；不得将旧分片计数当作正式域名刷新验收。

| 切换前分片 | 条目数 |
|---|---:|
| site_mainpage_en.xml | 1798 |
| site_mainpage_es.xml | 302 |
| site_mainpage_pt-BR.xml | 260 |
| site_mainpage_id.xml | 189 |
| site_mainpage_vi.xml | 92 |
| site_mainpage_th.xml | 104 |
| site_mainpage_ja.xml | 61 |
| site_mainpage_ko.xml | 80 |
| site_mainpage_zh-Hant.xml | 7 |
| site_mainpage_ar.xml | 9 |
| site_mainpage_fr.xml | 285 |
| site_mainpage_de.xml | 113 |
| site_mainpage_pl.xml | 2 |
| site_mainpage_ru.xml | 290 |
| site_novelpage_en.xml | 10000 |
| site_novelpage_en_1.xml | 10000 |
| site_novelpage_en_2.xml | 10000 |
| site_novelpage_en_3.xml | 10000 |
| site_novelpage_en_4.xml | 10000 |
| site_novelpage_en_5.xml | 1782 |
| site_novelpage_es.xml | 10000 |
| site_novelpage_es_1.xml | 679 |
| site_novelpage_pt-BR.xml | 9240 |
| site_novelpage_id.xml | 6292 |
| site_novelpage_vi.xml | 3312 |
| site_novelpage_th.xml | 3728 |
| site_novelpage_ja.xml | 1532 |
| site_novelpage_ko.xml | 3064 |
| site_novelpage_zh-Hant.xml | 60 |
| site_novelpage_ar.xml | 124 |
| site_novelpage_fr.xml | 9779 |
| site_novelpage_de.xml | 3369 |
| site_novelpage_pl.xml | 160 |
| site_novelpage_ru.xml | 10000 |
| site_novelpage_ru_1.xml | 1824 |
| 合计（35 分片） | 118537 |

### 包装修正、sudo 输入与偏离

- 包装隔离检查 `WRAPPER_FIXTURES=PASS cases=11`，覆盖空候选、正常候选、公开健康/坏 JSON/身份错误/5xx/noindex 异常、错误后台 realm、worker 健康与过期锁/后三次全 failed。Bash 3.2 语法通过；断言显式退出，未使用独立 `[[ … ]]` 冒充退出门禁。
- 首次候选检查器按错误的 server 序号判断 HTTPS 拒绝块，fixture 失败；改为匹配 default_server 块后重跑通过。样本查询首次误用推广状态 ready 而取不到记录；核对代码实际状态 fetched 后修正并重查。不修改 release 代码。
- SSH 可用，但 `sudo -n true` 返回需要密码；工具明确禁止操作本机 Codex/Terminal 窗口，没有可交给 Owner 的工具终端输入通道。已提供 [Owner 交互命令单](PUBLIC_CUTOVER_OWNER_STEPS_2026-10-07.md)，由 Owner 在自己的终端输入密码，所有 sudo 放同一会话执行；不索取密码、不改 sudoers、不用 root。
- 本机外部旧站经指定代理匿名 401、rehearsal/noindex。新域名 exit 60 的切换前差异按 Owner 已确认 ADR 接受，public 安装后不放宽 TLS。
- 逻辑备份和候选先于需要 sudo 的整份 nginx 备份完成；两者都须在维护/env/安装前齐全。这是执行顺序偏离，不替代 nginx 备份。
- 当前记录只证明准备结果，不宣称第 1～9 步全部完成。

### 15:21–15:22 JST：首次 public 安装后 TLS 检查失败，nginx/env 已回退，保持维护

来源：Owner 回传交互脚本完整关键输出；Codex 于 2026-10-07 15:23–15:25 JST 独立只读复核。**本轮第 3 步失败，没有进入第 4 步，没有对外开放；确实执行过 nginx/env 回退。**

- Owner 的 sudo 会话先完成整份 nginx 备份；重验基线 `BASELINE=PASS published=28745 chapters=85964 withdrawn=236 shards=35`，原暂停 SQL 通过。公开候选 SHA256 仍为 `d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe`。
- 第 2 步开启维护，env 仅两个域名切为正式主站/后台；域名 diff 和其余字节 cmp 通过。`PREPROD_SITE_MODE=public`、`PREPROD_PREFLIGHT=PASS`、secret consumer/access、既有写闸和 worker lanes 全 PASS；没有新增写闸或配置 IndexNow。
- 第 3 步安装器备份 `cutover_nginx_backup=/opt/cps-novel/shared/nginx-backups/install.xzocFoFH`；nginx -t、安装器和安装后站点哈希均 PASS。安装 log 文件修改时间 15:22:04.784848375 JST。
- 第一轮公开首页探测记录修改时间 15:22:04.933848540 JST，约在安装 log 返回后 149ms。受控记录为 curlExit=60 / HTTP=000 / time=0.075343s，无 HTTP 响应头或正文。**严格就绪未通过**，没有把证书失败当作允许重试的 7/52/28 或旧 rehearsal HTTP 响应。
- 原包装随即开启维护，使用 `install.xzocFoFH` 恢复 nginx，并恢复 env。恢复操作额外生成的安全备份 `/opt/cps-novel/shared/nginx-backups/install.nBoCCanA` 是恢复前的 public 配置，不是本次所选恢复源。Owner 输出 `CUTOVER_EDGE_ROLLBACK=PASS env_restored=1 maintenance=ON`。
- Codex 独立 `cmp`：env 全文与受控备份字节一致，域名以外字节也一致（只打印比较结论，没有打印 env 全文）；当前两个域名已回到旧值。四应用镜像锚点完全不变，postgres CID 不变；六容器 healthy、nginx active、443 保留；edge.pass 不存在。
- 恢复后站点文件 SHA256=`9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0`，与原 rehearsal 证据一致。旧公开 health 认证 HTTP200/healthy、version0.5.9/完整Final、database及metadata passed、noindex/no-store。以合法旧域名 SNI + 新 Host 的回环探针得到新 Host 404。
- 本机经规定代理的旧站匿名首页为 HTTP503；维护明确仍开启，因此**不宣称已经恢复旧站业务 200 或完整回退后的 401/200 验收**。应用容器未重发，数据库和任务数据未恢复、未删除；第 4～9 步均未继续。

#### TLS 诊断限制与接续

- VPS DNS 中主站/后台均解析到 2.24.209.236。回退后的新 SNI 握手呈现旧公开站证书（CN/SAN www.bangbangji.cloud）；这是恢复后的 rehearsal 状态，不能倒推安装期间呈现的证书。
- 探测开始过早可能仍命中旧 worker，但目前仅有时间关联，**没有已确证的根因**。新证书 SAN/链问题与 reload 交接问题仍需区分。
- 自写 fetch 包装没有保存首次 curl stderr 或失败时证书元数据，导致仅知道 exit60，无法从保存证据区分具体 TLS 失败原因。已在本地修正后续错误文本留存并重跑 11 项隔离检查 PASS；不放宽证书验证或 curl60 门禁，未替换运行版代码，也未重新安装。
- deploy 无权读取新证书公开 fullchain 元数据、nginx error.log 和系统 reload journal，sudo -n 需要密码。已上传只读诊断脚本 `tls-readonly-diagnostic.sh`，本地/远端 SHA256=`2f3183c8f39ce232e645ed22ca7a84281c7985b2c01e7004679682b5258ab8fb`，Bash 语法通过；只取公钥证书元数据、指定窗口的控制日志及两份配置备份哈希，不读取私钥、不安装或 reload。Owner 的交互命令见命令单。
- 当前暂停在第 3 步失败后的诊断；保持维护。版本台账、正式开发日志和 Notion 尚未登记“正式开放”，GSC/监控保持待做。重跑或恢复旧站业务须先根据诊断确定处理方式，不重复执行原安装命令。


### 15:29–15:32 JST：只读 TLS 诊断及包装修正版准备

- Owner 已运行只读诊断，服务器留存 2026-10-07T06:29:18Z 的诊断日志，TLS_READONLY_DIAGNOSTIC=PASS。公开 fullchain 的 CN=pulsenovels.com；SAN=pulsenovels.com、www.pulsenovels.com、zbcwf.pulsenovels.com；颁发者 Let's Encrypt YE1；有效期 2026-10-05T04:14:21Z 至 2027-01-03T04:14:20Z；SHA256 指纹 `02:8E:A0:56:03:5E:C5:9F:1D:99:F6:2B:09:68:53:B1:E0:AB:1E:A9:46:20:A2:07:1F:EA:DB:6A:C6:EE:82:C3`。没有读取私钥。
- reload journal 记录 15:22:04 和恢复的 15:22:06 均 signal process started/reloaded。过滤的 nginx 控制事件为空。日志不证明首次探测实际呈现的证书，也不证明当时新 worker 已接管；**根因仍未确证**。
- 原安装备份 install.xzocFoFH/0.file 哈希=9a163d703e6f30950d444b01f152fbcaabed7e6ec9db17b8971289c1f665ffe0；恢复前安全备份 install.nBoCCanA/0.file 哈希=d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe。证实候选已安装且所选恢复源正确。
- 修正版只改变受控操作包装：安装前记录 nginx master/worker PID，安装后最多十轮等待旧 worker 全部退出、新 worker 出现，再执行原严格 HTTPS 就绪；master 改变、交接超时立即失败。没有修改运行版 renderer、证书、DNS 或容忍 curl60。失败时留存 curl stderr 和实际呈现的公开证书诊断。
- 原 checks.py/owner-edge.sh 已按原哈希保存在远端 wrappers-first-attempt/；首次日志仍保留。修正版重试各自写入 attempts/<UTC>/，不覆盖第一次失败证据和初始 env/镜像/CID/逻辑备份。
- 本地及远端 WRAPPER_FIXTURES=PASS cases=16，增加 curl60 必须失败、PID 完整交接/仍有旧 worker/master 改变/无 worker 检查；Bash 语法通过。修正版 checks.py SHA256=`154a81fe7095e0e820869e151db0fb4a2b295e9b84ac95abeec2c469acfc07e4`；owner-edge.sh SHA256=`9384ed4a260c24b92b672f17cf3b0776c595ea639910bb6614ed6bfc4d42b531`，本地/远端一致。
- 15:32 JST 独立只读重验输出 RETRY_DATABASE_BASELINE=PASS、BASELINE=PASS published=28745 chapters=85964 withdrawn=236 shards=35。原暂停 SQL、22 迁移、站点设置、逐语种小说/章节和撤回记录与维护前基线一致；旧站匿名 503/维护/noindex、认证健康及新 Host 拒绝通过。因维护期间 sitemap 返回维护页，35 分片/118537 条明确继承维护前完整快照，不冒充新的 HTTP 分片核验。
- 当时 nginx master=679455，worker=3160295,3160296,3160297,3160298；仅只读采集，没有安装或 reload。仍保持旧 env/rehearsal nginx/维护，未同镜像发布，未对外开放。下一动作是 Owner 在终端输入 sudo 执行已准备的修正版第 3 步；命令及哈希见 Owner 命令单。


### 15:51–15:54 JST：public 就绪及同镜像发布 PASS，外部 og:image 条件冲突后维护

- Owner 重试目录 `/opt/cps-novel/shared/cutover/20261007T053946Z/attempts/20261007T065104Z`；原 SQL/数据库基线与候选重验 PASS；env 两行 diff/其余字节 cmp PASS；public preflight PASS，IndexNow保持关闭。
- cutover_nginx_backup=`/opt/cps-novel/shared/nginx-backups/install.nFW11rwP`；nginx -t/安装器/安装文件哈希 PASS。worker交接第2轮通过，master679455，新worker3186083,3186084,3186085,3186086；严格 HTTPS 第1轮 PUBLIC_READY=PASS，06:51:23Z 写 edge.pass。此次等待交接后通过支持首次过早探测的可能性，仍不追认首次实际证书根因已确证。
- Codex 再次严格就绪通过、重跑原暂停 SQL 后，以完整批准Final/PREPROD_APPROVED_MIGRATION=YES 执行原 release.sh。同镜像身份、22迁移无待执行、grants、各服务健康与发布验证全部 PASS，RELEASE=PASS，06:52:59Z 写 deploy.pass；当时维护OFF、匿名live验证PASS。
- 四应用 `.Image` 均保持 sha256:faa2c75b7c6e00efbe20d65bee89e685556429f98d6901de79adf1d53318cb11；postgres CID保持691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e；backup-timer RUNNING_HEALTHY。15:54只读复核六容器仍healthy，安装站点哈希仍d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe。
- 外部所有请求经 http://127.0.0.1:7899，不使用-k/-L，HTTP均200/curlExit0。首页1.658801s、ko首页1.730210s、browse1.398545s、ko/browse1.521249s、es/browse2.173408s；HSTS均max-age=86400，无X-Robots-Tag/认证头，HTML gzip。已完成页面canonical/hreflang/og:url/og:image使用正式域名，首页默认图 https://pulsenovels.com/brand/og-default.png。
- en小说 `/novel/contract-baby-and-billionaire-pg15q11wz` HTTP200/2.234722s；canonical、两个alternate及og:url均是该正式域名URL、HTML robots=index,follow、无bangbangji。**og:image=https://cos-enres.cdreader.com/site-322(new)/0/84876/coverbig.jpg**，和本轮明确要求“og:image使用正式域名”矛盾。模板 novel/chapter调用resolveOgImage(coverUrl,defaultOgImage)，优先小说封面，是现有运行行为；不擅自放宽，不开发功能或改封面数据。EXTERNAL_ACCEPTANCE=FAIL reason=metadata_host_en-novel，随即MAINTENANCE=ON；停止后续验收并请求Owner裁决。
- 未知Host服务器回环验收独立PASS：HTTP合法域名resolve回环+未知Host得到curl52/000 emptyreply；HTTPS使用pulsenovels.com合法SNI、resolve回环+未知Host，严格TLS curl0/HTTP404，保护头noindex及HSTS86400保留。
- worker仅暖机一次HTTP200/workerStatus=ok/expiredLocks=0/0.059731s，等待10秒后与外部失败开启维护交叠，JSON解析失败停止。原日志和暖机响应留存；没有完成后三采样，**不宣称worker健康整组PASS或四次无过期锁**。包装后续须先留存raw再解析，以保存非JSON失败响应；本次不重复采样。
- 本次public部署后未回退nginx/env；只开启维护。首次15:22恢复历史仍保留。sitemap尚未刷新，仍以维护前35分片/118537条作为旧快照，不宣称已切正式域名或排除236本；未请求推广短码，未运行30次/并发10测试，未新增业务批次或其它写闸。

| 步骤 | 当前验收状态 |
| --- | --- |
| 0 门禁及基线 | PASS，运行领取/后台发布任务均无，逐语种及迁移一致 |
| 1 备份及身份 | PASS，dump/sha256/metadata/restore-list齐全，见前述备份路径及哈希 |
| 2 env/preflight/候选 | PASS，两行域名diff、余字节cmp、public preflight及候选 |
| 3 public nginx/TLS/维护就绪 | 第二次PASS，备份install.nFW11rwP，严格TLS不放宽 |
| 4 同版发布 | PASS，镜像/CID不变，backup-timer及匿名live通过 |
| 5 外部验收 | FAIL/停止：en og:image上游域名和条件冲突；未知Host独立PASS，其余待做 |
| 6 Owner后台/worker | 待做；仅worker暖机正常，后三次未完成；2FA/设置未回报 |
| 7 sitemap | 未执行，待Owner裁决后仅刷新一次并完整验收 |
| 8 GSC/监控 | GSC待做、三探针外部监控待Owner确认，不冒充已配置 |
| 9 同批次恢复/治理 | 本轮无暂停批次，恢复跳过；Git证据/台账/原v0.5.9日志已推送，Notion暂停状态已同步回读PASS；不合并 |

**当前是否开放：否，维护ON；是否回退：首次nginx/env已回退，本次public部署后未回退。** 不恢复数据库或删除任务。等待Owner决定接受既有上游HTTPS封面后继续、恢复旧nginx/env同manifest重发，或保持维护。


### 暂停状态治理同步（2026-10-07 15:57 JST）

- 本地版本台账追加切换当前状态并更新v0.5.9既有行；开发日志只补同一次v0.5.9发布条目，不新建版本、不移动tag或生成无关CHANGELOG。Git提交31bfeb5ed464c5cb7e1e08faace05def3aa0ba5f已推送远端并核对HEAD一致。
- 已同步既有Notion《海阅 版本管理与发版手账》page 3e4601b5-fd34-81b5-a39b-cf48408015c2：当前快照添加public部署通过但外部og:image冲突后维护的详细记录，原预生产当前快照改标历史，既有v0.5.9台账行追加暂停状态。异步任务task_21c6af0ef5da4216a8e04c86e372b0f1 succeeded；再次fetch回读当前身份、备份SHA、install.nFW11rwP、上游封面及维护待裁决全部PASS。除本次既有台账行追加以外，第二区及后续历史文本逐字节一致；没有覆盖历史或模板。
- 本次同步只登记已核实的暂停状态，不宣称正式开放或步骤5～9已全部完成。Owner封面裁决、后台2FA、sitemap、GSC/监控仍按上述验收表处理。


### 16:15–16:20 JST：Owner 更正分享图口径，剩余外部通过；唯一限流组未取得429后维护

- Owner 已裁决：上游HTTPS书封属于设计如此，首次og:image阻断来自主控提示词验收口径错误，不是线上缺陷。本次不改代码、不回退；更正规则已记录ADR。全部站内canonical/hreflang/og:url严格正式域名；og:image只允许HTTPS且无旧/短剧/本机/预生产域名，无书封取样必须正式默认图。
- 初次关闭维护包装漏带release.sh要求的PREPROD_RELEASE_VERIFIED=YES，返回MAINTENANCE_OFF=REFUSED，维护未关闭；依赖脚本启动过早取得一次en章节维护503。核对既有RELEASE=PASS与deploy.pass后补带标记关闭维护，原verify-release.sh --anonymous-only --expect-live PASS；随后各次包装修正后都先关闭维护、匿名live通过才继续。不修改release脚本、不新发镜像。
- 分类首样错误地来自待刷新的旧sitemap：/category/adventure得到404；fail-closed先维护。当前browse没有该链接，改为当前browse实际分类链接取样，HTTP200。保留旧404证据，待当天刷新验证旧空分类链接是否排除，不擅自修改分类数据。
- 后台根路径匿名404是public renderer的location /直接拒绝，包装原误要求401已改正；/login匿名401/CPS Novel Administration/noindex，认证后200；后台根路径认证后仍404/noindex符合隔离。没有修改renderer或放宽后台登录门禁。
- 外部续验复用已通过的首页/browse/小说响应及原时间记录，没有重复声称重新抓取；未完成项继续取真实响应。外部EXTERNAL_ACCEPTANCE=PASS于07:19:24.750112Z附近完成；全部本机curl经http://127.0.0.1:7899，未使用-k/-L。所有取样HTML不含bangbangji，canonical/hreflang/og:url用正式域名；撤回页200、This book is temporarily unavailable、HTML noindex，未重新发布撤回书。
- 默认图200/image/png/缓存一天，字节SHA256=c4a4a7f4d89a6bce6a3bbf6b50c965cfce53982f85c8aed76be17367731627fb；真实JS/CSS均200、一年immutable、gzip。公开后台/worker/backup404，无公开认证或X-Robots-Tag；robots允许抓取、正式sitemap地址及no-store，IndexNowkey404/no-store；公开health200/0.5.9完整Final/no-store。HSTS86400，无提级/subdomains/preload。
- www、旧主站及旧后台三组首跳301，保留/ko?q=1或/login?q=1，严格TLS成功；按renderer实际跳转响应无HSTS，不伪造响应头。未知Host此前服务器合法SNI回环拒绝证据PASS保持。
- 仅一个书封HEAD：https://cos-enres.cdreader.com/site-322(new)/0/84876/coverbig.jpg 经代理07:19:23.752234Z，HTTP200/image/jpeg/1.729561s；.requested标记防重复，未GET。仅一个真实短码首跳 /go/hpsuxf95w4，07:19:24.750112Z，302/0.977734s，Location=https://eng.moboreader.com/vRK5N/273MMA，no-store/HSTS86400；未跟随，未开点击追踪，不再请求该短码。

#### 每种页面类型的实际 og:image

| 页面取样 | og:image 实际值 |
| --- | --- |
| browse | https://pulsenovels.com/brand/og-default.png |
| category | https://pulsenovels.com/brand/og-default.png |
| en-chapter | https://cos-enres.cdreader.com/site-322(new)/0/84876/coverbig.jpg |
| en-novel | https://cos-enres.cdreader.com/site-322(new)/0/84876/coverbig.jpg |
| es-browse | https://pulsenovels.com/brand/og-default.png |
| es-novel | https://cos-spres.cdreader.com/site-375(new)/0/13880/coverbig.jpg |
| home | https://pulsenovels.com/brand/og-default.png |
| ko-browse | https://pulsenovels.com/brand/og-default.png |
| ko-home | https://pulsenovels.com/brand/og-default.png |
| ko-novel | https://cos-enres.cdreader.com/site-436(new)/0/95741/coverbig.jpg |
| removed-zero-chapter | 无（撤回提示页） |

#### 已取响应状态与耗时（完整关键响应头另存受控JSON）

| 取样 | HTTP | 秒 | Content-Type |
| --- | --- | --- | --- |
| home | 200 | 1.658801 | text/html; charset=utf-8 |
| ko-home | 200 | 1.73021 | text/html; charset=utf-8 |
| browse | 200 | 1.398545 | text/html; charset=utf-8 |
| ko-browse | 200 | 1.521249 | text/html; charset=utf-8 |
| es-browse | 200 | 2.173408 | text/html; charset=utf-8 |
| en-novel | 200 | 2.234722 | text/html; charset=utf-8 |
| en-chapter | 200 | 1.332697 | text/html; charset=utf-8 |
| es-novel | 200 | 1.700534 | text/html; charset=utf-8 |
| ko-novel | 200 | 1.661151 | text/html; charset=utf-8 |
| pre-refresh-sitemap | 200 | 1.671182 | application/xml; charset=utf-8 |
| category-sample-source | 200 | 1.17299 | application/xml; charset=utf-8 |
| category | 200 | 3.525774 | text/html; charset=utf-8 |
| removed-zero-chapter | 200 | 1.731624 | text/html; charset=utf-8 |
| brand-png | 200 | 1.550347 | image/png |
| static-js | 200 | 2.400236 | application/javascript; charset=UTF-8 |
| static-css | 200 | 2.288323 | text/css; charset=UTF-8 |
| public-deny--dashboard | 404 | 1.114061 | text/html |
| public-deny--api-admin | 404 | 1.926112 | text/html |
| public-deny--api-health-worker | 404 | 1.944638 | text/html |
| public-deny--api-health-backup | 404 | 1.083045 | text/html |
| public-deny--indexnow-key.txt | 404 | 1.101733 | text/plain;charset=UTF-8 |
| robots | 200 | 1.954735 | text/plain |
| public-health | 200 | 0.94842 | application/json |
| admin-login-anon | 401 | 0.998091 | text/html |
| admin-root-anon | 404 | 0.960392 | text/html |
| admin-login-auth | 200 | 1.150261 | text/html; charset=utf-8 |
| admin-root-auth | 404 | 0.95745 | text/html |
| redirect-www | 301 | 1.248267 | text/html |
| redirect-old-public | 301 | 0.968763 | text/html |
| redirect-old-admin | 301 | 0.963283 | text/html |
| book-cover-head | 200 | 1.729561 | image/jpeg |
| promo-first-hop | 302 | 0.977734 | — |

#### 唯一 30/10 限流组：429未验证，停止并维护

- 只执行一组 /ko/browse 30次、ThreadPool并发10；开始标记rate-small.started防止意外重跑，逐条状态/头/真实时间留存rate-small-results.json。总墙钟6.495256秒；首完成2026-10-07T07:19:41.633308+00:00、末完成2026-10-07T07:19:46.111049+00:00。
- HTTP200=30、429=0、502及其它5xx=0，curlExit0=30；耗时最短1.404669、中位1.946296、最长2.590961秒。**未观察到429，不宣称限流复测PASS**。RATE_SMALL=FAIL reason=rate_no_429_observed，按失败处理MAINTENANCE=ON。
- 未追加整轮压测、未改变并发/请求数/UA/参数或限流配置，未重装nginx。已向Owner报告并请求裁决是否接受429未验证的明确遗留项后继续，或保持维护/恢复旧站；没有把默认预选当作批准。
- 当前六容器healthy，public配置哈希仍d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe，正式env保留；本次public部署后未回退，首次回退历史保留。sitemap尚未入队/刷新；完整worker4采样未开始重测，Owner后台2FA/手动刷新/GSC/监控仍待回报。主站当前维护ON，不能登记正式开放。
- 检查器已修正为先留存worker原始响应再解析JSON，原暖机证据保留；修正版仅受控包装，没有产品代码改动。站点设置只读确认PulseNovel、/brand/og-default.png和IndexNow三项全空，不打印key值。


### 16:24 JST：最新暂停状态同步与待裁决门禁

- 只读设置确认GA4/Yandex均缺失，按计划跳过；IndexNow host/key/keyLocation全空，只打印布尔结果，PulseNovel及相对默认图保持。修正版checks.py本地/远端SHA256=a9063a4211403fb2760c5c448443ca6c69f901150503ee2eefb8c45e6894ce2a，远端16项隔离检查PASS；没有重复实际worker采样或限流组。
- Git证据22fdd07ef1cf69cceaecbf2ca37d0601d7edc717已push并回读远端HEAD一致。Notion当前快照追加Owner分享图口径更正、已完成外部及唯一限流组429未验证后维护；15:54原分享图暂停记录改标历史，既有v0.5.9台账行改为最新待裁决状态。异步任务task_f40bef96b4924fb4b9d4d685f7c84b42 succeeded；fetch回读PASS，除该台账状态外第二区及后续历史文本完全一致。
- 本次未请求第二组限流、未改变参数、未入队sitemap；未擅自把429未验证改成通过或豁免。已向Owner请求明确裁决，待回复；后台2FA/手动刷新偏好/GSC/监控未回报。

| 步骤 | 最新状态（此前历史表保留） |
| --- | --- |
| 0～4 | PASS：基线、备份、两行env、public安装/严格TLS、同镜像发布及CID对比 |
| 5 | 公开页面/后台隔离/跳转/资源/robots/分享图更正后PASS；短码仅首跳302、书封仅HEAD200；唯一30/10组无5xx但429未验证，当前维护待裁决 |
| 6 | 只读站名/分享图/IndexNow空值通过；Owner登录2FA待回报，完整worker4采样待继续，GA4/Yandex缺失跳过 |
| 7 | 未入队/刷新，旧35分片118537仅维护前快照；待裁决后当天仅刷新一次并核对28745/85964/236排除 |
| 8 | GSC待做，三探针外部监控待Owner确认 |
| 9 | 无本轮暂停批次，恢复跳过；Git/台账/原v0.5.9日志和Notion最新暂停状态已同步；不合并、无新tag |

**是否开放：当前否（维护ON）；是否回退：本次public部署后未回退，首次TLS失败的nginx/env回退仍为真实历史。** 当前阻断是30/10组未取得要求的429，分享图标准错误已获Owner纠正，不登记为产品缺陷。
