import { CredentialLifecycleError } from "./lifecycle";

/**
 * A JWT-shaped token: three dot-separated base64url segments (RFC 7519
 * compact serialization). Matched against whitespace-delimited words rather
 * than the whole string, so a JWT-like fragment embedded anywhere inside a
 * longer reason (e.g. "Bearer <jwt> rotation") is still caught.
 */
const JWT_LIKE_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * A semver token (SemVer 2.0.0 grammar): optional leading "v", numeric
 * MAJOR.MINOR.PATCH, optional -prerelease and/or +build metadata, e.g.
 * "v0.2.0", "1.2.3", "2.0.0-rc.1", "2.0.0+build.123". Deliberately narrower
 * than JWT_LIKE_TOKEN so it only exempts genuine version strings and never
 * widens what otherwise counts as JWT-shaped.
 */
const SEMVER_TOKEN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Finds the first whitespace-delimited word in `text` that has JWT
 * compact-serialization shape (three dot-separated base64url segments) and
 * is not a semver string. Returns the matched word, or null if none exists.
 *
 * Exported for regression testing; prefer `assertReasonFreeOfCredentialMaterial`
 * at call sites.
 */
export function findJwtLikeToken(text: string): string | null {
  for (const token of text.split(/\s+/)) {
    if (token && JWT_LIKE_TOKEN.test(token) && !SEMVER_TOKEN.test(token)) {
      return token;
    }
  }
  return null;
}

/**
 * Rejects a free-text operation reason that appears to carry credential
 * material: either it echoes the secret submitted in the same request, or it
 * contains a JWT-shaped token (three dot-separated base64url segments) that
 * is not merely a version string. The reason is persisted into the audit
 * trail (operation_audit / credential_change_log), so it must never carry a
 * plaintext credential.
 *
 * Deliberately does not exempt anything beyond semver tokens: other
 * credential-shaped material (long random strings, Bearer-prefixed JWTs,
 * foreign JWTs unrelated to the current secret) must keep being rejected.
 */
export function assertReasonFreeOfCredentialMaterial(reasonText: string, submittedSecret: string): void {
  const trimmedSecret = submittedSecret.trim();
  const containsSubmittedSecret = Boolean(trimmedSecret && reasonText.includes(trimmedSecret));
  const jwtLikeToken = findJwtLikeToken(reasonText);
  if (containsSubmittedSecret || jwtLikeToken !== null) {
    const matchedPattern = containsSubmittedSecret
      ? "value matches the submitted credential secret"
      : "value matches JWT-like structure (three dot-separated base64url segments)";
    throw new CredentialLifecycleError(
      "credential_validation_failed",
      `The operation reason must not contain credential material: ${matchedPattern}`,
    );
  }
}
