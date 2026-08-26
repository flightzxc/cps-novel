# X8 local production-like environment

This topology is intentionally local-only. Its sole public origin is
`https://novel.test`; nginx binds ports 80/443 to `127.0.0.1`, while PostgreSQL
and the application runtime stay unexposed on isolated Docker networks.

## Operator flow

```bash
scripts/x8-production-like.sh setup
scripts/x8-production-like.sh up
scripts/x8-production-like.sh status
scripts/x8-production-like.sh verify
scripts/x8-production-like.sh accept
scripts/x8-production-like.sh down
```

`setup` is the only command allowed to install/trust mkcert or append the
marked `/etc/hosts` entry. `up` refuses to make host changes and refuses to
take ports from another process. `down` preserves data unless the operator
uses the explicitly destructive `down --purge` form.

Catalog starts in `dry-run` state: the feature is enabled and its write gate
is closed. Use the short-lived apply window only after a successful dry-run:

```bash
scripts/x8-production-like.sh gate catalog-write on
# create and finish exactly one bounded apply task
scripts/x8-production-like.sh gate catalog-write off
```

`off` closes both catalog gates. Use `gate catalog-write dry-run` only when a
new authorized acceptance session must reopen read-only upstream calls.

Real MoboReader credentials are entered only through the admin credential
form. They never belong in an env file, CLI argument, shell history, evidence
file, screenshot, or trace. Promo claim, Sitemap auto-refresh, and IndexNow
remain closed throughout X8.

If the bounded catalog sample has no ready upstream promo, first dry-run and
then explicitly apply the isolated fallback. It prefers an existing ready
promo, marks any fallback in `rawLinks` and `OperationAudit`, and refuses to
run outside the X8 project or while promo claim gates are open:

```bash
scripts/x8-production-like.sh promo-fixture \
  --source-item <uuid> --channel-account <uuid> \
  --target-url https://example.test/x8-acceptance
scripts/x8-production-like.sh promo-fixture \
  --source-item <uuid> --channel-account <uuid> \
  --target-url https://example.test/x8-acceptance --apply
```

Runtime material is under `.tmp/x8-production-like/` with owner-only
permissions. Automated acceptance evidence there is transient and redacted;
the reviewed result is recorded in the X8 operations report.
