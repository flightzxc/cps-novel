#!/usr/bin/env bash
set -euo pipefail
set +x

# Real-Postgres verification for scripts/tagging-auto-preview.ts (the
# read-only text-classification quality preview for the "open the front-end
# auto tag gate" round). Spins up a disposable, one-off Postgres 16
# container (same pattern as scripts/run-tagging-public-auto-postgres-
# verification.sh), seeds it with the real 123 CanonicalTag v1 rows plus a
# small fixture Novel population, then proves three things against the real
# `web_app` database role -- not by reading the script's source, by actually
# running it:
#
#   1. ZERO WRITES: every table's row count is identical before and after
#      the preview script runs (scripts/tagging-auto-preview-table-counts.ts
#      snapshots every base table in `public`, not a hand-picked subset).
#   2. REPRODUCIBILITY: the exact same `--seed` against the exact same
#      (unchanged, by (1)) data produces byte-identical sampling output.
#   3. THE READ-ONLY TRANSACTION ACTUALLY BLOCKS WRITES: a temporary,
#      never-committed copy of the script with one write call injected after
#      the role check is run against the same seeded database and MUST fail
#      with Postgres's own read-only-transaction error (SQLSTATE 25006) --
#      proving `SET TRANSACTION READ ONLY` (scripts/lib/set-transaction-
#      read-only.ts) is doing real work, not just sitting there unused.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-tagging-auto-preview-pg16-${run_id}"
database_name="cps_novel_tagging_auto_preview_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-tagging-auto-preview-secrets.XXXXXX")"
mutation_file="$project_root/scripts/.mutation-check.tagging-auto-preview.ts"
cleanup_complete="no"

cleanup() {
  rm -f "$mutation_file"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "TAGGING_AUTO_PREVIEW_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
}
trap cleanup EXIT INT TERM

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
printf "ALTER ROLE web_app PASSWORD '%s';\n" "$web_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE worker_app PASSWORD '%s';\n" "$worker_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE scheduler_app PASSWORD '%s';\n" "$scheduler_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE analyst_ro PASSWORD '%s';\n" "$analyst_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE backup_role PASSWORD '%s';\n" "$backup_password" >>"$secret_dir/role-passwords.sql"

cd "$project_root"
docker image inspect postgres:16.14 >/dev/null
docker run -d \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2g \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/tagging-auto-preview-secrets,readonly" \
  -e POSTGRES_USER=tagging_auto_preview_admin \
  -e POSTGRES_PASSWORD_FILE=/run/tagging-auto-preview-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U tagging_auto_preview_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U tagging_auto_preview_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U tagging_auto_preview_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U tagging_auto_preview_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U tagging_auto_preview_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

echo "== seeding fixtures (123 CanonicalTag v1 + fixture novels, en/ja) =="
DATABASE_URL="$owner_url" npx tsx scripts/tagging-auto-preview-fixtures.ts --locales en,ja

echo "== snapshotting table counts BEFORE the preview script runs =="
DATABASE_URL="$owner_url" npx tsx scripts/tagging-auto-preview-table-counts.ts >"$secret_dir/counts-before.json"

seed=20260928
run1_dir="$secret_dir/run1"
run2_dir="$secret_dir/run2"

echo "== run 1 (web_app, seed=$seed) =="
DATABASE_URL="$web_url" npx tsx scripts/tagging-auto-preview.ts \
  --seed "$seed" --sample-per-locale 8 --locales en,ja --out-dir "$run1_dir"

echo "== run 2 (web_app, same seed -- reproducibility) =="
DATABASE_URL="$web_url" npx tsx scripts/tagging-auto-preview.ts \
  --seed "$seed" --sample-per-locale 8 --locales en,ja --out-dir "$run2_dir"

echo "== snapshotting table counts AFTER both runs =="
DATABASE_URL="$owner_url" npx tsx scripts/tagging-auto-preview-table-counts.ts >"$secret_dir/counts-after.json"

