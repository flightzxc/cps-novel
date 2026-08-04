import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;

export function hashAdminPassword(
  password: string,
  options: { cost?: number; blockSize?: number; parallelization?: number } = {},
): string {
  if (password.length < 12) throw new Error("Admin password must contain at least 12 characters");
  const cost = options.cost ?? DEFAULT_COST;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const parallelization = options.parallelization ?? DEFAULT_PARALLELIZATION;
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, {
    N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", "v1", cost, blockSize, parallelization, salt.toString("base64"), derived.toString("base64")].join("$");
}

export function verifyAdminPassword(password: string, storedHash: string): boolean {
  const [algorithm, version, costText, blockText, parallelText, saltText, hashText, extra] = storedHash.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || extra !== undefined) return false;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  if (![cost, blockSize, parallelization].every(Number.isSafeInteger)) return false;
  try {
    const expected = Buffer.from(hashText, "base64");
    const actual = scryptSync(password, Buffer.from(saltText, "base64"), expected.length, {
      N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024,
    });
    return expected.length > 0 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
