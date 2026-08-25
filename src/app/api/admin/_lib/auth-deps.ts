import {
  PostgreSQLAuthUnitOfWork,
  PostgreSQLLoginAttemptStore,
  PostgreSQLRecoveryCodeStore,
  PostgreSQLTwoFactorStore,
} from "@/lib/auth/postgres";

import { prisma } from "./deps";

/**
 * Store factories for the PR-C1 login / 2FA surface.
 *
 * Lives beside `deps.ts` rather than inside it: `deps.ts` only ever wired
 * `identities` + `sessions` (what `guardDependencies()` needs for the
 * already-registered page/route/action guards). Login, the two-factor
 * challenge and the two-factor setup flow are bootstrapping surfaces that
 * sit outside that registry (see `(admin-auth)/_lib/auth-session.ts`), so
 * they need the remaining Postgres adapters `deps.ts` never had a reason to
 * construct. Kept additive and separate so `deps.ts` — which
 * `tests/backend/auth/security-boundaries.test.ts` source-scans for the
 * `ADMIN_CANONICAL_ORIGIN` discipline — never has to change for this.
 *
 * Every factory shares the one process-wide `prisma` client from `deps.ts`;
 * nothing here opens a second connection pool.
 */
export function twoFactorStore(): PostgreSQLTwoFactorStore {
  return new PostgreSQLTwoFactorStore(prisma);
}

export function recoveryCodeStore(): PostgreSQLRecoveryCodeStore {
  return new PostgreSQLRecoveryCodeStore(prisma);
}

export function loginAttemptStore(): PostgreSQLLoginAttemptStore {
  return new PostgreSQLLoginAttemptStore(prisma);
}

export function authUnitOfWork(): PostgreSQLAuthUnitOfWork {
  return new PostgreSQLAuthUnitOfWork(prisma);
}
