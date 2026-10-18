# 后台去掉 nginx Basic Auth：上线运维手册（v0.6.3，2026-10-18）

状态：代码已在功能分支准备，**本文不代表已上线**。生产步骤由 Codex 在 v0.6.3 发版时执行；带 `sudo` 的命令由 Owner 在自己的终端输入密码。决策见 [ADR-V063](../adr/ADR-V063-ADMIN-EDGE-BASIC-AUTH-REMOVAL.md)。

## 一、一页纸

| 项 | 内容 |
| --- | --- |
| 改了什么 | 后台 `zbcwf.pulsenovels.com` 的登录页、后台页面、后台接口、静态资源不再弹 Basic Auth，打开就是登录页 |
| 没改什么 | 三个健康检查接口 `/api/health`、`/api/health/worker`、`/api/health/backup` 仍要口令；限速、noindex 等安全头、维护页、兜底 404、证书、DNS、公开站全部路径不变（公开网址冻结） |
| 顺带生效 | PN-15 站内搜索的 nginx location（10-09 合入模板，一直没装；同一个模板，拆不开）。只给 `/search` 与 `/{语种}/search` 加独立限流，不改网址 |
| HSTS | 保持 86400，不变。要不要借这次一起提级由 Owner 决定（第六节） |
| 要不要 sudo | 要。安装和回滚都要 Owner 输 sudo 密码 |
| 🔴 先后顺序 | **先装 nginx，再跑 `release.sh deploy`**。反过来，v0.6.3 的发版核验会在关维护后看到旧门禁的 401，把站点关回维护 |
| 回滚 | 安装器 `--restore-backup` 一条命令；应用要回到 v0.6.2 之前，必须先回 nginx |
| 迁移 / grants / 环境变量 / 任务白名单 | 都没有变化 |

## 二、生产 nginx 是怎么装的（现状）

- **唯一装法是仓库里的安装器**：`scripts/preproduction/install-nginx.sh --mode public --hsts-max-age <秒>`，它转给 `install-public-nginx.sh`。安装器用自己所在 release 目录里的模板渲染候选（`render-nginx.sh` → `render-public-nginx.mjs`），**不以生产上现有的文件为底稿**：整份覆盖 `/etc/nginx/conf.d/cps-novel-preprod.conf`（文件名沿用预生产时期），并把 7 个 snippet 从仓库原样装进 `/etc/nginx/snippets/`。
- **安装器自带的保护**：要求 `PREPROD_OWNER_SUDO_APPROVED=YES`；检查 nginx 是 1.24；写任何东西之前先做候选检查（非空、形状符合 public 模式，含本次新增的两项后台口径检查），不通过就退出 65、什么都没动；整份备份到 `/opt/cps-novel/shared/nginx-backups/install.XXXXXXXX`（输出 `NGINX_BACKUP=…`）；装完逐文件核对哈希；`nginx -t`；reload。
- **reload 是异步的**：`systemctl reload nginx` 一返回，master 才开始读新配置、起新 worker，之后才让旧 worker 退出；这时马上探测可能还打到旧配置。安装器在 reload 后等 worker 换代：master PID 不变、出现 reload 前没有的新 worker、旧 worker 已退出或标题是 `shutting down`、80 和 443 都在监听，最多 10 轮、每轮 1 秒，通过才打印 `NGINX_READY=PASS phase=install`。任何一步失败都会用本次备份自动回退并 reload。**看到 `NGINX_READY=PASS` 之后再做验证**；下面第 1 步还会再轮询一次登录页，确认新配置真的在服务。
- **生产上现在跑的是哪一份**：10-07 切换当天用 v0.5.9（Final `bbb0625`）装的 public@86400，16,840 字节，SHA-256 `d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe`（见 `PUBLIC_CUTOVER_EVIDENCE.md`）。之后各版台账都记"nginx 未安装 / public 哈希不变"（v0.5.10、v0.5.11、v0.5.14 搜索模板未装、v0.6.2）。用 `bbb0625` 与 `6af0b2e` 的模板在本地重新渲染，字节与这个哈希一致。
- **所以第一件事是确认生产文件没被手改过**：安装器整份覆盖，手改会被抹掉。生产文件哈希不等于上面那个值就停下，报主控和 Owner，不要安装。
- **本次安装相对生产现状的全部差异**（逐行核对过；7 个 snippet 与生产现状逐字节相同）：
  1. 后台块 5 个 location（登录页、后台接口两个、后台页面正则、静态资源）各删 2 行 Basic Auth，共删 10 行；
  2. 后台块加 5 行中文注释；
  3. PN-15 搜索：文件头 5 行注释、2 行限流区、一个搜索 location（4 行注释 + 10 行配置），共加 21 行。
  合计删 10 行、加 26 行；不算注释，新增的只有 12 行，都是搜索的。

