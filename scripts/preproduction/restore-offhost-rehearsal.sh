#!/usr/bin/env bash
set -euo pipefail
set +x

offhost_dir=""; dump=""; manifest=""
while (($#)); do
  case "$1" in
    --offhost-dir) offhost_dir="${2:-}"; shift 2 ;;
    --dump) dump="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    *) echo "usage: restore-offhost-rehearsal.sh --offhost-dir DIR --dump FILE --manifest FILE" >&2; exit 64 ;;
  esac
done
[[ "${OFFHOST_COPY_CONFIRMED:-}" == "YES" ]] || { echo "OFFHOST_RESTORE=REFUSED reason=confirmation"; exit 65; }
[[ "$offhost_dir" = /* && -d "$offhost_dir" ]] || exit 64
[[ "$offhost_dir" != /opt/cps-novel/shared* ]] || { echo "OFFHOST_RESTORE=REFUSED reason=vps_source"; exit 65; }
[[ "$dump" = "$offhost_dir"/* && -r "$dump" && "$manifest" = "$offhost_dir"/* && -r "$manifest" ]] || exit 64
(
  cd "$offhost_dir"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum --status -c "${manifest#$offhost_dir/}"; else shasum -a 256 -c "${manifest#$offhost_dir/}" >/dev/null; fi
) || { echo "OFFHOST_RESTORE=FAIL reason=checksum"; exit 65; }

id="cps-offhost-restore-$$"
password="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f "$id" >/dev/null 2>&1 || true
  docker volume rm "${id}-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker volume create "${id}-data" >/dev/null
docker run -d --name "$id" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=cps_novel \
  -v "${id}-data:/var/lib/postgresql/data" -v "$offhost_dir:/offhost:ro" postgres:16.14 >/dev/null
for _ in {1..120}; do
  docker exec "$id" pg_isready -U postgres -d cps_novel >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$id" pg_isready -U postgres -d cps_novel >/dev/null
container_dump="/offhost/${dump#$offhost_dir/}"
docker exec "$id" pg_restore --list "$container_dump" >/dev/null
docker exec "$id" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d cps_novel "$container_dump"
docker exec "$id" psql --no-psqlrc -U postgres -d cps_novel -Atqc \
  'SELECT count(*) > 0 FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' | grep -qx t
echo "OFFHOST_RESTORE=PASS source=EXPORTED_COPY isolation=DISPOSABLE"
