import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export type CatalogFoundation = Readonly<{
  actorId: string;
  channels: readonly Readonly<{ channelId: string; sourceAppId: string; channelAppId: string; accountId: string; code: string }>[];
}>;

export async function assertDisposableCatalogDatabase(db: PrismaClient): Promise<void> {
  const [database] = await db.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!database.name.startsWith("cps_novel_catalog_batch_")) {
    throw new Error(`Refusing catalog-batch setup against ${database.name}`);
  }
  if (!database.version.startsWith("16.14")) {
    throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
  }
}

export async function truncateCatalogDatabase(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

export async function seedCatalogFoundation(db: PrismaClient, channelCount = 2): Promise<CatalogFoundation> {
  const actorId = `catalog-pg-${randomUUID()}`;
  const channels: CatalogFoundation["channels"][number][] = [];
  for (let index = 0; index < channelCount; index += 1) {
    const channelId = randomUUID();
    const sourceAppId = randomUUID();
    const channelAppId = randomUUID();
    const accountId = randomUUID();
    const code = `catalog-pg-${index}-${randomUUID()}`;
    await db.channel.create({ data: { id: channelId, code, name: `Catalog PG ${index}` } });
    await db.sourceApp.create({ data: { id: sourceAppId, code: `${code}-source`, name: `Catalog Source ${index}` } });
    await db.channelApp.create({ data: {
      id: channelAppId, channelId, sourceAppId, externalAppId: `${code}-app`, projectType: index + 1,
    } });
    await db.channelAccount.create({ data: {
      id: accountId, channelId, businessId: `${code}-account`, accountName: `Catalog Account ${index}`,
    } });
    await db.channelAccountCredential.create({ data: {
      channelAccountId: accountId,
      encryptedSecret: Buffer.from(`catalog-pg-secret-${index}`),
      keyVersion: 1,
      secretFingerprint: `catalog-pg-${randomUUID()}`,
      fingerprintPrefix: randomUUID().replaceAll("-", "").slice(0, 12),
      status: "active",
    } });
    channels.push({ channelId, sourceAppId, channelAppId, accountId, code });
  }
  return { actorId, channels };
}

export async function seedCatalogRows(
  db: PrismaClient,
  input: {
    channelAppId: string;
    count: number;
    prefix: string;
    status?: "pending" | "linked" | "ignored" | "stale";
    sourceLocale?: string | null;
  },
): Promise<string[]> {
  if (input.count === 0) return [];
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id,
      channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at
    )
    SELECT
      gen_random_uuid(),
      ${input.channelAppId}::uuid,
      ${input.prefix} || '-' || n::text,
      'en',
      ${input.sourceLocale === undefined ? "en" : input.sourceLocale},
      ${input.prefix} || ' title ' || lpad(n::text, 6, '0'),
      'catalog postgres regression',
      ${input.status ?? "pending"},
      jsonb_build_object('fixture', ${input.prefix}, 'ordinal', n),
      transaction_timestamp()
    FROM generate_series(1, ${input.count}) AS n
    RETURNING id
  `);
  return rows.map((row) => row.id);
}

export async function seedActiveTemplate(db: PrismaClient, locale = "en"): Promise<string> {
  const key = `catalog-pg-template-${randomUUID()}`;
  await db.articleTemplate.create({ data: {
    templateKey: key, templateName: "Catalog PG template", locale, version: 1,
    status: "active", applicableArticleType: "novel_article", bodyTemplate: "<article>{novel_title}</article>",
    contentTemplate: [{ type: "text", value: "{novel_title}" }],
    seoTemplate: { title: "{novel_title}", description: "{novel_description}" },
  } });
  return key;
}
