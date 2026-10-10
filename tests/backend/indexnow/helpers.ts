/**
 * TEST_ONLY shared fixtures for the IndexNow batch-delivery unit tests.
 * Everything here drives the production handler / sweep / scripts against
 * `FakeIndexNowDb` (see its header for what the double does and does not model).
 */
import { vi } from "vitest";

import { INDEXNOW_CONTROL_ACTIONS } from "@/lib/indexnow/delivery-control";
import { buildIndexNowCanonicalUrl } from "@/lib/indexnow/eligibility";
import { sweepDueIndexNowDeliveries } from "@/lib/indexnow/sweep";

import { createIndexNowDeliveryHandler } from "../../../worker/handlers/indexnow-delivery";
import { FakeIndexNowDb, testEnv } from "./fake-db";

export const ENABLED_DELIVERY_ENV = testEnv({ FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true" });
export const ENABLED_ALL_ENV = testEnv({
  FEATURE_INDEXNOW_OUTBOX: "true",
  INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
  FEATURE_INDEXNOW_DELIVERY: "true",
  INDEXNOW_DELIVERY_ALLOW_WRITE: "true",
  INDEXNOW_BACKFILL_ALLOW_WRITE: "true",
});
export const LOCALE_OK = { isLocalePublishable: () => true };
export const T0 = new Date("2026-03-01T12:00:00.000Z");

export function pad(index: number, width = 5): string {
  return String(index).padStart(width, "0");
}

export type SeededRow = { articleId: string; outboxId: string; url: string; createdAt: Date };

/**
 * Seeds `count` published novel articles, each with one due outbox row.
 * `createdAt` increases with the index (`index 0` is the oldest) while the
 * outbox ids run the OTHER way (`outbox-${count - index}`), so "FIFO by
 * createdAt" and "sorted by id" give different answers and a test can tell.
 */
export function seedDueRows(
  fake: FakeIndexNowDb,
  count: number,
  options: { prefix?: string; status?: string; locale?: string; baseMs?: number; idsDescending?: boolean; overrides?: Partial<Parameters<FakeIndexNowDb["seedOutbox"]>[0]> } = {},
): SeededRow[] {
  const prefix = options.prefix ?? "r";
  const baseMs = options.baseMs ?? T0.getTime() - 3_600_000;
  const rows: SeededRow[] = [];
  for (let index = 0; index < count; index++) {
    const articleId = `${prefix}-article-${pad(index)}`;
    const outboxId = options.idsDescending === false ? `${prefix}-outbox-${pad(index)}` : `${prefix}-outbox-${pad(count - index)}`;
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    fake.seedArticle({
      id: articleId,
      novelId: `${prefix}-novel-${pad(index)}`,
      locale: options.locale ?? "en",
      slug: `book-${prefix}-${pad(index)}`,
      publicPageShortId: `${prefix}${pad(index)}`,
      status: "published",
      updatedAt,
      publishedAt: new Date(baseMs),
    });
    const url = buildIndexNowCanonicalUrl({
      locale: options.locale ?? "en",
      slug: `book-${prefix}-${pad(index)}`,
      publicPageShortId: `${prefix}${pad(index)}`,
    });
    const createdAt = new Date(baseMs + index * 1000);
    fake.seedOutbox({
      id: outboxId,
      articleId,
      url,
      revision: BigInt(updatedAt.getTime()),
      status: options.status ?? "pending",
      locale: options.locale ?? "en",
      createdAt,
      ...options.overrides,
    });
    rows.push({ articleId, outboxId, url, createdAt });
  }
  return rows;
}

export function batchLease(taskId = "task-1", payload: unknown = { mode: "batch" }) {
  return {
    family: "generic" as const,
    taskType: "indexnow_delivery",
    mode: "apply" as const,
    itemId: "item-1",
    taskId,
    workerId: "worker-1",
    executionToken: "token-1",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60_000),
    payload,
  };
}

export type FetchReply = { status: number; headers?: Record<string, string>; body?: string } | Error;

/** Records each request body; `responder` sees the parsed JSON and the 1-based call number. */
export function fetchStub(responder: (body: { host: string; key: string; keyLocation: string; urlList: string[] }, call: number) => FetchReply) {
  let call = 0;
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    call++;
    const body = JSON.parse(init!.body as string);
    const reply = responder(body, call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? "ok", { status: reply.status, headers: reply.headers });
  });
}

export function urlListOf(fetchImpl: ReturnType<typeof fetchStub>, callIndex = 0): string[] {
  const [, init] = fetchImpl.mock.calls[callIndex]!;
  return JSON.parse(init!.body as string).urlList as string[];
}

export async function runDelivery(
  fake: FakeIndexNowDb,
  fetchImpl: ReturnType<typeof fetchStub> | typeof fetch,
  options: { env?: NodeJS.ProcessEnv; payload?: unknown; taskId?: string; signal?: AbortSignal; heartbeat?: () => Promise<boolean> } = {},
) {
  const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl as typeof fetch, options.env ?? ENABLED_DELIVERY_ENV, LOCALE_OK);
  return handler({
    lease: batchLease(options.taskId, options.payload),
    mode: "apply",
    signal: options.signal ?? new AbortController().signal,
    heartbeat: options.heartbeat ?? (async () => true),
  });
}

export async function runSweep(fake: FakeIndexNowDb, env: NodeJS.ProcessEnv = ENABLED_DELIVERY_ENV) {
  return sweepDueIndexNowDeliveries(fake.asTransactionClient(), { now: fake.clock() }, env);
}

export function auditsOf(fake: FakeIndexNowDb, action: string) {
  return [...fake.audits.values()].filter((audit) => audit.action === action);
}

export function lastBisectSnapshot(fake: FakeIndexNowDb): Record<string, unknown> {
  const bisects = auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.bisect);
  return bisects[bisects.length - 1]!.afterSnapshot as Record<string, unknown>;
}

export const RESUME_ACTOR = "11111111-1111-4111-8111-111111111111";
