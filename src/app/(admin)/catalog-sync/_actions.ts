"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import type { ErrorEnvelope } from "@/contracts";
import {
  CatalogSelectionInputError,
  normalizeCatalogSelection,
  type CatalogBatchContext,
  type CatalogBatchEnqueueResult,
  type CatalogBatchSummary,
  type CatalogSelection,
  type PromoLinkClaimCredentialWarning,
} from "@/domain/catalog-batch";
import { CatalogBatchInputError, enqueueCatalogBatch } from "@/lib/tasks/catalog-batch";
import { readCatalogBatchContext, readCatalogBatchSummary } from "@/server/catalog-batch";
import { resolveClaimCredentialAdmission } from "@/lib/credentials/claim-readiness";
import {
  isNovelCatalogSyncEnabled,
  isNovelCatalogSyncWriteAllowed,
  isPromoLinkClaimEnabled,
  isPromoLinkClaimWriteAllowed,
} from "@/lib/flags";
import {
  MoboreaderTaskInputError,
  createMoboreaderCatalogScanTask,
  resolveMoboreaderCatalogSafetyMaxPages,
  resolveMoboreaderUpstreamRecommendedPageSize,
  type MoboreaderTaskCreationResult,
} from "@/lib/tasks/moboreader";
import { requireAdminActionAccess, requireFreshAdminServiceMutation } from "@/server/auth/guards";
import {
  ContentCreationInputError,
  materializeNovelFromSourceItem,
  type ContentCreationInputErrorCode,
  type NovelMaterializeResult,
} from "@/server/content-creation";

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";

/**
 * P0-S13 content-creation trigger.
 *
 * `createContentFromSourceItem` (`@/server/content-creation`) has no
 * authorization of its own — its module header says so explicitly: "No admin
 * UI, no Server Action wrapper. Nothing under `src/app/**` calls this yet."
 * Everything below is that missing wrapper.
 *
 * Two actions, not one, because the operator must see the plan before
 * anything writes: `dryRunContentCreationAction` never sets `mode: "apply"`;
 * only `applyContentCreationAction` does, and only after its own fresh
 * capability + 2FA + same-origin + rate-limit + idempotent-request-id check —
 * the same `requireAdminActionAccess` → `requireFreshAdminServiceMutation`
 * two-step `src/app/(admin)/channel-accounts/_actions.ts` already uses for
 * credential mutations. Unlike those, `createContentFromSourceItem` takes a
 * plain `actor`, not a guard ticket, so the fresh re-check happens here
 * rather than inside the service (the credential services do it themselves
 * because they live in `src/server/`, the guard's own territory — this
 * service does not, by design; see its module header).
 *
 * Locale is never picked here at all — not hard-coded, not a dropdown.
 * L10N P2 (2026-09-10, matrix #3/#4) closed the S7a gap this comment used to
 * describe: `createContentFromSourceItem` now derives `Novel.locale`/
 * `Article.locale` from the source item's own `sourceLocale` (see
 * `src/server/content-creation/service.ts`'s module header, "Locale is
 * derived from the source item, never caller-supplied") and this wrapper has
 * no `locale` field left to forward. A `NULL`/unresolved `sourceLocale`
 * surfaces as `ContentCreationInputError("missing_locale")`; a resolved
 * value outside `SITE_LOCALES` (e.g. `it`/`fil`/`ms`/`tr`) surfaces as
 * `ContentCreationInputError("unsupported_locale")` — both caught below,
 * same as every other `ContentCreationInputError` code, and rendered by
 * `create-content-dialog.tsx`.
 */

export type ContentCreationActionResult =
  | { readonly ok: true; readonly data: NovelMaterializeResult }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | {
      readonly ok: false;
      readonly kind: "invalid_input";
      readonly code: ContentCreationInputErrorCode;
    };

async function authorizeAction(actionId: `admin.${string}`, requestId: string) {
  const requestHeaders = await headers();
  return requireAdminActionAccess(
    {
      actionId,
      sessionToken: await readSessionToken(),
      origin: requestHeaders.get("origin"),
      canonicalOrigin: await canonicalOrigin(),
      requestId,
    },
    guardDependencies(),
  );
}

/**
 * Read-only preview. Gated by `content:view` — the same bar `/catalog-sync`
 * already requires to render the source-item list at all, so anyone who can
 * see a row can also see what creating from it would do. Performs zero
 * writes: this always calls the service with `mode: "dry_run"`
 * (`createContentFromSourceItem`'s own default, spelled out here anyway so a
 * future edit cannot flip it by deleting a line).
 */
