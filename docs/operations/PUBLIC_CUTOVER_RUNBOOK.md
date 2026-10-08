# 海阅公网切换手册

状态：代码准备；本文件不代表已切换或开闸。依据 Owner 2026-09-27 十项决定及 2026-09-28 本单确认。目标仍是 haiyue-vps，同库、同镜像；不操作 X8。以下主机写命令均由 Owner 在切换窗口执行。

## 口径与前置条件

- 主域 `pulsenovels.com`，后台 `zbcwf.pulsenovels.com`；`www.pulsenovels.com` 301 到主域。
- 两个旧名指 `www.bangbangji.cloud`、`zbcwf.bangbangji.cloud`，分别 301 到对应新站，保留路径与查询。不是另加裸域 `bangbangji.cloud` 的证书。
- preprod 模板保持基线字节。旧模板公开站仍代理 worker/backup 健康接口；rehearsal/public 在边缘封堵。必须先完成 rehearsal 验收。
- 页面爬虫 nginx `burst=2`：空桶前三次放行、第四次 429；`/go/ burst=1`：前两次放行、第三次 429。禁止预热后把第四次写作第三次。
- 新代码先按常规补丁流程部署到旧域名。**切换日复用该已发布补丁镜像**，不是回到未包含公网化的 v0.5.1 镜像。
- 切换前异地拉取及完整恢复演练必须 PASS；凭据三项关闭证据齐备：旧令牌过期、本机独立签发新令牌且 worker 校验成功、新令牌到期时间与 X8/本机其他凭据记录均不重复。X8 核查由 Owner 提供既有只读证据，本单不操作其栈。超过原凭据 2026-10-01 02:08 +0800 的窗口需先续期。
- tracking 继续关闭，博客/换小说双组写闸继续 false，二步验证强制，自动标签沿用现状；IndexNow 四项 false、两项登记均无、light 不含 delivery。
- 只配 A 记录，沿用 IPv4 listener；不在本次增加 AAAA。

## 预演准备（Owner）

主机登录后进入 **已发布公网化补丁的真实 release 目录**，使用 bash；不要以 zsh source lib。

```bash
ssh haiyue-vps
bash
set -euo pipefail
cd /opt/cps-novel/current
export PREPROD_ENV_FILE=/opt/cps-novel/shared/env/preprod.env
# 指定当前已批准且已部署的 release manifest 绝对路径。
read -r -p '当前 release manifest 绝对路径: ' cutover_manifest
[[ "$cutover_manifest" = /* && -r "$cutover_manifest" ]] || { echo 'manifest 无效'; exit 1; }
source scripts/preproduction/lib.sh
preprod_read_release_manifest "$cutover_manifest" || exit 1
export CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF"
export GIT_COMMIT="$PREPROD_RELEASE_COMMIT"
export APPROVED_GIT_COMMIT="$PREPROD_RELEASE_COMMIT"
preprod_load_env || exit 1
preprod_assert_local_image "$CPS_NOVEL_APP_IMAGE" || exit 1
[[ "$(git rev-parse HEAD)" == "$GIT_COMMIT" ]] || { echo '目录与镜像版本不一致'; exit 1; }
```

后续命令复用这个 bash 会话；退出重进则重跑以上初始化。不要输出 env 全文、Basic Auth 密码、令牌或 IndexNow key。

### DNS、证书及续期

在新网后台为主域、www、后台三个名字添加 A → `2.24.209.236`，TTL 300；GSC 网域验证 TXT 按 GSC 提供的值填写。逐个 `dig +short A NAME` 核对，不符则停止签发。

