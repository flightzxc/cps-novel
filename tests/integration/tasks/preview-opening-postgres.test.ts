/**
 * Real-Postgres acceptance for `scripts/preview-opening.ts` — the two ops
 * subcommands ("试读正式开放" 开发阶段) that clear v0.4.5's predecessor's
 * ~80k never-attempted preview backlog (`cancel-backlog`) and backfill
 * previews for `novel_article`s that reached `published` before v0.4.5's
 * publish-triggered preview path existed (`enqueue-published`).
 *
 * Gated the same way every other `*_DATABASE_TEST`-style suite in this repo
 * is: a no-op under plain `npm test` (no live Postgres needed — only the
 * pure argv-parsing `describe` block below runs then), and only runs against
 * a real, disposable instance when `PREVIEW_OPENING_DATABASE_TEST=1` plus
 * `PREVIEW_OPENING_OWNER_DATABASE_URL`/`PREVIEW_OPENING_WEB_DATABASE_URL` are
 * set (see `scripts/run-preview-opening-postgres-verification.sh`).
 *
 * Two Prisma clients, exactly like `publication-preview-postgres.test.ts`:
 * `owner` (`migration_owner`, unrestricted — fixture setup and assertions)
 * and `web` (`web_app` — what every `preview-opening.ts` call under test
 * actually runs as, matching production: `abortTask` and
 * `enqueuePublicationPreviews` both already execute inside the Web tier's
 * own `web_app` connection).
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPublishTransition } from "@/server/publish-gate/service";
import { enqueuePublicationPreviews } from "@/server/publication/preview-enqueue";
import { abortTask, TASK_ABORT_AUDIT_ACTION, TASK_ABORT_TERMINATION_REASON } from "@/server/task-admin";

import { issueTaskAuthorization, newStores, NOW, seedTaskAdmin } from "../../backend/task-admin/test-support";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";

import {
  CANCEL_BACKLOG_AUDIT_ACTION,
  CANCEL_BACKLOG_CONFIRM_PHRASE,
  CANCEL_BACKLOG_TERMINATION_REASON_CODE,
  computeCancelBacklogStats,
  computeEnqueuePublishedStats,
  ENQUEUE_PUBLISHED_CONFIRM_PHRASE,
  parseCancelBacklogApplyOptions,
  parseCancelBacklogFilters,
  parseEnqueuePublishedApplyOptions,
  PreviewOpeningError,
  runCancelBacklogApply,
  runCancelBacklogStats,
  runEnqueuePublishedApply,
} from "../../../scripts/preview-opening";

vi.mock("@/server/publication/revalidate", () => ({
  revalidatePublicArticlePaths: vi.fn(), revalidatePublicArticleSet: vi.fn(), revalidatePublicBlogPaths: vi.fn(),
}));

const enabled = process.env.PREVIEW_OPENING_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.PREVIEW_OPENING_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.PREVIEW_OPENING_WEB_DATABASE_URL });

const BACKLOG_TASK_TYPE = "moboreader.preview_refresh.v1";
const env = {
  NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
} satisfies NodeJS.ProcessEnv;
const actor = { type: "system", source: "preview-opening-test" } as const;

let foundation: { channel: string; app: string; account: string; secondAccount: string };

function freshScopeHash(): string {
  return randomUUID().replaceAll("-", "").padEnd(64, "0");
}

async function truncateDatabase(): Promise<void> {
  const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

async function createAccount(channelId: string): Promise<string> {
  const account = await owner.channelAccount.create({ data: { channelId, businessId: randomUUID(), accountName: "local" } });
  const credentialId = randomUUID();
  await owner.channelAccountCredential.create({
    data: {
      id: credentialId, channelAccountId: account.id,
      encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("local-only-token", account.id, credentialId, 1)),
      keyVersion: 1, secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`, fingerprintPrefix: "aaaaaaaaaaaa", status: "active",
    },
  });
  return account.id;
}

async function seedFoundation(): Promise<void> {
  const channel = await owner.channel.create({ data: { code: `ch-${randomUUID()}`, name: "local" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: "moboreader", name: "local" } });
  const app = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "local", projectType: 1 } });
  foundation = { channel: channel.id, app: app.id, account: await createAccount(channel.id), secondAccount: await createAccount(channel.id) };
}

/** Mirrors `publication-preview-postgres.test.ts`'s own `seed()` helper. */
async function seedArticle(ordinal: number, accountId = foundation.account, published = false) {
  const suffix = randomUUID().replaceAll("-", "");
  const novel = await owner.novel.create({ data: { businessId: suffix, title: `Novel ${ordinal}`, description: "Fixture", locale: "en", slug: suffix, status: published ? "published" : "ready" } });
  const source = await owner.novelSourceItem.create({ data: { novelId: novel.id, channelAppId: foundation.app, externalBookId: suffix, externalAgencyId: "agency", sourceLanguageCode: "2", title: novel.title, description: "Fixture", status: "linked", rawPayload: { agencyId: "agency", seriesId: suffix, language: "2", projectType: 1, allEpis: 3, payEpisFrom: 2 } } });
  const promo = await owner.promoLink.create({ data: { novelId: novel.id, novelSourceItemId: source.id, channelAppId: foundation.app, channelAccountId: accountId, offerType: "read", publicRedirectCode: suffix, idempotencyKey: suffix.padEnd(64, "0"), webUrl: "https://local.example/read", status: "fetched" } });
  const article = await owner.article.create({ data: { novelId: novel.id, promoLinkId: promo.id, locale: "en", slug: suffix, publicPageShortId: suffix.slice(0, 12), title: novel.title, body: "Fixture body", status: published ? "published" : "draft", publishedAt: published ? new Date() : null } });
  return { novel, source, promo, article };
}

