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
