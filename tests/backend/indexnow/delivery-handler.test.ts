import { beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { createIndexNowDeliveryHandler } from "../../../worker/handlers/indexnow-delivery";
import { FakeIndexNowDb, TEST_SITE_URL, installTestSiteUrl, testEnv } from "./fake-db";

installTestSiteUrl();

const ENABLED_ENV = testEnv({ FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true" });
const LOCALE_OK = { isLocalePublishable: () => true };

function lease(outboxId: string, overrides: Partial<{ taskId: string }> = {}) {
  return {
    family: "generic" as const,
    taskType: "indexnow_delivery",
    mode: "apply" as const,
    itemId: "item-1",
    taskId: overrides.taskId ?? "task-1",
    workerId: "worker-1",
    executionToken: "token-1",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60_000),
    payload: { outboxId },
  };
}

function context(outboxId: string) {
  return { lease: lease(outboxId), mode: "apply" as const, signal: new AbortController().signal, heartbeat: async () => true };
}

function seedDueRow(fake: FakeIndexNowDb, overrides: Partial<Parameters<FakeIndexNowDb["seedOutbox"]>[0]> = {}) {
  fake.seedArticle({
    id: "article-1",
    novelId: "novel-1",
    locale: "en",
    slug: "great-novel",
    publicPageShortId: "abc123",
    status: "published",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    novelStatus: "published",
    promoLink: { status: "fetched", webUrl: "https://x.example/w", appUrl: null },
  });
  fake.seedOutbox({
    id: "outbox-1",
    articleId: "article-1",
    url: `${TEST_SITE_URL}/novel/great-novel-pabc123`,
    revision: BigInt(new Date("2026-01-01T00:00:00.000Z").getTime()),
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    ...overrides,
  });
}

beforeEach(() => {
  invalidateSiteSettingCache();
});

describe("createIndexNowDeliveryHandler — double-gate boundary", () => {
  it("skips without touching the DB when flags are off (default) — fetchImpl is never called", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, testEnv(), LOCALE_OK);
    const outcome = await handler(context("outbox-1"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "delivery_disabled" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.outbox.get("outbox-1")!.status).toBe("pending");
  });
});

describe("createIndexNowDeliveryHandler — fetchImpl-injected delivery outcomes", () => {
  it("200 -> attempt accepted, row accepted, terminal", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200, headers: {} }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);

    const outcome = await handler(context("outbox-1"));
    expect(outcome.status).toBe("success");
    expect(fetchImpl).toHaveBeenCalledOnce();

    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("accepted");
    expect(row.attemptCount).toBe(1);
    expect(row.payloadHost).toBe("indexnow-host.cps-novel.example");
    expect(row.lastHttpStatus).toBe(200);

    const attempt = [...fake.attempts.values()][0]!;
    expect(attempt.attemptState).toBe("completed");
    expect(attempt.outcome).toBe("accepted");
  });

  it("submits exactly the row's own URL as a single-element urlList (no batching)", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.urlList).toEqual([`${TEST_SITE_URL}/novel/great-novel-pabc123`]);
    expect(body.host).toBe("indexnow-host.cps-novel.example");
    expect(body.key).toBe("test-index-now-key");
  });

  it("500 -> retry_wait with a future nextAttemptAt", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async () => new Response("server error", { status: 500 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("retry_wait");
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.lastErrorKind).toBe("http_5xx");
  });

  it("403 -> permanent_failed, no next attempt", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("permanent_failed");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("a thrown network error -> retryable_failed with errorKind network", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("retry_wait");
    expect(row.lastErrorKind).toBe("network");
  });

  it("an AbortError (timeout) -> retryable_failed with errorKind timeout", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    expect(fake.outbox.get("outbox-1")!.lastErrorKind).toBe("timeout");
  });

  it("retryable failure at the attempt budget -> dead_letter", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake, { attemptCount: 4, maxAttempts: 5 });
    const fetchImpl = vi.fn(async () => new Response("server error", { status: 500 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    await handler(context("outbox-1"));

    const row = fake.outbox.get("outbox-1")!;
    expect(row.attemptCount).toBe(5);
    expect(row.status).toBe("dead_letter");
    expect(row.nextAttemptAt).toBeNull();
  });
});

describe("createIndexNowDeliveryHandler — pre-flight skip paths never call fetchImpl", () => {
  it("skips a row that is not due (already accepted)", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake, { status: "accepted" });
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    const outcome = await handler(context("outbox-1"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "not_due" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a row referencing an id that no longer exists", async () => {
    const fake = new FakeIndexNowDb();
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    const outcome = await handler(context("missing-outbox"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "not_due" } });
  });

  it("skips and records config_missing when IndexNow host/key/keyLocation is not configured", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    fake.seedSiteSetting({ indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "" });
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    const outcome = await handler(context("outbox-1"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "config_missing" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.outbox.get("outbox-1")!.lastErrorKind).toBe("config_missing");
  });

  it("skips and cancels a row whose Article no longer satisfies eligibility (drift)", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake);
    fake.articles.get("article-1")!.novelStatus = "takedown";
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    const outcome = await handler(context("outbox-1"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "eligibility_drift" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("cancelled");
    expect(row.lastErrorKind).toBe("eligibility_failed");
  });

  it("skips and cancels a row whose canonical URL changed (e.g. a slug edit)", async () => {
    const fake = new FakeIndexNowDb();
    seedDueRow(fake, { url: `${TEST_SITE_URL}/novel/old-slug-pabc123` });
    const fetchImpl = vi.fn();
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl, ENABLED_ENV, LOCALE_OK);
    const outcome = await handler(context("outbox-1"));
    expect(outcome).toEqual({ status: "skipped", result: { reason: "eligibility_drift" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
