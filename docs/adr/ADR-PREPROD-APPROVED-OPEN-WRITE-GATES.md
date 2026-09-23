# ADR: Preprod write gates move from always-closed to explicit, closed-enum registration

Status: accepted by Owner (2026-09-23)

## Context

`scripts/preproduction/preflight.sh` has, since Phase 2B, required a fixed
list of write gates to be exactly `"false"` on both of their paired
variables (`FEATURE_*` and the matching `*_ALLOW_WRITE`), including the
catalog-sync pair (`FEATURE_NOVEL_CATALOG_SYNC` /
`NOVEL_CATALOG_SYNC_ALLOW_WRITE`) and the promo-link-claim pair
(`FEATURE_PROMO_LINK_CLAIM` / `PROMO_LINK_CLAIM_ALLOW_WRITE`). That rule was
correct for as long as preproduction (`bangbangji.cloud`, a protected,
non-public host, not production) held zero business data: any write gate
being open there had no legitimate justification, so failing closed was
strictly safer than trusting a flag.

That precondition ended on 2026-09-22. Owner explicitly approved and opened,
directly on the target host's shared env
(`/opt/cps-novel/shared/env/preprod.env`, which `release.sh`'s preflight
never overwrites):

- the catalog-sync write gate (2026-09-22);
- the promo-link-claim write gate, the worker task allowlist entries
  (`catalog_scan`, `promo_link.claim.v1`, `batch.materialize.v1`,
  `novel.materialize.v1`), and the `promo:claim` admin capability grant to
  exactly one identity via `PROMO_CLAIM_USER_IDS` (2026-09-23).

`release.sh` runs `preflight.sh` on both `deploy()` (line ~72) and
`rollback()` (line ~167). With the old always-`false` rule still in the
codebase, the very next deploy or rollback attempt against this host fails
with `PREPROD_PREFLIGHT=FAIL reason=catalog_write`, even though the open
state is exactly what Owner approved. The path of least resistance at that
point is to flip the two variables back to `false` to make preflight pass
again -- which silently turns off functionality Owner just turned on, with
no code change and no review recording that it happened.

Separately, the repository's own template,
`infra/preproduction/preprod.env.example`, still shipped both pairs as
`false` and had no `PROMO_CLAIM_USER_IDS` / `PROMO_CLAIM_ROLES` entries at
all. A host provisioned fresh from that template would not reproduce the
approved 2026-09-22/23 state, and a diff between template and host would
read as unexplained drift rather than as a documented, approved delta.

## Decision

Replace "these two gates' variables must always equal `false`" with
"opening either of these two gates requires explicit registration in a new,
closed-enum env variable."

**`PREPROD_APPROVED_OPEN_WRITE_GATES`** (comma-separated, optional
surrounding whitespace per entry) lists which write gates this environment
has Owner approval to run non-fail-closed. It is read and enforced by
`preprod_assert_write_gates()` in `scripts/preproduction/lib.sh`, called
from `preflight.sh` in place of the two removed hardcoded checks.

The frozen semantics:

1. The registrable set is a **closed enum of exactly two names**:
   `catalog_write` (the catalog-sync pair) and `promo_write` (the
   promo-link-claim pair). Any other token in the list -- a typo, a name for
   a gate not on this list, anything -- is a hard failure
   (`reason=approved_open_write_gate_unknown`), naming the offending value.
   Every other write gate this repository already hard-closes
   (`indexnow_outbox`, `indexnow_delivery`, `auto_tagging`,
   `article_writes`, the tracking write gate, two-factor enforcement) is
   untouched by this change and keeps its unconditional `false` check.
2. Each registrable gate's two variables must each be the literal string
   `"true"` or `"false"`, case-sensitively. Anything else -- `"TRUE"`,
   `"1"`, empty, or simply unset -- is invalid
   (`catalog_write_invalid` / `promo_write_invalid`), whether or not the
   gate is registered. Unset does not default to `false`: the point of
   these two variables is to say explicitly what state the host is in, and
   a missing variable says nothing.
3. A registered gate may sit in any combination of its two variables,
   including `FEATURE_*=true` with `*_ALLOW_WRITE=false` (catalog sync's
   dry-run/probe-only mode) or both `false` (registered but not actually
   turned on yet). Registration approves "this gate is allowed to be in a
   non-closed state this cycle," not one specific combination.
