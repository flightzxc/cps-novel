# ADR: Preprod edge -- maintenance-exempt health, minimal admin assets, bootstrap stage

Status: accepted for the nginx/edge lane of the Phase 2B preproduction
release-engineering PR (2026-09-21)

## Context

An offline Docker matrix run against the then-current preprod nginx
template (`infra/preproduction/nginx/cps-novel-preprod.conf.template`)
measured three problems.

First, with the maintenance marker present, every probed path returned
503 -- including `/api/health` on both hosts, authenticated and
anonymous. That is deploy-blocking: `scripts/preproduction/release.sh`
turns maintenance on before starting the new Web container and only turns
it off after `verify-release.sh` passes, and that script authenticates
against `/api/health` to confirm build identity and database status. A
health check that is itself gated by maintenance cannot verify a release
that begins its life inside a maintenance window.

Second, with the maintenance marker absent, the admin host's
`/_next/static/example.js` returned 404 for both anonymous and
authenticated requests -- admin JS/CSS is unreachable -- while the public
host's equivalent path returned 200 authenticated (proving the test rig
and credentials were fine). Separately, `zbcwf.bangbangji.cloud
/api/health-anything` returned 200 authenticated, showing that the admin
host's `location ^~ /api/health` is a prefix match and therefore matches
more than the exact path it was meant to guard.

Third, `nginx -t` failed with `a duplicate default server for
0.0.0.0:80` when Ubuntu's stock `sites-enabled/default` (which carries its
own `listen 80 default_server;`) was present alongside the preprod
template, and `scripts/preproduction/install-nginx.sh` had no step that
accounted for that file at all, nor any way to recover if `nginx -t`
failed after the new config was already written to its live path.

## Decision

**1. `/api/health` is exempt from the maintenance gate, but still requires
Basic Auth.** The maintenance check in
`cps-novel-preprod-protected.conf` is an `if` that runs in nginx's
rewrite phase. `auth_basic` is evaluated later, in the access phase.
Phase ordering is fixed by nginx's request-processing model, not by the
order directives appear in a file, so there is no way to make `auth_basic`
run before that `if` within the same snippet -- the fix has to be a
different snippet. `cps-novel-preprod-protected-nomaintenance.conf` is
byte-for-byte the protected snippet minus that one `if`: same
`auth_basic`, same `auth_basic_user_file`, same security-header include.
It is deliberately not a general-purpose snippet -- using it on a
business or admin location would mean that location stays reachable
throughout a maintenance window, which defeats the point of maintenance
mode. Its only sanctioned use is the two `location = /api/health` blocks
(public and admin hosts), which is also why both were converted from
whatever match type they had to an exact `=` match: the point is to name
one specific path and gate nothing else through it.

On the admin host, `location ^~ /api/health` becoming `location =
/api/health` closes the same class of bug the measured evidence found
(`/api/health-anything` matching a prefix): an exact match cannot match
anything but that literal path, regardless of maintenance state.

That exact match, however, also stopped covering two legitimate sub-routes
the old prefix used to reach: `/api/health/worker` and `/api/health/backup`
(see `src/app/api/health/`), which without further changes fall through to
the admin host's catch-all `location /` and 404. A later adversarial
review caught this as a functional regression, not just a security fix:
the admin host gets a second, narrower block, `location ^~
/api/health/` (WITH a trailing slash), which restores that coverage
without reopening the prefix-match hole -- a literal-string prefix match
on `/api/health/` cannot match `/api/health-anything` (no trailing
slash), so the original bug stays closed. Unlike the exact-match block,
this one uses the maintenance-gated `cps-novel-preprod-protected.conf`,
not the nomaintenance snippet: these sub-routes have no requirement to
stay reachable through a maintenance window the way the top-level health
check itself does.

**2. The admin host's asset allowlist is exactly one location:
`^~ /_next/static/`.** `src/app/(admin)` and `src/app/(admin-auth)` were
checked for Next's image-optimizer component; there are zero imports of it
in either tree, and `site-settings-client.tsx` (around line 333) has an
explicit comment recording that a plain HTML image tag is used there on
purpose. That means the image-optimizer route has no admin caller to
serve, so it is not added to the allowlist -- adding it would open a
route with no legitimate admin traffic for no benefit. The site-icon path
was evaluated the same way: nothing in the admin app depends on it
resolving, so a missing icon is cosmetic and not worth a second location.
`/_next/static/` mirrors the public host's existing location exactly
(same `protected.conf` snippet, same rate-limit zone, same cache headers)
because static assets have no reason to be exempt from maintenance the way
`/api/health` does -- an admin session mid-maintenance-window is not a
case this deployment tooling needs to support.

