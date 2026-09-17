/**
 * Worker-only deep decrypt-and-validate step of the promo-link claim
 * credential check.
 *
 * `tests/backend/auth/credential-contracts.test.ts` forbids persisted-secret
 * decryption anywhere in Web (and all key access in Scheduler), scanning
 * bundled module text with transitive imports counted — so this function
 * cannot live under `src/server` or `src/lib/credentials`, only under
 * `worker/`, the one tier that test permits to hold `decryptCredentialSecretForWorker`.
 *
 * Builds on `classifyCredentialRowsForClaim`
 * (`src/lib/credentials/claim-readiness.ts`) for the non-secret "pick the
 * one usable row, or classify why there isn't one" step — the exact same
 * policy the Web-tier pre-flight gate
 * (`resolveClaimCredentialAdmission`, same module) uses — then actually
 * decrypts the chosen row's secret and validates the resulting JWT locally.
 * Deliberately a separate file rather than folding this back into that
 * Web-safe module: doing so would make importing the shared row-selection
 * logic also import the decrypt path, exactly the violation this split
 * exists to avoid. This file may import from `src/lib/credentials/
 * claim-readiness.ts`; that module must never import anything from here or
 * from anywhere else under `worker/`.
 *
 * Unlike the Web-tier admission check, this function never refuses on
 * `lastValidatedAt IS NULL` — a credential that decrypts to a
 * currently-valid JWT right now is usable right now, full stop, regardless
 * of whether the separate async validation task
 * (`worker/handlers/credential.ts`) has ever run against it. That refusal
 * is a Web-only pre-flight policy call (see this function's sibling
 * module's header for why), not a fact about whether a claim attempt can
 * succeed.
 */
import type { PrismaClient } from "@prisma/client";
import { decryptCredentialSecretForWorker } from "./crypto";
import { validateCredentialJwtLocally } from "../../src/lib/credentials/jwt";
import {
  classifyCredentialRowsForClaim,
  CREDENTIAL_EXPIRY_WARNING_WINDOW_MS,
  type ClaimCredentialNotReadyCode,
} from "../../src/lib/credentials/claim-readiness";

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

type CredentialReadinessDb = Pick<PrismaClient, "channelAccountCredential">;

function notReady(code: ClaimCredentialNotReadyCode, message: string): ClaimCredentialReadiness {
  return { status: "not_ready", code, message };
}

/**
 * Resolves the single credential a promo-link claim would use for
 * `accountId` right now, and actually attempts to decrypt and locally
 * validate it — never a weaker stand-in like "a row with status=active
 * exists". Row selection (0/1/many active, non-expired rows) is the exact
 * same policy the Web-tier pre-flight gate uses; only the tiers' final
 * gate differs (this one decrypts, the Web one checks `lastValidatedAt`).
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
  const selection = classifyCredentialRowsForClaim(credentials, now);
  if (selection.status === "not_ready") return selection;
  const credential = selection.row;
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
    expiringSoon: local.expiresAt.valueOf() - now.valueOf() < CREDENTIAL_EXPIRY_WARNING_WINDOW_MS,
  };
}
