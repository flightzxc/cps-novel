import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_EXPIRY_WARNING_WINDOW_MS,
  resolveClaimCredentialAdmission,
} from "@/lib/credentials/claim-readiness";

/**
 * These exercise the admission RULES directly. The action-level suite
 * (`tests/ui/promo-link-claim-actions.test.ts`) mocks this resolver and only
 * proves the caller reacts to each outcome — so before this file existed,
 * disabling the `lastValidatedAt === null` branch outright changed no test
 * result. That branch is the one that would have stopped the 2026-09-14
 * batch: 79,217 items were queued against a credential that had never
 * completed validation, and every one of them failed.
 */
const NOW = new Date("2026-09-16T00:00:00.000Z");
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function dbWith(rows: ReadonlyArray<{ id: string; expiresAt: Date | null; lastValidatedAt: Date | null }>) {
  return {
    channelAccountCredential: {
      findMany: async (args: { where: { channelAccountId: string; status: string } }) => {
        // Guard the query shape itself: the encrypted secret must never be
        // selected on this path (the Web tier may not read key material).
        expect(args.where.status).toBe("active");
        expect(args.where.channelAccountId).toBe(ACCOUNT);
        return rows;
      },
    },
  } as unknown as Parameters<typeof resolveClaimCredentialAdmission>[0];
}

const row = (over: Partial<{ id: string; expiresAt: Date | null; lastValidatedAt: Date | null }> = {}) => ({
  id: "cred-1",
  expiresAt: new Date(NOW.valueOf() + CREDENTIAL_EXPIRY_WARNING_WINDOW_MS * 10),
  lastValidatedAt: new Date(NOW.valueOf() - 86_400_000),
  ...over,
});

describe("resolveClaimCredentialAdmission", () => {
  it("refuses a credential that has never completed validation (the 2026-09-14 failure mode)", async () => {
    const result = await resolveClaimCredentialAdmission(dbWith([row({ lastValidatedAt: null })]), ACCOUNT, NOW);
    expect(result).toMatchObject({ status: "not_ready", code: "credential_never_validated" });
  });

  it("refuses when the account has no active credential at all", async () => {
    const result = await resolveClaimCredentialAdmission(dbWith([]), ACCOUNT, NOW);
    expect(result.status).toBe("not_ready");
  });

  it("refuses an already-expired credential", async () => {
    const expired = row({ expiresAt: new Date(NOW.valueOf() - 1) });
    const result = await resolveClaimCredentialAdmission(dbWith([expired]), ACCOUNT, NOW);
    expect(result.status).toBe("not_ready");
  });

  it("admits a healthy credential without an expiry warning", async () => {
    const result = await resolveClaimCredentialAdmission(dbWith([row()]), ACCOUNT, NOW);
    expect(result).toMatchObject({ status: "admitted", credentialId: "cred-1", expiringSoon: false });
  });

  it("admits but flags a credential expiring inside the warning window", async () => {
    const soon = row({ expiresAt: new Date(NOW.valueOf() + Math.floor(CREDENTIAL_EXPIRY_WARNING_WINDOW_MS / 2)) });
    const result = await resolveClaimCredentialAdmission(dbWith([soon]), ACCOUNT, NOW);
    expect(result).toMatchObject({ status: "admitted", expiringSoon: true });
  });

  it("treats a null expiry as non-expiring rather than as expiring soon", async () => {
    const result = await resolveClaimCredentialAdmission(dbWith([row({ expiresAt: null })]), ACCOUNT, NOW);
    expect(result).toMatchObject({ status: "admitted", expiresAt: null, expiringSoon: false });
  });
});