```bash
sudo mkdir -p /var/lib/letsencrypt/.well-known/acme-challenge
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --bootstrap-public
# 记录输出 NGINX_BACKUP；安装器先备份，nginx -t 成功才 reload。
printf 'haiyue-acme-probe\n' | sudo tee /var/lib/letsencrypt/.well-known/acme-challenge/cutover-probe >/dev/null
for name in pulsenovels.com www.pulsenovels.com zbcwf.pulsenovels.com; do
  curl --fail --show-error "http://$name/.well-known/acme-challenge/cutover-probe" || exit 1
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://$name/")" == 404 ]] || exit 1
  [[ "$(curl -ksS -o /dev/null -w '%{http_code}' "https://$name/")" == 404 ]] || exit 1
 done
sudo certbot certonly --webroot -w /var/lib/letsencrypt --cert-name pulsenovels.com \
  -d pulsenovels.com -d www.pulsenovels.com -d zbcwf.pulsenovels.com
sudo certbot renew --cert-name pulsenovels.com --dry-run
sudo systemctl status certbot.timer --no-pager
sudo openssl x509 -in /etc/letsencrypt/live/pulsenovels.com/fullchain.pem -noout -dates -ext subjectAltName
sudo rm -f /var/lib/letsencrypt/.well-known/acme-challenge/cutover-probe
```

必过：三名 SAN、续期 dry-run 成功、timer active；新站普通 HTTP/HTTPS 无内容、旧站仍有密码。HTTPS bootstrap 这里只用 `-k` 检查默认拒绝；正式验收禁用 `-k`。失败保留旧站，通过安装器恢复输出的备份，不直接覆盖 conf 或跳过语法检查。`--bootstrap-public` 与其余模式一样先做候选形状检查（只含 :80 的三名 server，无 TLS 与应用代理），装完等待 worker 交接并确认 :80 有监听，见第 3 步下的“安装器内置保护”。

### rehearsal 与容量

```bash
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --mode rehearsal
scripts/preproduction/verify-release.sh
preprod_compose exec -T postgres psql --no-psqlrc -U postgres -d cps_novel -c \
  "SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections','effective_io_concurrency','random_page_cost');"
```

rehearsal 安装使用与第 3 步相同的安装器保护（候选检查、哈希核对、reload 就绪等待），不再需要额外的物理目录、候选检查或哈希包装。

必过：旧域名密码、noindex、公开/后台隔离、健康接口、gzip/缓存均符合矩阵；参数与 v0.5.1 容量基线一致。目标机低流量窗口，用现有受控 curl config（0600，含 Basic Auth）从外部客户机做 HTTPS 压测：

```bash
# PREPROD_CURL_CONFIG 使用部署现有配置；下列只测页面，不触发领取。
for route in / /ko /browse /ko/browse; do
  seq 1 40 | xargs -P 4 -I '{}' curl --config "$PREPROD_CURL_CONFIG" -sS \
    -o /dev/null -w '%{http_code} %{time_total}\n' "https://www.bangbangji.cloud$route"
done
seq 1 40 | xargs -P 4 -I '{}' curl --config "$PREPROD_CURL_CONFIG" -sS \
  -H 'Next-Router-Prefetch: 1' -o /dev/null -w '%{http_code} %{time_total}\n' https://www.bangbangji.cloud/ko/browse
seq 1 100 | xargs -P 20 -I '{}' curl --config "$PREPROD_CURL_CONFIG" -sS \
  -o /dev/null -w '%{http_code} %{time_total}\n' https://www.bangbangji.cloud/ko/browse
```

记录低于预算时的 200/延迟与超预算时的 429；若有限流恢复中产生 429，分批等待后再测，不能把 12r/s 的持续速率预算当作仅并发预算。不得出现 502/其他 5xx。可重复、空桶及精确并发证据在本地运行 `scripts/preproduction/verify-nginx-matrix.sh`，测试台不对主机加压。压测后调整模板顶部集中数值并重新跑矩阵，再作为另一次配置安装交付。

### worker_connections（sudo）

