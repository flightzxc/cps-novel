/**
 * P0-S6: audited CLI entry point for flipping a `ChannelCapability`'s
 * status between `registered_disabled` and `enabled`.
 *
 * Background: `src/server/channel-capability/service.ts` implements the
 * actual write (transaction + `OperationAudit`, "证据先于启用" enforced in
 * the signature). This script is the only caller today — there is no admin
 * UI for this yet ("受审计脚本先行，管理界面后补", Owner decision). It runs
 * with `actor.type === "system"`, which bypasses the admin session/2FA
 * check (there is no browser session for a terminal script) but bypasses
 * NOTHING else: `--reason` and (for `--to enabled`) `--evidence` are still
 * mandatory, and every applied change still gets an `OperationAudit` row.
 *
 * Defaults to dry-run: without `--apply`, this prints the current status and
 * the change that *would* happen and performs zero writes — it does not even
 * call `setChannelCapabilityStatus` (see `runCli` below).
 *
 * Usage:
 *   CHANNEL_CAPABILITY_OPERATOR=<your-name> \
 *     tsx scripts/set-channel-capability-status.ts \
 *       --channel-app <channelAppId> --capability <capabilityKey> \
 *       --to enabled --reason "..." --evidence "smoke-report-2026-08-20.md" \
 *       [--apply]
 *
 * `CHANNEL_CAPABILITY_OPERATOR` identifies who is running this audited
 * script and is required even for a dry-run preview — this is a break-glass
 * tool, not an anonymous one. Missing it refuses to run at all.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  ChannelCapabilityStatusError,
  setChannelCapabilityStatus,
  validateChannelCapabilityStatusRequest,
} from "../src/server/channel-capability/service";

export class CliArgumentError extends Error {}

/**
 * Reads the value following a `--flag` token. Returns `undefined` only when
 * the flag itself is absent from `argv` — a genuinely missing *optional*
 * flag (e.g. `--evidence` when disabling) must stay silent so the caller's
 * own "is required" checks (or lack thereof) decide what that means.
 *
 * P0-S10 (2026-08-20): if the flag *is* present but the following token is
 * missing (end of argv) or itself looks like another flag (starts with
 * `--`), this throws instead of returning that token as the value. Before
 * this fix, `--evidence --apply` silently parsed as
 * `evidenceRef = "--apply"` *and* `apply = true` (the latter from the
 * separate `argv.includes("--apply")` check below) — a single dropped
 * argument would both hand the write path a nonsense evidence string and
 * still flip `--apply` on, letting one typo defeat "证据先于启用"
 * (evidence-precedes-enablement,
 * `docs/governance/database-governance.md` §1) without any error at all.
 * Treating a `--`-shaped "value" as missing-and-erroring closes that hole;
 * the trade-off (a real value can never itself start with `--`) is
 * accepted deliberately for this operator-facing break-glass tool.
 */
function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    const got = value === undefined ? "nothing (it was the last argument)" : `another flag ("${value}")`;
    throw new CliArgumentError(`${name} requires a value, but got ${got} — did an argument get dropped?`);
  }
  return value;
}

export type CliOptions = {
  readonly channelAppId: string;
  readonly capabilityKey: string;
  readonly targetStatus: string;
  readonly reason: string;
  readonly evidenceRef: string | undefined;
  readonly apply: boolean;
  readonly operatorId: string;
};

/**
 * Pure parsing of argv + env into validated CLI options — no I/O, so it is
 * unit-testable without a database. Deliberately requires
 * `CHANNEL_CAPABILITY_OPERATOR` before parsing anything else: an unnamed
 * operator is refused even for a dry-run preview.
 */
