/**
 * v0.6.0 PlotNovel 剧场真实库用例的共享夹具。
 *
 * 只在 `scripts/run-plotnovel-theater-postgres-verification.sh` 起的一次性 postgres:16.14 上运行：
 * 角色是真实的 migration_owner / web_app / worker_app / scheduler_app / analyst_ro，权限是真实的
 * infra/postgres/grants.sql——单测测不出角色权限，这就是这套用例存在的原因（历史上两次同款事故）。
 */
import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";

import { buildPromoLinkIdempotencyKey } from "@/lib/tasks/promo-link-claim";

import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";

export const enabled = process.env.PLOTNOVEL_DATABASE_TEST === "1";

function requiredUrl(name: string): string | undefined {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value;
}

export const owner = new PrismaClient({ datasourceUrl: requiredUrl("PLOTNOVEL_OWNER_DATABASE_URL") });
export const web = new PrismaClient({ datasourceUrl: requiredUrl("PLOTNOVEL_WEB_DATABASE_URL") });
export const worker = new PrismaClient({ datasourceUrl: requiredUrl("PLOTNOVEL_WORKER_DATABASE_URL") });
export const scheduler = new PrismaClient({ datasourceUrl: requiredUrl("PLOTNOVEL_SCHEDULER_DATABASE_URL") });
export const analyst = new PrismaClient({ datasourceUrl: requiredUrl("PLOTNOVEL_ANALYST_DATABASE_URL") });

export const ids = {
  channel: "06000000-0000-4000-8000-000000000001",
  moboSourceApp: "06000000-0000-4000-8000-000000000002",
  plotSourceApp: "06000000-0000-4000-8000-000000000003",
  moboApp: "06000000-0000-4000-8000-000000000004",
  plotApp: "06000000-0000-4000-8000-000000000005",
  account: "06000000-0000-4000-8000-000000000006",
  credential: "06000000-0000-4000-8000-000000000007",
} as const;

export const MOBO_AGENCY = "3366";
export const PLOT_AGENCY = "1351";

export const PLOT_CONFIG: Prisma.InputJsonObject = {
  promoMode: "code",
  agencyIds: [PLOT_AGENCY],
  appDisplayName: "PlotNovel",
  codeModeLocales: ["en"],
  appStoreUrl: "https://apps.apple.com/app/plotnovel/id123",
  googlePlayUrl: "https://play.google.com/store/apps/details?id=com.plotnovel",
};

export async function assertDisposableDatabase(): Promise<void> {
  const [database] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!database.name.startsWith("cps_novel_plotnovel_")) throw new Error(`Refusing PlotNovel tests against ${database.name}`);
  if (!database.version.startsWith("16.")) throw new Error(`PostgreSQL 16 required, got ${database.version}`);
}

export async function truncateDatabase(): Promise<void> {
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

export type SeedOptions = {
  /** PlotNovel 剧场的状态；默认 active。`registered_disabled` = 刚登记、还没打开。 */
  readonly plotStatus?: "active" | "registered_disabled";
  readonly plotConfig?: Prisma.InputJsonObject;
  readonly moboConfig?: Prisma.InputJsonObject;
  readonly withCapabilities?: boolean;
};

/** 渠道 + 两个剧场 + 渠道账号与凭据（目录扫描 / 领取需要）。 */
export async function seedTheaters(options: SeedOptions = {}): Promise<void> {
  await owner.channel.create({ data: { id: ids.channel, code: "changdu", name: "Changdu" } });
  await owner.sourceApp.create({ data: { id: ids.moboSourceApp, code: "moboreader", name: "MoboReader" } });
  await owner.sourceApp.create({ data: { id: ids.plotSourceApp, code: "plotnovel", name: "PlotNovel" } });
  await owner.channelApp.create({
    data: {
      id: ids.moboApp, channelId: ids.channel, sourceAppId: ids.moboSourceApp, externalAppId: "moboreader",
      projectType: 1, status: "active", config: options.moboConfig ?? { promoMode: "link", agencyIds: [MOBO_AGENCY] },
    },
  });
  await owner.channelApp.create({
    data: {
      id: ids.plotApp, channelId: ids.channel, sourceAppId: ids.plotSourceApp, externalAppId: "plotnovel",
      projectType: 1, status: options.plotStatus ?? "active", config: options.plotConfig ?? PLOT_CONFIG,
    },
  });
  if (options.withCapabilities !== false) {
    for (const appId of [ids.moboApp, ids.plotApp]) {
      for (const capabilityKey of ["getlistpc", "getbydataid", "getchapterinfo"]) {
        await owner.channelCapability.create({
          data: {
            channelAppId: appId, capabilityKey, status: "enabled", sideEffecting: false,
            evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
          },
        });
      }
    }
  }
  await owner.channelAccount.create({
    data: { id: ids.account, channelId: ids.channel, businessId: "plotnovel-account", accountName: "PlotNovel test" },
  });
  await owner.channelAccountCredential.create({
    data: {
      id: ids.credential,
      channelAccountId: ids.account,
      encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("test-jwt", ids.account, ids.credential, 1)),
      keyVersion: 1,
      secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`,
      fingerprintPrefix: "aaaaaaaaaaaa",
      status: "active",
    },
  });
}

export type SeedBook = {
  readonly appId: string;
  readonly externalBookId: string;
  readonly title: string;
  readonly locale?: string;
  readonly agencyId?: string | null;
  readonly languageCode?: string;
  readonly languageName?: string;
  /** 绑定小说（status linked）才能有推广链接。默认绑定。 */
  readonly linked?: boolean;
  readonly sourceStatus?: string;
};

/** 一本书：小说 + 书目（可选推广链接另用 `seedPromo`）。 */
export async function seedBook(book: SeedBook) {
  const locale = book.locale ?? "en";
  const linked = book.linked !== false;
  const novel = linked
    ? await owner.novel.create({
        data: {
          businessId: `biz-${book.externalBookId}-${randomUUID().slice(0, 8)}`,
          title: book.title,
          titleNormalized: book.title.toLowerCase(),
          description: `Description of ${book.title}`,
          coverUrl: `https://img.example/${book.externalBookId}.jpg`,
          locale,
          slug: `slug-${book.externalBookId}-${randomUUID().slice(0, 6)}`,
          status: "draft",
          totalChapterCount: 10,
        },
      })
    : null;
  const languageCode = book.languageCode ?? "3";
  const languageName = book.languageName ?? "English";
  const source = await owner.novelSourceItem.create({
    data: {
      channelAppId: book.appId,
      novelId: novel?.id ?? null,
      externalBookId: book.externalBookId,
      sourceLanguageCode: languageCode,
      sourceLanguageName: languageName,
      sourceLocale: locale,
      rawLanguageScope: JSON.stringify(["RAW_LANGUAGE_SCOPE_V1", languageCode, languageName]),
      title: book.title,
      description: `Description of ${book.title}`,
      totalChapterCount: 10,
      externalAgencyId: book.agencyId === undefined ? null : book.agencyId,
      status: book.sourceStatus ?? (linked ? "linked" : "pending"),
      rawPayload: {
        id: book.externalBookId,
        agencyId: book.agencyId ?? null,
        seriesId: `series-${book.externalBookId}`,
        language: languageCode,
        languageName,
        projectType: 1,
        __boundary: "approved_raw_evidence",
      },
    },
  });
  return { novel, source };
}

