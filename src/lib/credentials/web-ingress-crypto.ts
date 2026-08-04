import { createCipheriv, createHmac, randomBytes } from "node:crypto";

const CREDENTIAL_ENCRYPTION_KEY_VERSION = 1;

function canonicalKey(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = env[name]?.trim() ?? "";
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical 32-byte base64`);
  }
  return decoded;
}

function credentialAad(channelAccountId: string, credentialId: string): Buffer {
  return Buffer.from(
    `cps-novel:credential:v1\0${channelAccountId}\0${credentialId}`,
    "utf8",
  );
}

/**
 * Web ingress may encrypt only the new request-scoped secret. This module has
 * intentionally no decrypt export and must never be used to read persisted
 * Credential ciphertext.
 */
export function encryptNewCredentialSecret(input: {
  secret: string;
  channelAccountId: string;
  credentialId: string;
  env?: NodeJS.ProcessEnv;
}): { encryptedSecret: Buffer; keyVersion: number } {
  const secret = input.secret.trim();
  if (!secret) throw new Error("Credential secret is empty");
  const env = input.env ?? process.env;
  const iv = randomBytes(12);
  const keyVersion = CREDENTIAL_ENCRYPTION_KEY_VERSION;
  const cipher = createCipheriv(
    "aes-256-gcm",
    canonicalKey(env, `CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V${keyVersion}`),
    iv,
  );
  cipher.setAAD(credentialAad(input.channelAccountId, input.credentialId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const envelope = [
    "v1",
    keyVersion,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
  return { encryptedSecret: Buffer.from(envelope, "utf8"), keyVersion };
}

export function fingerprintNewCredentialSecret(
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): { full: string; prefix: string } {
  const digest = createHmac(
    "sha256",
    canonicalKey(env, "CHANNEL_CREDENTIAL_FINGERPRINT_KEY"),
  )
    .update("cps-novel:credential-fingerprint:v1\0")
    .update(secret.trim())
    .digest("hex");
  return { full: `hmac-sha256:v1:${digest}`, prefix: digest.slice(0, 12) };
}
