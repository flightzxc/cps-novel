#!/usr/bin/env bash
set -euo pipefail
set +x

# NAS 异地备份受限只读钥匙 (2026-09-28)：端到端真实演练。
#
# 起两个一次性容器,在 Owner 自己的机器上模拟真实拓扑,证明
# scripts/preproduction/offsite-readonly-gate.sh + offsite-pull.sh --gate
# 这条新链路真的比旧的"deploy 全量 ssh 钥匙"窄:
#   - "gate-rehearsal-sshd-<pid>":装了 openssh-server + docker CLI 的 Alpine
#     容器,挂了宿主机的 docker socket (模拟"deploy 有 docker 权限"这件事本身
#     ——不是模拟 deploy 的完整 ssh 钥匙,而是它能调用 docker 这一层),
#     authorized_keys 里只放这一把新生成的专用钥匙,`restrict,command=...`
#     指向本仓库的 offsite-readonly-gate.sh。
#   - "cps-novel-backup-timer-rehearsal-<pid>":用命名卷承载 root:root 0600
#     的真实 pg_dump 三件套 (.dump/.sha256/.metadata),以非 root UID 运行,
#     模拟生产里 backup-timer/web 的权限现实 (deploy 直接 ssh 读不到,必须
#     `docker exec -u 0`)。
#
# 三个断言 (对应 Owner 交付要求的 ①②③):
#   ① offsite-pull.sh --gate 通过这把新钥匙完整拉取、本地校验、生成
#      SHA256SUMS,得到 OFFSITE_PULL=PASS。
#   ② 用同一把钥匙尝试 `docker ps`、`cat /etc/passwd`、端口转发、交互式
#      shell,全部被 `restrict,command=` 挡住 (非零退出,`docker
#      ps`/`/etc/passwd` 的输出从未泄露;端口转发从未真正打通)。
#   ③ 拉回的目录原样交给 restore-offhost-rehearsal.sh,得到
#      OFFHOST_RESTORE=PASS —— 证明这条更窄的传输路径产出的文件,与旧的
#      "deploy 全量钥匙 + 直接 docker exec"路径产出的文件,对下游恢复流程
#      而言是等价的。
#
# 不改动、不连接 haiyue-vps；只用本机 Docker。运行完自动清理全部容器/卷/临时
# 文件——不留手动清理步骤。

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-offsite-gate-rehearsal.XXXXXX")"
id="cps-offsite-gate-$$"
sshd_container="gate-rehearsal-sshd-$$"
backup_container="cps-novel-backup-timer-rehearsal-$$"
backup_volume="${id}-backups"
pg_source_container="${id}-pg-source"
pg_source_volume="${pg_source_container}-data"
fwd_pid=""

cleanup() {
  if [[ -n "$fwd_pid" ]]; then kill "$fwd_pid" >/dev/null 2>&1 || true; wait "$fwd_pid" 2>/dev/null || true; fi
  docker rm -f "$sshd_container" >/dev/null 2>&1 || true
  docker rm -f "$backup_container" >/dev/null 2>&1 || true
  docker rm -f "$pg_source_container" >/dev/null 2>&1 || true
  docker volume rm "$backup_volume" >/dev/null 2>&1 || true
  docker volume rm "$pg_source_volume" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

# macOS 默认不带 GNU coreutils 的 `timeout` (`gtimeout` 也未必装了),用一个
# 纯 bash 的等价物:后台跑目标命令,另起一个"看门狗"子进程在 N 秒后把它杀掉,
# 两者哪个先完成都清理干净。只在"万一 restrict 没生效导致挂住"时兜底 -- 正常
# 路径下目标命令应该在拒绝后几乎立刻自己退出。
with_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs"; kill "$cmd_pid" >/dev/null 2>&1 || true ) &
  local watchdog_pid=$!
  local status=0
  wait "$cmd_pid" || status=$?
  kill "$watchdog_pid" >/dev/null 2>&1 || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$status"
}

echo "== 0) 生成 NAS 专用只读钥匙 (ed25519) ==" >&2
ssh-keygen -t ed25519 -N '' -f "$tmp/nas_key" -C ugreen-nas-offsite-rehearsal >/dev/null

