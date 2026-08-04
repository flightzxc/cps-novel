import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function key(name: string): Buffer {
  const value = process.env[name]?.trim() ?? "";
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.length !== 32 || decoded.toString("base64") !== value) throw new Error(`${name} must be canonical 32-byte base64`);
  return decoded;
}

function aad(accountId: string, credentialId: string): Buffer {
  return Buffer.from(`cps-novel:credential:v1\0${accountId}\0${credentialId}`, "utf8");
}

export function encryptCredentialSecretForWorker(secret: string, accountId: string, credentialId: string, version = 1): Buffer {
  if (!secret.trim()) throw new Error("Credential secret is empty");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(`CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V${version}`), iv);
  cipher.setAAD(aad(accountId, credentialId));
  const ciphertext = Buffer.concat([cipher.update(secret.trim(), "utf8"), cipher.final()]);
  return Buffer.from(["v1", version, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":"), "utf8");
}

export function decryptCredentialSecretForWorker(payload: Uint8Array, accountId: string, credentialId: string, expectedVersion: number): string {
  const [format, versionText, ivText, tagText, ciphertextText, extra] = Buffer.from(payload).toString("utf8").split(":");
  const version = Number(versionText);
  if (format !== "v1" || version !== expectedVersion || extra !== undefined) throw new Error("credential_validation_failed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(`CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V${version}`), Buffer.from(ivText, "base64"));
    decipher.setAAD(aad(accountId, credentialId));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credential_validation_failed");
  }
}

export function fingerprintCredentialSecretForWorker(secret: string): { full: string; prefix: string } {
  const digest = createHmac("sha256", key("CHANNEL_CREDENTIAL_FINGERPRINT_KEY"))
    .update("cps-novel:credential-fingerprint:v1\0").update(secret.trim()).digest("hex");
  return { full: `hmac-sha256:v1:${digest}`, prefix: digest.slice(0, 12) };
}