/** A `channel_sync_task` shaped like the pre-v0.4.5 preview backlog: `moboreader.preview_refresh.v1`, `pending`, `params.trigger = "auto"`, never attempted. Each item needs its own real `novel_source_item` row (FK). */
async function seedBacklogTask(input: {
  taskType?: string; status?: string; trigger?: string; createdAt: Date;
  channelAccountId?: string; channelAppId?: string; itemCount?: number;
}): Promise<{ taskId: string; itemIds: string[] }> {
  const taskType = input.taskType ?? BACKLOG_TASK_TYPE;
  const status = input.status ?? "pending";
  const trigger = input.trigger ?? "auto";
  const channelAccountId = input.channelAccountId ?? foundation.account;
  const channelAppId = input.channelAppId ?? foundation.app;
  const itemCount = input.itemCount ?? 1;
  const sourceItemIds: string[] = [];
  for (let i = 0; i < itemCount; i += 1) {
    const suffix = randomUUID().replaceAll("-", "");
    const novel = await owner.novel.create({ data: { businessId: suffix, title: `Backlog ${suffix}`, description: "Fixture", locale: "en", slug: suffix, status: "ready" } });
    const source = await owner.novelSourceItem.create({ data: { novelId: novel.id, channelAppId, externalBookId: suffix, sourceLanguageCode: "2", title: novel.title, description: "Fixture", status: "linked", rawPayload: {} } });
    sourceItemIds.push(source.id);
  }
  const task = await owner.channelSyncTask.create({
    data: {
      taskType, channelAccountId, channelAppId, operationScopeHash: freshScopeHash(), mode: "apply", status,
      requestToken: randomUUID(), totalCount: itemCount, params: { trigger }, createdAt: input.createdAt,
      items: { create: sourceItemIds.map((novelSourceItemId) => ({ novelSourceItemId, payload: { trigger, actorId: "seed", requestId: "seed" } })) },
    },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  return { taskId: task.id, itemIds: task.items.map((item) => item.id) };
}

async function tableCounts(): Promise<Record<string, number>> {
  const [csTask, csItem, audit, article, promo, novel, sourceItem] = await Promise.all([
    owner.channelSyncTask.count(), owner.channelSyncTaskItem.count(), owner.operationAudit.count(),
    owner.article.count(), owner.promoLink.count(), owner.novel.count(), owner.novelSourceItem.count(),
  ]);
  return { channelSyncTask: csTask, channelSyncTaskItem: csItem, operationAudit: audit, article, promoLink: promo, novel, novelSourceItem: sourceItem };
}

async function channelSyncTaskStatus(taskId: string): Promise<string> {
  return (await owner.channelSyncTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}
async function channelSyncItemRow(itemId: string) {
  return owner.channelSyncTaskItem.findUniqueOrThrow({ where: { id: itemId } });
}

/** A fresh admin ticket for `abortTask`, backed by an in-memory identity/session store, running against the real `web_app` connection — same pattern `tests/integration/tasks/x10-task-control-postgres.test.ts`'s own `ticketFor` uses. */
async function abortTicket() {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
  return { ...ticket, dependencies: { db: web, identities: stores, sessions: stores, now: NOW } };
}

// ---------------------------------------------------------------------------
// Pure argv-parsing tests — no database required, always collected by `npm
// test`.
// ---------------------------------------------------------------------------
describe("preview-opening argv parsing (no database)", () => {
  const validCancelArgv = [
    "--task-type", "moboreader.preview_refresh.v1", "--status", "pending", "--trigger", "auto",
    "--created-from", "2026-09-23T00:00:00.000Z", "--created-to", "2026-09-23T06:00:00.000Z",
  ];

  it("accepts a fully-specified cancel-backlog filter set", () => {
    const filters = parseCancelBacklogFilters(validCancelArgv);
    expect(filters.taskType).toBe("moboreader.preview_refresh.v1");
    expect(filters.createdFrom.toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  for (const flag of ["--task-type", "--status", "--trigger", "--created-from", "--created-to"]) {
    it(`refuses cancel-backlog when ${flag} is missing`, () => {
      const index = validCancelArgv.indexOf(flag);
      const argv = [...validCancelArgv.slice(0, index), ...validCancelArgv.slice(index + 2)];
      expect(() => parseCancelBacklogFilters(argv)).toThrow(PreviewOpeningError);
      try {
        parseCancelBacklogFilters(argv);
      } catch (error) {
        expect((error as PreviewOpeningError).code).toBe("missing_argument");
        expect((error as PreviewOpeningError).detail).toMatchObject({ flag });
      }
    });
  }

  it("refuses an unparseable --created-from", () => {
    const argv = [...validCancelArgv];
    argv[argv.indexOf("--created-from") + 1] = "not-a-date";
    expect(() => parseCancelBacklogFilters(argv)).toThrow(PreviewOpeningError);
  });

  const validApplyArgv = [
    ...validCancelArgv, "--expect-count", "3", "--confirm", CANCEL_BACKLOG_CONFIRM_PHRASE,
    "--request-id", "req-1", "--reason", "test", "--limit", "500",
  ];

  it("accepts a fully-specified cancel-backlog apply", () => {
    const options = parseCancelBacklogApplyOptions(validApplyArgv);
    expect(options).toMatchObject({ expectCount: 3, requestId: "req-1", reason: "test", limit: 500 });
  });

  it("refuses cancel-backlog apply when --expect-count is missing", () => {
    const argv = validApplyArgv.filter((_, i) => !(validApplyArgv[i - 1] === "--expect-count" || validApplyArgv[i] === "--expect-count"));
    expect(() => parseCancelBacklogApplyOptions(argv)).toThrow(PreviewOpeningError);
  });

  it("refuses cancel-backlog apply when --confirm does not match the exact phrase", () => {
    const argv = [...validApplyArgv];
    argv[argv.indexOf("--confirm") + 1] = "yes-please";
    expect(() => parseCancelBacklogApplyOptions(argv)).toThrow(PreviewOpeningError);
  });

  it("refuses cancel-backlog apply when --limit is not a positive integer", () => {
    const argv = [...validApplyArgv];
    argv[argv.indexOf("--limit") + 1] = "0";
    expect(() => parseCancelBacklogApplyOptions(argv)).toThrow(PreviewOpeningError);
  });

  it("refuses enqueue-published apply when --confirm does not match", () => {
    expect(() => parseEnqueuePublishedApplyOptions(["--confirm", "nope", "--request-id", "r", "--reason", "x"]))
      .toThrow(PreviewOpeningError);
  });

  it("refuses enqueue-published apply when --request-id or --reason is missing", () => {
    expect(() => parseEnqueuePublishedApplyOptions(["--confirm", ENQUEUE_PUBLISHED_CONFIRM_PHRASE, "--reason", "x"]))
      .toThrow(PreviewOpeningError);
    expect(() => parseEnqueuePublishedApplyOptions(["--confirm", ENQUEUE_PUBLISHED_CONFIRM_PHRASE, "--request-id", "r"]))
      .toThrow(PreviewOpeningError);
  });

  it("accepts a fully-specified enqueue-published apply", () => {
    const options = parseEnqueuePublishedApplyOptions(["--confirm", ENQUEUE_PUBLISHED_CONFIRM_PHRASE, "--request-id", "r", "--reason", "x"]);
    expect(options).toEqual({ requestId: "r", reason: "x" });
  });
});

// ---------------------------------------------------------------------------
// cancel-backlog — real Postgres
// ---------------------------------------------------------------------------
describe.skipIf(!enabled).sequential("preview-opening · cancel-backlog (real Postgres)", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!database!.name.startsWith("cps_novel_preview_opening_")) {
      throw new Error(`Refusing preview-opening setup against ${database!.name}`);
    }
  });
  beforeEach(async () => { await truncateDatabase(); await seedFoundation(); });
  afterAll(async () => { await Promise.all([owner.$disconnect(), web.$disconnect()]); });

  const WINDOW_FROM = new Date("2026-09-23T02:00:00.000Z");
  const WINDOW_TO = new Date("2026-09-23T05:00:00.000Z");
  const filters = { taskType: BACKLOG_TASK_TYPE, status: "pending", trigger: "auto", createdFrom: WINDOW_FROM, createdTo: WINDOW_TO };

  it("stats is read-only and exactly matches the scoped tasks", async () => {
    const inWindow1 = await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), itemCount: 2 });
    const inWindow2 = await seedBacklogTask({ createdAt: new Date("2026-09-23T04:00:00.000Z"), itemCount: 1, channelAccountId: foundation.secondAccount });
    // Controls: each differs from the scope by exactly one filter dimension.
    await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), taskType: "moboreader.catalog_scan.v1" });
    await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), status: "completed" });
    await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), trigger: "manual" });
    await seedBacklogTask({ createdAt: new Date("2026-09-23T01:00:00.000Z") }); // before the window
    await seedBacklogTask({ createdAt: new Date("2026-09-23T06:00:00.000Z") }); // after the window

    const before = await tableCounts();
    const stats = await runCancelBacklogStats(web, filters);
    const after = await tableCounts();
    expect(after).toEqual(before);

    expect(stats.taskCount).toBe(2);
    expect(stats.processingItemCount).toBe(0);
    expect(stats.itemStatusCounts).toEqual({ pending: 3 });
    expect(stats.earliestCreatedAt).toBe("2026-09-23T02:30:00.000Z");
    expect(stats.latestCreatedAt).toBe("2026-09-23T04:00:00.000Z");
    expect(new Set(stats.byAccountApp.map((g) => g.channelAccountId))).toEqual(new Set([foundation.account, foundation.secondAccount]));
    expect(stats.byAccountApp.find((g) => g.channelAccountId === foundation.account)).toMatchObject({ taskCount: 1 });
    void inWindow1; void inWindow2;
  });

  it("refuses both stats and apply against a non-web_app role", async () => {
    await expect(runCancelBacklogStats(owner, filters)).rejects.toMatchObject({ code: "wrong_database_role" });
    await expect(runCancelBacklogApply(owner, { filters, expectCount: 0, requestId: "r", reason: "x", limit: 10 }))
      .rejects.toMatchObject({ code: "wrong_database_role" });
  });

  it("apply refuses on an expect-count mismatch, with zero writes", async () => {
    await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z") });
    const before = await tableCounts();
    const result = await runCancelBacklogApply(web, { filters, expectCount: 999, requestId: "r", reason: "x", limit: 10 });
    expect(result.refused).toBe("expect_count_mismatch");
    expect(result.cancelledTaskCount).toBe(0);
    expect(await tableCounts()).toEqual(before);
  });

  it("apply refuses outright when any matched task has a processing item, with zero writes", async () => {
    const a = await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), itemCount: 1 });
    await seedBacklogTask({ createdAt: new Date("2026-09-23T03:00:00.000Z"), itemCount: 1 });
    await owner.channelSyncTaskItem.update({ where: { id: a.itemIds[0] }, data: { status: "processing", lockedBy: "probe", lockedUntil: new Date(Date.now() + 60_000), executionToken: randomUUID() } });
    const before = await tableCounts();
    const stats = await computeCancelBacklogStats(web, filters);
    expect(stats.processingItemCount).toBe(1);
    const result = await runCancelBacklogApply(web, { filters, expectCount: stats.taskCount, requestId: "r", reason: "x", limit: 10 });
    expect(result.refused).toBe("processing_items_present");
    expect(await tableCounts()).toEqual(before);
    expect(await channelSyncTaskStatus(a.taskId)).toBe("pending");
  });

  it("apply cancels every matched task across multiple batches, terminates pending items with the right reason, audits once per task, and leaves out-of-scope tasks untouched", async () => {
    const matched = [
      await seedBacklogTask({ createdAt: new Date("2026-09-23T02:10:00.000Z"), itemCount: 2 }),
      await seedBacklogTask({ createdAt: new Date("2026-09-23T02:20:00.000Z"), itemCount: 1 }),
      await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), itemCount: 3 }),
    ];
    const control = await seedBacklogTask({ createdAt: new Date("2026-09-23T02:15:00.000Z"), trigger: "manual", itemCount: 1 });

    const stats = await computeCancelBacklogStats(web, filters);
    expect(stats.taskCount).toBe(3);
    const requestId = `req-${randomUUID()}`;
    const result = await runCancelBacklogApply(web, { filters, expectCount: 3, requestId, reason: "clear pre-v0.4.5 backlog", limit: 2 });

    expect(result.refused).toBeNull();
    expect(result.cancelledTaskCount).toBe(3);
    expect(result.terminatedItemCount).toBe(6);
    expect(result.batches).toBeGreaterThanOrEqual(2); // limit=2 over 3 tasks forces >=2 batches

    for (const task of matched) {
      expect(await channelSyncTaskStatus(task.taskId)).toBe("cancelled");
      for (const itemId of task.itemIds) {
        const item = await channelSyncItemRow(itemId);
        expect(item.status).toBe("skipped");
        expect((item.error as { code?: string } | null)?.code).toBe(CANCEL_BACKLOG_TERMINATION_REASON_CODE);
        expect(item.finishedAt).not.toBeNull();
      }
      const audits = await owner.operationAudit.findMany({ where: { entityId: task.taskId, action: CANCEL_BACKLOG_AUDIT_ACTION } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: "system", actorId: null, entityType: "Task", taskType: "channel_sync", taskId: task.taskId,
        requestId: `${requestId}:${task.taskId}`, reason: "clear pre-v0.4.5 backlog",
      });
      expect(audits[0]!.beforeSnapshot).toMatchObject({ status: "pending" });
      expect(audits[0]!.afterSnapshot).toMatchObject({ status: "cancelled" });
    }

    // Out of scope: untouched.
    expect(await channelSyncTaskStatus(control.taskId)).toBe("pending");
    expect((await channelSyncItemRow(control.itemIds[0]!)).status).toBe("pending");
    expect(await owner.operationAudit.count({ where: { action: CANCEL_BACKLOG_AUDIT_ACTION } })).toBe(3);
  });

  it("re-running to completion never writes a duplicate audit and only ever touches what is left", async () => {
    for (let i = 0; i < 4; i += 1) await seedBacklogTask({ createdAt: new Date("2026-09-23T02:1" + i + ":00.000Z") });
    const requestId = `req-${randomUUID()}`;
    const first = await runCancelBacklogApply(web, { filters, expectCount: 4, requestId, reason: "first pass", limit: 100 });
    expect(first).toMatchObject({ refused: null, cancelledTaskCount: 4 });
    expect(await owner.operationAudit.count({ where: { action: CANCEL_BACKLOG_AUDIT_ACTION } })).toBe(4);

    // Re-running against the now-empty scope is a clean no-op, not a refusal.
    const second = await runCancelBacklogApply(web, { filters, expectCount: 0, requestId, reason: "second pass", limit: 100 });
    expect(second).toMatchObject({ refused: null, cancelledTaskCount: 0, batches: 0 });
    expect(await owner.operationAudit.count({ where: { action: CANCEL_BACKLOG_AUDIT_ACTION } })).toBe(4);
  });

  it("produces the same cancelled-task / terminated-item / audit shape abortTask itself produces, differing only in the documented actor fields", async () => {
    // Both fixtures are shaped exactly like the real backlog: every item
    // still `pending`, nothing ever claimed -- deliberately not mirroring
    // abortTask's own richer "some items already success/failed" acceptance
    // test, because that shape can never occur for a `--status pending`
    // cancel-backlog scope in the first place (this tool always filters on
    // `status = 'pending'`, and once a channel_sync_task item is claimed the
    // parent's own recompute moves the *parent* to `processing`, which the
    // filter and this tool's own processing-item guard both refuse anyway).
    const a = await seedBacklogTask({ createdAt: new Date("2026-09-23T02:30:00.000Z"), itemCount: 3 });
    const ticket = await abortTicket();
    const abortResult = await abortTask({ ...ticket, family: "channel_sync", taskId: a.taskId, reason: "equivalence probe" }, ticket.dependencies);
    expect(abortResult).toMatchObject({ status: "cancelled", terminatedPendingItemCount: 3 });

    // Fixture B: cancelled through this script, scoped to a task type unique to this test so the filter matches only it.
    const uniqueTaskType = `x-equiv-${randomUUID()}`;
    const b = await seedBacklogTask({ taskType: uniqueTaskType, createdAt: new Date("2026-09-23T02:30:00.000Z"), itemCount: 3 });
    const scriptResult = await runCancelBacklogApply(web, {
      filters: { taskType: uniqueTaskType, status: "pending", trigger: "auto", createdFrom: new Date("2026-09-23T02:00:00.000Z"), createdTo: new Date("2026-09-23T03:00:00.000Z") },
      expectCount: 1, requestId: `req-${randomUUID()}`, reason: "equivalence probe", limit: 10,
    });
    expect(scriptResult).toMatchObject({ refused: null, cancelledTaskCount: 1, terminatedItemCount: 3 });

    // Same task-level outcome.
    expect(await channelSyncTaskStatus(a.taskId)).toBe("cancelled");
    expect(await channelSyncTaskStatus(b.taskId)).toBe("cancelled");

    // Same item-level outcome shape for every item: terminal `skipped`, a
    // {code, message} error -- codes differ by design (see this script's own
    // header comment) but the shape matches.
    for (const itemId of a.itemIds) {
      const row = await channelSyncItemRow(itemId);
      expect(row.status).toBe("skipped");
      expect(row.finishedAt).not.toBeNull();
      expect((row.error as { code: string }).code).toBe(TASK_ABORT_TERMINATION_REASON);
    }
    for (const itemId of b.itemIds) {
      const row = await channelSyncItemRow(itemId);
      expect(row.status).toBe("skipped");
      expect(row.finishedAt).not.toBeNull();
      expect((row.error as { code: string }).code).toBe(CANCEL_BACKLOG_TERMINATION_REASON_CODE);
    }
    expect(TASK_ABORT_TERMINATION_REASON).not.toBe(CANCEL_BACKLOG_TERMINATION_REASON_CODE);

    // Same audit shape, differing only in the documented actor fields.
    const auditA = await owner.operationAudit.findFirstOrThrow({ where: { entityId: a.taskId, action: TASK_ABORT_AUDIT_ACTION } });
    const auditB = await owner.operationAudit.findFirstOrThrow({ where: { entityId: b.taskId, action: CANCEL_BACKLOG_AUDIT_ACTION } });
    for (const audit of [auditA, auditB]) {
      expect(audit.entityType).toBe("Task");
      expect(audit.taskType).toBe("channel_sync");
      expect(audit.beforeSnapshot).toMatchObject({ status: "pending" });
      expect(audit.afterSnapshot).toMatchObject({ status: "cancelled", terminatedPendingItemCount: 3 });
    }
    expect(auditA.actorType).toBe("admin");
    expect(auditB.actorType).toBe("system");
    expect(auditB.actorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enqueue-published — real Postgres
// ---------------------------------------------------------------------------
describe.skipIf(!enabled).sequential("preview-opening · enqueue-published (real Postgres)", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!database!.name.startsWith("cps_novel_preview_opening_")) {
      throw new Error(`Refusing preview-opening setup against ${database!.name}`);
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value!);
  });
  beforeEach(async () => { await truncateDatabase(); await seedFoundation(); });
  afterAll(async () => { vi.unstubAllEnvs(); await Promise.all([owner.$disconnect(), web.$disconnect()]); });

  it("stats is read-only and matches article-level admission/grouping exactly", async () => {
    const first = await seedArticle(0, foundation.account, true);
    const second = await seedArticle(1, foundation.secondAccount, true);
    // Same book, second locale -- deduped to one book.
    await owner.article.create({ data: { novelId: first.novel.id, promoLinkId: first.promo.id, locale: "ko", slug: randomUUID(), publicPageShortId: randomUUID().slice(0, 12), title: "locale", body: "body", status: "published", publishedAt: new Date() } });
    // Draft: not public, excluded entirely.
    await seedArticle(2, foundation.account, false);
    // Published but promo not ready: skipped with a reason.
    const badPromo = await seedArticle(3, foundation.account, true);
    await owner.promoLink.update({ where: { id: badPromo.promo.id }, data: { webUrl: "   ", appUrl: null } });

    const before = await tableCounts();
    const stats = await computeEnqueuePublishedStats(web, env);
    expect(await tableCounts()).toEqual(before);

    expect(stats.articleCount).toBe(4); // first + its ko locale + second + badPromo (draft excluded by buildPublicArticleWhere)
    expect(stats.distinctNovelCount).toBe(2); // first's book (deduped across locales) + second's book; badPromo's book skipped
    expect(stats.skipReasonCounts).toMatchObject({ promo_not_ready: 1 });
    expect(new Set(stats.groups.map((g) => g.channelAccountId))).toEqual(new Set([foundation.account, foundation.secondAccount]));
  });

  it("refuses both stats and apply against a non-web_app role", async () => {
    await expect(computeEnqueuePublishedStats(owner, env)).rejects.toMatchObject({ code: "wrong_database_role" });
    await expect(runEnqueuePublishedApply(owner, { requestId: "r", reason: "x" }, env)).rejects.toMatchObject({ code: "wrong_database_role" });
  });

  it("apply produces the exact same task shape a live publish-time trigger would produce for the same article", async () => {
    // Scenario 1: already published before this tool ever runs (the true
    // backfill shape -- `enqueue-published` is what discovers it).
    const backfilled = await seedArticle(0, foundation.account, true);
    const applyResult = await runEnqueuePublishedApply(web, { requestId: `req-${randomUUID()}`, reason: "backfill" }, env);
    expect(applyResult.plan.articleCount).toBe(1);
    expect(applyResult.groupsQueued).toBe(1);
    const backfilledTask = await owner.channelSyncTask.findFirstOrThrow({ where: { taskType: "moboreader.preview_refresh.v1" } });
    expect(backfilledTask).toMatchObject({ taskType: "moboreader.preview_refresh.v1", mode: "apply", channelAccountId: foundation.account, channelAppId: foundation.app, totalCount: 1, status: "pending" });
    expect(backfilledTask.params).toMatchObject({ trigger: "auto" });
    void backfilled;

    // Scenario 2: an equivalent draft, published live through the real
    // publish-gate path (this is what "发布时触发" actually calls).
    await truncateDatabase();
    await seedFoundation();
    const draft = await seedArticle(0, foundation.account, false);
    expect(await web.channelSyncTask.count()).toBe(0);
    expect((await applyPublishTransition(web, { articleId: draft.article.id, requestId: randomUUID(), actor })).outcome).toBe("published");
    const liveTask = await owner.channelSyncTask.findFirstOrThrow({ where: { taskType: "moboreader.preview_refresh.v1" } });

    // Same shape -- `channelAccountId`/`channelAppId` are necessarily
    // different UUIDs (each scenario re-seeds its own fresh foundation after
    // `truncateDatabase`), so only the structural fields are compared.
    expect(liveTask).toMatchObject({ taskType: backfilledTask.taskType, mode: backfilledTask.mode, totalCount: backfilledTask.totalCount, status: backfilledTask.status });
    expect(liveTask.params).toMatchObject({ trigger: "auto" });
  });

  it("already-fresh, account-held, and in-flight books are skipped -- matching what a live trigger would also skip", async () => {
    const fresh = await seedArticle(0, foundation.account, true);
    // First call materializes the preview policy's lastRefreshedAt indirectly
    // via a direct novel_preview_policy row (no worker needed for this probe).
    await owner.novelPreviewPolicy.create({ data: { novelId: fresh.novel.id, maxMaterializedChapters: 10, lastRefreshedAt: new Date() } });

    const held = await seedArticle(1, foundation.secondAccount, true);
    await owner.channelAccountHold.create({ data: { channelAccountId: foundation.secondAccount, scope: "preview", reasonCode: "credential_validation_failed" } });

    const result = await runEnqueuePublishedApply(web, { requestId: `req-${randomUUID()}`, reason: "probe" }, env);
    expect(result.plan.articleCount).toBe(2);
    // `result.skipReasonCounts` only ever aggregates the *article-level*
    // `article_not_public` counter `enqueuePublicationPreviews` sets
    // unconditionally (see this script's `runEnqueuePublishedApply` header
    // comment) -- the group-level reasons below (`fresh_preview`,
    // `system_hold`) live on each group's own nested `result`, exactly like
    // `publication-preview-postgres.test.ts`'s own assertions read them.
    const freshGroup = result.results.find((r) => r.channelAccountId === foundation.account);
    expect(freshGroup?.result).toMatchObject({ status: "no_eligible_sources", skipReasonCounts: { fresh_preview: 1 } });
    const heldGroup = result.results.find((r) => r.channelAccountId === foundation.secondAccount);
    expect((heldGroup?.result as { taskStatus?: string })?.taskStatus).toBe("disabled");
    const heldTask = await owner.channelSyncTask.findFirstOrThrow({ where: { channelAccountId: foundation.secondAccount } });
    expect(heldTask.result).toMatchObject({ taskControl: { kind: "system_hold" } });
  });
});

