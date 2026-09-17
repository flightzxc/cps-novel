/**
 * Phase B entity fix -- single-transaction correction (Owner-authorized,
 * 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二: "数据订正已获
 * Owner 授权，无需再请示"). Swaps `channel`/`source_app` code+name so the
 * production data matches the corrected entity semantics:
 *
 *   channel:     moboreader/MoboReader  -> changdu/Changdu
 *   source_app:  changdu/Changdu        -> moboreader/MoboReader
 *
 * Both rows are resolved by current code, rejecting on 0 or >1 matches; the
 * actual `UPDATE` statements are `WHERE id = $resolvedId`. Everything runs
 * in one transaction with a before/after snapshot comparison -- see
 * `runFoundationSwap` in `./moboreader-foundation-swap.ts` for the exact
 * guard sequence. This script never touches any other table.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/entity-fix/moboreader-foundation-swap-apply.ts --confirm
 *
 * `--confirm` is required and is the only guard this CLI adds on top of the
 * transactional one in the shared module -- it exists purely to stop an
 * operator from running this file the way they might run the dry-run
 * sibling, by habit, without reading what it does.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { applyFoundationSwap } from "./moboreader-foundation-swap";

async function main(): Promise<void> {
  if (!process.argv.slice(2).includes("--confirm")) {
    console.error("Refusing to run without --confirm. This writes to channel/source_app. Re-run with --confirm.");
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const report = await applyFoundationSwap(prisma);
    console.log("[APPLY - transaction committed]");
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
