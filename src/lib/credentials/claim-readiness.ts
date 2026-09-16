/**
 * Web-safe "can this credential even be admitted right now" predicate for
 * the promo-link claim chain, plus the row-selection policy it shares with
 * the worker's own deep check.
 *
 * This module selects only non-secret `ChannelAccountCredential` columns
 * (`id`, `status`, `expiresAt`, `lastValidatedAt`) and never selects, logs,
 * or imports anything that reaches `encryptedSecret` — so it is safe to
 * import from the Web tier
 * (`src/app/(admin)/catalog-sync/_actions.ts`'s pre-flight
 * `enqueuePromoLinkClaimAction` gate — see its module comment for the full
 * 2026-09-14 incident this exists to prevent) as well as from the worker.
 * `tests/backend/auth/credential-contracts.test.ts` enforces the Web-tier
 * half of that boundary by scanning every `.ts` file's raw source under
 * `src/server` and `src/lib/credentials` (this directory) for the literal
 * names of the symmetric-cipher primitive and the worker's own secret-
 * decryption helper — this file (and everything else in this directory)
 * must never spell out either name, call either one, or import a module
 * that does.
 *
 * `resolveClaimCredentialAdmission` below is deliberately *not* the same
 * check the worker performs at actual claim time: it never decrypts or
 * locally validates the JWT (that needs key access, which the Web tier must
 * never have), and it additionally refuses a credential that has never once
 * completed async validation (`lastValidatedAt IS NULL`) — a state the deep
 * decrypt/validate check has no way to see, because a row that decrypts
 * fine to a currently-valid JWT is, by the deep check's own definition,
 * "ready" regardless of whether the separate async validation task
 * (`worker/handlers/credential.ts`) has ever run against it. That gap is
 * exactly the 2026-09-14 incident's shape: a 79,217-item batch was admitted
 * against a credential whose `last_validated_at` was empty, and every one
 * of its ~44,000 attempted items failed inside decryption. This predicate
 * would have refused that batch outright, with zero key access.
 *
 * The row-selection step both checks share (which single row is even a
 * candidate, or why there isn't one) lives in
 * {@link classifyCredentialRowsForClaim} below — a pure function with no DB
 * or key access of its own — so that one piece of policy has exactly one
 * implementation. The worker's deep check
 * (`worker/credentials/claim-readiness.ts`) imports *that* function from
 * here and layers decrypt-and-validate on top of whatever row it selects;
 * this module never imports anything from `worker/`, so the two files
 * cannot be reached through each other in the wrong direction.
 */
import type { PrismaClient } from "@prisma/client";
import { PROMO_LINK_CLAIM_LIMITS } from "../tasks/promo-link-claim-limits";

export type ClaimCredentialNotReadyCode =
  | "credential_missing"
  | "credential_expired"
  | "credential_ambiguous"
  | "credential_never_validated"
  | "credential_validation_failed"
  | "credential_invalid";

/**
 * The subset of failure codes that are *systemic* for a given
 * `(channelAccountId)` rather than facts about any one claim attempt: every
 * one of them is derived purely from `accountId` (which credential rows
 * exist, whether the one usable row decrypts/validates), never from
 * anything about the particular novel/source item being claimed. A task's
 * items all share one `channelAccountId` (`src/lib/tasks/promo-link-claim.ts`),
 * so any of these codes is either true for literally every item in the task
 * or none of them — never "a few scattered bad rows". This is what makes
 * them safe to drive a batch-level circuit breaker
 * (`worker/handlers/promo-link-claim-circuit-breaker.ts`): a
 * transient/per-row failure class must never be able to trip it, and these
 * codes structurally cannot be a per-row phenomenon.
 *
 * `credential_never_validated` is deliberately excluded: it is a Web
 * pre-flight refusal only (see this module's header) and can never be a
 * code the worker's own deep check produces mid-batch — by the time a task
 * exists, that refusal already ran and either blocked admission or it
 * didn't. Including a code here that the breaker's caller
 * (`worker/credentials/claim-readiness.ts`) can never actually emit would
 * just be dead weight in the eligibility check.
 */
export const DETERMINISTIC_CREDENTIAL_FAILURE_CODES: ReadonlySet<string> = new Set<ClaimCredentialNotReadyCode>([
  "credential_missing",
  "credential_expired",
  "credential_ambiguous",
  "credential_validation_failed",
  "credential_invalid",
]);

