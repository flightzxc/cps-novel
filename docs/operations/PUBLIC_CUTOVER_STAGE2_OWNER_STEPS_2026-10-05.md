# 第二段准备：Owner 终端命令单（2026-10-05）

状态：A 已执行并复核通过；B/C 待执行。本文件是命令单，完成证据见 [PUBLIC_CUTOVER_EVIDENCE.md](PUBLIC_CUTOVER_EVIDENCE.md)。仅准备和演练，不对外开放。

Codex 已完成无需 sudo 的预检。deploy 无 sudo 缓存，工具执行会话没有可供 Owner 直接输入密码的共享输入界面，因此采用已批准的命令单方式。密码只在你自己的终端 sudo 提示中输入，不发到聊天、不保存。

下面四个代码块依次为公共初始化、A、B、C。Codex 将公共初始化分别拼到 A/B/C 前，生成并上传无秘密的 bash 文件至 `/opt/cps-novel/shared/cutover-stage2-20261005/commands/`；上传后核对 SHA-256。**一次只运行一个块，回传输出并由 Codex 核对通过后再运行下一块。**

当前本机终端下一块入口（A 已通过）：

`ssh -t haiyue-vps 'bash /opt/cps-novel/shared/cutover-stage2-20261005/commands/B.sh'`

B 通过后才将入口的 `B.sh` 换成 `C.sh`。三块都在服务器真实 release 的 bash 会话内执行；每块开头 `sudo -v`，同块复用缓存。若中途退出或缓存失效，按 sudo 提示重新输入；不改 sudoers。

## 公共初始化（自动包含在每个块中）

```bash
#!/usr/bin/env bash
set -euo pipefail
set +x
[[ "$(id -un)" == deploy ]] || { echo 'STAGE2=REFUSED user'; exit 65; }
cd /opt/cps-novel/current
source scripts/preproduction/lib.sh
export PREPROD_ENV_FILE=/opt/cps-novel/shared/env/preprod.env
stage2_manifest=/opt/cps-novel/shared/artifacts/staging/bbb06253828d9fd338f0ece1749c2020d8ec4679.json
preprod_read_release_manifest "$stage2_manifest"
export CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF"
export GIT_COMMIT="$PREPROD_RELEASE_COMMIT" APPROVED_GIT_COMMIT="$PREPROD_RELEASE_COMMIT"
preprod_load_env
[[ "$GIT_COMMIT" == bbb06253828d9fd338f0ece1749c2020d8ec4679 && "$(git rev-parse HEAD)" == "$GIT_COMMIT" ]] || { echo 'STAGE2=REFUSED identity'; exit 65; }
[[ "$(preprod_site_mode)" == preprod ]] || { echo 'STAGE2=REFUSED site_mode'; exit 65; }
preprod_assert_indexnow_gates preprod 0 0
preprod_assert_local_image "$CPS_NOVEL_APP_IMAGE"
preprod_assert_container_image web worker worker-light scheduler
[[ "$(stat -c %a "$PREPROD_CURL_CONFIG")" == 600 ]] || { echo 'STAGE2=REFUSED curl_config_mode'; exit 65; }
stage2_root=/opt/cps-novel/shared/cutover-stage2-20261005
mkdir -p "$stage2_root"
chmod 700 "$stage2_root"
stage2_work="$(mktemp -d "$stage2_root/run.XXXXXXXX")"
stage2_env_sha="$(sha256sum "$PREPROD_ENV_FILE" | cut -d' ' -f1)"
stage2_assert_env() {
  [[ "$(sha256sum "$PREPROD_ENV_FILE" | cut -d' ' -f1)" == "$stage2_env_sha" ]] || { echo 'STAGE2=FAIL env_changed'; return 65; }
}
stage2_probe() {
  local url="$1" expected="$2" auth="${3:-0}" insecure="${4:-0}" code
  local args=(--noproxy '*' --connect-timeout 5 --max-time 20 -sS -o /dev/null -D "$stage2_work/headers" -w '%{http_code}')
  [[ "$auth" == 0 ]] || args+=(--config "$PREPROD_CURL_CONFIG")
  # -k 仅允许检查新域名 bootstrap 的默认 HTTPS 拒绝。
  if [[ "$insecure" == 1 ]]; then
    case "$url" in https://pulsenovels.com/|https://www.pulsenovels.com/|https://zbcwf.pulsenovels.com/) args+=(-k);; *) return 65;; esac
  fi
  code="$(curl "${args[@]}" "$url")" || { echo "STAGE2=FAIL transport url=$url"; return 65; }
  printf 'PROBE=%s auth=%s expected=%s actual=%s\n' "$url" "$auth" "$expected" "$code"
  [[ "$code" == "$expected" ]] || return 65
}
stage2_old_protected() {
  local url
  for url in https://www.bangbangji.cloud/ https://zbcwf.bangbangji.cloud/login; do
    stage2_probe "$url" 401
    grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$stage2_work/headers" || return 65
    stage2_probe "$url" 200 1
    grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$stage2_work/headers" || return 65
  done
}
stage2_new_rejected() {
  local name
  for name in pulsenovels.com www.pulsenovels.com zbcwf.pulsenovels.com; do
    stage2_probe "http://$name/" 404
    stage2_probe "https://$name/" 404 0 1
  done
}
preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF (SELECT count(*) FROM channel_account_credential WHERE status='active') <> 1 THEN RAISE EXCEPTION 'ACTIVE_CREDENTIAL_GATE=FAIL'; END IF;
 IF NOT EXISTS (SELECT 1 FROM generic_task WHERE id='eba8f359-a569-43d7-bb55-b71fecc02f6e' AND status='paused') THEN RAISE EXCEPTION 'BATCH_GATE=FAIL'; END IF;
 IF EXISTS (SELECT 1 FROM generic_task_item i JOIN generic_task t ON t.id=i.task_id WHERE t.task_type='tagging.auto_classify' AND i.status IN ('pending','processing')) THEN RAISE EXCEPTION 'TAGGING_GATE=FAIL'; END IF;
 IF EXISTS (SELECT 1 FROM generic_task WHERE task_type='promo_link.claim.v1' AND status IN ('pending','processing')) THEN RAISE EXCEPTION 'CLAIM_GATE=FAIL'; END IF;
END $$;
ROLLBACK;
SQL
sudo -v
```