echo "== 1) 起一次性 postgres,产出一份真实的 pg_dump 逻辑备份三件套 ==" >&2
mkdir -p "$tmp/evidence" "$tmp/nas-local"
admin_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
printf '127.0.0.1:5432:cps_novel:backup_role:%s\n' "$backup_password" >"$tmp/evidence/backup.pgpass"
chmod 600 "$tmp/evidence/backup.pgpass"
docker volume create "$pg_source_volume" >/dev/null
docker run -d --name "$pg_source_container" -e POSTGRES_PASSWORD="$admin_password" -e POSTGRES_DB=cps_novel \
  -v "$pg_source_volume:/var/lib/postgresql/data" \
  -v "$root/scripts/db/backup-logical.sh:/opt/backup-logical.sh:ro" \
  -v "$tmp/evidence:/evidence" postgres:16.14 >/dev/null
for _ in {1..120}; do docker exec "$pg_source_container" pg_isready -U postgres -d cps_novel >/dev/null 2>&1 && break; sleep 0.5; done
docker exec "$pg_source_container" pg_isready -U postgres -d cps_novel >/dev/null
docker exec -i -e PGPASSWORD="$admin_password" "$pg_source_container" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  -v backup_password="$backup_password" <<'SQL' >/dev/null
CREATE TABLE "_prisma_migrations" (finished_at timestamptz);
INSERT INTO "_prisma_migrations" VALUES (now());
CREATE ROLE backup_role LOGIN PASSWORD :'backup_password';
GRANT CONNECT ON DATABASE cps_novel TO backup_role;
GRANT USAGE ON SCHEMA public TO backup_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_role;
SQL

new_name="cps-novel-gate-rehearsal-new.dump"
old_name="cps-novel-gate-rehearsal-old.dump"
inprogress_name="cps-novel-gate-rehearsal-inprogress.dump"
docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=cps_novel -e PGUSER=backup_role \
  -e PGPASSFILE=/evidence/backup.pgpass "$pg_source_container" \
  /bin/bash /opt/backup-logical.sh --output "/evidence/$new_name" >/dev/null

