/**
 * RC-4 explicit-selection batch wrapper around `createContentFromSourceItem`
 * (`./service.ts`). CPS v8.3.6 parity target:
 * `src/lib/changdu-promote-drama-batch.ts`'s `runChangduPromoteDramaBatch`
 * (read-only CPS reference, `git show v8.3.6:src/lib/
 * changdu-promote-drama-batch.ts`) — only the *semantics* are ported, never
 * its machinery: CPS's batch promote has no BatchTask/SQLite row of its own,
 * it is a plain in-process loop (`for (const sample of eligibleSamples) {
 * results.push(await runApply(...)) }`) over an explicit, already-deduped id
 * list, capped by a caller-supplied limit, collecting one structured result
 * per item into an array a caller-facing summary is derived from. This file
 * is that same shape, not a task-queue/worker construction — there is no
 * `GenericTask` row here, unlike `@/lib/tasks/promo-link-claim`.
 *
 * ## What this does and does not change
 *
 * This module never edits `./service.ts`. `createContentFromSourceItem`'s
 * own dry-run/apply behavior, transaction boundary, idempotency key
 * (`NovelSourceItem.novelId`), and every returned `CreateContentResult`
 * outcome are called here exactly as the single-item Server Action
 * (`src/app/(admin)/catalog-sync/_actions.ts`) already calls them — one call
 * per source item, each with its own `$transaction` (see `./service.ts`'s
 * module header, "Idempotency and concurrency"). Nothing about a single
 * item's judgment or write boundary is touched by looping over many of them.
 *
 * ## Serial, budgeted, no rollback of already-processed items
 *
 * `Promise.all`/`Promise.allSettled` are deliberately not used — CPS's own
 * production incident already proved the shape of the failure mode a
 * multi-item admin action can hit at the reverse proxy: v7.9.6's batch
 * "换租客" 504s traced back to nginx's default 60s read timeout on a
 * synchronous multi-item write endpoint (`docs/governance/…` / this
 * project's own institutional memory of that root cause). Here that risk is
 * closed two ways: (1) items are processed strictly one at a time, in
 * selection order, so a slow item cannot starve unrelated concurrent
 * requests the way an unbounded `Promise.all` fan-out could; (2) a wall-clock
 * budget (`CONTENT_CREATION_BATCH_BUDGET_MS`, comfortably under a 60s proxy
 * timeout) is checked *before* starting each new item — once exceeded, every
 * remaining id is returned as `"not_processed"` without being touched, and
 * the caller (`applyContentCreationBatchAction`) tells the operator exactly
 * that: submit the same (now-shorter) selection again. Nothing about an
 * already-committed item is reverted when the budget runs out mid-batch —
 * each item's own transaction already committed independently before the
 * next budget check runs, so a partial batch is always safe to resubmit
 * (the leftover ids will simply resolve to `"already_exists"` /
 * `"skipped_already_linked"` for anything that in fact got created just
 * before the cutoff).
 */
import type { PrismaClient } from "@prisma/client";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { summarizeDbError } from "@/lib/db/db-retry";

import {
  ContentCreationInputError,
  createContentFromSourceItem,
  type ContentCreationInputErrorCode,
  type CreateContentActor,
  type CreateContentResult,
} from "./service";
import { enqueueContentCreationPreview, type ContentCreationPreviewEnqueueResult } from "./preview-enqueue";

// ---------------------------------------------------------------------------
// Batch-level input validation (throws — malformed caller input, mirrors
// `PromoLinkClaimTaskInputError`'s split between action-level pre-checks and
// factory-level backstop validation; see `@/lib/tasks/promo-link-claim`).
// ---------------------------------------------------------------------------

export type ContentCreationBatchInputErrorCode = "items_required" | "batch_size_exceeded";

export class ContentCreationBatchInputError extends Error {
  readonly code: ContentCreationBatchInputErrorCode;

  constructor(code: ContentCreationBatchInputErrorCode, message: string) {
    super(message);
    this.name = "ContentCreationBatchInputError";
    this.code = code;
  }
}

/**
 * Single-run explicit-selection cap. `MAX_BATCH_PUBLISH_SELECTION` (200,
 * `src/app/(admin)/novels/_lib/batch-publish-constants.ts`) is a pure DB
 * status flip; this path writes `Novel` + `Article` + `OperationAudit` per
 * item and is bounded by {@link CONTENT_CREATION_BATCH_BUDGET_MS} on top, so
 * 50 — a quarter of the publish cap — is the deliberately smaller number for
 * a heavier write, not a copy-paste of that constant.
 */
export const CONTENT_CREATION_BATCH_MAX_SELECTION = 50;

/**
 * Wall-clock budget for one batch call, comfortably under the reverse
 * proxy's default 60s read timeout the CPS v7.9.6 incident traced its 504s
 * to — see module header. Exported so both batch functions below and the
 * calling Server Actions (`applyContentCreationBatchAction`,
 * `dryRunContentCreationBatchAction`) enforce the exact same number, never
 * two independently-typed literals that could drift apart.
 */
export const CONTENT_CREATION_BATCH_BUDGET_MS = 25_000;

