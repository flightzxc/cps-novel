import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { transitionSideEffectIntent } from "@/lib/tasks/side-effect-intent";
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

async function seedIntent(id: string, effectKey: string) {
  await owner.$executeRaw`
    INSERT INTO side_effect_intent (
      id, effect_key, operation_type, idempotency_key, target_type, target_id,
      status, request_summary
    ) VALUES (
      ${id}::uuid, ${effectKey}, 'x9.permission_probe', ${randomBytes(32).toString("hex")},
      'permission_probe', ${id}, 'manual_review_required', '{}'::jsonb
    )
  `;
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
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
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
    // The deployed worker role cannot bypass the service with a direct intent
    // read/write. Then use the owner connection only to reach (and verify) the
    // generic transition graph itself rather than letting role denial mask it.
    await expect(transitionSideEffectIntent(worker, {
      effectKey: keys.worker,
      status: "confirmed",
    })).rejects.toThrow(/permission denied for table side_effect_intent/i);
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
});
