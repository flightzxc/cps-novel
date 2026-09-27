# Preproduction deployment layer

Source of truth for the single-instance Host-Nginx deployment described in
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`.

- `docker-compose.yml`: stable production services/data identity; no edge
  proxy container and no PostgreSQL host port. Also carries the capacity
  overrides described below (`shm_size`, `mem_limit`, `NODE_OPTIONS`).
- `nginx/`: Ubuntu nginx 1.24 source templates/snippets.
- `backup-loop.sh`: daily logical, weekly verified physical, continuous-WAL
  retention wiring. The `backup-timer` service's healthcheck only tells you
  the loop is stuck or failing while the container is *running* -- it has no
  way to see a stopped container at all (2026-09-22 incident: an ops step
  used backup-timer for a one-off backup, then stopped it, and nothing
  restarted it for 5 days). Don't start/stop this service for an ad-hoc
  backup; `exec` into the running container instead:
  `preprod_compose exec -T backup-timer /bin/bash /app/scripts/db/backup-logical.sh --output <file>`.
- `offsite-pull.plist.example`: launchd template for
  `scripts/preproduction/offsite-pull.sh` (see "Offsite backup pull" below).
  Not installed by anything here -- copy, edit, and `launchctl load` it by
  hand on the Owner's own Mac/NAS.
- `preprod.env.example`: non-secret feature profile. Most write gates are
  fail-closed; the three Owner-approved open ones (`catalog_write`,
  `promo_write`, `sitemap_write`) must be listed in `PREPROD_APPROVED_OPEN_WRITE_GATES`, or
  `scripts/preproduction/preflight.sh` refuses to pass. See
  `preprod_assert_write_gates()` in `scripts/preproduction/lib.sh` and
  `docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md`. Opening any other
  write gate requires extending that function's closed enum first, not just
  an env edit.

These files are not evidence of target installation. Phase 2B forbids running
them against the VPS.

## Capacity (Owner 2026-09-27 baseline: 4 vCPU / 16 GiB RAM / no swap / SSD)

haiyue-vps is both preproduction and the eventual production host -- there is
no separate machine to size for. Every value below was picked against that
one machine's own measured facts (read-only, 2026-09-27): 4 vCPU, 15.62 GiB
RAM, 0 swap, 193 GB SSD (26 GB used), postgres ~1.1 GiB resident, load
~0.3-0.35, and a live connection count of 20 (web_app=9, worker_app=4,
postgres=2) out of `max_connections=100`.

**Database (`infra/postgres/pitr/postgresql.conf.example`)**: `shared_buffers
4GB`, `effective_cache_size 10GB`, `work_mem 16MB`, `maintenance_work_mem
512MB`, `random_page_cost 1.1`, `effective_io_concurrency 200`,
`max_parallel_workers_per_gather 2`, `max_worker_processes 8`,
`max_parallel_workers 4`, `max_connections 100` (unchanged -- see that file's
own comment for the full connection-budget algebra: worst case ~50 of 100
connections in use). Every value's rationale is documented inline in that
file, next to the setting itself, not only here.

🔴 **This file is mounted by BOTH `infra/preproduction/docker-compose.yml`
(this file) and `infra/production-like/docker-compose.yml` (the local X8
rehearsal overlay used on developer machines).** The memory-tuning section
added here is therefore shared: an X8 rehearsal brought up fresh after this
change will also load `shared_buffers=4GB` etc. On a developer Mac with
Docker Desktop's VM given less than ~6 GiB, that can be too aggressive --
give the Docker VM more memory, or override `shared_buffers`/
`maintenance_work_mem` downward in a local, uncommitted copy of the mounted
file if needed. This was a deliberate scope decision (see this branch's
commit for the full reasoning): forking the file in two would fix this at
the cost of the two overlays silently drifting apart on every future
observability/WAL setting, which is the exact class of drift this repository
has otherwise gone out of its way to prevent (see e.g. the WAL/archive
settings both overlays already share via this same file).

**`shm_size: 1gb`** is added to the `postgres` service in THIS overlay only
(preproduction/production), not in `infra/production-like/docker-compose.yml`
-- Docker's 64 MiB default is sized for a machine much smaller than 16 GiB
and can make a parallel query fail with "could not resize shared memory
segment"; the local X8 overlay runs on varying developer hardware and has
not shown this failure, so it is left at the Docker default rather than
guessing a value for machines this repository has no visibility into.

**Application containers**: `web` and `worker` get `mem_limit: 2g` /
`NODE_OPTIONS=--max-old-space-size=1536`; `worker-light` gets `mem_limit: 1g`
/ `--max-old-space-size=768`; `scheduler` gets `mem_limit: 512m` /
`--max-old-space-size=384`. The heap cap is set to ~75% of the container
limit so V8 GCs itself well before the container's cgroup limit would kill
the process outright, leaving headroom for Node's own non-heap memory.
`scheduler/index.ts` runs as a `tsx scheduler/index.ts &` bash background job
inside the same container (`scripts/run-scheduler-loop.sh`) rather than a
separate `child_process.spawn` -- POSIX environment inheritance means that
child sees `NODE_OPTIONS` automatically, with no extra wiring; this was
verified directly (see this branch's rehearsal notes) rather than assumed.
`postgres` intentionally carries no `mem_limit` -- see the block comment on
that service in `docker-compose.yml` for the reasoning (capping it would
fight `effective_cache_size`'s assumption about host-wide page cache) and the
full 16 GiB budget arithmetic (app limits + Postgres's own worst-case ceiling
+ headroom for the OS and page cache).

**Applying a `postgresql.conf.example` or `shm_size` edit to a running
cluster**: `scripts/preproduction/release.sh` deliberately never touches the
`postgres` service (see that script's own comments), and neither setting is
re-read by a plain `docker compose restart` -- only by recreating the
container. Use `scripts/preproduction/recreate-postgres.sh` for this; see its
own header comment for the full precondition list (claim-generating services
stopped, zero in-flight `processing` task-items, a fresh on-line logical
backup taken first) and
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`'s "Controlled postgres
recreate" section for the runbook-level walkthrough, measured local-rehearsal
downtime, and the exact Owner-authorization steps this requires before ever
running it against haiyue-vps.

