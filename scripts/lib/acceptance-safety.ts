import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TMP_ROOTS = ["/tmp", "/private/tmp"] as const;
const SENSITIVE_FLAG_PARTS = [
  "jwt",
  "token",
  "secret",
  "password",
  "cookie",
  "credential",
  "authorization",
] as const;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "jwt",
  "token",
  "secret",
  "password",
  "database_url",
  "databaseurl",
]);

const URL_OR_JWT = /(postgres(?:ql)?:\/\/\S+|https?:\/\/\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/g;
const KEY_VALUE_SECRET = /\b(jwt|token|secret|password|cookie|authorization)=([^&\s]+)/gi;

function isWithinTmp(candidate: string): boolean {
  return TMP_ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

function existingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** Rejects both obvious non-/tmp paths and symlink escapes from /tmp. */
export function assertTmpOutputPath(rawPath: string): string {
  if (!path.isAbsolute(rawPath)) {
    throw new Error("output path must be absolute and under /tmp or /private/tmp");
  }
  const resolved = path.resolve(rawPath);
  if (!isWithinTmp(resolved)) {
    throw new Error("output path must stay under /tmp or /private/tmp");
  }
  const ancestor = existingAncestor(path.dirname(resolved));
  const canonicalAncestor = fs.realpathSync(ancestor);
  if (!isWithinTmp(canonicalAncestor)) {
    throw new Error("output path resolves outside /tmp or /private/tmp");
  }
  return resolved;
}

export function databaseUrlSha256(databaseUrl: string): string {
  return createHash("sha256").update(databaseUrl, "utf8").digest("hex");
}

/**
 * Cross-checks DATABASE_URL without accepting or printing the URL itself.
 * Operators compute the expected SHA-256 out of band and pass only the hash.
 */
export function assertDatabaseUrlFingerprint(
  expectedSha256: string,
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): void {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("--database-url-sha256 must be a 64-character hexadecimal SHA-256");
  }
  const actual = Buffer.from(databaseUrlSha256(databaseUrl), "hex");
  const expected = Buffer.from(expectedSha256.toLowerCase(), "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("DATABASE_URL fingerprint mismatch; refusing to run");
  }
}

export function assertAllowedFlags(argv: readonly string[], allowedFlags: readonly string[]): void {
  const allowed = new Set(allowedFlags);
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const flag = token.slice(2).split("=", 1)[0]!.toLowerCase();
    if (allowed.has(flag)) continue;
    if (SENSITIVE_FLAG_PARTS.some((part) => flag.includes(part))) {
      throw new Error(`refusing credential-like flag --${flag}`);
    }
    throw new Error(`unrecognized flag --${flag}`);
  }
}

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(KEY_VALUE_SECRET, "$1=<redacted>")
      .replace(URL_OR_JWT, "<redacted:url_or_jwt>");
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? "<redacted:sensitive_key>"
        : redactSensitive(entry);
    }
    return output;
  }
  return value;
}
