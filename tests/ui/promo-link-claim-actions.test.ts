import { beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({ access: vi.fn(), fresh: vi.fn() }));
const batch = vi.hoisted(() => ({ enqueue: vi.fn(), summary: vi.fn() }));
const flags = vi.hoisted(() => ({ feature: true, write: true }));
const db = vi.hoisted(() => ({ channelApp: { findFirst: vi.fn() }, articleTemplate: { findFirst: vi.fn() }, novelSourceItem: { findMany: vi.fn() } }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => "https://admin.example" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireAdminActionAccess: guards.access, requireFreshAdminServiceMutation: guards.fresh }));
vi.mock("@/lib/tasks/catalog-batch", async (original) => ({ ...(await original<typeof import("@/lib/tasks/catalog-batch")>()), enqueueCatalogBatch: batch.enqueue }));
vi.mock("@/server/catalog-batch", () => ({ readCatalogBatchContext: vi.fn(), readCatalogBatchSummary: batch.summary }));
vi.mock("@/lib/flags", () => ({ isNovelCatalogSyncEnabled: () => true, isNovelCatalogSyncWriteAllowed: () => true, isPromoLinkClaimEnabled: () => flags.feature, isPromoLinkClaimWriteAllowed: () => flags.write }));
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: db, guardDependencies: () => ({ identities: "i", sessions: "s" }), canonicalOrigin: async () => "https://admin.example", readSessionToken: async () => "session" }));
vi.mock("@/server/content-creation", () => {
  class ContentCreationInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContentCreationInputError";
      this.code = code;
    }
  }
  return {
    ContentCreationInputError,
    materializeNovelFromSourceItem: vi.fn(),
    createContentFromSourceItem: vi.fn(),
  };
});
vi.mock("@/lib/tasks/moboreader", () => ({ MoboreaderTaskInputError: class extends Error {}, createMoboreaderCatalogScanTask: vi.fn(), resolveMoboreaderCatalogSafetyMaxPages: () => 1, resolveMoboreaderUpstreamRecommendedPageSize: () => 1 }));

const { enqueuePromoLinkClaimAction, applyContentCreationBatchAction } = await import("@/app/(admin)/catalog-sync/_actions");
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const explicit = { scope: "explicit_ids", ids: [B, A] } as const;
const filtered = { scope: "all_filtered", filter: { status: "linked", search: " x ", sourceLocale: "en" } } as const;

beforeEach(() => {
  vi.clearAllMocks(); flags.feature = true; flags.write = true;
  guards.access.mockResolvedValue({ context: { identity: { id: "actor" } }, serviceAuthorization: { ticket: true } });
  guards.fresh.mockResolvedValue({ identity: { id: "actor" } });
  db.channelApp.findFirst.mockResolvedValue({ id: A }); db.articleTemplate.findFirst.mockResolvedValue({ id: A });
  batch.enqueue.mockImplementation(async (_db, _input, _now, _enabled, validate) => {
    await validate?.(db);
    return { taskId: B, taskStatus: "pending", duplicate: false };
  });
});