## 三、上线步骤

前提：v0.6.3 发布归档已经按常规上传、校验、解包到 `/opt/cps-novel/releases/<v0.6.3 Final>`，**还没有跑 `release.sh deploy`**（`/opt/cps-novel/current` 此时仍指向 v0.6.2）。

### 第 0 步：只读预检（不需要 sudo）

```bash
ssh haiyue-vps
bash
set -euo pipefail
final=<v0.6.3 Final 40 位>
release_dir=/opt/cps-novel/releases/$final
cd "$release_dir"
[[ "$(git rev-parse HEAD)" == "$final" ]] || { echo 'release 目录不是 v0.6.3 Final'; exit 1; }
evidence=<本次发版证据目录>
mkdir -p "$evidence"

# 1) 生产现状仍是 10-07 装的那一份，snippet 与本版仓库一致
live=/etc/nginx/conf.d/cps-novel-preprod.conf
sha256sum "$live" | tee "$evidence/nginx-before.sha256"
[[ "$(sha256sum "$live" | cut -d' ' -f1)" == d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe ]] \
  || { echo 'STOP: 生产 nginx 与 10-07 安装不一致，可能被手改过'; exit 65; }
for name in cps-novel-preprod-security cps-novel-preprod-protected cps-novel-preprod-protected-nomaintenance cps-novel-preprod-proxy cps-novel-edge-public-security cps-novel-edge-admin-security cps-novel-edge-maintenance; do
  cmp "/etc/nginx/snippets/$name.conf" "infra/preproduction/nginx/$name.conf" || { echo "STOP: snippet $name 不一致"; exit 65; }
done

# 2) 先渲染一份候选到临时文件，跑和安装器同一套候选检查（不碰 /etc/nginx）
candidate="$(mktemp /tmp/v063-nginx-candidate.XXXXXX)"
scripts/preproduction/render-nginx.sh --mode public --hsts-max-age 86400 --output "$candidate"
node scripts/preproduction/verify-nginx-candidate.mjs --mode public --hsts-max-age 86400 "$candidate" | tee "$evidence/candidate.txt"
diff "$live" "$candidate" >"$evidence/nginx.diff" || true
grep -c '^< ' "$evidence/nginx.diff"                    # 期望 10
grep '^< ' "$evidence/nginx.diff" | sort | uniq -c      # 期望只有两种行，各 5 次：auth_basic "CPS Novel Administration"; 与 auth_basic_user_file …htpasswd;
grep -c '^> ' "$evidence/nginx.diff"                    # 期望 26
grep '^> ' "$evidence/nginx.diff" | grep -v '^> *#'     # 期望 12 行，全是搜索：两行 limit_req_zone + 搜索 location
rm -f "$candidate"

# 3) 安装前基线：匿名访问后台登录页仍是旧门禁
curl -sS -o /dev/null -D "$evidence/admin-login-before.headers" https://zbcwf.pulsenovels.com/login
head -1 "$evidence/admin-login-before.headers"   # 期望 401
```

`candidate.txt` 期望是 `NGINX_CANDIDATE=PASS mode=public bytes=18307 sha256=7199de10c02c9484fb5c8d571351f45fb7c3c49672648ad592110e142c6348b9`（以功能分支交付时的模板计算；主控合并后若模板没再改，这个值不变）。任何一项不符就停下，不进入第 1 步。

### 第 1 步：Owner 输 sudo，用安装器重装 nginx

