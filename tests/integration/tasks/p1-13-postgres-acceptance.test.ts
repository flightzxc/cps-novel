import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LeaseLostError,
  buildWorkerAllowlist,
  claimPendingItem,
  createHandlerRegistry,
  finalizeTaskItem,
} from "@/lib/tasks";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

const enabled = process.env.P1_13_DATABASE_TEST === "1";
const prisma = new PrismaClient();
const clients: PrismaClient[] = [];

const ids = {
  channel: "13130000-0000-4000-8000-000000000001",
  sourceApp: "13130000-0000-4000-8000-000000000002",
  channelApp: "13130000-0000-4000-8000-000000000003",
  account: "13130000-0000-4000-8000-000000000004",
} as const;

function client() {
  const value = new PrismaClient();
  clients.push(value);
  return value;
}

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedFoundation() {
  const sql = `
    INSERT INTO channel (id, code, name, updated_at)
    VALUES ('${ids.channel}', 'p1-13-channel', 'P1-13 Channel', now());
    INSERT INTO source_app (id, code, name, updated_at)
    VALUES ('${ids.sourceApp}', 'p1-13-source', 'P1-13 Source', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
    VALUES ('${ids.channelApp}', '${ids.channel}', '${ids.sourceApp}', 'p1-13-app', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
    VALUES ('${ids.account}', '${ids.channel}', 'p1-13-account', 'P1-13 Account', now())
  `;
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function createGenericTask(mode: "apply" | "dry_run" = "apply") {
  return prisma.genericTask.create({
    data: {
      taskType: "p1-13.runtime",
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      mode,
      totalCount: 1,
      items: { create: [{ targetType: "acceptance", targetId: randomUUID(), payload: {} }] },
    },
    include: { items: true },
  });
}

const frozenChecks: Record<string, readonly string[]> = {
  channel_status_check: ["active", "inactive", "registered_disabled"],
  source_app_status_check: ["active", "inactive", "registered_disabled"],
  channel_app_status_check: ["active", "inactive", "registered_disabled"],
  channel_capability_status_check: ["enabled", "registered_disabled", "registered_partial"],
  channel_account_status_check: ["active", "disabled"],
  channel_account_credential_status_check: ["active", "superseded", "expired", "invalid"],
  admin_identity_status_check: ["active", "disabled"],
  novel_status_check: ["draft", "ready", "published", "unpublished", "takedown"],
  novel_source_item_status_check: ["pending", "linked", "ignored", "stale"],
  novel_chapter_status_check: ["preview", "locked", "stale", "withdrawn"],
  novel_chapter_source_item_status_check: ["pending", "materialized", "failed"],
  novel_preview_policy_materialization_policy_check: ["upstream_returned_preview"],
  source_label_label_kind_check: ["series_type", "recommend", "language", "agency"],
  promo_link_status_check: ["pending", "fetched", "failed", "registered_disabled"],
  promo_link_origin_check: ["upstream_existing", "claimed"],
  catalog_scan_task_status_check: ["pending", "processing", "completed", "completed_with_errors", "failed", "disabled"],
  catalog_scan_task_mode_check: ["dry_run", "apply"],
  catalog_scan_task_item_status_check: ["pending", "processing", "success", "failed"],
  channel_sync_task_status_check: ["pending", "processing", "completed", "completed_with_errors", "failed", "disabled"],
  channel_sync_task_mode_check: ["dry_run", "apply"],
  channel_sync_task_item_status_check: ["pending", "processing", "success", "skipped", "failed"],
  generic_task_status_check: ["pending", "processing", "completed", "completed_with_errors", "failed", "disabled"],
  generic_task_mode_check: ["dry_run", "apply"],
  generic_task_item_status_check: ["pending", "processing", "success", "skipped", "failed"],
  side_effect_intent_status_check: ["prepared", "confirmed", "failed", "claim_retry_blocked", "manual_review_required"],
  indexnow_outbox_status_check: ["pending", "processing", "accepted", "retry_wait", "permanent_failed", "dead_letter", "cancelled"],
  indexnow_outbox_attempt_attempt_state_check: ["started", "accepted", "retryable_failed", "permanent_failed"],
  schedule_run_status_check: ["due", "enqueued", "misfired", "skipped", "failed"],
  schedule_run_trigger_kind_check: ["scheduled", "manual"],
  schedule_run_misfire_policy_check: ["bounded_catch_up", "skip", "mark_failed"],
  cron_run_status_check: ["created", "task_created", "failed"],
  article_template_status_check: ["draft", "active", "retired"],
  article_status_check: ["draft", "published", "unpublished", "takedown"],
  home_carousel_auto_batch_status_check: ["pending", "processing", "completed", "failed"],
  home_carousel_serving_source_check: ["manual", "automatic"],
};

describe.skipIf(!enabled).sequential("P1-13 PostgreSQL acceptance gaps", () => {
  beforeAll(async () => {
    const [database] = await prisma.$queryRawUnsafe<Array<{ name: string; version: string }>>(
      "SELECT current_database() AS name, current_setting('server_version') AS version",
    );
    if (!database.name.includes("p1_13")) throw new Error(`Refusing P1-13 tests against ${database.name}`);
    if (!database.version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
  });

  beforeEach(async () => {
    await truncateDatabase();
    await seedFoundation();
  });

  afterAll(async () => {
    await Promise.all(clients.map((value) => value.$disconnect()));
    await prisma.$disconnect();
  });

  it("runs one handler and one protected write when two Workers poll together", async () => {
    const task = await createGenericTask();
    let handlerCalls = 0;
    const registry = createHandlerRegistry({
      "p1-13.runtime": {
        family: "generic",
        handler: async () => {
          handlerCalls += 1;
          return {
            status: "success",
            protectedWrite: async (tx) => {
              await tx.operationAudit.create({
                data: { actorType: "test", action: "p1-13.protected-write", entityType: "task", entityId: task.id },
              });
            },
          };
        },
      },
    });
    const allowlist = buildWorkerAllowlist("p1-13.runtime", registry);
    const results = await Promise.all(["worker-a", "worker-b"].map((workerId) =>
      processOneWorkerCycle({
        prisma: client(), workerId, handlers: registry, allowlist,
        signal: new AbortController().signal, leaseMs: 30_000,
      })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(handlerCalls).toBe(1);
    expect(await prisma.operationAudit.count({ where: { action: "p1-13.protected-write" } })).toBe(1);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } }))
      .toMatchObject({ status: "success", attemptCount: 1, leaseEpoch: 1n });
  });

  it("allows exactly one concurrent active CatalogScan for account × app × projectType", async () => {
    const contenders = [client(), client()];
    const settled = await Promise.allSettled(contenders.map((db, index) => db.catalogScanTask.create({
      data: {
        channelAccountId: ids.account,
        channelAppId: ids.channelApp,
        projectType: 2,
        requestToken: `p1-13-catalog-${index}`,
        pageStart: 1,
        pageEnd: 1,
        pageSize: 20,
      },
    })));
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await prisma.catalogScanTask.count({ where: { status: { in: ["pending", "processing"] } } })).toBe(1);
  });

  it("rejects a stale execution_token and a stale lease_epoch independently", async () => {
    await createGenericTask();
    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["p1-13.runtime"], workerId: "fence-owner", leaseMs: 30_000,
    });
    expect(lease).not.toBeNull();
    await expect(finalizeTaskItem(prisma, { ...lease!, executionToken: randomUUID() }, { status: "success" }))
      .rejects.toBeInstanceOf(LeaseLostError);
    await expect(finalizeTaskItem(prisma, { ...lease!, leaseEpoch: lease!.leaseEpoch - 1n }, { status: "success" }))
      .rejects.toBeInstanceOf(LeaseLostError);
    await finalizeTaskItem(prisma, lease!, { status: "success" });
  });

  it("installs every frozen status and restricted-value CHECK as a validated constraint", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; definition: string; validated: boolean }>>(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition, convalidated AS validated
      FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
    `);
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const [name, values] of Object.entries(frozenChecks)) {
      const constraint = byName.get(name);
      expect(constraint, `${name} must exist`).toBeDefined();
      expect(constraint?.validated, `${name} must be validated`).toBe(true);
      for (const value of values) expect(constraint?.definition).toContain(`'${value}'`);
    }
    await expect(prisma.$executeRawUnsafe(`UPDATE channel SET status='not_frozen' WHERE id='${ids.channel}'`))
      .rejects.toThrow();
    await createGenericTask();
    await expect(prisma.$executeRawUnsafe("UPDATE generic_task SET mode='not_frozen'"))
      .rejects.toThrow();
  });

  it("keeps dry-run free of upstream and business writes while retaining audit semantics", async () => {
    const task = await createGenericTask("dry_run");
    let upstreamCalls = 0;
    const registry = createHandlerRegistry({
      "p1-13.runtime": {
        family: "generic",
        handler: async ({ mode }) => {
          if (mode !== "dry_run") upstreamCalls += 1;
          return {
            status: "success",
            result: { mode: mode ?? "missing" },
            protectedWrite: async (tx) => {
              await tx.novel.create({
                data: {
                  businessId: "p1-13-dry-run-asset", title: "Must not exist",
                  description: "dry-run business write sentinel", locale: "en-US",
                  slug: "p1-13-dry-run-asset",
                },
              });
            },
          };
        },
      },
    });
    const worked = await processOneWorkerCycle({
      prisma, workerId: "dry-run-worker", handlers: registry,
      allowlist: buildWorkerAllowlist("p1-13.runtime", registry),
      signal: new AbortController().signal, leaseMs: 30_000,
    });
    expect(worked).toBe(true);
    expect(upstreamCalls).toBe(0);
    expect(await prisma.novel.count({ where: { businessId: "p1-13-dry-run-asset" } })).toBe(0);
    expect(await prisma.operationAudit.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } }))
      .toMatchObject({ status: "success", result: { mode: "dry_run" } });
  });

  it("keeps apply mode executing upstream and protected business writes", async () => {
    const task = await createGenericTask("apply");
    let upstreamCalls = 0;
    const registry = createHandlerRegistry({
      "p1-13.runtime": {
        family: "generic",
        handler: async ({ mode }) => {
          if (mode === "apply") upstreamCalls += 1;
          return {
            status: "success",
            result: { mode },
            protectedWrite: async (tx) => {
              await tx.novel.create({
                data: {
                  businessId: "p1-13-apply-asset", title: "Apply asset",
                  description: "apply business write sentinel", locale: "en-US",
                  slug: "p1-13-apply-asset",
                },
              });
            },
          };
        },
      },
    });
    expect(await processOneWorkerCycle({
      prisma, workerId: "apply-worker", handlers: registry,
      allowlist: buildWorkerAllowlist("p1-13.runtime", registry),
      signal: new AbortController().signal, leaseMs: 30_000,
    })).toBe(true);
    expect(upstreamCalls).toBe(1);
    expect(await prisma.novel.count({ where: { businessId: "p1-13-apply-asset" } })).toBe(1);
    expect(await prisma.operationAudit.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } }))
      .toMatchObject({ status: "success", result: { mode: "apply" } });
  });
});
