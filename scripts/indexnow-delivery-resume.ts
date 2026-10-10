/**
 * Manually resumes IndexNow delivery after the breaker opened (B-41).
 *
 * The breaker opens on any HTTP 400/403/422 (see
 * `src/lib/indexnow/delivery-control.ts`) and only a human closes it, after
 * reading `scripts/indexnow-status.ts`. Closing = appending a
 * `indexnow.delivery.breaker_resume` event to `operation_audit` (who, when,
 * why) inside a transaction that holds the control lock; it refuses when the
 * breaker is not open (`breaker_not_open`) or a request is in flight
 * (`in_flight_requests_present`).
 *
 * Three kinds of recovery exist and only the middle one is this command:
 *   retry_wait rows  → automatic (backoff);
 *   breaker          → this command;
 *   dead_letter rows → stop and hand to the Owner (nothing here touches them).
 *
 * Usage:
 *   tsx scripts/indexnow-delivery-resume.ts --help
 *   tsx scripts/indexnow-delivery-resume.ts --actor-id <uuid> --reason "<text>" [--request-id <uuid>]
 *       prints the current state and the audit that WOULD be written
 *   tsx scripts/indexnow-delivery-resume.ts --actor-id <uuid> --reason "<text>" [--request-id <uuid>] --confirm
 *       writes the resume event
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  IndexNowResumeRefusedError,
  getIndexNowDeliveryControlState,
  resumeIndexNowDelivery,
  validateResumeInput,
} from "../src/lib/indexnow/delivery-control";
import { describeControl, jsonSafe } from "./indexnow-status";

export const RESUME_USAGE = `Usage:
  tsx scripts/indexnow-delivery-resume.ts --help
  tsx scripts/indexnow-delivery-resume.ts --actor-id <uuid> --reason "<text>" [--request-id <uuid>] [--confirm]

Without --confirm: prints the current control state and the audit record that would be written. Nothing is written.
With --confirm: appends the breaker_resume event. Refused with breaker_not_open / in_flight_requests_present.
--request-id defaults to a fresh UUID (replaying a request id is refused: request_id_reused).
`;

export interface ResumeCliArgs {
  help: boolean;
  actorId?: string;
  reason?: string;
  requestId?: string;
  confirm: boolean;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseResumeArgs(argv: readonly string[] = process.argv.slice(2)): ResumeCliArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true, confirm: false };
  const actorId = flagValue(argv, "--actor-id");
  const reason = flagValue(argv, "--reason");
  if (!actorId) throw new Error("--actor-id <uuid> is required");
  if (!reason) throw new Error('--reason "<text>" is required');
  return { help: false, actorId, reason, requestId: flagValue(argv, "--request-id"), confirm: argv.includes("--confirm") };
}

async function main(): Promise<void> {
  const args = parseResumeArgs();
  if (args.help) {
    console.log(RESUME_USAGE);
    return;
  }
  // Validate shape before touching the database.
  const valid = validateResumeInput({ actorId: args.actorId!, reason: args.reason!, requestId: args.requestId ?? randomUUID() });

  const prisma = new PrismaClient();
  try {
    if (!args.confirm) {
      const control = await getIndexNowDeliveryControlState(prisma);
      console.log(
        JSON.stringify(
          jsonSafe({
            mode: "dry-run",
            control: describeControl(control),
            wouldWrite: {
              actorType: "admin",
              actorId: valid.actorId,
              action: "indexnow.delivery.breaker_resume",
              entityType: "indexnow_delivery",
              entityId: "breaker",
              requestId: valid.requestId,
              reason: valid.reason,
              note: control.breaker.open
                ? "breaker is open: --confirm would close it (unless a request is in flight)"
                : "breaker is NOT open: --confirm would be refused with breaker_not_open",
            },
          }),
          null,
          2,
        ),
      );
      return;
    }
    try {
      const result = await resumeIndexNowDelivery(prisma, valid);
      console.log(JSON.stringify(jsonSafe({ resumed: true, ...result }), null, 2));
    } catch (error) {
      if (error instanceof IndexNowResumeRefusedError) {
        console.log(JSON.stringify({ resumed: false, refused: error.code }, null, 2));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
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
