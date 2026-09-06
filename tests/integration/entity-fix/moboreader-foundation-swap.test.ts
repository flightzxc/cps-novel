import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FoundationSwapError,
  applyFoundationSwap,
  planFoundationSwap,
  rollbackFoundationSwap,
} from "../../../scripts/entity-fix/moboreader-foundation-swap";

/**
 * Phase B entity-fix — Postgres-gated integration coverage
 * (施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二 / §四).
 *
 * Same disposable-Postgres discipline as `tests/integration/tasks/
 * p2-05-postgres.test.ts` and `tests/integration/database/p1-05b-
 * postgres.test.ts`: gated behind its own env flag so a normal
 * `npm run test:backend` / `npm run test:integration` run (no live
 * Postgres) reports these as skipped, not failed. Run against a real
 * database via `scripts/run-phase-b-entity-fix-postgres-verification.sh`,
 * which provisions an isolated, disposable Postgres 16 container (its own
 * project name/port, never `cps-novel-x8-local`), migrates it, seeds a
 * fixture shaped like the real production foundation (one Channel, one
 * SourceApp, one ChannelApp, three ChannelAccounts, one row in every listed
 * foreign-key table), and sets `PHASE_B_ENTITY_FIX_DATABASE_TEST=1` plus
 * `PHASE_B_ENTITY_FIX_DATABASE_URL` before invoking vitest.
 *
 * This suite never runs against `cps-novel-x8-local` or any other running
 * stack -- see the module doc on `applyFoundationSwap`/`rollbackFoundationSwap`
 * for why that matters (this is exactly the class of script the work order
 * forbids running against the live runtime database from this task).
 */

const enabled = process.env.PHASE_B_ENTITY_FIX_DATABASE_TEST === "1";
const prisma = new PrismaClient({ datasourceUrl: process.env.PHASE_B_ENTITY_FIX_DATABASE_URL });

const ids = {
  channel: "b0000000-0000-4000-8000-000000000001",
  sourceApp: "b0000000-0000-4000-8000-000000000002",
  channelApp: "b0000000-0000-4000-8000-000000000003",
  account1: "b0000000-0000-4000-8000-000000000004",
  account2: "b0000000-0000-4000-8000-000000000005",
  account3: "b0000000-0000-4000-8000-000000000006",
  novel: "b0000000-0000-4000-8000-000000000007",
  sourceItem: "b0000000-0000-4000-8000-000000000008",
  promoLink: "b0000000-0000-4000-8000-000000000009",
  catalogScanTask: "b0000000-0000-4000-8000-00000000000a",
  channelSyncTask: "b0000000-0000-4000-8000-00000000000b",
  genericTask: "b0000000-0000-4000-8000-00000000000c",
} as const;

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

/**
 * Seeds the pre-fix (buggy) production shape: Channel is "moboreader",
 * SourceApp is "changdu" -- plus one row in every foreign-key table the
 * work order lists, so "counts unchanged" is a real assertion, not a
 * trivial 0-equals-0.
 */
