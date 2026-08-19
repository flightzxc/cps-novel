import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ClaimPromoResult, PromoLinkClaimAdapter } from "@/lib/adapters";
import { PromoLinkClaimAdapterError } from "@/lib/adapters";
import { PROMO_LINK_CLAIM_CAPABILITY_KEY, PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks";
import {
  buildPromoLinkIdempotencyKey,
  createPromoLinkClaimHandler,
  parsePromoLinkClaimPayload,
  readExistingPromoFromRawPayload,
  redactUpstreamCode,
  safeHostname,
} from "../../../worker/handlers/promo-link-claim";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { FakePromoLinkClaimHandlerDb } from "./promo-link-claim-handler-fake-db";

const ENABLED_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "true" };
const APPLY_ENV: NodeJS.ProcessEnv = { ...ENABLED_ENV, PROMO_LINK_CLAIM_ALLOW_WRITE: "true" };

function fakeJwt(expiresInSeconds = 3600): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

function baseLease(overrides: Partial<{ mode: "dry_run" | "apply"; attemptCount: number; itemId: string; taskId: string }> = {}) {
  return {
    family: "generic" as const,
    taskType: PROMO_LINK_CLAIM_TASK_TYPE,
    mode: overrides.mode ?? "apply",
    itemId: overrides.itemId ?? "item-1",
    taskId: overrides.taskId ?? "task-1",
    workerId: "worker-1",
    executionToken: "token-1",
    leaseEpoch: 1n,
    attemptCount: overrides.attemptCount ?? 1,
    lockedUntil: new Date(Date.now() + 60_000),
  };
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    novelSourceItemId: "source-1",
    offerType: "read",
    channelAccountId: "account-1",
    channelAppId: "app-1",
    actorId: "actor-1",
    requestId: "request-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function seedFoundation(db: FakePromoLinkClaimHandlerDb, options: { rawPayload?: unknown; capabilityStatus?: string; capabilitySideEffecting?: boolean } = {}) {
  db.seedChannelApp({ id: "app-1", status: "active", channelStatus: "active", channelId: "channel-1", projectType: 1 });
  db.seedChannelAccount({ id: "account-1", channelId: "channel-1", status: "active", deletedAt: null });
  db.seedSourceItem({
    id: "source-1",
    channelAppId: "app-1",
    novelId: "novel-1",
    status: "linked",
    deletedAt: null,
    rawPayload: options.rawPayload ?? {},
  });
  if (options.capabilityStatus) {
    db.seedCapability({
      channelAppId: "app-1",
      capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY,
      status: options.capabilityStatus,
      sideEffecting: options.capabilitySideEffecting ?? true,
    });
  }
  return db;
}

beforeAll(() => {
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 7).toString("base64");
});

function seedActiveCredential(db: FakePromoLinkClaimHandlerDb, token = fakeJwt()) {
  db.seedCredential({
    id: "credential-1",
    channelAccountId: "account-1",
    status: "active",
    encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker(token, "account-1", "credential-1")),
    keyVersion: 1,
    expiresAt: null,
  });
}

describe("P0-S5 promo-link claim handler — payload and pure helpers", () => {
  it("parses a well-formed payload and rejects a malformed one", () => {
    expect(parsePromoLinkClaimPayload(makePayload())).toMatchObject({ novelSourceItemId: "source-1" });
    expect(() => parsePromoLinkClaimPayload({})).toThrow("claim_payload_invalid");
    expect(() => parsePromoLinkClaimPayload(makePayload({ expiresAt: "not-a-date" }))).toThrow("task_expiry_invalid");
  });

  it("reads the §3.9 pre-fetched promo fields without any upstream call", () => {
    expect(readExistingPromoFromRawPayload({ kocCode: "REALCODE1", publicUrl: "https://eng.moboreader.com/x" })).toEqual({
      kocCode: "REALCODE1",
      webUrl: "https://eng.moboreader.com/x",
      appUrl: null,
    });
    expect(readExistingPromoFromRawPayload({})).toEqual({ kocCode: null, webUrl: null, appUrl: null });
    expect(readExistingPromoFromRawPayload(null)).toEqual({ kocCode: null, webUrl: null, appUrl: null });
  });

  it("redacts the upstream code to a length marker and never the raw value", () => {
    expect(redactUpstreamCode("REALCODE1")).toBe("[redacted_code:length=9]");
    expect(redactUpstreamCode(null)).toBeNull();
  });

  it("reduces a URL to its hostname only", () => {
    expect(safeHostname("https://eng.moboreader.com/promo/x?y=1")).toBe("eng.moboreader.com");
    expect(safeHostname(null)).toBeNull();
    expect(safeHostname("not a url")).toBeNull();
  });

  it("derives a stable, deterministic PromoLink idempotency key", () => {
    const key = buildPromoLinkIdempotencyKey({ channelAppId: "a", novelSourceItemId: "b", channelAccountId: "c", offerType: "read" });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(buildPromoLinkIdempotencyKey({ channelAppId: "a", novelSourceItemId: "b", channelAccountId: "c", offerType: "read" })).toBe(key);
    expect(buildPromoLinkIdempotencyKey({ channelAppId: "a", novelSourceItemId: "b", channelAccountId: "c", offerType: "watch" })).not.toBe(key);
  });
});

