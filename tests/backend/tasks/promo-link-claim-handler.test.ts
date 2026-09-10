import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClaimPromoResult, PromoLinkClaimAdapter } from "@/lib/adapters";
import { PromoLinkClaimAdapterError } from "@/lib/adapters";
import {
  PROMO_LINK_CLAIM_CAPABILITY_KEY,
  PROMO_LINK_CLAIM_LIMITS,
  PROMO_LINK_CLAIM_TASK_TYPE,
  PromoLinkClaimReadbackConfigError,
  resolvePromoLinkClaimReadbackPolicy,
} from "@/lib/tasks";
import {
  buildPromoLinkIdempotencyKey,
  createPromoLinkClaimHandler,
  createPromoLinkClaimWorkerHandlers,
  parsePromoLinkClaimPayload,
  redactUpstreamCode,
  safeHostname,
} from "../../../worker/handlers/promo-link-claim";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { FakePromoLinkClaimHandlerDb } from "./promo-link-claim-handler-fake-db";

const ENABLED_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "true" };
const APPLY_ENV: NodeJS.ProcessEnv = { ...ENABLED_ENV, PROMO_LINK_CLAIM_ALLOW_WRITE: "true" };
const RETRY_ENV: NodeJS.ProcessEnv = {
  ...APPLY_ENV,
  PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "3",
  PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: "17",
};
const credentialEnvironmentNames = [
  "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION",
  "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE",
  "CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE",
  "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1",
  "CHANNEL_CREDENTIAL_FINGERPRINT_KEY",
] as const;
const previousCredentialEnvironment = new Map<string, string | undefined>();
let credentialSecretDirectory: string;

it("registers promo claim with a single worker attempt", () => {
  const db = new FakePromoLinkClaimHandlerDb();
  const handlers = createPromoLinkClaimWorkerHandlers(db.asPrismaClient(), { env: APPLY_ENV });
  expect(handlers[PROMO_LINK_CLAIM_TASK_TYPE]).toMatchObject({ family: "generic", maxAttempts: 1 });
});

describe("Step 4 read-only retry policy", () => {
  it("uses the registered defaults and clamps configured values in both directions", () => {
    expect(PROMO_LINK_CLAIM_LIMITS.readback.defaultAttempts).toBe(3);
    expect(resolvePromoLinkClaimReadbackPolicy({ NODE_ENV: "test" })).toEqual({
      attempts: PROMO_LINK_CLAIM_LIMITS.readback.defaultAttempts,
      intervalMs: PROMO_LINK_CLAIM_LIMITS.readback.defaultIntervalMs,
    });
    expect(resolvePromoLinkClaimReadbackPolicy({
      NODE_ENV: "test",
      PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "0",
      PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: "-9",
    })).toEqual({ attempts: 1, intervalMs: 0 });
    expect(resolvePromoLinkClaimReadbackPolicy({
      NODE_ENV: "test",
      PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "99",
      PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: "999999",
    })).toEqual({
      attempts: PROMO_LINK_CLAIM_LIMITS.readback.maxAttempts,
      intervalMs: PROMO_LINK_CLAIM_LIMITS.readback.maxIntervalMs,
    });
  });

  it("fails startup configuration closed for non-integer retry values", () => {
    expect(() => resolvePromoLinkClaimReadbackPolicy({
      NODE_ENV: "test",
      PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "2.5",
    })).toThrow(PromoLinkClaimReadbackConfigError);
  });
});

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
    title: "Exact Target Title",
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
  for (const name of credentialEnvironmentNames) previousCredentialEnvironment.set(name, process.env[name]);
  delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1;
  delete process.env.CHANNEL_CREDENTIAL_FINGERPRINT_KEY;
  credentialSecretDirectory = mkdtempSync(path.join(tmpdir(), "cps-novel-promo-credential-"));
  const encryptionKey = path.join(credentialSecretDirectory, "v1");
  const fingerprintKey = path.join(credentialSecretDirectory, "fingerprint");
  writeFileSync(encryptionKey, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprintKey, randomBytes(32).toString("base64"), { mode: 0o600 });
  process.env.CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION = "1";
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE = encryptionKey;
  process.env.CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE = fingerprintKey;
});

