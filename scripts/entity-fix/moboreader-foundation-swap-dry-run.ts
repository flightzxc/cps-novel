/**
 * Phase B entity fix -- read-only dry-run.
 *
 * Prints the current `channel`/`source_app` rows (id/code/name), the target
 * values for the requested direction, whether the database is in the
 * expected pre-state to run it, and every foreign-key table's affected row
 * count (`channel_account`, `channel_app`, `novel_source_item`,
 * `promo_link`, and the three task-family tables). Performs zero writes --
 * see `施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §二 step 1.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/entity-fix/moboreader-foundation-swap-dry-run.ts [--direction apply|rollback]
 *
 * Defaults to `--direction apply` (moboreader/changdu -> the corrected
 * values). Never writes to the database regardless of direction.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { planFoundationSwap, type FoundationSwapDirection } from "./moboreader-foundation-swap";

export function parseDirection(argv: readonly string[]): FoundationSwapDirection {
  const index = argv.indexOf("--direction");
  if (index < 0) return "apply";
  const value = argv[index + 1];
  if (value !== "apply" && value !== "rollback") {
    throw new Error(`--direction must be "apply" or "rollback", got: ${value ?? "(missing)"}`);
  }
  return value;
}

async function main(): Promise<void> {
  const direction = parseDirection(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const plan = await planFoundationSwap(prisma, direction);
    console.log("[DRY RUN - read-only, no changes written]");
    console.log(JSON.stringify(plan, null, 2));
    if (!plan.readyToRun) {
      console.log(
        `NOT READY: channel.code="${plan.channel.code}" sourceApp.code="${plan.sourceApp.code}" do not match the expected pre-state for direction="${direction}".`,
      );
      process.exitCode = 1;
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