describe("P0-S5 promo-link claim handler — gates and structural failures", () => {
  it("stays feature_disabled before touching the database", async () => {
    const db = new FakePromoLinkClaimHandlerDb();
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: { NODE_ENV: "test" } });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "feature_disabled" } });
    expect(db.calls).toHaveLength(0);
  });

  it("fails a stale task without touching the database", async () => {
    const db = new FakePromoLinkClaimHandlerDb();
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "task_expired" } });
    expect(db.calls).toHaveLength(0);
  });

  it("fails closed when the source item cannot be resolved", async () => {
    const db = new FakePromoLinkClaimHandlerDb();
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "claim_source_binding_missing" } });
  });
});

describe("P0-S5 promo-link claim handler — dry-run is zero-side-effect but real judgment", () => {
  it("evaluates the real §3.9 decision in dry-run without ever calling the adapter or writing", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: { kocCode: "REALCODE1", publicUrl: "https://eng.moboreader.com/x" } });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ mode: "dry_run" }), payload: makePayload() },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "skipped", result: { decision: "would_fetch_existing" } });
    expect("protectedWrite" in outcome).toBe(false);
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.promoLinks.size).toBe(0);
  });

  it("reports would_skip_capability_disabled in dry-run when no promo exists yet and the capability is off", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: {} });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV });
    const outcome = await handler({
      lease: { ...baseLease({ mode: "dry_run" }), payload: makePayload() },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "skipped", result: { decision: "would_skip_capability_disabled" } });
    expect(db.promoLinks.size).toBe(0);
  });

  it("reports would_claim in dry-run when the capability happens to be enabled", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: {}, capabilityStatus: "enabled" });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ mode: "dry_run" }), payload: makePayload() },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "skipped", result: { decision: "would_claim" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
  });
});

describe("P0-S5 promo-link claim handler — §3.9 already-existing promo (always enabled)", () => {
  it("writes PromoLink.status=fetched from the cached raw_payload alone, no adapter call, upstream code redacted in the audit", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { kocCode: "REALCODE-XYZ", publicUrl: "https://eng.moboreader.com/promo/abc" },
    });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome.status).toBe("success");
    expect((outcome as { result: unknown }).result).toMatchObject({ decision: "already_available", host: "eng.moboreader.com" });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    expect(adapter.claimPromo).not.toHaveBeenCalled();

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const row = db.promoLinkByIdempotencyKey(idempotencyKey);
    expect(row).toMatchObject({ status: "fetched", origin: "upstream_existing", upstreamCode: "REALCODE-XYZ", webUrl: "https://eng.moboreader.com/promo/abc" });
    expect(row!.publicRedirectCode).toMatch(/^[a-z0-9]{10}$/);

    const audit = db.audits.find((entry) => entry.action === "promo_link_claim.already_available");
    expect(JSON.stringify(audit)).not.toContain("REALCODE-XYZ");
    expect(JSON.stringify(audit)).toContain("[redacted_code:length=12]");
  });

  it("is idempotent: a second run against an already-fetched PromoLink is a zero-write skip", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: { kocCode: "REALCODE-XYZ", publicUrl: "https://eng.moboreader.com/promo/abc" } });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const lease = { ...baseLease(), payload: makePayload() };
    const first = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    await db.runProtectedWrite((first as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const second = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    expect(second).toMatchObject({ status: "skipped", result: { decision: "already_fetched" } });
    expect("protectedWrite" in second).toBe(false);
  });
});

describe("P0-S5 promo-link claim handler — capability_disabled (production reality today)", () => {
  it("writes PromoLink.status=registered_disabled when claimPromo is unproven/disabled and no existing promo is cached", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: {} });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "capability_disabled" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    expect(adapter.claimPromo).not.toHaveBeenCalled();

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "registered_disabled", errorKind: "capability_disabled" });
  });
});

describe("P0-S5 promo-link claim handler — claimPromo via fixture adapter (dead in prod, real and tested)", () => {
  it("path 1: adapter success confirms the intent and writes PromoLink.status=fetched, origin=claimed", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = { upstreamCode: "REALCODE-NEW", webUrl: "https://eng.moboreader.com/promo/new", appUrl: null };
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn().mockResolvedValue(claimResult) };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "claimed" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "fetched", origin: "claimed", upstreamCode: "REALCODE-NEW" });
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "confirmed", operationType: "promo_link.claim_promo" });
  });

  it("path 2: a classified, non-ambiguous upstream failure fails the item and confirms the intent as failed", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockRejectedValue(new PromoLinkClaimAdapterError("upstream_http_error", false, false, 422)),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "upstream_http_error" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "failed", errorKind: "upstream_http_error" });
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "failed" });
  });

  it("path 3: an ambiguous outcome (ex: timeout) is never retried automatically and routes to manual review", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockRejectedValue(new PromoLinkClaimAdapterError("request_timeout", true, true)),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "pending", errorKind: "claim_manual_review_required" });
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "manual_review_required" });
  });

  it("a prior unconfirmed intent blocks a new attempt without ever calling the adapter again", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    // Simulates a crashed prior attempt: intent committed, outcome never confirmed.
    db.intents.set("a".repeat(64), {
      id: "intent-stale",
      effectKey: "a".repeat(64),
      operationType: "promo_link.claim_promo",
      idempotencyKey: "a".repeat(64),
      targetType: "promo_link",
      targetId: idempotencyKey,
      channelAccountId: "account-1",
      channelAppId: "app-1",
      status: "prepared",
      requestSummary: {},
      responseShape: null,
      createdAt: new Date(Date.now() - 60_000),
    });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    const stale = db.intents.get("a".repeat(64));
    expect(stale).toMatchObject({ status: "manual_review_required" });
  });
});