export type ContentCreationBatchInput = {
  readonly novelSourceItemIds: readonly string[];
  readonly actor: CreateContentActor;
  readonly requestId: string;
  /** Forwarded to `createContentFromSourceItem` unchanged — defaults to `"en"` there. */
  readonly locale?: SiteLocale;
  /** Defaults to {@link CONTENT_CREATION_BATCH_BUDGET_MS}; overridable only for tests. */
  readonly budgetMs?: number;
};

function requireNonEmptyDedupedIds(novelSourceItemIds: readonly string[]): readonly string[] {
  const uniqueIds = Array.from(new Set(novelSourceItemIds));
  if (uniqueIds.length === 0) {
    throw new ContentCreationBatchInputError("items_required", "At least one novelSourceItemId is required");
  }
  if (uniqueIds.length > CONTENT_CREATION_BATCH_MAX_SELECTION) {
    throw new ContentCreationBatchInputError(
      "batch_size_exceeded",
      `Batch selection exceeds the ${CONTENT_CREATION_BATCH_MAX_SELECTION}-item limit`,
    );
  }
  return uniqueIds;
}

// ---------------------------------------------------------------------------
// Shared sequential/budgeted core. `TPrimaryStatus` is the one label that
// varies by mode (`"created"` for apply, `"creatable"` for dry_run) — every
// other status name is identical across both, so this is the single place
// the "serial, budgeted, per-item try/catch" shape is written once.
// ---------------------------------------------------------------------------

type CoreItemOutcome<TPrimaryStatus extends string> = {
  readonly novelSourceItemId: string;
  readonly status: TPrimaryStatus | "skipped_already_linked" | "failed" | "not_processed";
  /** Present whenever the service returned a structured outcome (i.e. status is not `not_processed` and the failure was not a malformed-input throw). */
  readonly result?: CreateContentResult;
  /** Present only when `status === "failed"` and the cause was `ContentCreationInputError` — a malformed-input defensive branch, not a business-state outcome. `code` is safe to surface verbatim (it is a fixed enum, never free text). */
  readonly inputErrorCode?: ContentCreationInputErrorCode;
  /**
   * Present (`true`) only when `status === "failed"` and the cause was an
   * exception `createContentFromSourceItem` itself does not classify (i.e.
   * neither `ContentCreationInputError` nor one of its own structured
   * `CreateContentResult` outcomes — see that module's header, everything
   * expected is converted to a return value before this ever throws). The
   * raw error is logged server-side via `summarizeDbError` (never sent to
   * the client — "不带 message 原文") and this flag is the only trace of it
   * in the returned item.
   */
  readonly unexpectedError?: boolean;
};

async function runSequentialBudgetedBatch<TPrimaryStatus extends string>(
  db: PrismaClient,
  mode: "dry_run" | "apply",
  input: ContentCreationBatchInput,
  classify: (result: CreateContentResult) => TPrimaryStatus | "skipped_already_linked" | "failed",
): Promise<readonly CoreItemOutcome<TPrimaryStatus>[]> {
  const uniqueIds = requireNonEmptyDedupedIds(input.novelSourceItemIds);
  const budgetMs = input.budgetMs ?? CONTENT_CREATION_BATCH_BUDGET_MS;
  const startedAt = Date.now();
  const items: CoreItemOutcome<TPrimaryStatus>[] = [];

  for (let index = 0; index < uniqueIds.length; index += 1) {
    if (Date.now() - startedAt >= budgetMs) {
      // Budget exhausted before this item could start — every remaining id,
      // this one included, is returned untouched. See module header:
      // nothing already committed is rolled back, and resubmitting this
      // trailing slice is always safe.
      for (let rest = index; rest < uniqueIds.length; rest += 1) {
        items.push({ novelSourceItemId: uniqueIds[rest]!, status: "not_processed" });
      }
      break;
    }

    const novelSourceItemId = uniqueIds[index]!;
    try {
      // Same call the single-item Server Action makes
      // (`dryRunContentCreationAction`/`applyContentCreationAction`,
      // `src/app/(admin)/catalog-sync/_actions.ts`), one source item at a
      // time — this is the whole "reuse, don't reimplement" contract this
      // module exists to keep. `requestId` is suffixed per item (still well
      // under `Article`/`OperationAudit`'s 160-char bound) purely so each
      // item's own `OperationAudit` row and `withDbRetry` log entries stay
      // individually traceable back to this one batch submission.
      const result = await createContentFromSourceItem(db, {
        novelSourceItemId,
        locale: input.locale,
        mode,
        actor: input.actor,
        requestId: `${input.requestId}:${novelSourceItemId}`,
        deferPreviewEnqueue: mode === "apply",
      });
      items.push({ novelSourceItemId, status: classify(result), result });
    } catch (error) {
      if (error instanceof ContentCreationInputError) {
        items.push({ novelSourceItemId, status: "failed", inputErrorCode: error.code });
        continue;
      }
      // Unexpected — everything `createContentFromSourceItem` itself
      // anticipates is already a returned outcome, not a throw (see that
      // module's header). Isolate it to this one item rather than aborting
      // the rest of an explicit selection the operator deliberately made;
      // logged server-side only, never forwarded to the client verbatim.
      console.error("[content-creation-batch] unexpected per-item failure", {
        novelSourceItemId,
        mode,
        error: summarizeDbError(error),
      });
      items.push({ novelSourceItemId, status: "failed", unexpectedError: true });
    }
  }

  return items;
}