afterAll(() => {
  rmSync(credentialSecretDirectory, { recursive: true, force: true });
  for (const name of credentialEnvironmentNames) {
    const previous = previousCredentialEnvironment.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

function seedActiveCredential(db: FakePromoLinkClaimHandlerDb, token = fakeJwt()) {
  db.seedCredential({
    id: "credential-1",
    channelAccountId: "account-1",
    status: "active",
    encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker(token, "account-1", "credential-1", 1)),
    keyVersion: 1,
    expiresAt: null,
  });
}

function seedFetchedPromoLink(db: FakePromoLinkClaimHandlerDb) {
  const idempotencyKey = buildPromoLinkIdempotencyKey({
    channelAppId: "app-1",
    novelSourceItemId: "source-1",
    channelAccountId: "account-1",
    offerType: "read",
  });
  db.promoLinks.set("promo-link-existing", {
    id: "promo-link-existing",
    novelId: "novel-1",
    novelSourceItemId: "source-1",
    channelAppId: "app-1",
    channelAccountId: "account-1",
    offerType: "read",
    origin: "upstream_existing",
    upstreamCode: "REALCODE-XYZ",
    publicRedirectCode: "abc123def4",
    webUrl: "https://eng.moboreader.com/promo/abc",
    appUrl: null,
    idempotencyKey,
    status: "fetched",
    errorKind: null,
    errorMessage: null,
    fetchedAt: new Date(),
    lastAttemptedAt: new Date(),
  });
  return "promo-link-existing";
}

describe("P0-S5 promo-link claim handler — payload and pure helpers", () => {
  it("parses a well-formed payload and rejects a malformed one", () => {
    expect(parsePromoLinkClaimPayload(makePayload())).toMatchObject({ novelSourceItemId: "source-1" });
    expect(() => parsePromoLinkClaimPayload({})).toThrow("claim_payload_invalid");
    expect(() => parsePromoLinkClaimPayload(makePayload({ expiresAt: "not-a-date" }))).toThrow("task_expiry_invalid");
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
  it("does not reconstruct promo evidence from rawPayload, even when it contains real-looking legacy values", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), { rawPayload: { kocCode: "REALCODE1", publicUrl: "https://eng.moboreader.com/x" } });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ mode: "dry_run" }), payload: makePayload() },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "skipped", result: { decision: "would_skip_capability_disabled" } });
    expect("protectedWrite" in outcome).toBe(false);
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.promoLinks.size).toBe(0);
  });

  it("does not let redaction sentinels hide the real capability decision", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { kocCode: "[redacted]", publicUrl: "[redacted]" },
    });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: ENABLED_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ mode: "dry_run" }), payload: makePayload() },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "skipped", result: { decision: "would_skip_capability_disabled" } });
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

describe("C2 §3.9 promo ownership and fetched-link reconciliation", () => {
  it("never creates a fetched PromoLink from cached rawPayload promo fields", async () => {
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
    expect(outcome).toMatchObject({ status: "success", result: { decision: "capability_disabled" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    expect(adapter.claimPromo).not.toHaveBeenCalled();

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const row = db.promoLinkByIdempotencyKey(idempotencyKey);
    expect(row).toMatchObject({ status: "registered_disabled", errorKind: "capability_disabled", upstreamCode: null, webUrl: null });
    expect(row!.publicRedirectCode).toMatch(/^[a-z0-9]{10}$/);
    expect(JSON.stringify(db.audits)).not.toContain("REALCODE-XYZ");
  });

  it("reconciles an already-fetched PromoLink and remains zero-write when no Article needs binding", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    seedFetchedPromoLink(db);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const lease = { ...baseLease(), payload: makePayload() };
    const outcome = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "already_fetched" } });
    db.calls.length = 0;
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    expect(db.calls.filter((call) => call === "article.update")).toHaveLength(0);
    expect(db.audits.filter((entry) => entry.action === "promo_link_claim.already_fetched_binding_reconciled")).toHaveLength(0);
  });

  it("binds an Article created after the PromoLink had already reached fetched", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    const promoLinkId = seedFetchedPromoLink(db);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const lease = { ...baseLease(), payload: makePayload() };
    db.seedArticle({ id: "article-late", novelId: "novel-1", locale: "en", promoLinkId: null, deletedAt: null });

    const outcome = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    expect(db.articles.get("article-late")!.promoLinkId).toBe(promoLinkId);
    expect(db.audits.find((entry) => entry.action === "promo_link_claim.already_fetched_binding_reconciled")?.afterSnapshot)
      .toMatchObject({ articlesBound: 1, articlesConflicted: 0 });
  });
});

