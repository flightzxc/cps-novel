import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  projectAdminSession,
  projectCredentialMetadata,
  projectCredentialTaskStatus,
  projectErrorEnvelope,
  projectTwoFactorChallenge,
  projectTwoFactorState,
} from "@/contracts";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const CONTRACTS_DIR = path.resolve(process.cwd(), "src/contracts");

/** Every field that must never reach a browser payload. */
const FORBIDDEN = [
  "tokenHash",
  "sessionVersion",
  "passwordHash",
  "encryptedSecret",
  "secretFingerprint",
  "codeHash",
  "keyVersion",
  "revokedAt",
  "deletedAt",
  "stack",
];

function assertClean(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const field of FORBIDDEN) {
    expect(serialized).not.toMatch(new RegExp(field, "i"));
  }
  return serialized;
}

async function contractSources(): Promise<Array<{ file: string; source: string }>> {
  const entries = await readdir(CONTRACTS_DIR, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  return Promise.all(
    files.map(async (entry) => ({
      file: entry.name,
      source: await readFile(path.join(CONTRACTS_DIR, entry.name), "utf8"),
    })),
  );
}

describe("frontend projections never serialize server-internal state", () => {
  it("drops session token, version and revocation state", () => {
    // Deliberately passes the full internal record, extra fields and all.
    const view = projectAdminSession({
      identity: {
        id: "identity-1",
        username: "operator",
        role: "super_admin",
        status: "active",
        sessionVersion: 42,
        twoFactorEnabled: true,
        passwordHash: "scrypt$v1$deadbeef",
      } as never,
      session: {
        id: "session-db-primary-key",
        tokenHash: "b".repeat(64),
        identityId: "identity-1",
        sessionVersion: 42,
        issuedAt: NOW,
        lastSeenAt: NOW,
        absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000),
        twoFactorCompletedAt: NOW,
        revokedAt: null,
      } as never,
      twoFactorCompleted: true,
      idleTimeoutMs: 7_200_000,
      capabilities: [{ capability: "credential:manage", state: "granted" }],
    });

    const serialized = assertClean(view);
    expect(serialized).not.toContain("session-db-primary-key");
    expect(serialized).not.toContain("b".repeat(64));
    expect(serialized).not.toContain("42");
  });

  it("drops TOTP ciphertext while still deriving the pending state from it", () => {
    const view = projectTwoFactorState({
      state: {
        identityId: "identity-1",
        enabled: false,
        encryptedSecret: "aes-gcm$v1$enabled-secret",
        keyVersion: 3,
        confirmedAt: null,
        pendingEncryptedSecret: "aes-gcm$v1$pending-secret",
        pendingKeyVersion: 3,
        pendingExpiresAt: new Date(NOW.getTime() + 60_000),
        recoveryCodesRotatedAt: null,
      } as never,
      recoveryCodesRemaining: 10,
      now: NOW,
    });

    expect(view.status).toBe("pending");
    const serialized = assertClean(view);
    expect(serialized).not.toContain("pending-secret");
    expect(serialized).not.toContain("enabled-secret");
  });

  it("drops the challenge handle and its session binding", () => {
    const view = projectTwoFactorChallenge({
      challenge: {
        id: "challenge-1",
        identityId: "identity-1",
        sessionId: "session-1",
        tokenHash: "c".repeat(64),
        expiresAt: new Date(NOW.getTime() + 300_000),
        consumedAt: null,
        attemptCount: 1,
        createdAt: NOW,
      } as never,
      maxAttempts: 5,
    });

    const serialized = assertClean(view);
    expect(Object.keys(view).sort()).toEqual(["attemptsRemaining", "expiresAt"]);
    expect(serialized).not.toContain("challenge-1");
    expect(serialized).not.toContain("session-1");
  });

  it("emits only the fingerprint prefix, never the full HMAC or ciphertext", () => {
    const view = projectCredentialMetadata({
      credentialId: "credential-1",
      channelAccountId: "account-1",
      credentialType: "bearer_jwt",
      status: "active",
      expiresAt: null,
      lastValidatedAt: null,
      fingerprintPrefix: "ab12",
      // Extra keys a caller might pass by mistake.
      secretFingerprint: `hmac-sha256:${"f".repeat(64)}`,
      encryptedSecret: "ciphertext",
      keyVersion: 1,
    } as never);

    const serialized = assertClean(view);
    expect(view.fingerprintPrefix).toBe("ab12");
    expect(serialized).not.toContain("f".repeat(64));
    expect(serialized).not.toContain("hmac-sha256");
  });

  it("strips message, stack and upstream payload from a task outcome", () => {
    const view = projectCredentialTaskStatus({
      taskId: "task-1",
      status: "failed",
      result: {
        code: "credential_validation_failed",
        credentialId: "credential-1",
        status: "invalid",
        expiresAt: null,
        lastValidatedAt: null,
        fingerprintPrefix: "ab12",
        // Fields a future Worker revision might add.
        secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        rawUpstreamResponse: { body: "upstream" },
        stack: "Error: boom\n    at handler",
      },
      error: {
        code: "credential_ambiguous",
        message: "Credential selection is ambiguous",
        stack: "Error: boom",
      },
    });

    const serialized = assertClean(view);
    expect(view.failureCode).toBe("credential_ambiguous");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("upstream");
    expect(serialized).not.toContain("ambiguous is");
    expect(serialized).not.toContain("Credential selection");
  });

  it("never carries a server-authored message in the error envelope", () => {
    const envelope = projectErrorEnvelope({
      code: "credential_capability_denied",
      status: 403,
      details: {
        capability: "credential:manage",
        message: "Missing admin capability: credential:manage",
        stack: "Error: denied",
      },
    });

    expect(envelope).not.toHaveProperty("message");
    const serialized = assertClean(envelope);
    expect(serialized).not.toContain("Missing admin capability");
  });
});

describe("contract module stays browser-safe", () => {
  it("imports no Node built-ins", async () => {
    for (const { file, source } of await contractSources()) {
      expect(source, `${file} must not import a Node built-in`).not.toMatch(
        /from\s+"node:[a-z/]+"/,
      );
    }
  });

  it("uses type-only imports for every server module", async () => {
    // `@/domain/database-statuses` is the one vetted value import: it is a leaf
    // with no imports of its own, so it cannot drag server code into a bundle.
    const VETTED_VALUE_IMPORT = "@/domain/database-statuses";
    const leaf = await readFile(
      path.resolve(process.cwd(), "src/domain/database-statuses.ts"),
      "utf8",
    );
    expect(leaf).not.toMatch(/^\s*import\s/m);

    for (const { file, source } of await contractSources()) {
      const valueImports = source
        .split("\n")
        .filter((line) => /^import\s/.test(line) && !/^import\s+type\s/.test(line))
        .filter((line) => /from\s+"@\//.test(line))
        .filter((line) => !line.includes(VETTED_VALUE_IMPORT));

      expect(valueImports, `${file} must not value-import a server module`).toEqual([]);
    }
  });
});
