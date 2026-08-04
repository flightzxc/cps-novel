import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_EXECUTION_STATUS,
  CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED,
  type CredentialContractCode,
  type CredentialMetadata,
  type CredentialQueuedResult,
} from "@/lib/credentials/contracts";

describe("credential web boundary", () => {
  it("defines all redacted task result codes while production secret intake remains gated", () => {
    const codes: CredentialContractCode[] = [
      "credential_validation_queued",
      "credential_missing",
      "credential_expired",
      "credential_fingerprint_conflict",
      "credential_validation_failed",
      "credential_capability_denied",
      "credential_ambiguous",
      "account_inactive",
    ];
    expect(new Set(codes).size).toBe(8);
    expect(CREDENTIAL_EXECUTION_STATUS).toBe("PARTIAL_SECRET_INGRESS_GATED");
    expect(CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED).toBe(false);
  });

  it("freezes redacted metadata and queued results without secret material", () => {
    const metadata: CredentialMetadata = {
      credentialId: "credential-1",
      channelAccountId: "account-1",
      credentialType: "bearer_jwt",
      fingerprintPrefix: "abcd",
      status: "invalid",
      expiresAt: null,
      lastValidatedAt: "2026-08-04T00:00:00.000Z",
    };
    const queued: CredentialQueuedResult = {
      code: "credential_validation_queued",
      state: "queued",
      taskId: "task-1",
      credentialId: metadata.credentialId,
      channelAccountId: metadata.channelAccountId,
      enqueuedAt: "2026-08-04T00:00:01.000Z",
      mutationRequestId: "550e8400-e29b-41d4-a716-446655440000",
    };

    expect(metadata).toHaveProperty("lastValidatedAt");
    expect(metadata.status).toBe("invalid");
    expect(Object.keys(queued).sort()).toEqual([
      "channelAccountId",
      "code",
      "credentialId",
      "enqueuedAt",
      "mutationRequestId",
      "state",
      "taskId",
    ]);
    expect(JSON.stringify(queued)).not.toMatch(/secret|ciphertext|fingerprint/i);
  });

  it("keeps Credential decryption and symmetric key access out of the Web boundary", async () => {
    async function typescriptSources(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) return typescriptSources(target);
          return entry.isFile() && entry.name.endsWith(".ts") ? [await readFile(target, "utf8")] : [];
        }),
      );
      return nested.flat();
    }

    const source = (
      await Promise.all(
        ["src/lib/credentials", "src/server", "scheduler"].map((directory) =>
          typescriptSources(path.resolve(process.cwd(), directory)),
        ),
      )
    )
      .flat()
      .join("\n");
    expect(source).not.toMatch(/encrypted[_A-Z]?secret/i);
    expect(source).not.toMatch(/decrypt|createDecipheriv|CHANNEL_CREDENTIAL_ENCRYPTION_KEY/);
    expect(source).not.toMatch(/CREDENTIAL_ENCRYPTION_KEYS|CREDENTIAL_FINGERPRINT_HMAC_KEY/);

    const workerCrypto = await readFile(
      path.resolve(process.cwd(), "worker/credentials/crypto.ts"),
      "utf8",
    );
    expect(workerCrypto).toMatch(/createDecipheriv/);
    expect(workerCrypto).toMatch(/CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V/);
    expect(workerCrypto).toMatch(/CHANNEL_CREDENTIAL_FINGERPRINT_KEY/);
  });
});
