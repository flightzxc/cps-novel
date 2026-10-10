#!/bin/bash
set -euo pipefail
set +x
cd /Users/chenweifeng/Documents/cps海阅/release-v0.5.15
source scripts/lib/p1-12-local-env.sh
prepare_p1_12_local_environment
image="$CPS_NOVEL_APP_IMAGE"
run_id="v0515-$(date -u +%Y%m%d%H%M%S)-$$"
pg="cps-e2e-pg-$run_id"
web="cps-e2e-web-$run_id"
network="cps-e2e-net-$run_id"
cleanup() {
 docker rm -f "$web" "$pg" >/dev/null 2>&1 || true
 docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
umask 077
for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
 password="$(read_secret_value "$P1_12_SECRET_DIR/$role.password")"
 printf "ALTER ROLE %s PASSWORD '%s';\n" "$role" "$password"
done > "$P1_12_SECRET_DIR/e2e-role-passwords.sql"
docker network create "$network" >/dev/null
docker run -d --name "$pg" --network "$network" --network-alias postgres \
 --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2g \
 --mount "type=bind,src=$P1_12_SECRET_DIR,dst=/run/e2e-secrets,readonly" \
 -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
 -e POSTGRES_PASSWORD_FILE=/run/e2e-secrets/postgres_admin.password postgres:16.14 >/dev/null
ready=0
for _ in $(seq 1 60); do
 if docker exec "$pg" pg_isready -U postgres -d postgres >/dev/null 2>&1; then ready=1; break; fi
 sleep 1
done
[ "$ready" = 1 ] || { echo E2E_POSTGRES=FAIL; exit 65; }
docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < infra/postgres/roles.sql >/dev/null
docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$P1_12_SECRET_DIR/e2e-role-passwords.sql" >/dev/null
docker exec "$pg" createdb -U postgres -O migration_owner cps_novel
DATABASE_URL="$P1_12_MIGRATION_DATABASE_URL" docker run --rm --platform linux/amd64 --network "$network" -e DATABASE_URL "$image" npx --no-install prisma migrate deploy
count="$(docker exec "$pg" psql -X -U postgres -d cps_novel -Atqc 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
[ "$count" = 26 ] || { echo "E2E_MIGRATIONS=FAIL applied=$count"; exit 65; }
echo "E2E_MIGRATIONS=PASS applied=$count"
docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 --single-transaction -U postgres -d cps_novel < infra/postgres/grants.sql >/dev/null
DATABASE_URL="$P1_12_WORKER_DATABASE_URL" docker run --rm --platform linux/amd64 --network "$network" -e DATABASE_URL "$image" tsx scripts/ops/effective-tag-projection.ts check
docker run --rm --platform linux/amd64 --network none "$image" tsx scripts/indexnow-status.ts --help
echo INDEXNOW_STATUS_HELP=PASS
docker run --rm --platform linux/amd64 --network none -i "$image" node --input-type=module - < scripts/preproduction/verify-runtime-image-deps.mjs
docker run --rm --platform linux/amd64 --network none "$image" node -e 'const fs=require("fs");for(const p of ["vitest","tinypool"])if(fs.existsSync("node_modules/"+p))throw Error(p);const next=require("next/package.json").version;const nanoid=require("nanoid/package.json").version;if(next!=="16.3.8"||nanoid!=="3.3.18")throw Error("versions");console.log(`IMAGE_VERSIONS=PASS next=${next} nanoid=${nanoid} dev_absent=yes`);'
export SITE_URL=https://pulsenovels.com ADMIN_CANONICAL_ORIGIN=https://zbcwf.pulsenovels.com
DATABASE_URL="$P1_12_WEB_DATABASE_URL" docker run -d --platform linux/amd64 --name "$web" --network "$network" \
 -p 127.0.0.1::3000 -e DATABASE_URL -e APP_VERSION -e GIT_COMMIT -e TRACKING_HASH_SALT -e TOTP_ENCRYPTION_KEY -e SITE_URL -e ADMIN_CANONICAL_ORIGIN "$image" >/dev/null
port="$(docker port "$web" 3000/tcp | awk -F: 'NR==1{print $NF}')"
ready=0
for _ in $(seq 1 90); do
 if curl --noproxy '*' --silent --fail -H 'Host: pulsenovels.com' "http://127.0.0.1:$port/api/health" > .tmp/v0515-release/image-health.json; then ready=1; break; fi
 sleep 1
done
[ "$ready" = 1 ] || { docker logs "$web"; echo IMAGE_HEALTH=FAIL; exit 65; }
node - <<'JS'
const h=require('./.tmp/v0515-release/image-health.json');
if(h.status!=='healthy'||h.build.version!=='0.5.15'||h.build.commit!==process.env.GIT_COMMIT||h.metadataConsistency.status!=='passed')throw Error(JSON.stringify(h));
console.log('IMAGE_HEALTH=PASS '+JSON.stringify(h));
JS
docker exec "$pg" psql -X -U postgres -d cps_novel -Atqc "SELECT site_search_enabled, has_column_privilege('web_app','site_setting','site_search_enabled','UPDATE'), has_column_privilege('scheduler_app','site_setting','site_search_enabled','SELECT') FROM site_setting WHERE id=1" | grep -Fx 'f|t|f'
docker logs "$web" > .tmp/v0515-release/image-web.log 2>&1
docker exec "$pg" psql -X -U postgres -d cps_novel -Atqc "SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL OR finished_at IS NULL" | grep -Fx '0'
docker exec "$pg" psql -X -U postgres -d cps_novel -Atqc "SELECT has_column_privilege('web_app','canonical_tag','is_homepage_visible','UPDATE')" | grep -Fx 't'
echo E2E_HOMEPAGE_COLUMN_GRANT=PASS
echo IMAGE_E2E=PASS
