import { describe, expect, it } from "vitest";

import type { CredentialMetadata } from "@/lib/credentials/contracts";
import {
  CredentialLifecycleError,
  planChannelAccountStatusChange,
  planCredentialReplacement,
  resolveSingleActiveCredential,
  supersedeCredentialStatus,
  validateCredentialStatus,
} from "@/lib/credentials/lifecycle";

function metadata(id: string, status: CredentialMetadata["status"]): CredentialMetadata {
  return {
    credentialId: id,
    channelAccountId: "account-1",
    credentialType: "bearer_jwt",
    fingerprintPrefix: id.slice(0, 4),
    status,
    expiresAt: null,
    lastValidatedAt: null,
  };
}

describe("credential lifecycle contract", () => {
  it("replaces every old active row with superseded and permits three inserted outcomes", () => {
    for (const insertedStatus of ["active", "expired", "invalid"] as const) {
      expect(
        planCredentialReplacement(
          ["active", "expired", "invalid", "superseded"],
          insertedStatus,
        ),
      ).toEqual({
        existingStatuses: ["superseded", "expired", "invalid", "superseded"],
        insertedStatus,
      });
    }
  });

  it("never reactivates superseded through validation", () => {
    expect(() => validateCredentialStatus("superseded", "active")).toThrowError(
      expect.objectContaining({ code: "credential_validation_failed" }),
    );
    expect(validateCredentialStatus("active", "invalid")).toBe("invalid");
    expect(validateCredentialStatus("expired", "active")).toBe("active");
    expect(validateCredentialStatus("invalid", "expired")).toBe("expired");
  });

  it("supports explicit supersede only from active", () => {
    expect(supersedeCredentialStatus("active")).toBe("superseded");
    for (const status of ["superseded", "expired", "invalid"] as const) {
      expect(() => supersedeCredentialStatus(status)).toThrow(CredentialLifecycleError);
    }
  });

  it("changes account status without changing credential state", () => {
    const statuses = ["active", "expired", "invalid", "superseded"] as const;
    expect(
      planChannelAccountStatusChange({ nextStatus: "disabled", credentialStatuses: statuses }),
    ).toEqual({ accountStatus: "disabled", credentialStatuses: statuses });
    expect(
      planChannelAccountStatusChange({ nextStatus: "active", credentialStatuses: statuses }),
    ).toEqual({ accountStatus: "active", credentialStatuses: statuses });
  });

  it("uses account_inactive instead of credential_missing for a disabled account", () => {
    expect(() => resolveSingleActiveCredential("disabled", [])).toThrowError(
      expect.objectContaining({ code: "account_inactive" }),
    );
  });

  it("fails closed when defensive resolution sees multiple active rows", () => {
    expect(() =>
      resolveSingleActiveCredential("active", [metadata("cred-a", "active"), metadata("cred-b", "active")]),
    ).toThrowError(expect.objectContaining({ code: "credential_ambiguous" }));
    expect(resolveSingleActiveCredential("active", [metadata("cred-a", "active")])).toMatchObject({
      credentialId: "cred-a",
    });
  });
});