echo "== asserting zero writes, reproducibility, and output shape =="
node - "$secret_dir/counts-before.json" "$secret_dir/counts-after.json" "$run1_dir" "$run2_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [, , beforePath, afterPath, run1Dir, run2Dir] = process.argv;
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

const tables = new Set([...Object.keys(before), ...Object.keys(after)]);
const diffs = [];
for (const table of tables) {
  if ((before[table] ?? null) !== (after[table] ?? null)) {
    diffs.push(`${table}: before=${before[table] ?? "missing"} after=${after[table] ?? "missing"}`);
  }
}
if (diffs.length > 0) {
  throw new Error(`TAGGING_AUTO_PREVIEW_WRITE_DETECTED tables=${diffs.length}\n${diffs.join("\n")}`);
}
if (tables.size < 30) {
  throw new Error(`TAGGING_AUTO_PREVIEW_TABLE_COUNT_SUSPICIOUSLY_LOW tables=${tables.size}`);
}
console.log(`TAGGING_AUTO_PREVIEW_ZERO_WRITES=PASS tables_checked=${tables.size}`);

function readRun(dir) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, "tagging-auto-preview.json"), "utf8"));
  const csv = fs.readFileSync(path.join(dir, "tagging-auto-preview.csv"), "utf8");
  return { json, csv };
}

const run1 = readRun(run1Dir);
const run2 = readRun(run2Dir);

if (run1.csv !== run2.csv) {
  throw new Error("TAGGING_AUTO_PREVIEW_NOT_REPRODUCIBLE csv_mismatch");
}
const normalize = (payload) => {
  const clone = JSON.parse(JSON.stringify(payload));
  clone.runMeta.generatedAt = "REDACTED";
  return JSON.stringify(clone);
};
if (normalize(run1.json) !== normalize(run2.json)) {
  throw new Error("TAGGING_AUTO_PREVIEW_NOT_REPRODUCIBLE json_mismatch");
}
console.log("TAGGING_AUTO_PREVIEW_REPRODUCIBLE=PASS seed_reused=true");

const { runMeta, localeSummaries, samples } = run1.json;
if (runMeta.databaseRole !== "web_app" || runMeta.transactionMode !== "READ_ONLY") {
  throw new Error(`TAGGING_AUTO_PREVIEW_RUNMETA_UNEXPECTED role=${runMeta.databaseRole} mode=${runMeta.transactionMode}`);
}
if (localeSummaries.length !== 2 || samples.length !== localeSummaries.reduce((sum, l) => sum + l.sampleTaken, 0)) {
  throw new Error("TAGGING_AUTO_PREVIEW_SAMPLE_COUNT_MISMATCH");
}
for (const summary of localeSummaries) {
  if (summary.globalTotalNovelCount !== 20) {
    throw new Error(`TAGGING_AUTO_PREVIEW_FIXTURE_TOTAL_MISMATCH locale=${summary.locale} total=${summary.globalTotalNovelCount}`);
  }
  // Fixture eligible pool is 15/20 (Group D, manual+empty, is excluded);
  // mapped pool is Group A (5), unmapped pool is Groups B+C (10).
  if (summary.mappedPoolSize !== 5 || summary.unmappedPoolSize !== 10) {
    throw new Error(
      `TAGGING_AUTO_PREVIEW_FIXTURE_POOL_MISMATCH locale=${summary.locale} mapped=${summary.mappedPoolSize} unmapped=${summary.unmappedPoolSize}`,
    );
  }
  if (summary.skippedCount !== 0) {
    throw new Error(`TAGGING_AUTO_PREVIEW_UNEXPECTED_SKIP locale=${summary.locale} skipped=${summary.skippedCount}`);
  }
  // Both mapped-eligible titles ("An Adventure returns ...") and one
  // unmapped-eligible title ("An Adventure begins ...") exist per locale;
  // sample-per-locale=8 against a 15-book eligible pool should reliably
  // surface at least one classifier hit either way.
  if (summary.autoHitRatio <= 0) {
    throw new Error(`TAGGING_AUTO_PREVIEW_NO_CLASSIFIER_HIT locale=${summary.locale}`);
  }
}
console.log("TAGGING_AUTO_PREVIEW_OUTPUT_SHAPE=PASS");
NODE

