# CPS Novel preproduction deployment runbook

This runbook is implementation evidence for Phase 2B. Do not execute it on
`haiyue-vps` until the Owner explicitly starts Phase 2C.

## Release and filesystem identity

```text
/opt/cps-novel/
  releases/<approved-40-hex-commit>/
  current -> releases/<commit>      # convenience only
  shared/
    env/preprod.env
    secrets/
    backups/{logical,base}/
    wal-archive/
    maintenance/
```

Build only from a clean checkout whose HEAD equals `APPROVED_GIT_COMMIT`:

```bash
APPROVED_GIT_COMMIT=<40-hex> \
scripts/preproduction/build-release-archive.sh
```

The command uses `prepare_p1_12_local_environment` and the repository's root
Compose build, then `docker save` + zstd into an immutable archive. It refuses to
produce a deployable manifest unless the built image matches the approved commit's
`org.opencontainers.image.revision`, the target platform, and a well-formed config
digest. Record the approved commit, BOTH OCI digests (platform manifest and config)
and the archive SHA256
in approval notes.

Transport and verification on the VPS are covered by
`docs/operations/ARCHIVE_RELEASE_TRANSPORT.md`.

> 🔴 Owner decision 2026-09-20: the production artifact transport is an **immutable
> Docker archive over SSH**, not a registry. `scripts/preproduction/build-release-artifact.sh`
> (registry / `REGISTRY_IMAGE` / `repo@sha256` push) belongs to the **completed GHCR
> PoC** and is **not** the production path — see
> `docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md`. Phase 2C needs no GHCR PAT and
> no `docker login ghcr.io`.

The known `v0.2.0` versus package `0.1.0` drift remains an Owner/Release
decision for Phase 2C.

## One-time Owner sudo steps

1. Install Docker Engine/Compose, Node.js (the release manifest reader, image
   identity checks and `release.sh` all shell out to `node`),
   PostgreSQL-client-compatible tooling, Ubuntu Nginx 1.24.x, Certbot, the Nginx
   Certbot integration, and `acl` from approved OS repositories.
2. Create `/opt/cps-novel/{releases,shared}` and the shared children above.
   Also seed the maintenance page once from the repo checkout, so it exists
   before the first `release.sh deploy` ever runs `maintenance on`:
   `install -m 0644 infra/preproduction/maintenance/__preprod_maintenance.html
   /opt/cps-novel/shared/maintenance/__preprod_maintenance.html`. Every
   `deploy`/`rollback` re-installs this file at the start of its own
   `maintenance on`, so this manual copy is a one-time bootstrap only --
   without it, Step 6's `secrets-preflight.sh` has nothing at that path yet
   and fails `reason=maintenance_page_missing`.
3. Do not put `www-data` in a deployment group. Grant consumers only the
   per-file ACLs in `scripts/preproduction/secret-consumers.tsv`; PostgreSQL is
   UID/GID `999:999`, the application is `1001:1001`, and `backup-timer` stays
   root because its PostgreSQL image command does not start the server entrypoint.
