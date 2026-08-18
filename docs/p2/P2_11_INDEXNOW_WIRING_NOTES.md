# P2-11 (Stream E, IndexNow) — event-source wiring notes

**Status:** informational — this Stream does not modify any call site outside
`src/lib/indexnow/`, `worker/handlers/indexnow-delivery.ts`, `worker/index.ts`
(registry append), `src/lib/flags/feature-flags.ts` (flag append), and
`src/app/indexnow-key.txt/route.ts`. The one integration edit below is left
for the round's integrator per this Stream's task book ("调用点补参由整合方统一
做").

## What this PR ships that plugs into the dispatcher

`src/lib/indexnow/dispatch-handler.ts` exports `enqueueIndexNow`, matching
`PublicationDispatchHandlers.enqueueIndexNow`'s frozen signature
(`docs/p2/V020_FOUNDATION_INTERFACES.md` §5) exactly:

```ts
enqueueIndexNow: (
  input: DispatchFirstPublicPublicationInput,
  db: PrismaClient | Prisma.TransactionClient,
) => Promise<EnqueueIndexNowFirstPublishResult>
```

It is self-gating (no-ops unless `FEATURE_INDEXNOW_OUTBOX` +
`INDEXNOW_OUTBOX_ALLOW_WRITE` are both `"true"`), so wiring it in is safe at
any time regardless of rollout state.

## Actual entry-point count in this codebase today: 1, not 7–9

`P2-11.md` §4 found CPS's "seven入口" historical framing stale — the real
CPS baseline (d77c3b9) has 9 function-level call sites of
`dispatchFirstPublicPublication` across 6 files, because CPS's `Article` has
blog/category/tag/drama-default-article polymorphism and several redundant
status-change call paths. **None of that polymorphism exists in cps-novel.**
Grepping this worktree today (`grep -rn "dispatchFirstPublicPublication("
src/ worker/ scripts/`) finds exactly one real call site:

| # | File:line | Trigger | Status |
| --- | --- | --- | --- |
| 1 | `src/server/publish-gate/service.ts:361-369` (inside `applyPublishTransition`) | Any Article's first successful transition to `published` — interactive admin publish, `publishArticlesBatch`'s per-item loop, and the future `publishDueScheduledArticles` scheduled-publish sweep all funnel through this one gated function (`src/server/publish-gate/service.ts`'s module header: "the only function anywhere in this codebase that may write `Article.status = "published"`") | **Already wired, currently called with no `handlers` argument** — a safe no-op per the interface freeze doc |

That is the entire mapping table for this codebase; there is no second,
third, or ninth entry point to enumerate because there is no second write
path to `published` (`tests/backend/publish-gate/no-bypass.test.ts` statically
enforces that). `withdrawNovel`/`takedownNovel`/`restoreNovel`
(`applyNovelRightsTransition`) do **not** call the dispatcher — matching
CPS's `offlineDrama`/`takedownDrama` never calling it either
(`P2-11.md` §4: "IndexNow 语义上不该对下线内容发通知").

## The one integration edit (not made by this PR)

```diff
--- a/src/server/publish-gate/service.ts
+++ b/src/server/publish-gate/service.ts
@@
+import { enqueueIndexNow } from "@/lib/indexnow/dispatch-handler";
@@
   if (txResult.outcome === "published" && txResult.wrote && txResult.firstPublish) {
     await dispatchFirstPublicPublication(
       {
         articleId: txResult.articleId,
         novelId: txResult.novelId,
         locale: txResult.locale,
         source: dispatchSource(input.actor),
       },
       db,
+      { enqueueIndexNow /* , enqueueSitemapRefresh — Stream D's handler, once it lands */ },
     );
   }
```

`src/server/publish-gate/service.ts` is Stream A's file (not this Stream's to
edit per this round's file-ownership rule); this diff is handed to the
integrator to apply once Stream D's `enqueueSitemapRefresh` handler is also
ready, so both handlers land in the same edit rather than touching this
shared call site twice.

## What is NOT wired by this PR (explicitly out of scope, precedent-matched)

- **A periodic trigger for `sweepDueIndexNowDeliveries`** (`src/lib/indexnow/
  sweep.ts`) — no `ScheduleRun`/cron registration exists. This mirrors the
  precedent `src/server/publish-gate/service.ts`'s own
  `publishDueScheduledArticles` sets: "Wiring this onto an actual
  scheduler/GenericTask trigger is out of this PR's scope ... this function
  is the gated primitive a future trigger calls." Until wired, retries and
  manually-released defers do not automatically progress — first-publish
  enqueue still creates its own delivery item immediately, so day-one
  delivery works without the sweep.
- **A backfill/manual admin surface for `releaseDeferredIndexNowOutbox`** —
  only the library function exists; no Server Action/CLI flag calls it yet
  (parallel to `scripts/indexnow-backfill-apply.ts` existing as a CLI without
  an admin-UI equivalent).

## Known, already-documented shared blocker: D-7 empty locale whitelist

`isNovelIndexNowEligible` (`src/lib/indexnow/eligibility.ts`) gates on
`isPublishableLocale`, which is `Object.freeze([])` today pending the D-7
first-locale-whitelist decision (`src/lib/locale/locale-canonical.ts`). This
means **`enqueueIndexNowFirstPublish` returns `{ outcome: "ineligible" }` for
every Article right now**, by the same shared, already-documented mechanism
Stream D's sitemap generator is blocked by
(`P2-07-12-移植审计-2026-08-12/P2-11.md` §9, `DECISION-CHECK.md` 核查4). This is
not a defect introduced by this Stream — it resolves automatically the day
D-7 is decided and `PUBLISHABLE_LOCALES` gets its first entry, with zero code
change in this Stream's modules.
