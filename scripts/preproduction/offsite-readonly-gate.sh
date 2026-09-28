#!/usr/bin/env bash
set -euo pipefail
set +x

# NAS 异地备份:受限只读钥匙的服务器侧入口 (2026-09-28)。
#
# 背景:scripts/preproduction/offsite-pull.sh 原本要求调用方持有 `deploy`
# 用户的 ssh 私钥,而 `deploy`在 docker 组里 —— 能 `docker exec -u 0` 进任意
# 容器,等价于宿主机 root。把这把钥匙原样交给放在家里的绿联 NAS,NAS 一旦被
# 攻破就等于生产被攻破。这个脚本就是补上的"受限入口":authorized_keys 里给
# NAS 单独配一把新钥匙,`command="<这个脚本的绝对路径>"` 把它锁死成只能跑这
# 一个脚本 (forced command),脚本自己再把 ssh 客户端能表达的操作收窄到恰好
# 两个只读动作 —— 别的一律拒绝、非零退出。
#
# 🔴 安全模型的关键点:
#   1. sshd 的 `command=` 会把这个脚本自己的 argv 换成 authorized_keys 里写
#      死的那一条 (这里就是"不带参数运行这个脚本"),客户端真正想跑的命令改
#      放进 SSH_ORIGINAL_COMMAND 这个环境变量。脚本只读这一个变量,从不读
#      argv、从不 eval、从不把它交给 `sh -c`/`ssh ... <<HEREDOC` 之类的东西
#      当脚本执行 —— 对照:offsite-pull.sh 旧版走 `docker exec ... sh -s`,
#      从 stdin 喂一段脚本进容器当 root 执行;这把钥匙丢了,拿到它的人就能在
#      容器里以 root 跑任意命令。这个入口脚本永不做这件事:唯一一次
#      `docker exec ... sh -s --` 调用,喂给它的是这个文件里写死的 heredoc
#      (REMOTE_LISTING_SCRIPT,见下),不是任何来自网络的字节。
#   2. 只认两个动作,字符串精确匹配,不做前缀/通配:
#        list          -> 列出当前"已完成"的备份 (文件名/大小/mtime/sha256)
#        get <文件名>  -> 把该文件的字节原样吐到 stdout
#      其余任何输入 (空命令、多余参数、未知动作、换行注入、shell 元字符)
#      一律 deny(),退出码 77,不执行任何 docker/文件操作。
#   3. `get` 的文件名必须同时满足:匹配 `^cps-novel-[A-Za-z0-9._-]+\.dump
#      (\.metadata|\.sha256)?$`、不含 `/`、不含 `..`、且出现在"当前 list 结果
#      "里 (不是"文件名长得像"就放行 —— 必须是这一刻真实存在且已完成的备份
#      之一)。四层校验分别独立生效,任何一层没过都拒绝。
#   4. 远端目录、要 exec 进去的容器名,都是脚本内部写死的默认值,只能通过
#      "部署这个脚本的人"自己设的环境变量覆盖 (给单元测试和未来改路径用的
#      旋钮) —— ssh 客户端 (也就是 NAS 那端) 的 SSH_ORIGINAL_COMMAND 永远碰
#      不到这两个变量,不存在"客户端传目录名"这个输入通道。容器名的查找方式
#      沿用 offsite-pull.sh 现有逻辑 (`docker ps --filter name=... --format
#      '{{.Names}}' | head -1`,只列运行中的容器),同样不接受外部传入。
#   5. "已完成"的判定与 offsite-pull.sh 完全一致:scripts/db/backup-logical.sh
#      按 pg_dump -> pg_restore --list 校验 -> 写 .sha256 -> 写 .metadata 的
#      顺序产出一份备份,所以一个 .dump 的 .sha256 与 .metadata 两个 sidecar
#      同时存在才算"已完成";只有 .dump 没有 sidecar 的视为"写入中",list 里
#      不出现,get 也拒绝 (因为不在 list 结果里)。
#   6. 每次调用都写审计日志 (动作 + 结果,不含文件内容),优先 syslog
#      (`logger`),同时尽力追加到本地日志文件;两者都失败也不能让 gate 本身
#      跟着失败 (审计失败不该变成新的拒绝服务面)。
#
# authorized_keys 里怎么配这把钥匙、为什么用 `restrict`,见
# docs/operations/OFFSITE_BACKUP_UGREEN_NAS.md。
#
# 环境变量 (只给部署者/测试用,ssh 客户端到不了):
#   OFFSITE_READONLY_GATE_REMOTE_DIR       默认 /var/lib/cps-novel/backups/logical
#     (容器内部路径,与 offsite-pull.sh --remote-dir 的默认值一致)
#   OFFSITE_READONLY_GATE_CONTAINER_FILTER 默认 cps-novel-backup-timer
#   OFFSITE_READONLY_GATE_LOG_FILE         默认 /opt/cps-novel/shared/logs/offsite-readonly-gate.log

