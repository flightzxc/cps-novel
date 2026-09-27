import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { confirmSideEffectIntentByReadbackInTransaction, transitionSideEffectIntent } from "@/lib/tasks/side-effect-intent";
import { finalizeTaskItem, type TaskLease } from "@/lib/tasks";
import { resolveManualReview } from "@/server/task-admin";

import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
} from "../../backend/task-admin/test-support";

const enabled = process.env.X9_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("X9_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("X9_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("X9_WORKER_DATABASE_URL") });

const bootstrap = new PrismaClient({ datasourceUrl: requiredUrl("X9_BOOTSTRAP_DATABASE_URL") });
const GUARD_ERROR = "side_effect_manual_review_exit_requires_web_app";

const ids = {
  grantIntent: randomUUID(),
  casIntent: randomUUID(),
  workerIntent: randomUUID(),
};
const keys = {
  grant: randomBytes(32).toString("hex"),
  cas: randomBytes(32).toString("hex"),
  worker: randomBytes(32).toString("hex"),
};

async function expectDenied(action: () => Promise<unknown>) {
  await expect(action()).rejects.toThrow();
}

async function seedIntent(id: string, effectKey: string, status = "manual_review_required") {
  await owner.$executeRaw`
    INSERT INTO side_effect_intent (
      id, effect_key, operation_type, idempotency_key, target_type, target_id,
      status, request_summary
    ) VALUES (
      ${id}::uuid, ${effectKey}, 'x9.permission_probe', ${randomBytes(32).toString("hex")},
      'permission_probe', ${id}, ${status}, '{}'::jsonb
    )
  `;
}

async function newIntent(status = "manual_review_required") {
  const id = randomUUID();
  const effectKey = randomBytes(32).toString("hex");
  await seedIntent(id, effectKey, status);
  return { id, effectKey };
}

async function expectGuardDenied(run: () => Promise<unknown>) {
  let failure: unknown;
  try { await run(); } catch (error) { failure = error; }
  expect(failure, "the database trigger must reject this write").toBeDefined();
  expect(String(failure)).toContain(GUARD_ERROR);
  expect(String(failure) + JSON.stringify(failure)).toMatch(/42501/);
}

async function adjudication(intentId: string, resolution: string) {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const ticket = await issueTaskAuthorization(stores, {
    token: admin.token, pathname: "/api/admin/tasks/manual-reviews/resolve",
  });
  const input = { ...ticket, intentId, resolution, reason: "B-15 real database adjudication" };
  const deps = { db: web, identities: stores, sessions: stores, now: NOW };
  return () => resolveManualReview(input, deps);
}