## A：证书引导、签发、续期

做什么：只开放三个新名字的 HTTP ACME 入口，签发三名 SAN；保持旧站保护、新站普通路径拒绝。DNS 仅复核，不改解析，不处理 GSC TXT。

预期：DNS 指向 `2.24.209.236`，ACME 探针正确；签发和续期 dry-run 成功、timer active、SAN 恰为三个名字；最终 `STAGE2_CERTIFICATE=PASS`。

失败：非零退出、错误状态码、SAN 不符或续期失败均停止。安装器处理自身失败；安装成功后的验收失败由下面的 trap 使用该次 `NGINX_BACKUP` 恢复 nginx，并清理探针。已经签发的证书可以保留，不撤销证书、不改私钥。

13:39 首次 A 安装成功后，立即请求 ACME 得到 curl 52，已成功回退，未进入 certbot。服务器 reload 使用 `nginx -s reload`；可能存在检查先于新 worker 就绪的竞态，尚非唯一确证原因。本版最多等待 10 次，每次请求最多 3 秒、间隔 1 秒。只接受 HTTP 200 且探针正文逐字相同；只对空连接、连接失败/超时及 404 重试，其他状态或错误正文立即失败。耗尽后记录配置哈希、主机匹配和权限诊断，再由原 trap 回退。

