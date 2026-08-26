/**
 * Register the one frozen MoboReader foundation profile.
 *
 * This is deliberately an operator-run, dry-run-by-default bootstrap tool.
 * It creates no credentials and performs no upstream calls. `--apply` holds
 * a PostgreSQL advisory transaction lock, validates every pre-existing row,
 * creates only missing rows, and appends OperationAudit in the same
 * transaction. Existing enabled capabilities are preserved; this script can
 * never create or promote an enabled capability.
 *
 * Usage:
 *   MOBOREADER_FOUNDATION_OPERATOR=<operator> \
 *     npx tsx scripts/register-moboreader-foundation.ts \
 *       --request-id <stable-id> --reason "initial production registration" [--apply]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

export class MoboreaderFoundationError extends Error {
  constructor(
    readonly code:
      | "invalid_arguments"
      | "metadata_drift"
      | "request_replay_conflict"
      | "incomplete_replay",
    message: string,
  ) {
    super(message);
    this.name = "MoboreaderFoundationError";
  }
}

export const MOBOREADER_FOUNDATION = Object.freeze({
  channel: Object.freeze({ code: "moboreader", name: "MoboReader", status: "active" }),
  sourceApp: Object.freeze({ code: "changdu", name: "Changdu", status: "active" }),
  channelApp: Object.freeze({
    externalAppId: "moboreader",
    projectType: 1,
    status: "active",
    config: Object.freeze({}),
  }),
  capabilities: Object.freeze([
    Object.freeze({
      capabilityKey: "getlistpc",
      sideEffecting: false,
      evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
      reasonCode: null,
      enabledGate: null,
      qpsLimit: null,
      timeoutMs: 15_000,
      config: Object.freeze({}),
    }),
    Object.freeze({
      capabilityKey: "getbydataid",
      sideEffecting: false,
      evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
      reasonCode: null,
      enabledGate: null,
      qpsLimit: null,
      timeoutMs: 15_000,
      config: Object.freeze({}),
    }),
    Object.freeze({
      capabilityKey: "getchapterinfo",
      sideEffecting: false,
      evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
      reasonCode: null,
      enabledGate: null,
      qpsLimit: null,
      timeoutMs: 15_000,
      config: Object.freeze({}),
    }),
    Object.freeze({
      capabilityKey: "claimPromo",
      sideEffecting: true,
      evidenceLevel: "BROWSER_OBSERVED",
      reasonCode: "capability_contract_unproven",
      enabledGate: "OWNER_GATE + CONTRACT_FROZEN",
      qpsLimit: null,
      timeoutMs: null,
      config: Object.freeze({}),
    }),
  ]),
});

const AUDIT_ACTION = "moboreader.foundation.register";
const ADVISORY_LOCK_KEY = "cps-novel:moboreader-foundation:v1";
const ALLOWED_CAPABILITY_STATUSES = new Set(["registered_disabled", "enabled"]);

type ChannelRow = { id: string; code: string; name: string; status: string };
type SourceAppRow = { id: string; code: string; name: string; status: string };
type ChannelAppRow = {
  id: string;
  channelId: string;
  sourceAppId: string;
  externalAppId: string;
  projectType: number;
  status: string;
  config: unknown;
};
type CapabilityRow = {
  id: string;
  channelAppId: string;
  capabilityKey: string;
  status: string;
  sideEffecting: boolean;
  evidenceLevel: string;
  reasonCode: string | null;
  enabledGate: string | null;
  qpsLimit: { toString(): string } | string | number | null;
  timeoutMs: number | null;
  config: unknown;
};

export type FoundationSnapshot = {
  channel: ChannelRow | null;
  sourceApp: SourceAppRow | null;
  channelApp: ChannelAppRow | null;
  capabilities: readonly CapabilityRow[];
};

export type FoundationInspection = {
  readonly missing: readonly string[];
  readonly capabilityStatuses: Readonly<Record<string, string | null>>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function drift(entity: string, field: string, expected: unknown, actual: unknown): never {
  throw new MoboreaderFoundationError(
    "metadata_drift",
    `${entity}.${field} metadata drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function expectField(entity: string, field: string, expected: unknown, actual: unknown): void {
  if (stableJson(expected) !== stableJson(actual)) drift(entity, field, expected, actual);
}

/** Pure validation/planning helper used by dry-run and by the locked write path. */
export function inspectFoundationSnapshot(snapshot: FoundationSnapshot): FoundationInspection {
  const missing: string[] = [];
  if (!snapshot.channel) {
    missing.push("channel:moboreader");
  } else {
    expectField("channel:moboreader", "code", MOBOREADER_FOUNDATION.channel.code, snapshot.channel.code);
    expectField("channel:moboreader", "name", MOBOREADER_FOUNDATION.channel.name, snapshot.channel.name);
    expectField("channel:moboreader", "status", MOBOREADER_FOUNDATION.channel.status, snapshot.channel.status);
  }

  if (!snapshot.sourceApp) {
    missing.push("source_app:changdu");
  } else {
    expectField("source_app:changdu", "code", MOBOREADER_FOUNDATION.sourceApp.code, snapshot.sourceApp.code);
    expectField("source_app:changdu", "name", MOBOREADER_FOUNDATION.sourceApp.name, snapshot.sourceApp.name);
    expectField("source_app:changdu", "status", MOBOREADER_FOUNDATION.sourceApp.status, snapshot.sourceApp.status);
  }

  if (!snapshot.channelApp) {
    missing.push("channel_app:moboreader/changdu/moboreader");
  } else {
    if (snapshot.channel) expectField("channel_app", "channelId", snapshot.channel.id, snapshot.channelApp.channelId);
    if (snapshot.sourceApp) expectField("channel_app", "sourceAppId", snapshot.sourceApp.id, snapshot.channelApp.sourceAppId);
    expectField("channel_app", "externalAppId", MOBOREADER_FOUNDATION.channelApp.externalAppId, snapshot.channelApp.externalAppId);
    expectField("channel_app", "projectType", MOBOREADER_FOUNDATION.channelApp.projectType, snapshot.channelApp.projectType);
    expectField("channel_app", "status", MOBOREADER_FOUNDATION.channelApp.status, snapshot.channelApp.status);
    expectField("channel_app", "config", MOBOREADER_FOUNDATION.channelApp.config, snapshot.channelApp.config);
  }

  const capabilityStatuses: Record<string, string | null> = {};
  for (const expected of MOBOREADER_FOUNDATION.capabilities) {
    const actual = snapshot.capabilities.find((row) => row.capabilityKey === expected.capabilityKey);
    capabilityStatuses[expected.capabilityKey] = actual?.status ?? null;
    if (!actual) {
      missing.push(`channel_capability:${expected.capabilityKey}`);
      continue;
    }
    if (!ALLOWED_CAPABILITY_STATUSES.has(actual.status)) {
      drift(`channel_capability:${expected.capabilityKey}`, "status", "registered_disabled|enabled", actual.status);
    }
    if (snapshot.channelApp) expectField(`channel_capability:${expected.capabilityKey}`, "channelAppId", snapshot.channelApp.id, actual.channelAppId);
    expectField(`channel_capability:${expected.capabilityKey}`, "sideEffecting", expected.sideEffecting, actual.sideEffecting);
    expectField(`channel_capability:${expected.capabilityKey}`, "evidenceLevel", expected.evidenceLevel, actual.evidenceLevel);
    expectField(`channel_capability:${expected.capabilityKey}`, "reasonCode", expected.reasonCode, actual.reasonCode);
    expectField(`channel_capability:${expected.capabilityKey}`, "enabledGate", expected.enabledGate, actual.enabledGate);
    expectField(
      `channel_capability:${expected.capabilityKey}`,
      "qpsLimit",
      expected.qpsLimit,
      actual.qpsLimit === null ? null : actual.qpsLimit.toString(),
    );
    expectField(`channel_capability:${expected.capabilityKey}`, "timeoutMs", expected.timeoutMs, actual.timeoutMs);
    expectField(`channel_capability:${expected.capabilityKey}`, "config", expected.config, actual.config);
  }
  return { missing, capabilityStatuses };
}