```bash
sudo cp -a /etc/nginx/nginx.conf /etc/nginx/nginx.conf.before-public-cutover
sudo sed -i 's/worker_connections[[:space:]]*768;/worker_connections 4096;/' /etc/nginx/nginx.conf
sudo grep -n worker_connections /etc/nginx/nginx.conf
if sudo nginx -t; then sudo systemctl reload nginx; else
  sudo cp -a /etc/nginx/nginx.conf.before-public-cutover /etc/nginx/nginx.conf
  sudo nginx -t || exit 1
  exit 1
fi
```

必过：只有一个生效的 `worker_connections 4096;`。若原值并非 768，停止 sed 步骤，先核对变化来源。回退：恢复上述 `nginx.conf` 备份，`sudo nginx -t` 成功后 `sudo systemctl reload nginx`。站点安装器不管理 events 块。

### 异地备份

在 Mac/NAS 按 `infra/preproduction/README.md` 的 offsite-pull 命令安装既有定时任务，首次拉回后执行：

```bash
OFFHOST_COPY_CONFIRMED=YES scripts/preproduction/restore-offhost-rehearsal.sh \
  --offhost-dir /absolute/mac-or-nas-copy \
  --dump /absolute/mac-or-nas-copy/selected.dump \
  --manifest /absolute/mac-or-nas-copy/SHA256SUMS
```

三个绝对路径替换为同一实际导出集合。必须保留散列校验、恢复成功及角色/数据验收日志；失败不开放公网。

## 切换当天 0～9 步

### 0：暂停与清空在途

Owner 在后台批次详情执行批次级暂停（不对分片单独暂停）。保留目标批次 ID 和 `paused` 状态证据。主机只读门禁：

```bash
preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM generic_task b WHERE b.status IN ('pending','processing') AND EXISTS (SELECT 1 FROM generic_task s WHERE s.parent_task_id=b.id AND s.task_type='promo_link.claim.v1'))
 OR EXISTS (SELECT 1 FROM generic_task WHERE task_type='promo_link.claim.v1' AND status IN ('pending','processing'))
 OR EXISTS (SELECT 1 FROM side_effect_intent WHERE status IN ('prepared','claim_retry_blocked'))
 OR EXISTS (SELECT 1 FROM generic_task_item WHERE status='processing')
 OR EXISTS (SELECT 1 FROM channel_sync_task_item WHERE status='processing')
 THEN RAISE EXCEPTION 'PUBLIC_CUTOVER_PAUSE_GATE=FAIL'; END IF;
END $$;
SELECT 'PUBLIC_CUTOVER_PAUSE_GATE=PASS';
SQL
```

必须 PASS；失败等待在途结束或排查，不开始下一步。

### 1：备份及身份

```bash
cutover_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cutover_save="/opt/cps-novel/shared/cutover/$cutover_stamp"
mkdir -p "$cutover_save"
chmod 700 "$cutover_save"
cp -p "$PREPROD_ENV_FILE" "$cutover_save/preprod.env"
sudo cp -a /etc/nginx "$cutover_save/nginx"
preprod_compose ps -q postgres > "$cutover_save/postgres.cid"
preprod_compose ps -q web worker worker-light scheduler | xargs docker inspect --format '{{.Name}} {{.Image}}' > "$cutover_save/images.txt"
preprod_compose exec -T backup-timer /bin/bash /app/scripts/db/backup-logical.sh --output "/var/lib/cps-novel/backups/logical/public-cutover-$cutover_stamp.dump"
preprod_compose exec -T backup-timer pg_restore --list "/var/lib/cps-novel/backups/logical/public-cutover-$cutover_stamp.dump" >/dev/null
preprod_compose exec -T backup-timer sh -c "cd /var/lib/cps-novel/backups/logical && sha256sum -c public-cutover-$cutover_stamp.dump.sha256"
```

备份及其 metadata/sha256 必须完整。任何失败不切换；不停止 backup-timer。

### 2：维护与 env

