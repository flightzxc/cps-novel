"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import type { ErrorEnvelope } from "@/contracts";
import {
  requireAdminActionAccess,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";
import {
  PublishLifecycleError,
  publishArticleAsAdmin,
  publishArticlesBatchAsAdmin,
  restoreNovel,
  takedownNovel,
  withdrawNovel,
  type ApplyPublishTransitionResult,
  type RightsTransitionKind,
  type RightsTransitionResult,
} from "@/server/publish-gate";

import { canonicalOrigin, guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";
import { serviceDependencies } from "../../api/admin/_lib/route";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";
import { readPrimaryArticlesForNovels } from "./_lib/read-primary-article";
import { validateReason } from "./_lib/reason-guard";

/**
 * Re-exported, not re-declared: `tests/ui/admin-secret-boundary.test.tsx`
 * forbids any `"use client"` file from naming an `@/server/**` module, even
 * in a type position (a regex over the literal import source, deliberately
 * blind to `import type` — see that test's own comment on the check). This
 * file is `"use server"`, not client-reachable itself, so it is the correct
 * place to be the *only* module in this route that names
 * `@/server/publish-gate`; every client component and shared `_lib` helper
 * that needs one of these shapes imports it from here instead — the exact
 * discipline `../../catalog-sync/_lib/outcome-copy.ts` already documents for
 * the same reason ("keeps the boundary obviously clean rather than merely
 * safe-in-practice").
 */
export type { ApplyPublishTransitionResult, RightsTransitionKind, RightsTransitionResult };
/** `PublishLifecycleError.code`'s six-member union, derived once here — see `./_lib/publish-outcome-copy.ts` for the exhaustive Chinese copy. */
export type PublishLifecycleErrorCode = InstanceType<typeof PublishLifecycleError>["code"];

/**
 * PR-C3 publish/rights-transition triggers.
 *
 * `src/server/publish-gate/service.ts`'s own header is explicit that these
 * functions had zero production callers before this file: "no admin screen
 * calls them yet ... wiring a Server Action now would be untested,
 * unreachable code". This is that wiring, following the exact shape the
 * service header names as its template
 * (`src/app/(admin)/channel-accounts/_actions.ts`) rather than P0-S13/PR-C2's
 * shape: `publishArticleAsAdmin` / `publishArticlesBatchAsAdmin` /
 * `withdrawNovel` / `takedownNovel` / `restoreNovel` all call
 * `requireFreshAdminServiceMutation` *themselves* (same as
 * `src/server/credentials/service.ts`), so — unlike
 * `createContentFromSourceItem`/`createMoboreaderCatalogScanTask`, which
 * carry no authorization of their own — this file never calls
 * `requireFreshAdminServiceMutation` a second time. It only has to mint the
 * ticket via `requireAdminActionAccess` and hand it straight to the service.
 *
 * `entryId` binding is load-bearing and non-negotiable: each service
 * function hardcodes the exact literal `entryId` it will check the ticket
 * against internally (`publishArticleAsAdmin` → `"admin.article.publish"`,
 * `publishArticlesBatchAsAdmin` → `"admin.article.publish_batch"`,
 * `withdrawNovel`/`takedownNovel`/`restoreNovel` → `"admin.novel.withdraw"`/
 * `"admin.novel.takedown"`/`"admin.novel.restore"` respectively, via their
 * shared `applyNovelRightsTransition` helper). The `actionId` requested from
 * `requireAdminActionAccess` below — and the registration in
 * `../../api/admin/_lib/registry.ts` — must therefore match those literals
 * exactly, or `requireFreshAdminServiceMutation`'s entryId check fails every
 * call with `admin_service_authorization_required`.
 */

export type PublishActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | { readonly ok: false; readonly kind: "lifecycle_error"; readonly code: PublishLifecycleErrorCode }
  | {
      readonly ok: false;
      readonly kind: "invalid_input";
      readonly code: "reason_required" | "reason_too_long" | "selection_required";
    };

/**
 * Client-side input guard, not a substitute for anything the service does.
 * `applyNovelRightsTransition`'s own `trimmedReason` throws a bare `Error`
 * (not `PublishLifecycleError`, not `AdminAccessError`) for a blank or
 * over-length reason — routing that through `toErrorEnvelope`'s generic
 * fallback would misreport it as `admin_capability_denied` ("缺少能力位"),
 * which is simply wrong. Validating here, before the service is ever called,
 * gives the operator an accurate message and never reaches that fallback.
 */
class PublishActionInputError extends Error {
  readonly code: "reason_required" | "reason_too_long" | "selection_required";
  constructor(code: PublishActionInputError["code"]) {
    super(code);
    this.name = "PublishActionInputError";
    this.code = code;
  }
}

/**
 * Thin throwing wrapper around `./_lib/reason-guard.ts`'s `validateReason` —
 * that module is the shared source of truth (also used by
 * `../../articles/_components/article-list.tsx`'s row-level "下线" dialog,
 * fix 3 of the C-21/22/23 review); this function just adapts its
 * discriminated result to the throw-based control flow `runNovelAction`
 * below already has for `PublishActionInputError`.
 */
function requireNonBlankReason(reason: string): string {
  const result = validateReason(reason);
  if (!result.ok) throw new PublishActionInputError(result.code);
  return result.reason;
}

async function authorize(actionId: `admin.${string}`, requestId: string) {
  const requestHeaders = await headers();
  const { serviceAuthorization } = await requireAdminActionAccess(
    {
      actionId,
      sessionToken: await readSessionToken(),
      origin: requestHeaders.get("origin"),
      canonicalOrigin: await canonicalOrigin(),
      requestId,
    },
    guardDependencies(),
  );
  if (!serviceAuthorization) {
    // Unreachable given this file's own registrations below (capability is
    // always set) — kept as a fail-closed backstop against a future
    // registration mistake, same posture `channel-accounts/_actions.ts` and
    // `catalog-sync/_actions.ts` both take at this exact spot.
    const { AdminAccessError } = await import("@/lib/auth/errors");
    throw new AdminAccessError(
      "admin_service_authorization_required",
      403,
      "Action is not bound to a capability",
    );
  }
  return serviceAuthorization;
}

async function runNovelAction<T>(
  actionId: `admin.${string}`,
  requestId: string,
  revalidate: readonly string[],
  run: (authorization: AdminServiceAuthorization) => Promise<T>,
  /**
   * Input validation that must reject *before* `authorize()` spends anything
   * scoped to this `requestId` — the per-action rate-limit allowance and the
   * `requestId` idempotency key `requireAdminActionAccess` mints. A reason
   * that is blank client-side is never going to become valid server-side, so
   * paying that cost for it first is pure waste (and, repeated, a way to
   * exhaust the limiter on requests that were never going to do anything).
   * Runs inside the same `try` as everything else, so a thrown
   * `PublishActionInputError` still comes out through the same
   * `invalid_input` branch below — the return shape is unchanged, only the
   * ordering relative to `authorize()` is.
   */
  validate?: () => void,
): Promise<PublishActionResult<T>> {
  try {
    validate?.();
    const authorization = await authorize(actionId, requestId);
    const data = await run(authorization);
    for (const path of revalidate) revalidatePath(path);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof PublishLifecycleError) {
      return { ok: false, kind: "lifecycle_error", code: error.code };
    }
    if (error instanceof PublishActionInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

export async function publishArticleAction(input: {
  novelId: string;
  articleId: string;
  requestId: string;
}): Promise<PublishActionResult<ApplyPublishTransitionResult>> {
  return runNovelAction(
    "admin.article.publish",
    input.requestId,
    [`/novels/${input.novelId}`, "/novels"],
    async (authorization) =>
      publishArticleAsAdmin(
        { authorization, requestId: input.requestId, articleId: input.articleId },
        serviceDependencies(),
      ),
  );
}

export async function withdrawNovelAction(input: {
  novelId: string;
  requestId: string;
  reason: string;
}): Promise<PublishActionResult<RightsTransitionResult>> {
  let reason = "";
  return runNovelAction(
    "admin.novel.withdraw",
    input.requestId,
    [`/novels/${input.novelId}`, "/novels"],
    async (authorization) =>
      withdrawNovel(
        { authorization, requestId: input.requestId, novelId: input.novelId, reason },
        serviceDependencies(),
      ),
    () => {
      reason = requireNonBlankReason(input.reason);
    },
  );
}

export async function takedownNovelAction(input: {
  novelId: string;
  requestId: string;
  reason: string;
}): Promise<PublishActionResult<RightsTransitionResult>> {
  let reason = "";
  return runNovelAction(
    "admin.novel.takedown",
    input.requestId,
    [`/novels/${input.novelId}`, "/novels"],
    async (authorization) =>
      takedownNovel(
        { authorization, requestId: input.requestId, novelId: input.novelId, reason },
        serviceDependencies(),
      ),
    () => {
      reason = requireNonBlankReason(input.reason);
    },
  );
}

export async function restoreNovelAction(input: {
  novelId: string;
  requestId: string;
  reason: string;
}): Promise<PublishActionResult<RightsTransitionResult>> {
  let reason = "";
  return runNovelAction(
    "admin.novel.restore",
    input.requestId,
    [`/novels/${input.novelId}`, "/novels"],
    async (authorization) =>
      restoreNovel(
        { authorization, requestId: input.requestId, novelId: input.novelId, reason },
        serviceDependencies(),
      ),
    () => {
      reason = requireNonBlankReason(input.reason);
    },
  );
}

// ---------------------------------------------------------------------------
// Batch publish — `/novels` list's selection toolbar.
// ---------------------------------------------------------------------------

export type PublishNovelsBatchItem =
  | { readonly kind: "no_article"; readonly novelId: string }
  | {
      readonly kind: "resolved";
      readonly novelId: string;
      readonly articleId: string;
      readonly result: ApplyPublishTransitionResult;
    };

export type PublishNovelsBatchSummary = {
  readonly published: number;
  readonly rejected: number;
  readonly conflict: number;
  readonly notFound: number;
  readonly noArticle: number;
};

export type PublishNovelsBatchOutcome = {
  readonly items: readonly PublishNovelsBatchItem[];
  readonly summary: PublishNovelsBatchSummary;
};

/**
 * Same exhaustiveness discipline as `./_lib/publish-outcome-copy.ts`'s
 * `assertUnreachableCode` / `assertUnreachableKind`: a `default` branch that
 * only type-checks while `ApplyPublishTransitionResult["outcome"]` is fully
 * covered above it. Add a fifth outcome to that union without adding a case
 * here and this switch stops compiling, instead of silently leaving the new
 * outcome uncounted in the batch-publish summary.
 */
function assertUnreachableOutcome(value: never): never {
  throw new Error(`Unhandled publish outcome: ${JSON.stringify(value)}`);
}

function summarize(items: readonly PublishNovelsBatchItem[]): PublishNovelsBatchSummary {
  const summary: { -readonly [K in keyof PublishNovelsBatchSummary]: number } = {
    published: 0,
    rejected: 0,
    conflict: 0,
    notFound: 0,
    noArticle: 0,
  };
  for (const item of items) {
    if (item.kind === "no_article") {
      summary.noArticle += 1;
      continue;
    }
    switch (item.result.outcome) {
      case "published":
        summary.published += 1;
        break;
      case "rejected":
        summary.rejected += 1;
        break;
      case "conflict":
        summary.conflict += 1;
        break;
      case "not_found":
        summary.notFound += 1;
        break;
      default:
        // `item.result` itself — not `.outcome` — is what the switch above
        // has already narrowed to `never` here; re-reading `.outcome` off an
        // already-`never` value is a type error in its own right (`never`
        // has no properties), so the exhaustiveness argument has to be the
        // object the switch discriminated on, same as
        // `assertUnreachableCode(code)` / `assertUnreachableKind(kind)` in
        // `./_lib/publish-outcome-copy.ts` pass the switched-on value
        // itself, not one of its properties.
        assertUnreachableOutcome(item.result);
    }
  }
  return summary;
}

/**
 * Resolves each selected `novelId` to the one Article
 * `publishArticlesBatchAsAdmin` (Article-keyed) actually needs — see
 * `./_lib/read-primary-article.ts` for why that resolution has to happen
 * here rather than inside `src/server/publish-gate` itself — then reports
 * back one outcome per originally-selected novel, `no_article` included, so
 * a caller never has to reconcile a shorter result array against a longer
 * selection.
 */
export async function publishNovelsBatchAction(input: {
  novelIds: readonly string[];
  requestId: string;
}): Promise<PublishActionResult<PublishNovelsBatchOutcome>> {
  return runNovelAction("admin.article.publish_batch", input.requestId, ["/novels"], async (authorization) => {
    const novelIds = Array.from(new Set(input.novelIds));
    if (novelIds.length === 0) throw new PublishActionInputError("selection_required");

    const refs = await readPrimaryArticlesForNovels(novelIds);
    const articleIds = novelIds
      .map((novelId) => refs.get(novelId)?.articleId)
      .filter((articleId): articleId is string => articleId !== undefined);

    const batch = await publishArticlesBatchAsAdmin(
      { authorization, requestId: input.requestId, articleIds },
      serviceDependencies(),
    );
    const resultByArticleId = new Map(batch.results.map((entry) => [entry.articleId, entry.result]));

    const items: PublishNovelsBatchItem[] = novelIds.map((novelId) => {
      const ref = refs.get(novelId);
      if (!ref) return { novelId, kind: "no_article" as const };
      // `articleIds` above is built from this same `refs` map, so
      // `publishArticlesBatchAsAdmin` (via `publishArticlesBatch`'s
      // one-result-per-input-id loop) is guaranteed to return exactly one
      // entry for `ref.articleId`. The `not_found` fallback below is a
      // defensive shape guard, not an expected path.
      const result = resultByArticleId.get(ref.articleId) ?? { outcome: "not_found" as const };
      return { kind: "resolved" as const, novelId, articleId: ref.articleId, result };
    });

    return { items, summary: summarize(items) };
  });
}