type FoundationReadClient = {
  channel: { findUnique(args: unknown): Promise<ChannelRow | null> };
  sourceApp: { findUnique(args: unknown): Promise<SourceAppRow | null> };
  channelApp: { findUnique(args: unknown): Promise<ChannelAppRow | null> };
  channelCapability: { findMany(args: unknown): Promise<CapabilityRow[]> };
};

async function loadSnapshot(db: FoundationReadClient): Promise<FoundationSnapshot> {
  const channel = await db.channel.findUnique({ where: { code: MOBOREADER_FOUNDATION.channel.code } });
  const sourceApp = await db.sourceApp.findUnique({ where: { code: MOBOREADER_FOUNDATION.sourceApp.code } });
  const channelApp =
    channel && sourceApp
      ? await db.channelApp.findUnique({
          where: {
            channelId_sourceAppId_externalAppId: {
              channelId: channel.id,
              sourceAppId: sourceApp.id,
              externalAppId: MOBOREADER_FOUNDATION.channelApp.externalAppId,
            },
          },
        })
      : null;
  const capabilities = channelApp
    ? await db.channelCapability.findMany({ where: { channelAppId: channelApp.id } })
    : [];
  return { channel, sourceApp, channelApp, capabilities };
}

export type RegisterFoundationOptions = {
  readonly apply: boolean;
  readonly operatorId: string;
  readonly requestId: string;
  readonly reason: string;
};

