/**
 * RC-11 — idempotent local-only bootstrap for the two X8 `X8_LEVEL=uat`
 * operator accounts, `admin` and `admin2`.
 *
 * Hard fail-closed gate: this script refuses to do anything unless
 * `ADMIN_LOCAL_IDENTITY_SEED` is the exact value `allow` — a value that only
 * `scripts/lib/x8-levels.json`'s `uat` entry ever exports (Level 0 and Level
 * R leave it unset). This is the one place the 12-character admin-password
 * floor (`@/lib/auth/password.ts`) can be relaxed: real deploys and Level 0
 * always keep the full floor, because this whole script is a no-op there.
 *
 * Passwords never appear in argv, never in a committed file, and never in a
 * log line. They come from `X8_ADMIN_PASSWORD` / `X8_ADMIN2_PASSWORD`, which
 * `scripts/x8-production-like.sh admin-secret set <user>` writes (via a
 * `read -s` stdin prompt, 0600 file, never echoed) to
 * `${X8_RUNTIME_DIR}/secrets/admin-password` / `admin2-password` and
 * `admin-seed` then loads into the environment before invoking this script —
 * the same "secret file, never argv" discipline as every other X8 local
 * secret (`scripts/lib/p1-12-local-env.sh`).
 *
 * Idempotent: an existing `admin`/`admin2` identity is left untouched unless
 * `--reset-password` is passed, in which case only its password hash and
 * `sessionVersion` (to invalidate any session issued under the old password)
 * change — role, status, and 2FA state are never touched by this script.
 * Every real write gets its own `OperationAudit` row; a no-op run (both
 * identities already exist, no `--reset-password`) writes nothing.
 *
 * Usage:
 *   ADMIN_LOCAL_IDENTITY_SEED=allow \
 *   X8_ADMIN_PASSWORD=<local-only-password> \
 *   X8_ADMIN2_PASSWORD=<local-only-password> \
 *     tsx scripts/ensure-local-admin-identities.ts [--reset-password]
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import { normalizeAdminUsername } from "../src/lib/auth/login-attempts";
import { hashAdminPassword } from "../src/lib/auth/password";

export const ADMIN_LOCAL_IDENTITY_SEED_ENV = "ADMIN_LOCAL_IDENTITY_SEED";
export const ADMIN_LOCAL_IDENTITY_SEED_ALLOW_VALUE = "allow";
export const ENSURE_LOCAL_ADMIN_IDENTITY_AUDIT_ACTION = "admin_identity.local_seed_ensure";
export const ENSURE_LOCAL_ADMIN_IDENTITY_ROLE = "super_admin";
export const ENSURE_LOCAL_ADMIN_IDENTITY_USERNAMES = ["admin", "admin2"] as const;
export const ENSURE_LOCAL_ADMIN_IDENTITY_ADVISORY_LOCK = Object.freeze({ namespace: 50_312, scope: 1 });
const DEFAULT_OPERATOR_ID = "x8-local-identity-seed";

export type EnsureLocalAdminIdentityUsername = (typeof ENSURE_LOCAL_ADMIN_IDENTITY_USERNAMES)[number];

const PASSWORD_ENV_BY_USERNAME: Readonly<Record<EnsureLocalAdminIdentityUsername, string>> = Object.freeze({
  admin: "X8_ADMIN_PASSWORD",
  admin2: "X8_ADMIN2_PASSWORD",
});

export type EnsureLocalAdminIdentityErrorCode =
  | "argument_value_missing"
  | "missing_password"
  | "password_forbidden_in_argv"
  | "seed_not_allowed";

export class EnsureLocalAdminIdentityError extends Error {
  constructor(readonly code: EnsureLocalAdminIdentityErrorCode, message: string) {
    super(message);
    this.name = "EnsureLocalAdminIdentityError";
  }
}

/**
 * Fail-closed by construction, same shape as
 * `@/lib/auth/two-factor-enforcement.ts`'s `readTwoFactorEnforcement`: only
 * the exact (trimmed) value `"allow"` opens this script up. Unset, `"true"`,
 * a typo, or any other value refuses to run.
 */
