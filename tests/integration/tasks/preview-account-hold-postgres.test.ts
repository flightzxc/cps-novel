/**
 * Real-Postgres acceptance for the account-level brake's **claim-time** layer
 * (Owner 2026-09-18 决策 2). Gated the same way `./p2-05-postgres.test.ts` is:
 * set `PREVIEW_HOLD_DATABASE_TEST=1` and point
 * `PREVIEW_HOLD_DATABASE_URL` at a throwaway database carrying this repo's
 * migrations.
 *
 * Why this cannot be a unit test: the whole guarantee lives in one SQL
 * predicate pushed into `selectPending`'s inner `WHERE`
 * (`src/lib/tasks/store.ts`). A fake `$queryRaw` returns whatever a fixture
 * says regardless of that predicate, so a unit test would stay green with the
 * brake deleted. The sibling unit suite
 * (`tests/backend/tasks/preview-account-hold.test.ts`) covers classification,
 * the hold write, the enqueue-time parking and release; this covers the part
 * only a database can answer.
 *
 * Cases covered here, in the acceptance list's own numbering:
 *   6  — one account's three tasks stop being claimable after it is held
 *   8  — a *different* account is completely unaffected (not a channel-wide pause)
 *   9  — after release, the previously held work runs
 *   10 — no busy loop: a held item is not written to at all across repeated
 *        claim attempts (same status/attempt_count/lease_epoch/updated_at),
 *        so there is no claim→requeue→claim cycle and nothing to undo
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOBOREADER_TASK_TYPES } from "@/lib/tasks/moboreader";
import { claimPendingItem } from "@/lib/tasks/store";

const enabled = process.env.PREVIEW_HOLD_DATABASE_TEST === "1";
const db = new PrismaClient({ datasourceUrl: process.env.PREVIEW_HOLD_DATABASE_URL });

const CHANNEL = randomUUID();
const SOURCE_APP = randomUUID();
const CHANNEL_APP = randomUUID();
const ACCOUNT_A = randomUUID();
const ACCOUNT_B = randomUUID();

type SeededTask = { readonly taskId: string; readonly itemId: string };

async function seedScope(): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel (id, code, name, status, created_at, updated_at)
    VALUES (${CHANNEL}::uuid, ${`ch-${CHANNEL.slice(0, 8)}`}, 'hold probe', 'active', now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO source_app (id, code, name, status, created_at, updated_at)
    VALUES (${SOURCE_APP}::uuid, ${`sa-${SOURCE_APP.slice(0, 8)}`}, 'MoboReader', 'active', now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, status, created_at, updated_at)
    VALUES (${CHANNEL_APP}::uuid, ${CHANNEL}::uuid, ${SOURCE_APP}::uuid, ${`app-${CHANNEL_APP.slice(0, 8)}`}, 1, 'active', now(), now())`);
  for (const [id, label] of [[ACCOUNT_A, "acct-a"], [ACCOUNT_B, "acct-b"]] as const) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO channel_account (id, channel_id, business_id, account_name, status, created_at, updated_at)
      VALUES (${id}::uuid, ${CHANNEL}::uuid, ${`${label}-${id.slice(0, 8)}`}, ${label}, 'active', now(), now())`);
  }
}

async function seedPreviewTask(channelAccountId: string, label: string): Promise<SeededTask> {
  const novelId = randomUUID();
  const sourceItemId = randomUUID();
  const taskId = randomUUID();
  const itemId = randomUUID();
  await db.$executeRaw(Prisma.sql`
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, total_chapter_count, created_at, updated_at)
    VALUES (${novelId}::uuid, ${`nv-${novelId.slice(0, 8)}`}, ${label}, 'd', 'en', ${`slug-${novelId.slice(0, 8)}`}, 'draft', 10, now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, external_agency_id, source_language_code, title, description, raw_payload, raw_payload_schema_version, created_at, updated_at)
    VALUES (${sourceItemId}::uuid, ${CHANNEL_APP}::uuid, ${novelId}::uuid, ${label}, '7', '1', ${label}, 'd', '{}'::jsonb, 1, now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel_sync_task (id, task_type, channel_account_id, channel_app_id, operation_scope_hash, mode, status, request_token, total_count, params, requested_at, created_at, updated_at)
    VALUES (${taskId}::uuid, ${MOBOREADER_TASK_TYPES.previewRefresh}, ${channelAccountId}::uuid, ${CHANNEL_APP}::uuid,
            ${taskId.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}, 'apply', 'pending', ${`tok-${taskId}`}, 1, '{}'::jsonb, now(), now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel_sync_task_item (id, task_id, novel_source_item_id, status, attempt_count, lease_epoch, payload, created_at, updated_at)
    VALUES (${itemId}::uuid, ${taskId}::uuid, ${sourceItemId}::uuid, 'pending', 0, 0,
            '{"trigger":"auto","actorId":"probe","requestId":"probe"}'::jsonb, now(), now())`);
  return { taskId, itemId };
}

function claim() {
  return claimPendingItem(db, {
    family: "channel_sync",
    taskTypes: [MOBOREADER_TASK_TYPES.previewRefresh],
    workerId: "hold-probe",
    leaseMs: 30_000,
  });
}

async function itemFingerprint(itemId: string): Promise<string> {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT status, attempt_count, lease_epoch, execution_token, locked_by, locked_until, error, updated_at
    FROM channel_sync_task_item WHERE id = ${itemId}::uuid`);
  return JSON.stringify(rows[0], (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

async function settle(itemId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE channel_sync_task_item SET status = 'success', finished_at = now() WHERE id = ${itemId}::uuid`);
}

describe.skipIf(!enabled)("Preview account hold · claim-time pushdown (real Postgres)", () => {
  let a1: SeededTask;
  let a2: SeededTask;
  let a3: SeededTask;
  let b1: SeededTask;

  beforeAll(async () => {
    await seedScope();
    a1 = await seedPreviewTask(ACCOUNT_A, "a1");
    a2 = await seedPreviewTask(ACCOUNT_A, "a2");
    a3 = await seedPreviewTask(ACCOUNT_A, "a3");
    b1 = await seedPreviewTask(ACCOUNT_B, "b1");
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("baseline: the account's work is claimable before any hold exists", async () => {
    const lease = await claim();
    expect(lease?.taskId).toBe(a1.taskId);
    // Return it to the pending pool so the hold measurement below starts clean.
    await db.$executeRaw(Prisma.sql`
      UPDATE channel_sync_task_item
      SET status = 'pending', execution_token = NULL, locked_by = NULL, locked_until = NULL,
          heartbeat_at = NULL, attempt_count = 0, lease_epoch = 0
      WHERE id = ${a1.itemId}::uuid`);
  });

  it("Cases 6/8/10: a held account yields nothing, another account still runs, and held items are never written to", async () => {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO channel_account_hold (id, channel_account_id, reason_code, held_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${ACCOUNT_A}::uuid, 'credential_validation_failed', now(), now(), now())`);

    const before = await Promise.all([a1, a2, a3].map((task) => itemFingerprint(task.itemId)));

    const claimed: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const lease = await claim();
      if (!lease) {
        claimed.push("none");
        continue;
      }
      claimed.push(lease.taskId === b1.taskId ? "accountB" : "HELD_ACCOUNT_LEAKED");
      await settle(lease.itemId);
    }

    // Case 6: the held account's three tasks were never handed out.
    expect(claimed).not.toContain("HELD_ACCOUNT_LEAKED");
    // Case 8: the other account's single item ran exactly once — this is
    // account isolation, not a channel-wide pause.
    expect(claimed.filter((entry) => entry === "accountB")).toHaveLength(1);
    expect(claimed.filter((entry) => entry === "none")).toHaveLength(5);

    // Case 10: six claim attempts later, every held item is byte-identical —
    // same status, attempt_count, lease_epoch, token, lock and updated_at.
    // A claim→requeue busy loop, or any "discover the hold then push the item
    // back" design, would move at least one of these.
    const after = await Promise.all([a1, a2, a3].map((task) => itemFingerprint(task.itemId)));
    expect(after).toEqual(before);
    expect(JSON.parse(after[0]!)).toMatchObject({ status: "pending", attempt_count: 0, error: null });
  });

  it("Case 9: after the hold is released, the previously held work is claimable again", async () => {
    await db.$executeRaw(Prisma.sql`
      UPDATE channel_account_hold
      SET released_at = now(), released_by = 'hold-probe', release_reason = 'acceptance'
      WHERE channel_account_id = ${ACCOUNT_A}::uuid AND released_at IS NULL`);

    const heldTaskIds = new Set([a1.taskId, a2.taskId, a3.taskId]);
    const claimed: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lease = await claim();
      if (!lease) {
        claimed.push("none");
        continue;
      }
      claimed.push(heldTaskIds.has(lease.taskId) ? "accountA" : "other");
      await settle(lease.itemId);
    }
    expect(claimed).toEqual(["accountA", "accountA", "accountA"]);
  });
});