**3. A separate, HTTP-only bootstrap stage owns first contact with a new
host, and installing it (or the full config) now hands over Ubuntu's
default site first.** `cps-novel-preprod-bootstrap.conf.template` is
installed before DNS points at the host and before any certificate
exists. It contains no certificate directive (so `nginx -t` passes with
zero certs on disk) and no backend pool or reverse-proxy directive
anywhere (so it is structurally incapable of serving application content,
not just configured not to). Its only job is answering the ACME HTTP-01
challenge on both preprod hostnames; everything else on a known host is a
bare 404 with the security headers attached, and unknown hosts get
nginx's default-server close. `render-nginx.sh --bootstrap` renders it
without the `__UPSTREAM__` substitution the full template needs, since it
has no upstream block to substitute into.

Root cause three (the duplicate-default-server failure) is fixed in
`install-nginx.sh`: the candidate config is rendered (a local temp file)
and the files this invocation is about to overwrite -- snippets and the
site config -- are backed up first; only THEN, and still before `nginx -t`
ever runs, does it check whether `/etc/nginx/sites-enabled/default` exists
and declares `default_server`, and if so record what that file was
(symlink and target, or a plain file, via `cp -a`, which preserves a
symlink as a symlink) under the shared root and remove it. `nginx -t` runs
before `systemctl reload`, so a serving nginx process is never handed an
invalid config; if the test fails, every backed-up path (snippets, site
config, default-site file) is restored, `nginx -t` is re-run to confirm
the restore itself is valid, and only then does the script reload and
report `NGINX_INSTALL=REFUSED reason=nginx_test_failed`. This is a full
rollback of everything the invocation touched, not a partial one.

Two further hardenings to that rollback path, both from a later
adversarial review with a reproduced failure: first, the backup directory
used to be deleted by the same trap that also cleaned up the disposable
rendered-candidate file, registered for `EXIT INT TERM` -- a signal
delivered while `sudo nginx -t` runs as the foreground child is deferred
by bash until that command returns, so the trap could fire and destroy the
backups before the rollback below ever used them, making every "no
backup" read as "this file should not exist" and deleting the live site
config and security snippet. The backup directory (and, if disabled, the
default-site backup/state files) are now only ever cleaned up on a
confirmed-successful exit path, never via a signal trap, and `restore_one`
refuses to delete anything and aborts with `NGINX_INSTALL=REFUSED
reason=backup_dir_missing` if the backup directory itself is gone or
unreadable rather than guessing. Second, if the state this invocation
found was already broken before it ran (e.g. an old site config and the
default site both present, so `nginx -t` fails even after a byte-for-byte
restore), the script now reports that distinctly as `NGINX_INSTALL=REFUSED
reason=rollback_state_invalid` and does not reload -- and keeps the
default-site backup/state files on disk in that case, since they are
removed only after that second `nginx -t` has actually confirmed the
restore is valid, not unconditionally inside the restore step itself.

## Consequences

- `cps-novel-preprod-protected-nomaintenance.conf` is a second place that
  needs to be kept in sync with `cps-novel-preprod-protected.conf` (same
  `auth_basic_user_file` path, same security snippet) whenever either
  changes; a test in
  `tests/backend/runtime/preproduction-deployment-contract.test.ts` checks
  they haven't diverged, but the discipline is still manual.
- `/api/health` responding with an HTTP-level 401 (not 503) throughout a
  maintenance window is now part of the observable contract for anyone
  polling it externally -- a 503 there no longer means "we're deploying",
  it would mean the exemption itself broke.
- The admin allowlist decision is coupled to the current admin codebase
  (zero image-optimizer imports). If a future admin screen adds one, this
  decision needs revisiting before that screen ships, not after.
- IPv6 stays unbound in both the full and bootstrap templates (no
  `listen [::]` anywhere); this is recorded, not an oversight, and depends
  on no AAAA record ever being created for either hostname without first
  revisiting it.
- `install-nginx.sh`'s "test before commit" is implemented as "write
  candidates to their real system paths, then `nginx -t`, with a full
  backup/restore on failure" rather than a fully isolated dry run against
  copies. A genuinely isolated pre-write test is possible in principle
  (build a scratch `nginx.conf` and rewrite every absolute
  `/etc/nginx/snippets/...` include to point at scratch copies) but was
  rejected: rewriting those paths for the test means testing something
  that is not byte-identical to what ships, which is a worse guarantee
  than a real `nginx -t` against the real paths with a proven rollback.
  The load-bearing property -- nginx is never reloaded into an invalid
  config -- holds either way.
- The bootstrap stage is not exercised by `install-nginx.sh --bootstrap`
  going through a real handoff to the full config in this PR; that
  transition (bootstrap live, certificate issued, full config installed
  over it) is an operational sequence for whoever runs the actual DNS
  cutover, not something this lane's Docker matrix can simulate end to
  end.
