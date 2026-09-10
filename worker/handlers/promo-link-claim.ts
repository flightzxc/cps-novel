/**
 * Promo-link claim `TaskHandler`
 * (`docs/architecture/candidate-v0.2.1/novel-v1-adapter-and-workflow-
 * v0.2.1.md` §3.9/§3.10, §4). One unified decision tree per
 * `GenericTaskItem`, covering both halves of the architecture doc's flow:
 *
 *   1. §3.9 "已有推广资源读取" — the production path extracts
 *      `kocCode` plus `publicUrl`/`homeLink` from the catalog response before
 *      evidence redaction and writes them directly to `PromoLink` in
 *      `worker/handlers/moboreader.ts`. This handler never interprets promo
 *      fields from `NovelSourceItem.rawPayload`: official snapshots have
 *      been redacted since the first catalog writer, so there is no genuine
 *      non-redacted compatibility history to recover here.
 *   2. §3.10 "推广生成" — the side-effecting `claimPromo` capability.
 *      Its novel wire contract was frozen by the Owner-approved Book A
 *      probe on 2026-08-31 (see `docs/operations/MOBOREADER_PROMO_CLAIM_
 *      CONTRACT_2026-08-31.md`). Execution still requires both feature
 *      flags and an explicitly enabled `ChannelCapability` row.
 *
 * `upstream_code` (the channel's real promo code) is read from upstream
 * responses and written to the DB, but must never reach a log line, an
 * error message, or an `OperationAudit`/task `result` snapshot — every
 * place this handler surfaces claim outcomes uses `redactUpstreamCode`
 * (length-only) or `safeHostname` (host-only) instead. `tests/backend/
 * tasks/promo-link-claim-redaction.test.ts` asserts this with a fixture
 * that carries both codes side by side.
 *
 * Whenever a PromoLink genuinely reaches `fetched`, the shared
 * `bindPromoLinkToArticles` helper binds it back onto every locale Article
 * for its Novel in the same transaction. Catalog capture and this claim
 * handler deliberately share that binding implementation and conflict
 * policy.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  classifyClaimPromoFailure,
  createPromoLinkClaimAdapter,
  moboreaderUpstreamRateGate,
  type ClaimPromoRequest,
  type ClaimPromoResult,
  type PromoLinkClaimAdapter,
  type ReadPromoAfterClaimResult,
} from "../../src/lib/adapters";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../../src/lib/flags";
import {
  buildPromoLinkIdempotencyKey,
  confirmSideEffectIntentByReadbackInTransaction,
  createHandlerRegistry,
  prepareSideEffectIntent,
  transitionSideEffectIntent,
  type TaskHandler,
} from "../../src/lib/tasks";
export { buildPromoLinkIdempotencyKey } from "../../src/lib/tasks/promo-link-claim";
import {
  PROMO_LINK_CLAIM_CAPABILITY_KEY,
  PROMO_LINK_CLAIM_TASK_TYPE,
  resolvePromoLinkClaimReadbackPolicy,
  type PromoLinkClaimReadbackPolicy,
} from "../../src/lib/tasks/promo-link-claim-limits";
import { createPublicRedirectCode } from "../../src/lib/redirect";
import { validateCredentialJwtLocally } from "../../src/lib/credentials/jwt";
import { decryptCredentialSecretForWorker } from "../credentials/crypto";
import { bindPromoLinkToArticles } from "./promo-link-binding";

// ---------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------

export interface PromoLinkClaimPayload {
  novelSourceItemId: string;
  offerType: string;
  channelAccountId: string;
  channelAppId: string;
  actorId: string;
  requestId: string;
  expiresAt: string;
}

const PAYLOAD_STRING_FIELDS = [
  "novelSourceItemId",
  "offerType",
  "channelAccountId",
  "channelAppId",
  "actorId",
  "requestId",
  "expiresAt",
] as const;

export function parsePromoLinkClaimPayload(value: unknown): PromoLinkClaimPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("claim_payload_invalid");
  const item = value as Partial<PromoLinkClaimPayload>;
  for (const field of PAYLOAD_STRING_FIELDS) {
    if (typeof item[field] !== "string" || !item[field]) throw new Error("claim_payload_invalid");
  }
  if (Number.isNaN(Date.parse(item.expiresAt as string))) throw new Error("task_expiry_invalid");
  return item as PromoLinkClaimPayload;
}

// ---------------------------------------------------------------------
// Redaction — the only place these two functions need to exist. Doc §3.9
// "脱敏: 审计只存 [redacted_code:length=N] 与 hostname".
// ---------------------------------------------------------------------

export function redactUpstreamCode(code: string | null | undefined): string | null {
  return code ? `[redacted_code:length=${code.length}]` : null;
}

export function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// PromoLink idempotency key
// ---------------------------------------------------------------------

/**
 * This project's own key formula — not a literal port of the architecture
 * doc's cited CPS-era formula `(channel_app_id, external_book_id,
 * source_language_code, channel_account_id)`. `NovelSourceItem`'s own
 * unique constraint (`channelAppId_externalBookId_sourceLanguageCode`)
 * already makes `novelSourceItemId` a stable stand-in for that
 * `(channel_app_id, external_book_id, source_language_code)` triple, so
 * this substitutes the id directly rather than re-deriving the raw upstream
 * fields; `offerType` is added because — unlike the doc's citation, written
 * before this project's schema settled — `PromoLink.offerType` exists and
 * nothing enforces exactly one offer per source item.
 */