```bash
cd "$release_dir"     # 必须是 v0.6.3 的 release 目录；current 此时还是 v0.6.2，从那里装会装回旧模板
sudo -v               # Owner 输密码
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --mode public --hsts-max-age 86400 | tee "$evidence/nginx-install.log"
nginx_backup="$(sed -n 's/^NGINX_BACKUP=//p' "$evidence/nginx-install.log")"
[[ -n "$nginx_backup" ]] || { echo '没有拿到备份目录'; exit 1; }
echo "$nginx_backup" | tee "$evidence/nginx-backup-dir.txt"
grep -E '^NGINX_CANDIDATE=PASS mode=public ' "$evidence/nginx-install.log"
grep -E '^NGINX_READY=PASS phase=install round=[0-9]+ master=[0-9]+ listeners=80 443$' "$evidence/nginx-install.log"
grep -E '^NGINX_INSTALL=PASS mode=public ' "$evidence/nginx-install.log"
sha256sum "$live" | tee "$evidence/nginx-after.sha256"   # 期望等于第 0 步候选的 sha256

# reload 已等过 worker 换代；再从边缘确认新配置确实在服务（最多 10 次、每次间隔 1 秒）
for i in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' https://zbcwf.pulsenovels.com/login)"
  [[ "$code" == 200 ]] && break
  sleep 1
done
[[ "$code" == 200 ]] || { echo "STOP: 后台登录页仍是 $code"; exit 65; }
```

安装器退出码非零时它已经用本次备份自动回退（输出里有 `reason=`），生产仍是 `d2825477…`、应用仍是 v0.6.2，不受影响。此时**不要继续 `release.sh deploy`**，保存输出报主控和 Owner。

### 第 2 步：公网验证矩阵

从外部客户机（无痕、匿名）和服务器上各取一遍，保存状态码和响应头。`preprod-curl.conf` 只用在标"带口令"的几行。

| 请求 | 期望 |
| --- | --- |
| 后台 `/login` 匿名 | **200**，就是登录页（能看到人机验证组件）；**没有** `WWW-Authenticate`；有 `X-Robots-Tag: noindex, nofollow, noarchive`；`Strict-Transport-Security: max-age=86400` |
| 后台 `/dashboard` 匿名 | 不再是 401；由应用把未登录的人带到登录页（浏览器最终停在 `/login`） |
| 后台 `/api/admin/tasks` 匿名 | 由应用自己拒绝：401 或 403 的 JSON，**不是 200**，没有 `WWW-Authenticate: Basic` |
| 后台登录页实际引用的一个 `/_next/static/…` 文件匿名 | 200 |
| 后台 `/api/health`、`/api/health/worker`、`/api/health/backup` 匿名 | **仍是 401**，`WWW-Authenticate: Basic realm="CPS Novel Administration"` |
| 同上三个，带口令（`curl --config "$PREPROD_CURL_CONFIG"`） | 200；`/api/health` 的 `build.commit` 仍是 v0.6.2 Final（应用还没发） |
| 后台 `/`、`/api/health-anything` | 404 |
| 公开站 `/`、`/ko`、一本已发布小说、它的第 1 章 | 200，无 `X-Robots-Tag`，HSTS 86400（与安装前一致） |
| 公开站 `/dashboard`、`/login`、`/api/admin`、`/api/health/worker` | 404 |
| 公开站 `/api/health` 匿名 | 200 |
| 公开站 `/search?q=a` | 与安装前同样的应用响应（新增的只是独立限流） |
| 浏览器无痕打开后台登录页 | 不弹浏览器口令框，直接是登录页；Owner 正常登录并完成两步验证 |
| UptimeRobot 三条关键词监控 | 绿（后台两条本来就带口令，不受影响） |

任何一条不符：按第四节"只回 nginx"恢复，不进入第 3 步。

### 第 3 步：发应用

矩阵通过后照常发 v0.6.3：

```bash
cd "$release_dir"
APPROVED_GIT_COMMIT="$final" PREPROD_APPROVED_MIGRATION=YES \
  scripts/preproduction/release.sh deploy --manifest <v0.6.3 manifest 绝对路径>
```

环境初始化（`PREPROD_ENV_FILE`、读 manifest、`preprod_load_env`）与平常发版完全相同，以常规发版手册为准。`release.sh deploy` 每次都要 `PREPROD_APPROVED_MIGRATION=YES`（它固定跑一次 `migrate-approved` 并重放 grants）；本版没有新迁移，这一步不会改表。v0.6.3 的 `verify-release.sh` 在关维护后会按新口径核对：后台 `/login` 匿名 200；完整核验里后台 `/api/health` 匿名 401、带口令 200 且 `build.commit` 是 v0.6.3 Final。

