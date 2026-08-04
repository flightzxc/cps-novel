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
