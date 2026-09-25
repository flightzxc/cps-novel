/** Add a second administrator without changing the first administrator's auth state. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import { normalizeAdminUsername } from "../src/lib/auth/login-attempts";
import { hashAdminPassword, verifyAdminPassword } from "../src/lib/auth/password";

export const ADD_ADMIN_AUDIT_ACTION = "admin_identity.add";
export const ADD_ADMIN_ROLE = "super_admin";
export const ADD_ADMIN_ADVISORY_LOCK = Object.freeze({ namespace: 50_313, scope: 1 });

export type AddAdminErrorCode =
  | "argument_missing" | "argument_value_missing" | "invalid_operator" | "invalid_password"
  | "password_forbidden_in_argv" | "invalid_reason" | "invalid_request_id"
  | "invalid_username" | "self_reference" | "username_exists"
  | "reference_identity_not_found" | "reference_password_mismatch"
  | "request_id_conflict" | "replay_integrity_error";

export class AddAdminError extends Error {
  constructor(readonly code: AddAdminErrorCode, message: string) {
    super(message);
    this.name = "AddAdminError";
  }
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AddAdminError("argument_value_missing", `${name} requires a value`);
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number, code: AddAdminErrorCode): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new AddAdminError(code, `${field} must contain 1-${max} characters`);
  return text;
}

function username(value: unknown): string {
  return normalizeAdminUsername(boundedText(value, "username", 160, "invalid_username"));
}

export type AddAdminCliOptions = Readonly<{
  username: string;
  referenceUsername: string;
  operatorId: string;
  reason: string;
  requestId: string;
  apply: boolean;
}>;

export function parseAddAdminCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv): AddAdminCliOptions {
  if (argv.some((item) => item === "--password" || item.startsWith("--password="))) {
    throw new AddAdminError("password_forbidden_in_argv", "Passwords are forbidden in argv");
  }
  const rawUsername = argument(argv, "--username");
  const rawReference = argument(argv, "--same-password-as");
  const rawReason = argument(argv, "--reason");
  const rawRequestId = argument(argv, "--request-id");
  if (rawUsername === undefined || rawReference === undefined || rawReason === undefined || rawRequestId === undefined) {
    throw new AddAdminError("argument_missing", "--username, --same-password-as, --reason and --request-id are required");
  }
  const target = username(rawUsername);
  const reference = username(rawReference);
  if (target === reference) throw new AddAdminError("self_reference", "Target and reference identities must differ");
  return Object.freeze({
    username: target,
    referenceUsername: reference,
    operatorId: boundedText(env.ADD_ADMIN_OPERATOR, "ADD_ADMIN_OPERATOR", 128, "invalid_operator"),
    reason: boundedText(rawReason, "reason", 2_000, "invalid_reason"),
    requestId: boundedText(rawRequestId, "requestId", 160, "invalid_request_id"),
    apply: argv.includes("--apply"),
  });
}

async function readPassword(env: NodeJS.ProcessEnv): Promise<string> {
  const file = env.ADD_ADMIN_PASSWORD_FILE;
  if (!file || !path.isAbsolute(file)) {
    throw new AddAdminError("invalid_password", "ADD_ADMIN_PASSWORD_FILE must be an absolute path");
  }
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    throw new AddAdminError("invalid_password", "ADD_ADMIN_PASSWORD_FILE cannot be read");
  }
  const password = contents.replace(/[\r\n]+$/, "");
  if (password.length < 12 || password.includes("\r") || password.includes("\n")) {
    throw new AddAdminError("invalid_password", "ADD_ADMIN_PASSWORD_FILE must contain one password of at least 12 characters");
  }
  return password;
}

type AddAdminReadDb = Pick<PrismaClientType, "adminIdentity" | "operationAudit">;
type AddAdminDb = AddAdminReadDb & Pick<PrismaClientType, "$transaction">;
type Identity = Readonly<{
  id: string; username: string; passwordHash: string; role: string; status: string; sessionVersion: number;
}>;
type Audit = Readonly<{
  id: bigint; actorId: string | null; entityId: string; reason: string | null;
  afterSnapshot: Prisma.JsonValue | null;
}>;

export type AddAdminReport = Readonly<{
  mode: "dry-run" | "apply";
  outcome: "eligible" | "created" | "replayed";
  username: string;
  role: typeof ADD_ADMIN_ROLE;
  requestId: string;
  identityId: string | null;
  auditId: string | null;
  wrote: boolean;
  referenceUsername: string;
}>;

async function findCommitted(db: AddAdminReadDb, requestId: string): Promise<Audit | null> {
  return db.operationAudit.findFirst({
    where: { actorType: "system", action: ADD_ADMIN_AUDIT_ACTION, requestId },
    select: { id: true, actorId: true, entityId: true, reason: true, afterSnapshot: true },
  });
}

function snapshot(audit: Audit): Record<string, unknown> | null {
  const value = audit.afterSnapshot;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function validateReplay(db: AddAdminReadDb, options: AddAdminCliOptions, audit: Audit, password: string): Promise<Identity> {
  const identity = await db.adminIdentity.findUnique({
    where: { id: audit.entityId },
    select: { id: true, username: true, passwordHash: true, role: true, status: true, sessionVersion: true },
  });
  const after = snapshot(audit);
  if (!identity || identity.username !== after?.username || identity.role !== ADD_ADMIN_ROLE
      || identity.status !== "active" || after?.role !== ADD_ADMIN_ROLE
      || after?.status !== "active") {
    throw new AddAdminError("replay_integrity_error", "Committed add audit does not resolve to its active identity");
  }
  if (audit.actorId !== options.operatorId || audit.reason !== options.reason
      || identity.username !== options.username || after?.samePasswordAs !== options.referenceUsername
      || !verifyAdminPassword(password, identity.passwordHash)) {
    throw new AddAdminError("request_id_conflict", "The request id is already committed for different input");
  }
  return identity;
}

function replayReport(mode: AddAdminReport["mode"], options: AddAdminCliOptions, audit: Audit, identity: Identity): AddAdminReport {
  return Object.freeze({
    mode, outcome: "replayed", username: identity.username, role: ADD_ADMIN_ROLE,
    requestId: options.requestId, identityId: identity.id, auditId: audit.id.toString(),
    wrote: false, referenceUsername: options.referenceUsername,
  });
}

async function checkEligibility(db: AddAdminReadDb, options: AddAdminCliOptions, password: string): Promise<void> {
  if (await db.adminIdentity.findUnique({ where: { username: options.username }, select: { id: true } })) {
    throw new AddAdminError("username_exists", "Target username already exists");
  }
  const reference = await db.adminIdentity.findUnique({
    where: { username: options.referenceUsername },
    select: { id: true, status: true, passwordHash: true },
  });
  if (!reference || reference.status !== "active") {
    throw new AddAdminError("reference_identity_not_found", "Active reference identity not found");
  }
  if (!verifyAdminPassword(password, reference.passwordHash)) {
    throw new AddAdminError("reference_password_mismatch", "Password does not match the reference identity");
  }
}

export async function runAddAdminCli(db: AddAdminDb, options: AddAdminCliOptions, env: NodeJS.ProcessEnv): Promise<AddAdminReport> {
  const password = await readPassword(env);
  if (!options.apply) {
    const committed = await findCommitted(db, options.requestId);
    if (committed) return replayReport("dry-run", options, committed, await validateReplay(db, options, committed, password));
    await checkEligibility(db, options, password);
    return Object.freeze({
      mode: "dry-run", outcome: "eligible", username: options.username, role: ADD_ADMIN_ROLE,
      requestId: options.requestId, identityId: null, auditId: null, wrote: false,
      referenceUsername: options.referenceUsername,
    });
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(${ADD_ADMIN_ADVISORY_LOCK.namespace}::int, ${ADD_ADMIN_ADVISORY_LOCK.scope}::int)::text AS lock_result
    `);
    const committed = await findCommitted(tx, options.requestId);
    if (committed) return replayReport("apply", options, committed, await validateReplay(tx, options, committed, password));
    await checkEligibility(tx, options, password);
    const identity = await tx.adminIdentity.create({
      data: {
        id: randomUUID(), username: options.username, passwordHash: hashAdminPassword(password),
        role: ADD_ADMIN_ROLE, status: "active", sessionVersion: 0,
      },
      select: { id: true, username: true, role: true, status: true, sessionVersion: true },
    });
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system", actorId: options.operatorId, action: ADD_ADMIN_AUDIT_ACTION,
        entityType: "AdminIdentity", entityId: identity.id, requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: { username: options.username, existed: false },
        afterSnapshot: {
          username: identity.username, role: identity.role, status: identity.status,
          sessionVersion: identity.sessionVersion, samePasswordAs: options.referenceUsername,
          twoFactor: "not_enrolled",
        },
      },
      select: { id: true },
    });
    return Object.freeze({
      mode: "apply", outcome: "created", username: identity.username, role: ADD_ADMIN_ROLE,
      requestId: options.requestId, identityId: identity.id, auditId: audit.id.toString(),
      wrote: true, referenceUsername: options.referenceUsername,
    });
  });
}

async function main(): Promise<void> {
  const options = parseAddAdminCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await runAddAdminCli(prisma, options, process.env);
    if (report.mode === "dry-run") console.log("[DRY RUN — no changes written; pass --apply to create the identity]");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof AddAdminError ? error.code : "add_admin_failed");
    process.exitCode = 1;
  });
}
