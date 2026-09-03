/**
 * RC-11 — audited, repeatable reset of one admin identity's *authentication
 * state*: every outstanding session, every pending/confirmed 2FA binding,
 * every recovery code, every 2FA challenge, and its login-attempt lockout
 * bucket. It never deletes the `AdminIdentity` row itself and never touches
 * `passwordHash` — this is "make the account loggable-in-and-re-enrollable
 * again", not "delete the account" and not "reset the password".
 *
 * Why this exists (2026-09-04 incident): X8 reused an old PostgreSQL volume
 * whose `x8-owner` identity had already completed 2FA setup on 2026-08-26.
 * Owner has neither the authenticator app entry nor the recovery codes for
 * that binding, so `/two-factor/challenge` is now a dead end for that
 * account — a correct password authenticates the session but nothing can
 * step it up. `bootstrap-admin-identity.ts` cannot fix this: it refuses
 * unless `admin_identity` is completely empty, and there was no "reset just
 * the auth state" tool. Manually `DELETE`ing rows would also work around the
 * audit trail this script exists to keep intact.
 *
 * Deliberately dry-run by default, same discipline as
 * `bootstrap-admin-identity.ts`: `--apply`, a stable caller-supplied
 * `--request-id`, `RESET_ADMIN_OPERATOR` from the environment (never argv),
 * a fixed transaction-level advisory lock, and one `OperationAudit` row
 * committed in the same transaction as every write. A second `--apply` for
 * the same `--request-id` replays the first outcome instead of writing
 * again — safe against an operator (or a retried CLI invocation) re-sending
 * the exact same command.
 *
 * Production break-glass gate: when `NODE_ENV=production` and the global 2FA
 * switch (`@/lib/auth/two-factor-enforcement.ts`) is at its fail-closed
 * `required` value, `--apply` additionally requires `--break-glass`. This is
 * the one path that lets an operator force an *enrolled* production identity
 * back to "never enrolled" without going through `/two-factor/setup`'s own
 * step-up — every such run is a distinct audited event
 * (`breakGlass: true` in `afterSnapshot`) precisely because it is a
 * privileged bypass, not routine maintenance. Local UAT
 * (`ADMIN_TWO_FACTOR_ENFORCEMENT=false`) never hits this gate.
 *
 * Usage:
 *   RESET_ADMIN_OPERATOR=<operator-id> \
 *     tsx scripts/reset-admin-auth-state.ts \
 *       --username <normalized-login> \
 *       --reason <why-this-reset-is-authorized> \
 *       --request-id <stable-caller-request-id> \
 *       [--deactivate] [--ip <client-ip-to-also-clear>] \
 *       [--apply] [--break-glass]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import { hashLoginAttemptIdentifier, normalizeAdminUsername } from "../src/lib/auth/login-attempts";
import { isTwoFactorEnforced } from "../src/lib/auth/two-factor-enforcement";

export const RESET_ADMIN_AUTH_AUDIT_ACTION = "admin_identity.auth_state_reset";
export const RESET_ADMIN_AUTH_ADVISORY_LOCK = Object.freeze({ namespace: 50_311, scope: 1 });

export type ResetAdminAuthStateErrorCode =
  | "argument_missing"
  | "argument_value_missing"
  | "break_glass_required"
  | "identity_not_found"
  | "invalid_ip"
  | "invalid_operator"
  | "invalid_reason"
  | "invalid_request_id"
  | "invalid_username";

export class ResetAdminAuthStateError extends Error {
  constructor(readonly code: ResetAdminAuthStateErrorCode, message: string) {
    super(message);
    this.name = "ResetAdminAuthStateError";
  }
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ResetAdminAuthStateError("argument_value_missing", `${name} requires a value`);
  }
  return value;
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  code: ResetAdminAuthStateErrorCode,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new ResetAdminAuthStateError(code, `${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

export type ResetAdminAuthStateCliOptions = Readonly<{
  username: string;
  operatorId: string;
  reason: string;
  requestId: string;
  ip: string | null;
  deactivate: boolean;
  apply: boolean;
  breakGlass: boolean;
}>;

export function parseResetAdminAuthStateCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ResetAdminAuthStateCliOptions {
  const username = argument(argv, "--username");
  const reason = argument(argv, "--reason");
  const requestId = argument(argv, "--request-id");
  const ip = argument(argv, "--ip");
  if (username === undefined) throw new ResetAdminAuthStateError("argument_missing", "--username is required");
  if (reason === undefined) throw new ResetAdminAuthStateError("argument_missing", "--reason is required");
  if (requestId === undefined) throw new ResetAdminAuthStateError("argument_missing", "--request-id is required");

  return Object.freeze({
    username: normalizeAdminUsername(boundedText(username, "username", 160, "invalid_username")),
    operatorId: boundedText(env.RESET_ADMIN_OPERATOR, "RESET_ADMIN_OPERATOR", 128, "invalid_operator"),
    reason: boundedText(reason, "reason", 2_000, "invalid_reason"),
    requestId: boundedText(requestId, "requestId", 160, "invalid_request_id"),
    ip: ip === undefined ? null : boundedText(ip, "ip", 64, "invalid_ip"),
    deactivate: argv.includes("--deactivate"),
    apply: argv.includes("--apply"),
    breakGlass: argv.includes("--break-glass"),
  });
}

/**
 * Fail-closed production guard. Only gates `--apply` (a dry-run preview is
 * always safe to run). Local UAT's `ADMIN_TWO_FACTOR_ENFORCEMENT=false`
 * never reaches this — `isTwoFactorEnforced` is false there by construction.
 */