echo "== mutation: a write injected after the role check must be rejected by the read-only transaction =="
sed \
  -e 's/if (role !== "web_app") throw new TaggingAutoPreviewError("wrong_database_role", { role, expected: "web_app" });/if (role !== "web_app") throw new TaggingAutoPreviewError("wrong_database_role", { role, expected: "web_app" });\n    await tx.canonicalTag.updateMany({ where: { id: "00000000-0000-0000-0000-000000000000" }, data: { slug: "mutation-check-must-be-rejected" } });/' \
  scripts/tagging-auto-preview.ts >"$mutation_file"
if diff -q scripts/tagging-auto-preview.ts "$mutation_file" >/dev/null; then
  echo "TAGGING_AUTO_PREVIEW_MUTATION_SETUP_FAILED: sed did not inject the write call" >&2
  exit 1
fi

mutation_out="$secret_dir/mutation.out"
mutation_status=0
DATABASE_URL="$web_url" npx tsx scripts/.mutation-check.tagging-auto-preview.ts \
  --seed "$seed" --sample-per-locale 8 --locales en,ja --out-dir "$secret_dir/mutation-run" \
  >"$mutation_out" 2>&1 || mutation_status=$?

rm -f "$mutation_file"

if [[ "$mutation_status" -eq 0 ]]; then
  echo "TAGGING_AUTO_PREVIEW_MUTATION_NOT_CAUGHT: mutated script exited 0" >&2
  cat "$mutation_out" >&2
  exit 1
fi
if ! grep -qi "read-only transaction" "$mutation_out"; then
  echo "TAGGING_AUTO_PREVIEW_MUTATION_WRONG_FAILURE_MODE: expected a read-only-transaction error" >&2
  cat "$mutation_out" >&2
  exit 1
fi
echo "TAGGING_AUTO_PREVIEW_MUTATION_CAUGHT=PASS exit_code=$mutation_status"

echo "== re-snapshotting table counts AFTER the rejected mutation attempt =="
DATABASE_URL="$owner_url" npx tsx scripts/tagging-auto-preview-table-counts.ts >"$secret_dir/counts-after-mutation.json"
node - "$secret_dir/counts-before.json" "$secret_dir/counts-after-mutation.json" <<'NODE'
const fs = require("node:fs");
const [, , beforePath, afterPath] = process.argv;
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const tables = new Set([...Object.keys(before), ...Object.keys(after)]);
for (const table of tables) {
  if ((before[table] ?? null) !== (after[table] ?? null)) {
    throw new Error(`TAGGING_AUTO_PREVIEW_MUTATION_LEAKED_A_WRITE table=${table} before=${before[table]} after=${after[table]}`);
  }
}
console.log(`TAGGING_AUTO_PREVIEW_MUTATION_ZERO_WRITES=PASS tables_checked=${tables.size}`);
NODE

if [[ -f "$mutation_file" ]]; then
  echo "TAGGING_AUTO_PREVIEW_MUTATION_FILE_LEAKED: $mutation_file still present" >&2
  exit 1
fi
# Not a `git status` check: this worktree legitimately has other new,
# not-yet-committed files at verification time (this very script, its
# fixture/table-count helpers, the preview script itself). The one file this
# step must never leave behind is the mutated scratch copy checked above --
# `scripts/tagging-auto-preview.ts` itself was only ever read (by `sed`,
# into `$mutation_file`), never written.
echo "TAGGING_AUTO_PREVIEW_MUTATION_SCRATCH_FILE_REMOVED=PASS"

echo "TAGGING_AUTO_PREVIEW_POSTGRES_VERIFICATION=PASS"