describe("C2 promo-link claim handler — redacted raw evidence is not a decision source", () => {
  it("routes a sync-redacted rawPayload through the actual capability gate", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { kocCode: "[redacted]", publicUrl: "[redacted]" },
    });
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
    const row = db.promoLinkByIdempotencyKey(idempotencyKey);
    expect(row).toMatchObject({ status: "registered_disabled", errorKind: "capability_disabled" });
    expect(row!.status).not.toBe("fetched");
    expect(row!.upstreamCode).not.toBe("[redacted]");
    expect(row!.webUrl).not.toBe("[redacted]");
    expect(row!.upstreamCode).toBeNull();
    expect(row!.webUrl).toBeNull();
  });

  it("re-evaluates the capability state on a second run without calling the adapter", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { kocCode: "[redacted]" },
    });
    const adapter: PromoLinkClaimAdapter = { claimPromo: vi.fn() };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const lease = { ...baseLease(), payload: makePayload() };

    const first = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    await db.runProtectedWrite((first as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    const second = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });

    expect(second).toMatchObject({ status: "success", result: { decision: "capability_disabled" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
  });
});

describe("P0-S11 promo-link claim handler — Article.promoLinkId binding (defect two)", () => {
  it("binds a catalog-fetched PromoLink onto every locale Article through the compensation path", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    const promoLinkId = seedFetchedPromoLink(db);
    db.seedArticle({ id: "article-en", novelId: "novel-1", locale: "en", promoLinkId: null, deletedAt: null });
    db.seedArticle({ id: "article-ko", novelId: "novel-1", locale: "ko", promoLinkId: null, deletedAt: null });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    expect(db.articles.get("article-en")!.promoLinkId).toBe(promoLinkId);
    expect(db.articles.get("article-ko")!.promoLinkId).toBe(promoLinkId);

    const audit = db.audits.find((entry) => entry.action === "promo_link_claim.already_fetched_binding_reconciled");
    expect(audit?.afterSnapshot).toMatchObject({ articlesBound: 2, articlesAlreadyBound: 0, articlesConflicted: 0 });
  });

  it("is idempotent: re-running the write against already-bound Articles produces zero additional article.update calls", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    seedFetchedPromoLink(db);
    db.seedArticle({ id: "article-en", novelId: "novel-1", locale: "en", promoLinkId: null, deletedAt: null });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const lease = { ...baseLease(), payload: makePayload() };

    const first = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    await db.runProtectedWrite((first as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    const boundPromoLinkId = db.articles.get("article-en")!.promoLinkId;
    expect(boundPromoLinkId).not.toBeNull();

    db.calls.length = 0;
    // Replay the same compensation write as a duplicated terminal attempt.
    await db.runProtectedWrite((first as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);
    expect(db.calls.filter((call) => call === "article.update")).toHaveLength(0);
    expect(db.articles.get("article-en")!.promoLinkId).toBe(boundPromoLinkId);
  });

  it("conflict: an Article already bound to a different PromoLink is left untouched, never silently overwritten", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    seedFetchedPromoLink(db);
    db.seedArticle({ id: "article-en", novelId: "novel-1", locale: "en", promoLinkId: "some-other-promo-link-id", deletedAt: null });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    // Not overwritten:
    expect(db.articles.get("article-en")!.promoLinkId).toBe("some-other-promo-link-id");
    // But the PromoLink itself still correctly reached `fetched` — a
    // downstream Article's pre-existing binding must never block that fact
    // from being recorded.
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "fetched" });

    const audit = db.audits.find((entry) => entry.action === "promo_link_claim.already_fetched_binding_reconciled");
    expect(audit?.afterSnapshot).toMatchObject({ articlesBound: 0, articlesConflicted: 1 });
  });

  it("safely skips when no Article exists yet for the Novel (content-creation pipeline has not run)", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    seedFetchedPromoLink(db);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    await expect(
      db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never),
    ).resolves.toBeUndefined();

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "fetched" });
  });
});