export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  const operatorId = (env.CHANNEL_CAPABILITY_OPERATOR ?? "").trim();
  if (!operatorId) {
    throw new CliArgumentError(
      "CHANNEL_CAPABILITY_OPERATOR is required (identifies who is running this audited script) — refusing to run without it",
    );
  }
  const channelAppId = arg(argv, "--channel-app");
  if (!channelAppId) throw new CliArgumentError("--channel-app <channelAppId> is required");
  const capabilityKey = arg(argv, "--capability");
  if (!capabilityKey) throw new CliArgumentError("--capability <capabilityKey> is required");
  const targetStatus = arg(argv, "--to");
  if (!targetStatus) throw new CliArgumentError("--to <registered_disabled|enabled> is required");
  const reason = arg(argv, "--reason");
  if (!reason) throw new CliArgumentError("--reason <text> is required");
  const evidenceRef = arg(argv, "--evidence");
  const apply = argv.includes("--apply");
  return { channelAppId, capabilityKey, targetStatus, reason, evidenceRef, apply, operatorId };
}

export type CliReport =
  | {
      readonly mode: "dry-run";
      readonly channelAppId: string;
      readonly capabilityKey: string;
      readonly currentStatus: string;
      readonly proposedStatus: string;
      readonly reason: string;
      readonly evidenceRef: string | null;
    }
  | {
      readonly mode: "apply";
      readonly channelAppId: string;
      readonly capabilityKey: string;
      readonly beforeStatus: string;
      readonly afterStatus: string;
      readonly wrote: boolean;
      readonly auditId: string;
    };

type CapabilityLookupClient = {
  channelCapability: {
    findUnique: (args: {
      where: { channelAppId_capabilityKey: { channelAppId: string; capabilityKey: string } };
    }) => Promise<{ channelAppId: string; capabilityKey: string; status: string } | null>;
  };
};

/**
 * Orchestrates either the read-only dry-run preview or the audited
 * `--apply` write, against a Prisma-shaped `db`. Takes `db` as a parameter
 * (rather than constructing its own `PrismaClient`) so tests can substitute
 * a fake; `main()` below is the only real caller and always passes a real
 * client.
 *
 * The dry-run branch never calls `setChannelCapabilityStatus` — it only
 * reads — so "zero writes without `--apply`" holds structurally, not just
 * by convention.
 */
export async function runCli(
  db: CapabilityLookupClient & Parameters<typeof setChannelCapabilityStatus>[0],
  options: CliOptions,
  requestId: string,
): Promise<CliReport> {
  // Same validation the write path enforces, run first and unconditionally
  // — a dry-run reliably previews whether `--apply` would be rejected on
  // reason/evidence/target-status grounds, before anything touches the
  // database.
  const validated = validateChannelCapabilityStatusRequest({
    targetStatus: options.targetStatus,
    reason: options.reason,
    evidenceRef: options.evidenceRef,
  });

  if (!options.apply) {
    const capability = await db.channelCapability.findUnique({
      where: {
        channelAppId_capabilityKey: { channelAppId: options.channelAppId, capabilityKey: options.capabilityKey },
      },
    });
    if (!capability) {
      throw new ChannelCapabilityStatusError(
        "capability_not_found",
        `No registered capability for channelAppId="${options.channelAppId}" capabilityKey="${options.capabilityKey}"`,
      );
    }
    return {
      mode: "dry-run",
      channelAppId: capability.channelAppId,
      capabilityKey: capability.capabilityKey,
      currentStatus: capability.status,
      proposedStatus: validated.targetStatus,
      reason: validated.reason,
      evidenceRef: validated.evidenceRef,
    };
  }

  const result = await setChannelCapabilityStatus(db, {
    channelAppId: options.channelAppId,
    capabilityKey: options.capabilityKey,
    targetStatus: options.targetStatus,
    reason: options.reason,
    evidenceRef: options.evidenceRef,
    requestId,
    actor: { type: "system", actorId: options.operatorId },
  });
  return {
    mode: "apply",
    channelAppId: result.channelAppId,
    capabilityKey: result.capabilityKey,
    beforeStatus: result.beforeStatus,
    afterStatus: result.afterStatus,
    wrote: result.wrote,
    auditId: result.auditId,
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const requestId = randomUUID();
    const report = await runCli(prisma, options, requestId);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply to write]");
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