```bash
scripts/preproduction/release.sh maintenance on
curl --config "$PREPROD_CURL_CONFIG" -sS https://www.bangbangji.cloud/ | grep -F '<h1>Maintenance in progress</h1>'
sed -i 's#^SITE_URL=.*#SITE_URL=https://pulsenovels.com#; s#^ADMIN_CANONICAL_ORIGIN=.*#ADMIN_CANONICAL_ORIGIN=https://zbcwf.pulsenovels.com#' "$PREPROD_ENV_FILE"
# 仅展示域名变化，禁止打印完整 env diff。
diff -u <(grep -E '^(SITE_URL|ADMIN_CANONICAL_ORIGIN)=' "$cutover_save/preprod.env") <(grep -E '^(SITE_URL|ADMIN_CANONICAL_ORIGIN)=' "$PREPROD_ENV_FILE") || true
cmp <(sed '/^SITE_URL=/d; /^ADMIN_CANONICAL_ORIGIN=/d' "$cutover_save/preprod.env") <(sed '/^SITE_URL=/d; /^ADMIN_CANONICAL_ORIGIN=/d' "$PREPROD_ENV_FILE") || { echo '域名以外的 env 内容被修改，停止'; exit 1; }
preprod_load_env || exit 1
scripts/preproduction/preflight.sh
```

必过：`PREPROD_SITE_MODE=public` 与 `PREPROD_PREFLIGHT=PASS`；用本地文件比较确认除两行外没有修改。失败恢复 env 备份，保持维护直到旧模式验证成功。

### 3：先安装正式边缘

```bash
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --mode public --hsts-max-age 86400 | tee "$cutover_save/nginx-install.log"
cutover_nginx_backup="$(sed -n 's/^NGINX_BACKUP=//p' "$cutover_save/nginx-install.log")"
[[ -n "$cutover_nginx_backup" ]] || exit 1
curl -sS -D "$cutover_save/public-maintenance.headers" https://pulsenovels.com/ | grep -F '<h1>Maintenance in progress</h1>'
curl --fail -sS https://pulsenovels.com/api/health
curl --fail --config "$PREPROD_CURL_CONFIG" -sS https://zbcwf.pulsenovels.com/api/health
```

安装后须为维护 503；健康接口仍可达。此时容器尚未更新 env，健康检查允许暴露当前相同镜像身份，业务内容必须被维护挡住。失败使用安装器 `--restore-backup` 恢复，恢复 env，不继续部署。

#### 安装器内置保护（v0.5.11 起）

2026-10-05 第二段准备暴露的三个底层缺陷（软链目录下渲染出 0 字节站点文件、安装器不拦空候选、reload 返回后立即探测的竞态）已在安装器里修复；证据对应关系见 `PUBLIC_CUTOVER_EVIDENCE.md` 末尾“底层修复已落地（v0.5.11）”。`install-nginx.sh` 经 `--mode`、`--bootstrap-public`、`--restore-backup` 进入的路径现在自带：

1. **软链安全的渲染**：渲染器按真实路径判断自己是不是 CLI 入口，脚本 root 取物理路径；在 `/opt/cps-novel/current` 下直接执行与在物理 release 目录下执行，渲染字节逐字节相同。渲染产物为空时 `render-nginx.sh` 自己就以 65 失败（`NGINX_RENDER=FAIL reason=empty_output`，原输出文件不动）。
2. **候选门禁**（在写备份目录、`/etc/nginx` 文件、`nginx -t` 和 reload 之前）：候选必须非空，并按 `--mode` 具备应有的形状。public：公开主机与后台主机的 :80→https 301 与 :443 应用 server、后台 `auth_basic "CPS Novel Administration"` 与口令文件指令、公开主机开放（无 auth_basic 口令域）、`www.pulsenovels.com` 301、两个旧域名 301（:80 与 :443 各一）、:80 拒绝（444）、未知 Host 的 :443 拒绝（404）、robots 为空、HSTS 取值等于 `--hsts-max-age`。rehearsal：同一拓扑，公开主机为 rehearsal 口令域（`auth_basic "CPS Novel Rehearsal"`）、noindex、无 HSTS，不要求旧域名 301。不满足时只打印检查码（不打印候选内容），任何系统文件都未动。
3. **安装后哈希核对**：站点文件与全部 snippet 的 SHA-256 必须等于候选/来源文件；不等则用本次备份回退并非零退出，且不一致的文件从未被 reload 加载。
4. **reload 就绪等待**（成功安装、回退、`--restore-backup` 的 reload 均适用）：reload 前记录 nginx master PID 与子进程集合；reload 后最多 10 轮、每轮间隔 1 秒，要求 master PID 不变、出现 reload 前不存在的新子进程、reload 前的旧子进程已退出或进程标题为 `shutting down`、期望端口有 TCP 监听（site 模式 80+443，`--bootstrap-public` 仅 80，`--restore-backup` 不断言端口）。只用 `systemctl show`、`pgrep`、`ps`、`ss`，无需读 nginx 日志；不做业务 HTTP 探测，业务层验收仍由 `verify-release.sh` 与本手册各步骤负责。