```bash
stage2_backup=''
stage2_ok=0
stage2_finish() {
  local status=$?
  trap - EXIT INT TERM
  if ! sudo rm -f /var/lib/letsencrypt/.well-known/acme-challenge/cutover-stage2-probe; then status=71; fi
  if [[ "$stage2_ok" != 1 && -n "$stage2_backup" ]]; then
    if PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --restore-backup "$stage2_backup"; then
      echo 'STAGE2_ROLLBACK=PASS block=A'
    else status=71; echo 'STAGE2_ROLLBACK=FAIL block=A'; fi
  fi
  exit "$status"
}
trap stage2_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for resolver in 8.8.8.8 1.1.1.1 lunar.dns-parking.com solar.dns-parking.com; do
  for name in pulsenovels.com www.pulsenovels.com zbcwf.pulsenovels.com; do
    answer="$(dig +time=3 +tries=2 +short "@$resolver" "$name" A)"
    printf 'DNS=%s %s %s\n' "$resolver" "$name" "$answer"
    [[ "$(printf '%s\n' "$answer" | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/')" == 2.24.209.236 ]] || exit 65
    aaaa="$(dig +time=3 +tries=2 +short "@$resolver" "$name" AAAA)"
    if printf '%s\n' "$aaaa" | grep -q ':'; then echo 'STAGE2=REFUSED unexpected_AAAA'; exit 65; fi
  done
done
sudo mkdir -p /var/lib/letsencrypt/.well-known/acme-challenge
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --bootstrap-public | tee "$stage2_work/install.log"
stage2_backup="$(sed -n 's/^NGINX_BACKUP=//p' "$stage2_work/install.log")"
[[ -n "$stage2_backup" && "$stage2_backup" != *$'\n'* ]] || exit 65
printf 'haiyue-stage2-acme-probe\n' | sudo tee /var/lib/letsencrypt/.well-known/acme-challenge/cutover-stage2-probe >/dev/null
stage2_acme_probe() {
  local name="$1" attempt code curl_status body
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    curl_status=0
    code="$(curl -q --noproxy '*' --connect-timeout 2 --max-time 3 -sS -o "$stage2_work/acme.body" -D "$stage2_work/acme.headers" -w '%{http_code}' "http://$name/.well-known/acme-challenge/cutover-stage2-probe" 2>"$stage2_work/acme.error")" || curl_status=$?
    printf 'ACME_ATTEMPT=%s host=%s http=%s curl_exit=%s\n' "$attempt" "$name" "$code" "$curl_status"
    if [[ "$curl_status" == 0 && "$code" == 200 ]]; then
      body="$(cat "$stage2_work/acme.body")"
      [[ "$body" == haiyue-stage2-acme-probe ]] || { echo 'ACME_PROBE=FAIL reason=unexpected_body'; return 65; }
      printf 'ACME_PROBE=%s PASS\n' "$name"
      return 0
    fi
    case "$curl_status:$code" in
      0:404|52:000|7:000|28:000) ;;
      *) echo 'ACME_PROBE=FAIL reason=unexpected_response'; return 65 ;;
    esac
    if [[ "$attempt" != 10 ]]; then sleep 1; fi
  done
  echo 'ACME_PROBE=FAIL reason=readiness_timeout'
  sudo sha256sum /etc/nginx/conf.d/cps-novel-public-bootstrap.conf
  sudo namei -l /var/lib/letsencrypt/.well-known/acme-challenge/cutover-stage2-probe
  sudo nginx -T 2>"$stage2_work/nginx-check.error" | awk '/^# configuration file/ || /^[[:space:]]*(listen|server_name)[[:space:]]/ || /^[[:space:]]*location.*acme-challenge/ {print}'
  return 65
}
for name in pulsenovels.com www.pulsenovels.com zbcwf.pulsenovels.com; do stage2_acme_probe "$name"; done
stage2_new_rejected
stage2_old_protected
sudo certbot certonly --webroot -w /var/lib/letsencrypt --cert-name pulsenovels.com -d pulsenovels.com -d www.pulsenovels.com -d zbcwf.pulsenovels.com
sudo certbot renew --cert-name pulsenovels.com --dry-run
sudo systemctl is-active --quiet certbot.timer
cert_info="$(sudo openssl x509 -in /etc/letsencrypt/live/pulsenovels.com/fullchain.pem -noout -dates -ext subjectAltName)"
printf '%s\n' "$cert_info"
printf '%s' "$cert_info" | node -e 'let t="";process.stdin.on("data",d=>t+=d);process.stdin.on("end",()=>{const actual=[...t.matchAll(/DNS:([^,\s]+)/g)].map(x=>x[1]).sort();const expected=["pulsenovels.com","www.pulsenovels.com","zbcwf.pulsenovels.com"].sort();if(JSON.stringify(actual)!==JSON.stringify(expected))process.exit(65);console.log("CERT_SAN=PASS");});'
stage2_new_rejected
stage2_old_protected
stage2_assert_env
sudo rm -f /var/lib/letsencrypt/.well-known/acme-challenge/cutover-stage2-probe
printf '%s\n' "$GIT_COMMIT" > "$stage2_root/certificate.pass"
stage2_ok=1
printf 'STAGE2_CERTIFICATE=PASS backup=%s logdir=%s\n' "$stage2_backup" "$stage2_work"
```

## B：旧域名 rehearsal 与容量读回

前提：A 输出已经回传并由 Codex 确认通过。做什么：只安装 rehearsal，运行完整发布验证及独立匿名复验、主机隔离和缓存/压缩检查，读回并断言七项数据库参数。

预期：两个 `RELEASE_VERIFY=PASS`、`CAPACITY=PASS`、旧域名匿名 401/认证 200 且 noindex、新域名普通路径 404；最终 `STAGE2_REHEARSAL=PASS`。任何失败使用 B 自己的安装器备份恢复到执行 B 前的状态；保留 A 的证书引导。

