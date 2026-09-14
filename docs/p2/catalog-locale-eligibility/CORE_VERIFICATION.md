# Catalog batch locale eligibility — core verification

## Baseline and implemented behavior

- Baseline commit: `166fa53e0a19fc497ea16025fc13a99b1dcfeeed`.
- Added one shared, side-effect-free locale eligibility rule. The catalog parent and the core Novel materialization path use the same exact `SITE_LOCALES` membership rule; the core continues to re-check immediately before its protected business write.
- New `novel_materialize` parents persist enumeration policy v2 and pre-classify `missing_locale` / `unsupported_locale` as blocked without creating leaf items. Historical versionless payloads remain v1. Other operations persist v1, and v2 is rejected for non-materialization operations.
- Policy version is server-selected and persisted in parent payload/result and queue/materialization audits. It is excluded from the public enqueue input and the legacy business-input fingerprint.
- Review correction: the fingerprint factory now filters runtime objects through the legacy business-field allowlist before canonicalization. Runtime-injected policy values or unknown metadata cannot select the policy or cause a replay mismatch; valid legacy field order and map sorting remain unchanged.
- No database schema, source locale registry/mapping, slug behavior, source data, or historical task state was changed.

## Verification evidence

### Focused backend verification

The final focused run passed 20 tests across the shared locale rule and catalog handler payload contract:

```text
Test Files  2 passed (2)
Tests       20 passed (20)
```

Coverage includes missing/blank locale, unsupported `fil` / `tr` / `it` / `ms`, supported `en` / `ru` / `zh-Hant`, exact-match behavior, invalid policy versions, and rejection of v2 on non-materialization operations.

### Disposable PostgreSQL 16.14 verification

`scripts/run-catalog-batch-postgres-verification.sh` passed all 17 integration tests against a newly created disposable PostgreSQL 16.14 database:

```text
Test Files  1 passed (1)
Tests       17 passed (17)
CATALOG_BATCH_SCALE_METRIC count=12051 materializeMs=2576
CATALOG_BATCH_DICTIONARY_DRIFT=0
CATALOG_BATCH_POSTGRES_VERIFICATION=PASS
CATALOG_BATCH_DISPOSABLE_DATABASE_CLEANED=yes
```

This run covered mixed and all-blocked batches, mutually exclusive submitted/ineligible/already-linked/blocked accounting, linked rows with missing locale, ineligible rows with unsupported locale, repair followed by a new batch, versionless v1 replay, runtime metadata filtering, a locale change after enumeration, 12,051-row pagination, Repeatable Read membership, rollback, fencing, and active-scope behavior.

### Full repository verification

The sandboxed full `npm test` run produced:

```text
Test Files  1 failed | 388 passed | 21 skipped (410)
Tests       1 failed | 4924 passed | 200 skipped (5125)
```

The only failure was the test that invokes the real Docker Compose binary for a read-only catalog-gate status query. It failed because the sandbox denied access to `/Users/chenweifeng/.docker/run/docker.sock`. That exact test was then run outside the sandbox with Docker socket access and passed:

```text
Test Files  1 passed (1)
Tests       1 passed | 67 skipped (68)
```

No test was changed or exempted. Complete logs:

- `/tmp/cps-novel-catalog-locale-full-test.log`
- `/tmp/cps-novel-catalog-locale-docker-guard-rerun.log`

The final `npm run lint` completed with zero errors and four warnings: one unused parameter in the task-copy UI helper and three existing unused test parameters in IndexNow tests. Complete log: `/tmp/cps-novel-catalog-locale-lint.log`.

`npm run typecheck` and `git diff --check` also passed during final core verification.

## UAT and release status

- The UAT PostgreSQL container was observed in `Restarting` state during the preceding read-only analysis. This implementation did not restart it or query it destructively.
- This change has not been deployed to UAT, and no UAT batch rerun has been executed. UAT is therefore not recorded as passed.
- No source locale backfill was executed. Unknown language codes, mapping-conflict rows, and unsupported product locales remain unchanged and will be reported as blocked by new v2 parents.
- No commit or push was performed.