// ---------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------

interface ClaimScope {
  source: { id: string; novelId: string; title: string; rawPayload: unknown };
  app: { id: string; channelId: string; projectType: number };
  account: { id: string };
  capabilityEnabled: boolean;
  idempotencyKey: string;
  existingPromoLink: { id: string; status: string; publicRedirectCode: string } | null;
}

async function loadClaimScope(db: PrismaClient, payload: PromoLinkClaimPayload): Promise<ClaimScope> {
  const source = await db.novelSourceItem.findUnique({
    where: { id: payload.novelSourceItemId },
    select: { id: true, novelId: true, channelAppId: true, deletedAt: true, status: true, title: true, rawPayload: true },
  });
  if (!source || source.deletedAt || source.status !== "linked" || !source.novelId || source.channelAppId !== payload.channelAppId) {
    throw new Error("claim_source_binding_missing");
  }
  const app = await db.channelApp.findFirst({
    where: { id: payload.channelAppId, status: "active", channel: { status: "active" } },
    select: { id: true, channelId: true, projectType: true },
  });
  if (!app) throw new Error("claim_channel_binding_unavailable");
  const account = await db.channelAccount.findFirst({
    where: { id: payload.channelAccountId, channelId: app.channelId, status: "active", deletedAt: null },
    select: { id: true },
  });
  if (!account) throw new Error("claim_account_unavailable");
  const capability = await db.channelCapability.findUnique({
    where: {
      channelAppId_capabilityKey: { channelAppId: app.id, capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY },
    },
    select: { status: true, sideEffecting: true },
  });
  const idempotencyKey = buildPromoLinkIdempotencyKey({
    channelAppId: app.id,
    novelSourceItemId: source.id,
    channelAccountId: account.id,
    offerType: payload.offerType,
  });
  const existingPromoLink = await db.promoLink.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, publicRedirectCode: true },
  });
  return {
    source: { id: source.id, novelId: source.novelId, title: source.title, rawPayload: source.rawPayload },
    app,
    account,
    capabilityEnabled: capability?.status === "enabled" && capability.sideEffecting === true,
    idempotencyKey,
    existingPromoLink,
  };
}

// ---------------------------------------------------------------------
// PromoLink writes. All go through `ensurePromoLinkRow` first — the single
// path that allocates `public_redirect_code` (via `src/lib/redirect/
// public-redirect-code.ts`) and satisfies the column's NOT NULL constraint
// at INSERT time, matching that module's "assigned once, at creation,
// never reassigned" contract.
// ---------------------------------------------------------------------

async function ensurePromoLinkRow(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
): Promise<{ id: string; publicRedirectCode: string }> {
  // `upsert` keyed on `idempotencyKey` compiles to `INSERT ... ON CONFLICT
  // (idempotency_key) DO UPDATE` — Postgres resolves that conflict at the
  // SQL level without raising an exception, so this is safe to call inside
  // an already-open transaction (`protectedWrite` runs inside
  // `finalizeTaskItem`'s transaction). A plain `create` guarded by a
  // catch-and-requery would NOT be safe here: once a statement inside an
  // open Postgres transaction raises a constraint violation, the whole
  // transaction is aborted and no further statement on the same connection
  // can run until rollback (`src/lib/tasks/store.ts`'s `claimPendingItem`
  // documents the same reasoning for why `withDbRetry` wraps whole
  // `$transaction` calls, never a statement inside one).
  //
  // The `publicRedirectCode` below is generated once via
  // `createPublicRedirectCode()`, not `createWithPublicRedirectCodeRetry`'s
  // bounded-retry loop — that loop's retry-on-conflict strategy has the
  // same nested-transaction problem: a same-transaction collision on this
  // *different* unique column (not the one `upsert`'s `ON CONFLICT`
  // targets) still aborts the transaction. At 36^10 ≈ 3.66e15 possible
  // codes this is treated as statistically negligible rather than worth a
  // SAVEPOINT. If it ever happens, `protectedWrite` throws,
  // `finalizeTaskItem` never commits a terminal status, and the same
  // poison-item recovery path every other task family already relies on
  // (`recoverExpiredItem`, lease expiry, capped `attemptCount`) reclaims
  // the item — a fresh attempt gets a fresh random code.
  return tx.promoLink.upsert({
    where: { idempotencyKey: scope.idempotencyKey },
    create: {
      novelId: scope.source.novelId,
      novelSourceItemId: scope.source.id,
      channelAppId: scope.app.id,
      channelAccountId: scope.account.id,
      offerType: payload.offerType,
      publicRedirectCode: createPublicRedirectCode(),
      idempotencyKey: scope.idempotencyKey,
      status: "pending",
    },
    update: {},
    select: { id: true, publicRedirectCode: true },
  });
}

