#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-backup-restore.XXXXXX")"
source_container="cps-backup-source-$$"
source_volume="${source_container}-data"
cleanup() {
  docker rm -f "$source_container" >/dev/null 2>&1 || true
  docker volume rm "$source_volume" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$tmp/vps-copy" "$tmp/mac-export"
admin_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
printf '127.0.0.1:5432:cps_novel:backup_role:%s\n' "$backup_password" >"$tmp/backup.pgpass"
chmod 600 "$tmp/backup.pgpass"

docker volume create "$source_volume" >/dev/null
docker run -d --name "$source_container" -e POSTGRES_PASSWORD="$admin_password" -e POSTGRES_DB=cps_novel \
  -v "$source_volume:/var/lib/postgresql/data" \
  -v "$root/scripts/db/backup-logical.sh:/opt/backup-logical.sh:ro" \
  -v "$tmp:/evidence" postgres:16.14 >/dev/null
for _ in {1..120}; do docker exec "$source_container" pg_isready -U postgres -d cps_novel >/dev/null 2>&1 && break; sleep 0.5; done
docker exec -i -e PGPASSWORD="$admin_password" "$source_container" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  -v backup_password="$backup_password" <<'SQL' >/dev/null
CREATE TABLE "_prisma_migrations" (finished_at timestamptz);
INSERT INTO "_prisma_migrations" VALUES (now());
CREATE ROLE backup_role LOGIN PASSWORD :'backup_password';
GRANT CONNECT ON DATABASE cps_novel TO backup_role;
GRANT USAGE ON SCHEMA public TO backup_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_role;
SQL
docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=cps_novel -e PGUSER=backup_role \
  -e PGPASSFILE=/evidence/backup.pgpass "$source_container" \
  /bin/bash /opt/backup-logical.sh --output /evidence/vps-copy/cps-novel.dump >/dev/null
cp "$tmp/vps-copy"/* "$tmp/mac-export/"
"$root/scripts/preproduction/export-backup-manifest.sh" \
  --source-dir "$tmp/mac-export" --output "$tmp/mac-export/SHA256SUMS" >/dev/null
OFFHOST_COPY_CONFIRMED=YES "$root/scripts/preproduction/restore-offhost-rehearsal.sh" \
  --offhost-dir "$tmp/mac-export" \
  --dump "$tmp/mac-export/cps-novel.dump" \
  --manifest "$tmp/mac-export/SHA256SUMS" >/dev/null
echo "BACKUP_RESTORE_REHEARSAL=PASS source=EXPORTED_COPY"