| 现象 | 输出 | 退出码 | 状态 |
|---|---|---|---|
| 候选为空 | `NGINX_INSTALL=REFUSED reason=candidate_empty` | 65 | 未动任何文件 |
| 候选缺 server 或关键指令 | `NGINX_CANDIDATE=FAIL mode=… missing=<检查码>`，随后 `reason=candidate_incomplete` | 65 | 未动任何文件 |
| 缺少 pgrep/ps/ss/systemctl/node/sha256 工具 | `reason=ready_tool_missing tool=…` | 69 | 未动任何文件 |
| 安装后哈希不一致 | `reason=installed_hash_mismatch file=… installed_sha256=… expected_sha256=…` | 72 | 已用本次备份回退（stderr `candidate_failed_restored`） |
| reload 后 10 轮内未交接 / 缺监听 / master 变化 | `reason=ready_handoff_timeout`、`ready_listener_missing`、`ready_master_changed`、`ready_master_missing` | 73 | 已用本次备份回退，回退的 reload 也等待交接 |
| 回退本身未能确认 | stderr `reason=rollback_failed` | 71 | 保持维护，按 `NGINX_BACKUP` 目录人工核对 |

成功时 stdout 依次含 `NGINX_CANDIDATE=PASS mode=… bytes=… sha256=…`（候选摘要，可直接记入证据）、`NGINX_BACKUP=…`、`NGINX_READY=PASS phase=install round=N master=PID listeners=80 443`、`NGINX_INSTALL=PASS …`。

因此切换当天原先的包装规避可以去掉：必须在物理目录执行（保留 `cd -P` 无害）、安装前手工检查候选非空并含各 server、安装后手工核对站点文件哈希、reload 后手写的最多 10 轮 worker/监听交接等待。**仍须保留**的是业务层验收：公开/后台严格 HTTPS 探测（不用 `-k`）、维护 503 页、健康接口、`verify-release.sh`。

### 4：相同镜像发布

```bash
APPROVED_GIT_COMMIT="$GIT_COMMIT" PREPROD_APPROVED_MIGRATION=YES \
  scripts/preproduction/release.sh deploy --manifest "$cutover_manifest"
[[ "$(preprod_compose ps -q postgres)" == "$(cat "$cutover_save/postgres.cid")" ]] || { echo '数据库容器身份变化'; exit 1; }
preprod_assert_container_image web worker worker-light scheduler || exit 1
preprod_compose ps -q web worker worker-light scheduler | xargs docker inspect --format '{{.Name}} {{.Image}}' > "$cutover_save/images-after.txt"
diff -u "$cutover_save/images.txt" "$cutover_save/images-after.txt"
scripts/preproduction/verify-release.sh --anonymous-only --expect-live
```

必过 `RELEASE=PASS`、镜像一致、postgres CID 不变、四应用 healthy、backup-timer 常驻。既有发布入口会执行 migrate-approved/grants；本单没有新迁移，必须事先确认当前同版本无 pending migration。发布失败保持维护，按下方 env+nginx 回退。

