import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as webIngressCrypto from "@/lib/credentials/web-ingress-crypto";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { decryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";

function keyFiles(activeVersion = 1): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-credential-keys-"));
  const v1 = path.join(directory, "v1");
  const v2 = path.join(directory, "v2");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(v2, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return { env: {
    NODE_ENV: "test",
    CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: String(activeVersion),
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE: v2,
    CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
  }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("P1-08B synchronous Web Credential ingress", () => {
  it("produces a Worker-compatible envelope without exporting decrypt", () => {
    const keys = keyFiles(2);
    const channelAccountId = randomUUID();
    const credentialId = randomUUID();
    const secret = "header.payload.signature";
    try {
      const encrypted = webIngressCrypto.encryptNewCredentialSecret({
        secret,
        channelAccountId,
        credentialId,
        env: keys.env,
      });

      expect(encrypted.keyVersion).toBe(2);
      expect(Buffer.from(encrypted.encryptedSecret).toString("utf8")).not.toContain(secret);
      expect(decryptCredentialSecretForWorker(
        encrypted.encryptedSecret,
        channelAccountId,
        credentialId,
        encrypted.keyVersion,
        keys.env,
      )).toBe(secret);
      expect(webIngressCrypto).not.toHaveProperty("decryptCredentialSecret");
    } finally {
      keys.cleanup();
    }
  });

  it("uses a stable HMAC fingerprint while exposing only its prefix", () => {
    const keys = keyFiles();
    try {
      const first = webIngressCrypto.fingerprintNewCredentialSecret("jwt", keys.env);
      const second = webIngressCrypto.fingerprintNewCredentialSecret("jwt", {
        ...keys.env,
        CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "2",
      });
      expect(second).toEqual(first);
      expect(first.full).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/);
      expect(first.prefix).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      keys.cleanup();
    }
  });

  it("registers add/replace only as a guarded action", () => {
    expect(resolveAdminRoute(
      "/api/admin/credentials/replace",
      "POST",
      P1_08B_ADMIN_REGISTRY,
    )).toBeNull();
    expect(resolveAdminAction(
      "admin.credential.replace",
      P1_08B_ADMIN_REGISTRY,
    )).toMatchObject({ capability: "credential:manage", mutation: true });
  });
});