export function requireBreakGlassIfNeeded(
  env: NodeJS.ProcessEnv,
  options: Pick<ResetAdminAuthStateCliOptions, "apply" | "breakGlass">,
): void {
  if (!options.apply) return;
  if (env.NODE_ENV !== "production") return;
  if (!isTwoFactorEnforced(env)) return;
  if (options.breakGlass) return;
  throw new ResetAdminAuthStateError(
    "break_glass_required",
    "Production with 2FA enforcement required needs --break-glass to reset an identity's auth state",
  );
}

type ResetAdminAuthStateReadDb = Pick<
  PrismaClientType,
  "adminIdentity" | "adminSession" | "adminTwoFactor" | "adminTwoFactorChallenge" | "adminRecoveryCode" | "adminLoginAttempt" | "operationAudit"
>;
type ResetAdminAuthStateDb = ResetAdminAuthStateReadDb & Pick<PrismaClientType, "$transaction">;

type TargetIdentity = Readonly<{
  id: string;
  username: string;
  status: string;
  sessionVersion: number;
}>;

type ResetAudit = Readonly<{
  id: bigint;
  actorId: string | null;
  entityId: string;
  reason: string | null;
  beforeSnapshot: Prisma.JsonValue | null;
  afterSnapshot: Prisma.JsonValue | null;
}>;

export type ResetAdminAuthStateCounts = Readonly<{
  sessionsRevoked: number;
  twoFactorChallengesDeleted: number;
  recoveryCodesDeleted: number;
  twoFactorReset: boolean;
  loginAttemptRowsCleared: number;
}>;

export type ResetAdminAuthStateReport = Readonly<{
  mode: "dry-run" | "apply";
  outcome: "eligible" | "reset" | "replayed";
  username: string;
  identityId: string | null;
  requestId: string;
  auditId: string | null;
  wrote: boolean;
  deactivated: boolean;
  sessionVersionBefore: number | null;
  sessionVersionAfter: number | null;
  counts: ResetAdminAuthStateCounts;
}>;

const ZERO_COUNTS: ResetAdminAuthStateCounts = Object.freeze({
  sessionsRevoked: 0,
  twoFactorChallengesDeleted: 0,
  recoveryCodesDeleted: 0,
  twoFactorReset: false,
  loginAttemptRowsCleared: 0,
});

function loginAttemptHashes(options: Pick<ResetAdminAuthStateCliOptions, "username" | "ip">): string[] {
  const hashes = [hashLoginAttemptIdentifier("user", options.username)];
  if (options.ip) hashes.push(hashLoginAttemptIdentifier("ip", options.ip));
  return hashes;
}

