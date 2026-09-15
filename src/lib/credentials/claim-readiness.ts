/**
 * Shared "can this credential actually be used right now" assessment for
 * the promo-link claim chain.
 *
 * Factored out of `worker/handlers/promo-link-claim.ts`'s (formerly private)
 * `resolveClaimCredential` so the *exact* check the worker performs at claim
 * time can also run before a batch is admitted at all
 * (`src/app/(admin)/catalog-sync/_actions.ts`'s `enqueuePromoLinkClaimAction`
 * — see its module comment for the 2026-09-14 incident this exists to
 * prevent: a 79,217-item batch was enqueued against a credential that had
 * never once validated successfully, and burned ~44k items to
 * `credential_validation_failed` in about 18 minutes before anyone noticed).
 *
 * This module never reimplements decryption or JWT parsing — both still
 * come from their single existing source
 * (`decryptCredentialSecretForWorker`, `validateCredentialJwtLocally`). It
 * only adds the "pick the one usable row, classify why there isn't one"
 * policy, so that policy has exactly one implementation shared by both the
 * pre-flight gate and the worker's own claim-time resolution — not two
 * copies that could quietly drift apart.
 */
import type { PrismaClient } from "@prisma/client";
import { decryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { validateCredentialJwtLocally } from "./jwt";
import { PROMO_LINK_CLAIM_LIMITS } from "../tasks/promo-link-claim-limits";

export type ClaimCredentialNotReadyCode =
  | "credential_missing"
  | "credential_expired"
  | "credential_ambiguous"
  | "credential_validation_failed"
  | "credential_invalid";

/**
 * The subset of failure codes this module ever returns that are *systemic*
 * for a given `(channelAccountId)` rather than facts about any one claim
 * attempt: every one of them is derived purely from `accountId` (which
 * credential rows exist, whether the one usable row decrypts/validates),
 * never from anything about the particular novel/source item being claimed.
 * A task's items all share one `channelAccountId`
 * (`src/lib/tasks/promo-link-claim.ts`), so any of these codes is either
 * true for literally every item in the task or none of them — never "a few
 * scattered bad rows". This is what makes them safe to drive a batch-level
 * circuit breaker (`worker/handlers/promo-link-claim-circuit-breaker.ts`):
 * a transient/per-row failure class must never be able to trip it, and
 * these codes structurally cannot be a per-row phenomenon.
 */
export const DETERMINISTIC_CREDENTIAL_FAILURE_CODES: ReadonlySet<string> = new Set<ClaimCredentialNotReadyCode>([
  "credential_missing",
  "credential_expired",
  "credential_ambiguous",
  "credential_validation_failed",
  "credential_invalid",
]);

export type ClaimCredentialReadiness =
  | {
      readonly status: "ready";
      readonly credentialId: string;
      /** Plaintext JWT. Never log, persist, or return this to a client — same handling rule as every other decrypted secret in this codebase. */
      readonly secret: string;
      readonly expiresAt: Date | null;
      readonly expiringSoon: boolean;
    }
  | {
      readonly status: "not_ready";
      readonly code: ClaimCredentialNotReadyCode;
      readonly message: string;
    };

/**
 * A claim batch's own child items inherit the *batch's* `expiresAt`
 * (`PROMO_LINK_CLAIM_LIMITS.ttlMs` measured from submission — see
 * `worker/handlers/catalog-batch.ts`'s `promo_claim` payload construction
 * and `src/lib/tasks/promo-link-claim.ts`'s own task TTL), so an item near
 * the tail of a large batch can still be legitimately picked up and
 * executed right up to that full window after admission. A credential that
 * would expire *before* the batch's own items do could pass this gate clean
 * and still strand the tail of the run on a fresh `credential_expired`
 * — a second, avoidable incident of the same shape this gate exists to
 * catch. "Near expiry" is therefore defined relative to that same
 * operational window, not an arbitrary clock value: a credential is
 * "expiring soon" when less of it remains than a full batch is allowed to
 * take.
 */
export const CREDENTIAL_EXPIRY_WARNING_WINDOW_MS = PROMO_LINK_CLAIM_LIMITS.ttlMs;

type CredentialReadinessDb = Pick<PrismaClient, "channelAccountCredential">;

function notReady(code: ClaimCredentialNotReadyCode, message: string): ClaimCredentialReadiness {
  return { status: "not_ready", code, message };
}

/**
 * Resolves the single credential a promo-link claim would use for
 * `accountId` right now, and actually attempts to decrypt and locally
 * validate it — never a weaker stand-in like "a row with status=active
 * exists". Identical selection algorithm to (and now the single source
 * for) the worker's claim-time resolution: exactly one non-expired
 * `active` credential must exist for the account, and it must decrypt to a
 * structurally valid, not-yet-expired JWT.
 */
export async function resolveClaimCredentialReadiness(
  db: CredentialReadinessDb,
  accountId: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaimCredentialReadiness> {
  const credentials = await db.channelAccountCredential.findMany({
    where: { channelAccountId: accountId, status: "active" },
    select: { id: true, encryptedSecret: true, keyVersion: true, expiresAt: true },
  });
  const nowMs = now.valueOf();
  const nonExpired = credentials.filter((row) => row.expiresAt === null || row.expiresAt.valueOf() > nowMs);
  if (nonExpired.length === 0) {
    return notReady(
      credentials.length === 0 ? "credential_missing" : "credential_expired",
      "No usable active credential for this account",
    );
  }
  if (nonExpired.length > 1) {
    return notReady("credential_ambiguous", "Multiple active credentials exist for this account");
  }
  const credential = nonExpired[0]!;
  let secret: string;
  try {
    secret = decryptCredentialSecretForWorker(credential.encryptedSecret, accountId, credential.id, credential.keyVersion, env);
  } catch {
    // The only failure mode `decryptCredentialSecretForWorker` raises
    // (`worker/credentials/crypto.ts`): malformed envelope, wrong key
    // version, or a tampered/undecryptable ciphertext — this is the exact
    // condition the 2026-09-14 incident hit. Never rethrown: every branch
    // of this function reports through the same typed `not_ready` shape so
    // neither caller has to separately handle "the check failed" versus
    // "the check threw".
    return notReady("credential_validation_failed", "Stored credential could not be decrypted");
  }
  const local = validateCredentialJwtLocally(secret, now);
  if (local.status !== "active") {
    return notReady(
      local.status === "expired" ? "credential_expired" : "credential_invalid",
      "Credential failed local validation",
    );
  }
  return {
    status: "ready",
    credentialId: credential.id,
    secret,
    expiresAt: local.expiresAt,
    expiringSoon: local.expiresAt.valueOf() - nowMs < CREDENTIAL_EXPIRY_WARNING_WINDOW_MS,
  };
}
