import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  createMoboreaderReadAdapter,
  createPromoLinkClaimAdapter,
  type PromoLinkClaimAdapter,
} from "../src/lib/adapters";
import { validateCredentialJwtLocally } from "../src/lib/credentials/jwt";
import { resolveSiteLocale, SITE_LOCALES, type SiteLocale } from "../src/lib/locale/locale-canonical";
import {
  buildWorkerAllowlist,
  createHandlerRegistry,
  createPromoLinkClaimTask,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "../src/lib/tasks";
import { setChannelCapabilityStatus } from "../src/server/channel-capability/service";
import { createContentFromSourceItem } from "../src/server/content-creation/service";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";
import { createPromoLinkClaimHandler } from "../worker/handlers/promo-link-claim";
import { processOneWorkerCycle } from "../worker/runtime";

const ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_APP_ID = "5e9aa528-88ab-43d4-97de-a0d9ff5e9862";
const BOOK_A_SERIES_ID = "124235322";
const CAPABILITY_KEY = "claimPromo";
const EVIDENCE_REF = "docs/operations/MOBOREADER_PROMO_CLAIM_CONTRACT_2026-08-31.md";
const COORDINATE = Object.freeze({ name: "", orderType: 1, pageIndex: 1, pageSize: 10, projectType: 1 });

class SmokeBlocked extends Error {}

function blocked(reason: string): never {
  throw new SmokeBlocked(reason);
}

function jwtUserId(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload.UserId ?? payload.userId ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

function safeHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function run() {
  if (process.env.SMOKE_OWNER_GATE !== "ONE_BOOK_PROMO_CLAIM_SMOKE_APPROVED") blocked("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "true" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "true") {
    blocked("promo_write_gates_closed");
  }

  const prisma = new PrismaClient();
  let capabilityEnabledBySmoke = false;
  const network = { total: 0, getlistpc: 0, getcode: 0 };
  let selectedSeriesId: string | null = null;
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (init?.method !== "POST" || init.redirect !== "error") blocked("transport_contract_violation");
    network.total += 1;
    if (url.pathname === "/api/v1/res/getlistpc") {
      network.getlistpc += 1;
      if (network.getlistpc > 2) blocked("readback_budget_exceeded");
      if (body.name !== "" || body.orderType !== 1 || body.pageIndex !== 1 || body.pageSize !== 10 || body.projectType !== 1) {
        blocked("readback_coordinate_violation");
      }
    } else if (url.pathname === "/api/v1/res/getcode") {
      network.getcode += 1;
      if (network.getcode > 1) blocked("mutation_budget_exceeded");
      if (
        selectedSeriesId === null
        || String(body.seriesId ?? "") !== selectedSeriesId
        || body.projectType !== 1
        || Object.keys(body).sort().join(",") !== "agencyId,language,projectType,seriesId"
      ) {
        blocked("mutation_coordinate_violation");
      }
    } else {
      blocked("endpoint_not_allowlisted");
    }
    return fetch(input, init);
  };

  try {
    const [account, app, credentials, capability] = await Promise.all([
      prisma.channelAccount.findUnique({ where: { id: ACCOUNT_ID } }),
      prisma.channelApp.findUnique({ where: { id: CHANNEL_APP_ID } }),
      prisma.channelAccountCredential.findMany({
        where: { channelAccountId: ACCOUNT_ID, status: "active" },
        select: { id: true, encryptedSecret: true, keyVersion: true, expiresAt: true },
      }),
      prisma.channelCapability.findUnique({
        where: { channelAppId_capabilityKey: { channelAppId: CHANNEL_APP_ID, capabilityKey: CAPABILITY_KEY } },
      }),
    ]);
    if (!account || account.businessId !== BUSINESS_ID || account.status !== "active" || account.deletedAt) {
      blocked("account_identity_or_status_invalid");
    }
    if (!app || app.status !== "active" || app.projectType !== 1 || app.channelId !== account.channelId) {
      blocked("channel_app_scope_invalid");
    }
    if (credentials.length !== 1) blocked("active_credential_cardinality_invalid");
    const credential = credentials[0];
    const token = decryptCredentialSecretForWorker(
      credential.encryptedSecret,
      ACCOUNT_ID,
      credential.id,
      credential.keyVersion,
    );
    if (jwtUserId(token) !== BUSINESS_ID || validateCredentialJwtLocally(token).status !== "active") {
      blocked("stored_credential_identity_invalid");
    }
    if (!capability || capability.sideEffecting !== true) blocked("claim_capability_registration_invalid");

    const readAdapter = createMoboreaderReadAdapter({ fetchImpl: guardedFetch, maxAttempts: 1 });
    const catalog = await readAdapter.listBooks(COORDINATE, token);
    const candidate = catalog.items.find((book) => (
      book.seriesId !== BOOK_A_SERIES_ID
      && !book.existingPromo.upstreamCode
      && !book.existingPromo.webUrl
      && Boolean(book.agencyId)
      && SITE_LOCALES.includes(resolveSiteLocale(book.language, book.languageName ?? undefined).locale as SiteLocale)
    ));
    if (!candidate) blocked("book_b_unclaimed_candidate_missing");
    selectedSeriesId = candidate.seriesId;
    if (selectedSeriesId === BOOK_A_SERIES_ID) blocked("book_a_reuse_forbidden");

    const resolvedLocale = resolveSiteLocale(candidate.language, candidate.languageName ?? undefined).locale;
    if (!SITE_LOCALES.includes(resolvedLocale as SiteLocale)) blocked("book_b_locale_unresolved");
    const locale = resolvedLocale as SiteLocale;
    const source = await prisma.novelSourceItem.upsert({
      where: {
        channelAppId_externalBookId_sourceLanguageCode: {
          channelAppId: CHANNEL_APP_ID,
          externalBookId: candidate.externalBookId,
          sourceLanguageCode: candidate.language,
        },
      },
      create: {
        channelAppId: CHANNEL_APP_ID,
        externalBookId: candidate.externalBookId,
        sourceLanguageCode: candidate.language,
        sourceLanguageName: candidate.languageName,
        sourceLocale: locale,
        title: candidate.title,
        description: candidate.description ?? "",
        coverUrl: candidate.coverUrl,
        totalChapterCount: candidate.allEpis ?? 0,
        paidFromChapter: candidate.payEpisFrom,
        splitRatio: candidate.splitRatio === null ? null : new Prisma.Decimal(candidate.splitRatio),
        ttoSplitRatio: candidate.ttoSplitRatio === null ? null : new Prisma.Decimal(candidate.ttoSplitRatio),
        externalAgencyId: candidate.agencyId,
        sourceCreatedAtRaw: candidate.createTime,
        lastSeenAt: new Date(),
        rawPayload: candidate.rawEvidence as Prisma.InputJsonObject,
      },
      update: {
        sourceLanguageName: candidate.languageName,
        sourceLocale: locale,
        title: candidate.title,
        description: candidate.description ?? "",
        coverUrl: candidate.coverUrl,
        totalChapterCount: candidate.allEpis ?? 0,
        paidFromChapter: candidate.payEpisFrom,
        splitRatio: candidate.splitRatio === null ? null : new Prisma.Decimal(candidate.splitRatio),
        ttoSplitRatio: candidate.ttoSplitRatio === null ? null : new Prisma.Decimal(candidate.ttoSplitRatio),
        externalAgencyId: candidate.agencyId,
        sourceCreatedAtRaw: candidate.createTime,
        lastSeenAt: new Date(),
        deletedAt: null,
        rawPayload: candidate.rawEvidence as Prisma.InputJsonObject,
      },
    });
    if (!["pending", "linked"].includes(source.status)) blocked("book_b_source_status_invalid");
    const content = await createContentFromSourceItem(prisma, {
      novelSourceItemId: source.id,
      locale,
      mode: "apply",
      actor: { type: "system", source: "one-book-promo-claim-smoke" },
      requestId: randomUUID(),
    });
    if (!['created', 'already_exists'].includes(content.outcome)) blocked(`book_b_content_${content.outcome}`);

    if (capability.status !== "enabled") {
      await setChannelCapabilityStatus(prisma, {
        channelAppId: CHANNEL_APP_ID,
        capabilityKey: CAPABILITY_KEY,
        targetStatus: "enabled",
        reason: "Owner-approved one-book promo claim smoke after contract and safety review",
        evidenceRef: EVIDENCE_REF,
        requestId: randomUUID(),
        actor: { type: "system", actorId: "one-book-promo-claim-smoke" },
      });
      capabilityEnabledBySmoke = true;
    }

    const liveClaimAdapter = createPromoLinkClaimAdapter({ fetchImpl: guardedFetch });
    // The production handler owns the only invocation site, after it has
    // durably prepared the SideEffectIntent and proven the task fence. Keep
    // this harness as dependency injection only; do not add a second direct
    // mutation call site here.
    const claimPromoAfterPreparedIntent = liveClaimAdapter.claimPromo;
    let cachedPreRead = true;
    const smokeAdapter: PromoLinkClaimAdapter = {
      claimPromo: claimPromoAfterPreparedIntent,
      readPromoAfterClaim: async (request, secret, signal) => {
        if (cachedPreRead) {
          cachedPreRead = false;
          if (String(request.seriesId) !== selectedSeriesId) blocked("cached_preread_target_mismatch");
          return { status: "missing" };
        }
        return liveClaimAdapter.readPromoAfterClaim!(request, secret, signal);
      },
    };
    const handler = createPromoLinkClaimHandler(prisma, { env: process.env, adapter: smokeAdapter });
    const handlers = createHandlerRegistry({
      [PROMO_LINK_CLAIM_TASK_TYPE]: { family: "generic", maxAttempts: 1, handler },
    });
    const allowlist = buildWorkerAllowlist(PROMO_LINK_CLAIM_TASK_TYPE, handlers);
    const task = await createPromoLinkClaimTask(prisma, {
      channelAccountId: ACCOUNT_ID,
      channelAppId: CHANNEL_APP_ID,
      items: [{ novelSourceItemId: source.id, offerType: "read" }],
      requestToken: `one-book-promo-claim-smoke:${randomUUID()}`,
      actorId: "one-book-promo-claim-smoke",
      requestId: randomUUID(),
      mode: "apply",
    }, process.env);
    if (task.status !== "enqueued" || task.taskStatus !== "pending") blocked("smoke_task_not_enqueued");
    const item = await prisma.genericTaskItem.findFirstOrThrow({ where: { taskId: task.taskId } });
    await processOneWorkerCycle({
      prisma,
      workerId: `one-book-promo-claim-smoke-${process.pid}`,
      handlers,
      allowlist,
      signal: new AbortController().signal,
      claimTarget: { family: "generic", taskId: task.taskId, itemId: item.id },
    });

    const [finished, promo, intent] = await Promise.all([
      prisma.genericTaskItem.findUniqueOrThrow({ where: { id: item.id } }),
      prisma.promoLink.findFirst({
        where: { novelSourceItemId: source.id, channelAccountId: ACCOUNT_ID, offerType: "read" },
      }),
      prisma.sideEffectIntent.findFirst({
        where: { targetType: "promo_link", channelAccountId: ACCOUNT_ID, channelAppId: CHANNEL_APP_ID },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    if (finished.status !== "success" || finished.attemptCount !== 1) blocked("smoke_task_not_successful");
    if (!promo || promo.status !== "fetched" || promo.origin !== "claimed" || !promo.upstreamCode) {
      blocked("smoke_promolink_not_fetched");
    }
    if (!intent || intent.status !== "confirmed") blocked("smoke_intent_not_confirmed");
    if (network.total !== 3 || network.getlistpc !== 2 || network.getcode !== 1) blocked("network_budget_mismatch");

    const rerun = await createPromoLinkClaimTask(prisma, {
      channelAccountId: ACCOUNT_ID,
      channelAppId: CHANNEL_APP_ID,
      items: [{ novelSourceItemId: source.id, offerType: "read" }],
      requestToken: `one-book-promo-claim-smoke-rerun:${randomUUID()}`,
      actorId: "one-book-promo-claim-smoke",
      requestId: randomUUID(),
      mode: "apply",
    }, process.env);
    if (rerun.status !== "enqueued") blocked("smoke_rerun_not_enqueued");
    const rerunItem = await prisma.genericTaskItem.findFirstOrThrow({ where: { taskId: rerun.taskId } });
    await processOneWorkerCycle({
      prisma,
      workerId: `one-book-promo-claim-smoke-rerun-${process.pid}`,
      handlers,
      allowlist,
      signal: new AbortController().signal,
      claimTarget: { family: "generic", taskId: rerun.taskId, itemId: rerunItem.id },
    });
    const rerunFinished = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: rerunItem.id } });
    if (rerunFinished.status !== "success" || network.total !== 3 || network.getcode !== 1) {
      blocked("smoke_rerun_short_circuit_failed");
    }

    return {
      result: "ONE_BOOK_PROMO_CLAIM_SMOKE_PASSED",
      accountIdentity: BUSINESS_ID,
      channelAccountId: ACCOUNT_ID,
      bookAExcluded: BOOK_A_SERIES_ID,
      bookB: {
        title: candidate.title,
        seriesId: candidate.seriesId,
        externalBookId: candidate.externalBookId,
        sourceItemId: source.id,
      },
      requestCoordinate: { page: 1, pageSize: 10, projectType: 1 },
      network,
      claimAttempts: 1,
      retryCount: 0,
      taskId: task.taskId,
      taskItemId: item.id,
      rerunTaskId: rerun.taskId,
      rerunTaskItemId: rerunItem.id,
      promo: { redactedCode: `[redacted_code:length=${promo.upstreamCode.length}]`, host: safeHost(promo.webUrl ?? promo.appUrl) },
      intentStatus: intent.status,
    };
  } finally {
    if (capabilityEnabledBySmoke) {
      await setChannelCapabilityStatus(prisma, {
        channelAppId: CHANNEL_APP_ID,
        capabilityKey: CAPABILITY_KEY,
        targetStatus: "registered_disabled",
        reason: "One-book promo claim smoke completed; close side-effect capability",
        requestId: randomUUID(),
        actor: { type: "system", actorId: "one-book-promo-claim-smoke" },
      }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (report) => process.stdout.write(JSON.stringify(report) + "\n"),
    (error) => {
      process.stderr.write(JSON.stringify({
        result: "ONE_BOOK_PROMO_CLAIM_SMOKE_STOPPED",
        reason: error instanceof Error ? error.message : "unknown_error",
      }) + "\n");
      process.exitCode = 1;
    },
  );
}