remote_dir="${OFFSITE_READONLY_GATE_REMOTE_DIR:-/var/lib/cps-novel/backups/logical}"
container_filter="${OFFSITE_READONLY_GATE_CONTAINER_FILTER:-cps-novel-backup-timer}"
log_file="${OFFSITE_READONLY_GATE_LOG_FILE:-/opt/cps-novel/shared/logs/offsite-readonly-gate.log}"

# 文件名必须整串匹配 (^...$),不能含 `/`、不能含 `..` —— 后两条是正则本身
# 允许的字符集之外的额外防线 (字符集里本来就没有 `/`;`..` 理论上不足以在
# 没有 `/` 的情况下穿越目录,但按要求仍独立拒绝,双保险)。
filename_re='^cps-novel-[A-Za-z0-9._-]+\.dump(\.metadata|\.sha256)?$'

action_for_log="(unset)"

log() {
  # $1=action $2=result $3=detail(可省)。只记动作与结果,不记文件字节内容。
  local line
  line="$(date -u +'%Y-%m-%dT%H:%M:%SZ') pid=$$ user=${USER:-unknown} action=$1 result=$2 detail=${3:-}"
  if command -v logger >/dev/null 2>&1; then
    logger -t offsite-readonly-gate -p auth.info -- "$line" 2>/dev/null || true
  fi
  if mkdir -p "$(dirname "$log_file")" 2>/dev/null; then
    printf '%s\n' "$line" >>"$log_file" 2>/dev/null || true
  fi
}

deny() {
  log "$action_for_log" "deny" "$1"
  echo "offsite-readonly-gate: refused ($1)" >&2
  exit 77
}

remote_fail() {
  log "$action_for_log" "fail" "$1"
  echo "offsite-readonly-gate: failed ($1)" >&2
  exit 65
}

# --- 0) 只读 SSH_ORIGINAL_COMMAND,不读 argv --------------------------------
raw_command="${SSH_ORIGINAL_COMMAND:-}"
if ! [[ -n "$raw_command" ]]; then
  deny "empty_command"
fi
case "$raw_command" in
  *$'\n'*) deny "multiline_command" ;;
esac

# 只按空白切分成 token,不做任何 shell 层面的二次解释 (不 eval,不 `sh -c`)。
read -r -a parts <<<"$raw_command"
action="${parts[0]:-}"
action_for_log="$action"

case "$action" in
  list) ;;
  get) ;;
  *) deny "unknown_action" ;;
esac

if [[ "$action" == "list" ]]; then
  if ! [[ "${#parts[@]}" -eq 1 ]]; then deny "list_takes_no_arguments"; fi
fi
if [[ "$action" == "get" ]]; then
  if ! [[ "${#parts[@]}" -eq 2 ]]; then deny "get_requires_exactly_one_argument"; fi
fi

