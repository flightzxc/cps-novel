/**
 * Book C live claim smoke.
 *
 * Selection first proves that Book C is absent from the legacy empty-name
 * first 10 rows and that the frozen exact-target reader locates the target
 * as a complete, unique identity with no promo. Only the production claim
 * handler may then dispatch getcode, at most once.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { createMoboreaderReadAdapter } from "../src/lib/adapters/moboreader";
import {
  createPromoLinkClaimAdapter,
  MOBOREADER_PROMO_MAX_CANDIDATES,
  type ClaimPromoRequest,
} from "../src/lib/adapters/promo-link-claim";
import { validateCredentialJwtLocally } from "../src/lib/credentials/jwt";
import {
  buildPromoLinkIdempotencyKey,
  buildWorkerAllowlist,
  createHandlerRegistry,
  createPromoLinkClaimTask,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "../src/lib/tasks";
import { setChannelCapabilityStatus } from "../src/server/channel-capability/service";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";
import { createPromoLinkClaimHandler } from "../worker/handlers/promo-link-claim";
import { processOneWorkerCycle } from "../worker/runtime";

const OWNER_GATE = "BOOK_C_EXACT_TARGET_CLAIM_APPROVED";
const OPERATOR = "book-c-exact-target-claim-smoke";
const ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_APP_ID = "5e9aa528-88ab-43d4-97de-a0d9ff5e9862";
const BOOK_A_SERIES_ID = "124235322";
const BOOK_B_SERIES_ID = "118274322";
const MAX_SELECTION_READS = 5;
const MAX_NETWORK_REQUESTS = 12;
const EVIDENCE_REF = "docs/operations/MOBOREADER_PROMO_CLAIM_CONTRACT_2026-08-31.md#10-step-4bounded-read-only-retry-readback-only-recovery2026-09-02";

class SmokeStopped extends Error {}

function stop(reason: string): never {
  throw new SmokeStopped(reason);
}

function jwtUserId(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload.UserId ?? payload.userId ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

function scalar(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function safeHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

type Candidate = {
  id: string;
  title: string;
  externalBookId: string;
  agencyId: string | number;
  seriesId: string | number;
  language: string | number;
  idempotencyKey: string;
};

type ReadObservation = {
  phase: "legacy_homepage" | "selection" | "production";
  totalCount: number | null;
  returnedCount: number | null;
  complete: boolean;
};

async function run(): Promise<Record<string, unknown>> {
  if (process.env.BOOK_C_OWNER_GATE !== OWNER_GATE) stop("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "true" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "true") {
    stop("promo_write_gates_not_open_in_isolated_operator");
  }

  const prisma = new PrismaClient();
  let token: string | undefined;
  let capabilityEnabledBySmoke = false;
  let report: Record<string, unknown> | undefined;
  const network = { total: 0, getlistpc: 0, getcode: 0 };
  const observations: ReadObservation[] = [];
  let phase: ReadObservation["phase"] = "legacy_homepage";
  let expectedExactTitle: string | null = null;
  let selected: Candidate | null = null;

  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (
      network.total >= MAX_NETWORK_REQUESTS
      || url.origin !== "https://kocserver-cn.cdreader.com"
      || init?.method !== "POST"
      || init.redirect !== "error"
    ) {
      stop("transport_contract_or_budget_violation");
    }

    if (url.pathname === "/api/v1/res/getlistpc") {
      const legacy = body.name === "";
      if (
        !exactKeys(body, ["name", "orderType", "pageIndex", "pageSize", "projectType"])
        || body.orderType !== 1
        || body.pageIndex !== 1
        || body.projectType !== 1
        || (legacy && (phase !== "legacy_homepage" || body.pageSize !== 10 || network.getlistpc !== 0))
        || (!legacy && (
          expectedExactTitle === null
          || String(body.name).trim() !== expectedExactTitle
          || body.pageSize !== MOBOREADER_PROMO_MAX_CANDIDATES
        ))
      ) {
        stop("readback_coordinate_violation");
      }
      network.total += 1;
      network.getlistpc += 1;
      const response = await fetch(input, init);
      let totalCount: number | null = null;
      let returnedCount: number | null = null;
      try {
        const envelope = await response.clone().json() as { data?: { totalCount?: unknown; list?: unknown } };
        totalCount = Number.isSafeInteger(envelope.data?.totalCount) ? Number(envelope.data?.totalCount) : null;
        returnedCount = Array.isArray(envelope.data?.list) ? envelope.data.list.length : null;
      } catch {
        // The production adapter owns malformed-response classification.
      }
      observations.push({
        phase,
        totalCount,
        returnedCount,
        complete: totalCount !== null
          && returnedCount === totalCount
          && totalCount <= (legacy ? 10 : MOBOREADER_PROMO_MAX_CANDIDATES),
      });
      return response;
    }

    if (url.pathname === "/api/v1/res/getcode") {
      network.total += 1;
      network.getcode += 1;
      if (
        network.getcode > 1
        || !selected
        || !exactKeys(body, ["agencyId", "seriesId", "projectType", "language"])
        || String(body.agencyId) !== String(selected.agencyId)
        || String(body.seriesId) !== String(selected.seriesId)
        || String(body.language) !== String(selected.language)
        || body.projectType !== 1
      ) {
        stop("getcode_contract_or_budget_violation");
      }
      return fetch(input, init);
    }

    stop("endpoint_not_allowlisted");
  };

  try {
    const [roleRows, account, app, credentials, capability, sourceRows, existingPromos] = await Promise.all([
      prisma.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`,
      prisma.channelAccount.findUnique({ where: { id: ACCOUNT_ID } }),
      prisma.channelApp.findUnique({ where: { id: CHANNEL_APP_ID } }),
      prisma.channelAccountCredential.findMany({
        where: { channelAccountId: ACCOUNT_ID, status: "active" },
        select: { id: true, encryptedSecret: true, keyVersion: true, expiresAt: true },
      }),
      prisma.channelCapability.findUnique({
        where: { channelAppId_capabilityKey: { channelAppId: CHANNEL_APP_ID, capabilityKey: "claimPromo" } },
        select: { status: true, sideEffecting: true },
      }),
      prisma.novelSourceItem.findMany({
        where: {
          channelAppId: CHANNEL_APP_ID,
          status: "linked",
          deletedAt: null,
          novelId: { not: null },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, externalBookId: true, rawPayload: true },
      }),
      prisma.promoLink.findMany({
        where: { channelAppId: CHANNEL_APP_ID, channelAccountId: ACCOUNT_ID, offerType: "read" },
        select: { novelSourceItemId: true },
      }),
    ]);
    if (roleRows[0]?.role !== "worker_app") stop("worker_role_required");
    if (!account || account.businessId !== BUSINESS_ID || account.status !== "active" || account.deletedAt) {
      stop("account_identity_or_status_invalid");
    }
    if (!app || app.channelId !== account.channelId || app.projectType !== 1 || app.status !== "active") {
      stop("channel_app_scope_invalid");
    }
    if (credentials.length !== 1) stop("active_credential_cardinality_invalid");
    if (capability?.status !== "registered_disabled" || capability.sideEffecting !== true) {
      stop("claim_capability_must_start_registered_disabled");
    }
    const credential = credentials[0];
    if (credential.expiresAt && credential.expiresAt.valueOf() <= Date.now()) stop("active_credential_expired");
    token = decryptCredentialSecretForWorker(
      credential.encryptedSecret,
      ACCOUNT_ID,
      credential.id,
      credential.keyVersion,
    );
    if (jwtUserId(token) !== BUSINESS_ID || validateCredentialJwtLocally(token).status !== "active") {
      stop("stored_credential_identity_invalid");
    }

    const sourceIdsWithPromo = new Set(existingPromos.map((row) => row.novelSourceItemId));
    const candidates: Candidate[] = [];
    for (const row of sourceRows) {
      if (sourceIdsWithPromo.has(row.id) || !row.title.trim()) continue;
      if (!row.rawPayload || typeof row.rawPayload !== "object" || Array.isArray(row.rawPayload)) continue;
      const raw = row.rawPayload as Record<string, unknown>;
      const agencyId = scalar(raw.agencyId);
      const seriesId = scalar(raw.seriesId);
      const language = scalar(raw.language);
      if (agencyId === null || seriesId === null || language === null) continue;
      if ([BOOK_A_SERIES_ID, BOOK_B_SERIES_ID].includes(String(seriesId))) continue;
      const idempotencyKey = buildPromoLinkIdempotencyKey({
        channelAppId: CHANNEL_APP_ID,
        novelSourceItemId: row.id,
        channelAccountId: ACCOUNT_ID,
        offerType: "read",
      });
      candidates.push({
        id: row.id,
        title: row.title.trim(),
        externalBookId: row.externalBookId,
        agencyId,
        seriesId,
        language,
        idempotencyKey,
      });
    }
    if (candidates.length === 0) stop("local_book_c_candidate_missing");
    const blockedIntents = await prisma.sideEffectIntent.findMany({
      where: {
        targetType: "promo_link",
        targetId: { in: candidates.map((candidate) => candidate.idempotencyKey) },
        status: { in: ["prepared", "claim_retry_blocked", "manual_review_required", "confirmed"] },
      },
      select: { targetId: true },
    });
    const blockedTargets = new Set(blockedIntents.map((intent) => intent.targetId));

    const readAdapter = createMoboreaderReadAdapter({ fetchImpl: guardedFetch, maxAttempts: 1 });
    const homepage = await readAdapter.listBooks({
      name: "",
      orderType: 1,
      pageIndex: 1,
      pageSize: 10,
      projectType: 1,
    }, token);
    if (homepage.items.length !== 10) stop("legacy_homepage_did_not_return_10_rows");
    const legacySeriesIds = new Set(homepage.items.map((item) => String(item.seriesId)));

    const exactAdapter = createPromoLinkClaimAdapter({ fetchImpl: guardedFetch });
    phase = "selection";
    let selectionReadCount = 0;
    for (const candidate of candidates) {
      if (legacySeriesIds.has(String(candidate.seriesId)) || blockedTargets.has(candidate.idempotencyKey)) continue;
      if (selectionReadCount >= MAX_SELECTION_READS) break;
      selectionReadCount += 1;
      expectedExactTitle = candidate.title;
      const request: ClaimPromoRequest = {
        agencyId: candidate.agencyId,
        seriesId: candidate.seriesId,
        language: candidate.language,
        projectType: 1,
        name: candidate.title,
        offerType: "read",
      };
      const exact = await exactAdapter.readPromoAfterClaim!(request, token);
      if (exact.status === "missing") {
        selected = candidate;
        break;
      }
    }
    if (!selected) stop("book_c_exact_target_missing_or_already_claimed");
    const selectionObservation = observations.at(-1);
    if (!selectionObservation || selectionObservation.phase !== "selection" || !selectionObservation.complete) {
      stop("book_c_selection_candidate_set_not_complete");
    }
    if (legacySeriesIds.has(String(selected.seriesId))) stop("book_c_present_in_legacy_homepage");

    await setChannelCapabilityStatus(prisma, {
      channelAppId: CHANNEL_APP_ID,
      capabilityKey: "claimPromo",
      targetStatus: "enabled",
      reason: "Owner-approved Book C exact-target claim smoke after S-1 PASS",
      evidenceRef: EVIDENCE_REF,
      requestId: randomUUID(),
      actor: { type: "system", actorId: OPERATOR },
    });
    capabilityEnabledBySmoke = true;

    const claimEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FEATURE_PROMO_LINK_CLAIM: "true",
      PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
      PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "3",
      PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: "2000",
      WORKER_TASK_ALLOWLIST: PROMO_LINK_CLAIM_TASK_TYPE,
    };
    phase = "production";
    expectedExactTitle = selected.title;
    const handler = createPromoLinkClaimHandler(prisma, { env: claimEnv, adapter: exactAdapter });
    const handlers = createHandlerRegistry({
      [PROMO_LINK_CLAIM_TASK_TYPE]: { family: "generic", maxAttempts: 1, handler },
    });
    const allowlist = buildWorkerAllowlist(claimEnv.WORKER_TASK_ALLOWLIST, handlers);
    if (allowlist.invalid.length > 0 || allowlist.effective.join(",") !== PROMO_LINK_CLAIM_TASK_TYPE) {
      stop("book_c_worker_allowlist_invalid");
    }
    const task = await createPromoLinkClaimTask(prisma, {
      channelAccountId: ACCOUNT_ID,
      channelAppId: CHANNEL_APP_ID,
      items: [{ novelSourceItemId: selected.id, offerType: "read" }],
      requestToken: `book-c-exact-target-claim:${randomUUID()}`,
      actorId: OPERATOR,
      requestId: randomUUID(),
      mode: "apply",
    }, claimEnv);
    if (task.status !== "enqueued" || task.taskStatus !== "pending" || task.eligibleCount !== 1) {
      stop(`book_c_task_${task.status}`);
    }
    const item = await prisma.genericTaskItem.findFirstOrThrow({ where: { taskId: task.taskId } });
    await processOneWorkerCycle({
      prisma,
      workerId: `${OPERATOR}-${process.pid}`,
      handlers,
      allowlist,
      signal: new AbortController().signal,
      claimTarget: { family: "generic", taskId: task.taskId, itemId: item.id },
    });

    const [finished, promo, intent] = await Promise.all([
      prisma.genericTaskItem.findUniqueOrThrow({ where: { id: item.id } }),
      prisma.promoLink.findUnique({ where: { idempotencyKey: selected.idempotencyKey } }),
      prisma.sideEffectIntent.findFirst({
        where: { targetType: "promo_link", targetId: selected.idempotencyKey },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    if (finished.status !== "success" || finished.attemptCount !== 1) stop("book_c_task_not_successful");
    if (!promo || promo.status !== "fetched" || promo.origin !== "claimed" || !promo.upstreamCode) {
      stop("book_c_promolink_not_fetched");
    }
    if (!intent || intent.status !== "confirmed") stop("book_c_intent_not_confirmed");
    if (network.getcode !== 1) stop("book_c_getcode_count_not_one");
    const productionReads = observations.filter((observation) => observation.phase === "production");
    if (productionReads.length < 2 || productionReads.some((observation) => !observation.complete)) {
      stop("book_c_production_exact_readback_incomplete");
    }

    report = {
      result: "BOOK_C_PASS",
      bookC: {
        title: selected.title,
        seriesId: String(selected.seriesId),
        externalBookId: selected.externalBookId,
        sourceItemId: selected.id,
      },
      legacyHomepage: {
        pageIndex: 1,
        pageSize: 10,
        returnedCount: homepage.items.length,
        bookCPresent: false,
      },
      exactTarget: {
        selectionStatus: "missing",
        selectionCandidateSetComplete: true,
        selectionTotalCount: selectionObservation.totalCount,
        selectionReturnedCount: selectionObservation.returnedCount,
        productionReadCount: productionReads.length,
        allProductionCandidateSetsComplete: true,
      },
      network: {
        total: network.total,
        getlistpc: network.getlistpc,
        getcode: network.getcode,
        getcodeRetry: 0,
      },
      taskId: task.taskId,
      taskItemId: item.id,
      taskAttemptCount: finished.attemptCount,
      promo: {
        redactedCode: `[redacted_code:length=${promo.upstreamCode.length}]`,
        host: safeHost(promo.webUrl ?? promo.appUrl),
      },
      intentStatus: intent.status,
    };
  } finally {
    token = undefined;
    if (capabilityEnabledBySmoke) {
      await setChannelCapabilityStatus(prisma, {
        channelAppId: CHANNEL_APP_ID,
        capabilityKey: "claimPromo",
        targetStatus: "registered_disabled",
        reason: "Book C exact-target claim smoke completed; close side-effect capability",
        requestId: randomUUID(),
        actor: { type: "system", actorId: OPERATOR },
      });
      const restored = await prisma.channelCapability.findUnique({
        where: { channelAppId_capabilityKey: { channelAppId: CHANNEL_APP_ID, capabilityKey: "claimPromo" } },
        select: { status: true },
      });
      if (restored?.status !== "registered_disabled") stop("claim_capability_restore_failed");
      if (report) report.capabilityRestored = true;
    }
    await prisma.$disconnect();
  }
  if (!report) stop("book_c_report_missing");
  return report;
}

void run().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(`${JSON.stringify({
      result: "BOOK_C_STOPPED",
      reason: error instanceof SmokeStopped ? error.message : "unexpected_smoke_error",
      getcodeUpperBound: 1,
    })}\n`);
    process.exitCode = 1;
  },
);
