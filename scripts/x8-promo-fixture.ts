import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { createPublicRedirectCode } from "../src/lib/redirect/public-redirect-code";

export class X8PromoFixtureError extends Error {}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new X8PromoFixtureError(`${flag} requires a value`);
  return value;
}

export type X8PromoFixtureOptions = {
  readonly sourceItemId: string;
  readonly channelAccountId: string;
  readonly targetUrl: string;
  readonly apply: boolean;
  readonly operatorId: string;
};

export function parseX8PromoFixtureOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): X8PromoFixtureOptions {
  if (env.SITE_URL !== "https://novel.test" || env.P1_12_COMPOSE_PROJECT !== "cps-novel-x8-local") {
    throw new X8PromoFixtureError("fixture is restricted to the X8 local origin and compose project");
  }
  if (env.FEATURE_PROMO_LINK_CLAIM !== "false" || env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "false") {
    throw new X8PromoFixtureError("promo claim gates must remain closed");
  }
  const sourceItemId = valueAfter(argv, "--source-item");
  const channelAccountId = valueAfter(argv, "--channel-account");
  const targetUrl = valueAfter(argv, "--target-url");
  const operatorId = (env.X8_ACCEPTANCE_OPERATOR ?? "").trim();
  if (!sourceItemId) throw new X8PromoFixtureError("--source-item is required");
  if (!channelAccountId) throw new X8PromoFixtureError("--channel-account is required");
  if (!targetUrl) throw new X8PromoFixtureError("--target-url is required");
  if (!operatorId) throw new X8PromoFixtureError("X8_ACCEPTANCE_OPERATOR is required");
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new X8PromoFixtureError("--target-url must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new X8PromoFixtureError("--target-url must use http or https");
  }
  const apply = argv.includes("--apply");
  if (apply && env.X8_ACCEPTANCE_FIXTURE_ALLOW_WRITE !== "true") {
    throw new X8PromoFixtureError("apply requires X8_ACCEPTANCE_FIXTURE_ALLOW_WRITE=true");
  }
  return { sourceItemId, channelAccountId, targetUrl: parsed.toString(), apply, operatorId };
}

function isReady(link: { status: string; webUrl: string | null; appUrl: string | null }): boolean {
  return link.status === "fetched" && Boolean(link.webUrl?.trim() || link.appUrl?.trim());
}

export async function runX8PromoFixture(db: PrismaClient, options: X8PromoFixtureOptions) {
  const source = await db.novelSourceItem.findUnique({
    where: { id: options.sourceItemId },
    select: { id: true, novelId: true, channelAppId: true, channelApp: { select: { channelId: true } } },
  });
  if (!source?.novelId) throw new X8PromoFixtureError("source item is missing or is not linked to a novel");
  const account = await db.channelAccount.findUnique({
    where: { id: options.channelAccountId },
    select: { id: true, channelId: true },
  });
  if (!account || account.channelId !== source.channelApp.channelId) {
    throw new X8PromoFixtureError("channel account does not belong to the source item's channel app");
  }
  const article = await db.article.findUnique({
    where: { novelId_locale: { novelId: source.novelId, locale: "en" } },
    select: { id: true, promoLinkId: true },
  });
  if (!article) throw new X8PromoFixtureError("the linked novel has no en article");

  const existingCandidates = await db.promoLink.findMany({
    where: { novelSourceItemId: source.id, deletedAt: null },
    select: { id: true, publicRedirectCode: true, status: true, webUrl: true, appUrl: true, origin: true },
    orderBy: { createdAt: "desc" },
  });
  const existing = existingCandidates.find(isReady) ?? null;
  if (!options.apply) {
    return {
      mode: "dry-run" as const,
      source: existing ? "upstream-existing" : "acceptance-fixture",
      wouldAttachArticle: article.promoLinkId !== existing?.id,
      publicRedirectCode: existing?.publicRedirectCode ?? null,
    };
  }

  const fixtureKey = createHash("sha256")
    .update(`x8-promo-fixture\n${source.id}\n${account.id}`, "utf8")
    .digest("hex");
  const requestId = randomUUID();
  const result = await db.$transaction(async (tx) => {
    const promoLink = existing ?? await tx.promoLink.upsert({
      where: { idempotencyKey: fixtureKey },
      create: {
        novelId: source.novelId!,
        novelSourceItemId: source.id,
        channelAppId: source.channelAppId,
        channelAccountId: account.id,
        offerType: "read",
        origin: "upstream_existing",
        publicRedirectCode: createPublicRedirectCode(),
        webUrl: options.targetUrl,
        appUrl: null,
        idempotencyKey: fixtureKey,
        status: "fetched",
        fetchedAt: new Date(),
        rawLinks: { acceptanceFixture: true, targetRecordedInWebUrl: true },
      },
      update: {},
      select: { id: true, publicRedirectCode: true, origin: true },
    });
    await tx.article.update({ where: { id: article.id }, data: { promoLinkId: promoLink.id } });
    await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: existing ? "x8.acceptance.promo_existing.attach" : "x8.acceptance.promo_fixture.attach",
        entityType: "promo_link",
        entityId: promoLink.id,
        requestId,
        reason: existing ? "X8 accepted an upstream-existing ready promo" : "X8 isolated /go acceptance fallback",
        beforeSnapshot: { articlePromoLinkId: article.promoLinkId },
        afterSnapshot: { articlePromoLinkId: promoLink.id, acceptanceFixture: !existing },
      },
    });
    return promoLink;
  });
  return {
    mode: "apply" as const,
    source: existing ? "upstream-existing" : "acceptance-fixture",
    publicRedirectCode: result.publicRedirectCode,
    promoLinkId: result.id,
    articleId: article.id,
  };
}

async function main(): Promise<void> {
  const options = parseX8PromoFixtureOptions(process.argv.slice(2), process.env);
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await runX8PromoFixture(db, options), null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