### 5：外部验收

从外部客户机执行，不使用 `-k`、不使用 `-L` 掩盖错误重定向：

```bash
curl -sS -D - -o /dev/null https://pulsenovels.com/
curl -sS -D - -o /dev/null https://pulsenovels.com/ko
curl -sS -D - -o /dev/null https://pulsenovels.com/browse
curl -sS -D - -o /dev/null https://pulsenovels.com/brand/og-default.png
curl -sS -D - -o /dev/null https://pulsenovels.com/dashboard
curl -sS -D - -o /dev/null https://pulsenovels.com/api/health/worker
curl -sS -D - -o /dev/null https://zbcwf.pulsenovels.com/login
curl -sS -D - -o /dev/null https://zbcwf.pulsenovels.com/
curl -sS -D - -o /dev/null 'https://www.pulsenovels.com/ko?q=1'
curl -sS -D - -o /dev/null 'https://www.bangbangji.cloud/ko?q=1'
curl -sS -D - -o /dev/null 'https://zbcwf.bangbangji.cloud/login?q=1'
curl --fail -sS https://pulsenovels.com/robots.txt
curl -sS -D - -o /dev/null https://pulsenovels.com/indexnow-key.txt
```

补充实际已发布小说、目录/章节、分类和真实推广短码样例，记录浏览器最终可达结果；推广入口本身通常是 3xx，不要求第一跳伪装成 200。逐项验收：

- 公开页无需密码，HTML 的 canonical/hreflang/分享地址无旧域名；公开所有状态无 X-Robots-Tag，HSTS 为 86400 且无 includeSubDomains/preload。
- 公开后台路径及 worker/backup 健康接口 404；后台登录先 401，带 Basic Auth 可达登录页，公开页面 404，所有响应保留 noindex。
- www/旧域名 301，保留查询和路径；未知 Host HTTP 拒绝、HTTPS 404。
- 实际页面引用的 `/_next/static/` URL 缓存一年 immutable；分享图 `image/png`、缓存一天、下载 SHA-256 与交付一致；`curl --compressed -D -` 验证 JS/CSS 等压缩。
- robots/sitemap/key/health 为 no-store；配置 IndexNow key 前 key 为 404。
- HTTPS 爬虫及并发复测符合预演记录，超过预算为 429，不出现 502；不得用 HTTP 301 当限流证据。
- UptimeRobot 三条关键词监控：公开 `/api/health`、**后台** `/api/health/worker` 与 `/api/health/backup`（带 Basic Auth），全部绿。

失败先开启维护，按影响范围回退；不能以 HTTP 200 单独证明业务正确。

### 6～9：设置、站点地图、GSC、恢复

6. 后台新域名重新登录并完成二步验证。设置 `default_og_image=https://pulsenovels.com/brand/og-default.png`，站名 PulseNovel；生成 IndexNow key 并填写 host/key/keyLocation 三项，**不开闸**；保存操作理由，记录审计。缺失这张默认分享图仍是上线阻断，不能长期保留短剧品牌地址。设置失败保持暂停并修复。
7. 后台设置点击手动刷新 sitemap，记录 request/task ID、light 执行结果；备用命令只入队：

```bash
preprod_compose_app_run -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" web \
  tsx scripts/generate-static-sitemaps.ts --apply --reason '正式域名切换后刷新 sitemap'
curl --fail -sS https://pulsenovels.com/sitemap.xml
# 继续取 index 中所有分片，逐个核对 loc/hreflang 全为 pulsenovels.com。
preprod_compose logs --since 10m worker-light
```

失败查 light 队列和日志；不得只依赖翌日东京 04:00 兜底作为当日验收。
8. GSC 验证网域资源并提交 `https://pulsenovels.com/sitemap.xml`，保存已提交状态；可稍后补，不开启 IndexNow。
9. Owner 后台恢复同一批次，观察状态进入运行、上游零 429，失败再次暂停；切换 30～45 分钟只是预算，不是超时后跳过验收的理由。