```bash
[[ "$(cat "$stage2_root/certificate.pass")" == "$GIT_COMMIT" ]] || exit 65
stage2_backup=''
stage2_ok=0
stage2_finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$stage2_ok" != 1 && -n "$stage2_backup" ]]; then
    if PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --restore-backup "$stage2_backup"; then
      echo 'STAGE2_ROLLBACK=PASS block=B'
    else status=71; echo 'STAGE2_ROLLBACK=FAIL block=B'; fi
  fi
  exit "$status"
}
trap stage2_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PREPROD_OWNER_SUDO_APPROVED=YES scripts/preproduction/install-nginx.sh --mode rehearsal | tee "$stage2_work/install.log"
stage2_backup="$(sed -n 's/^NGINX_BACKUP=//p' "$stage2_work/install.log")"
[[ -n "$stage2_backup" && "$stage2_backup" != *$'\n'* ]] || exit 65
scripts/preproduction/verify-release.sh </dev/null
scripts/preproduction/verify-release.sh --anonymous-only --expect-live </dev/null
stage2_old_protected
stage2_new_rejected
stage2_probe https://www.bangbangji.cloud/dashboard 404
stage2_probe https://www.bangbangji.cloud/api/health/worker 404
stage2_probe https://www.bangbangji.cloud/api/health/backup 404
stage2_probe https://zbcwf.bangbangji.cloud/ 404
for endpoint in worker backup; do stage2_probe "https://zbcwf.bangbangji.cloud/api/health/$endpoint" 200 1; done
static_path="$(curl --noproxy '*' --connect-timeout 5 --max-time 20 --fail -sS --config "$PREPROD_CURL_CONFIG" https://www.bangbangji.cloud/ | node -e 'let t="";process.stdin.on("data",d=>t+=d);process.stdin.on("end",()=>{const m=t.match(/\/_next\/static\/[^"<>\s]+\.(?:js|css)/);if(!m)process.exit(65);console.log(m[0]);});')"
stage2_probe "https://www.bangbangji.cloud$static_path" 200 1
grep -qi '^Cache-Control:.*max-age=31536000.*immutable' "$stage2_work/headers" || exit 65
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$stage2_work/headers" || exit 65
curl --noproxy '*' --connect-timeout 5 --max-time 20 --fail --compressed --config "$PREPROD_CURL_CONFIG" -sS -D "$stage2_work/compressed.headers" -o /dev/null "https://www.bangbangji.cloud$static_path"
grep -qi '^Content-Encoding: gzip' "$stage2_work/compressed.headers" || exit 65
preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections','effective_io_concurrency','random_page_cost') ORDER BY name;
DO $$ BEGIN
 IF pg_size_bytes(current_setting('shared_buffers')) <> 4294967296
 OR pg_size_bytes(current_setting('effective_cache_size')) <> 10737418240
 OR pg_size_bytes(current_setting('work_mem')) <> 16777216
 OR pg_size_bytes(current_setting('maintenance_work_mem')) <> 536870912
 OR current_setting('max_connections')::int <> 100
 OR current_setting('effective_io_concurrency')::int <> 200
 OR current_setting('random_page_cost')::numeric <> 1.1
 THEN RAISE EXCEPTION 'CAPACITY=FAIL'; END IF;
END $$;
SELECT 'CAPACITY=PASS';
ROLLBACK;
SQL
stage2_assert_env
printf '%s\n' "$GIT_COMMIT" > "$stage2_root/rehearsal.pass"
stage2_ok=1
printf 'STAGE2_REHEARSAL=PASS backup=%s logdir=%s\n' "$stage2_backup" "$stage2_work"
```

## C：worker_connections 与最近备份

前提：B 输出已经回传并由 Codex 确认通过。预期：唯一生效连接数 768 → 4096，nginx 检查和 reload 成功；最新备份三件非空、SHA-256 和目录读取通过，最终 `STAGE2_CONNECTIONS_BACKUP=PASS`。

原值不是 768 则不改。此块主配置按 Owner 已确认的例外使用独立备份；任意后续失败恢复该主配置、检查并 reload。站点配置不手工覆盖，rehearsal 保留。若回退也失败，停止并保留全部备份。

