/**
 * Admin frontend contract surface (P1-08B).
 *
 * This module is the only shape the browser may receive. Two rules make that
 * enforceable rather than aspirational:
 *
 * 1. Zero runtime imports from `src/lib/**` or `src/server/**` — only
 *    `import type`. `@/lib/auth/session` pulls in `node:crypto`, so a value
 *    import here would drag Node built-ins into a client bundle.
 * 2. Every projection assembles its output field-by-field. Nothing spreads a
 *    database row, an `AdminAuthContext`, or an `Error`, so `tokenHash`,
 *    `sessionVersion`, `passwordHash`, `encryptedSecret`, the full fingerprint,
 *    TOTP ciphertext, recovery-code hashes and stack traces have no path out.
 */
export * from "./errors";
export * from "./admin-session";
export * from "./two-factor";
export * from "./channel-accounts";
export * from "./credentials";
