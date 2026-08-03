import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "v1";

export class TotpSecretCryptoError extends Error {
  constructor(message = "Invalid TOTP secret encryption material") {
    super(message);
    this.name = "TotpSecretCryptoError";
  }
}

export function parseTotpEncryptionKey(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new TotpSecretCryptoError("TOTP_ENCRYPTION_KEY must be canonical 32-byte base64");
  }
  const key = Buffer.from(normalized, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== normalized) {
    throw new TotpSecretCryptoError("TOTP_ENCRYPTION_KEY must be canonical 32-byte base64");
  }
  return key;
}

function resolveKey(value?: string): Buffer {
  const key = value ?? process.env.TOTP_ENCRYPTION_KEY;
  if (!key) throw new TotpSecretCryptoError("TOTP_ENCRYPTION_KEY is required");
  return parseTotpEncryptionKey(key);
}

export function encryptTotpSecret(secret: string, base64Key?: string): string {
  if (!secret) throw new TotpSecretCryptoError("TOTP secret must not be empty");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", resolveKey(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptTotpSecret(payload: string, base64Key?: string): string {
  const [version, ivText, tagText, ciphertextText, extra] = payload.split(":");
  if (version !== PREFIX || !ivText || !tagText || !ciphertextText || extra !== undefined) {
    throw new TotpSecretCryptoError();
  }
  try {
    const iv = Buffer.from(ivText, "base64");
    const tag = Buffer.from(tagText, "base64");
    const ciphertext = Buffer.from(ciphertextText, "base64");
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) {
      throw new TotpSecretCryptoError();
    }
    const decipher = createDecipheriv("aes-256-gcm", resolveKey(base64Key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof TotpSecretCryptoError) throw error;
    throw new TotpSecretCryptoError();
  }
}