async function seedPreFixFoundation() {
  await prisma.channel.create({ data: { id: ids.channel, code: "moboreader", name: "MoboReader" } });
  await prisma.sourceApp.create({ data: { id: ids.sourceApp, code: "changdu", name: "Changdu" } });
  await prisma.channelApp.create({
    data: {
      id: ids.channelApp,
      channelId: ids.channel,
      sourceAppId: ids.sourceApp,
      externalAppId: "moboreader",
      projectType: 1,
    },
  });
  await prisma.channelAccount.createMany({
    data: [
      { id: ids.account1, channelId: ids.channel, businessId: "phase-b-acct-1", accountName: "Account 1" },
      { id: ids.account2, channelId: ids.channel, businessId: "phase-b-acct-2", accountName: "Account 2" },
      { id: ids.account3, channelId: ids.channel, businessId: "phase-b-acct-3", accountName: "Account 3" },
    ],
  });
  await prisma.novelSourceItem.create({
    data: {
      id: ids.sourceItem,
      channelAppId: ids.channelApp,
      externalBookId: "book-1",
      sourceLanguageCode: "1",
      title: "Seed Novel",
      description: "seed",
      rawPayload: {},
      status: "linked",
    },
  });
  await prisma.novel.create({
    data: {
      id: ids.novel,
      businessId: "phase-b-novel-1",
      title: "Seed Novel",
      description: "seed",
      locale: "en",
      slug: "seed-novel",
      status: "draft",
    },
  });
  await prisma.promoLink.create({
    data: {
      id: ids.promoLink,
      novelId: ids.novel,
      novelSourceItemId: ids.sourceItem,
      channelAppId: ids.channelApp,
      channelAccountId: ids.account1,
      offerType: "read",
      publicRedirectCode: "PHASEB01",
      idempotencyKey: "a".repeat(64),
      status: "pending",
    },
  });
  await prisma.catalogScanTask.create({
    data: {
      id: ids.catalogScanTask,
      channelAccountId: ids.account1,
      channelAppId: ids.channelApp,
      projectType: 1,
      requestToken: `catalog-scan-${randomUUID()}`,
      pageStart: 1,
      pageEnd: 1,
      pageSize: 20,
    },
  });
  await prisma.channelSyncTask.create({
    data: {
      id: ids.channelSyncTask,
      taskType: "moboreader.preview_refresh.v1",
      channelAccountId: ids.account2,
      channelAppId: ids.channelApp,
      operationScopeHash: "b".repeat(64),
      requestToken: `channel-sync-${randomUUID()}`,
    },
  });
  await prisma.genericTask.create({
    data: {
      id: ids.genericTask,
      taskType: "promo_link.claim.v1",
      channelAccountId: ids.account3,
      channelAppId: ids.channelApp,
      operationScopeHash: "c".repeat(64),
      requestToken: `generic-${randomUUID()}`,
    },
  });
}

