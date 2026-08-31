/**
 * Owner-approved Book B vertical E2E using the already-fetched PromoLink.
 *
 * This operator never imports the promo claim adapter or handler. Its only
 * upstream transport allows one getbydataid and one getchapterinfo request;
 * every other path, especially getcode, fails closed before fetch.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { createMoboreaderReadAdapter } from "../src/lib/adapters/moboreader";
import {
  buildWorkerAllowlist,
  createHandlerRegistry,
  createMoboreaderPreviewRefreshTask,
  MOBOREADER_TASK_TYPES,
} from "../src/lib/tasks";
import { evaluatePublishGate } from "../src/server/publish-gate/evaluator";
import { loadPublishGateFacts } from "../src/server/publish-gate/facts";
import { applyPublishTransition } from "../src/server/publish-gate/service";
import { createMoboreaderPreviewHandler } from "../worker/handlers/moboreader";
import { processOneWorkerCycle } from "../worker/runtime";

const BOOK_B = Object.freeze({
  sourceItemId: "850bfd87-66dc-48dd-8166-3daed39e536f",
  novelId: "d22a6048-9872-497d-b542-478f89f713eb",
  articleId: "d8d005be-4488-48e8-ba52-8cfebae6b1e2",
  promoLinkId: "0fc6dab3-05f5-4844-b4b8-ece48b06615d",
  channelAccountId: "45e89c67-b160-4ae6-95e3-c85f98b5a010",
  channelAppId: "5e9aa528-88ab-43d4-97de-a0d9ff5e9862",
  seriesId: "118274322",
  agencyId: "3366",
  language: "3",
  projectType: 1,
});

const OWNER_GATE = "BOOK_B_EXISTING_PROMO_E2E_APPROVED";
const OPERATOR = "book-b-existing-promo-e2e";
let currentStage = "startup";

class E2EStop extends Error {}

function stop(reason: string): never {
  throw new E2EStop(reason);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name.toLowerCase()}_missing`);
  return value;
}

function exactObjectKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(body).sort().join(",") === [...expected].sort().join(",");
}

export function createPreviewOnlyFetch(fetchImpl: typeof fetch, network: {
  total: number;
  getbydataid: number;
  getchapterinfo: number;
}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method !== "POST" || init.redirect !== "error") stop("preview_transport_contract_violation");
    if (url.pathname === "/api/v1/res/getcode") stop("getcode_forbidden");
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    network.total += 1;
    if (network.total > 2) stop("preview_request_budget_exceeded");

    if (url.pathname === "/api/v1/material/getbydataid") {
      network.getbydataid += 1;
      if (
        network.getbydataid > 1
        || String(body.agencyId) !== BOOK_B.agencyId
        || String(body.dataId) !== BOOK_B.seriesId
        || String(body.language) !== BOOK_B.language
        || body.projectType !== BOOK_B.projectType
        || !exactObjectKeys(body, ["agencyId", "dataId", "projectType", "language", "materialType"])
      ) stop("getbydataid_coordinate_violation");
    } else if (url.pathname === "/api/v1/res/getchapterinfo") {
      network.getchapterinfo += 1;
      if (
        network.getchapterinfo > 1
        || String(body.agencyId) !== BOOK_B.agencyId
        || String(body.seriesId) !== BOOK_B.seriesId
        || String(body.language) !== BOOK_B.language
        || body.projectType !== BOOK_B.projectType
        || !exactObjectKeys(body, ["agencyId", "seriesId", "projectType", "language"])
      ) stop("getchapterinfo_coordinate_violation");
    } else {
      stop("preview_endpoint_not_allowlisted");
    }
    return fetchImpl(input, init);
  };
}

async function run(): Promise<Record<string, unknown>> {
  if (process.env.BOOK_B_E2E_OWNER_GATE !== OWNER_GATE) stop("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "false" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "false") {
    stop("claim_flags_must_remain_false");
  }
  const previewEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FEATURE_NOVEL_CATALOG_SYNC: "true",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    WORKER_TASK_ALLOWLIST: MOBOREADER_TASK_TYPES.previewRefresh,
    MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu",
    MOBOREADER_PREVIEW_SOURCE_ITEM_ALLOWLIST: BOOK_B.sourceItemId,
  };
  const web = new PrismaClient({ datasourceUrl: requiredEnv("BOOK_B_E2E_WEB_DATABASE_URL") });
  const worker = new PrismaClient({ datasourceUrl: requiredEnv("BOOK_B_E2E_WORKER_DATABASE_URL") });
  const network = { total: 0, getbydataid: 0, getchapterinfo: 0 };
  try {
    currentStage = "database_preflight";
    const [webRole, workerRole, article, capability, trackingBefore] = await Promise.all([
      web.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`,
      worker.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`,
      web.article.findUnique({
        where: { id: BOOK_B.articleId },
        select: {
          id: true, novelId: true, status: true, promoLinkId: true, slug: true,
          publicPageShortId: true,
          promoLink: { select: { id: true, status: true, origin: true, publicRedirectCode: true } },
        },
      }),
      web.channelCapability.findUnique({
        where: { channelAppId_capabilityKey: { channelAppId: BOOK_B.channelAppId, capabilityKey: "claimPromo" } },
        select: { status: true },
      }),
      web.trackingEvent.count({ where: { promoLinkId: BOOK_B.promoLinkId, eventType: "go_redirect" } }),
    ]);
    if (webRole[0]?.role !== "web_app" || workerRole[0]?.role !== "worker_app") stop("database_role_boundary_invalid");
    if (
      !article
      || article.novelId !== BOOK_B.novelId
      || article.status !== "draft"
      || article.promoLinkId !== BOOK_B.promoLinkId
      || article.promoLink?.id !== BOOK_B.promoLinkId
      || article.promoLink.status !== "fetched"
      || article.promoLink.origin !== "claimed"
    ) stop("book_b_existing_promo_precondition_failed");
    if (capability?.status !== "registered_disabled") stop("claim_capability_not_closed");

    currentStage = "publish_gate_before_preview";
    const beforeLoaded = await loadPublishGateFacts(web, BOOK_B.articleId);
    if (!beforeLoaded) stop("publish_gate_facts_missing_before_preview");
    const gateBefore = evaluatePublishGate(beforeLoaded.facts);
    if (gateBefore.publishable || gateBefore.reasons.join(",") !== "preview_chapter_missing") {
      stop("unexpected_publish_gate_before_preview");
    }

    currentStage = "preview_task_create";
    const requestId = randomUUID();
    const created = await createMoboreaderPreviewRefreshTask(web, {
      channelAccountId: BOOK_B.channelAccountId,
      channelAppId: BOOK_B.channelAppId,
      novelSourceItemIds: [BOOK_B.sourceItemId],
      requestToken: `book-b-existing-promo-e2e:${requestId}`,
      actorId: OPERATOR,
      requestId,
      mode: "apply",
    }, previewEnv);
    if (created.status !== "enqueued" || created.taskStatus !== "pending" || created.eligibleCount !== 1) {
      stop(`preview_task_${created.status}`);
    }
    const item = await web.channelSyncTaskItem.findFirst({
      where: { taskId: created.taskId, novelSourceItemId: BOOK_B.sourceItemId },
      select: { id: true },
    });
    if (!item) stop("preview_task_item_missing");

    currentStage = "preview_task_consume";
    const adapter = createMoboreaderReadAdapter({
      fetchImpl: createPreviewOnlyFetch(fetch, network),
      maxAttempts: 1,
    });
    const handlers = createHandlerRegistry({
      [MOBOREADER_TASK_TYPES.previewRefresh]: {
        family: "channel_sync",
        maxAttempts: 1,
        handler: createMoboreaderPreviewHandler(worker, { adapter, env: previewEnv }),
      },
    });
    const allowlist = buildWorkerAllowlist(previewEnv.WORKER_TASK_ALLOWLIST, handlers);
    if (allowlist.invalid.length > 0 || allowlist.effective.join(",") !== MOBOREADER_TASK_TYPES.previewRefresh) {
      stop("preview_worker_allowlist_invalid");
    }
    await processOneWorkerCycle({
      prisma: worker,
      workerId: `${OPERATOR}-${randomUUID()}`,
      handlers,
      allowlist,
      signal: new AbortController().signal,
      claimTarget: { family: "channel_sync", taskId: created.taskId, itemId: item.id },
    });

    currentStage = "preview_materialization_verify";
    const [finalItem, policy, chapters, afterLoaded] = await Promise.all([
      web.channelSyncTaskItem.findUnique({ where: { id: item.id }, select: { status: true, attemptCount: true } }),
      web.novelPreviewPolicy.findUnique({
        where: { novelId: BOOK_B.novelId },
        select: { materializedChapterCount: true, maxMaterializedChapters: true, lastRefreshedAt: true },
      }),
      web.novelChapter.count({
        where: { novelId: BOOK_B.novelId, status: "preview", deletedAt: null, content: { body: { not: "" } } },
      }),
      loadPublishGateFacts(web, BOOK_B.articleId),
    ]);
    if (network.total !== 2 || network.getbydataid !== 1 || network.getchapterinfo !== 1) {
      stop("preview_request_budget_not_exact");
    }
    if (finalItem?.status !== "success" || finalItem.attemptCount !== 1) stop("preview_task_not_successful");
    if (!policy || policy.materializedChapterCount < 1 || chapters < 1 || !policy.lastRefreshedAt) {
      stop("preview_materialization_missing");
    }
    if (!afterLoaded) stop("publish_gate_facts_missing_after_preview");
    const gateAfter = evaluatePublishGate(afterLoaded.facts);
    if (!gateAfter.publishable || gateAfter.reasons.length !== 0) stop("publish_gate_rejected_after_preview");

    currentStage = "publish_transition";
    const publishRequestId = randomUUID();
    const published = await applyPublishTransition(web, {
      articleId: BOOK_B.articleId,
      requestId: publishRequestId,
      actor: { type: "system", source: OPERATOR },
    });
    if (published.outcome !== "published" || !published.firstPublish) stop(`publish_${published.outcome}`);
    currentStage = "published_state_verify";
    const [finalArticle, finalNovel, finalCapability] = await Promise.all([
      web.article.findUnique({ where: { id: BOOK_B.articleId }, select: { status: true, publishedAt: true } }),
      web.novel.findUnique({ where: { id: BOOK_B.novelId }, select: { status: true } }),
      web.channelCapability.findUnique({
        where: { channelAppId_capabilityKey: { channelAppId: BOOK_B.channelAppId, capabilityKey: "claimPromo" } },
        select: { status: true },
      }),
    ]);
    if (finalArticle?.status !== "published" || !finalArticle.publishedAt || finalNovel?.status !== "published") {
      stop("published_state_missing");
    }
    if (finalCapability?.status !== "registered_disabled") stop("claim_capability_changed");

    return {
      result: "BOOK_B_EXISTING_PROMO_PREVIEW_PUBLISH_PASSED",
      sourceItemId: BOOK_B.sourceItemId,
      novelId: BOOK_B.novelId,
      articleId: BOOK_B.articleId,
      promoLinkId: BOOK_B.promoLinkId,
      previewTaskId: created.taskId,
      previewTaskItemId: item.id,
      previewAttemptCount: finalItem.attemptCount,
      previewNetwork: { ...network, getcode: 0, retryCount: 0 },
      materializedChapterCount: policy.materializedChapterCount,
      gateBefore: gateBefore.reasons,
      gateAfter: gateAfter.reasons,
      publishRequestId,
      publishedAt: finalArticle.publishedAt.toISOString(),
      publicPath: `/novel/${article.slug}-p${article.publicPageShortId}`,
      publicRedirectCode: article.promoLink.publicRedirectCode,
      trackingBefore,
      claimFlags: { feature: false, write: false, capability: finalCapability.status },
    };
  } finally {
    await Promise.allSettled([web.$disconnect(), worker.$disconnect()]);
  }
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(await run()));
  } catch (error) {
    console.error(JSON.stringify({
      result: "BOOK_B_EXISTING_PROMO_E2E_STOPPED",
      reason: error instanceof E2EStop ? error.message : "unexpected_execution_error",
      stage: currentStage,
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
