import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  getCredentialTaskResult,
  projectPersistedCredentialTaskFailure,
} from "@/server/credentials";

const FAILURE_CODES = [
  "account_inactive",
  "credential_missing",
  "credential_ambiguous",
  "credential_validation_failed",
] as const;

function databaseReturning(task: unknown): PrismaClient {
  return {
    genericTask: { findUnique: vi.fn().mockResolvedValue(task) },
  } as unknown as PrismaClient;
}

describe("Credential task result read path", () => {
  it.each(FAILURE_CODES)("selects and exposes only the stable %s failure code", async (code) => {
    const db = databaseReturning({
      taskType: "credential.validate.v1",
      status: "failed",
      items: [{
        result: null,
        error: {
          code,
          message: "server-authored text",
          stack: "private stack",
          cause: { database: "private" },
          secret: "private-secret",
          ciphertext: "private-ciphertext",
          fingerprint: "f".repeat(64),
        },
      }],
    });

    const read = await getCredentialTaskResult(db, "task-1");
    expect(read).toEqual({ state: "failed", result: null, error: { code } });
    expect(JSON.stringify(read)).not.toMatch(/message|stack|cause|database|secret|ciphertext|f{64}/i);

    expect(db.genericTask.findUnique).toHaveBeenCalledWith({
      where: { id: "task-1" },
      select: {
        taskType: true,
        status: true,
        items: { take: 1, select: { result: true, error: true } },
      },
    });
  });

  it("keeps the successful result path unchanged and returns no failure", async () => {
    const result = {
      code: null,
      credentialId: "credential-1",
      status: "active",
      expiresAt: "2026-08-05T00:00:00.000Z",
      lastValidatedAt: "2026-08-04T00:00:00.000Z",
      fingerprintPrefix: "ab12",
    };
    const read = await getCredentialTaskResult(databaseReturning({
      taskType: "credential.validate.v1",
      status: "completed",
      items: [{ result, error: null }],
    }), "task-1");

    expect(read).toEqual({ state: "completed", result, error: null });
  });

  it("collapses missing, malformed, and unknown codes instead of passing strings through", () => {
    for (const value of [
      null,
      "credential_missing",
      {},
      { code: 123 },
      { code: "handler_failed", message: "arbitrary" },
      { code: "credential_missing<script>" },
    ]) {
      expect(projectPersistedCredentialTaskFailure(value)).toBeNull();
    }
  });
});
