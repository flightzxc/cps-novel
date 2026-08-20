/**
 * Promo-link claim `TaskHandler`
 * (`docs/architecture/candidate-v0.2.1/novel-v1-adapter-and-workflow-
 * v0.2.1.md` §3.9/§3.10, §4). One unified decision tree per
 * `GenericTaskItem`, covering both halves of the architecture doc's flow:
 *
 *   1. §3.9 "已有推广资源读取" — always enabled, zero additional upstream
 *      calls. Reads `kocCode`/`publicUrl`/`homeLink`/`onlineUrl` straight
 *      out of `NovelSourceItem.rawPayload` (already fetched by the proven
 *      `getlistpc`/`getbydataid` capabilities during catalog sync —
 *      `worker/handlers/moboreader.ts`). *If a genuine, non-redacted value
 *      were ever present*, this alone would be enough to write
 *      `PromoLink.status = 'fetched'` — but 🔴 **it never is, in the sync
 *      pipeline as it exists today**: `src/lib/adapters/moboreader.ts`'s
 *      `toApprovedRawEvidence` unconditionally masks these exact fields to
 *      `REDACTED_EVIDENCE_SENTINEL` before `rawPayload` is ever persisted
 *      (`worker/handlers/moboreader.ts`'s `persistCatalogPage` is the only
 *      writer). This handler's pre-read (`readExistingPromoFromRawPayload`)
 *      therefore always observes `redacted: true` in production and takes
 *      the third outcome below instead of ever reaching `fetched` through
 *      this path — see `writePromoLinkExistingEvidenceRedacted` for the
 *      write this produces, and its doc comment for what enabling this
 *      path for real would require (Owner-gated, out of this task's scope).
 *      The `already_available`/`fetched` write path itself remains correct
 *      code, exercised by fixtures using genuinely non-redacted input, for
 *      whenever that follow-up work lands.
 *   2. §3.10 "推广生成（占位流程）" — the side-effecting `claimPromo`
 *      capability. `ChannelCapability.status` for this key is
 *      `registered_disabled` everywhere in this codebase (nothing sets it
 *      to `enabled` — see `src/lib/adapters/promo-link-claim.ts`'s header
 *      for the four Owner-gated preconditions), so this path always
 *      terminates at "capability_disabled" in production today. The full
 *      `SideEffectIntent` → adapter → PromoLink state machine below it is
 *      real and tested (via a fixture adapter), not a stub — only the
 *      network call itself is refused.
 *
 * `upstream_code` (the channel's real promo code) is read from upstream
 * responses and written to the DB, but must never reach a log line, an
 * error message, or an `OperationAudit`/task `result` snapshot — every
 * place this handler surfaces claim outcomes uses `redactUpstreamCode`
 * (length-only) or `safeHostname` (host-only) instead. `tests/backend/
 * tasks/promo-link-claim-redaction.test.ts` asserts this with a fixture
 * that carries both codes side by side.
 *
 * Whenever a PromoLink genuinely reaches `fetched` (either write path
 * above), this handler also binds it back onto every locale Article for
 * its Novel (`bindPromoLinkToArticles`) in the same transaction — see that
 * function's header for the cardinality this binding strategy is derived
 * from and its conflict semantics. This is the only writer of
 * `Article.promoLinkId` in this codebase; without it, `evaluatePublishGate`
 * reports `promo_link_missing` forever even once a real PromoLink exists.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  classifyClaimPromoFailure,
  createPromoLinkClaimAdapter,
  REDACTED_EVIDENCE_SENTINEL,
  type ClaimPromoRequest,
  type ClaimPromoResult,
  type PromoLinkClaimAdapter,
} from "../../src/lib/adapters";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../../src/lib/flags";
import {
  createHandlerRegistry,
  prepareSideEffectIntent,
  transitionSideEffectIntent,
  type TaskHandler,
} from "../../src/lib/tasks";
import {
  PROMO_LINK_CLAIM_CAPABILITY_KEY,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "../../src/lib/tasks/promo-link-claim-limits";
import { createPublicRedirectCode } from "../../src/lib/redirect";
import { validateCredentialJwtLocally } from "../../src/lib/credentials/jwt";
import { decryptCredentialSecretForWorker } from "../credentials/crypto";

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
// §3.9 pre-read — pure, no IO
// ---------------------------------------------------------------------

export interface ExistingPromoRead {
  kocCode: string | null;
  webUrl: string | null;
  appUrl: string | null;
  /**
   * True when at least one of the promo-shaped `raw_payload` fields
   * (`kocCode`/`publicUrl`/`homeLink`/`onlineUrl`) carried
   * `REDACTED_EVIDENCE_SENTINEL` rather than a real value. This is
   * deliberately a separate signal from `kocCode === null`: the sentinel
   * means "the sync-time adapter boundary masked this field" (see
   * `src/lib/adapters/moboreader.ts`'s `toApprovedRawEvidence` — the *only*
   * writer of `NovelSourceItem.rawPayload`, per
   * `worker/handlers/moboreader.ts`'s `persistCatalogPage`), which is a
   * structurally different fact than "upstream confirmed no promo yet"
   * (doc §3.9's `promo_not_generated`). Conflating the two would make a
   * masked-but-possibly-real code look identical to a genuine absence — the
   * exact confusion this field exists to prevent. See this module's header
   * and `writePromoLinkExistingEvidenceRedacted` for how callers must act
   * on it.
   */
  redacted: boolean;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === REDACTED_EVIDENCE_SENTINEL) return null;
  return trimmed;
}

