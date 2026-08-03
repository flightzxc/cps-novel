import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const DEFAULT_RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_RE = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isRecoveryCodeFormat(code: string): boolean {
  return RECOVERY_CODE_RE.test(normalizeRecoveryCode(code));
}

export function generateRecoveryCodes(count = DEFAULT_RECOVERY_CODE_COUNT): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw new Error("Recovery code count must be between 1 and 50");
  }
  const codes = new Set<string>();
  while (codes.size < count) {
    const value = randomBytes(6).toString("hex").toUpperCase();
    codes.add(`${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`);
  }
  return [...codes];
}

export function hashRecoveryCode(
  code: string,
  options: { cost?: number; blockSize?: number; parallelization?: number } = {},
): string {
  const normalized = normalizeRecoveryCode(code);
  if (!isRecoveryCodeFormat(normalized)) throw new Error("Invalid recovery code format");
  const cost = options.cost ?? 16384;
  const blockSize = options.blockSize ?? 8;
  const parallelization = options.parallelization ?? 1;
  const salt = randomBytes(16);
  const derived = scryptSync(normalized, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", "v1", cost, blockSize, parallelization, salt.toString("base64"), derived.toString("base64")].join("$");
}

export function verifyRecoveryCode(code: string, storedHash: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (!isRecoveryCodeFormat(normalized)) return false;
  const [algorithm, version, costText, blockText, parallelText, saltText, hashText, extra] = storedHash.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || extra !== undefined) return false;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  if (![cost, blockSize, parallelization].every(Number.isSafeInteger)) return false;
  try {
    const expected = Buffer.from(hashText, "base64");
    const actual = scryptSync(normalized, Buffer.from(saltText, "base64"), expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length > 0 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function maskRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return normalized.length >= 4 ? `${normalized.slice(0, 4)}-****-${normalized.slice(-4)}` : "****";
}
