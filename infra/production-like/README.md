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

## One targeted preview

The permanent worker deliberately does not consume preview tasks. After the
parser tests pass, a credential is validated, and both read capabilities are
enabled through the audited admin entry, open the explicit catalog apply
window and run exactly one pending item:

```bash
scripts/x8-production-like.sh gate catalog-write on
scripts/x8-production-like.sh preview-one \
  --task-id <uuid> --item-id <uuid> --actor <operator-handle>
scripts/x8-production-like.sh gate catalog-write off
```

This starts a disposable worker using `worker_app`, an exact preview-only
allowlist and the ordinary worker cycle. The target only narrows pending
candidates; all gates, capabilities, leases, heartbeat and fenced finalization
remain in force. The permanent worker's allowlist is not changed. The operator
handle must be 1–64 ASCII letters/digits/underscores/hyphens, starting with a
letter; never put credentials or free-form evidence in it.

The command logs its target, operator, unique worker identity and outcome. It
only reports success after finding the corresponding committed worker audit.
An unavailable target, competing lease or intervening normal recovery cycle
returns `not_consumed` and a nonzero exit status; it never falls back to another
book or automatically loops. For a new refresh, use the existing preview task
factory (including its freshness checks), then target its item.

Preview pending items currently have **no task TTL**. The catalog/claim six-hour
TTL does not apply to them. Do not drain an unrelated backlog or assume waiting
will expire it. Preview TTL and the C5 “refresh this book” UI are separate
follow-ups; neither is implemented by this command.

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