describe.skipIf(!enabled).sequential("Phase B entity fix — Channel/SourceApp swap (Postgres)", () => {
  beforeAll(async () => {
    const [database] = await prisma.$queryRaw<Array<{ name: string; version: string }>>`
      SELECT current_database() AS name, current_setting('server_version') AS version
    `;
    if (!database.name.includes("phase_b_entity_fix")) {
      throw new Error(`Refusing Phase B entity-fix tests against ${database.name}`);
    }
  });

  beforeEach(async () => {
    await truncateDatabase();
    await seedPreFixFoundation();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("dry-run: reports the pre-fix rows, the apply target, readyToRun=true, and writes nothing", async () => {
    const plan = await planFoundationSwap(prisma, "apply");
    expect(plan.channel).toMatchObject({ id: ids.channel, code: "moboreader", name: "MoboReader" });
    expect(plan.sourceApp).toMatchObject({ id: ids.sourceApp, code: "changdu", name: "Changdu" });
    expect(plan.readyToRun).toBe(true);
    expect(plan.snapshot.channelAccountIds.slice().sort()).toEqual(
      [ids.account1, ids.account2, ids.account3].sort(),
    );
    expect(plan.snapshot.counts).toEqual({
      channelAccounts: 3,
      channelApps: 1,
      novelSourceItems: 1,
      promoLinks: 1,
      catalogScanTasks: 1,
      channelSyncTasks: 1,
      genericTasks: 1,
    });

    // Confirms zero writes: still exactly the pre-fix values afterward.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ids.channel } });
    expect(channel.code).toBe("moboreader");
  });

  it("apply: swaps code/name by id, keeps every id and foreign-key count identical, and commits", async () => {
    const report = await applyFoundationSwap(prisma);

    expect(report.channelId).toBe(ids.channel);
    expect(report.sourceAppId).toBe(ids.sourceApp);

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ids.channel } });
    const sourceApp = await prisma.sourceApp.findUniqueOrThrow({ where: { id: ids.sourceApp } });
    expect(channel).toMatchObject({ code: "changdu", name: "Changdu" });
    expect(sourceApp).toMatchObject({ code: "moboreader", name: "MoboReader" });

    // channel_app.external_app_id is untouched.
    const channelApp = await prisma.channelApp.findUniqueOrThrow({ where: { id: ids.channelApp } });
    expect(channelApp.externalAppId).toBe("moboreader");
    expect(channelApp.channelId).toBe(ids.channel);
    expect(channelApp.sourceAppId).toBe(ids.sourceApp);

    // The three accounts are still linked via channel_id -- same ids, same FK.
    const accounts = await prisma.channelAccount.findMany({ where: { channelId: ids.channel }, select: { id: true } });
    expect(accounts.map((row) => row.id).sort()).toEqual([ids.account1, ids.account2, ids.account3].sort());

    // Every foreign-key table's row count is identical before/after.
    expect(report.after.counts).toEqual(report.before.counts);
    expect(await prisma.novelSourceItem.count({ where: { channelAppId: ids.channelApp } })).toBe(1);
    expect(await prisma.promoLink.count({ where: { channelAppId: ids.channelApp } })).toBe(1);
    expect(await prisma.catalogScanTask.count({ where: { channelAccountId: { in: accounts.map((a) => a.id) } } })).toBe(1);
    expect(await prisma.channelSyncTask.count({ where: { channelAccountId: { in: accounts.map((a) => a.id) } } })).toBe(1);
    expect(await prisma.genericTask.count({ where: { channelAccountId: { in: accounts.map((a) => a.id) } } })).toBe(1);
  });

  it("rollback: reverses a committed apply exactly, round-tripping ids and counts", async () => {
    await applyFoundationSwap(prisma);
    const rolledBack = await rollbackFoundationSwap(prisma);

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ids.channel } });
    const sourceApp = await prisma.sourceApp.findUniqueOrThrow({ where: { id: ids.sourceApp } });
    expect(channel).toMatchObject({ code: "moboreader", name: "MoboReader" });
    expect(sourceApp).toMatchObject({ code: "changdu", name: "Changdu" });
    expect(rolledBack.after.counts).toEqual(rolledBack.before.counts);

    // A second rollback in a row has nothing to reverse -- state is not "apply"-shaped anymore.
    await expect(rollbackFoundationSwap(prisma)).rejects.toBeInstanceOf(FoundationSwapError);
  });

  it("rejects with row_not_found and writes nothing when neither known code exists", async () => {
    await prisma.channel.update({ where: { id: ids.channel }, data: { code: "unrelated-code" } });
    await expect(applyFoundationSwap(prisma)).rejects.toMatchObject({ code: "row_not_found" });

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ids.channel } });
    expect(channel.code).toBe("unrelated-code");
    const sourceApp = await prisma.sourceApp.findUniqueOrThrow({ where: { id: ids.sourceApp } });
    expect(sourceApp.code).toBe("changdu"); // untouched -- the whole transaction rolled back
  });

  it("rejects with multiple_rows_found and writes nothing when a second row shares a candidate code", async () => {
    await prisma.channel.create({ data: { id: randomUUID(), code: "changdu", name: "Duplicate Changdu" } });
    await expect(applyFoundationSwap(prisma)).rejects.toMatchObject({ code: "multiple_rows_found" });

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ids.channel } });
    expect(channel.code).toBe("moboreader"); // untouched
    const sourceApp = await prisma.sourceApp.findUniqueOrThrow({ where: { id: ids.sourceApp } });
    expect(sourceApp.code).toBe("changdu"); // untouched -- whole transaction rolled back, not a partial write
  });

  it("targets the UPDATE by id: an unrelated row is never touched, and the real row's id never changes", async () => {
    const decoyId = randomUUID();
    await prisma.sourceApp.create({ data: { id: decoyId, code: "unrelated-source-app", name: "Unrelated" } });

    const report = await applyFoundationSwap(prisma);
    expect(report.channelId).toBe(ids.channel);
    expect(report.sourceAppId).toBe(ids.sourceApp);

    const decoy = await prisma.sourceApp.findUniqueOrThrow({ where: { id: decoyId } });
    expect(decoy).toMatchObject({ code: "unrelated-source-app", name: "Unrelated" }); // never touched
  });
});