export type SeedPromo = {
  readonly appId: string;
  readonly novelId: string;
  readonly sourceId: string;
  readonly status?: string;
  readonly upstreamCode?: string | null;
  readonly webUrl?: string | null;
  readonly appUrl?: string | null;
  readonly publicRedirectCode?: string;
  readonly offerType?: string;
  readonly fetchedAt?: Date | null;
};

/** 一条推广链接；`idempotency_key` 用真实公式（含剧场编号）——改挂脚本必须重算它。 */
export async function seedPromo(promo: SeedPromo) {
  const offerType = promo.offerType ?? "read";
  const status = promo.status ?? "fetched";
  return owner.promoLink.create({
    data: {
      novelId: promo.novelId,
      novelSourceItemId: promo.sourceId,
      channelAppId: promo.appId,
      channelAccountId: ids.account,
      offerType,
      origin: "upstream_existing",
      upstreamCode: promo.upstreamCode === undefined ? null : promo.upstreamCode,
      publicRedirectCode: promo.publicRedirectCode ?? randomUUID().replace(/-/g, "").slice(0, 10),
      webUrl: promo.webUrl === undefined ? null : promo.webUrl,
      appUrl: promo.appUrl === undefined ? null : promo.appUrl,
      idempotencyKey: buildPromoLinkIdempotencyKey({
        channelAppId: promo.appId, novelSourceItemId: promo.sourceId, channelAccountId: ids.account, offerType,
      }),
      status,
      fetchedAt: promo.fetchedAt === undefined ? (status === "fetched" ? new Date() : null) : promo.fetchedAt,
    },
  });
}

export type SeedPublished = {
  readonly appId: string;
  readonly externalBookId: string;
  readonly title: string;
  readonly locale?: string;
  readonly agencyId?: string | null;
  readonly promo?: Partial<Pick<SeedPromo, "status" | "upstreamCode" | "webUrl" | "appUrl">>;
  readonly articleStatus?: string;
  readonly novelStatus?: string;
  readonly coverUrl?: string | null;
  /** 不建文章，只建书目 + 小说 + 推广（用于"可生成"判定）。 */
  readonly withoutArticle?: boolean;
};

/** 一本"已发布"的书：小说 + 书目 + 推广链接 + 文章，全部在同一个剧场名下。 */
export async function seedPublished(book: SeedPublished) {
  const locale = book.locale ?? "en";
  const { novel, source } = await seedBook({
    appId: book.appId, externalBookId: book.externalBookId, title: book.title, locale, agencyId: book.agencyId,
  });
  await owner.novel.update({
    where: { id: novel!.id },
    data: { status: book.novelStatus ?? "published", coverUrl: book.coverUrl === undefined ? `https://img.example/${book.externalBookId}.jpg` : book.coverUrl },
  });
  const promo = await seedPromo({
    appId: book.appId, novelId: novel!.id, sourceId: source.id,
    status: book.promo?.status ?? "fetched",
    upstreamCode: book.promo?.upstreamCode,
    webUrl: book.promo?.webUrl,
    appUrl: book.promo?.appUrl,
  });
  if (book.withoutArticle) return { novel: novel!, source, promo, article: null };
  const token = randomUUID().replace(/-/g, "").slice(0, 12);
  const article = await owner.article.create({
    data: {
      novelId: novel!.id,
      promoLinkId: promo.id,
      locale,
      slug: `slug-${book.externalBookId}-${token}`,
      publicPageShortId: `p${token}`,
      title: book.title,
      summary: `Summary of ${book.title}`,
      body: `Body of ${book.title}. Read it at /go/${promo.publicRedirectCode}`,
      status: book.articleStatus ?? "published",
      articleType: "novel_article",
      publishedAt: new Date(),
    },
  });
  return { novel: novel!, source, promo, article };
}
