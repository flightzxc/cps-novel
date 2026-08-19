import { createHash } from "node:crypto";

/**
 * Open-redirect guard. Copied from CPS `normalizeRedirectUrl`
 * (`src/app/go/[code]/route.ts:160-168`): parse with `new URL()`, allow only
 * http/https, return "" on failure or any other protocol.
 */
export function normalizeRedirectUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Salted SHA-256 of IP / User-Agent. Adapted from CPS `hashSensitive`
 * (`src/lib/cps-tracking.ts:282-285`): drop the `"cps-tracking"` default salt
 * and `AUTH_SECRET` fallback; salt is `TRACKING_HASH_SALT` (empty if unset).
 */
export function hashSensitive(value: string): string {
  const salt = process.env.TRACKING_HASH_SALT ?? "";
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

/** First client IP from forwarded headers. Copied from CPS `getRequestIp`. */
export function getRequestIp(headers: Headers): string | null {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("cf-connecting-ip")?.trim() ||
    null
  );
}
