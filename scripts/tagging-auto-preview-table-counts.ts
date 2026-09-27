/**
 * Test-only helper for `scripts/run-tagging-auto-preview-postgres-
 * verification.sh`: prints `{ "<table>": <row count>, ... }` for every base
 * table in the `public` schema, as JSON on stdout. Used to snapshot row
 * counts before and after running `scripts/tagging-auto-preview.ts` --  an
 * identical before/after snapshot (checked by the shell script, not here) is
 * the zero-write proof for that run. Never runs against a real database;
 * only against the disposable, one-off Postgres container that verification
 * script creates.
 *
 * Table names come from `information_schema.tables` in the connected
 * database, not from any external input, so building one `SELECT count(*)`
 * statement per discovered table name is safe.
 */
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const counts: Record<string, number> = {};
    for (const { table_name: tableName } of tables) {
      const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT count(*)::bigint AS c FROM "${tableName}"`);
      counts[tableName] = Number(rows[0]?.c ?? 0n);
    }
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 64;
});
