import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { loadCredentialKeyring } from "./keyring";

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
  const keyring = loadCredentialKeyring(env);
  const iv = randomBytes(12);
  const keyVersion = keyring.activeVersion;
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyring.encryptionKey(keyVersion),
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
  const keyring = loadCredentialKeyring(env);
  const digest = createHmac(
    "sha256",
    keyring.fingerprintKey,
  )
    .update("cps-novel:credential-fingerprint:v1\0")
    .update(secret.trim())
    .digest("hex");
  return { full: `hmac-sha256:v1:${digest}`, prefix: digest.slice(0, 12) };
}
