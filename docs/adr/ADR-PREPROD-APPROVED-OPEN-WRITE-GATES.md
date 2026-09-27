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
"opening a registrable gate requires explicit registration in a
closed-enum env variable."

**`PREPROD_APPROVED_OPEN_WRITE_GATES`** (comma-separated, optional
surrounding whitespace per entry) lists which write gates this environment
has Owner approval to run non-fail-closed. It is read and enforced by
`preprod_assert_write_gates()` in `scripts/preproduction/lib.sh`, called
from `preflight.sh` in place of the two removed hardcoded checks.

The frozen semantics:

1. The registrable set is a **closed enum, now four names (extended 2026-09-26
   with `sitemap_write`, then 2026-09-28 with `auto_tag_write`)**:
   `catalog_write` (the catalog-sync pair), `promo_write` (the
   promo-link-claim pair), `sitemap_write` (`FEATURE_SITEMAP_AUTO_REFRESH` /
   `SITEMAP_AUTO_REFRESH_ALLOW_WRITE`), and `auto_tag_write`
   (`FEATURE_NOVEL_TAG_AUTO` / `AUTO_WRITE_AUTHORIZED`, see the 2026-09-28
   section below for that pair's different value domain). Any other token in
   the list -- a typo, a name for a gate not on this list, anything -- is a
   hard failure (`reason=approved_open_write_gate_unknown`), naming the
   offending value. Every other write gate this repository already
   hard-closes (`article_writes`,
   the tracking write gate, two-factor enforcement) is untouched by this
   change and keeps its unconditional `false` check.
2. Each registrable gate's two variables must each be exactly one of that
   pair's two legal literal strings, case-sensitively -- `"true"`/`"false"`
   for three of the four pairs, `"true"`/`"false"` and `"YES"`/`"NO"` for
   `auto_tag_write`. Anything else -- `"TRUE"`, `"1"`, `"yes"`, empty, or
   simply unset -- is invalid (`catalog_write_invalid` /
   `promo_write_invalid` / `sitemap_write_invalid` /
   `auto_tag_write_invalid`), whether or not the gate is registered. Unset
   does not default to the closed value: the point of these two variables is
   to say explicitly what state the host is in, and
   a missing variable says nothing.
3. A registered gate may sit in any combination of its two variables,
   including `FEATURE_*=true` with `*_ALLOW_WRITE=false` (catalog sync's
   dry-run/probe-only mode) or both `false` (registered but not actually
   turned on yet). Registration approves "this gate is allowed to be in a
   non-closed state this cycle," not one specific combination.
4. An unregistered gate must still have both variables exactly `false`,
   with the pre-existing `reason=catalog_write` / `reason=promo_write`
   codes, plus `reason=sitemap_write` for sitemap, so existing monitoring
   or runbooks keyed on the old reason strings keep
   working unchanged.
5. On success, preflight now prints an extra evidence line before
   `PREPROD_PREFLIGHT=PASS`:
   `PREPROD_WRITE_GATES=PASS approved=<list|none> open=<list|none>`.

The original 2026-09-23 `infra/preproduction/preprod.env.example` update matched the target
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

- Opening any write gate beyond `catalog_write` / `promo_write` / `sitemap_write` still
  requires a code change (extending the enum in
  `preprod_assert_write_gates()`) and Owner approval -- registering an
  unlisted name in the env file alone does nothing but fail preflight.
- Historical 2026-09-23 migration (superseded for current upgrades by the
  2026-09-26 upgrade order below): before deploying that version on the target host, the
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


## 2026-09-26 extension: sitemap registration and upgrade order

The repository's version registry records Owner approval at 2026-09-26
00:44 +0900 under v0.4.3: append `article.generate.v1`,
`article.generate.batch.v1`, `article.generate.batch.v2`, `sitemap_refresh`
and open both sitemap flags. Its v0.4.4 snapshot records those settings
retained. These are historical release records, **not a fresh host check**.
The template now reproduces that approved profile; registration extends the
existing shell enum, without adding a second runtime registry.

`sitemap_write` follows the same strict literal boolean and registration
rules as catalog/promo. Either flag true requires registration, including
both single-sided combinations; registration permits all four combinations.
The runtime TS helpers still parse only exact `"true"`; malformed or absent
values fail closed there, while preflight rejects them as
`sitemap_write_invalid` to surface configuration mistakes. Runtime writing
still requires both flags. Registration is a deployment approval check,
not another runtime feature flag, so it is not passed into app containers.
Compose already passes the two sitemap flags to web and worker, with false
fallbacks; scheduler does not consume them.

Before deploying the new preflight, an authorized operator must back up the
shared host env and append `sitemap_write` to its existing approved list
(expected historical value: `catalog_write,promo_write,sitemap_write`).
Preserve all existing approved entries and actual switch values; do not
close an approved gate merely to make preflight pass. Inspect the env diff,
then run the new preflight and retain its approved/open evidence. This work
only supplies code and instructions: no host access or env change occurred.

Order matters: the old two-name preflight rejects the new name as unknown.
Adding the entry and invoking the new release must therefore be coordinated;
do not run the old preflight between them. A rollback that invokes an older
checkout needs an Owner-reviewed env compatibility plan (the old enum will
reject `sitemap_write`); prefer rolling forward. Removing registration is
not authorization to leave the sitemap gate unmanaged on an older release.

## 2026-09-28 extension: `auto_tag_write` registration (no host state change)

Context: the front-end auto-tag round's first step (a read-only quality
evaluation of the text classifier, `scripts/tagging-auto-preview.ts` --
never writes a tag, never runs a backfill, never flips a flag) also asked to
convert `preflight.sh`'s hard, unconditional rejection of an open
`FEATURE_NOVEL_TAG_AUTO`/`AUTO_WRITE_AUTHORIZED` pair into the same
registration discipline `catalog_write`/`promo_write`/`sitemap_write`
already use, so that a *future* Owner approval to open the gate only needs
an env registration, not another `preflight.sh` code change on the critical
path. This extension supplies exactly that registration plumbing. It does
**not** open the gate, does not change any value on the target host, and is
not itself the Owner approval that would be required to open it.