function isRedactedSentinel(value: unknown): boolean {
  return value === REDACTED_EVIDENCE_SENTINEL;
}

/**
 * Reads the already-fetched promo fields straight out of `raw_payload` — no
 * upstream call. Field mapping per doc §2.3 `readExistingPromo`:
 * `kocCode`/`publicUrl`/`homeLink` are `PRODUCTION_READ_PROVEN`.
 * `onlineUrl` → `appUrl` is this handler's own interpretation, not
 * doc-proven: the doc lists `onlineUrl` alongside `publicUrl`/`homeLink` as
 * one of the promo-shaped fields returned by the catalog endpoints, but
 * explicitly flags its null-vs-populated meaning as unproven ("onlineUrl
 * 为 null 的含义未证" — §2.3 `readExistingPromo` 未知项). Every observed
 * sample has it null, so this mapping is currently inert; it only matters
 * once a populated sample is captured, at which point Codex should verify
 * this interpretation against real evidence rather than assume it.
 *
 * 🔴 Production reality today: `src/lib/adapters/moboreader.ts`'s
 * `REDACTED_EVIDENCE_KEYS` unconditionally masks `kocCode`/`publicUrl`/
 * `homeLink`/`onlineUrl` to `REDACTED_EVIDENCE_SENTINEL` before
 * `persistCatalogPage` ever writes `rawPayload` — so `nonBlank` below can
 * never observe a real value for these four fields via the sync pipeline as
 * it exists today, and `kocCode`/`webUrl`/`appUrl` on the returned value are
 * therefore always `null` in production; `redacted` is the field that
 * actually distinguishes "upstream had nothing" from "upstream may have had
 * something, but sync threw it away before we could judge". Enabling this
 * §3.9 read path for real needs two things neither of which this task
 * implements: (a) confirming against real upstream evidence that these
 * fields are genuinely populated, and (b) moving catalog-sync's promo-code
 * capture out of the redacted `rawPayload` snapshot into `PromoLink.
 * upstreamCode` directly (its correct home) instead of `rawPayload`. Both
 * are Owner-gated follow-up work, tracked separately — not this ticket.
 */