// ---------------------------------------------------------------------
// Article binding — the missing other half of "PromoLink reached fetched".
// `Article.promoLinkId` (`prisma/schema.prisma`'s `article_promo_link_novel_
// fkey`, a composite FK on `(promo_link_id, novel_id)`) is what
// `src/server/publish-gate/facts.ts` resolves `article.promoLink` through;
// until this column is set, `evaluatePublishGate` reports
// `promo_link_missing` forever, even for a PromoLink that is genuinely
// `fetched`. Nothing else in this codebase writes this column.
//
// Cardinality read from schema (not assumed): `PromoLink.idempotencyKey` is
// keyed on `(channelAppId, novelSourceItemId, channelAccountId, offerType)`
// — it carries no locale dimension at all. `Article` is keyed on
// `(novelId, locale)` (`article_novel_locale_key`) — one Article row per
// locale per Novel. Since a PromoLink cannot be locale-specific (the
// concept doesn't exist on that row), the only binding strategy consistent
// with this basis is: every locale Article under the same Novel shares the
// *same* PromoLink. A Novel can in principle have more than one PromoLink
// (multiple NovelSourceItems/channel accounts/offer types), so binding is
// scoped per-PromoLink, first-fetched-wins — see the conflict handling
// below for what happens when a second, different PromoLink for the same
// Novel also reaches `fetched`.
// ---------------------------------------------------------------------

/**
 * Binds `promoLinkId` onto every non-deleted Article for `novelId` that
 * does not already carry a *different* PromoLink. Runs inside the same `tx`
 * as the PromoLink write that produced `promoLinkId` (catalog capture and
 * `writePromoLinkClaimed` call this after their `PromoLink` write), and
 * therefore inherits that write's
 * `withDbRetry`-wrapped whole-transaction retry from
 * `src/lib/tasks/store.ts`'s `finalizeTaskItem` — no separate retry wrapper
 * is added here (nesting one would reproduce the same
 * open-transaction-abort hazard `ensurePromoLinkRow`'s header documents for
 * nested conflict-retry loops).
 *
 * Idempotent by construction: the `findMany` immediately before each write
 * is this call's guard read — a row already pointing at `promoLinkId` is
 * left untouched (`alreadyBoundArticleIds`), so re-running the same
 * terminal write (e.g. a retried task attempt) never produces a second
 * write or a duplicate audit-worthy side effect.
 *
 * Conflict semantics: a row already pointing at a *different*, non-null
 * `promoLinkId` is left untouched, not overwritten and not failed
 * (`conflictedArticleIds`) — throwing here would roll back the entire
 * transaction, including the PromoLink row genuinely reaching `fetched`,
 * over an unrelated Article's pre-existing binding. Silently overwriting it
 * would violate the "never overwrite an existing binding" requirement this
 * function exists to satisfy. Skip is therefore the only option that lets a
 * true, correct fact (this PromoLink is fetched) commit while never
 * clobbering a different one; conflicts are still observable — both call
 * sites fold these counts into the same `operationAudit` row this write
 * already creates — so silently overwriting is never confused with
 * silently skipping. A Novel with more than one live PromoLink competing
 * for the same Article does not yet have an Owner-defined selection policy
 * beyond this first-fetched-wins default; see this task's final report.
 *
 * A locale whose Article row does not exist yet (content-creation pipeline
 * has not run for it) is simply absent from `findMany`'s result — no error,
 * nothing to bind, matching this function's "safe skip, never throw" brief.
 */
async function reconcileAlreadyFetchedBinding(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
): Promise<void> {
  const existing = scope.existingPromoLink;
  if (!existing) throw new Error("promo_link_missing_during_binding_reconcile");
  const articleBinding = await bindPromoLinkToArticles(tx, scope.source.novelId, existing.id);
  if (articleBinding.boundArticleIds.length === 0 && articleBinding.conflictedArticleIds.length === 0) return;
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: "promo_link_claim.already_fetched_binding_reconciled",
      entityType: "PromoLink",
      entityId: existing.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: {
        decision: "already_fetched",
        articlesBound: articleBinding.boundArticleIds.length,
        articlesAlreadyBound: articleBinding.alreadyBoundArticleIds.length,
        articlesConflicted: articleBinding.conflictedArticleIds.length,
      },
    },
  });
}