// ---------------------------------------------------------------------------
// The end-to-end narrative: clearing the backlog is what lets a newly (or
// re-)published book's preview actually get enqueued, instead of silently
// reading as "already in flight" forever.
// ---------------------------------------------------------------------------
describe.skipIf(!enabled).sequential("preview-opening · clearing the backlog unblocks publish-triggered previews", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!database!.name.startsWith("cps_novel_preview_opening_")) {
      throw new Error(`Refusing preview-opening setup against ${database!.name}`);
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value!);
  });
  beforeEach(async () => { await truncateDatabase(); await seedFoundation(); });
  afterAll(async () => { vi.unstubAllEnvs(); await Promise.all([owner.$disconnect(), web.$disconnect()]); });

  it("a book stuck behind a backlog task is skipped as in-flight before cancel-backlog, and enqueues cleanly after", async () => {
    const row = await seedArticle(0, foundation.account, true);
    // A pre-v0.4.5 backlog task for the SAME book/account/app, never attempted.
    const backlog = await seedBacklogTask({
      createdAt: new Date("2026-09-23T02:30:00.000Z"), channelAccountId: foundation.account, channelAppId: foundation.app,
    });
    // Re-point the backlog item at this book's own source item so the
    // in-flight dedupe actually matches on `novelId`.
    await owner.channelSyncTaskItem.update({ where: { id: backlog.itemIds[0] }, data: { novelSourceItemId: row.source.id } });

    const before = await enqueuePublicationPreviews(web, { articleIds: [row.article.id], requestId: randomUUID(), actorId: "probe" }, env);
    // The group-level reason lives on the group's own nested `result`, not
    // the top-level `skipReasonCounts` (which only ever aggregates the
    // article-level `article_not_public` counter) -- same read
    // `publication-preview-postgres.test.ts`'s own assertions use.
    expect(before.groups[0]?.result).toMatchObject({ status: "no_eligible_sources", skipReasonCounts: { preview_in_flight: 1 } });
    expect(await owner.channelSyncTask.count({ where: { taskType: BACKLOG_TASK_TYPE, status: { not: "pending" } } })).toBe(0);

    const stats = await computeCancelBacklogStats(web, { taskType: BACKLOG_TASK_TYPE, status: "pending", trigger: "auto", createdFrom: new Date("2026-09-23T02:00:00.000Z"), createdTo: new Date("2026-09-23T03:00:00.000Z") });
    expect(stats.taskCount).toBe(1);
    const cancelled = await runCancelBacklogApply(web, {
      filters: { taskType: BACKLOG_TASK_TYPE, status: "pending", trigger: "auto", createdFrom: new Date("2026-09-23T02:00:00.000Z"), createdTo: new Date("2026-09-23T03:00:00.000Z") },
      expectCount: 1, requestId: `req-${randomUUID()}`, reason: "clear backlog", limit: 10,
    });
    expect(cancelled).toMatchObject({ refused: null, cancelledTaskCount: 1 });

    const after = await enqueuePublicationPreviews(web, { articleIds: [row.article.id], requestId: randomUUID(), actorId: "probe" }, env);
    expect(after.groups[0]?.result).toMatchObject({ status: "enqueued", taskStatus: "pending" });
    expect(after.skipReasonCounts.preview_in_flight ?? 0).toBe(0);
  });
});