```bash
[[ "$(cat "$stage2_root/rehearsal.pass")" == "$GIT_COMMIT" ]] || exit 65
original_values="$(sudo nginx -T 2>/dev/null | awk '/^[[:space:]]*worker_connections/ {print $2}')"
printf 'WORKER_CONNECTIONS_BEFORE=%s\n' "$original_values"
[[ "$original_values" == '768;' ]] || { echo 'STAGE2=REFUSED original_not_768'; exit 65; }
[[ "$(sudo awk '/^[[:space:]]*worker_connections/ {print $2}' /etc/nginx/nginx.conf)" == '768;' ]] || exit 65
stage2_main_backup="/etc/nginx/nginx.conf.before-stage2-$(date -u +%Y%m%dT%H%M%SZ).$$"
sudo test ! -e "$stage2_main_backup"
sudo cp -a /etc/nginx/nginx.conf "$stage2_main_backup"
stage2_main_sha="$(sudo sha256sum "$stage2_main_backup" | cut -d' ' -f1)"
stage2_site_sha="$(sha256sum /etc/nginx/conf.d/cps-novel-preprod.conf | cut -d' ' -f1)"
stage2_mutated=0
stage2_ok=0
stage2_finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$stage2_ok" != 1 && "$stage2_mutated" == 1 ]]; then
    if sudo cp -a "$stage2_main_backup" /etc/nginx/nginx.conf && sudo nginx -t && sudo systemctl reload nginx && [[ "$(sudo sha256sum /etc/nginx/nginx.conf | cut -d' ' -f1)" == "$stage2_main_sha" ]]; then
      echo 'STAGE2_ROLLBACK=PASS block=C'
    else status=71; echo 'STAGE2_ROLLBACK=FAIL block=C'; fi
  fi
  exit "$status"
}
trap stage2_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage2_mutated=1
sudo sed -i 's/^[[:space:]]*worker_connections[[:space:]]*768[[:space:]]*;/    worker_connections 4096;/' /etc/nginx/nginx.conf
[[ "$(sudo nginx -T 2>/dev/null | awk '/^[[:space:]]*worker_connections/ {print $2}')" == '4096;' ]] || exit 65
sudo nginx -t
sudo systemctl reload nginx
printf 'MAIN_CONFIG_BACKUP=%s\nWORKER_CONNECTIONS_AFTER=4096\n' "$stage2_main_backup"
[[ "$(sha256sum /etc/nginx/conf.d/cps-novel-preprod.conf | cut -d' ' -f1)" == "$stage2_site_sha" ]] || exit 65
stage2_dump="$(find /opt/cps-novel/shared/backups/logical -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
[[ -n "$stage2_dump" ]] || exit 65
for file in "$stage2_dump" "$stage2_dump.metadata" "$stage2_dump.sha256"; do
  sudo test -s "$file"
  sudo stat -c '%y %s bytes mode=%a owner=%U %n' "$file"
done
sudo sed -n '/^created_at=/p; /^size_bytes=/p; /^sha256=/p' "$stage2_dump.metadata"
sudo sh -c 'cd "$1" && sha256sum -c "$2"' sh "$(dirname "$stage2_dump")" "$(basename "$stage2_dump").sha256"
preprod_compose exec -T backup-timer pg_restore --list "/var/lib/cps-novel/backups/logical/$(basename "$stage2_dump")" >/dev/null
stage2_old_protected
stage2_new_rejected
stage2_assert_env
stage2_ok=1
printf 'STAGE2_CONNECTIONS_BACKUP=PASS backup=%s dump=%s logdir=%s\n' "$stage2_main_backup" "$stage2_dump" "$stage2_work"
```

## 接续与未解决事项

- 三块通过后，Codex 才从本机进行旧域名 HTTPS 压测。本机直连未恢复就暂停，不用服务器本机或 SSH 隧道替代。
- Docker 可用后，Codex 在隔离测试容器运行原 `verify-nginx-matrix.sh`。未取得 `NGINX_MATRIX_ALL=PASS` 就记为待验收；矩阵的 public 模式不安装到 VPS。
- 新凭据缺续期后的 worker 校验记录，独立签发来源及 X8 到期时间排重证据也待 Owner 提供。本命令单不会入队校验或访问 X8。
- 本机最新备份三件的存在性已只读确认；C 才补充 root 文件的散列和目录读取验收。NAS 成功拉取仍须日志或 Owner 确认。恢复演练暂缓，可恢复性未经实测。
- 不改站点地址，不安装 VPS public 模式，不移除密码/noindex，不开 IndexNow，不恢复批次，不调模板参数。