async function writePromoLinkCapabilityDisabled(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
  now: Date,
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      status: "registered_disabled",
      errorKind: "capability_disabled",
      errorMessage: "claimPromo capability is registered_disabled for this ChannelApp",
      lastAttemptedAt: now,
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: "promo_link_claim.capability_disabled",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: { decision: "capability_disabled" },
    },
  });
  return row.id;
}

async function writePromoLinkManualReview(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
  now: Date,
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      status: "pending",
      errorKind: "claim_manual_review_required",
      errorMessage: "A prior claim attempt's outcome is unknown; automatic retry is blocked pending manual review (CLAUDE.md §5 修正 4)",
      lastAttemptedAt: now,
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: "promo_link_claim.manual_review_required",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: { decision: "manual_review_required" },
    },
  });
  return row.id;
}

async function writePromoLinkClaimFailed(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
  failureCategory: string,
  now: Date,
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      status: "failed",
      errorKind: failureCategory,
      errorMessage: `claimPromo failed: ${failureCategory}`,
      lastAttemptedAt: now,
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: "promo_link_claim.failed",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: { decision: "claim_failed", failureCategory },
    },
  });
  return row.id;
}

async function writePromoLinkClaimed(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
  result: ClaimPromoResult,
  now: Date,
  options: {
    origin: "claimed" | "upstream_existing";
    decision: "claimed" | "already_available" | "readback_recovered";
    intentEffectKey?: string;
  },
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      origin: options.origin,
      status: "fetched",
      upstreamCode: result.upstreamCode,
      webUrl: result.webUrl,
      appUrl: result.appUrl,
      errorKind: null,
      errorMessage: null,
      fetchedAt: now,
      lastAttemptedAt: now,
    },
  });
  const articleBinding = await bindPromoLinkToArticles(tx, scope.source.novelId, row.id);
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: `promo_link_claim.${options.decision}`,
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: {
        decision: options.decision,
        articlesBound: articleBinding.boundArticleIds.length,
        articlesAlreadyBound: articleBinding.alreadyBoundArticleIds.length,
        articlesConflicted: articleBinding.conflictedArticleIds.length,
        upstreamCode: redactUpstreamCode(result.upstreamCode),
        host: safeHostname(result.webUrl ?? result.appUrl),
      },
    },
  });
  if (options.intentEffectKey) {
    await confirmSideEffectIntentByReadbackInTransaction(tx, {
      effectKey: options.intentEffectKey,
      evidence: { hasWebUrl: Boolean(result.webUrl), hasAppUrl: Boolean(result.appUrl) },
    });
  }
  return row.id;
}

// ---------------------------------------------------------------------
// §3.10 claimPromo path — real contract, dual-gated, single mutation with
// readback-only recovery.
// ---------------------------------------------------------------------

function claimRequestScalar(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function buildClaimPromoRequest(
  rawPayload: unknown,
  name: string,
  projectType: number,
  offerType: string,
): ClaimPromoRequest | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const row = rawPayload as Record<string, unknown>;
  const agencyId = claimRequestScalar(row.agencyId);
  const seriesId = claimRequestScalar(row.seriesId);
  const language = claimRequestScalar(row.language);
  if (agencyId === null || seriesId === null || language === null) return null;
  return { agencyId, seriesId, projectType, language, name: name.trim(), offerType };
}

/** SideEffectIntent identity for one specific worker attempt — see this file's header for why it is per-(task, item, attemptCount), not per-PromoLink. */
function buildAttemptEffectKey(taskId: string, itemId: string, attemptCount: number): string {
  return createHash("sha256").update(`promo_link_claim_attempt\n${taskId}\n${itemId}\n${attemptCount}`, "utf8").digest("hex");
}

interface FailedOutcome {
  status: "failed";
  error: { code: string; message: string };
}

type ReadbackSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

function waitForReadbackRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("readback_retry_aborted"));
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("readback_retry_aborted"));
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function failed(code: string, message: string): FailedOutcome {
  return { status: "failed", error: { code, message } };
}

function readbackFailureEvidence(
  result: Exclude<ReadPromoAfterClaimResult, { status: "found" }>,
): Record<string, string | number | null | boolean> {
  if (result.status === "missing") {
    return { readbackConfirmed: false, readbackStatus: "promo_missing" };
  }
  const evidence: Record<string, string | number | null | boolean> = {
    readbackConfirmed: false,
    readbackStatus: result.status,
    readbackReason: result.reason,
    readbackTotalCount: result.totalCount,
  };
  if ("returnedCount" in result) evidence.readbackReturnedCount = result.returnedCount;
  return evidence;
}