export type RegisterFoundationReport = {
  readonly mode: "dry-run" | "apply";
  readonly wrote: boolean;
  readonly replayed: boolean;
  readonly missing: readonly string[];
  readonly created: readonly string[];
  readonly capabilityStatuses: Readonly<Record<string, string | null>>;
  readonly auditId: string | null;
};

function boundedRequired(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new MoboreaderFoundationError("invalid_arguments", `${name} must contain 1-${max} characters`);
  }
  return normalized;
}

export function validateOptions(options: RegisterFoundationOptions): RegisterFoundationOptions {
  return {
    ...options,
    operatorId: boundedRequired("operator", options.operatorId, 128),
    requestId: boundedRequired("request-id", options.requestId, 160),
    reason: boundedRequired("reason", options.reason, 1000),
  };
}

type FoundationWriteClient = FoundationReadClient & {
  channel: FoundationReadClient["channel"] & { create(args: unknown): Promise<ChannelRow> };
  sourceApp: FoundationReadClient["sourceApp"] & { create(args: unknown): Promise<SourceAppRow> };
  channelApp: FoundationReadClient["channelApp"] & { create(args: unknown): Promise<ChannelAppRow> };
  channelCapability: FoundationReadClient["channelCapability"] & { create(args: unknown): Promise<CapabilityRow> };
  operationAudit: {
    findFirst(args: unknown): Promise<{
      id: bigint;
      actorId: string | null;
      reason: string | null;
      entityId: string;
    } | null>;
    create(args: unknown): Promise<{ id: bigint }>;
  };
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
};

type FoundationRootClient = FoundationReadClient & {
  $transaction<T>(callback: (tx: FoundationWriteClient) => Promise<T>): Promise<T>;
};

function auditSnapshot(channelAppId: string, statuses: Readonly<Record<string, string | null>>) {
  return {
    channelCode: MOBOREADER_FOUNDATION.channel.code,
    sourceAppCode: MOBOREADER_FOUNDATION.sourceApp.code,
    channelAppId,
    externalAppId: MOBOREADER_FOUNDATION.channelApp.externalAppId,
    projectType: MOBOREADER_FOUNDATION.channelApp.projectType,
    capabilityStatuses: statuses,
  };
}