function countBy<TStatus extends string>(
  items: readonly { readonly status: TStatus }[],
  keys: readonly TStatus[],
): Readonly<Record<TStatus, number>> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<TStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Apply — the real batch write. Four-way status per item, per RC-4 spec.
// ---------------------------------------------------------------------------

export type ContentCreationBatchApplyStatus = "created" | "skipped_already_linked" | "failed" | "not_processed";

export type ContentCreationBatchApplyItemOutcome = CoreItemOutcome<"created">;

/** Keyed by {@link ContentCreationBatchApplyStatus} verbatim — see `countBy` below; no separate camelCase field-naming pass to keep in sync by hand. */
export type ContentCreationBatchApplyCounts = Readonly<Record<ContentCreationBatchApplyStatus, number>>;

export type ContentCreationBatchApplyResult = {
  readonly items: readonly ContentCreationBatchApplyItemOutcome[];
  readonly counts: ContentCreationBatchApplyCounts;
  readonly previewEnqueue?: ContentCreationPreviewEnqueueResult;
};

const APPLY_STATUSES = ["created", "skipped_already_linked", "failed", "not_processed"] as const;

function classifyApplyOutcome(
  result: CreateContentResult,
): "created" | "skipped_already_linked" | "failed" {
  if (result.outcome === "created") return "created";
  if (result.outcome === "already_exists") return "skipped_already_linked";
  return "failed";
}

/**
 * Real batch write. See module header for the full contract (serial,
 * budgeted, per-item transaction reused verbatim from `./service.ts`, no
 * rollback of already-processed items). Throws {@link
 * ContentCreationBatchInputError} for `items_required`/`batch_size_exceeded`
 * — `applyContentCreationBatchAction` pre-checks both for a friendly early
 * return and also catches this as a backstop, the same two-layer pattern
 * `enqueuePromoLinkClaimAction` / `createPromoLinkClaimTask` already use.
 */
export async function applyContentCreationBatch(
  db: PrismaClient,
  input: ContentCreationBatchInput,
): Promise<ContentCreationBatchApplyResult> {
  const items = await runSequentialBudgetedBatch(db, "apply", input, classifyApplyOutcome);
  const createdIds = items
    .filter((item) => item.status === "created")
    .map((item) => item.novelSourceItemId);
  const previewEnqueue = createdIds.length > 0
    ? await enqueueContentCreationPreview(db, {
        novelSourceItemIds: createdIds,
        requestToken: `moboreader.preview_refresh.v1:content_create_batch:${input.requestId}`,
        requestId: input.requestId,
        actorId: input.actor.type === "admin" ? input.actor.adminId : input.actor.source,
      })
    : undefined;
  return { items, counts: countBy(items, APPLY_STATUSES), ...(previewEnqueue ? { previewEnqueue } : {}) };
}

// ---------------------------------------------------------------------------
// Dry run — batch preview, same loop, zero writes (mode "dry_run" never
// reaches `runCreateTransaction` in `./service.ts`).
// ---------------------------------------------------------------------------

export type ContentCreationBatchDryRunStatus = "creatable" | "skipped_already_linked" | "failed" | "not_processed";

export type ContentCreationBatchDryRunItemOutcome = CoreItemOutcome<"creatable">;

/** Keyed by {@link ContentCreationBatchDryRunStatus} verbatim — see `countBy` above. */
export type ContentCreationBatchDryRunCounts = Readonly<Record<ContentCreationBatchDryRunStatus, number>>;

export type ContentCreationBatchDryRunResult = {
  readonly items: readonly ContentCreationBatchDryRunItemOutcome[];
  readonly counts: ContentCreationBatchDryRunCounts;
};

const DRY_RUN_STATUSES = ["creatable", "skipped_already_linked", "failed", "not_processed"] as const;

function classifyDryRunOutcome(
  result: CreateContentResult,
): "creatable" | "skipped_already_linked" | "failed" {
  if (result.outcome === "dry_run") return "creatable";
  if (result.outcome === "already_exists") return "skipped_already_linked";
  return "failed";
}

/**
 * Batch preview for the confirm dialog to render before `applyContentCreationBatch`
 * ever runs. Same budget, same dedupe/limit validation, same per-item call —
 * only the `mode` passed to `createContentFromSourceItem` and the resulting
 * status label differ from {@link applyContentCreationBatch}.
 */
export async function dryRunContentCreationBatch(
  db: PrismaClient,
  input: ContentCreationBatchInput,
): Promise<ContentCreationBatchDryRunResult> {
  const items = await runSequentialBudgetedBatch(db, "dry_run", input, classifyDryRunOutcome);
  return { items, counts: countBy(items, DRY_RUN_STATUSES) };
}