# --- 0.5) get 的文件名格式校验,尽早做、在碰 docker 之前 ---------------------
# 三条独立检查 (正则整串匹配 / 不含 `/` / 不含 `..`) 只看字符串本身,不依赖
# 任何远端状态,所以特意放在"容器名查找"之前:格式不对的请求应该连一次
# docker 调用都不触发就被拒绝 (fail fast、不给无效输入任何触达 docker 的
# 机会),而不是走到最后才因为"不在 list 里"被拒。"是否出现在当前 list 结果
# 里" 这一层必须依赖远端状态,留到下面第 2 步拿到 formatted_listing 之后再查。
if [[ "$action" == "get" ]]; then
  get_filename="${parts[1]}"
  if ! [[ "$get_filename" =~ $filename_re ]]; then deny "get_invalid_filename"; fi
  case "$get_filename" in
    */*) deny "get_filename_contains_slash" ;;
  esac
  case "$get_filename" in
    *..*) deny "get_filename_contains_dotdot" ;;
  esac
fi

# --- 1) 容器名:固定查找方式,沿用 offsite-pull.sh,不接受外部传入 ---------
container="$(docker ps --filter "name=${container_filter}" --format '{{.Names}}' | head -1)"
if ! [[ -n "$container" ]]; then remote_fail "container_not_found"; fi

# --- 2) 远端列举:判定"已完成"的规则与 offsite-pull.sh 完全一致 (两个
# sidecar 都存在才算完成),喂进 `docker exec -u 0 ... sh -s --` 的是这个文件
# 里写死的 heredoc,不是任何来自网络的字节。`-u 0` 是必须的,道理与
# offsite-pull.sh 相同:备份文件在宿主机上是 root:root 0600,而目标容器
# (如 web) 默认可能以非 root UID 运行,不加 -u 0 会 Permission denied。
if ! raw_listing="$(
  docker exec -u 0 -i "$container" sh -s -- "$remote_dir" <<'REMOTE_LISTING_SCRIPT'
set -eu
dir="$1"
cd "$dir"
for dump in *.dump; do
  [ -e "$dump" ] || continue
  if [ -f "${dump}.sha256" ] && [ -f "${dump}.metadata" ]; then
    mtime="$(stat -c '%Y' "${dump}.metadata")"
    size="$(stat -c '%s' "$dump")"
    sha="$(awk '{print $1}' "${dump}.sha256")"
    printf '%s %s %s %s\n' "$mtime" "$dump" "$size" "$sha"
  fi
done
REMOTE_LISTING_SCRIPT
)"; then
  remote_fail "remote_listing_failed"
fi

# 按 mtime 升序整理成固定的、机器可读的一行一份格式;空输入 (没有任何已完成
# 备份) 时 formatted_listing 就是空字符串,list 打印 0 行、get 必然
# filename_not_in_current_list,两者都是正确行为,不是错误。
formatted_listing="$(
  printf '%s\n' "$raw_listing" | sort -k1,1n | awk 'NF==4 { printf "name=%s size=%s mtime=%s sha256=%s\n", $2, $3, $1, $4 }'
)"

if [[ "$action" == "list" ]]; then
  count=0
  if [[ -n "$formatted_listing" ]]; then
    count="$(printf '%s\n' "$formatted_listing" | wc -l | tr -d ' ')"
  fi
  log "list" "ok" "container=$container count=$count"
  if [[ -n "$formatted_listing" ]]; then printf '%s\n' "$formatted_listing"; fi
  exit 0
fi

# --- 3) get:格式校验已在第 0.5 步做完 (不依赖 docker 的三条,尽早拒绝);这
# 里补最后一层——必须出现在"当前 list 结果"里,即确实是一份此刻存在、已完成
# 的备份,而不只是"文件名长得符合规则"。四层校验任何一层没过都拒绝,且这里
# 之前从未执行过任何 docker exec cat / 文件读取操作。
#
# list 的 name= 字段永远是 .dump 本身的文件名 (不含 sidecar 后缀) —— 请求
# 的是 .sha256/.metadata 这两个 sidecar 之一时,要校验的是"它所属的那份
# .dump 是否在当前已完成列表里",所以先剥掉这一层已知后缀,再去比对,而不是
# 直接用带后缀的原始文件名比对 (那样会让任何 sidecar 请求都恒不命中)。
filename="$get_filename"
base_name="$filename"
case "$filename" in
  *.sha256) base_name="${filename%.sha256}" ;;
  *.metadata) base_name="${filename%.metadata}" ;;
esac

known_names="$(printf '%s\n' "$formatted_listing" | sed -n 's/^name=\([^ ]*\) .*/\1/p')"
if ! printf '%s\n' "$known_names" | grep -qxF -- "$base_name"; then
  deny "get_filename_not_in_current_list"
fi

log "get" "start" "container=$container file=$filename"
if ! docker exec -u 0 "$container" cat "$remote_dir/$filename"; then
  remote_fail "get_exec_failed:$filename"
fi
log "get" "ok" "container=$container file=$filename"
exit 0