async function resolveClaimCredential(
  db: PrismaClient,
  accountId: string,
  now: Date,
): Promise<{ secret: string } | FailedOutcome> {
  const credentials = await db.channelAccountCredential.findMany({
    where: { channelAccountId: accountId, status: "active" },
    select: { id: true, encryptedSecret: true, keyVersion: true, expiresAt: true },
  });
  const nowMs = now.valueOf();
  const nonExpired = credentials.filter((row) => row.expiresAt === null || row.expiresAt.valueOf() > nowMs);
  if (nonExpired.length === 0) {
    return failed(credentials.length === 0 ? "credential_missing" : "credential_expired", "No usable active credential for this account");
  }
  if (nonExpired.length > 1) return failed("credential_ambiguous", "Multiple active credentials exist for this account");
  const credential = nonExpired[0];
  const secret = decryptCredentialSecretForWorker(credential.encryptedSecret, accountId, credential.id, credential.keyVersion);
  const local = validateCredentialJwtLocally(secret, now);
  if (local.status !== "active") {
    return failed(local.status === "expired" ? "credential_expired" : "credential_invalid", "Credential failed local validation");
  }
  return { secret };
}

async function claimViaAdapter(
  db: PrismaClient,
  adapter: PromoLinkClaimAdapter,
  scope: ClaimScope,
  payload: PromoLinkClaimPayload,
  lease: { taskId: string; itemId: string; attemptCount: number },
  now: Date,
  signal: AbortSignal,
  heartbeat: () => Promise<boolean>,
  readbackPolicy: Readonly<PromoLinkClaimReadbackPolicy>,
  sleep: ReadbackSleep,
): Promise<{ status: "success" | "failed"; result?: unknown; error?: unknown; protectedWrite: (tx: Prisma.TransactionClient) => Promise<void> }> {
  const credential = await resolveClaimCredential(db, scope.account.id, now);
  if ("status" in credential) {
    return { status: "failed", error: credential.error, protectedWrite: async () => undefined };
  }

  if (!scope.source.title.trim()) {
    return {
      status: "failed",
      error: { code: "claim_readback_title_unavailable", message: "The exact-target readback title is unavailable" },
      protectedWrite: async () => undefined,
    };
  }
  const builtRequest = buildClaimPromoRequest(
    scope.source.rawPayload,
    scope.source.title,
    scope.app.projectType,
    payload.offerType,
  );
  if (!builtRequest) {
    return {
      status: "failed",
      error: { code: "claim_source_fields_missing", message: "NovelSourceItem raw_payload is missing agencyId/seriesId/language" },
      protectedWrite: async () => undefined,
    };
  }
  let request: ClaimPromoRequest = builtRequest;

  if (!adapter.readPromoAfterClaim) {
    return {
      status: "failed",
      error: { code: "claim_readback_unavailable", message: "Promo readback adapter is unavailable" },
      protectedWrite: async () => undefined,
    };
  }

  interface ExactReadbackOptions {
    /** Retry a successful-but-not-yet-visible promo result after mutation. */
    retryPromoVisibility: boolean;
    /** A successful claim must eventually read back the same code. */
    expectedUpstreamCode?: string;
  }

  /**
   * Transport/visibility layer for one title coordinate. Only retryable
   * read errors (429/5xx/timeout/network) are repeated. After mutation,
   * `missing` and a stale promo code are also repeated because getlistpc may
   * lag getcode. Structural contract failures return immediately.
   */
  const readCoordinate = async (
    options: ExactReadbackOptions,
  ): Promise<ReadPromoAfterClaimResult> => {
    for (let attempt = 1; attempt <= readbackPolicy.attempts; attempt += 1) {
      let result: ReadPromoAfterClaimResult;
      try {
        result = await adapter.readPromoAfterClaim!(request, credential.secret, signal);
      } catch (error) {
        const classified = classifyClaimPromoFailure(error);
        if (!classified.retryable || attempt === readbackPolicy.attempts) throw error;
        await sleep(readbackPolicy.intervalMs, signal);
        if (signal.aborted) throw new Error("readback_retry_aborted");
        continue;
      }

      const promoNotVisible = options.retryPromoVisibility && (
        result.status === "missing"
        || (
          result.status === "found"
          && options.expectedUpstreamCode !== undefined
          && result.promo.upstreamCode !== options.expectedUpstreamCode
        )
      );
      if (!promoNotVisible || attempt === readbackPolicy.attempts) return result;
      await sleep(readbackPolicy.intervalMs, signal);
      if (signal.aborted) throw new Error("readback_retry_aborted");
    }
    throw new Error("readback_retry_loop_exhausted_without_result");
  };

  /**
   * Semantic locator layer shared by pre-read, post-claim confirmation, and
   * readback-only recovery. A zero-row result reloads the mutable title and
   * retries that coordinate exactly once. Each coordinate independently
   * receives the bounded read-only policy above; getcode is never involved.
   */
  const readback = async (options: ExactReadbackOptions): Promise<ReadPromoAfterClaimResult> => {
    const first = await readCoordinate(options);
    if (first.status !== "target_not_located" || first.reason !== "title_no_match") return first;

    const refreshedSource = await db.novelSourceItem.findUnique({
      where: { id: scope.source.id },
      select: { title: true },
    });
    const refreshedTitle = refreshedSource?.title.trim() ?? "";
    if (!refreshedTitle) {
      return { status: "target_not_located", reason: "title_unavailable", totalCount: null };
    }
    request = { ...request, name: refreshedTitle };
    const retried = await readCoordinate(options);
    if (retried.status === "target_not_located" && retried.reason === "title_no_match") {
      return { status: "target_not_located", reason: "locator_stale", totalCount: 0 };
    }
    return retried;
  };

  async function routeIntentToManualReview(
    effectKey: string,
    status: string,
    responseShape?: Record<string, string | number | null | boolean>,
  ): Promise<void> {
    if (status === "prepared") {
      await transitionSideEffectIntent(db, { effectKey, status: "claim_retry_blocked", responseShape });
      await transitionSideEffectIntent(db, { effectKey, status: "manual_review_required" });
    } else if (status === "claim_retry_blocked") {
      await transitionSideEffectIntent(db, { effectKey, status: "manual_review_required", responseShape });
    }
    // A legacy `confirmed` row from the old confirmed-before-finalize
    // sequence is deliberately left confirmed. Its presence still blocks
    // every future mutation and forces readback-only recovery.
  }

  // Include legacy `confirmed` rows so a crash produced by the old ordering
  // can never fall through to another getcode call.
  const priorIntent = await db.sideEffectIntent.findFirst({
    where: {
      targetType: "promo_link",
      targetId: scope.idempotencyKey,
      status: { in: ["prepared", "claim_retry_blocked", "manual_review_required", "confirmed"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (priorIntent) {
    // Once an intent has entered manual review, the generic worker may not
    // adjudicate it back to confirmed. X9 owns that transition boundary.
    // It also must not spend another upstream request for an object whose
    // automatic lifecycle is already terminal.
    if (priorIntent.status === "manual_review_required") {
      return {
        status: "success",
        result: { decision: "manual_review_required" },
        protectedWrite: (tx) => writePromoLinkManualReview(tx, scope, payload, now).then(() => undefined),
      };
    }
    let priorReadbackEvidence: Record<string, string | number | null | boolean> = {
      readbackConfirmed: false,
      readbackStatus: "readback_error",
    };
    try {
      const recovered = await readback({ retryPromoVisibility: true });
      if (recovered.status === "found") {
        return {
          status: "success",
          result: { decision: "readback_recovered" },
          protectedWrite: (tx) => writePromoLinkClaimed(tx, scope, payload, recovered.promo, now, {
            origin: "claimed",
            decision: "readback_recovered",
            ...(priorIntent.status === "confirmed" ? {} : { intentEffectKey: priorIntent.effectKey }),
          }).then(() => undefined),
        };
      }
      priorReadbackEvidence = readbackFailureEvidence(recovered);
    } catch {
      // Readback failure cannot authorize another mutation. It is routed to
      // the same manual-review terminal below without exposing response data.
    }
    await routeIntentToManualReview(priorIntent.effectKey, priorIntent.status, priorReadbackEvidence);
    return {
      status: "success",
      result: { decision: "manual_review_required", readback: priorReadbackEvidence },
      protectedWrite: (tx) => writePromoLinkManualReview(tx, scope, payload, now).then(() => undefined),
    };
  }

  // CPS parity: a current upstream promo short-circuits before any intent or
  // mutation. Failure of this read-only guard fails closed; it never falls
  // through to getcode.
  let preRead;
  try {
    preRead = await readback({ retryPromoVisibility: false });
  } catch (error) {
    const classified = classifyClaimPromoFailure(error);
    return {
      status: "failed",
      error: { code: classified.failureCategory, message: "Promo pre-read failed" },
      protectedWrite: async () => undefined,
    };
  }
  if (preRead.status === "found") {
    return {
      status: "success",
      result: { decision: "already_available" },
      protectedWrite: (tx) => writePromoLinkClaimed(tx, scope, payload, preRead.promo, now, {
        origin: "upstream_existing",
        decision: "already_available",
      }).then(() => undefined),
    };
  }
  if (preRead.status === "target_not_located") {
    return {
      status: "failed",
      error: {
        code: preRead.reason === "title_unavailable"
          ? "claim_readback_title_unavailable"
          : preRead.reason === "locator_stale"
            ? "claim_readback_locator_stale"
            : "claim_readback_target_not_located",
        message: preRead.reason === "locator_stale"
          ? "The catalog title locator returned zero rows before and after its single refresh; manual review is required"
          : "The exact-target title locator is unavailable",
      },
      protectedWrite: async () => undefined,
    };
  }
  if (preRead.status === "target_missing") {
    return {
      status: "failed",
      error: {
        code: "claim_readback_target_missing",
        message: `The complete candidate set contains no four-dimensional target match (totalCount=${preRead.totalCount})`,
      },
      protectedWrite: async () => undefined,
    };
  }
  if (preRead.status === "ambiguous") {
    return {
      status: "failed",
      error: {
        code: "claim_readback_ambiguous",
        message: `Exact-target readback requires manual review (${preRead.reason}, totalCount=${preRead.totalCount}, returnedCount=${preRead.returnedCount ?? "not_array"})`,
      },
      protectedWrite: async () => undefined,
    };
  }

  const effectKey = buildAttemptEffectKey(lease.taskId, lease.itemId, lease.attemptCount);
  await prepareSideEffectIntent(db, {
    effectKey,
    operationType: "promo_link.claim_promo",
    idempotencyKey: effectKey,
    targetType: "promo_link",
    targetId: scope.idempotencyKey,
    channelAccountId: scope.account.id,
    channelAppId: scope.app.id,
    requestSummary: { offerType: payload.offerType, novelSourceItemId: scope.source.id },
  });

  // Ownership is revalidated immediately before the only mutation. The
  // runtime also wires lease loss into `signal`, so an in-flight request is
  // aborted locally; because abort does not prove the server did not receive
  // it, the catch path below still treats the outcome as ambiguous.
  if (signal.aborted || !(await heartbeat())) {
    return {
      status: "failed",
      error: { code: "lease_lost_before_claim", message: "Lease ownership was lost before claimPromo" },
      protectedWrite: async () => undefined,
    };
  }

  let claimResult: ClaimPromoResult;
  try {
    claimResult = await adapter.claimPromo(request, credential.secret, signal);
  } catch (error) {
    const classified = classifyClaimPromoFailure(error);
    if (classified.ambiguous) {
      let recoveryEvidence: Record<string, string | number | null | boolean> = {
        readbackConfirmed: false,
        readbackStatus: "readback_error",
      };
      try {
        const recovered = await readback({ retryPromoVisibility: true });
        if (recovered.status === "found") {
          return {
            status: "success",
            result: { decision: "readback_recovered" },
            protectedWrite: (tx) => writePromoLinkClaimed(tx, scope, payload, recovered.promo, now, {
              origin: "claimed",
              decision: "readback_recovered",
              intentEffectKey: effectKey,
            }).then(() => undefined),
          };
        }
        recoveryEvidence = readbackFailureEvidence(recovered);
      } catch {
        // The mutation remains ambiguous. Never call getcode again.
      }
      await transitionSideEffectIntent(db, {
        effectKey,
        status: "claim_retry_blocked",
        responseShape: { failureCategory: classified.failureCategory, ...recoveryEvidence },
      });
      await transitionSideEffectIntent(db, { effectKey, status: "manual_review_required" });
      return {
        status: "success",
        result: { decision: "manual_review_required" },
        protectedWrite: (tx) => writePromoLinkManualReview(tx, scope, payload, now).then(() => undefined),
      };
    }
    await transitionSideEffectIntent(db, {
      effectKey,
      status: "failed",
      responseShape: { failureCategory: classified.failureCategory },
    });
    return {
      status: "failed",
      error: { code: classified.failureCategory, message: "claimPromo failed" },
      protectedWrite: (tx) => writePromoLinkClaimFailed(tx, scope, payload, classified.failureCategory, now).then(() => undefined),
    };
  }

  let confirmed: ReadPromoAfterClaimResult | null = null;
  try {
    confirmed = await readback({
      retryPromoVisibility: true,
      expectedUpstreamCode: claimResult.upstreamCode,
    });
  } catch {
    // The intent evidence below records the readback error without exposing
    // an upstream body or authorizing another mutation.
  }
  if (!confirmed || confirmed.status !== "found" || confirmed.promo.upstreamCode !== claimResult.upstreamCode) {
    const confirmationEvidence = !confirmed
      ? { readbackConfirmed: false, readbackStatus: "readback_error" }
      : confirmed.status === "found"
        ? { readbackConfirmed: false, readbackStatus: "promo_code_mismatch" }
        : readbackFailureEvidence(confirmed);
    await transitionSideEffectIntent(db, {
      effectKey,
      status: "claim_retry_blocked",
      responseShape: { failureCategory: "readback_unconfirmed", ...confirmationEvidence },
    });
    await transitionSideEffectIntent(db, { effectKey, status: "manual_review_required" });
    return {
      status: "success",
      result: { decision: "manual_review_required" },
      protectedWrite: (tx) => writePromoLinkManualReview(tx, scope, payload, now).then(() => undefined),
    };
  }
  return {
    status: "success",
    result: { decision: "claimed" },
    protectedWrite: (tx) => writePromoLinkClaimed(tx, scope, payload, confirmed.promo, now, {
      origin: "claimed",
      decision: "claimed",
      intentEffectKey: effectKey,
    }).then(() => undefined),
  };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export interface PromoLinkClaimHandlerDependencies {
  adapter?: PromoLinkClaimAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Test/host hook; production uses an AbortSignal-aware timer. */
  sleep?: ReadbackSleep;
}

export function createPromoLinkClaimHandler(
  db: PrismaClient,
  dependencies: PromoLinkClaimHandlerDependencies = {},
): TaskHandler {
  // RC-3: shares the same process-wide upstream pacing door as the
  // catalog/Preview adapters (`worker/handlers/moboreader.ts`) — getcode and
  // its readback hit the same host, so all three task families must pace
  // against one shared clock. This only makes the dispatch wait its turn;
  // it does not add or change retries (the getcode call/error contract
  // above stays frozen).
  const adapter = dependencies.adapter ?? createPromoLinkClaimAdapter({ rateGate: moboreaderUpstreamRateGate });
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const readbackPolicy = resolvePromoLinkClaimReadbackPolicy(env);
  const sleep = dependencies.sleep ?? waitForReadbackRetry;
  return async ({ lease, mode, signal, heartbeat }) => {
    const payload = parsePromoLinkClaimPayload(lease.payload);

    if (!isPromoLinkClaimEnabled(env)) {
      return { status: "failed", error: { code: "feature_disabled", message: "Promo link claim feature is disabled" } };
    }
    if (now().valueOf() >= Date.parse(payload.expiresAt)) {
      return { status: "failed", error: { code: "task_expired", message: "Promo link claim task expired" } };
    }

    let scope: ClaimScope;
    try {
      scope = await loadClaimScope(db, payload);
    } catch (error) {
      return {
        status: "failed",
        error: { code: error instanceof Error ? error.message : "claim_scope_invalid", message: "Unable to resolve claim scope" },
      };
    }

    const writeAllowed = mode === "apply" && isPromoLinkClaimWriteAllowed(env);

    // A fetched PromoLink may predate Article creation (or have been written
    // directly by catalog sync). Reconcile the binding before declaring the
    // item terminal; this is zero-write when every Article is already bound.
    if (scope.existingPromoLink?.status === "fetched") {
      if (!writeAllowed) {
        return { status: "skipped", result: { decision: "already_fetched", promoLinkId: scope.existingPromoLink.id } };
      }
      return {
        status: "success",
        result: { decision: "already_fetched", promoLinkId: scope.existingPromoLink.id },
        protectedWrite: (tx) => reconcileAlreadyFetchedBinding(tx, scope, payload),
      };
    }

    // Doc §4 item 14 "dry-run 走完真实判定": feature flag, TTL,
    // scope resolution, fetched-link reconciliation, and the capability
    // decision all run for real. Promo evidence is owned exclusively by the
    // catalog-capture boundary and is never reconstructed from rawPayload.
    if (!writeAllowed) {
      return {
        status: "skipped",
        result: { decision: scope.capabilityEnabled ? "would_claim" : "would_skip_capability_disabled" },
      };
    }

    if (!scope.capabilityEnabled) {
      return {
        status: "success",
        result: { decision: "capability_disabled" },
        protectedWrite: (tx) => writePromoLinkCapabilityDisabled(tx, scope, payload, now()).then(() => undefined),
      };
    }

    return claimViaAdapter(
      db,
      adapter,
      scope,
      payload,
      lease,
      now(),
      signal,
      heartbeat,
      readbackPolicy,
      sleep,
    );
  };
}

export function createPromoLinkClaimWorkerHandlers(
  db: PrismaClient,
  dependencies: PromoLinkClaimHandlerDependencies = {},
) {
  return createHandlerRegistry({
    [PROMO_LINK_CLAIM_TASK_TYPE]: {
      family: "generic",
      // getcode idempotency is unverified. A worker item therefore receives
      // exactly one execution attempt. Crash/unknown recovery is initiated
      // by a fresh explicit task, whose prior-intent guard permits readback
      // only and can never reach the mutation again.
      maxAttempts: 1,
      handler: createPromoLinkClaimHandler(db, dependencies),
    },
  });
}