async function rejectRetiredContentCreation(
  actionId: "admin.content_creation.dry_run" | "admin.content_creation.apply" | "admin.content_creation.batch_apply",
  requestId: string,
): Promise<ContentCreationActionResult> {
  try {
    await authorizeAction(actionId, requestId);
    return { ok: false, kind: "invalid_input", code: "retired_protocol" };
  } catch (error) {
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/** Retired coupled protocol. Old clients must fail closed even without templateKey. */
export async function dryRunContentCreationAction(input: {
  novelSourceItemId: string;
  requestId: string;
  templateKey?: string;
}): Promise<ContentCreationActionResult> {
  void input.novelSourceItemId;
  void input.templateKey;
  return rejectRetiredContentCreation("admin.content_creation.dry_run", input.requestId);
}

export async function dryRunNovelMaterializeAction(input: {
  novelSourceItemId: string;
  requestId: string;
}): Promise<ContentCreationActionResult> {
  try {
    const { context } = await authorizeAction("admin.content_creation.dry_run", input.requestId);
    const data = await materializeNovelFromSourceItem(prisma, {
      novelSourceItemId: input.novelSourceItemId,
      mode: "dry_run",
      actor: { type: "admin", adminId: context.identity.id },
      requestId: input.requestId,
    });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ContentCreationInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * The real write. Gated by `content:publish` — the closest existing
 * content-mutation capability. `AdminCapability`
 * (`src/lib/auth/capabilities.ts`, Codex-owned) has no dedicated
 * `content:create`, and adding one is outside this task's write scope (that
 * file is not under `src/app/**`); reusing `content:publish` is a deliberate,
 * documented choice — see the delivery notes for the tradeoff, not an
 * oversight to "fix" by loosening it to `content:view`. It carries the same
 * `requiresTwoFactor: true` + `super_admin`-default bar as every other real
 * content mutation, which is the right bar for a call that inserts the first
 * `Novel` row a source item will ever have. It no longer creates an Article.
 */
/** Retired coupled protocol. Old clients must fail closed even without templateKey. */
export async function applyContentCreationAction(input: {
  novelSourceItemId: string;
  requestId: string;
  templateKey?: string;
}): Promise<ContentCreationActionResult> {
  void input.novelSourceItemId;
  void input.templateKey;
  try {
    const { serviceAuthorization } = await authorizeAction("admin.content_creation.apply", input.requestId);
    if (!serviceAuthorization) {
      const { AdminAccessError } = await import("@/lib/auth/errors");
      throw new AdminAccessError(
        "admin_service_authorization_required",
        403,
        "Action is not bound to a capability",
      );
    }
    await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
      identities: guardDependencies().identities,
      sessions: guardDependencies().sessions,
      entryId: "admin.content_creation.apply",
      requestId: input.requestId,
    });
    return { ok: false, kind: "invalid_input", code: "retired_protocol" };
  } catch (error) {
    if (error instanceof ContentCreationInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

export async function applyNovelMaterializeAction(input: {
  novelSourceItemId: string;
  requestId: string;
}): Promise<ContentCreationActionResult> {
  try {
    const { serviceAuthorization } = await authorizeAction(
      "admin.content_creation.apply",
      input.requestId,
    );
    if (!serviceAuthorization) {
      const { AdminAccessError } = await import("@/lib/auth/errors");
      throw new AdminAccessError(
        "admin_service_authorization_required",
        403,
        "Action is not bound to a capability",
      );
    }
    const guards = guardDependencies();
    const context = await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
      identities: guards.identities,
      sessions: guards.sessions,
      entryId: "admin.content_creation.apply",
      requestId: input.requestId,
    });
    const data = await materializeNovelFromSourceItem(prisma, {
      novelSourceItemId: input.novelSourceItemId,
      mode: "apply",
      actor: { type: "admin", adminId: context.identity.id },
      requestId: input.requestId,
    });
    if (data.outcome === "created") {
      revalidatePath("/catalog-sync");
      revalidatePath("/novels");
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ContentCreationInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * PR-C2 catalog-scan trigger.
 *
 * `createMoboreaderCatalogScanTask` (`@/lib/tasks/moboreader`) had zero
 * production callers before this file — see the registration comment in
 * `../../api/admin/_lib/registry.ts` (`ADMIN_CATALOG_SCAN_ACTIONS`) for the
 * full rationale. The short version: unlike the content-creation dry run
 * above, the factory writes a `CatalogScanTask` row in *every* mode, so both
 * actions below are mutations, and only `apply` — the mode that can actually
 * make the worker persist upstream data once `NOVEL_CATALOG_SYNC_ALLOW_WRITE`
 * is also on — goes through the extra `requireFreshAdminServiceMutation`
 * step.
 *
 * `requestToken` is never accepted from the caller. It is the factory's own
 * idempotency key (`CatalogScanTask.requestToken` is `@unique`), so a
 * client-supplied value would let a stale or replayed value collide, or let a
 * caller omit it into a validation error; minting a fresh `randomUUID()` here
 * keeps that key entirely server-controlled. The actual "don't double-create"
 * protection an operator experiences is the factory's own
 * `channelAccountId` + `channelAppId` + `projectType` scope check
 * (`active_conflict`), not requestToken replay — a double submit from this
 * form produces two distinct tokens but still only one live task, because the
 * second call observes the first one still `pending`/`processing`.
 *
 * Phase B (`施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §三):
 * `pageStart`/`pageEnd`/`pageSize` are no longer part of this action's own
 * input — CPS's `changdu-sync-panel.tsx` never exposes page mechanics to an
 * operator either, it just scans to its own safety ceiling every time. This
 * action now resolves the same three values the old form used to collect —
 * page 1 through the factory's own configured safety ceiling
 * (`resolveMoboreaderCatalogSafetyMaxPages`), at the factory's own
 * env-resolved recommended page size (`resolveMoboreaderUpstreamRecommendedPageSize`
 * — C-13, `施工工单_C13_每页100本与节流余量_2026-09-07.md`: reads the
 * `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE` env var instead of the bare
 * CPS-parity constant, so an operator can opt a task into the probed-safe
 * larger page size without a code change; still defaults to 20 when unset)
 * — as fixed server-side values instead. `languages` replaces them as the
 * one thing the operator does choose: recorded on the task for `/tasks`
 * detail and result filtering (Phase C), never sent upstream as a filter
 * (see the doc on `CreateMoboreaderCatalogScanTaskInput.languages`).
 */

export type CatalogScanTriggerInput = {
  readonly channelAccountId: string;
  readonly channelAppId: string;
  readonly languages: readonly string[];
  readonly requestId: string;
};

export type CatalogScanOutcome =
  | { readonly outcome: "created"; readonly taskId: string; readonly mode: "dry_run" | "apply" }
  | {
      readonly outcome: "created_disabled";
      readonly taskId: string;
      readonly mode: "dry_run" | "apply";
      /**
       * Live state of both gating flags at creation time, not just the one
       * that happened to block this call — an operator who only just turned
       * on `FEATURE_NOVEL_CATALOG_SYNC` still needs to know
       * `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is a separate switch before an
       * `apply` task will ever leave `disabled`.
       */
      readonly flags: { readonly featureEnabled: boolean; readonly writeAllowed: boolean };
    }
  | { readonly outcome: "duplicate"; readonly taskId: string }
  | { readonly outcome: "active_conflict"; readonly taskId: string };

export type CatalogScanActionResult =
  | { readonly ok: true; readonly data: CatalogScanOutcome }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | { readonly ok: false; readonly kind: "invalid_input"; readonly code: string };

function classifyCatalogScanResult(
  result: MoboreaderTaskCreationResult,
  mode: "dry_run" | "apply",
): CatalogScanOutcome {
  if (result.status === "duplicate") return { outcome: "duplicate", taskId: result.taskId };
  if (result.status === "active_conflict") return { outcome: "active_conflict", taskId: result.taskId };
  if (result.taskStatus === "pending") return { outcome: "created", taskId: result.taskId, mode };
  return {
    outcome: "created_disabled",
    taskId: result.taskId,
    mode,
    flags: {
      featureEnabled: isNovelCatalogSyncEnabled(),
      writeAllowed: isNovelCatalogSyncWriteAllowed(),
    },
  };
}

/**
 * Shared body for both exported actions below. Not exported itself — the
 * public surface is still two named actions (`dryRunCatalogScanTaskAction`,
 * `applyCatalogScanTaskAction`), each with its own hardcoded `mode` and
 * `actionId`, the same shape P0-S13 uses above. A single runtime-branched
 * action taking `mode` as caller input would mean the capability enforced
 * depended on a value the client controls; two statically-registered action
 * ids means the registry — not this function — is what decides which
 * capability an `apply` request needs.
 */
async function runCatalogScanTrigger(
  actionId: "admin.catalog_scan.dry_run" | "admin.catalog_scan.apply",
  mode: "dry_run" | "apply",
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  try {
    const { context, serviceAuthorization } = await authorizeAction(actionId, input.requestId);
    let actorId = context.identity.id;

    if (mode === "apply") {
      if (!serviceAuthorization) {
        // Unreachable given this action's own registration (capability is
        // always set — see `ADMIN_CATALOG_SCAN_ACTIONS`), kept as a
        // fail-closed backstop against a future registration mistake, same
        // as `applyContentCreationAction` above.
        const { AdminAccessError } = await import("@/lib/auth/errors");
        throw new AdminAccessError(
          "admin_service_authorization_required",
          403,
          "Action is not bound to a capability",
        );
      }
      const guards = guardDependencies();
      const fresh = await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
        identities: guards.identities,
        sessions: guards.sessions,
        entryId: actionId,
        requestId: input.requestId,
      });
      actorId = fresh.identity.id;
    }

    const result = await createMoboreaderCatalogScanTask(prisma, {
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      pageStart: 1,
      pageEnd: resolveMoboreaderCatalogSafetyMaxPages(),
      pageSize: resolveMoboreaderUpstreamRecommendedPageSize(),
      languages: input.languages,
      requestToken: randomUUID(),
      actorId,
      requestId: input.requestId,
      mode,
    });
    return { ok: true, data: classifyCatalogScanResult(result, mode) };
  } catch (error) {
    if (error instanceof MoboreaderTaskInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * Requests `admin.catalog_scan.dry_run` (`content:view` — the same bar
 * `/catalog-sync` already requires to render). Still a real write (see the
 * module-level comment above), so unlike `dryRunContentCreationAction` this
 * one does not skip same-origin/rate-limit/request-id — the registration
 * (`mutation: true`) is what turns those checks on, not this function.
 */
export async function dryRunCatalogScanTaskAction(
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  return runCatalogScanTrigger("admin.catalog_scan.dry_run", "dry_run", input);
}

/**
 * Requests `admin.catalog_scan.apply` (`content:publish`) and, once granted a
 * ticket, re-validates freshly via `requireFreshAdminServiceMutation` before
 * calling the factory — the same two-step P0-S13 uses for its real write.
 * Even a successful `apply` call here may still create a `disabled` task if
 * `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is off; that is not an error from this
 * action's point of view (the row exists, exactly as requested), it is
 * `classifyCatalogScanResult` producing `created_disabled` for the UI to
 * explain.
 */
export async function applyCatalogScanTaskAction(
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  return runCatalogScanTrigger("admin.catalog_scan.apply", "apply", input);
}

export type CatalogBatchActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | { readonly ok: false; readonly kind: "invalid_input"; readonly code: string };

function catalogBatchInputFailure(error: unknown): { readonly ok: false; readonly kind: "invalid_input"; readonly code: string } | null {
  return error instanceof CatalogSelectionInputError || error instanceof CatalogBatchInputError
    ? { ok: false, kind: "invalid_input", code: error.code }
    : null;
}

const CATALOG_BATCH_CONFIG_MAX_ENTRIES = 1_000;
const CONFIG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 2026-09-14 incident (see `worker/handlers/promo-link-claim-circuit-
 * breaker.ts`'s module header for the full account): a 79,217-item batch was
 * enqueued and run to ~44k permanently-failed items against a credential
 * that had *never once* validated successfully. Nothing checked the
 * credential before the batch existed at all.
 *
 * This now does two things per `(channelAppId, channelAccountId)` pair,
 * inside the same transaction that creates the batch's `GenericTask` row
 * (`enqueueCatalogBatch`'s `validateNewInput` hook) — so a batch can never
 * be admitted against a binding this function would have rejected a moment
 * later:
 *
 *  1. The pre-existing binding check (channel/app/account all active).
 *  2. `resolveClaimCredentialAdmission` — a Web-safe, non-secret-column-only
 *     check (never `encryptedSecret`; see its module header for why this is
 *     deliberately *not* the same function the worker's deep decrypt/
 *     validate step uses at actual claim time) — and refuses with the
 *     credential's own typed code (`credential_missing`/`credential_expired`/
 *     `credential_ambiguous`/`credential_never_validated`) rather than the
 *     generic `channel_account_binding_invalid`, so an operator (and
 *     `src/server/task-admin/safe-task-error.ts`'s label map) can tell "this
 *     account/app binding is gone" apart from "this credential cannot be
 *     used" — two different remediations. `credential_never_validated` alone
 *     would have caught the 09-14 batch: that credential's `last_validated_at`
 *     was empty when it was admitted.
 *
 * A credential that *is* usable right now but will expire before a batch
 * this size could plausibly finish is not refused — refusing a legitimate,
 * currently-valid credential outright would be its own foot-gun — but is
 * collected into `warnings` so the caller can record *when* it expires
 * rather than silently proceeding. See `CREDENTIAL_EXPIRY_WARNING_WINDOW_MS`
 * (`src/lib/credentials/claim-readiness.ts`) for why that window is tied to
 * the batch's own TTL rather than an arbitrary clock value.
 */
async function validatePromoAccountConfiguration(
  db: Pick<typeof prisma, "channelApp" | "channelAccountCredential">,
  accounts: Readonly<Record<string, string>>,
  now: Date,
): Promise<PromoLinkClaimCredentialWarning[]> {
  const warnings: PromoLinkClaimCredentialWarning[] = [];
  for (const [channelAppId, accountId] of Object.entries(accounts)) {
    const binding = await db.channelApp.findFirst({ where: {
      id: channelAppId, status: "active",
      channel: { status: "active", channelAccounts: { some: { id: accountId, status: "active", deletedAt: null } } },
    }, select: { id: true } });
    if (!binding) throw new CatalogBatchInputError("channel_account_binding_invalid");
    const admission = await resolveClaimCredentialAdmission(db, accountId, now);
    if (admission.status === "not_ready") throw new CatalogBatchInputError(admission.code);
    if (admission.expiringSoon && admission.expiresAt) {
      warnings.push({ channelAppId, channelAccountId: accountId, expiresAt: admission.expiresAt.toISOString() });
    }
  }
  return warnings;
}

export async function readCatalogBatchContextAction(input: {
  selection: CatalogSelection;
  requestId: string;
}): Promise<CatalogBatchActionResult<CatalogBatchContext>> {
  try {
    await authorizeAction("admin.catalog_batch.context", input.requestId);
    const data = await readCatalogBatchContext(prisma, normalizeCatalogSelection(input.selection));
    return { ok: true, data };
  } catch (error) {
    return catalogBatchInputFailure(error) ?? { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

export async function enqueuePromoLinkClaimAction(input: {
  selection: CatalogSelection;
  channelAccounts: Readonly<Record<string, string>>;
  requestId: string;
}): Promise<CatalogBatchActionResult<CatalogBatchEnqueueResult>> {
  try {
    const { serviceAuthorization } = await authorizeAction("admin.promo_link_claim.enqueue", input.requestId);
    if (!serviceAuthorization) throw new Error("admin_service_authorization_required");
    const guards = guardDependencies();
    const fresh = await requireFreshAdminServiceMutation(serviceAuthorization, "promo:claim", {
      identities: guards.identities, sessions: guards.sessions,
      entryId: "admin.promo_link_claim.enqueue", requestId: input.requestId,
    });
    const selection = normalizeCatalogSelection(input.selection);
    if (!input.channelAccounts || typeof input.channelAccounts !== "object" || Array.isArray(input.channelAccounts)) {
      return { ok: false, kind: "invalid_input", code: "channel_accounts_invalid" };
    }
    if (Object.keys(input.channelAccounts).length > CATALOG_BATCH_CONFIG_MAX_ENTRIES) {
      return { ok: false, kind: "invalid_input", code: "channel_accounts_invalid" };
    }
    for (const [channelAppId, accountId] of Object.entries(input.channelAccounts)) {
      if (!CONFIG_UUID.test(channelAppId.trim()) || typeof accountId !== "string" || !CONFIG_UUID.test(accountId.trim())) {
        return { ok: false, kind: "invalid_input", code: "channel_accounts_invalid" };
      }
    }
    const normalizedAccounts = Object.fromEntries(Object.entries(input.channelAccounts).map(([k, v]) => [k.trim(), v.trim()]));
    const enabled = isPromoLinkClaimEnabled() && isPromoLinkClaimWriteAllowed();
    const now = new Date();
    // Reset on every attempt (`enqueueCatalogBatch`'s transaction can retry
    // this callback from scratch on a transient DB error) rather than
    // accumulated across attempts — the last attempt to actually run is the
    // only one whose warnings should ever reach the caller.
    let credentialWarnings: PromoLinkClaimCredentialWarning[] = [];
    const result = await enqueueCatalogBatch(prisma, {
      operation: "promo_claim", selection, actorId: fresh.identity.id, requestId: input.requestId,
      channelAccounts: normalizedAccounts,
    }, now, enabled, async (tx) => {
      credentialWarnings = await validatePromoAccountConfiguration(tx, normalizedAccounts, now);
    });
    if (!result.duplicate && credentialWarnings.length > 0) {
      // Advisory only — the batch was already admitted above. Recorded as
      // its own audit row (rather than blocking, or silently doing nothing)
      // so an operator reviewing why a batch later ran into a
      // freshly-expired credential can see it was flagged as expiring soon
      // at admission time, with the exact expiry timestamp.
      await prisma.operationAudit.create({ data: {
        actorType: "admin", actorId: fresh.identity.id,
        action: "promo_link_claim.credential_expiring_soon",
        entityType: "GenericTask", entityId: result.taskId,
        requestId: input.requestId,
        afterSnapshot: { warnings: credentialWarnings },
      } });
    }
    const replaySummary = result.duplicate ? await readCatalogBatchSummary(prisma, result.taskId, fresh.identity.id) : null;
    return { ok: true, data: {
      taskId: result.taskId,
      phase: replaySummary?.phase ?? (result.taskStatus === "disabled" ? "disabled" : "queued"),
      ...(!result.duplicate && credentialWarnings.length > 0 ? { credentialWarnings } : {}),
    } };
  } catch (error) {
    return catalogBatchInputFailure(error) ?? { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/** Retired coupled protocol. Empty or missing template map still fails. */
export async function applyContentCreationBatchAction(input: {
  selection: CatalogSelection;
  templateKeysByLocale?: Readonly<Record<string, string>>;
  requestId: string;
}): Promise<CatalogBatchActionResult<CatalogBatchEnqueueResult>> {
  void input.selection;
  void input.templateKeysByLocale;
  try {
    const { serviceAuthorization } = await authorizeAction("admin.content_creation.batch_apply", input.requestId);
    if (!serviceAuthorization) throw new Error("admin_service_authorization_required");
    await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
      identities: guardDependencies().identities,
      sessions: guardDependencies().sessions,
      entryId: "admin.content_creation.batch_apply",
      requestId: input.requestId,
    });
    return { ok: false, kind: "invalid_input", code: "retired_protocol" };
  } catch (error) {
    return catalogBatchInputFailure(error) ?? { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

export async function applyNovelMaterializeBatchAction(input: {
  selection: CatalogSelection;
  requestId: string;
}): Promise<CatalogBatchActionResult<CatalogBatchEnqueueResult>> {
  try {
    const { serviceAuthorization } = await authorizeAction("admin.content_creation.batch_apply", input.requestId);
    if (!serviceAuthorization) throw new Error("admin_service_authorization_required");
    const guards = guardDependencies();
    const fresh = await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
      identities: guards.identities, sessions: guards.sessions,
      entryId: "admin.content_creation.batch_apply", requestId: input.requestId,
    });
    const selection = normalizeCatalogSelection(input.selection);
    const result = await enqueueCatalogBatch(prisma, {
      operation: "novel_materialize", selection, actorId: fresh.identity.id, requestId: input.requestId,
    }, new Date(), true);
    const replaySummary = result.duplicate ? await readCatalogBatchSummary(prisma, result.taskId, fresh.identity.id) : null;
    return { ok: true, data: { taskId: result.taskId, phase: replaySummary?.phase ?? (result.taskStatus === "disabled" ? "disabled" : "queued") } };
  } catch (error) {
    return catalogBatchInputFailure(error) ?? { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

export async function readCatalogBatchSummaryAction(input: {
  taskId: string;
  requestId: string;
}): Promise<CatalogBatchActionResult<CatalogBatchSummary>> {
  try {
    const { context } = await authorizeAction("admin.catalog_batch.summary", input.requestId);
    if (!/^[0-9a-f-]{36}$/i.test(input.taskId)) return { ok: false, kind: "invalid_input", code: "task_id_invalid" };
    const data = await readCatalogBatchSummary(prisma, input.taskId, context.identity.id);
    if (!data) return { ok: false, kind: "invalid_input", code: "task_not_found" };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}