describe("catalog batch mutation actions", () => {
  it("does not enqueue when initial or fresh authorization fails", async () => {
    guards.access.mockRejectedValueOnce(new Error("denied"));
    expect((await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "r1" })).ok).toBe(false);
    guards.fresh.mockRejectedValueOnce(new Error("revoked"));
    expect((await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "r2" })).ok).toBe(false);
    expect(batch.enqueue).not.toHaveBeenCalled();
  });
  it("uses promo capability, validates binding, and ignores malicious mode", async () => {
    await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "r3", mode: "dry_run" } as never);
    expect(guards.access).toHaveBeenCalledWith(expect.objectContaining({ actionId: "admin.promo_link_claim.enqueue", sessionToken: "session", origin: "https://admin.example", requestId: "r3" }), expect.anything());
    expect(guards.fresh).toHaveBeenCalledWith(expect.anything(), "promo:claim", expect.objectContaining({ entryId: "admin.promo_link_claim.enqueue", requestId: "r3" }));
    expect(db.channelApp.findFirst).toHaveBeenCalled();
    expect(batch.enqueue).toHaveBeenCalledWith(db, expect.objectContaining({ operation: "promo_claim", selection: { scope: "explicit_ids", ids: [A, B] } }), expect.any(Date), true, expect.any(Function));
  });
  it("preserves all_filtered as an O(1) snapshot enqueue", async () => {
    await enqueuePromoLinkClaimAction({ selection: filtered, channelAccounts: { [A]: B }, requestId: "r4" });
    expect(batch.enqueue).toHaveBeenCalledWith(db, expect.objectContaining({ selection: { scope: "all_filtered", filter: { status: "linked", search: "x", sourceLocale: "en" } } }), expect.any(Date), true, expect.any(Function));
    expect(db.novelSourceItem.findMany).not.toHaveBeenCalled();
  });
  it("stores a disabled parent when a promo safety flag is off", async () => {
    flags.write = false; batch.enqueue.mockResolvedValueOnce({ taskId: B, taskStatus: "disabled", duplicate: false });
    expect(await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "r5" })).toEqual({ ok: true, data: { taskId: B, phase: "disabled" } });
    expect(batch.enqueue).toHaveBeenCalledWith(db, expect.anything(), expect.any(Date), false, expect.any(Function));
  });
  it("rejects an invalid account binding", async () => {
    db.channelApp.findFirst.mockResolvedValueOnce(null);
    expect(await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "r6" })).toMatchObject({ ok: false, code: "channel_account_binding_invalid" });
    expect(db.channelApp.findFirst).toHaveBeenCalled();
  });
  it("canonicalizes account ids before both validation and enqueue", async () => {
    await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [` ${A} `]: ` ${B} ` }, requestId: "trimmed-account" });
    expect(db.channelApp.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: A, channel: expect.objectContaining({ channelAccounts: { some: expect.objectContaining({ id: B }) } }) }),
    }));
    expect(batch.enqueue).toHaveBeenCalledWith(db, expect.objectContaining({ channelAccounts: { [A]: B } }), expect.any(Date), true, expect.any(Function));
  });
  it.each([explicit, filtered])("content apply enqueues novel_materialize without templates", async (selection) => {
    await applyContentCreationBatchAction({ selection, requestId: "r7" });
    expect(guards.fresh).toHaveBeenCalledWith(expect.anything(), "content:publish", expect.anything());
    expect(batch.enqueue).toHaveBeenCalledWith(db, expect.objectContaining({ operation: "novel_materialize" }), expect.any(Date), true);
    expect(db.novelSourceItem.findMany).not.toHaveBeenCalled();
  });
  it("rejects leftover template maps from old pages", async () => {
    expect(await applyContentCreationBatchAction({ selection: explicit, templateKeysByLocale: { en: "missing" }, requestId: "r8" })).toMatchObject({ ok: false, code: "legacy_template_on_materialize" });
    expect(batch.enqueue).not.toHaveBeenCalled();
  });
  it("uses stored task state on request-id replay", async () => {
    batch.enqueue.mockResolvedValueOnce({ taskId: B, taskStatus: "completed", duplicate: true });
    batch.summary.mockResolvedValueOnce({ taskId: B, phase: "completed", submittedCount: 2, ineligibleCount: 0 });
    expect(await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "same" })).toEqual({ ok: true, data: { taskId: B, phase: "completed" } });
  });
  it("returns a replay even after its account becomes unavailable", async () => {
    batch.enqueue.mockResolvedValueOnce({ taskId: B, taskStatus: "pending", duplicate: true });
    db.channelApp.findFirst.mockResolvedValueOnce(null);
    expect(await enqueuePromoLinkClaimAction({ selection: explicit, channelAccounts: { [A]: B }, requestId: "lost-ack" })).toEqual({ ok: true, data: { taskId: B, phase: "queued" } });
    expect(db.channelApp.findFirst).not.toHaveBeenCalled();
  });
  it("rejects reuse of a request id with a different payload", async () => {
    const { CatalogBatchInputError } = await import("@/lib/tasks/catalog-batch");
    batch.enqueue.mockRejectedValueOnce(new CatalogBatchInputError("request_replay_mismatch"));
    expect(await enqueuePromoLinkClaimAction({ selection: filtered, channelAccounts: { [A]: B }, requestId: "same" }))
      .toMatchObject({ ok: false, kind: "invalid_input", code: "request_replay_mismatch" });
  });
});