async function findTarget(db: ResetAdminAuthStateReadDb, username: string): Promise<TargetIdentity | null> {
  return db.adminIdentity.findUnique({
    where: { username },
    select: { id: true, username: true, status: true, sessionVersion: true },
  });
}

async function findCommittedReset(
  db: ResetAdminAuthStateReadDb,
  requestId: string,
): Promise<ResetAudit | null> {
  return db.operationAudit.findFirst({
    where: { actorType: "system", action: RESET_ADMIN_AUTH_AUDIT_ACTION, requestId },
    select: { id: true, actorId: true, entityId: true, reason: true, beforeSnapshot: true, afterSnapshot: true },
  });
}

function snapshotSessionVersion(snapshot: Prisma.JsonValue | null): number | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const value = (snapshot as Record<string, unknown>).sessionVersion;
  return typeof value === "number" ? value : null;
}

function snapshotCounts(snapshot: Prisma.JsonValue | null): ResetAdminAuthStateCounts {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return ZERO_COUNTS;
  const record = snapshot as Record<string, unknown>;
  const counts = record.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return ZERO_COUNTS;
  const c = counts as Record<string, unknown>;
  return Object.freeze({
    sessionsRevoked: typeof c.sessionsRevoked === "number" ? c.sessionsRevoked : 0,
    twoFactorChallengesDeleted: typeof c.twoFactorChallengesDeleted === "number" ? c.twoFactorChallengesDeleted : 0,
    recoveryCodesDeleted: typeof c.recoveryCodesDeleted === "number" ? c.recoveryCodesDeleted : 0,
    twoFactorReset: c.twoFactorReset === true,
    loginAttemptRowsCleared: typeof c.loginAttemptRowsCleared === "number" ? c.loginAttemptRowsCleared : 0,
  });
}

async function dryRun(
  db: ResetAdminAuthStateDb,
  options: ResetAdminAuthStateCliOptions,
): Promise<ResetAdminAuthStateReport> {
  const committed = await findCommittedReset(db, options.requestId);
  if (committed) {
    return Object.freeze({
      mode: "dry-run",
      outcome: "replayed",
      username: options.username,
      identityId: committed.entityId,
      requestId: options.requestId,
      auditId: committed.id.toString(),
      wrote: false,
      deactivated: options.deactivate,
      sessionVersionBefore: snapshotSessionVersion(committed.beforeSnapshot),
      sessionVersionAfter: snapshotSessionVersion(committed.afterSnapshot),
      counts: snapshotCounts(committed.afterSnapshot),
    });
  }

  const identity = await findTarget(db, options.username);
  if (!identity) {
    throw new ResetAdminAuthStateError("identity_not_found", `Admin identity "${options.username}" was not found`);
  }
  const hashes = loginAttemptHashes(options);
  const [sessionsActive, twoFactorChallenges, recoveryCodes, twoFactorRow, loginAttemptRows] = await Promise.all([
    db.adminSession.count({ where: { identityId: identity.id, revokedAt: null } }),
    db.adminTwoFactorChallenge.count({ where: { identityId: identity.id } }),
    db.adminRecoveryCode.count({ where: { identityId: identity.id } }),
    db.adminTwoFactor.findUnique({ where: { identityId: identity.id }, select: { enabled: true } }),
    db.adminLoginAttempt.count({ where: { identifierHash: { in: hashes } } }),
  ]);

  return Object.freeze({
    mode: "dry-run",
    outcome: "eligible",
    username: identity.username,
    identityId: identity.id,
    requestId: options.requestId,
    auditId: null,
    wrote: false,
    deactivated: options.deactivate,
    sessionVersionBefore: identity.sessionVersion,
    sessionVersionAfter: null,
    counts: Object.freeze({
      sessionsRevoked: sessionsActive,
      twoFactorChallengesDeleted: twoFactorChallenges,
      recoveryCodesDeleted: recoveryCodes,
      twoFactorReset: Boolean(twoFactorRow),
      loginAttemptRowsCleared: loginAttemptRows,
    }),
  });
}