export function requireLocalIdentitySeedAllowed(env: NodeJS.ProcessEnv): void {
  const raw = env[ADMIN_LOCAL_IDENTITY_SEED_ENV];
  const normalized = typeof raw === "string" ? raw.trim() : "";
  if (normalized !== ADMIN_LOCAL_IDENTITY_SEED_ALLOW_VALUE) {
    throw new EnsureLocalAdminIdentityError(
      "seed_not_allowed",
      `${ADMIN_LOCAL_IDENTITY_SEED_ENV} must be exactly "allow" (X8_LEVEL=uat only); refusing to seed local admin identities`,
    );
  }
}

export function requireLocalAdminPasswords(
  env: NodeJS.ProcessEnv,
): Readonly<Record<EnsureLocalAdminIdentityUsername, string>> {
  const passwords: Partial<Record<EnsureLocalAdminIdentityUsername, string>> = {};
  for (const username of ENSURE_LOCAL_ADMIN_IDENTITY_USERNAMES) {
    const envKey = PASSWORD_ENV_BY_USERNAME[username];
    const value = env[envKey];
    if (typeof value !== "string" || value.length === 0) {
      throw new EnsureLocalAdminIdentityError(
        "missing_password",
        `${envKey} is required to seed "${username}" — set it with `
          + `scripts/x8-production-like.sh admin-secret set ${username}`,
      );
    }
    passwords[username] = value;
  }
  return Object.freeze(passwords as Record<EnsureLocalAdminIdentityUsername, string>);
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new EnsureLocalAdminIdentityError(
      "argument_value_missing",
      `${field} must contain 1-${maxLength} characters`,
    );
  }
  return normalized;
}

export type EnsureLocalAdminIdentitiesCliOptions = Readonly<{
  operatorId: string;
  resetPassword: boolean;
}>;

export function parseEnsureLocalAdminIdentitiesCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): EnsureLocalAdminIdentitiesCliOptions {
  if (argv.includes("--password")) {
    throw new EnsureLocalAdminIdentityError(
      "password_forbidden_in_argv",
      "Passwords are forbidden in argv; use X8_ADMIN_PASSWORD / X8_ADMIN2_PASSWORD",
    );
  }
  return Object.freeze({
    operatorId: boundedText(env.ADMIN_LOCAL_IDENTITY_SEED_OPERATOR ?? DEFAULT_OPERATOR_ID, "operatorId", 128),
    resetPassword: argv.includes("--reset-password"),
  });
}

type EnsureLocalAdminIdentityDb = Pick<PrismaClientType, "adminIdentity" | "operationAudit" | "$transaction">;

export type EnsureLocalAdminIdentityOutcome = "created" | "password_reset" | "skipped_existing";

export type EnsureLocalAdminIdentityUserReport = Readonly<{
  username: EnsureLocalAdminIdentityUsername;
  outcome: EnsureLocalAdminIdentityOutcome;
  identityId: string;
  auditId: string | null;
  wrote: boolean;
}>;

export type EnsureLocalAdminIdentitiesReport = Readonly<{
  users: readonly EnsureLocalAdminIdentityUserReport[];
}>;

