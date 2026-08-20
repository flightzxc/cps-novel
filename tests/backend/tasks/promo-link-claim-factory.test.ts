import { describe, expect, it } from "vitest";
import {
  createPromoLinkClaimTask,
  PROMO_LINK_CLAIM_LIMITS,
  PROMO_LINK_CLAIM_TASK_TYPE,
  PromoLinkClaimTaskInputError,
} from "@/lib/tasks";
import { FakePromoLinkClaimTaskDb } from "./promo-link-claim-factory-fake-db";

const APPLY_ENABLED_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "true" };

const SOURCE_1 = "00000000-0000-4000-8000-000000000001";
const SOURCE_2 = "00000000-0000-4000-8000-000000000002";
const SOURCE_PENDING = "00000000-0000-4000-8000-000000000003";
const SOURCE_MISSING = "00000000-0000-4000-8000-000000000099";

function seedFoundation(db: FakePromoLinkClaimTaskDb) {
  db.seedChannelApp({ id: "app-1", status: "active", channelStatus: "active", channelId: "channel-1" });
  db.seedChannelAccount({ id: "account-1", channelId: "channel-1", status: "active", deletedAt: null });
  db.seedSourceItem({ id: SOURCE_1, channelAppId: "app-1", novelId: "novel-1", status: "linked", deletedAt: null });
  db.seedSourceItem({ id: SOURCE_2, channelAppId: "app-1", novelId: "novel-2", status: "linked", deletedAt: null });
  return db;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    channelAccountId: "account-1",
    channelAppId: "app-1",
    items: [{ novelSourceItemId: SOURCE_1, offerType: "read" }],
    requestToken: "request-token-1",
    actorId: "actor-1",
    requestId: "request-1",
    mode: "apply" as const,
    ...overrides,
  };
}

describe("P0-S5 promo-link claim task factory — idempotency", () => {
  it("returns duplicate for an exact requestToken resubmission without creating a second task", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const prisma = db.asPrismaClient();
    const first = await createPromoLinkClaimTask(prisma, baseInput(), APPLY_ENABLED_ENV);
    expect(first).toMatchObject({ status: "enqueued", taskStatus: "pending", eligibleCount: 1 });

    const second = await createPromoLinkClaimTask(prisma, baseInput(), APPLY_ENABLED_ENV);
    expect(second).toMatchObject({ status: "duplicate", taskId: (first as { taskId: string }).taskId });
    expect(db.tasks.size).toBe(1);
  });

  it("marks the task disabled when the feature flag is off, but still records it", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const result = await createPromoLinkClaimTask(db.asPrismaClient(), baseInput({ requestToken: "rt-flag-off" }), { NODE_ENV: "test" });
    expect(result).toMatchObject({ status: "enqueued", taskStatus: "disabled" });
  });

  it("allows dry_run to queue as pending even without the write-allow flag", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const result = await createPromoLinkClaimTask(
      db.asPrismaClient(),
      baseInput({ requestToken: "rt-dry-run", mode: "dry_run" }),
      { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "true" },
    );
    expect(result).toMatchObject({ status: "enqueued", taskStatus: "pending" });
  });
});

describe("P0-S5 promo-link claim task factory — scope conflicts", () => {
  it("rejects a second concurrent submission with the identical scope as active_conflict", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const prisma = db.asPrismaClient();
    const input = baseInput();
    const first = await createPromoLinkClaimTask(prisma, input, APPLY_ENABLED_ENV);
    expect(first.status).toBe("enqueued");

    const second = await createPromoLinkClaimTask(prisma, { ...input, requestToken: "request-token-2" }, APPLY_ENABLED_ENV);
    expect(second).toMatchObject({ status: "active_conflict", taskId: (first as { taskId: string }).taskId });
    expect(db.tasks.size).toBe(1);
  });

  it("drops an item that is already claimed by another active task (cross-task overlap precheck)", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    db.seedActiveTask(
      {
        id: "existing-task",
        taskType: PROMO_LINK_CLAIM_TASK_TYPE,
        channelAccountId: "account-1",
        channelAppId: "app-1",
        operationScopeHash: "unrelated-scope-hash",
        mode: "apply",
        status: "processing",
        requestToken: "existing-request-token",
        createdAt: new Date(),
      },
      [{ targetType: "novel_source_item", targetId: SOURCE_1 }],
    );
    const result = await createPromoLinkClaimTask(
      db.asPrismaClient(),
      baseInput({ items: [{ novelSourceItemId: SOURCE_1, offerType: "read" }, { novelSourceItemId: SOURCE_2, offerType: "read" }] }),
      APPLY_ENABLED_ENV,
    );
    expect(result).toMatchObject({ status: "enqueued", eligibleCount: 1, skipReasonCounts: { item_already_active_elsewhere: 1 } });
  });

  it("allows two tasks scoped to different, non-overlapping items to both be active", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const prisma = db.asPrismaClient();
    const first = await createPromoLinkClaimTask(prisma, baseInput({ items: [{ novelSourceItemId: SOURCE_1, offerType: "read" }] }), APPLY_ENABLED_ENV);
    const second = await createPromoLinkClaimTask(
      prisma,
      baseInput({ items: [{ novelSourceItemId: SOURCE_2, offerType: "read" }], requestToken: "request-token-2" }),
      APPLY_ENABLED_ENV,
    );
    expect(first.status).toBe("enqueued");
    expect(second.status).toBe("enqueued");
    expect(db.tasks.size).toBe(2);
  });
});

describe("P0-S5 promo-link claim task factory — explicit selection only", () => {
  it("rejects an empty item list", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    await expect(createPromoLinkClaimTask(db.asPrismaClient(), baseInput({ items: [] }), APPLY_ENABLED_ENV)).rejects.toThrow(
      PromoLinkClaimTaskInputError,
    );
  });

  it("rejects a batch larger than the configured cap", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const items = Array.from({ length: PROMO_LINK_CLAIM_LIMITS.maxBatchSize + 1 }, (_, index) => ({
      novelSourceItemId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      offerType: "read",
    }));
    await expect(createPromoLinkClaimTask(db.asPrismaClient(), baseInput({ items }), APPLY_ENABLED_ENV)).rejects.toThrow("batch_size_exceeded");
  });

  it("skips ineligible items (unlinked/deleted) individually rather than failing the whole batch", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    db.seedSourceItem({ id: SOURCE_PENDING, channelAppId: "app-1", novelId: null, status: "pending", deletedAt: null });
    const result = await createPromoLinkClaimTask(
      db.asPrismaClient(),
      baseInput({ items: [{ novelSourceItemId: SOURCE_1, offerType: "read" }, { novelSourceItemId: SOURCE_PENDING, offerType: "read" }] }),
      APPLY_ENABLED_ENV,
    );
    expect(result).toMatchObject({ status: "enqueued", eligibleCount: 1, skipReasonCounts: { source_not_linked: 1 } });
  });

  it("returns no_eligible_sources when every requested item is ineligible", async () => {
    const db = seedFoundation(new FakePromoLinkClaimTaskDb());
    const result = await createPromoLinkClaimTask(
      db.asPrismaClient(),
      baseInput({ items: [{ novelSourceItemId: SOURCE_MISSING, offerType: "read" }] }),
      APPLY_ENABLED_ENV,
    );
    expect(result).toMatchObject({ status: "no_eligible_sources", skipReasonCounts: { source_unlinked_or_deleted: 1 } });
    expect(db.tasks.size).toBe(0);
  });
});
