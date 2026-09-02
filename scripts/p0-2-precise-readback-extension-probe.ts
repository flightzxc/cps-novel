/**
 * P-5/P-6/P-7 read-only extension of the exact-target getlistpc probe.
 *
 * The transport permits at most three single-attempt getlistpc requests and
 * rejects every other endpoint before fetch. If the local catalog has no
 * multilingual title/series sample, P-7 consumes no upstream request and is
 * reported as a CONTRACT_EVIDENCE_GAP.
 */
import { PrismaClient } from "@prisma/client";

import { createMoboreaderReadAdapter } from "../src/lib/adapters/moboreader";
import { validateCredentialJwtLocally } from "../src/lib/credentials/jwt";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";

const OWNER_GATE = "PRECISE_READBACK_EXTENSION_APPROVED";
const ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_APP_ID = "5e9aa528-88ab-43d4-97de-a0d9ff5e9862";
const BOOK_B_SOURCE_ITEM_ID = "850bfd87-66dc-48dd-8166-3daed39e536f";
const COMMON_TERM = "the";
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
  probe: "P-5" | "P-6" | "P-7";
  name: string;
  pageSize: number;
}>;

async function run(): Promise<Record<string, unknown>> {
  if (process.env.PRECISE_READBACK_EXTENSION_OWNER_GATE !== OWNER_GATE) stop("owner_gate_missing");
  if (process.env.FEATURE_PROMO_LINK_CLAIM !== "false" || process.env.PROMO_LINK_CLAIM_ALLOW_WRITE !== "false") {
    stop("claim_write_gates_must_remain_closed");
  }

  const prisma = new PrismaClient();
  let token: string | undefined;
  const network = { total: 0, getlistpc: 0, getcode: 0, retries: 0 };
  try {
    const [roleRows, account, app, credentials, capability, bookB, multilingual] = await Promise.all([
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
      prisma.novelSourceItem.findUnique({
        where: { id: BOOK_B_SOURCE_ITEM_ID },
        select: { title: true, channelAppId: true, deletedAt: true },
      }),
      prisma.$queryRaw<Array<{ title: string }>>`
        SELECT a.title
        FROM novel_source_item AS a
        JOIN novel_source_item AS b
          ON b.channel_app_id = a.channel_app_id
         AND b.id <> a.id
         AND b.source_language_code <> a.source_language_code
         AND (
           b.title = a.title
           OR (
             NULLIF(b.raw_payload->>'seriesId', '') IS NOT NULL
             AND b.raw_payload->>'seriesId' = a.raw_payload->>'seriesId'
           )
         )
        WHERE a.channel_app_id = ${CHANNEL_APP_ID}::uuid
          AND a.deleted_at IS NULL
          AND b.deleted_at IS NULL
        ORDER BY a.title, a.id
        LIMIT 1
      `,
    ]);
    if (roleRows[0]?.role !== "worker_app") stop("worker_role_required");
    if (!account || account.businessId !== BUSINESS_ID || account.status !== "active" || account.deletedAt) {
      stop("account_identity_or_status_invalid");
    }
    if (!app || app.channelId !== account.channelId || app.projectType !== 1 || app.status !== "active") {
      stop("channel_app_scope_invalid");
    }
    if (!bookB || bookB.channelAppId !== CHANNEL_APP_ID || bookB.deletedAt || !bookB.title.trim()) {
      stop("book_b_local_identity_invalid");
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

    const prefixEnd = bookB.title.lastIndexOf(" ");
    if (prefixEnd < 1) stop("book_b_strict_prefix_unavailable");
    const plan: ProbeCoordinate[] = [
      { probe: "P-5", name: bookB.title.slice(0, prefixEnd), pageSize: 10 },
      { probe: "P-6", name: COMMON_TERM, pageSize: 200 },
    ];
    if (multilingual[0]?.title) plan.push({ probe: "P-7", name: multilingual[0].title, pageSize: 100 });

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
    const results = [];
    for (const coordinate of plan) {
      const response = await adapter.listBooks({
        name: coordinate.name,
        orderType: 1,
        pageIndex: 1,
        pageSize: coordinate.pageSize,
        projectType: 1,
      }, token);
      const normalizedName = coordinate.name.toLocaleLowerCase("en");
      const normalizedTitles = response.items.map((item) => item.title.toLocaleLowerCase("en"));
      if (coordinate.probe === "P-5") {
        results.push({
          probe: coordinate.probe,
          totalCount: response.totalCount,
          returnedCount: response.items.length,
          bookBReturned: response.items.some((item) => item.title === bookB.title),
          allRowsStartWithStrictPrefix: normalizedTitles.every((title) => title.startsWith(normalizedName)),
        });
      } else if (coordinate.probe === "P-6") {
        results.push({
          probe: coordinate.probe,
          totalCount: response.totalCount,
          returnedCount: response.items.length,
          requestedPageSize: coordinate.pageSize,
          rowsContainingTerm: normalizedTitles.filter((title) => title.includes(normalizedName)).length,
          rowsStartingWithTerm: normalizedTitles.filter((title) => title.startsWith(normalizedName)).length,
          rowsContainingTermAwayFromStart: normalizedTitles.filter((title) => (
            title.includes(normalizedName) && !title.startsWith(normalizedName)
          )).length,
          responseTruncated: response.items.length < response.totalCount,
        });
      } else {
        const languages = [...new Set(response.items.map((item) => item.language))].sort();
        results.push({
          probe: coordinate.probe,
          totalCount: response.totalCount,
          returnedCount: response.items.length,
          distinctReturnedLanguages: languages,
          multilingualRowsReturned: languages.length > 1,
        });
      }
    }
    if (!multilingual[0]) {
      results.push({
        probe: "P-7",
        result: "CONTRACT_EVIDENCE_GAP",
        reason: "local_multilingual_sample_unavailable",
        upstreamRequests: 0,
      });
    }
    if (network.total !== plan.length || network.getlistpc !== plan.length || expectedIndex !== plan.length) {
      stop("read_request_ledger_mismatch");
    }
    return {
      result: "PASS",
      mutationRequests: network.getcode,
      readRequests: network.getlistpc,
      retries: network.retries,
      maxAttempts: 1,
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