echo "== 2) 把三件套按生产权限现实 (root:root 0600) 放进命名卷,充当 backup-timer 的备份目录 ==" >&2
# 同一份合法 pg_dump 字节复制出一份"更旧"的 (.metadata mtime 更早) 和一份
# "写入中" (只有 .dump,没有两个 sidecar) —— 验证 list 的完成态判定与
# mtime 排序在真实 ssh + docker exec 链路上也成立,不只是单元测试里的桩。
docker volume create "$backup_volume" >/dev/null
docker run --rm -u 0 -v "$backup_volume:/data" -v "$tmp/evidence:/evidence:ro" postgres:16.14 sh -c "
set -eu
cp /evidence/$new_name /data/$new_name
cp /evidence/$new_name.sha256 /data/$new_name.sha256
cp /evidence/$new_name.metadata /data/$new_name.metadata
cp /data/$new_name /data/$old_name
sed 's/$new_name/$old_name/' /data/$new_name.sha256 >/data/$old_name.sha256
cp /data/$new_name.metadata /data/$old_name.metadata
cp /data/$new_name /data/$inprogress_name
chown -R 0:0 /data
chmod 0600 /data/*
touch -d '2026-09-01T00:00:00' /data/$old_name.metadata
touch -d '2026-09-02T00:00:00' /data/$new_name.metadata
"

echo "== 3) 起长期运行的 fake backup-timer 容器 (非 root UID,证明 gate 必须用 -u 0) ==" >&2
docker run -d --name "$backup_container" -u 1001:1001 \
  -v "$backup_volume:/var/lib/cps-novel/backups/logical" \
  --entrypoint sleep postgres:16.14 infinity >/dev/null
docker exec "$backup_container" sh -c 'cat /var/lib/cps-novel/backups/logical/*.dump >/dev/null' >/dev/null 2>&1 \
  && { echo "REHEARSAL=FAIL reason=fixture_readable_without_dash_u0_this_invalidates_the_rehearsal"; exit 1; }
echo "确认: 非 root UID 直接读备份文件被拒 (Permission denied) -- 与生产现实一致" >&2

echo "== 4) 起装了 sshd 的一次性容器,挂宿主机 docker socket + 本仓库 scripts/preproduction (只读) ==" >&2
cat >"$tmp/sshd-init.sh" <<'INIT'
set -eu
apk add --no-cache openssh-server docker-cli bash coreutils grep sed >/tmp/apk.log 2>&1
ssh-keygen -A >/dev/null 2>&1
addgroup -g 2000 deploy 2>/dev/null || true
adduser -D -h /home/deploy -s /bin/bash -G deploy deploy 2>/dev/null || true
# `adduser -D` 在 /etc/shadow 里把密码字段设成 `!` (锁定)。OpenSSH 即使只走
# pubkey 认证，也会在 pubkey 校验之前先检查目标账号是不是"locked"，锁定账号
# 一律拒绝 (与是否配了公钥无关) —— 排查过程中真实见过
# "User deploy not allowed because account is locked" / "invalid user deploy"
# 这条 server 端日志。把密码字段从 `!` 改成 `*` 就解锁了 (`*` 本身永远不会
# 匹配任何密码哈希，所以密码登录依旧不可能，只是不再是 sshd 眼里的"locked"
# 账号) —— 这台容器没装 shadow 包，没有 usermod/passwd -p，直接 sed
# /etc/shadow 最简单。
sed -i 's/^deploy:!:/deploy:*:/' /etc/shadow
# socket 在宿主机上是 root:root 660 —— 把 deploy 也加进 gid 0 (root 组),
# 靠组权限拿到读写权，不去动宿主机那个 bind-mount 过来的 socket 文件本身
# 的权限位 (chmod 它会真的改到宿主机上，演练完也未必能可靠复原)。
addgroup deploy root 2>/dev/null || true
mkdir -p /home/deploy/.ssh
printf 'restrict,command="/gate/scripts/preproduction/offsite-readonly-gate.sh" %s\n' \
  "$(cat /keys/nas_key.pub)" >/home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
{
  echo "PasswordAuthentication no"
  echo "PubkeyAuthentication yes"
  echo "PermitRootLogin no"
  echo "AuthorizedKeysFile .ssh/authorized_keys"
} >>/etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e
INIT
docker run -d --name "$sshd_container" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$root/scripts/preproduction:/gate/scripts/preproduction:ro" \
  -v "$tmp/sshd-init.sh:/sshd-init.sh:ro" \
  -v "$tmp/nas_key.pub:/keys/nas_key.pub:ro" \
  -p 127.0.0.1::22 \
  alpine:3.20 sh /sshd-init.sh >/dev/null

port=""
for _ in {1..60}; do
  port="$(docker port "$sshd_container" 22/tcp 2>/dev/null | head -1 | awk -F: '{print $2}')"
  if [[ -n "$port" ]]; then break; fi
  sleep 0.5
done
if ! [[ -n "$port" ]]; then echo "REHEARSAL=FAIL reason=sshd_port_not_published"; exit 1; fi
ssh_opts=(-p "$port" -i "$tmp/nas_key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=5)
for _ in {1..60}; do
  ssh "${ssh_opts[@]}" deploy@127.0.0.1 list >/dev/null 2>&1 && break
  sleep 0.5
done

echo "== ① offsite-pull.sh --gate：完整拉取 + 本地校验 + SHA256SUMS ==" >&2
gate_ssh_opts="-p $port -i $tmp/nas_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=5"
pull_output="$(OFFSITE_PULL_SSH_OPTS="$gate_ssh_opts" "$root/scripts/preproduction/offsite-pull.sh" \
  --gate --remote-host "deploy@127.0.0.1" --local-dir "$tmp/nas-local" --keep 5)"
echo "$pull_output"
printf '%s\n' "$pull_output" | grep -q '^OFFSITE_PULL=PASS ' || { echo "REHEARSAL_STEP1=FAIL"; exit 1; }
pulled_file="$(printf '%s\n' "$pull_output" | sed -n 's/.*file=\([^ ]*\).*/\1/p')"
if ! [[ "$pulled_file" == "$new_name" ]]; then
  echo "REHEARSAL_STEP1=FAIL reason=wrong_backup_selected expected=$new_name actual=$pulled_file"
  exit 1
