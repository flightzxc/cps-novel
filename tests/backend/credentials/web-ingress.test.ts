import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as webIngressCrypto from "@/lib/credentials/web-ingress-crypto";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { decryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";

function env(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1: randomBytes(32).toString("base64"),
    CHANNEL_CREDENTIAL_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  };
}

describe("P1-08B synchronous Web Credential ingress", () => {
  it("produces a Worker-compatible envelope without exporting decrypt", () => {
    const keys = env();
    const previousEncryptionKey = process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1;
    process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1 = keys.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1;
    const channelAccountId = randomUUID();
    const credentialId = randomUUID();
    const secret = "header.payload.signature";
    try {
      const encrypted = webIngressCrypto.encryptNewCredentialSecret({
        secret,
        channelAccountId,
        credentialId,
        env: keys,
      });

      expect(Buffer.from(encrypted.encryptedSecret).toString("utf8")).not.toContain(secret);
      expect(decryptCredentialSecretForWorker(
        encrypted.encryptedSecret,
        channelAccountId,
        credentialId,
        encrypted.keyVersion,
      )).toBe(secret);
      expect(webIngressCrypto).not.toHaveProperty("decryptCredentialSecret");
    } finally {
      if (previousEncryptionKey === undefined) {
        delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1;
      } else {
        process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1 = previousEncryptionKey;
      }
    }
  });

  it("uses a stable HMAC fingerprint while exposing only its prefix", () => {
    const keys = env();
    const first = webIngressCrypto.fingerprintNewCredentialSecret("jwt", keys);
    const second = webIngressCrypto.fingerprintNewCredentialSecret("jwt", keys);
    expect(second).toEqual(first);
    expect(first.full).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/);
    expect(first.prefix).toMatch(/^[0-9a-f]{12}$/);
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
