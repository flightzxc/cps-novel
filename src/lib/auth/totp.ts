import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_ISSUER = "cps-novel";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Buffer {
  const normalized = input.trim().toUpperCase().replace(/=+$/, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("Invalid base32 TOTP secret");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function generateTotpCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotpCode(
  secret: string,
  code: string,
  options: { timestamp?: number; window?: number } = {},
): boolean {
  const candidate = code.trim();
  if (!/^\d{6}$/.test(candidate)) return false;
  const timestamp = options.timestamp ?? Date.now();
  const window = options.window ?? TOTP_WINDOW;
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = generateTotpCode(secret, timestamp + delta * TOTP_PERIOD_SECONDS * 1000);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
  }
  return false;
}

export function createTotpUri(username: string, secret: string, issuer = TOTP_ISSUER): string {
  const normalized = username.trim().toLowerCase();
  if (!normalized) throw new Error("Username is required for TOTP label");
  const label = `${normalized}@${issuer}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}