describe.skipIf(!enabled).sequential("X9 disposable PostgreSQL enforcement", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await owner.$queryRawUnsafe<Array<{ database_name: string }>>(
      "SELECT current_database() AS database_name",
    );
    if (!databaseName.startsWith("cps_novel_x9_")) {
      throw new Error(`Refusing X9 setup against ${databaseName}`);
    }
    await seedIntent(ids.grantIntent, keys.grant);
    await seedIntent(ids.casIntent, keys.cas);
    await seedIntent(ids.workerIntent, keys.worker);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), bootstrap.$disconnect()]);
  });

  it("lets web update only status, response_shape, and confirmed_at", async () => {
    const changed = await web.$executeRaw`
      UPDATE side_effect_intent
      SET status = 'confirmed', response_shape = '{"manualResolution":"effect_confirmed"}'::jsonb,
          confirmed_at = now()
      WHERE id = ${ids.grantIntent}::uuid AND status = 'manual_review_required'
    `;
    expect(changed).toBe(1);

    await expectDenied(() => web.$executeRaw`
      UPDATE side_effect_intent SET effect_key = ${randomBytes(32).toString("hex")}
      WHERE id = ${ids.grantIntent}::uuid
    `);
    await expectDenied(() => web.$executeRaw`
      UPDATE side_effect_intent SET idempotency_key = ${randomBytes(32).toString("hex")}
      WHERE id = ${ids.grantIntent}::uuid
    `);
    await expectDenied(() => web.$executeRaw`
      UPDATE side_effect_intent SET request_summary = '{"tampered":true}'::jsonb
      WHERE id = ${ids.grantIntent}::uuid
    `);
    await expectDenied(() => web.$executeRaw`
      UPDATE side_effect_intent SET target_id = 'tampered' WHERE id = ${ids.grantIntent}::uuid
    `);
  });

  it("gives two concurrent admins one CAS winner and commits exactly one audit", async () => {
    const stores = newStores();
    const first = seedTaskAdmin(stores, { identityId: "x9-admin-1" });
    const second = seedTaskAdmin(stores, { identityId: "x9-admin-2" });
    const [firstTicket, secondTicket] = await Promise.all([
      issueTaskAuthorization(stores, {
        token: first.token,
        pathname: "/api/admin/tasks/manual-reviews/resolve",
      }),
      issueTaskAuthorization(stores, {
        token: second.token,
        pathname: "/api/admin/tasks/manual-reviews/resolve",
      }),
    ]);
    const dependencies = { db: web, identities: stores, sessions: stores, now: NOW };
    const settled = await Promise.allSettled([
      resolveManualReview({
        ...firstTicket,
        intentId: ids.casIntent,
        resolution: "effect_confirmed",
        reason: "x9 concurrent PostgreSQL probe one",
      }, dependencies),
      resolveManualReview({
        ...secondTicket,
        intentId: ids.casIntent,
        resolution: "no_effect_confirmed",
        reason: "x9 concurrent PostgreSQL probe two",
      }, dependencies),
    ]);
    const failures = settled.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    if (settled.every((result) => result.status === "rejected")) {
      throw new Error(failures.map((result) => String(result.reason)).join("\n---\n"));
    }
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ status: 409 });

    const [intent] = await owner.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM side_effect_intent WHERE id = ${ids.casIntent}::uuid
    `;
    expect(["confirmed", "failed"]).toContain(intent.status);
    const audits = await owner.operationAudit.findMany({
      where: { action: "side_effect_intent.manual_resolve", entityId: ids.casIntent },
    });
    expect(audits).toHaveLength(1);
  });

  it("keeps the generic worker transition unable to exit manual_review_required", async () => {
    await expect(transitionSideEffectIntent(worker, {
      effectKey: keys.worker,
      status: "confirmed",
    })).rejects.toThrow("Illegal side-effect transition: manual_review_required -> confirmed");
    await expect(transitionSideEffectIntent(worker, {
      effectKey: keys.worker,
      status: "failed",
    })).rejects.toThrow("Illegal side-effect transition: manual_review_required -> failed");
    await expect(transitionSideEffectIntent(owner, {
      effectKey: keys.worker,
      status: "confirmed",
      responseShape: { shouldNotPersist: true },
    })).rejects.toThrow("Illegal side-effect transition: manual_review_required -> confirmed");
    await expect(transitionSideEffectIntent(owner, {
      effectKey: keys.worker,
      status: "failed",
      responseShape: { shouldNotPersist: true },
    })).rejects.toThrow("Illegal side-effect transition: manual_review_required -> failed");
    const intent = await owner.sideEffectIntent.findUniqueOrThrow({ where: { id: ids.workerIntent } });
    expect(intent).toMatchObject({
      status: "manual_review_required",
      responseShape: null,
      confirmedAt: null,
    });
  });

  it("preserves the invoker trigger and exact grants after replay", async () => {
    const rows = await owner.$queryRaw<Array<{ enabled: string; invoker: boolean; return_type: string; args: string }>>`
      SELECT t.tgenabled AS enabled, NOT p.prosecdef AS invoker,
             format_type(p.prorettype, NULL) AS return_type,
             pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='public.side_effect_intent'::regclass
        AND t.tgname='side_effect_manual_review_exit_guard'
        AND p.oid='public.reject_side_effect_manual_review_exit()'::regprocedure
    `;
    expect(rows).toEqual([{ enabled: "O", invoker: true, return_type: "trigger", args: "" }]);
    const [grants] = await owner.$queryRaw<Array<{ worker_read: boolean; worker_insert: boolean; worker_update: boolean; worker_execute: boolean; web_execute: boolean }>>`
      SELECT has_table_privilege('worker_app','side_effect_intent','SELECT') AS worker_read,
        has_table_privilege('worker_app','side_effect_intent','INSERT') AS worker_insert,
        has_table_privilege('worker_app','side_effect_intent','UPDATE') AS worker_update,
        has_function_privilege('worker_app','public.reject_side_effect_manual_review_exit()','EXECUTE') AS worker_execute,
        has_function_privilege('web_app','public.reject_side_effect_manual_review_exit()','EXECUTE') AS web_execute
    `;
    expect(grants).toEqual({ worker_read: true, worker_insert: true, worker_update: true, worker_execute: false, web_execute: false });
    const columns = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT attname AS name FROM pg_attribute
      WHERE attrelid='public.side_effect_intent'::regclass AND attnum>0 AND NOT attisdropped
        AND has_column_privilege('web_app',attrelid,attnum,'UPDATE') ORDER BY attname
    `;
    expect(columns.map((row) => row.name)).toEqual(["confirmed_at", "response_shape", "status"]);
  });

  for (const status of ["confirmed", "failed", "prepared", "claim_retry_blocked"]) {
    for (const method of ["SQL", "Prisma"] as const) {
      it(`database rejects worker ${method} manual-review exit to ${status} with 42501`, async () => {
        const { id } = await newIntent();
        const before = await owner.sideEffectIntent.findUniqueOrThrow({ where: { id } });
        await expectGuardDenied(() => method === "SQL"
          ? worker.$executeRaw`UPDATE side_effect_intent SET status=${status}, response_shape='{"tampered":true}'::jsonb,
              confirmed_at=now() WHERE id=${id}::uuid`
          : worker.sideEffectIntent.updateMany({ where: { id }, data: { status, responseShape: { tampered: true }, confirmedAt: NOW } }));
        expect(await owner.sideEffectIntent.findUniqueOrThrow({ where: { id } })).toEqual(before);
      });
    }
  }

  it("owner is also denied a manual-review exit", async () => {
    const { id } = await newIntent();
    await expectGuardDenied(() => owner.$executeRaw`UPDATE side_effect_intent SET status='confirmed' WHERE id=${id}::uuid`);
  });

  it("worker cannot SET ROLE or disable the trigger", async () => {
    const [roles] = await worker.$queryRaw<Array<{ web_member: boolean; owner_member: boolean; role: string }>>`
      SELECT current_user AS role, pg_has_role(current_user,'web_app','MEMBER') AS web_member,
        pg_has_role(current_user,'migration_owner','MEMBER') AS owner_member
    `;
    expect(roles).toEqual({ role: "worker_app", web_member: false, owner_member: false });
    for (const role of ["web_app", "migration_owner"]) {
      await expect(worker.$transaction((tx) => tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)))
        .rejects.toThrow(/permission denied to set role/i);
    }
    await expect(worker.$executeRaw`ALTER TABLE side_effect_intent DISABLE TRIGGER side_effect_manual_review_exit_guard`)
      .rejects.toThrow(/must be owner/i);
  });

  it("uses current_user after SET ROLE web_app rather than session_user", async () => {
    const { id } = await newIntent();
    await bootstrap.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE web_app`;
      const [roles] = await tx.$queryRaw<Array<{ effective: string; login: string }>>`SELECT current_user AS effective, session_user AS login`;
      expect(roles.effective).toBe("web_app");
      expect(roles.login).not.toBe("web_app");
      expect(await tx.$executeRaw`UPDATE side_effect_intent SET status='confirmed' WHERE id=${id}::uuid`).toBe(1);
    });
    const blocked = await newIntent();
    await expectGuardDenied(() => bootstrap.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE worker_app`;
      const [roles] = await tx.$queryRaw<Array<{ effective: string; login: string }>>`SELECT current_user AS effective, session_user AS login`;
      expect(roles.effective).toBe("worker_app");
      expect(roles.login).not.toBe("worker_app");
      await tx.$executeRaw`UPDATE side_effect_intent SET status='failed' WHERE id=${blocked.id}::uuid`;
    }));
  });

  it("allows same-status updates by worker", async () => {
    const { id } = await newIntent();
    expect(await worker.sideEffectIntent.updateMany({ where: { id }, data: { status: "manual_review_required", responseShape: { observed: true } } }))
      .toEqual({ count: 1 });
    expect((await owner.sideEffectIntent.findUniqueOrThrow({ where: { id } })).responseShape).toEqual({ observed: true });
  });

  for (const status of ["prepared", "claim_retry_blocked"]) {
    it(`allows worker readback confirmation from ${status}`, async () => {
      const { effectKey } = await newIntent(status);
      const result = await worker.$transaction((tx) => confirmSideEffectIntentByReadbackInTransaction(tx, {
        effectKey, evidence: { hasWebUrl: true, hasAppUrl: false },
      }));
      expect(result.status).toBe("confirmed");
      expect(result.confirmedAt).not.toBeNull();
    });
  }

  it.each(["prepared", "claim_retry_blocked", "confirmed", "failed"])(
    "leaves database transitions from %s unchanged", async (status) => {
      const { id } = await newIntent(status);
      expect(await worker.sideEffectIntent.updateMany({ where: { id }, data: { status: "manual_review_required" } }))
        .toEqual({ count: 1 });
    },
  );

  it("readback cannot leave manual review and preserves evidence", async () => {
    const intent = await newIntent();
    const before = await owner.sideEffectIntent.findUniqueOrThrow({ where: { id: intent.id } });
    await expect(worker.$transaction((tx) => confirmSideEffectIntentByReadbackInTransaction(tx, {
      effectKey: intent.effectKey, evidence: { hasWebUrl: true, hasAppUrl: true },
    }))).rejects.toThrow("Illegal side-effect readback confirmation: manual_review_required -> confirmed");
    expect(await owner.sideEffectIntent.findUniqueOrThrow({ where: { id: intent.id } })).toEqual(before);
  });

  for (const [resolution, status] of [["effect_confirmed", "confirmed"], ["no_effect_confirmed", "failed"]]) {
    it(`Web adjudication ${resolution} succeeds and replays once`, async () => {
      const { id } = await newIntent();
      const resolve = await adjudication(id, resolution);
      const result = await resolve();
      expect(result).toMatchObject({ status, wrote: true });
      expect(await resolve()).toMatchObject({ status, wrote: false, auditId: result.auditId });
      expect(await owner.operationAudit.count({ where: { entityId: id, action: "side_effect_intent.manual_resolve" } })).toBe(1);
    });
  }

  it("rolls back adjudication when the audit INSERT fails", async () => {
    const { id } = await newIntent();
    const before = await owner.sideEffectIntent.findUniqueOrThrow({ where: { id } });
    const resolve = await adjudication(id, "effect_confirmed");
    await owner.$executeRaw`REVOKE INSERT ON operation_audit FROM web_app`;
    try {
      await expect(resolve()).rejects.toThrow(/permission denied for table operation_audit/i);
      expect(await owner.sideEffectIntent.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await owner.operationAudit.count({ where: { entityId: id } })).toBe(0);
    } finally {
      await owner.$executeRaw`GRANT INSERT ON operation_audit TO web_app`;
    }
  });

  it("rolls back PromoLink Article intent audit and task when the guard rejects protectedWrite", async () => {
    const token = randomUUID();
    const channel = await owner.channel.create({ data: { code: token, name: "B15" } });
    const source = await owner.sourceApp.create({ data: { code: token, name: "B15" } });
    const app = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: source.id, externalAppId: token, projectType: 2 } });
    const account = await owner.channelAccount.create({ data: { channelId: channel.id, businessId: token, accountName: "B15" } });
    const novel = await owner.novel.create({ data: { businessId: token, title: "B15", description: "", locale: "en", slug: token } });
    const sourceItem = await owner.novelSourceItem.create({ data: { channelAppId: app.id, novelId: novel.id, externalBookId: token, sourceLanguageCode: "en", title: "B15", description: "", rawPayload: {} } });
    const promo = await owner.promoLink.create({ data: { novelId: novel.id, novelSourceItemId: sourceItem.id, channelAppId: app.id, channelAccountId: account.id, offerType: "default", publicRedirectCode: token.replaceAll("-", ""), idempotencyKey: randomBytes(32).toString("hex") } });
    const article = await owner.article.create({ data: { novelId: novel.id, locale: "en", slug: token, publicPageShortId: token.replaceAll("-", ""), title: "B15", body: "B15", contentMode: "manual" } });
    const intent = await newIntent();
    const task = await owner.genericTask.create({ data: {
      taskType: "x9.atomic", operationScopeHash: randomBytes(32).toString("hex"), requestToken: token, status: "processing", totalCount: 1,
      items: { create: { targetType: "probe", targetId: token, status: "processing", executionToken: token, leaseEpoch: 1, attemptCount: 1,
        lockedBy: "x9-worker", lockedUntil: new Date(Date.now()+120_000), startedAt: new Date() } },
    }, include: { items: true } });
    const lease: TaskLease = { family: "generic", taskType: task.taskType, mode: "apply", itemId: task.items[0].id, taskId: task.id,
      workerId: "x9-worker", executionToken: token, leaseEpoch: 1n, attemptCount: 1, lockedUntil: task.items[0].lockedUntil!, payload: {} };
    const snapshot = async () => ({
      promo: await owner.promoLink.findUniqueOrThrow({ where: { id: promo.id } }),
      article: await owner.article.findUniqueOrThrow({ where: { id: article.id } }),
      intent: await owner.sideEffectIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      task: await owner.genericTask.findUniqueOrThrow({ where: { id: task.id }, include: { items: true } }),
      audit: await owner.operationAudit.findMany({ where: { requestId: token } }),
    });
    const before = await snapshot();
    await expectGuardDenied(() => finalizeTaskItem(worker, lease, { status: "success", protectedWrite: async (tx) => {
      await tx.promoLink.update({ where: { id: promo.id }, data: { status: "fetched", webUrl: "https://example.test/b15", fetchedAt: new Date() } });
      await tx.article.update({ where: { id: article.id }, data: { promoLinkId: promo.id } });
      await tx.operationAudit.create({ data: { actorType: "worker", action: "x9.atomic_probe", entityType: "PromoLink", entityId: promo.id, requestId: token } });
      await tx.genericTask.update({ where: { id: task.id }, data: { result: { probe: true } } });
      await tx.genericTaskItem.update({ where: { id: lease.itemId }, data: { result: { probe: true } } });
      await tx.$executeRaw`UPDATE side_effect_intent SET status='confirmed', response_shape='{"probe":true}'::jsonb, confirmed_at=now() WHERE id=${intent.id}::uuid`;
    } }));
    expect(await snapshot()).toEqual(before);
  });

});