export type ClaimCredentialAdmission =
  | {
      readonly status: "not_ready";
      readonly code: ClaimCredentialNotReadyCode;
      readonly message: string;
    }
  | {
      readonly status: "admitted";
      readonly credentialId: string;
      readonly expiresAt: Date | null;
      readonly expiringSoon: boolean;
    };

/**
 * A claim batch's own child items inherit the *batch's* `expiresAt`
 * (`PROMO_LINK_CLAIM_LIMITS.ttlMs` measured from submission — see
 * `worker/handlers/catalog-batch.ts`'s `promo_claim` payload construction
 * and `src/lib/tasks/promo-link-claim.ts`'s own task TTL), so an item near
 * the tail of a large batch can still be legitimately picked up and
 * executed right up to that full window after admission. A credential that
 * would expire *before* a batch this size could plausibly finish is not
 * refused outright — refusing a legitimate, currently-valid credential
 * would be its own foot-gun — but is flagged as a warning so the caller can
 * record *when* it expires rather than silently proceeding. "Near expiry"
 * is therefore defined relative to that same operational window, not an
 * arbitrary clock value: a credential is "expiring soon" when less of it
 * remains than a full batch is allowed to take.
 */
export const CREDENTIAL_EXPIRY_WARNING_WINDOW_MS = PROMO_LINK_CLAIM_LIMITS.ttlMs;

function notReady(code: ClaimCredentialNotReadyCode, message: string): { status: "not_ready"; code: ClaimCredentialNotReadyCode; message: string } {
  return { status: "not_ready", code, message };
}

interface CandidateCredentialRow {
  readonly id: string;
  readonly expiresAt: Date | null;
}

export type CredentialRowSelection<T extends CandidateCredentialRow> =
  | { readonly status: "not_ready"; readonly code: ClaimCredentialNotReadyCode; readonly message: string }
  | { readonly status: "selected"; readonly row: T };

/**
 * Given every `status: "active"` credential row for one account, decides
 * which single row a claim would use right now, or classifies why there
 * isn't one — zero DB access, zero key access, and generic over whatever
 * extra columns the caller selected (a caller that also selected
 * `encryptedSecret`/`keyVersion` for its own later use — the worker's deep
 * check — can pass those very same rows through here unmodified; this
 * function only ever reads `id`/`expiresAt`). Exported so both
 * {@link resolveClaimCredentialAdmission} below and the worker's deep
 * decrypt/validate step share exactly one implementation of this policy —
 * never two copies that could quietly drift apart.
 */
export function classifyCredentialRowsForClaim<T extends CandidateCredentialRow>(
  rows: readonly T[],
  now: Date,
): CredentialRowSelection<T> {
  const nowMs = now.valueOf();
  const nonExpired = rows.filter((row) => row.expiresAt === null || row.expiresAt.valueOf() > nowMs);
  if (nonExpired.length === 0) {
    return notReady(
      rows.length === 0 ? "credential_missing" : "credential_expired",
      "No usable active credential for this account",
    );
  }
  if (nonExpired.length > 1) {
    return notReady("credential_ambiguous", "Multiple active credentials exist for this account");
  }
  return { status: "selected", row: nonExpired[0]! };
}

type CredentialAdmissionDb = Pick<PrismaClient, "channelAccountCredential">;

/**
 * Resolves whether a promo-link claim batch may even be admitted against
 * `accountId` right now, reading only non-secret columns — never
 * `encryptedSecret`. The account itself (active, not soft-deleted) is
 * expected to already be validated by the caller before this runs
 * (`src/app/(admin)/catalog-sync/_actions.ts`'s
 * `validatePromoAccountConfiguration` checks the `ChannelAccount` binding
 * first); `ChannelAccountCredential` itself carries no soft-delete column
 * of its own.
 */
export async function resolveClaimCredentialAdmission(
  db: CredentialAdmissionDb,
  accountId: string,
  now: Date,
): Promise<ClaimCredentialAdmission> {
  const rows = await db.channelAccountCredential.findMany({
    where: { channelAccountId: accountId, status: "active" },
    select: { id: true, expiresAt: true, lastValidatedAt: true },
  });
  const selection = classifyCredentialRowsForClaim(rows, now);
  if (selection.status === "not_ready") return selection;
  const { row } = selection;
  if (row.lastValidatedAt === null) {
    return notReady(
      "credential_never_validated",
      "Stored credential has never completed validation",
    );
  }
  const expiringSoon = row.expiresAt !== null && row.expiresAt.valueOf() - now.valueOf() < CREDENTIAL_EXPIRY_WARNING_WINDOW_MS;
  return { status: "admitted", credentialId: row.id, expiresAt: row.expiresAt, expiringSoon };
}
