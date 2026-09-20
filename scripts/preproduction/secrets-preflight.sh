#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
secret_root="${PREPROD_SECRET_ROOT:-/opt/cps-novel/shared/secrets}"
inventory="$root/scripts/preproduction/secret-files.txt"
consumer_matrix="${PREPROD_SECRET_CONSUMER_MATRIX:-$root/scripts/preproduction/secret-consumers.tsv}"
host_only=0
fail() {
  echo "SECRET_PREFLIGHT=FAIL reason=$1"
  exit "${2:-65}"
}

case "${1:-}" in
  "") ;;
  --host-only) host_only=1 ;;
  *) fail invalid_argument ;;
esac
[[ "$#" -le 1 ]] || fail invalid_argument

if [[ "$secret_root" != "/opt/cps-novel/shared/secrets" && "${PREPROD_TEST_MODE:-0}" != "1" ]]; then
  fail secret_root
fi

matrix_status="$(node "$root/scripts/preproduction/verify-secret-consumers.mjs" "$inventory" "$consumer_matrix")" || {
  printf '%s\n' "$matrix_status"
  fail consumer_matrix
}
printf '%s\n' "$matrix_status"

[[ -d "$secret_root" && ! -L "$secret_root" ]] || fail secret_root

declare -a names=()
declare -a classes=()
declare -a uids=()
declare -a gids=()
while IFS=$'\t' read -r name consumer_class uid gid extra; do
  [[ -n "$name" && "$name" != \#* ]] || continue
  [[ "$name" == "name" ]] && continue
  [[ -z "${extra:-}" ]] || fail consumer_matrix
  path="$secret_root/$name"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || fail secret_file
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  # ACL masks are reflected in group-mode bits. Group read is permitted, but
  # group write/execute and all "other" bits are not.
  (( (8#$mode & 0037) == 0 )) || fail secret_mode
  names+=("$name")
  classes+=("$consumer_class")
  uids+=("$uid")
  gids+=("$gid")
done <"$consumer_matrix"

manifest="$secret_root/secret-identity.sha256"
[[ -f "$manifest" && ! -L "$manifest" ]] || fail secret_identity_manifest
(
  cd "$secret_root"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --status -c secret-identity.sha256
  else
    shasum -a 256 -c secret-identity.sha256 >/dev/null
  fi
) || fail secret_identity_mismatch

# Host-only is intentionally not a consumer-access success. It checks only the
# inventory, base mode, regular-file and stable-identity invariants above.
if [[ "$host_only" == "1" ]]; then
  echo "SECRET_PREFLIGHT=HOST_ONLY CONSUMER_ACCESS=UNVERIFIED"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail docker_missing 69
command -v getfacl >/dev/null 2>&1 || fail getfacl_missing 69
[[ -n "${CPS_NOVEL_APP_IMAGE:-}" ]] || fail probe_image_unset

security_options="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)" || fail docker_info 69
if grep -Eiq 'rootless|userns' <<<"$security_options"; then
  fail unsupported_docker_user_namespace_for_secret_acl
fi
docker image inspect "$CPS_NOVEL_APP_IMAGE" >/dev/null 2>&1 || fail probe_image_missing 66

probe_readable() {
  local uid="$1" gid="$2" path="$3"
  # Open the file for reading so the kernel evaluates the bind-mounted inode's
  # DAC/ACL. BusyBox `test -r` only inspects mode bits and can reject a valid
  # named-user ACL, which would make the probe report a false negative.
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user "$uid:$gid" \
    --mount "type=bind,src=$path,dst=/run/check,readonly" \
    --entrypoint /bin/sh "$CPS_NOVEL_APP_IMAGE" -c 'exec 3</run/check' >/dev/null 2>&1
}

numeric_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

named_user_acl() {
  local path="$1" uid="$2"
  getfacl -cpn "$path" 2>/dev/null | awk -F: -v uid="$uid" '$1 == "user" && $2 == uid { print $3 }'
}

named_acl_count() {
  getfacl -cpn "$1" 2>/dev/null | awk -F: '$1 == "default" || ($1 == "user" && $2 != "") || ($1 == "group" && $2 != "") { count++ } END { print count + 0 }'
}

acl_entry() {
  local path="$1" kind="$2"
  getfacl -cpn "$path" 2>/dev/null | awk -F: -v kind="$kind" '$1 == kind && $2 == "" { print $3 }'
}

acl_mask() {
  getfacl -cpn "$1" 2>/dev/null | awk -F: '$1 == "mask" { print $3 }'
}

assert_file_base_acl() {
  [[ "$(acl_entry "$1" user)" == "rw-" ]] || fail owner_acl
  [[ "$(acl_entry "$1" group)" == "---" ]] || fail group_acl
  [[ "$(acl_entry "$1" other)" == "---" ]] || fail other_acl
}

assert_single_consumer_acl() {
  local path="$1" uid="$2" permissions="$3"
  [[ "$(named_acl_count "$path")" == "1" ]] || fail unexpected_named_acl
  [[ "$(named_user_acl "$path" "$uid")" == "$permissions" ]] || fail consumer_acl
  if [[ "$permissions" == "r--" ]]; then
    [[ "$(acl_mask "$path")" == "r--" ]] || fail consumer_acl_mask
  else
    [[ "$(acl_mask "$path")" == *x* ]] || fail consumer_acl_mask
  fi
}

# 🔴 目录不能复用 assert_file_base_acl：目录的 user:: 是 rwx 而不是 rw-。
# 这里补上原先漏掉的那一条 —— other 必须完全没有权限。
# 不补的话：给 secrets 目录设成 other::r-x，named ACL 仍然只有 u:33:--x、
# 计数仍是 1、mask 仍含 x，preflight 照样 PASS，而任何 UID 都能穿越并列出
# secrets 目录（文件内容仍受各自 ACL 保护，但"只给 UID 33 traverse"这条
# 不变式已经不成立）。实测确认过：UID 4242 能 ls 出目录内容。
#
# group:: **刻意不强制为 ---**：现网三个目录是 drwxr-x--- deploy:deploy，
# group 就是 owner 本人所在的组；强制 --- 会与 Owner 既定布局冲突。
# 同理 mask 不收紧到精确 --x —— group::r-x 存在时 setfacl 会把 mask 重算成
# r-x，收紧会把现网判死。named 条目本身已被钉死为 --x，且全目录仅此一条，
# 所以 mask 放宽也无法让任何 UID 越过 traverse。
assert_directory_traverse_acl() {
  local path="$1" uid="$2"
  [[ "$(acl_entry "$path" other)" == "---" ]] || fail nginx_traverse_other
  assert_single_consumer_acl "$path" "$uid" "--x"
}

assert_no_named_acl() {
  [[ "$(named_acl_count "$1")" == "0" ]] || fail unexpected_named_acl
  [[ -z "$(acl_mask "$1")" ]] || fail unexpected_acl_mask
}

for index in "${!names[@]}"; do
  name="${names[$index]}"
  consumer_class="${classes[$index]}"
  uid="${uids[$index]}"
  gid="${gids[$index]}"
  path="$secret_root/$name"
  assert_file_base_acl "$path"

  case "$consumer_class" in
    APP|POSTGRES)
      [[ "$(numeric_owner "$path")" == "1000:1000" ]] || fail secret_owner
      [[ "$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")" == "640" ]] || fail secret_mode
      assert_single_consumer_acl "$path" "$uid" "r--"
      probe_readable "$uid" "$gid" "$path" || fail positive_access_probe 66
      ;;
    HOST_NGINX)
      [[ "$(numeric_owner "$path")" == "1000:1000" ]] || fail secret_owner
      [[ "$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")" == "640" ]] || fail secret_mode
      assert_single_consumer_acl "$path" "$uid" "r--"
      ;;
    HOST_DEPLOY)
      [[ "$(numeric_owner "$path")" == "1000:1000" ]] || fail secret_owner
      [[ "$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")" == "600" ]] || fail secret_mode
      assert_no_named_acl "$path"
      [[ "$(id -u):$(id -g)" == "$uid:$gid" && -r "$path" ]] || fail host_deploy_access
      ;;
    BACKUP_ROOT)
      [[ "$(numeric_owner "$path")" == "0:0" ]] || fail secret_owner
      [[ "$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")" == "600" ]] || fail secret_mode
      assert_no_named_acl "$path"
      probe_readable "$uid" "$gid" "$path" || fail positive_access_probe 66
      ;;
    *) fail consumer_matrix ;;
  esac
done

# The Nginx worker gets read access to one file and traverse-only access to the
# three fixed directories. No deployment-group membership is part of the model.
nginx_traverse_directories=(/opt/cps-novel /opt/cps-novel/shared /opt/cps-novel/shared/secrets)
if [[ "${PREPROD_TEST_MODE:-0}" == "1" && -n "${PREPROD_TEST_NGINX_TRAVERSE_PATHS:-}" ]]; then
  IFS=: read -r -a nginx_traverse_directories <<<"$PREPROD_TEST_NGINX_TRAVERSE_PATHS"
fi
for directory in "${nginx_traverse_directories[@]}"; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail nginx_traverse_directory
  assert_directory_traverse_acl "$directory" "33"
done

# Fail closed if either container identity can read any secret outside its
# declared class. This is deliberately independent of the positive probes.
for index in "${!names[@]}"; do
  name="${names[$index]}"
  consumer_class="${classes[$index]}"
  path="$secret_root/$name"
  if [[ "$consumer_class" != "APP" ]] && probe_readable 1001 1001 "$path"; then
    fail negative_access_app
  fi
  if [[ "$consumer_class" != "POSTGRES" ]] && probe_readable 999 999 "$path"; then
    fail negative_access_postgres
  fi
done

echo "SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED"
