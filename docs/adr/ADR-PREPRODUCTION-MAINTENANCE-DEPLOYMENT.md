# ADR: Preproduction maintenance deployment and immutable identity

Status: accepted by Owner for Phase 2B implementation (2026-09-20)

## Decision

The preproduction edge is Ubuntu Host Nginx 1.24.x. It proxies directly to
`127.0.0.1:3000`; no container Nginx is added. Public and admin hosts are
`www.bangbangji.cloud` and `zbcwf.bangbangji.cloud`. Both require Basic Auth
before application content and emit `X-Robots-Tag: noindex, nofollow,
noarchive`. ACME challenge files are the only anonymous content on a known
host. Unknown hosts are rejected.

Releases use one stable Compose project (`cps-novel`), one PostgreSQL volume
(`cps_novel_postgres_data`), one sitemap volume (`cps_novel_sitemap_static`),
one runtime network (`cps_novel_runtime`), and stable secrets under
`/opt/cps-novel/shared`. Release directories and future domain names cannot
rename them. `current` is an operator convenience symlink, never a traffic
switch.

The release artifact is authoritative only as an approved 40-hex commit plus
registry `repo@sha256:...` digest. `package.json` remains `0.1.0` while Git has
tag `v0.2.0`; Phase 2B does not change either. A mutable `0.1.0-*` tag is not
sufficient release identity.

Deployment is a single-instance maintenance sequence: preflight, maintenance
on, Scheduler stop, Worker drain/stop, old Web stop, separately approved
migration, new Web start, health/version/database/auth checks, Worker start,
Scheduler last, maintenance off. Any failure remains in maintenance.

Application rollback is permitted only after an explicit determination that
the previous app is compatible with the current schema. It never performs a
down migration. Database restore is a separate incident procedure.

Secret access is classified by `scripts/preproduction/secret-consumers.tsv`,
not by the inventory alone. File-backed Docker secrets retain host numeric
ownership and ACL semantics: application consumers are `1001:1001`, the
PostgreSQL init consumer is `999:999`, Host Nginx is `33:33`, the deploy-only
curl config is `1000:1000`, and the backup timer's non-server command remains
root. Named POSIX ACLs grant each container/host consumer only its own files;
`www-data` receives traverse-only ACLs on the fixed parent directories and is
not added to the deployment group. Rootless Docker or user-namespace remapping
is unsupported and fails preflight because those modes invalidate direct host
UID/GID reasoning.

## Consequences

- Short planned downtime is accepted; Phase 2B does not create blue/green.
- Certbot owns certificate material. The deployment tool owns the rendered
  site config. Manual edits to the installed generated config are unsupported.
- Host-only secret validation never represents consumer access verification;
  a release requires positive and cross-consumer negative probes using the
  already-loaded approved application image with registry pulls disabled.
- Phase 2C must resolve the package/tag version drift before production
  release policy can use a human version label.

> **Follow-up (2026-09-23, Owner decision)**: the package/tag version drift noted
> above has been resolved — `package.json`, the env templates, and the image tag
> prefix are unified at `v0.3.0`. Release identity remains approved commit +
> config digest, unchanged by this.