async function applyReset(
  db: ResetAdminAuthStateDb,
  options: ResetAdminAuthStateCliOptions,
): Promise<ResetAdminAuthStateReport> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        ${RESET_ADMIN_AUTH_ADVISORY_LOCK.namespace}::int,
        ${RESET_ADMIN_AUTH_ADVISORY_LOCK.scope}::int
      )::text AS lock_result
    `);

    const committed = await findCommittedReset(tx, options.requestId);
    if (committed) {
      return Object.freeze({
        mode: "apply",
        outcome: "replayed",
        username: options.username,
        identityId: committed.entityId,
        requestId: options.requestId,
        auditId: committed.id.toString(),
        wrote: false,
        deactivated: options.deactivate,
        sessionVersionBefore: snapshotSessionVersion(committed.beforeSnapshot),
        sessionVersionAfter: snapshotSessionVersion(committed.afterSnapshot),
        counts: snapshotCounts(committed.afterSnapshot),
      } satisfies ResetAdminAuthStateReport);
    }

    const identity = await findTarget(tx, options.username);
    if (!identity) {
      throw new ResetAdminAuthStateError("identity_not_found", `Admin identity "${options.username}" was not found`);
    }

    const sessionsRevoked = (
      await tx.adminSession.updateMany({
        where: { identityId: identity.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    ).count;
    const twoFactorChallengesDeleted = (
      await tx.adminTwoFactorChallenge.deleteMany({ where: { identityId: identity.id } })
    ).count;
    const recoveryCodesDeleted = (
      await tx.adminRecoveryCode.deleteMany({ where: { identityId: identity.id } })
    ).count;
    const twoFactorReset = (
      await tx.adminTwoFactor.updateMany({
        where: { identityId: identity.id },
        data: {
          enabled: false,
          encryptedSecret: null,
          keyVersion: null,
          confirmedAt: null,
          pendingEncryptedSecret: null,
          pendingKeyVersion: null,
          pendingExpiresAt: null,
          recoveryCodesRotatedAt: null,
        },
      })
    ).count > 0;
    const loginAttemptRowsCleared = (
      await tx.adminLoginAttempt.deleteMany({ where: { identifierHash: { in: loginAttemptHashes(options) } } })
    ).count;
    const updatedIdentity = await tx.adminIdentity.update({
      where: { id: identity.id },
      data: {
        sessionVersion: { increment: 1 },
        ...(options.deactivate ? { status: "disabled" } : {}),
      },
      select: { sessionVersion: true, status: true },
    });

    const counts: ResetAdminAuthStateCounts = Object.freeze({
      sessionsRevoked,
      twoFactorChallengesDeleted,
      recoveryCodesDeleted,
      twoFactorReset,
      loginAttemptRowsCleared,
    });

    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: RESET_ADMIN_AUTH_AUDIT_ACTION,
        entityType: "AdminIdentity",
        entityId: identity.id,
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: {
          username: identity.username,
          status: identity.status,
          sessionVersion: identity.sessionVersion,
        },
        afterSnapshot: {
          username: identity.username,
          status: updatedIdentity.status,
          sessionVersion: updatedIdentity.sessionVersion,
          deactivated: options.deactivate,
          breakGlass: options.breakGlass,
          counts,
        },
      },
      select: { id: true },
    });

    return Object.freeze({
      mode: "apply",
      outcome: "reset",
      username: identity.username,
      identityId: identity.id,
      requestId: options.requestId,
      auditId: audit.id.toString(),
      wrote: true,
      deactivated: options.deactivate,
      sessionVersionBefore: identity.sessionVersion,
      sessionVersionAfter: updatedIdentity.sessionVersion,
      counts,
    } satisfies ResetAdminAuthStateReport);
  });
}

export async function runResetAdminAuthStateCli(
  db: ResetAdminAuthStateDb,
  options: ResetAdminAuthStateCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResetAdminAuthStateReport> {
  requireBreakGlassIfNeeded(env, options);
  if (!options.apply) return dryRun(db, options);
  return applyReset(db, options);
}

async function main(): Promise<void> {
  const options = parseResetAdminAuthStateCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await runResetAdminAuthStateCli(prisma, options, process.env);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply to reset this identity's auth state]");
    }
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
