/** Verbatim fixture reuse from baseline 58cdb94d:
 * tests/integration/tasks/promo-claim-batch-control-postgres.test.ts:158-184.
 * Existing helper is private, so archived unchanged here for the ops fixture.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

async function seedBooks(db: PrismaClient, channelAppId: string, count: number, prefix: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at
    )
    SELECT gen_random_uuid(), ${channelAppId}::uuid, ${prefix} || '-' || n::text, 'en', 'en',
           ${prefix} || ' title ' || n::text, 'promo claim batch control fixture', 'pending',
           jsonb_build_object('fixture', ${prefix}, 'agencyId', 3366, 'seriesId', ${prefix} || '-series-' || n::text, 'language', 3),
           transaction_timestamp()
    FROM generate_series(1, ${count}) AS n
    RETURNING id
  `);
  const ids = rows.map((row) => row.id);
  for (const id of ids) {
    const novelId = randomUUID();
    const slug = `pcbc-${randomUUID()}`;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      VALUES (${novelId}::uuid, ${slug}, ${`${prefix} novel`}, 'promo claim batch control fixture', 'en', ${slug}, transaction_timestamp(), transaction_timestamp())
    `);
    await db.$executeRaw(Prisma.sql`
      UPDATE novel_source_item SET novel_id = ${novelId}::uuid, status = 'linked' WHERE id = ${id}::uuid
    `);
  }
  return ids;
}

export { seedBooks };
