/**
 * Ported from CPS `src/lib/channel-account/jwt.ts`'s `normalizeJwtInput`
 * (identical semantics, renamed for this codebase's credential module):
 * strips an operator's copy-pasted `Authorization: Bearer <token>` header or
 * bare `Bearer <token>` prefix before the value is validated, fingerprinted,
 * or encrypted, so a pasted-with-prefix credential does not silently become
 * a different (invalid) token than the one the operator intended to store.
 * Case-insensitive; trims both the outer value and the captured group.
 */
export function normalizeCredentialJwtInput(value: string): string {
  const trimmed = value.trim();
  const authorizationMatch = /^Authorization\s*:\s*Bearer\s+(.+)$/i.exec(trimmed);
  if (authorizationMatch) {
    return authorizationMatch[1].trim();
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  return trimmed;
}

export type LocalCredentialValidation =
  | { status: "active"; expiresAt: Date }
  | { status: "expired"; expiresAt: Date }
  | { status: "invalid"; expiresAt: null };

export function validateCredentialJwtLocally(token: string, now = new Date()): LocalCredentialValidation {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return { status: "invalid", expiresAt: null };
  try {
    const padded = parts[1].padEnd(parts[1].length + ((4 - parts[1].length % 4) % 4), "=");
    const payload = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { status: "invalid", expiresAt: null };
    const milliseconds = payload.exp >= 1_000_000_000_000 ? payload.exp : payload.exp * 1000;
    const expiresAt = new Date(milliseconds);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getUTCFullYear() > 9999) return { status: "invalid", expiresAt: null };
    return expiresAt > now ? { status: "active", expiresAt } : { status: "expired", expiresAt };
  } catch {
    return { status: "invalid", expiresAt: null };
  }
}