export async function registerMoboreaderFoundation(
  db: FoundationRootClient,
  rawOptions: RegisterFoundationOptions,
): Promise<RegisterFoundationReport> {
  const options = validateOptions(rawOptions);
  if (!options.apply) {
    const inspection = inspectFoundationSnapshot(await loadSnapshot(db));
    return {
      mode: "dry-run",
      wrote: false,
      replayed: false,
      missing: inspection.missing,
      created: [],
      capabilityStatuses: inspection.capabilityStatuses,
      auditId: null,
    };
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ADVISORY_LOCK_KEY}, 0))`;
    const beforeSnapshot = await loadSnapshot(tx);
    const before = inspectFoundationSnapshot(beforeSnapshot);
    const replay = await tx.operationAudit.findFirst({
      where: { actorType: "system", action: AUDIT_ACTION, requestId: options.requestId },
    });
    if (replay) {
      if (replay.actorId !== options.operatorId || replay.reason !== options.reason) {
        throw new MoboreaderFoundationError(
          "request_replay_conflict",
          "request-id was already committed with a different operator or reason",
        );
      }
      if (before.missing.length > 0) {
        throw new MoboreaderFoundationError(
          "incomplete_replay",
          `request-id was audited but foundation is incomplete: ${before.missing.join(", ")}`,
        );
      }
      return {
        mode: "apply",
        wrote: false,
        replayed: true,
        missing: [],
        created: [],
        capabilityStatuses: before.capabilityStatuses,
        auditId: replay.id.toString(),
      };
    }

    const created: string[] = [];
    let channel = beforeSnapshot.channel;
    if (!channel) {
      channel = await tx.channel.create({ data: MOBOREADER_FOUNDATION.channel });
      created.push("channel:moboreader");
    }
    let sourceApp = beforeSnapshot.sourceApp;
    if (!sourceApp) {
      sourceApp = await tx.sourceApp.create({ data: MOBOREADER_FOUNDATION.sourceApp });
      created.push("source_app:changdu");
    }
    let channelApp = beforeSnapshot.channelApp;
    if (!channelApp) {
      channelApp = await tx.channelApp.create({
        data: {
          channelId: channel.id,
          sourceAppId: sourceApp.id,
          ...MOBOREADER_FOUNDATION.channelApp,
        },
      });
      created.push("channel_app:moboreader/changdu/moboreader");
    }

    const existingCapabilities = new Map(beforeSnapshot.capabilities.map((row) => [row.capabilityKey, row]));
    for (const capability of MOBOREADER_FOUNDATION.capabilities) {
      if (existingCapabilities.has(capability.capabilityKey)) continue;
      await tx.channelCapability.create({
        data: {
          channelAppId: channelApp.id,
          ...capability,
          status: "registered_disabled",
          config: capability.config as Prisma.InputJsonValue,
        },
      });
      created.push(`channel_capability:${capability.capabilityKey}`);
    }

    const afterSnapshot = await loadSnapshot(tx);
    const after = inspectFoundationSnapshot(afterSnapshot);
    if (after.missing.length > 0) {
      throw new MoboreaderFoundationError("metadata_drift", `foundation remained incomplete: ${after.missing.join(", ")}`);
    }
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: AUDIT_ACTION,
        entityType: "ChannelApp",
        entityId: channelApp.id,
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: auditSnapshot(channelApp.id, before.capabilityStatuses),
        afterSnapshot: auditSnapshot(channelApp.id, after.capabilityStatuses),
      },
    });
    return {
      mode: "apply",
      wrote: created.length > 0,
      replayed: false,
      missing: before.missing,
      created,
      capabilityStatuses: after.capabilityStatuses,
      auditId: audit.id.toString(),
    };
  });
}

function valueAfter(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new MoboreaderFoundationError("invalid_arguments", `${name} requires a value`);
  }
  return value;
}

export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv): RegisterFoundationOptions {
  return validateOptions({
    apply: argv.includes("--apply"),
    operatorId: env.MOBOREADER_FOUNDATION_OPERATOR ?? "",
    requestId: valueAfter(argv, "--request-id") ?? "",
    reason: valueAfter(argv, "--reason") ?? "",
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await registerMoboreaderFoundation(prisma as unknown as FoundationRootClient, options);
    if (report.mode === "dry-run") console.log("[DRY RUN - no changes written; pass --apply to write]");
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
