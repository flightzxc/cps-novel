import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { getCredentialTaskResult } from "@/server/credentials";

function databaseWith(error: unknown, result: unknown = null): PrismaClient {
  return {
    genericTask: {
      findUnique: async () => ({
        taskType: "credential.validate.v1",
        status: error ? "failed" : "completed",
        items: [{ error, result }],
      }),
    },
  } as unknown as PrismaClient;
}

describe("CredentialTaskStatusView backend handoff", () => {
  it.each([
    "account_inactive",
    "credential_missing",
    "credential_ambiguous",
    "credential_validation_failed",
  ] as const)("projects %s through the sanitized error.code seam", async (code) => {
    const read = await getCredentialTaskResult(databaseWith({
      code,
      message: "must not cross the contract boundary",
      stack: "private",
    }), "task-1");

    // Claude's contract projection consumes `error` and maps this code to
    // CredentialTaskStatusView.failureCode. The backend hands it no free text.
    const failureCode = read.error?.code ?? null;
    expect({ state: read.state, failureCode }).toEqual({ state: "failed", failureCode: code });
    expect(JSON.stringify(read)).not.toMatch(/message|stack|must not cross|private/i);
  });

  it("preserves success projection with failureCode=null", async () => {
    const result = {
      code: null,
      credentialId: "credential-1",
      status: "active",
      expiresAt: null,
      lastValidatedAt: "2026-08-04T00:00:00.000Z",
      fingerprintPrefix: "ab12",
    };
    const read = await getCredentialTaskResult(databaseWith(null, result), "task-1");
    expect({ result: read.result, failureCode: read.error?.code ?? null }).toEqual({
      result,
      failureCode: null,
    });
  });

  it("never projects an illegal persisted code", async () => {
    const read = await getCredentialTaskResult(databaseWith({
      code: "database_error:secret",
      message: "password=private",
      stack: "private stack",
      ciphertext: "private ciphertext",
      fingerprint: "f".repeat(64),
    }), "task-1");
    expect(read).toEqual({ state: "failed", result: null, error: null });
    expect(JSON.stringify(read)).not.toMatch(/database_error|password|stack|ciphertext|f{64}/i);
  });
});