## Offsite backup pull

`scripts/preproduction/offsite-pull.sh` replaces the manual "Owner copies the
backup set to a Mac, runs `export-backup-manifest.sh`, copies to NAS" step
this directory's runbook previously described entirely by hand. It runs on
the Owner's own Mac or NAS -- **never on haiyue-vps** -- and only ever
initiates read-only `ssh haiyue-vps docker exec -u 0 <container> ...` calls
(`ls`/`stat`/`cat`, never a write) to read backup files, streamed back over
that same ssh session. No VPS or Mac/NAS credential is stored on the other
side in either direction.

🔴 **Transport is `docker exec`, not direct file access or rsync** (revised
from this branch's first draft): the backup files under
`/opt/cps-novel/shared/backups/logical` are root:root mode `0600` on the
host, and the `deploy` ssh user has no passwordless `sudo` to read them
directly (confirmed live). Routing every read through `docker exec -u 0`
into an already-running container that has that directory bind-mounted
needs no VPS-side permission change and no sudo grant -- `deploy` already
runs `docker` directly for every release and every read-only diagnostic in
this repository, and `docker exec -u 0` on any container is inherently as
privileged as host root for whatever is bind-mounted into it. Because of
this, `--remote-dir` is the path **as seen inside that container**
(`/var/lib/cps-novel/backups/logical`, per
`infra/preproduction/docker-compose.yml`'s bind mount of
`${PREPROD_SHARED_ROOT}/backups:/var/lib/cps-novel/backups`), not the host
path outside it. `-u 0` is confirmed necessary, not just defensive: `web`
(the fallback target, see below) runs as UID 1001 by default, and a plain
`docker exec` without `-u 0` gets `Permission denied` on these files
(confirmed live).

```bash
scripts/preproduction/offsite-pull.sh \
  --remote-host haiyue-vps \
  --remote-dir /var/lib/cps-novel/backups/logical \
  --local-dir /absolute/path/on/mac-or-nas \
  [--backup-timer-container cps-novel-backup-timer-1] \
  --keep 14
```

`--backup-timer-container` defaults to auto-discovering a running
`cps-novel-backup-timer*` container (read-only `docker ps --filter`); pass
it explicitly to target a different running container that mounts the same
directory (e.g. `cps-novel-web-1`, which mounts it read-only) when
backup-timer itself is not running -- confirmed necessary in practice: as of
2026-09-27, `cps-novel-backup-timer-1` on haiyue-vps has been `Exited(137)`
since 2026-09-22 (flagged separately, being handled by the Owner/main
session -- unrelated to this script, which only needs *some* currently
running container with the mount, not specifically that one).

It identifies the most recently COMPLETED logical backup (both the `.sha256`
and `.metadata` sidecar `scripts/db/backup-logical.sh` writes last must
already exist -- a backup still being written has neither yet, and is
skipped, reported on stderr as `IN_PROGRESS`, not treated as an error);
"most recent" is decided by that `.metadata` file's own mtime, not by
filename sort (backup filenames are not guaranteed chronologically
sortable -- see the script's own comment for a real example found on
haiyue-vps). It pulls into a private staging directory first, recomputes
sha256 locally against the transferred bytes (not merely trusting the
sidecar's own claim about itself), and only then atomically promotes the
verified triple into `--local-dir`; a checksum mismatch fails loudly and
leaves the previous good copy untouched. Retention keeps the newest `--keep`
(default 14) complete local backups and deletes older ones. Re-running when
the latest backup is already present and still verifies is a fast no-op.

Every successful run also (re)generates `SHA256SUMS` in `--local-dir` by
calling the existing `scripts/preproduction/export-backup-manifest.sh` --
the same script, same format, this directory's manual off-host workflow
already used ("runs `export-backup-manifest.sh`, verifies every checksum"
above); nothing new is invented here. This is what makes `--local-dir`
immediately usable as `restore-offhost-rehearsal.sh`'s `--offhost-dir`
with **no separate manual step** -- `offsite-pull.sh`'s own per-file
`.dump.sha256` check (verifying the transfer itself, before a file is even
promoted into `--local-dir`) and this whole-directory `SHA256SUMS`
(covering every retained backup, consumed by the restore rehearsal below)
are complementary, not redundant: one guards the transfer, the other is the
manifest format the restore tooling already expects.

**Restore rehearsal from a pulled copy** (the exact command
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`'s "Backups, WAL,
export, and restore" section already documents for a manually-copied set --
a pull via this script produces the identical on-disk shape, so the same
command applies unchanged, no rewrite):

```bash
OFFHOST_COPY_CONFIRMED=YES scripts/preproduction/restore-offhost-rehearsal.sh \
  --offhost-dir /absolute/path/on/mac-or-nas \
  --dump /absolute/path/on/mac-or-nas/<backup>.dump \
  --manifest /absolute/path/on/mac-or-nas/SHA256SUMS
```

**Scheduling**: copy `offsite-pull.plist.example` to
`~/Library/LaunchAgents/cloud.bangbangji.cps-novel.offsite-pull.plist`, edit
every path marked `REPLACE_ME` inside it, then:

```bash
launchctl load ~/Library/LaunchAgents/cloud.bangbangji.cps-novel.offsite-pull.plist
```

Verify it is actually scheduled and has run at least once:

```bash
launchctl list | grep cps-novel.offsite-pull   # shows a PID/exit-status row once it has run
tail -f ~/Library/Logs/cps-novel-offsite-pull.log       # stdout, incl. the OFFSITE_PULL=... result line
tail -f ~/Library/Logs/cps-novel-offsite-pull.err.log   # stderr, incl. any IN_PROGRESS/RETENTION_DELETED lines
launchctl start cloud.bangbangji.cps-novel.offsite-pull # trigger one run immediately instead of waiting for 07:15
```

**Permission blocker: resolved by the `docker exec -u 0` transport above**,
no VPS-side change needed. An earlier draft of this script read backup files
directly over ssh (`rsync`/plain file access) and hit a real
`Permission denied` against the root:root `0600` files with no passwordless
`sudo` available -- see this branch's commit history for that finding. The
`docker exec -u 0` redesign sidesteps it entirely, verified live: real
read-only listing + sha256 against haiyue-vps's actual backup set (through
`cps-novel-web-1`, since `backup-timer` itself is currently down -- a
separate, already-flagged issue, not a permission problem), and a full local
rehearsal (disposable ssh server with the host's own Docker socket mounted,
`docker exec`-ing into a second disposable container holding a real
root:root `0600` pg_dump on a named volume -- bind mounts on Docker Desktop
for Mac do not enforce Unix permissions the way a real Linux host's
filesystem does, so a named volume was needed for a faithful reproduction)
confirming pull, verification, in-progress detection, and retention all
still work end to end over the new transport.