4. An unregistered gate must still have both variables exactly `false`,
   with the pre-existing `reason=catalog_write` / `reason=promo_write`
   codes, so any monitoring or runbook keyed on those reason strings keeps
   working unchanged.
5. On success, preflight now prints an extra evidence line before
   `PREPROD_PREFLIGHT=PASS`:
   `PREPROD_WRITE_GATES=PASS approved=<list|none> open=<list|none>`.

`infra/preproduction/preprod.env.example` is updated to match the target
host's actual 2026-09-22/23 state: both pairs `true`,
`PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,promo_write`, the worker
allowlist extended with the four new task names, and
`PROMO_CLAIM_ROLES=`/`PROMO_CLAIM_USER_IDS=REQUIRED_ADMIN_IDENTITY_UUID`
added following the repo's existing `REQUIRED_*` placeholder convention
(the real UUID is per-environment and lives only on the target host).
`promo:claim` is granted by identity, not by role, because
`src/lib/auth/capabilities.ts` defines it with `defaultRoles: []` --
leaving `PROMO_CLAIM_ROLES` empty and naming only the admin identity in
`PROMO_CLAIM_USER_IDS` is what keeps the grant scoped to exactly one
account rather than an entire role.

## Rejected alternatives

- **Close the gates before every deploy/rollback, reopen them after.**
  Rejected: this makes "the feature is on" and "the feature is off during
  every release window" indistinguishable from a real incident, doubles the
  chance of forgetting the reopen step, and leaves no record of who
  approved the reopen or when.
- **Delete the write-gate checks from preflight entirely.** Rejected: this
  removes the fail-closed guard for every OTHER write gate along with the
  two that needed to change, trading a real gap for a narrower one that
  could have been closed without touching them.
- **Accept any string in `PREPROD_APPROVED_OPEN_WRITE_GATES`, not a closed
  enum.** Rejected: the registration list itself lives in an env file
  anyone with host access can edit. Without a closed enum tied to code,
  registering a new write gate would be a one-line env edit with no review
  -- exactly the unreviewed-drift failure mode this change exists to close.
  The closed enum forces opening any future write gate through a code
  change to `preprod_assert_write_gates()` plus Owner approval, not just an
  env edit.

## Consequences

- Opening any write gate beyond `catalog_write` / `promo_write` still
  requires a code change (extending the enum in
  `preprod_assert_write_gates()`) and Owner approval -- registering an
  unlisted name in the env file alone does nothing but fail preflight.
- Before deploying this version (or any later one) on the target host, the
  operator must add `PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,
  promo_write` to `/opt/cps-novel/shared/env/preprod.env`. Skipping this
  step makes the very next `preflight.sh` run fail with
  `reason=catalog_write` (catalog is checked first), even though the
  target host's actual `FEATURE_NOVEL_CATALOG_SYNC` /
  `NOVEL_CATALOG_SYNC_ALLOW_WRITE` values are unchanged and were already
  Owner-approved.
- **Residual risk, not fixed by this change: the registration key does
  nothing for a rollback to a release older than this one.**
  `scripts/preproduction/release.sh`'s `rollback()` requires the invoking
  checkout's `HEAD` to equal the target (older) commit
  (`invoke_from_previous_release`) and runs `preflight.sh` *from that
  checkout* -- the older release's own copy of the script, which has never
  heard of `PREPROD_APPROVED_OPEN_WRITE_GATES` and still hard-requires
  both catalog/promo pairs to be exactly `"false"`. So rolling back past
  this commit while catalog/promo are open on the target host always fails
  `reason=catalog_write`, key or no key. The only ways through are (a)
  Owner-approved, temporary `false` on all four catalog/promo variables in
  the shared env before that rollback runs -- which also means catalog
  sync and promo-link claim stop working post-rollback, matching what the
  older release itself expects -- or (b) roll forward instead of back.
  This is not something to fix by patching the older release's checkout.
- `preprod_assert_write_gates()` is a pure function of environment
  variables with no side effects, so it can be (and is) tested directly by
  sourcing `lib.sh`, without running the rest of preflight or touching any
  target-host secret.
- The evidence line `PREPROD_WRITE_GATES=PASS approved=... open=...` is now
  part of preflight's observable stdout contract for anyone parsing deploy
  logs; a future change to `preprod_assert_write_gates()` that removes or
  reformats it should be treated as a breaking change to that contract.
