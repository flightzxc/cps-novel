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
