/**
 * S-1: live structural smoke for the frozen exact-target promo reader.
 *
 * One read-only getlistpc request is permitted. The broad locator must return
 * an incomplete candidate set, proving that the production completeness
 * guard executes. getcode and every other endpoint are rejected before fetch.
 * All database inspection runs inside an explicit READ ONLY transaction.
 */
import { PrismaClient } from "@prisma/client";

import {
  createPromoLinkClaimAdapter,
  MOBOREADER_PROMO_MAX_CANDIDATES,
  type ClaimPromoRequest,
} from "../src/lib/adapters/promo-link-claim";
import { validateCredentialJwtLocally } from "../src/lib/credentials/jwt";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";

const OWNER_GATE = "S1_EXACT_TARGET_STRUCTURAL_SMOKE_APPROVED";
const ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_APP_ID = "5e9aa528-88ab-43d4-97de-a0d9ff5e9862";
const BOOK_B_SOURCE_ITEM_ID = "850bfd87-66dc-48dd-8166-3daed39e536f";
const BROAD_LOCATOR = "the";

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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

async function run(): Promise<Record<string, unknown>> {
  if (process.env.S1_OWNER_GATE !== OWNER_GATE) stop("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "false" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "false") {
    stop("claim_write_gates_must_remain_closed");
  }

  const prisma = new PrismaClient();
  const network = { total: 0, getlistpc: 0, getcode: 0 };
  let token: string | undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [roleRows, account, app, credentials, capability, source] = await Promise.all([
        tx.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`,
        tx.channelAccount.findUnique({ where: { id: ACCOUNT_ID } }),
        tx.channelApp.findUnique({ where: { id: CHANNEL_APP_ID } }),
        tx.channelAccountCredential.findMany({
          where: { channelAccountId: ACCOUNT_ID, status: "active" },
          select: { id: true, encryptedSecret: true, keyVersion: true, expiresAt: true },
        }),
        tx.channelCapability.findUnique({
          where: { channelAppId_capabilityKey: { channelAppId: CHANNEL_APP_ID, capabilityKey: "claimPromo" } },
          select: { status: true, sideEffecting: true },
        }),
        tx.novelSourceItem.findUnique({
          where: { id: BOOK_B_SOURCE_ITEM_ID },
          select: { channelAppId: true, rawPayload: true, deletedAt: true },
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
        stop("claim_capability_must_remain_registered_disabled");
      }
      if (!source || source.channelAppId !== CHANNEL_APP_ID || source.deletedAt) stop("source_identity_invalid");
      if (!source.rawPayload || typeof source.rawPayload !== "object" || Array.isArray(source.rawPayload)) {
        stop("source_identity_fields_missing");
      }
      const raw = source.rawPayload as Record<string, unknown>;
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

      const request: ClaimPromoRequest = {
        agencyId: String(raw.agencyId ?? ""),
        seriesId: String(raw.seriesId ?? ""),
        language: String(raw.language ?? ""),
        projectType: 1,
        name: BROAD_LOCATOR,
        offerType: "read",
      };
      if (!request.agencyId || !request.seriesId || !request.language) stop("source_identity_fields_missing");

      const guardedFetch: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === "/api/v1/res/getcode") {
          network.getcode += 1;
          stop("getcode_forbidden");
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (
          network.total >= 1
          || url.origin !== "https://kocserver-cn.cdreader.com"
          || url.pathname !== "/api/v1/res/getlistpc"
          || init?.method !== "POST"
          || init.redirect !== "error"
          || !exactKeys(body, ["name", "orderType", "pageIndex", "pageSize", "projectType"])
          || body.name !== BROAD_LOCATOR
          || body.orderType !== 1
          || body.pageIndex !== 1
          || body.pageSize !== MOBOREADER_PROMO_MAX_CANDIDATES
          || body.projectType !== 1
        ) {
          stop("read_transport_or_coordinate_violation");
        }
        network.total += 1;
        network.getlistpc += 1;
        return fetch(input, init);
      };

      const adapter = createPromoLinkClaimAdapter({ fetchImpl: guardedFetch });
      const result = await adapter.readPromoAfterClaim!(request, token);
      if (
        result.status !== "ambiguous"
        || result.reason !== "candidate_set_incomplete"
        || result.returnedCount !== MOBOREADER_PROMO_MAX_CANDIDATES
        || result.totalCount <= MOBOREADER_PROMO_MAX_CANDIDATES
      ) {
        stop("candidate_completeness_guard_not_observed");
      }
      if (network.total !== 1 || network.getlistpc !== 1 || network.getcode !== 0) {
        stop("network_ledger_mismatch");
      }

      return {
        result: "S1_PASS",
        reader: "exact_target",
        candidateCompletenessCheck: "EXECUTED",
        structuralResult: result.reason,
        totalCount: result.totalCount,
        returnedCount: result.returnedCount,
        maxCandidates: MOBOREADER_PROMO_MAX_CANDIDATES,
        readRequests: network.getlistpc,
        getcodeRequests: network.getcode,
        databaseTransaction: "READ_ONLY",
        structuralWrites: 0,
      };
    });
  } finally {
    token = undefined;
    await prisma.$disconnect();
  }
}

void run().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(`${JSON.stringify({
      result: "S1_STOPPED",
      reason: error instanceof SmokeStopped ? error.message : "unexpected_smoke_error",
    })}\n`);
    process.exitCode = 1;
  },
);