async function ensureOneIdentity(
  db: EnsureLocalAdminIdentityDb,
  username: EnsureLocalAdminIdentityUsername,
  password: string,
  options: EnsureLocalAdminIdentitiesCliOptions,
): Promise<EnsureLocalAdminIdentityUserReport> {
  const normalizedUsername = normalizeAdminUsername(username);
  // The 12-character floor is deliberately bypassed here (`minLength: 1`),
  // not raised — this function only ever runs after
  // `requireLocalIdentitySeedAllowed` has already confirmed
  // `ADMIN_LOCAL_IDENTITY_SEED=allow`, which only `X8_LEVEL=uat` sets.
  const passwordHash = hashAdminPassword(password, { minLength: 1 });

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        ${ENSURE_LOCAL_ADMIN_IDENTITY_ADVISORY_LOCK.namespace}::int,
        ${ENSURE_LOCAL_ADMIN_IDENTITY_ADVISORY_LOCK.scope}::int
      )::text AS lock_result
    `;

    const existing = await tx.adminIdentity.findUnique({
      where: { username: normalizedUsername },
      select: { id: true, role: true, status: true, sessionVersion: true },
    });

    if (existing) {
      if (!options.resetPassword) {
        return Object.freeze({
          username,
          outcome: "skipped_existing" as const,
          identityId: existing.id,
          auditId: null,
          wrote: false,
        });
      }
      const updated = await tx.adminIdentity.update({
        where: { id: existing.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
        select: { id: true, sessionVersion: true },
      });
      const audit = await tx.operationAudit.create({
        data: {
          actorType: "system",
          actorId: options.operatorId,
          action: ENSURE_LOCAL_ADMIN_IDENTITY_AUDIT_ACTION,
          entityType: "AdminIdentity",
          entityId: existing.id,
          reason: "X8 local UAT admin password reset (--reset-password)",
          beforeSnapshot: { username: normalizedUsername, sessionVersion: existing.sessionVersion },
          afterSnapshot: { username: normalizedUsername, sessionVersion: updated.sessionVersion, outcome: "password_reset" },
        },
        select: { id: true },
      });
      return Object.freeze({
        username,
        outcome: "password_reset" as const,
        identityId: existing.id,
        auditId: audit.id.toString(),
        wrote: true,
      });
    }

    const identityId = randomUUID();
    const created = await tx.adminIdentity.create({
      data: {
        id: identityId,
        username: normalizedUsername,
        passwordHash,
        role: ENSURE_LOCAL_ADMIN_IDENTITY_ROLE,
        status: "active",
        sessionVersion: 0,
      },
      select: { id: true },
    });
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: ENSURE_LOCAL_ADMIN_IDENTITY_AUDIT_ACTION,
        entityType: "AdminIdentity",
        entityId: created.id,
        reason: "X8 local UAT admin identity seed",
        beforeSnapshot: { username: normalizedUsername, existed: false },
        afterSnapshot: {
          username: normalizedUsername,
          role: ENSURE_LOCAL_ADMIN_IDENTITY_ROLE,
          status: "active",
          sessionVersion: 0,
          outcome: "created",
        },
      },
      select: { id: true },
    });
    return Object.freeze({
      username,
      outcome: "created" as const,
      identityId: created.id,
      auditId: audit.id.toString(),
      wrote: true,
    });
  });
}

export async function runEnsureLocalAdminIdentitiesCli(
  db: EnsureLocalAdminIdentityDb,
  options: EnsureLocalAdminIdentitiesCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<EnsureLocalAdminIdentitiesReport> {
  requireLocalIdentitySeedAllowed(env);
  const passwords = requireLocalAdminPasswords(env);
  const users: EnsureLocalAdminIdentityUserReport[] = [];
  // Sequential, not Promise.all: each user's transaction takes the same
  // fixed advisory lock, so concurrent transactions would only serialize
  // anyway — running them one at a time keeps the report's write order
  // deterministic (admin, then admin2) instead of depending on lock queue
  // order.
  for (const username of ENSURE_LOCAL_ADMIN_IDENTITY_USERNAMES) {
    users.push(await ensureOneIdentity(db, username, passwords[username], options));
  }
  return Object.freeze({ users: Object.freeze(users) });
}

async function main(): Promise<void> {
  const options = parseEnsureLocalAdminIdentitiesCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await runEnsureLocalAdminIdentitiesCli(prisma, options, process.env);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
