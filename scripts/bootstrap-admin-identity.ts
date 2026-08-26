/**
 * One-time, audited bootstrap for the first admin identity.
 *
 * The command is deliberately dry-run by default. The write path requires an
 * explicit `--apply`, a stable caller-supplied request id, and a password from
 * `BOOTSTRAP_ADMIN_PASSWORD` (never argv). A fixed transaction-level advisory
 * lock serializes every bootstrap attempt; after taking it, the transaction
 * checks for a committed request-id replay and then re-confirms that the
 * identity table is empty before creating exactly one active `super_admin`.
 * The identity and its `OperationAudit` row commit or roll back together.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_OPERATOR=<operator-id> \
 *   BOOTSTRAP_ADMIN_PASSWORD=<at-least-12-characters> \
 *     tsx scripts/bootstrap-admin-identity.ts \
 *       --username <normalized-login> \
 *       --reason <why-bootstrap-is-authorized> \
 *       --request-id <stable-deployment-request-id> \
 *       [--apply]
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import { normalizeAdminUsername } from "../src/lib/auth/login-attempts";
import { hashAdminPassword, verifyAdminPassword } from "../src/lib/auth/password";

export const BOOTSTRAP_ADMIN_AUDIT_ACTION = "admin_identity.bootstrap";
export const BOOTSTRAP_ADMIN_ROLE = "super_admin";
export const BOOTSTRAP_ADMIN_ADVISORY_LOCK = Object.freeze({ namespace: 50_310, scope: 1 });

export type BootstrapAdminErrorCode =
  | "argument_missing"
  | "argument_value_missing"
  | "identity_table_not_empty"
  | "invalid_operator"
  | "invalid_password"
  | "invalid_reason"
  | "invalid_request_id"
  | "invalid_username"
  | "replay_integrity_error"
  | "request_id_conflict";

export class BootstrapAdminError extends Error {
  constructor(readonly code: BootstrapAdminErrorCode, message: string) {
    super(message);
    this.name = "BootstrapAdminError";
  }
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BootstrapAdminError("argument_value_missing", `${name} requires a value`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maxLength: number, code: BootstrapAdminErrorCode): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new BootstrapAdminError(code, `${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function normalizeUsername(value: unknown): string {
  return normalizeAdminUsername(boundedText(value, "username", 160, "invalid_username"));
}

function requirePassword(env: NodeJS.ProcessEnv): string {
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (typeof password !== "string" || password.length < 12) {
    throw new BootstrapAdminError(
      "invalid_password",
      "BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters and may only be supplied through the environment",
    );
  }
  return password;
}

export type BootstrapAdminCliOptions = Readonly<{
  username: string;
  operatorId: string;
  reason: string;
  requestId: string;
  apply: boolean;
}>;

export function parseBootstrapAdminCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BootstrapAdminCliOptions {
  if (argv.includes("--password")) {
    throw new BootstrapAdminError(
      "invalid_password",
      "Passwords are forbidden in argv; use BOOTSTRAP_ADMIN_PASSWORD",
    );
  }
  const username = argument(argv, "--username");
  const reason = argument(argv, "--reason");
  const requestId = argument(argv, "--request-id");
  if (username === undefined) throw new BootstrapAdminError("argument_missing", "--username is required");
  if (reason === undefined) throw new BootstrapAdminError("argument_missing", "--reason is required");
  if (requestId === undefined) throw new BootstrapAdminError("argument_missing", "--request-id is required");

  const options = Object.freeze({
    username: normalizeUsername(username),
    operatorId: boundedText(env.BOOTSTRAP_ADMIN_OPERATOR, "BOOTSTRAP_ADMIN_OPERATOR", 128, "invalid_operator"),
    reason: boundedText(reason, "reason", 2_000, "invalid_reason"),
    requestId: boundedText(requestId, "requestId", 160, "invalid_request_id"),
    apply: argv.includes("--apply"),
  });
  if (options.apply) requirePassword(env);
  return options;
}

type BootstrapAdminReadDb = Pick<PrismaClientType, "adminIdentity" | "operationAudit">;
type BootstrapAdminDb = BootstrapAdminReadDb & Pick<PrismaClientType, "$transaction">;

type BootstrapAudit = Readonly<{
  id: bigint;
  actorId: string | null;
  entityId: string;
  reason: string | null;
  afterSnapshot: Prisma.JsonValue | null;
}>;

type BootstrapIdentity = Readonly<{
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  status: string;
  sessionVersion: number;
}>;

export type BootstrapAdminReport = Readonly<{
  mode: "dry-run" | "apply";
  outcome: "eligible" | "created" | "replayed";
  username: string;
  role: typeof BOOTSTRAP_ADMIN_ROLE;
  requestId: string;
  identityId: string | null;
  auditId: string | null;
  wrote: boolean;
}>;

const AUDIT_SELECT = Object.freeze({
  id: true,
  actorId: true,
  entityId: true,
  reason: true,
  afterSnapshot: true,
});

async function findCommittedBootstrap(db: BootstrapAdminReadDb, requestId: string): Promise<BootstrapAudit | null> {
  return db.operationAudit.findFirst({
    where: {
      actorType: "system",
      action: BOOTSTRAP_ADMIN_AUDIT_ACTION,
      requestId,
    },
    select: AUDIT_SELECT,
  });
}

function auditUsername(audit: BootstrapAudit): string | null {
  const snapshot = audit.afterSnapshot;
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  const username = (snapshot as Record<string, Prisma.JsonValue>).username;
  return typeof username === "string" ? username : null;
}

async function validateCommittedReplay(
  db: BootstrapAdminReadDb,
  options: BootstrapAdminCliOptions,
  audit: BootstrapAudit,
  password: string | null,
): Promise<BootstrapIdentity> {
  if (await db.adminIdentity.count() !== 1) {
    throw new BootstrapAdminError(
      "identity_table_not_empty",
      "Bootstrap replay refused because admin_identity contains an identity other than the committed bootstrap identity",
    );
  }
  const identity = await db.adminIdentity.findUnique({
    where: { id: audit.entityId },
    select: {
      id: true,
      username: true,
      passwordHash: true,
      role: true,
      status: true,
      sessionVersion: true,
    },
  });
  if (!identity || identity.role !== BOOTSTRAP_ADMIN_ROLE || identity.status !== "active") {
    throw new BootstrapAdminError(
      "replay_integrity_error",
      "The committed bootstrap audit no longer resolves to its active super_admin identity",
    );
  }
  const bindingMatches = audit.actorId === options.operatorId
    && audit.reason === options.reason
    && auditUsername(audit) === options.username
    && identity.username === options.username;
  if (!bindingMatches || (password !== null && !verifyAdminPassword(password, identity.passwordHash))) {
    throw new BootstrapAdminError(
      "request_id_conflict",
      "The request id is already committed for different bootstrap input",
    );
  }
  return identity;
}

function replayReport(
  mode: BootstrapAdminReport["mode"],
  options: BootstrapAdminCliOptions,
  audit: BootstrapAudit,
  identity: BootstrapIdentity,
): BootstrapAdminReport {
  return Object.freeze({
    mode,
    outcome: "replayed",
    username: identity.username,
    role: BOOTSTRAP_ADMIN_ROLE,
    requestId: options.requestId,
    identityId: identity.id,
    auditId: audit.id.toString(),
    wrote: false,
  });
}

async function dryRun(
  db: BootstrapAdminDb,
  options: BootstrapAdminCliOptions,
): Promise<BootstrapAdminReport> {
  const committed = await findCommittedBootstrap(db, options.requestId);
  if (committed) {
    const identity = await validateCommittedReplay(db, options, committed, null);
    return replayReport("dry-run", options, committed, identity);
  }
  if (await db.adminIdentity.count() !== 0) {
    throw new BootstrapAdminError(
      "identity_table_not_empty",
      "Bootstrap refused because admin_identity already contains an identity",
    );
  }
  return Object.freeze({
    mode: "dry-run",
    outcome: "eligible",
    username: options.username,
    role: BOOTSTRAP_ADMIN_ROLE,
    requestId: options.requestId,
    identityId: null,
    auditId: null,
    wrote: false,
  });
}

async function applyBootstrap(
  db: BootstrapAdminDb,
  options: BootstrapAdminCliOptions,
  password: string,
): Promise<BootstrapAdminReport> {
  const identityId = randomUUID();
  const passwordHash = hashAdminPassword(password);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        ${BOOTSTRAP_ADMIN_ADVISORY_LOCK.namespace},
        ${BOOTSTRAP_ADMIN_ADVISORY_LOCK.scope}
      )
    `);

    const committed = await findCommittedBootstrap(tx, options.requestId);
    if (committed) {
      const identity = await validateCommittedReplay(tx, options, committed, password);
      return replayReport("apply", options, committed, identity);
    }

    // This check must remain after the advisory lock and inside the write
    // transaction. A preflight count cannot defend two concurrent first-user
    // attempts from both observing an empty table.
    if (await tx.adminIdentity.count() !== 0) {
      throw new BootstrapAdminError(
        "identity_table_not_empty",
        "Bootstrap refused because admin_identity already contains an identity",
      );
    }

    const identity = await tx.adminIdentity.create({
      data: {
        id: identityId,
        username: options.username,
        passwordHash,
        role: BOOTSTRAP_ADMIN_ROLE,
        status: "active",
        sessionVersion: 0,
      },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        sessionVersion: true,
      },
    });
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: BOOTSTRAP_ADMIN_AUDIT_ACTION,
        entityType: "AdminIdentity",
        entityId: identity.id,
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: { identityCount: 0 },
        afterSnapshot: {
          username: identity.username,
          role: identity.role,
          status: identity.status,
          sessionVersion: identity.sessionVersion,
        },
      },
      select: { id: true },
    });

    return Object.freeze({
      mode: "apply",
      outcome: "created",
      username: identity.username,
      role: BOOTSTRAP_ADMIN_ROLE,
      requestId: options.requestId,
      identityId: identity.id,
      auditId: audit.id.toString(),
      wrote: true,
    });
  });
}

export async function runBootstrapAdminCli(
  db: BootstrapAdminDb,
  options: BootstrapAdminCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<BootstrapAdminReport> {
  if (!options.apply) return dryRun(db, options);
  return applyBootstrap(db, options, requirePassword(env));
}

async function main(): Promise<void> {
  const options = parseBootstrapAdminCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await runBootstrapAdminCli(prisma, options, process.env);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply to create the first super_admin]");
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