4. Apply the permission model once, as Owner, before initializing identity or
   starting PostgreSQL. These commands assume the fixed target identities
   `deploy=1000:1000` and `www-data=33:33`; stop if the target differs:

   ```bash
   sudo chown 1000:1000 \
     /opt/cps-novel/shared/secrets/{channel_credential_encryption_key_v1,channel_credential_fingerprint_key,totp_encryption_key,tracking_hash_salt,admin-smoke-password,postgres_admin_password,migration_owner_password,web_app_password,worker_app_password,scheduler_app_password,analyst_ro_password,backup_role_password,nginx-preprod.htpasswd,preprod-curl.conf}
   sudo chown 0:0 /opt/cps-novel/shared/secrets/backup_role.pgpass
   sudo chmod 0600 /opt/cps-novel/shared/secrets/{channel_credential_encryption_key_v1,channel_credential_fingerprint_key,totp_encryption_key,tracking_hash_salt,admin-smoke-password,postgres_admin_password,migration_owner_password,web_app_password,worker_app_password,scheduler_app_password,analyst_ro_password,backup_role_password,nginx-preprod.htpasswd,preprod-curl.conf,backup_role.pgpass}
   sudo setfacl -b /opt/cps-novel/shared/secrets/{channel_credential_encryption_key_v1,channel_credential_fingerprint_key,totp_encryption_key,tracking_hash_salt,admin-smoke-password,postgres_admin_password,migration_owner_password,web_app_password,worker_app_password,scheduler_app_password,analyst_ro_password,backup_role_password,nginx-preprod.htpasswd,preprod-curl.conf,backup_role.pgpass}
   sudo setfacl -m u:1001:r-- /opt/cps-novel/shared/secrets/{channel_credential_encryption_key_v1,channel_credential_fingerprint_key,totp_encryption_key,tracking_hash_salt,admin-smoke-password}
   sudo setfacl -m u:999:r-- /opt/cps-novel/shared/secrets/{postgres_admin_password,migration_owner_password,web_app_password,worker_app_password,scheduler_app_password,analyst_ro_password,backup_role_password}
   sudo setfacl -m u:33:r-- /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd
   sudo setfacl -m u:33:--x /opt/cps-novel /opt/cps-novel/shared /opt/cps-novel/shared/secrets /opt/cps-novel/shared/maintenance
   ```

   A named read ACL changes the file's displayed group-mode mask from `0600`
   to `0640`; `getfacl` must still show `group::---`, one named consumer only,
   and `other::---`. `preprod-curl.conf` has no named ACL. The root-owned
   `backup_role.pgpass` has no named ACL.

   The four traverse directories are **not** chmod-ed here on purpose: they stay
   `drwxr-x--- deploy:deploy`, so `other::---` already holds and the only named
   entry is `u:33:--x`. `secrets-preflight.sh` enforces that `other::---`
   explicitly (`reason=nginx_traverse_other`). Without that check a directory set
   to `other::r-x` still shows exactly one named ACL and a mask containing `x`,
   so preflight would report PASS while any UID could traverse and list the
   secrets directory — verified on real Linux ACLs. `group::` is deliberately
   left as `r-x`: that group is the owning `deploy` principal itself, and the
   mask is likewise not pinned to `--x`, because `setfacl` recomputes the mask
   from `group::` and would otherwise reject the established layout.

   🔴 `/opt/cps-novel/shared/maintenance` is the fourth directory, and it needs
   more than traverse: `cps-novel-preprod-protected.conf` does
   `if (-f .../maintenance/enabled) { return 503; }` and, on that branch,
   `error_page 503` serves `.../maintenance/__preprod_maintenance.html`
   straight out of that directory (`root /opt/cps-novel/shared/maintenance`).
   The `enabled` marker only ever needs www-data to **stat** it (covered by
   the directory's own traverse ACL above -- `-f` never opens the file), but
   the **page** has to be actually **readable** by www-data, the same as
   `nginx-preprod.htpasswd`. Measured on the real target before this fix: the
   directory had `other::---` and no `u:33:--x` entry at all (not even a
   too-permissive one), so nginx's worker got `DENIED` on both `stat
   .../enabled` and reading the page. `release.sh deploy` would still flip
   `maintenance on`, believe traffic was gated, and serve the site normally
   the whole time -- the maintenance window silently never took effect, and
   `verify-release.sh`'s own marker check (run as the `deploy` user, who
   *can* see the marker) would not catch it either. `secrets-preflight.sh`
   now asserts both halves: the directory ACL above (`reason=
   nginx_traverse_directory` / the `assert_directory_traverse_acl` reasons),
   and separately that the page is www-data-readable
   (`reason=maintenance_page_missing` / `reason=maintenance_page_unreadable`).
   The page file itself needs no extra `chown`/`chmod`/ACL beyond what Step 2's
   `install -m 0644` already gives it (world-readable), since directory
   traverse is the only thing that was actually missing.
5. Confirm Docker reports neither rootless nor userns remapping, then perform
   the one sudo-backed Nginx identity check. Any failure stops the rollout:

   ```bash
   docker info --format '{{json .SecurityOptions}}'
   sudo -u www-data test -x /opt/cps-novel
   sudo -u www-data test -x /opt/cps-novel/shared
   sudo -u www-data test -x /opt/cps-novel/shared/secrets
   sudo -u www-data test -x /opt/cps-novel/shared/maintenance
   sudo -u www-data test -r /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd
   sudo -u www-data test -r /opt/cps-novel/shared/maintenance/__preprod_maintenance.html
   sudo -u www-data test ! -r /opt/cps-novel/shared/secrets/postgres_admin_password
   ```

6. After independently recording the new key material, run
   `record-secret-identity.sh --initialize` once. An existing manifest is
   never overwritten. `secrets-preflight.sh --host-only` reports
   `CONSUMER_ACCESS=UNVERIFIED`; it is not release approval. The ordinary
   non-sudo `secrets-preflight.sh` performs the APP/POSTGRES/root positive
   probes, all cross-consumer negative probes, static Nginx ACL validation on
   all four traverse directories, a real uid-33 read probe of the maintenance
   page, and -- only while a maintenance window is actually open, since the
   marker does not otherwise exist -- a real uid-33 stat probe of the marker
   (`MAINTENANCE_MARKER_PROBE=VERIFIED`; outside a maintenance window it
   prints `MAINTENANCE_MARKER_PROBE=SKIPPED reason=marker_absent` instead of
   silently claiming that check ran). It uses the already-loaded
   `CPS_NOVEL_APP_IMAGE` with `--pull never`.
7. Obtain certificates with Certbot. Certbot owns files below
   `/etc/letsencrypt`; deployment owns the Git-rendered Nginx config.
8. With explicit approval, run `PREPROD_OWNER_SUDO_APPROVED=YES
   scripts/preproduction/install-nginx.sh`. It renders, installs, runs
   `nginx -t`, and gracefully reloads. Never hand-edit the generated file.

## Nginx and crawler matrix

Before target installation run `scripts/preproduction/verify-nginx-matrix.sh`.
It validates the exact source on nginx 1.24 and checks anonymous/authenticated
behavior for `/`, a localized route, novel detail, `/login`, admin, API,
`robots.txt`, sitemap index/family, `_next/static`, 404, maintenance 503,
rate-limit 429, and upstream 502. Anonymous responses cannot contain the mock
business marker. 401/404/429/5xx responses retain the anti-index header.

HTTP redirects use fixed configured hosts, never the request Host. ACME only
serves challenge files and never proxies. `robots.txt` may say `Disallow: /`,
but Basic Auth is the access control. Authenticated QA may inspect sitemap XML;
anonymous crawlers cannot.

## Database paths

Fresh initialization requires the exact one-time confirmation:

```bash
PREPROD_CONFIRM_EMPTY_VOLUME=EMPTY_cps_novel_postgres_data \
scripts/preproduction/database.sh fresh-init
```

It refuses a non-empty stable volume. PostgreSQL initdb creates roles only on
an empty cluster; migration still requires `PREPROD_APPROVED_MIGRATION=YES`.
After migration, import approved accounts or bootstrap one through the
existing audited bootstrap tool. Do not register MoboReader, seed novels,
articles, promos, catalog rows, tasks, or test jobs.

Every persistent start uses `database.sh persistent-check`. It verifies the
stable volume, migration table, required roles, and real password
authentication. It never changes role passwords, rotates keys, recreates a
key, or restores a database.

### Runtime network subnet is pinned (replication)

`infra/preproduction/docker-compose.yml`'s `runtime` network
(`cps_novel_runtime`) declares an explicit `ipam.config[0].subnet:
172.18.0.0/16`. This is pinned deliberately, not incidental: without it,
Docker auto-allocates a subnet on network creation, and that allocation is
silent and can change again on any future `docker network rm` + recreate.

That matters because `infra/postgres/hba-replication-rule.sh` writes a
`pg_hba.conf` replication rule for `backup_role` **once, at initdb time**,
scoped to `X8_RUNTIME_SUBNET` (same default, `172.18.0.0/16`) — it is never
re-derived or refreshed afterward. The network must therefore be made to
match the already-baked rule, not the other way round; editing
`pg_hba.conf`/`init-roles.sh` after the fact is out of scope here and is not
how this is fixed. A mismatch (measured on a real host: auto-allocation
picked `172.16.1.0/24`) rejects every replication connection (`FATAL: no
pg_hba.conf entry for replication connection from host ...`), which makes
`pg_basebackup` — and therefore physical base backups and PITR — impossible.
`tests/backend/runtime/preproduction-deployment-contract.test.ts` asserts
the compose subnet and the script's default subnet cannot drift apart.

Operationally: changing this subnet on an **existing** deployment requires
removing the network first — Docker will not re-IPAM a network in place.
**Do not** manually run `docker network rm cps_novel_runtime` after
stopping the containers — verified broken on a real host: `docker network
rm` succeeds even with stopped containers attached, but a stopped container
keeps a reference to the removed network id, so the next `up` fails
(`Error response from daemon: failed to set up container networking:
network <old id> not found`) and postgres stays `exited`. Use one of these
instead:

- `docker compose down` **without** `-v`/`--volumes`, then `up` — clean; or
- stop the containers, then plain `up -d` — Compose detects the IPAM
  change itself and replaces the network in place (observed:
  `Stopping -> Network Removed -> Creating -> Created -> Starting`).

Both were verified working on Compose v5.0.1 — confirm the same
self-replacement behaviour against the host's actual compose version before
relying on it in production. The `postgres_data` volume is unaffected by
either path; this is a network-only change **only as long as `down` is never
given `-v`/`--volumes`** — that flag is what would delete
`cps_novel_postgres_data`.

### Grants replay (`migrate-approved`) and `DATABASE_PRIVILEGE_CHECK`

`migrate-approved` now replays `infra/postgres/grants.sql` immediately after
`prisma migrate deploy` succeeds (`echo "DATABASE_MIGRATION=PASS"` stays
where it already was; the replay and its own `DATABASE_GRANTS=PASS` line
follow it). Before this change the preproduction path never replayed grants
at all — measured on the real host, `web_app` and `backup_role` each held
SELECT on 0 of 54 tables, which also breaks `pg_dump` for `backup_role`. The
replay uses the exact invocation the mature X8 path
(`scripts/x8-production-like.sh prepare_database()`) already proved safe:

```bash
preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
  -U postgres -d cps_novel < infra/postgres/grants.sql
```

- **`-U postgres`, not `-U migration_owner`**: `grants.sql`'s blanket
  `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` also
  touches postgres-owned extension functions (e.g. `pg_stat_statements`).
  `migration_owner` does not own those functions, so a `REVOKE` issued as
  `migration_owner` is not guaranteed to stay idempotent on a repeat run —
  only the bootstrap superuser does.
- **`--single-transaction`**: `grants.sql` REVOKEs every privilege up front
  and re-GRANTs them line by line. Without `--single-transaction`, psql
  commits each statement as it runs, so a mid-file failure could leave the
  REVOKE half committed and the GRANT half missing, stripping every runtime
  role to zero privileges. With it, the REVOKE block and the GRANT block
  either both land or both roll back — there is no partially-applied state.

If the replay fails, `database.sh` prints `DATABASE_GRANTS=REFUSED
reason=grants_replay_failed` and does **not** retry automatically —
`--single-transaction` means PostgreSQL has already rolled the attempt back
atomically, so a second replay would be redundant, not corrective. Recover
by hand, from the release checkout root, after investigating why it failed:

```bash
source scripts/preproduction/lib.sh && preprod_load_env
preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
  -U postgres -d cps_novel < infra/postgres/grants.sql
```

`persistent-check` now also asserts `DATABASE_PRIVILEGE_CHECK`: real
`has_table_privilege`/`has_schema_privilege`/`has_sequence_privilege` checks
derived from what `grants.sql` actually grants (not re-guessed by hand) —
every runtime role holds at least one table privilege, `backup_role` can
SELECT every table and sequence, `web_app` has the exact Admin-auth and
`operation_audit` privileges `grants.sql` grants and nothing more (no
UPDATE/DELETE on `operation_audit`), and `worker_app`/`scheduler_app`/
`analyst_ro` have no SELECT on the three most sensitive Admin-auth tables. A
failure prints `DATABASE_PRIVILEGE_CHECK=FAIL reason=<specific role/table/
privilege>`, and `DATABASE_PERSISTENT_CHECK` fails with it — recover by
replaying grants with the command above, then re-run `persistent-check`.

`backup-loop.sh` (`infra/preproduction/backup-loop.sh`) runs the logical
backup (`backup-logical.sh`, which connects as `backup_role`) **before** the
physical base backup on every cycle, and the physical base backup is
skipped entirely if the logical step fails (`set -euo pipefail` stops
`run_once()` there). Without `backup_role`'s grants, the logical backup
fails immediately and the physical base backup is never taken either — so
grants must be replayed (via `migrate-approved`, or by hand with the
recovery command above on an already-migrated database) before
`backup-timer` is ever started.

### Application image entry points: no build, no pull, fail closed

Every container that runs the application image goes through
`preprod_compose_app_up` / `preprod_compose_app_run` in
`scripts/preproduction/lib.sh`. Both call the same gate first:

1. `CPS_NOVEL_APP_IMAGE` must be set — `APP_RUNTIME=REFUSED reason=app_image_unset`.
2. The **merged** preproduction Compose config must contain no `build:` section —
   `APP_RUNTIME=REFUSED reason=build_capability_present`. The preproduction
   overlay removes it with `build: !reset null`; a plain `build: null` does not
   override the base file and is not a valid substitute.
3. Every rendered service running the approved image must declare
   `pull_policy: never` — `APP_RUNTIME=REFUSED reason=pull_policy_not_never`.
4. The approved image must already be loaded locally —
   `APP_RUNTIME=REFUSED reason=approved_image_missing`. A missing image is a
   transport/release problem, never something Compose is allowed to "solve".
5. On the deploy/rollback path (release manifest loaded) the image must also
   pass the full identity comparison — `APP_RUNTIME=REFUSED reason=app_image_identity`.
   Without a manifest, the gate prints `identity=unverified_no_manifest`: only
   the tag's presence was checked, not that it is the approved artifact.

Refusals go to stderr, the `APP_RUNTIME=PASS …` line to stdout, because
`verify-release.sh` discards the one-off's stdout.

🔴 Do not reintroduce a hard-coded `--no-build` on `docker compose run`. That
flag has **never** existed on `run` (checked on Compose v2.24.0, v2.29.7,
v2.32.0, v2.36.0, v5.0.1, v5.5.1); it exists only on `up`. `--pull` likewise did
not exist on `run` before v2.36.0. The scripts append either flag only where the
subcommand's own `--help` advertises it, and the contract does not rest on them.
Never infer flag support from the version string.

🔴 A `build:` section in a Compose file is not permission to build. With the
build source still merged in and the approved image absent,
`docker compose run --pull never` builds the image on the spot and exits 0 —
measured, not assumed. That is why the gate is in the merged config and in the
image precondition, not in a CLI flag.

### Recovering a partial fresh-init (initdb PASS, migration not run)

🔴 A `fresh-init` that stopped **after** initdb and role initialization but
**before** migration has produced a valid PostgreSQL 16 foundation, not a
disposable failed volume. In that state:

- Do **not** re-run `fresh-init` — it refuses a non-empty volume by design, and
  the `initdb`-time role ceremony cannot run again on an initialized cluster.
- Do **not** delete or recreate `cps_novel_postgres_data`.
- Do **not** hand-run `prisma migrate deploy`, `psql` DDL, or `ALTER ROLE`.

Resume with migration only, once the release tooling defect is fixed and the
approved image is loaded on the host. Preconditions, all of them load-bearing:

- Run it in **bash**. `lib.sh` derives its repo root from `BASH_SOURCE`; under
  zsh that resolves to the wrong directory and the manifest reader fails.
- `cd` into the release checkout at the approved commit first — every path below
  is relative, and `migrate-approved` does not verify the checkout's commit.
- `postgres` must already be running. The one-off uses `--no-deps` and will not
  start it, and `persistent-check` cannot be used as a pre-check because
  `_prisma_migrations` does not exist yet. `preprod_compose up -d postgres` is
  idempotent and does not touch the initialized volume.
- Node.js must be installed on the host (the manifest reader and the gate's
  identity comparison both need it).

The release identity is deliberately absent from the shared env file, so export
it from the approved manifest through the same reader deploy uses. Going through
`preprod_read_release_manifest` is what arms the identity leg of the gate —
exporting only `CPS_NOVEL_APP_IMAGE` by hand leaves it at tag-presence.

```bash
cd /opt/cps-novel/releases/<approved-40-hex-commit>
bash
source scripts/preproduction/lib.sh
preprod_read_release_manifest /absolute/release-manifest.json
export CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF" GIT_COMMIT="$PREPROD_RELEASE_COMMIT"

preprod_compose up -d postgres
PREPROD_APPROVED_MIGRATION=YES scripts/preproduction/database.sh migrate-approved
scripts/preproduction/database.sh persistent-check
```

`migrate-approved` runs the one-off through `preprod_compose_app_run`, so the
gate above applies: with the manifest loaded, an absent or wrong approved image
stops here rather than being built or pulled on the target.

### Bootstrapping the first admin identity

`scripts/bootstrap-admin-identity.ts` is the existing audited bootstrap tool
referenced above. It is dry-run by default, requires an explicit `--apply`
to write, takes the password only through `BOOTSTRAP_ADMIN_PASSWORD` (never
argv, never the host shell environment on the host side), and is safe to
replay with the same `--request-id`: a committed replay returns the already-
created identity instead of erroring or creating a second one. On the
preproduction host, run it through `preprod_compose_app_run` (same
immutable-artifact gate as `migrate-approved`/`verify-release.sh`) with the
password read inside the container from a read-only bind mount, so it never
touches argv or the host shell's environment:

```bash
preprod_compose_app_run \
  -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
  -v /opt/cps-novel/shared/secrets/admin-smoke-password:/run/preprod-admin/password:ro \
  web sh -c 'BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/preprod-admin/password)" BOOTSTRAP_ADMIN_OPERATOR=<operator> tsx scripts/bootstrap-admin-identity.ts --username <name> --reason <why> --request-id <stable-id>'
```

Sequence:

1. **Dry-run** first (the command above, no `--apply`) — confirms
   `outcome: "eligible"` (or `"replayed"` if this exact `--request-id` was
   already committed) before anything is written.
2. **Apply** — add `--apply` to the same command (with the same
   `--username`, `--reason`, and `--request-id`) to actually create the
   identity and its `OperationAudit` row, atomically.
3. **Same-request-id replay** — re-running the identical `--apply` command
   (same `--request-id`) afterward, deliberately or by accident, must return
   `outcome: "replayed"`, `wrote: false` — it must never error and must
   never create a second identity. This is the property that makes it safe
   to re-run this step if a deploy fails partway through and needs retrying.

### Minimal account transfer

The current schema proves the minimal set is `admin_identity` (username,
self-contained `scrypt$v1` password hash, role/status/session version), plus
`admin_two_factor` and `admin_recovery_code` only when the stable TOTP key
identity is exactly the same. Sessions, challenges, and login-attempt lockouts
are ephemeral and are not moved. `operation_audit` has no FK to admin identity;
retain the source audit export as evidence rather than importing unrelated
business audit rows. AdminIdentity's optional business approval relations do
not require rows for account import.

Use `account-transfer.sh` with either `--two-factor preserve` and matching
source/target SHA-256 key fingerprints, or `--two-factor reenroll`. A key
mismatch stops. Password portability is verified against the actual scrypt
format. `ADMIN_TWO_FACTOR_ENFORCEMENT=true` stays unchanged; re-enrollment must
be completed through the approved recovery/bootstrap ceremony before release
verification can pass.

### Foundation assets (channels, tags, translations, templates)

A freshly provisioned preproduction database has **every foundation-asset
table at zero rows** — no Channel, no SourceApp, no ChannelApp, no
CanonicalTag, no translations, no ArticleTemplate. The admin UI then shows
empty shells and `INCOMPLETE` diagnostics, and nothing in a normal deploy
fills them: the migrations that created these tables are additive-only and
carry no seed data.

Seeding them is a separate, explicitly-run step:

```bash
cd /opt/cps-novel/releases/<SHA>
PREPROD_FOUNDATION_OPERATOR=<operator> \
PREPROD_FOUNDATION_APPROVER=<AdminIdentity uuid or username> \
  scripts/preproduction/foundation-assets.sh status   # read-only census
scripts/preproduction/foundation-assets.sh plan       # dry-run every stage
scripts/preproduction/foundation-assets.sh apply      # seed, then ANALYZE
```

`status` prints one `FOUNDATION_ASSET=<name> state=… actual=… expected=…`
line per asset and distinguishes `MISSING` / `VERSION_MISMATCH` /
`NO_ACCOUNT` / `NO_CREDENTIAL` / `FEATURE_DISABLED` / `OK`, so "no rows yet",
"wrong artifact version" and "registered but no channel account" never
collapse into one indistinguishable "not ready".

That script is an orchestrator only. Every write happens inside one of four
already-reviewed CLIs, run in dependency order (see the script's own header
for the full list and row counts). It never creates a ChannelAccount or
credential, never promotes a capability to `enabled`, never opens a
feature/write gate, and never touches SiteSetting or admin/2FA.

🔴 Two of those four stages read hash-pinned artifacts under `docs/p2/**`,
and `docs/` is **not** in the application image. The script bind-mounts the
release checkout's own `docs/` read-only for exactly those two stages. Both
CLIs hash-verify what they read and fail closed on `SHA-256 mismatch`, so a
wrong mount is rejected rather than silently accepted.

`apply` is resumable: each stage's request-id is stable, a stage already at
its expected shape is reported `ALREADY_SATISFIED` and skipped rather than
rewritten, and progress is recorded in
`$PREPROD_SHARED_ROOT/foundation-assets-state.json`. An interrupted run is
resumed by rerunning `apply` — never by clearing tables and starting over.

The final step runs a whole-database `ANALYZE` and verifies it, per
`docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md` §2. This is not
optional housekeeping: every table this step writes is a small registry that
is written once and never changes, so it can never reach autovacuum's
`50 + 0.1 × reltuples` analyze threshold, and the checklist records a real
case where adding one `ANALYZE channel_app` took an unchanged query from
2,696ms to 0.68ms.

## Maintenance release

Set protected `PREPROD_CURL_CONFIG`, admin username/password-file inputs, the
approved commit, and migration approval, then run:

```bash
APPROVED_GIT_COMMIT=<40-hex> PREPROD_APPROVED_MIGRATION=YES \
scripts/preproduction/release.sh deploy --manifest /absolute/release-manifest.json
```

The tool controls actual Compose services. Health verifies the image commit
and database; the auth probe validates the current password implementation,
2FA enrollment, and decryptability without printing credentials. Any failure
leaves maintenance enabled. Investigate; do not manually turn traffic back on.

Rollback requires `SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES` and the approved
previous release manifest (identity = approved commit + OCI platform manifest digest
+ OCI config digest +
archive SHA256), and must be invoked from that previous immutable
release directory so its Compose/scripts match the app being restored. It does
not reverse migrations. If the schema is not
backward compatible, remain in maintenance and follow a separately approved
database restore incident plan.

Rollback also replays `infra/postgres/grants.sql` from that same previous
release checkout (before the app containers come back up), so runtime role
privileges match the code being restored instead of whatever grants the
release being rolled back FROM last committed via `migrate-approved` --
without this, a deploy that had tightened a grant (e.g. `7141177`, `a943fda`)
would leave the restored, older application running with privileges it
never had before, or missing one it still depends on. This is a grants
replay only, not a schema change or a data restore, and it does not by
itself make an incompatible schema safe to roll back onto: the operator
approving `SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES` must also confirm the
grants delta between the two releases' `infra/postgres/grants.sql` is
itself backward compatible with the previous release's code (i.e. the
newer release's `grants.sql` did not tighten or revoke a grant that the
previous release's code still legitimately needs -- the same hazard the
replay above exists to undo, e.g. `7141177`, `a943fda`).

## Backups, WAL, export, and restore

The backup service writes one logical backup daily and retains 14 days. It
creates and verifies a physical base backup at least weekly, keeps at least two
verified anchors, continuously archives WAL, and applies fail-closed retention
anchored to those bases for an approximately seven-day local PITR window.

At least weekly, the Owner manually copies the backup set from VPS to Owner
Mac, runs `export-backup-manifest.sh`, verifies every checksum, and copies the
same set plus manifest to NAS. No Mac/NAS credentials belong on the VPS or in
this repository. VPS-local recovery RPO is the WAL window; whole-VPS-loss
off-host RPO is only the most recent manual sync cadence, not continuous WAL.

The first G2 restore must use an already exported Mac/NAS copy:

```bash
OFFHOST_COPY_CONFIRMED=YES scripts/preproduction/restore-offhost-rehearsal.sh \
  --offhost-dir /absolute/mac-or-nas-copy \
  --dump /absolute/mac-or-nas-copy/<backup>.dump \
  --manifest /absolute/mac-or-nas-copy/SHA256SUMS
```

The rehearsal rejects `/opt/cps-novel/shared` as its source, verifies the
manifest, restores into a disposable isolated PostgreSQL 16 volume, checks
migrations, and removes that disposable environment. A physical PITR drill
uses the same exported copy with `scripts/db/restore-pitr.sh`; it must not use
the VPS original as supposed off-host evidence.

## Preproduction to production domain

Use the same VPS, PostgreSQL volume, Compose project, and stable secrets. Switch
in sequence: DNS, TLS, `SITE_URL`, `ADMIN_CANONICAL_ORIGIN`, Nginx server names,
then regenerate/verify SEO outputs. Explicitly audit sitemap files,
canonical/hreflang, SiteSetting IndexNow host/key, pending absolute IndexNow
URLs, and absolute default OG image. The preproduction domain must not remain a
second public site. IndexNow write/delivery gates remain off until separately
approved.