fi
if [[ -e "$tmp/nas-local/$inprogress_name" ]]; then
  echo "REHEARSAL_STEP1=FAIL reason=inprogress_backup_leaked"
  exit 1
fi
echo "REHEARSAL_STEP1=PASS file=$pulled_file"

echo "== ② 同一把钥匙尝试越权操作，逐条验证被拒 ==" >&2
denied=1
ssh "${ssh_opts[@]}" deploy@127.0.0.1 'docker ps' >"$tmp/deny-dockerps.out" 2>"$tmp/deny-dockerps.err" && denied=0
if [[ "$denied" -eq 0 ]]; then echo "REHEARSAL_STEP2=FAIL reason=docker_ps_not_denied"; exit 1; fi
if [[ -s "$tmp/deny-dockerps.out" ]]; then echo "REHEARSAL_STEP2=FAIL reason=docker_ps_output_leaked"; exit 1; fi
echo "docker ps -> 拒绝 (exit!=0, 无输出泄露): OK" >&2

denied=1
ssh "${ssh_opts[@]}" deploy@127.0.0.1 'cat /etc/passwd' >"$tmp/deny-passwd.out" 2>"$tmp/deny-passwd.err" && denied=0
if [[ "$denied" -eq 0 ]]; then echo "REHEARSAL_STEP2=FAIL reason=cat_passwd_not_denied"; exit 1; fi
if grep -q 'root:' "$tmp/deny-passwd.out" 2>/dev/null; then echo "REHEARSAL_STEP2=FAIL reason=cat_passwd_content_leaked"; exit 1; fi
echo "cat /etc/passwd -> 拒绝 (exit!=0, 内容未泄露): OK" >&2

with_timeout 6 ssh -N -L 19919:127.0.0.1:80 "${ssh_opts[@]}" deploy@127.0.0.1 >"$tmp/fwd.log" 2>&1 &
fwd_pid=$!
sleep 2
fwd_worked=0
curl -s -m 2 -o /dev/null http://127.0.0.1:19919/ >/dev/null 2>&1 && fwd_worked=1
kill "$fwd_pid" >/dev/null 2>&1 || true
wait "$fwd_pid" 2>/dev/null || true
fwd_pid=""
if [[ "$fwd_worked" -eq 1 ]]; then echo "REHEARSAL_STEP2=FAIL reason=port_forward_not_denied"; exit 1; fi
echo "端口转发 (-L) -> restrict 挡住，转发从未真正打通: OK" >&2

denied=1
with_timeout 6 ssh "${ssh_opts[@]}" deploy@127.0.0.1 </dev/null >"$tmp/deny-shell.out" 2>"$tmp/deny-shell.err" && denied=0
if [[ "$denied" -eq 0 ]]; then echo "REHEARSAL_STEP2=FAIL reason=interactive_shell_not_denied"; exit 1; fi
echo "交互式 shell (无命令) -> 走 forced command，空 SSH_ORIGINAL_COMMAND 被拒: OK" >&2
echo "REHEARSAL_STEP2=PASS"

echo "== ③ 拉回目录交给 restore-offhost-rehearsal.sh ==" >&2
restore_output="$(OFFHOST_COPY_CONFIRMED=YES "$root/scripts/preproduction/restore-offhost-rehearsal.sh" \
  --offhost-dir "$tmp/nas-local" \
  --dump "$tmp/nas-local/$pulled_file" \
  --manifest "$tmp/nas-local/SHA256SUMS")"
echo "$restore_output"
printf '%s\n' "$restore_output" | grep -qx 'OFFHOST_RESTORE=PASS source=EXPORTED_COPY isolation=DISPOSABLE' \
  || { echo "REHEARSAL_STEP3=FAIL"; exit 1; }
echo "REHEARSAL_STEP3=PASS"

echo "OFFSITE_GATE_REHEARSAL=PASS"