export function readExistingPromoFromRawPayload(rawPayload: unknown): ExistingPromoRead {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return { kocCode: null, webUrl: null, appUrl: null, redacted: false };
  }
  const row = rawPayload as Record<string, unknown>;
  const redacted = isRedactedSentinel(row.kocCode)
    || isRedactedSentinel(row.publicUrl)
    || isRedactedSentinel(row.homeLink)
    || isRedactedSentinel(row.onlineUrl);
  return {
    kocCode: nonBlank(row.kocCode),
    webUrl: nonBlank(row.publicUrl) ?? nonBlank(row.homeLink),
    appUrl: nonBlank(row.onlineUrl),
    redacted,
  };
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
export function buildPromoLinkIdempotencyKey(input: {
  channelAppId: string;
  novelSourceItemId: string;
  channelAccountId: string;
  offerType: string;
}): string {
  return createHash("sha256")
    .update(`promo_link\n${input.channelAppId}\n${input.novelSourceItemId}\n${input.channelAccountId}\n${input.offerType}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------

interface ClaimScope {
  source: { id: string; novelId: string; rawPayload: unknown };
  app: { id: string; channelId: string; projectType: number };
  account: { id: string };
  capabilityEnabled: boolean;
  idempotencyKey: string;
  existingPromoLink: { id: string; status: string; publicRedirectCode: string } | null;
}

async function loadClaimScope(db: PrismaClient, payload: PromoLinkClaimPayload): Promise<ClaimScope> {
  const source = await db.novelSourceItem.findUnique({
    where: { id: payload.novelSourceItemId },
    select: { id: true, novelId: true, channelAppId: true, deletedAt: true, status: true, rawPayload: true },
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
    source: { id: source.id, novelId: source.novelId, rawPayload: source.rawPayload },
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

interface ArticleBindingResult {
  boundArticleIds: string[];
  alreadyBoundArticleIds: string[];
  conflictedArticleIds: string[];
}

/**
 * Binds `promoLinkId` onto every non-deleted Article for `novelId` that
 * does not already carry a *different* PromoLink. Runs inside the same `tx`
 * as the PromoLink write that produced `promoLinkId` (both
 * `writePromoLinkAlreadyAvailable` and `writePromoLinkClaimed` call this
 * after their `promoLink.update`), and therefore inherits that write's
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
async function bindPromoLinkToArticles(
  tx: Prisma.TransactionClient,
  novelId: string,
  promoLinkId: string,
): Promise<ArticleBindingResult> {
  const articles = await tx.article.findMany({
    where: { novelId, deletedAt: null },
    select: { id: true, promoLinkId: true },
  });
  const result: ArticleBindingResult = { boundArticleIds: [], alreadyBoundArticleIds: [], conflictedArticleIds: [] };
  for (const article of articles) {
    if (article.promoLinkId === promoLinkId) {
      result.alreadyBoundArticleIds.push(article.id);
      continue;
    }
    if (article.promoLinkId !== null) {
      result.conflictedArticleIds.push(article.id);
      continue;
    }
    await tx.article.update({ where: { id: article.id }, data: { promoLinkId } });
    result.boundArticleIds.push(article.id);
  }
  return result;
}

async function writePromoLinkAlreadyAvailable(
  tx: Prisma.TransactionClient,
  scope: ClaimScope,
  existingRead: ExistingPromoRead,
  payload: PromoLinkClaimPayload,
  now: Date,
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      origin: "upstream_existing",
      status: "fetched",
      upstreamCode: existingRead.kocCode,
      webUrl: existingRead.webUrl,
      appUrl: existingRead.appUrl,
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
      action: "promo_link_claim.already_available",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: {
        decision: "already_available",
        upstreamCode: redactUpstreamCode(existingRead.kocCode),
        host: safeHostname(existingRead.webUrl ?? existingRead.appUrl),
        articlesBound: articleBinding.boundArticleIds.length,
        articlesAlreadyBound: articleBinding.alreadyBoundArticleIds.length,
        articlesConflicted: articleBinding.conflictedArticleIds.length,
      },
    },
  });
  return row.id;
}

/**
 * §3.9's third outcome — distinct from both `already_available` (real,
 * usable evidence) and `capability_disabled`/`promo_not_generated` (a
 * genuine absence). `raw_payload` carries `REDACTED_EVIDENCE_SENTINEL` for
 * at least one promo-shaped field, which means the sync-time adapter
 * boundary masked whatever was there — we cannot tell from this alone
 * whether upstream actually has a promo code. Writing `fetched` here would
 * silently persist the sentinel as if it were the real `upstream_code`/
 * `web_url` (exactly the defect this function exists to close — the public
 * `/go/{code}` redirect would resolve `"[redacted]"` as a URL and 404 for
 * every reader while the publish gate waved the Article through as ready).
 * `status` stays inside the four values the `promo_link_status_check`
 * CHECK constraint allows (`pending`/`fetched`/`failed`/
 * `registered_disabled`) — `pending` + a distinguishing `errorKind` is the
 * same pattern `writePromoLinkManualReview` already uses for "not resolved,
 * blocked for a specific, known, non-error reason".
 *
 * Deliberately does **not** fall through to the §3.10 capability check
 * below it: `REDACTED_EVIDENCE_KEYS` masks these fields unconditionally
 * whenever upstream's response object includes the key at all (empty or
 * populated), so in the current sync implementation this branch fires for
 * effectively every synced row — always short-circuiting here keeps that
 * fact visible in `errorKind` instead of getting silently absorbed into
 * `capability_disabled`'s message (which would then wrongly read as "no
 * promo exists AND capability is off", losing the redaction fact
 * entirely). If `claimPromo` is ever unfrozen, whoever does that unfreezing
 * must decide — with real evidence in hand, per this module's header —
 * whether an `existing_evidence_redacted` PromoLink should still attempt a
 * live claim; that decision is out of this task's scope.
 */
async function writePromoLinkExistingEvidenceRedacted(
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
      errorKind: "existing_evidence_redacted",
      errorMessage: "raw_payload carries the sync-time redaction sentinel for one or more promo fields; local evidence cannot be used to judge whether upstream already has a promo (worker/handlers/promo-link-claim.ts header)",
      lastAttemptedAt: now,
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: payload.actorId,
      action: "promo_link_claim.existing_evidence_redacted",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: { decision: "existing_evidence_redacted" },
    },
  });
  return row.id;
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
      errorMessage: "claimPromo capability is registered_disabled pending Owner unfreeze (novel-v1-adapter-and-workflow-v0.2.1.md §2.3)",
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
): Promise<string> {
  const row = await ensurePromoLinkRow(tx, scope, payload);
  await tx.promoLink.update({
    where: { idempotencyKey: scope.idempotencyKey },
    data: {
      origin: "claimed",
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
      action: "promo_link_claim.claimed",
      entityType: "PromoLink",
      entityId: row.id,
      requestId: payload.requestId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      afterSnapshot: {
        decision: "claimed",
        articlesBound: articleBinding.boundArticleIds.length,
        articlesAlreadyBound: articleBinding.alreadyBoundArticleIds.length,
        articlesConflicted: articleBinding.conflictedArticleIds.length,
        upstreamCode: redactUpstreamCode(result.upstreamCode),
        host: safeHostname(result.webUrl ?? result.appUrl),
      },
    },
  });
  return row.id;
}

// ---------------------------------------------------------------------
// §3.10 claimPromo path — real, tested via fixture adapter; unreachable in
// production because `loadClaimScope`'s `capabilityEnabled` is always
// false (see module header).
// ---------------------------------------------------------------------

function claimRequestScalar(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function buildClaimPromoRequest(
  rawPayload: unknown,
  projectType: number,
  offerType: string,
): ClaimPromoRequest | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const row = rawPayload as Record<string, unknown>;
  const agencyId = claimRequestScalar(row.agencyId);
  const seriesId = claimRequestScalar(row.seriesId);
  const language = claimRequestScalar(row.language);
  if (agencyId === null || seriesId === null || language === null) return null;
  return { agencyId, seriesId, projectType, language, offerType };
}

/** SideEffectIntent identity for one specific worker attempt — see this file's header for why it is per-(task, item, attemptCount), not per-PromoLink. */
function buildAttemptEffectKey(taskId: string, itemId: string, attemptCount: number): string {
  return createHash("sha256").update(`promo_link_claim_attempt\n${taskId}\n${itemId}\n${attemptCount}`, "utf8").digest("hex");
}

interface FailedOutcome {
  status: "failed";
  error: { code: string; message: string };
}

function failed(code: string, message: string): FailedOutcome {
  return { status: "failed", error: { code, message } };
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
): Promise<{ status: "success" | "failed"; result?: unknown; error?: unknown; protectedWrite: (tx: Prisma.TransactionClient) => Promise<void> }> {
  // Doc §3.10: "最近一条意图审计未被确认？→ claim_retry_blocked（转人工，禁止
  // 自动重试）". Scoped by `targetId = scope.idempotencyKey` (the PromoLink
  // asset identity), not by this attempt's own (not-yet-created) effectKey
  // — any row found here necessarily belongs to an *earlier* attempt.
  const priorUnconfirmed = await db.sideEffectIntent.findFirst({
    where: {
      targetType: "promo_link",
      targetId: scope.idempotencyKey,
      status: { in: ["prepared", "claim_retry_blocked", "manual_review_required"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (priorUnconfirmed) {
    if (priorUnconfirmed.status === "prepared") {
      await transitionSideEffectIntent(db, { effectKey: priorUnconfirmed.effectKey, status: "claim_retry_blocked" });
      await transitionSideEffectIntent(db, { effectKey: priorUnconfirmed.effectKey, status: "manual_review_required" });
    } else if (priorUnconfirmed.status === "claim_retry_blocked") {
      await transitionSideEffectIntent(db, { effectKey: priorUnconfirmed.effectKey, status: "manual_review_required" });
    }
    return {
      status: "success",
      result: { decision: "manual_review_required" },
      protectedWrite: (tx) => writePromoLinkManualReview(tx, scope, payload, now).then(() => undefined),
    };
  }

  const credential = await resolveClaimCredential(db, scope.account.id, now);
  if ("status" in credential) {
    return { status: "failed", error: credential.error, protectedWrite: async () => undefined };
  }

  const request = buildClaimPromoRequest(scope.source.rawPayload, scope.app.projectType, payload.offerType);
  if (!request) {
    return {
      status: "failed",
      error: { code: "claim_source_fields_missing", message: "NovelSourceItem raw_payload is missing agencyId/seriesId/language" },
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

  let claimResult: ClaimPromoResult;
  try {
    claimResult = await adapter.claimPromo(request, credential.secret, signal);
  } catch (error) {
    const classified = classifyClaimPromoFailure(error);
    if (classified.ambiguous) {
      await transitionSideEffectIntent(db, {
        effectKey,
        status: "claim_retry_blocked",
        responseShape: { failureCategory: classified.failureCategory },
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

  await transitionSideEffectIntent(db, {
    effectKey,
    status: "confirmed",
    responseShape: { hasWebUrl: Boolean(claimResult.webUrl), hasAppUrl: Boolean(claimResult.appUrl) },
  });
  return {
    status: "success",
    result: { decision: "claimed" },
    protectedWrite: (tx) => writePromoLinkClaimed(tx, scope, payload, claimResult, now).then(() => undefined),
  };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export interface PromoLinkClaimHandlerDependencies {
  adapter?: PromoLinkClaimAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function createPromoLinkClaimHandler(
  db: PrismaClient,
  dependencies: PromoLinkClaimHandlerDependencies = {},
): TaskHandler {
  const adapter = dependencies.adapter ?? createPromoLinkClaimAdapter();
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  return async ({ lease, mode, signal }) => {
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

    // Idempotent short-circuit: nothing left to do.
    if (scope.existingPromoLink?.status === "fetched") {
      return { status: "skipped", result: { decision: "already_fetched", promoLinkId: scope.existingPromoLink.id } };
    }

    const existingRead = readExistingPromoFromRawPayload(scope.source.rawPayload);
    // Doc §4 item 14 "dry-run 走完真实判定": even in dry-run, every gate
    // above this line (feature flag, TTL, scope resolution, already-fetched
    // short-circuit, the §3.9 pre-read decision) runs for real. Only the
    // write-allow-gated branches below stop short — with zero adapter call
    // and zero `protectedWrite` either way.
    const writeAllowed = mode === "apply" && isPromoLinkClaimWriteAllowed(env);

    if (existingRead.kocCode) {
      if (!writeAllowed) {
        return { status: "skipped", result: { decision: "would_fetch_existing" } };
      }
      return {
        status: "success",
        result: { decision: "already_available", host: safeHostname(existingRead.webUrl ?? existingRead.appUrl) },
        protectedWrite: (tx) => writePromoLinkAlreadyAvailable(tx, scope, existingRead, payload, now()).then(() => undefined),
      };
    }

    // `existingRead.kocCode` was falsy above — but that can mean two very
    // different things: upstream genuinely has nothing yet, or sync's
    // redaction boundary masked whatever was there before this handler ever
    // saw it. `redacted` tells them apart; see `writePromoLinkExistingEvidenceRedacted`
    // for why this must short-circuit here rather than silently falling
    // through to the capability check below (which would misreport this as
    // "no promo + capability disabled", losing the redaction fact).
    if (existingRead.redacted) {
      if (!writeAllowed) {
        return { status: "skipped", result: { decision: "would_skip_evidence_redacted" } };
      }
      return {
        status: "success",
        result: { decision: "existing_evidence_redacted" },
        protectedWrite: (tx) => writePromoLinkExistingEvidenceRedacted(tx, scope, payload, now()).then(() => undefined),
      };
    }

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

    // Dead in production (capabilityEnabled is always false) — real and
    // fixture-tested, see this file's header.
    return claimViaAdapter(db, adapter, scope, payload, lease, now(), signal);
  };
}

export function createPromoLinkClaimWorkerHandlers(
  db: PrismaClient,
  dependencies: PromoLinkClaimHandlerDependencies = {},
) {
  return createHandlerRegistry({
    [PROMO_LINK_CLAIM_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 3,
      handler: createPromoLinkClaimHandler(db, dependencies),
    },
  });
}