describe("P0-S5 promo-link claim handler — capability disabled gate", () => {
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

describe("P0-S5 promo-link claim handler — frozen novel claim contract", () => {
  it("path 1: adapter success confirms the intent and writes PromoLink.status=fetched, origin=claimed", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = { upstreamCode: "REALCODE-NEW", webUrl: "https://eng.moboreader.com/promo/new", appUrl: null };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim: vi.fn()
        .mockResolvedValueOnce({ status: "missing" })
        .mockResolvedValueOnce({ status: "found", promo: claimResult }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "claimed" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(2);
    expect(adapter.readPromoAfterClaim).toHaveBeenNthCalledWith(1, {
      agencyId: "agency-1",
      seriesId: "series-1",
      language: "en",
      projectType: 1,
      name: "Exact Target Title",
      offerType: "read",
    }, expect.any(String), expect.any(AbortSignal));
    expect([...db.intents.values()][0]).toMatchObject({ status: "prepared" });
    expect(db.promoLinks.size).toBe(0);
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "fetched", origin: "claimed", upstreamCode: "REALCODE-NEW" });
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "confirmed", operationType: "promo_link.claim_promo" });
  });

  it("fault injection: retries transient pre-read failures within the read-only budget, then calls getcode once", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = {
      upstreamCode: "READ-RETRY-CODE",
      webUrl: "https://eng.moboreader.com/promo/read-retry",
      appUrl: null,
    };
    const readPromoAfterClaim = vi.fn()
      .mockRejectedValueOnce(new PromoLinkClaimAdapterError("upstream_http_error", true, false, 429))
      .mockRejectedValueOnce(new PromoLinkClaimAdapterError("request_timeout", true, false))
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "found", promo: claimResult });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim,
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), {
      env: RETRY_ENV,
      adapter,
      sleep,
    });
    const signal = new AbortController().signal;
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "claimed" } });
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 17, signal);
    expect(sleep).toHaveBeenNthCalledWith(2, 17, signal);
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
  });

  it("fault injection: aborts a read-only retry wait on lease loss and never reaches getcode", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const readPromoAfterClaim = vi.fn()
      .mockRejectedValue(new PromoLinkClaimAdapterError("upstream_http_error", true, false, 503));
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim,
    };
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: controller.signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "transport_error" } });
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.size).toBe(0);
  });

  it("fails closed before getcode when the authoritative identity is not unique", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({
        status: "ambiguous",
        reason: "identity_not_unique",
        totalCount: 7,
        returnedCount: 7,
      }),
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), {
      env: { ...RETRY_ENV, PROMO_LINK_CLAIM_READBACK_ATTEMPTS: "5" },
      adapter,
      sleep,
    });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "claim_readback_ambiguous",
        message: expect.stringContaining("totalCount=7"),
      },
    });
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.size).toBe(0);
  });

  it("records incomplete post-mutation candidate counts before routing to manual review", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = {
      upstreamCode: "CLAIMED-BUT-AMBIGUOUS",
      webUrl: "https://eng.moboreader.com/promo/ambiguous",
      appUrl: null,
    };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim: vi.fn()
        .mockResolvedValueOnce({ status: "missing" })
        .mockResolvedValueOnce({
          status: "ambiguous",
          reason: "candidate_set_incomplete",
          totalCount: 109,
          returnedCount: 100,
        }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(2);
    expect([...db.intents.values()][0]).toMatchObject({
      status: "manual_review_required",
      responseShape: {
        failureCategory: "readback_unconfirmed",
        readbackStatus: "ambiguous",
        readbackReason: "candidate_set_incomplete",
        readbackTotalCount: 109,
        readbackReturnedCount: 100,
      },
    });
  });

  it("fault injection: enters manual terminal only after post-claim promo visibility exhausts its read-only budget", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = {
      upstreamCode: "NOT-YET-VISIBLE",
      webUrl: "https://eng.moboreader.com/promo/not-yet-visible",
      appUrl: null,
    };
    const readPromoAfterClaim = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "missing" });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim,
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect([...db.intents.values()][0]).toMatchObject({
      status: "manual_review_required",
      responseShape: {
        failureCategory: "readback_unconfirmed",
        readbackStatus: "promo_missing",
      },
    });
  });

  it("fault injection: retries a stale post-claim code and confirms only the claimed code", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = {
      upstreamCode: "NEW-CODE",
      webUrl: "https://eng.moboreader.com/promo/new-code",
      appUrl: null,
    };
    const stalePromo: ClaimPromoResult = {
      upstreamCode: "OLD-CODE",
      webUrl: "https://eng.moboreader.com/promo/old-code",
      appUrl: null,
    };
    const readPromoAfterClaim = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "found", promo: stalePromo })
      .mockResolvedValueOnce({ status: "found", promo: claimResult });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim,
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "claimed" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("refreshes the mutable title once when it drifts between getcode and post-claim readback", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = {
      upstreamCode: "REALCODE-AFTER-RENAME",
      webUrl: "https://eng.moboreader.com/promo/renamed",
      appUrl: null,
    };
    const readPromoAfterClaim = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "target_not_located", reason: "title_no_match", totalCount: 0 })
      .mockRejectedValueOnce(new PromoLinkClaimAdapterError("upstream_http_error", true, false, 503))
      .mockResolvedValueOnce({ status: "found", promo: claimResult });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockImplementation(async () => {
        db.sourceItems.get("source-1")!.title = "Renamed Target Title";
        return claimResult;
      }),
      readPromoAfterClaim,
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "claimed" } });
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(4);
    expect(readPromoAfterClaim).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "Exact Target Title" }), expect.any(String), expect.any(AbortSignal));
    expect(readPromoAfterClaim).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "Exact Target Title" }), expect.any(String), expect.any(AbortSignal));
    expect(readPromoAfterClaim).toHaveBeenNthCalledWith(3, expect.objectContaining({ name: "Renamed Target Title" }), expect.any(String), expect.any(AbortSignal));
    expect(readPromoAfterClaim).toHaveBeenNthCalledWith(4, expect.objectContaining({ name: "Renamed Target Title" }), expect.any(String), expect.any(AbortSignal));
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
  });

  it("does not confuse two zero-row locator reads with a located row whose promo is missing", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({
        status: "target_not_located",
        reason: "title_no_match",
        totalCount: 0,
      }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "claim_readback_locator_stale" },
    });
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(2);
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.size).toBe(0);
  });

  it("does not confuse zero authoritative matches with promo absence", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({
        status: "target_missing",
        reason: "identity_no_match",
        totalCount: 4,
        returnedCount: 4,
      }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "claim_readback_target_missing", message: expect.stringContaining("totalCount=4") },
    });
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(1);
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.size).toBe(0);
  });

  it("path 2: a classified, non-ambiguous upstream failure fails the item and confirms the intent as failed", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockRejectedValue(new PromoLinkClaimAdapterError("upstream_http_error", false, false, 422)),
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "missing" }),
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
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "missing" }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), {
      env: { ...APPLY_ENV, PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: "0" },
      adapter,
    });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(4);
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({ status: "pending", errorKind: "claim_manual_review_required" });
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "manual_review_required" });
  });

  it("fault injection: retries only readback after an ambiguous getcode timeout and atomically recovers", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const recoveredPromo: ClaimPromoResult = {
      upstreamCode: "RECOVERED-AFTER-TIMEOUT",
      webUrl: "https://eng.moboreader.com/promo/recovered-after-timeout",
      appUrl: null,
    };
    const readPromoAfterClaim = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockRejectedValueOnce(new PromoLinkClaimAdapterError("upstream_http_error", true, false, 503))
      .mockRejectedValueOnce(new PromoLinkClaimAdapterError("request_timeout", true, false))
      .mockResolvedValueOnce({ status: "found", promo: recoveredPromo });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockRejectedValue(new PromoLinkClaimAdapterError("request_timeout", true, true)),
      readPromoAfterClaim,
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "readback_recovered" } });
    expect(adapter.claimPromo).toHaveBeenCalledTimes(1);
    expect(readPromoAfterClaim).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    const intent = [...db.intents.values()][0];
    expect(intent).toMatchObject({ status: "prepared" });
    expect(db.promoLinks.size).toBe(0);

    await db.runProtectedWriteTransaction(
      (outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never,
    );
    expect(intent).toMatchObject({ status: "confirmed" });
    expect(db.promoLinkByIdempotencyKey(intent.targetId)).toMatchObject({
      status: "fetched",
      upstreamCode: "RECOVERED-AFTER-TIMEOUT",
    });
  });

  it("a prior unconfirmed intent exhausts read-only recovery before manual review and never repeats getcode", async () => {
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
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "missing" }),
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(adapter.readPromoAfterClaim).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const stale = db.intents.get("a".repeat(64));
    expect(stale).toMatchObject({ status: "manual_review_required" });
  });

  it("keeps an already manual intent outside automatic readback and adjudication", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const effectKey = "c".repeat(64);
    db.intents.set(effectKey, {
      id: "intent-manual",
      effectKey,
      operationType: "promo_link.claim_promo",
      idempotencyKey: effectKey,
      targetType: "promo_link",
      targetId: idempotencyKey,
      channelAccountId: "account-1",
      channelAppId: "app-1",
      status: "manual_review_required",
      requestSummary: {},
      responseShape: null,
      createdAt: new Date(Date.now() - 60_000),
    });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn(),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ attemptCount: 1 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(adapter.readPromoAfterClaim).not.toHaveBeenCalled();
    expect(db.intents.get(effectKey)).toMatchObject({ status: "manual_review_required" });
  });

  it("recovers a prepared intent by readback only and confirms it atomically with PromoLink", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const effectKey = "b".repeat(64);
    db.intents.set(effectKey, {
      id: "intent-recoverable",
      effectKey,
      operationType: "promo_link.claim_promo",
      idempotencyKey: effectKey,
      targetType: "promo_link",
      targetId: idempotencyKey,
      channelAccountId: "account-1",
      channelAppId: "app-1",
      status: "prepared",
      requestSummary: {},
      responseShape: null,
      createdAt: new Date(Date.now() - 60_000),
    });
    const recoveredPromo: ClaimPromoResult = {
      upstreamCode: "RECOVERED-CODE",
      webUrl: "https://eng.moboreader.com/recovered",
      appUrl: "https://eng.moboreader.com/book/recovered",
    };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "found", promo: recoveredPromo }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ attemptCount: 2 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "readback_recovered" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.get(effectKey)).toMatchObject({ status: "prepared" });
    expect(db.promoLinks.size).toBe(0);

    await db.runProtectedWriteTransaction(
      (outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never,
    );
    expect(db.intents.get(effectKey)).toMatchObject({ status: "confirmed" });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({
      status: "fetched",
      origin: "claimed",
      upstreamCode: "RECOVERED-CODE",
    });
  });

  it("recovers a claim_retry_blocked intent (crash window before manual review) by readback only and confirms it atomically with PromoLink", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const effectKey = "d".repeat(64);
    db.intents.set(effectKey, {
      id: "intent-blocked-recoverable",
      effectKey,
      operationType: "promo_link.claim_promo",
      idempotencyKey: effectKey,
      targetType: "promo_link",
      targetId: idempotencyKey,
      channelAccountId: "account-1",
      channelAppId: "app-1",
      status: "claim_retry_blocked",
      requestSummary: {},
      responseShape: { failureCategory: "upstream_timeout", readbackConfirmed: false, readbackStatus: "missing" },
      createdAt: new Date(Date.now() - 60_000),
    });
    const recoveredPromo: ClaimPromoResult = {
      upstreamCode: "RECOVERED-BLOCKED-CODE",
      webUrl: "https://eng.moboreader.com/recovered-blocked",
      appUrl: "https://eng.moboreader.com/book/recovered-blocked",
    };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "found", promo: recoveredPromo }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease({ attemptCount: 2 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "readback_recovered" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.get(effectKey)).toMatchObject({ status: "claim_retry_blocked" });
    expect(db.promoLinks.size).toBe(0);

    await db.runProtectedWriteTransaction(
      (outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never,
    );
    expect(db.intents.get(effectKey)).toMatchObject({
      status: "confirmed",
      responseShape: {
        failureCategory: "upstream_timeout",
        source: "readback",
        confirmedFrom: "claim_retry_blocked",
        hasWebUrl: true,
        hasAppUrl: true,
      },
    });
    expect(db.promoLinkByIdempotencyKey(idempotencyKey)).toMatchObject({
      status: "fetched",
      origin: "claimed",
      upstreamCode: "RECOVERED-BLOCKED-CODE",
    });
    expect(db.audits.some((audit) => audit.action === "promo_link_claim.readback_recovered")).toBe(true);
  });

  it("routes a claim_retry_blocked intent whose readback cannot locate the promo to manual review without another getcode", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: "app-1", novelSourceItemId: "source-1", channelAccountId: "account-1", offerType: "read" });
    const effectKey = "d".repeat(64);
    db.intents.set(effectKey, {
      id: "intent-blocked-unrecoverable",
      effectKey,
      operationType: "promo_link.claim_promo",
      idempotencyKey: effectKey,
      targetType: "promo_link",
      targetId: idempotencyKey,
      channelAccountId: "account-1",
      channelAppId: "app-1",
      status: "claim_retry_blocked",
      requestSummary: {},
      responseShape: { failureCategory: "upstream_timeout", readbackConfirmed: false, readbackStatus: "missing" },
      createdAt: new Date(Date.now() - 60_000),
    });
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn().mockResolvedValue({ status: "missing" }),
    };
    const sleep = vi.fn(async () => undefined);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: RETRY_ENV, adapter, sleep });
    const outcome = await handler({
      lease: { ...baseLease({ attemptCount: 2 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "success", result: { decision: "manual_review_required" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect(db.intents.get(effectKey)).toMatchObject({ status: "manual_review_required" });
    expect(db.intents.get(effectKey)?.responseShape).toMatchObject({ readbackConfirmed: false });
  });

  it("rolls back the PromoLink write when intent confirmation cannot commit", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const claimResult: ClaimPromoResult = { upstreamCode: "ATOMIC-CODE", webUrl: "https://eng.moboreader.com/atomic", appUrl: null };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn().mockResolvedValue(claimResult),
      readPromoAfterClaim: vi.fn()
        .mockResolvedValueOnce({ status: "missing" })
        .mockResolvedValueOnce({ status: "found", promo: claimResult }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    const effectKey = [...db.intents.keys()][0];
    db.intents.delete(effectKey);

    await expect(db.runProtectedWriteTransaction(
      (outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never,
    )).rejects.toThrow("Side-effect intent not found");
    expect(db.promoLinks.size).toBe(0);
    expect(db.audits.filter((entry) => entry.action === "promo_link_claim.claimed")).toHaveLength(0);
  });

  it("loses ownership before mutation, leaves prepared intent, and retries by readback only", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb(), {
      rawPayload: { agencyId: "agency-1", seriesId: "series-1", language: "en" },
      capabilityStatus: "enabled",
    });
    seedActiveCredential(db);
    const recoveredPromo: ClaimPromoResult = {
      upstreamCode: "LEASE-RECOVERED",
      webUrl: "https://eng.moboreader.com/lease-recovered",
      appUrl: null,
    };
    const adapter: PromoLinkClaimAdapter = {
      claimPromo: vi.fn(),
      readPromoAfterClaim: vi.fn()
        .mockResolvedValueOnce({ status: "missing" })
        .mockResolvedValueOnce({ status: "found", promo: recoveredPromo }),
    };
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV, adapter });

    const first = await handler({
      lease: { ...baseLease({ attemptCount: 1 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => false,
    });
    expect(first).toMatchObject({ status: "failed", error: { code: "lease_lost_before_claim" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    expect([...db.intents.values()][0]).toMatchObject({ status: "prepared" });

    const second = await handler({
      lease: { ...baseLease({ attemptCount: 2 }), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(second).toMatchObject({ status: "success", result: { decision: "readback_recovered" } });
    expect(adapter.claimPromo).not.toHaveBeenCalled();
    await db.runProtectedWriteTransaction(
      (second as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never,
    );
    expect([...db.intents.values()][0]).toMatchObject({ status: "confirmed" });
  });
});
