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
   sudo setfacl -m u:33:--x /opt/cps-novel /opt/cps-novel/shared /opt/cps-novel/shared/secrets
   ```

   A named read ACL changes the file's displayed group-mode mask from `0600`
   to `0640`; `getfacl` must still show `group::---`, one named consumer only,
   and `other::---`. `preprod-curl.conf` has no named ACL. The root-owned
   `backup_role.pgpass` has no named ACL.

   The three traverse directories are **not** chmod-ed here on purpose: they stay
   `drwxr-x--- deploy:deploy`, so `other::---` already holds and the only named
   entry is `u:33:--x`. `secrets-preflight.sh` enforces that `other::---`
   explicitly (`reason=nginx_traverse_other`). Without that check a directory set
   to `other::r-x` still shows exactly one named ACL and a mask containing `x`,
   so preflight would report PASS while any UID could traverse and list the
   secrets directory — verified on real Linux ACLs. `group::` is deliberately
   left as `r-x`: that group is the owning `deploy` principal itself, and the
   mask is likewise not pinned to `--x`, because `setfacl` recomputes the mask
   from `group::` and would otherwise reject the established layout.
5. Confirm Docker reports neither rootless nor userns remapping, then perform
   the one sudo-backed Nginx identity check. Any failure stops the rollout:

   ```bash
   docker info --format '{{json .SecurityOptions}}'
   sudo -u www-data test -x /opt/cps-novel
   sudo -u www-data test -x /opt/cps-novel/shared
   sudo -u www-data test -x /opt/cps-novel/shared/secrets
   sudo -u www-data test -r /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd
   sudo -u www-data test ! -r /opt/cps-novel/shared/secrets/postgres_admin_password
   ```

6. After independently recording the new key material, run
   `record-secret-identity.sh --initialize` once. An existing manifest is
   never overwritten. `secrets-preflight.sh --host-only` reports
   `CONSUMER_ACCESS=UNVERIFIED`; it is not release approval. The ordinary
   non-sudo `secrets-preflight.sh` performs the APP/POSTGRES/root positive
   probes, all cross-consumer negative probes, and static Nginx ACL validation.
   It uses the already-loaded `CPS_NOVEL_APP_IMAGE` with `--pull never`.
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