The registrable enum is now **four names**: the three above plus
`auto_tag_write`, covering `FEATURE_NOVEL_TAG_AUTO` /
`AUTO_WRITE_AUTHORIZED`. Its validity check differs from the other three in
one respect worth calling out explicitly: `FEATURE_NOVEL_TAG_AUTO` still
uses the exact `"true"`/`"false"` domain every other registrable gate's
`FEATURE_*` variable uses, but `AUTO_WRITE_AUTHORIZED`'s domain is exact
`"YES"`/`"NO"` -- the pre-existing production Owner gate convention
(`isAutoTagWriteAuthorized`, `src/lib/flags/feature-flags.ts`; see also
`docs/governance/feature-flag-registry.md` and ADR-P2-06-5-TAGGING-V3.md §11),
not a new value shape invented for this registration. Anything else on
either variable -- unset, empty, `"true"`/`"false"` on the wrong side, any
casing variant -- is `auto_tag_write_invalid`, whether or not the gate is
registered, matching the other three gates' "unset is not the same as
false" rule. Either variable in its open state (`FEATURE_NOVEL_TAG_AUTO =
"true"` or `AUTO_WRITE_AUTHORIZED = "YES"`) while unregistered is
`reason=auto_tag_write`.

**Preprod's actual values are unchanged by this extension**:
`FEATURE_NOVEL_TAG_AUTO=false`, `AUTO_WRITE_AUTHORIZED=NO`, and
`auto_tag_write` is deliberately **not** appended to
`PREPROD_APPROVED_OPEN_WRITE_GATES` in `infra/preproduction/
preprod.env.example` or on the target host -- registration is not required
until Owner actually approves opening the gate. Unlike the sitemap
extension above, this means deploying the preflight version that ships this
extension needs **no** coordinated host env edit beforehand: the gate stays
closed and unregistered, `preprod_assert_write_gates()` still returns
`approved=catalog_write,promo_write,sitemap_write
open=catalog_write,promo_write,sitemap_write` (auto_tag_write absent from
both lists) against the current host env, exactly as before this change.

The upgrade-order lesson from the sitemap extension still applies for
*next* time, though: when Owner does approve opening `auto_tag_write`, the
target host's `PREPROD_APPROVED_OPEN_WRITE_GATES` must be updated to
include it, and that host env edit must land before -- or in the same
deploy window as -- the first `preflight.sh` run that would observe the
gate open (i.e. before `FEATURE_NOVEL_TAG_AUTO`/`AUTO_WRITE_AUTHORIZED` are
actually flipped). Getting that order backwards fails the very next
`deploy()`/`rollback()` with `reason=auto_tag_write`, the same failure mode
`catalog_write`/`promo_write` hit in 2026-09-22/23 before this ADR existed.
This extension ships the registration path ahead of time specifically so
that future sequencing problem does not recur -- but it does not eliminate
the need to sequence the *actual* approval correctly when it happens.

Every other invariant from the 2026-09-23/09-26 sections above (closed
enum tied to a code change, strict literal booleans, dry-run combinations
legal once registered, the `PREPROD_WRITE_GATES=PASS approved=...
open=...` evidence line contract, pure-function testability by sourcing
`lib.sh`) applies unchanged to `auto_tag_write`.

## 2026-09-28：公网化登记扩展（代码准备，不代表开闸）

封闭枚举新增 `indexnow_outbox`、`indexnow_delivery`，只允许在 SITE_URL 为
`https://pulsenovels.com` 且后台为 `https://zbcwf.pulsenovels.com` 的正式模式登记。
预生产仍要求 IndexNow 四项严格 false，且不得登记这两项。正式模式未登记的组也必须双 false。
登记后保持既有语义：每项只能严格 true/false，可关闭、dry-run 或全开。

`indexnow_delivery` 登记依赖 `indexnow_outbox` 登记，并必须与轻量白名单包含
`indexnow_delivery` 完全一致（同步添加、同步撤销）；不以当前双开关值替代登记状态。
主通道任何时候都禁止两个 IndexNow 类型，自动标签的 true/false + YES/NO 语义不变。

preflight 输出 `PREPROD_SITE_MODE=preprod|public`，模式由既有 SITE_URL 推导，无新增 env。
实际开闸仍按工单 6 分步审批；本补丁和切换日均不登记、不打开 IndexNow。
