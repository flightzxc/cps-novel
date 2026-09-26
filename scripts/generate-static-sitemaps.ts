/** Run with npx tsx scripts/generate-static-sitemaps.ts --dry-run or --apply --reason TEXT.
 * Apply enqueues only; the existing worker is the sole publisher. See docs/operations/sitemap-manual.md. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { SITE_LOCALES } from "../src/lib/locale/locale-canonical";
import { createSitemapFamilyBuilder, SITEMAP_TYPES } from "../src/lib/seo/sitemap";
import { requestAuditedSitemapRefresh } from "../src/server/sitemap-admin/service";

export function parseSitemapArgs(argv: string[]) {
  let apply = false;
  let dryRun = false;
  let reason = "";
  let requestId = randomUUID() as string;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--reason" && argv[i + 1]) reason = argv[++i];
    else if (argv[i] === "--request-id" && argv[i + 1]) requestId = argv[++i];
    else throw new Error("Usage: --dry-run | --apply --reason TEXT [--request-id ID]");
  }
  if (apply && dryRun) throw new Error("Choose --dry-run or --apply");
  if (apply && (!reason.trim() || reason.trim().length > 500)) throw new Error("--apply requires --reason (1-500 characters)");
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(requestId)) throw new Error("Invalid request id");
  return { apply, reason, requestId };
}

export async function runSitemapCli(db: PrismaClient, args: ReturnType<typeof parseSitemapArgs>, env = process.env) {
  if (!args.apply) {
    // PostgreSQL itself rejects accidental writes in the full calculation path.
    const counts = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const build = createSitemapFamilyBuilder(tx);
      const counts: Record<string, number> = {};
      for (const locale of SITE_LOCALES) {
        counts[locale] = 0;
        for (const type of SITEMAP_TYPES) {
          for (const file of await build({ locale, type })) counts[locale] += file.entries.length;
        }
      }
      return counts;
    }, { timeout: 120_000 });
    return { status: "dry_run", counts, urlCount: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
  const [role] = await db.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`;
  if (role?.role !== "web_app") throw new Error("Apply requires the web_app database role");
  return requestAuditedSitemapRefresh({ actorType: "system", actorId: "sitemap-cli", requestId: args.requestId, reason: args.reason }, db, env);
}

async function main() {
  const args = parseSitemapArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const result = await runSitemapCli(db, args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "disabled") process.exitCode = 2;
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("sitemap_command_failed: check arguments, role, database and SITE_URL configuration"); process.exitCode = 1; });
}