## 四、回滚

### 只回 nginx（应用留在 v0.6.3 或还在 v0.6.2）

```bash
cd /opt/cps-novel/current   # 软链目录即可，安装器自己取物理路径
sudo -v
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --restore-backup "$nginx_backup" | tee "$evidence/nginx-restore.log"
sha256sum /etc/nginx/conf.d/cps-novel-preprod.conf    # 期望回到 d2825477…
curl -sS -o /dev/null -w '%{http_code}\n' https://zbcwf.pulsenovels.com/login   # 期望 401（旧门禁回来了）
```

- `--restore-backup` 不带 `--mode`。它先把恢复前的状态再备份一份，然后恢复、`nginx -t`、reload，同样等 worker 换代（不断言端口，输出 `NGINX_READY=PASS phase=install … listeners=none`）。10 轮内没换代就以 73 退出并自动回到恢复前的状态，这时按输出的备份目录人工核对。
- 回到旧门禁后，v0.6.3 的 `verify-release.sh --anonymous-only` 会因为后台登录 401 报 `anonymous_status`（它按新口径期望 200）。这是预期结果：这种状态下别再跑 v0.6.3 的发版核验；下一次发版前要先把 nginx 装回新口径。
- 只回 nginx 不需要开维护：恢复的是更严的旧门禁，不会暴露任何东西。

### 应用回滚到 v0.6.2

**先做上面的"只回 nginx"，再按常规回滚应用**（`SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES` 需 Owner 另批；本版无迁移）。原因：v0.6.2 的 `verify-release.sh` 期望后台登录 401；nginx 不先回，回滚最后一步核验会失败，站点会留在维护状态。

## 五、发版要点

- 数据库迁移、grants、数据字典：无变化。
- 环境变量、compose、任务白名单：无变化。
- 证书、DNS、公开站网址、canonical、hreflang、站点地图、robots：不变（公开网址冻结）。
- 口令文件 `nginx-preprod.htpasswd`、发版核验用的 `preprod-curl.conf`：保留，内容和用法都不变；现在只有后台健康检查接口和监控用到它们（发版核验从来只拿它访问 `/api/health`）。
- 预生产模板 `cps-novel-preprod.conf.template` 未改；预生产模式的核验仍期望后台全程 401。

## 六、待 Owner 决定

1. **HSTS 要不要借这次 sudo 一起提级到 31536000**。原计划 10-14 前后提级，[ADR-PN15](../adr/ADR-PN15-SITE-SEARCH.md) 也写过"与 HSTS 提级同一次安装"。本手册默认**不提**（命令都写 86400）：提级和本单无关，而且回不去（浏览器会缓存一年）。要提，就把第 0、1 步里所有 `86400` 换成 `31536000`，候选变为 18,310 字节、SHA-256 `70fb04fd24c71eb303d1d6bc1b6eed149eff2ff4c71ce86118c433ccb5f02ffe`，验证矩阵里两处 HSTS 期望改成 `max-age=31536000`（不带 includeSubDomains/preload）。
2. **PN-15 搜索限流会随这次一起生效**（同一个模板，拆不开）。不想现在上就得另开单把它从模板里拿掉，不建议：它只给搜索加独立额度，不改网址，也不占读者看书的额度。

## 附录：标识符与对应检查

| 说明 | 标识符 |
| --- | --- |
| 健康检查三路径必须带 Administration 口令域与口令文件 | 候选检查码 `admin_health_auth` |
| 登录页、后台页面、后台接口、静态资源必须直达应用、不带任何 `auth_basic`（含 server 级） | 候选检查码 `admin_console_open` |
| 后台块不得出现 `auth_basic off;` | 候选检查码 `admin_auth_not_disabled`（原有） |
| 后台应用 server 存在、有证书 | 候选检查码 `admin_https_app`（不再要求口令域，口令域改由 `admin_health_auth` 按路径检查） |
| 本单新增的变异 | `verify-public-cutover-mutations.mjs` 里以 `candidate_admin_` / `candidate_route_` / `template_admin_` / `matrix_admin_` / `release_admin_` 开头的 10 条 |
