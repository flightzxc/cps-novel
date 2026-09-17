/**
 * Phase B entity fix -- rollback. Reverses `moboreader-foundation-swap-
 * apply.ts`: swaps `channel`/`source_app` code+name back to the pre-fix
 * values, with the exact same guard sequence (resolve-by-code with 0/>1
 * rejection, single transaction, before/after snapshot comparison) as the
 * apply direction -- see `runFoundationSwap` in
 * `./moboreader-foundation-swap.ts`. This script never touches any other
 * table.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/entity-fix/moboreader-foundation-swap-rollback.ts --confirm
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { rollbackFoundationSwap } from "./moboreader-foundation-swap";

async function main(): Promise<void> {
  if (!process.argv.slice(2).includes("--confirm")) {
    console.error("Refusing to run without --confirm. This writes to channel/source_app. Re-run with --confirm.");
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const report = await rollbackFoundationSwap(prisma);
    console.log("[ROLLBACK - transaction committed]");
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
