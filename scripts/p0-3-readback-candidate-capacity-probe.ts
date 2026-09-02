/**
 * P-8/P-9/P-10 read-only getlistpc candidate-capacity probe.
 *
 * Exactly three single-attempt requests are permitted:
 *   P-8: a locally selected low-cardinality substring with pageSize 15
 *   P-9: the same substring with pageSize 100
 *   P-10: the proven broad substring `the` with pageSize 100
 *
 * No response rows, titles, promo values, credentials, or raw payloads are
 * printed. Completeness is derived from returnedCount === totalCount; the
 * requested pageSize is never treated as proof that the response is complete.
 */
import { PrismaClient } from "@prisma/client";

import { createMoboreaderReadAdapter } from "../src/lib/adapters/moboreader";
import { validateCredentialJwtLocally } from "../src/lib/credentials/jwt";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";

const OWNER_GATE = "READBACK_CANDIDATE_CAPACITY_APPROVED";
const ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_APP_ID = "5e9aa528-88ab-43d4-97de-a0d9ff5e9862";
const LOW_CARDINALITY_TERM = "dragonless";
const BROAD_TERM = "the";
const MAX_REQUESTS = 3;

class ProbeStopped extends Error {}

function stop(reason: string): never {
  throw new ProbeStopped(reason);
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

type ProbeCoordinate = Readonly<{
  probe: "P-8" | "P-9" | "P-10";
  name: string;
  pageSize: 15 | 100;
}>;

async function run(): Promise<Record<string, unknown>> {
  if (process.env.READBACK_CANDIDATE_CAPACITY_OWNER_GATE !== OWNER_GATE) stop("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "false" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "false") {
    stop("claim_write_gates_must_remain_closed");
  }

  const prisma = new PrismaClient();
  let token: string | undefined;
  const network = { total: 0, getlistpc: 0, getcode: 0 };
  try {
    const [roleRows, account, app, credentials, capability] = await Promise.all([
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

    const plan: readonly ProbeCoordinate[] = [
      { probe: "P-8", name: LOW_CARDINALITY_TERM, pageSize: 15 },
      { probe: "P-9", name: LOW_CARDINALITY_TERM, pageSize: 100 },
      { probe: "P-10", name: BROAD_TERM, pageSize: 100 },
    ];
    let expectedIndex = 0;
    const guardedFetch: typeof fetch = async (input, init) => {
      const coordinate = plan[expectedIndex];
      if (!coordinate || network.total >= MAX_REQUESTS) stop("read_request_budget_exceeded");
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (
        url.origin !== "https://kocserver-cn.cdreader.com"
        || url.pathname !== "/api/v1/res/getlistpc"
        || init?.method !== "POST"
        || init.redirect !== "error"
        || !exactKeys(body, ["name", "orderType", "pageIndex", "pageSize", "projectType"])
        || body.name !== coordinate.name
        || body.orderType !== 1
        || body.pageIndex !== 1
        || body.pageSize !== coordinate.pageSize
        || body.projectType !== 1
      ) {
        stop("read_transport_or_coordinate_violation");
      }
      expectedIndex += 1;
      network.total += 1;
      network.getlistpc += 1;
      return fetch(input, init);
    };

    const adapter = createMoboreaderReadAdapter({ fetchImpl: guardedFetch, maxAttempts: 1 });
    const results: Array<Record<string, unknown>> = [];
    for (const coordinate of plan) {
      const response = await adapter.listBooks({
        name: coordinate.name,
        orderType: 1,
        pageIndex: 1,
        pageSize: coordinate.pageSize,
        projectType: 1,
      }, token);
      results.push({
        probe: coordinate.probe,
        requestedPageSize: coordinate.pageSize,
        totalCount: response.totalCount,
        returnedCount: response.items.length,
        listLengthEqualsTotalCount: response.items.length === response.totalCount,
        responseTruncated: response.items.length < response.totalCount,
      });
    }

    if (network.total !== MAX_REQUESTS || network.getlistpc !== MAX_REQUESTS || expectedIndex !== plan.length) {
      stop("read_request_ledger_mismatch");
    }
    const p8 = results[0];
    const p9 = results[1];
    const p10 = results[2];
    if (p8.totalCount !== p9.totalCount) stop("same_query_total_count_changed_between_p8_and_p9");
    return {
      result: "PASS",
      mutationRequests: network.getcode,
      readRequests: network.getlistpc,
      retries: 0,
      maxAttempts: 1,
      sameQueryTotalCountStable: true,
      p10DeliveredRequestedPageSize: p10.returnedCount === p10.requestedPageSize,
      results,
    };
  } finally {
    token = undefined;
    await prisma.$disconnect();
  }
}

void run().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(`${JSON.stringify({
      result: "STOPPED",
      reason: error instanceof ProbeStopped ? error.message : "unexpected_probe_error",
    })}\n`);
    process.exitCode = 1;
  },
);