## 回退、后续观察与 sudo 清单

**仅回 nginx**：先 `scripts/preproduction/release.sh maintenance on`，然后：

```bash
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --restore-backup "$cutover_nginx_backup"
```

`--restore-backup` 同样等待 worker 交接（不断言端口，输出 `NGINX_READY=PASS phase=install … listeners=none`）；若 10 轮内没有交接，以 73 退出并自动回到恢复前的状态（该次恢复自己的安全备份），此时保持维护并按输出的备份目录人工核对。

恢复旧域名密码和 noindex，新域名无业务内容；nginx-only **不会**恢复应用生成 URL 的正式域名，也不要为了验收旧域名临时改 SITE_URL 输入源。作为紧急关闭公网的步骤，保留维护状态；需要恢复旧站业务则继续下一档。

**连 env 一起回**：保持维护，先恢复 nginx，然后恢复 env，同 manifest 再发一次：

```bash
cp -p "$cutover_save/preprod.env" "$PREPROD_ENV_FILE"
preprod_load_env || exit 1
APPROVED_GIT_COMMIT="$GIT_COMMIT" PREPROD_APPROVED_MIGRATION=YES \
  scripts/preproduction/release.sh deploy --manifest "$cutover_manifest"
# 后台旧域名重新登录、恢复适合旧域名的 IndexNow 设置（或清空三项），重新刷新 sitemap。
scripts/preproduction/verify-release.sh --anonymous-only --expect-live
```

**数据不回**：不还原数据库，不删除任务、outbox 或尝试记录；后台设置和 sitemap 按当前域名重做。核对 GSC 是否已提交：若已做步骤 8，则在 GSC 撤下错误 sitemap，不能声称从未提交；IndexNow 四项始终关闭，应无外部推送。监控恢复旧域名、确认三条绿。事件连接数若需恢复，单独按 nginx.conf 备份回退。

第一周每天按 JSON 日志统计 429/499/5xx、request_time、upstream_response_time、两类限流 REJECTED，并看主机负载、数据库及两 worker 积压。稳定一周后用安装器 `--mode public --hsts-max-age 31536000` 提级；不加子域/preload。30 天后另行删除旧域名跳转与旧证书，先查续期引用；IndexNow 开闸按工单 6 单独审批。

### HSTS 提级（稳定一周后）

```bash
cd /opt/cps-novel/current   # 软链目录即可，安装器自己取物理路径
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --mode public --hsts-max-age 31536000 | tee "$evidence_dir/nginx-hsts-install.log"
scripts/preproduction/verify-release.sh --anonymous-only --expect-live
for host in pulsenovels.com zbcwf.pulsenovels.com; do
  curl -sSI "https://$host/" | grep -i '^strict-transport-security:'   # 期望 max-age=31536000，无 includeSubDomains/preload
done
```

`$evidence_dir` 为本次证据目录。安装器自带候选、哈希与就绪保护，不再需要 `cd -P`、手工候选检查、手工哈希核对或手写等待循环。候选中的 HSTS 取值必须等于 `--hsts-max-age`（否则 `NGINX_CANDIDATE=FAIL … missing=hsts_value`，退出 65，未动任何文件）。退出码非零即安装器已用本次备份回退，只需保存 stdout 里的 `reason=` 行。注意：浏览器一旦缓存 HSTS 最长保留一年，回退 nginx 收不回已缓存的值，所以“稳定一周”的前置条件不变。

Owner sudo 清单：ACME webroot/探针与 certbot；所有 nginx 安装和备份恢复；主配置连接数修改、检查和 reload；读取 root 备份证据。应用发布沿用现有 deploy 用户与 Docker 权限。切换前审阅手册和证据，本开发单不执行这些主机写步骤。
