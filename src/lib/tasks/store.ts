import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  RecoveryResult,
  TaskFamily,
  TaskLease,
  TaskOutcome,
} from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

interface CandidateRow {
  id: string;
  task_id: string;
  task_type: string;
  payload: unknown;
  attempt_count: number;
  lease_epoch: bigint;
  cursor_at?: Date;
  eligible?: boolean;
}

interface LeaseRow extends CandidateRow {
  execution_token: string;
  locked_until: Date;
}

export class LeaseLostError extends Error {
  readonly code = "TASK_LEASE_LOST";
  readonly retryable = false;

  constructor(readonly lease: TaskLease) {
    super(`Task lease is no longer valid for ${lease.family}:${lease.itemId}`);
    this.name = "LeaseLostError";
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function selectPending(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskTypes: string[],
): Promise<CandidateRow | null> {
  if (family === "catalog_scan" && !taskTypes.includes("catalog_scan")) return null;
  let cursor: { at: Date; id: string } | null = null;
  while (true) {
    const cursorClause = cursor
      ? Prisma.sql`AND (i.created_at, i.id) > (${cursor.at}, ${cursor.id}::uuid)`
      : Prisma.empty;
    let rows: CandidateRow[];
    if (family === "catalog_scan") {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.created_at AS cursor_at
          FROM catalog_scan_task_item i
          WHERE i.status = 'pending' ${cursorClause}
          ORDER BY i.created_at, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, 'catalog_scan'::text AS task_type,
               (t.status IN ('pending', 'processing')) AS eligible
        FROM candidates c JOIN catalog_scan_task t ON t.id = c.task_id
        ORDER BY c.cursor_at, c.id
      `);
    } else if (family === "channel_sync") {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.created_at AS cursor_at
          FROM channel_sync_task_item i
          WHERE i.status = 'pending' ${cursorClause}
          ORDER BY i.created_at, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, t.task_type,
               (t.status IN ('pending', 'processing') AND t.task_type = ANY(${taskTypes}::text[])) AS eligible
        FROM candidates c JOIN channel_sync_task t ON t.id = c.task_id
        ORDER BY c.cursor_at, c.id
      `);
    } else {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.created_at AS cursor_at
          FROM generic_task_item i
          WHERE i.status = 'pending' ${cursorClause}
          ORDER BY i.created_at, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, t.task_type,
               (t.status IN ('pending', 'processing') AND t.task_type = ANY(${taskTypes}::text[])) AS eligible
        FROM candidates c JOIN generic_task t ON t.id = c.task_id
        ORDER BY c.cursor_at, c.id
      `);
    }
    const eligible = rows.find((row) => row.eligible);
    if (eligible) return eligible;
    if (rows.length < 128) return null;
    const last = rows.at(-1)!;
    cursor = { at: last.cursor_at!, id: last.id };
  }
}

async function assignLease(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  itemId: string,
  workerId: string,
  executionToken: string,
  leaseMs: number,
): Promise<LeaseRow> {
  let rows: LeaseRow[];
  if (family === "catalog_scan") {
    rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE catalog_scan_task_item
      SET status = 'processing', attempt_count = attempt_count + 1,
          execution_token = ${executionToken}::uuid, lease_epoch = lease_epoch + 1,
          locked_by = ${workerId},
          locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at = transaction_timestamp(),
          started_at = COALESCE(started_at, transaction_timestamp()),
          finished_at = NULL, updated_at = transaction_timestamp()
      WHERE id = ${itemId}::uuid AND status = 'pending'
      RETURNING id, task_id, 'catalog_scan'::text AS task_type, payload,
                attempt_count, lease_epoch, execution_token, locked_until
    `);
  } else if (family === "channel_sync") {
    rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE channel_sync_task_item i
      SET status = 'processing', attempt_count = i.attempt_count + 1,
          execution_token = ${executionToken}::uuid, lease_epoch = i.lease_epoch + 1,
          locked_by = ${workerId},
          locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at = transaction_timestamp(),
          started_at = COALESCE(i.started_at, transaction_timestamp()),
          finished_at = NULL, updated_at = transaction_timestamp()
      FROM channel_sync_task t
      WHERE i.id = ${itemId}::uuid AND i.status = 'pending' AND t.id = i.task_id
      RETURNING i.id, i.task_id, t.task_type, i.payload,
                i.attempt_count, i.lease_epoch, i.execution_token, i.locked_until
    `);
  } else {
    rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE generic_task_item i
      SET status = 'processing', attempt_count = i.attempt_count + 1,
          execution_token = ${executionToken}::uuid, lease_epoch = i.lease_epoch + 1,
          locked_by = ${workerId},
          locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at = transaction_timestamp(),
          started_at = COALESCE(i.started_at, transaction_timestamp()),
          finished_at = NULL, updated_at = transaction_timestamp()
      FROM generic_task t
      WHERE i.id = ${itemId}::uuid AND i.status = 'pending' AND t.id = i.task_id
      RETURNING i.id, i.task_id, t.task_type, i.payload,
                i.attempt_count, i.lease_epoch, i.execution_token, i.locked_until
    `);
  }
  if (!rows[0]) throw new Error(`Locked pending item disappeared: ${family}:${itemId}`);
  return rows[0];
}

export async function recomputeParentTask(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
): Promise<void> {
  if (family === "catalog_scan") {
    await tx.$executeRaw(Prisma.sql`
      WITH counts AS (
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM catalog_scan_task_item WHERE task_id = ${taskId}::uuid
      )
      UPDATE catalog_scan_task t SET
        total_count = c.total, success_count = c.success, failed_count = c.failed,
        status = CASE
          WHEN c.pending + c.processing > 0 THEN 'processing'
          WHEN c.failed > 0 AND c.success = 0 THEN 'failed'
          WHEN c.failed > 0 THEN 'completed_with_errors'
          ELSE 'completed' END,
        started_at = COALESCE(t.started_at, transaction_timestamp()),
        completed_at = CASE WHEN c.pending + c.processing = 0 THEN transaction_timestamp() ELSE NULL END,
        updated_at = transaction_timestamp()
      FROM counts c WHERE t.id = ${taskId}::uuid
    `);
  } else if (family === "channel_sync") {
    await tx.$executeRaw(Prisma.sql`
      WITH counts AS (
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
        FROM channel_sync_task_item WHERE task_id = ${taskId}::uuid
      )
      UPDATE channel_sync_task t SET
        total_count = c.total, success_count = c.success,
        failed_count = c.failed, skipped_count = c.skipped,
        status = CASE
          WHEN c.pending + c.processing > 0 THEN 'processing'
          WHEN c.failed > 0 AND c.success = 0 AND c.skipped = 0 THEN 'failed'
          WHEN c.failed > 0 THEN 'completed_with_errors'
          ELSE 'completed' END,
        started_at = COALESCE(t.started_at, transaction_timestamp()),
        completed_at = CASE WHEN c.pending + c.processing = 0 THEN transaction_timestamp() ELSE NULL END,
        updated_at = transaction_timestamp()
      FROM counts c WHERE t.id = ${taskId}::uuid
    `);
  } else {
    await tx.$executeRaw(Prisma.sql`
      WITH counts AS (
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
        FROM generic_task_item WHERE task_id = ${taskId}::uuid
      )
      UPDATE generic_task t SET
        total_count = c.total, success_count = c.success,
        failed_count = c.failed, skipped_count = c.skipped,
        status = CASE
          WHEN c.pending + c.processing > 0 THEN 'processing'
          WHEN c.failed > 0 AND c.success = 0 AND c.skipped = 0 THEN 'failed'
          WHEN c.failed > 0 THEN 'completed_with_errors'
          ELSE 'completed' END,
        started_at = COALESCE(t.started_at, transaction_timestamp()),
        completed_at = CASE WHEN c.pending + c.processing = 0 THEN transaction_timestamp() ELSE NULL END,
        updated_at = transaction_timestamp()
      FROM counts c WHERE t.id = ${taskId}::uuid
    `);
  }
}

export async function claimPendingItem(
  prisma: PrismaClient,
  input: {
    family: TaskFamily;
    taskTypes: string[];
    workerId: string;
    leaseMs: number;
  },
): Promise<TaskLease | null> {
  if (input.taskTypes.length === 0) return null;
  if (input.leaseMs < 1) throw new Error("leaseMs must be positive");
  return prisma.$transaction(async (tx) => {
    const candidate = await selectPending(tx, input.family, input.taskTypes);
    if (!candidate) return null;
    const executionToken = randomUUID();
    const row = await assignLease(
      tx,
      input.family,
      candidate.id,
      input.workerId,
      executionToken,
      input.leaseMs,
    );
    await recomputeParentTask(tx, input.family, row.task_id);
    return {
      family: input.family,
      taskType: row.task_type,
      itemId: row.id,
      taskId: row.task_id,
      workerId: input.workerId,
      executionToken: row.execution_token,
      leaseEpoch: row.lease_epoch,
      attemptCount: row.attempt_count,
      lockedUntil: row.locked_until,
      payload: row.payload,
    };
  });
}

async function selectExpired(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskTypes: string[],
): Promise<CandidateRow | null> {
  if (family === "catalog_scan" && !taskTypes.includes("catalog_scan")) return null;
  let cursor: { at: Date; id: string } | null = null;
  while (true) {
    const cursorClause = cursor
      ? Prisma.sql`AND (i.locked_until, i.id) > (${cursor.at}, ${cursor.id}::uuid)`
      : Prisma.empty;
    let rows: CandidateRow[];
    if (family === "catalog_scan") {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.locked_until AS cursor_at
          FROM catalog_scan_task_item i
          WHERE i.status = 'processing'
            AND i.locked_until < transaction_timestamp() ${cursorClause}
          ORDER BY i.locked_until, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, 'catalog_scan'::text AS task_type, true AS eligible
        FROM candidates c ORDER BY c.cursor_at, c.id
      `);
    } else if (family === "channel_sync") {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.locked_until AS cursor_at
          FROM channel_sync_task_item i
          WHERE i.status = 'processing'
            AND i.locked_until < transaction_timestamp() ${cursorClause}
          ORDER BY i.locked_until, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, t.task_type, (t.task_type = ANY(${taskTypes}::text[])) AS eligible
        FROM candidates c JOIN channel_sync_task t ON t.id = c.task_id
        ORDER BY c.cursor_at, c.id
      `);
    } else {
      rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT i.id, i.task_id, i.payload, i.attempt_count, i.lease_epoch,
                 i.locked_until AS cursor_at
          FROM generic_task_item i
          WHERE i.status = 'processing'
            AND i.locked_until < transaction_timestamp() ${cursorClause}
          ORDER BY i.locked_until, i.id
          LIMIT 128
          FOR UPDATE OF i SKIP LOCKED
        )
        SELECT c.*, t.task_type, (t.task_type = ANY(${taskTypes}::text[])) AS eligible
        FROM candidates c JOIN generic_task t ON t.id = c.task_id
        ORDER BY c.cursor_at, c.id
      `);
    }
    const eligible = rows.find((row) => row.eligible);
    if (eligible) return eligible;
    if (rows.length < 128) return null;
    const last = rows.at(-1)!;
    cursor = { at: last.cursor_at!, id: last.id };
  }
}

export async function recoverExpiredItem(
  prisma: PrismaClient,
  input: { family: TaskFamily; taskTypes: string[]; maxAttemptsByType: Record<string, number> },
): Promise<RecoveryResult | null> {
  if (input.taskTypes.length === 0) return null;
  return prisma.$transaction(async (tx) => {
    const row = await selectExpired(tx, input.family, input.taskTypes);
    if (!row) return null;
    const maxAttempts = input.maxAttemptsByType[row.task_type] ?? 3;
    const terminal = row.attempt_count >= maxAttempts;
    const error = json({ code: "stale_processing", attemptCount: row.attempt_count, maxAttempts });
    if (input.family === "catalog_scan") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE catalog_scan_task_item SET
          status = ${terminal ? "failed" : "pending"}, execution_token = NULL,
          locked_by = NULL, locked_until = NULL, heartbeat_at = NULL,
          error = ${terminal ? error : null}::jsonb,
          finished_at = ${terminal ? Prisma.sql`transaction_timestamp()` : Prisma.sql`NULL`},
          updated_at = transaction_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'processing'
      `);
    } else if (input.family === "channel_sync") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE channel_sync_task_item SET
          status = ${terminal ? "failed" : "pending"}, execution_token = NULL,
          locked_by = NULL, locked_until = NULL, heartbeat_at = NULL,
          error = ${terminal ? error : null}::jsonb,
          finished_at = ${terminal ? Prisma.sql`transaction_timestamp()` : Prisma.sql`NULL`},
          updated_at = transaction_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'processing'
      `);
    } else {
      await tx.$executeRaw(Prisma.sql`
        UPDATE generic_task_item SET
          status = ${terminal ? "failed" : "pending"}, execution_token = NULL,
          locked_by = NULL, locked_until = NULL, heartbeat_at = NULL,
          error = ${terminal ? error : null}::jsonb,
          finished_at = ${terminal ? Prisma.sql`transaction_timestamp()` : Prisma.sql`NULL`},
          updated_at = transaction_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'processing'
      `);
    }
    await recomputeParentTask(tx, input.family, row.task_id);
    return {
      family: input.family,
      itemId: row.id,
      taskId: row.task_id,
      action: terminal ? "failed" : "requeued",
      attemptCount: row.attempt_count,
      leaseEpoch: row.lease_epoch,
    };
  });
}

export async function heartbeatTaskItem(
  db: Db,
  lease: TaskLease,
  leaseMs: number,
): Promise<boolean> {
  let count: number;
  const predicate = Prisma.sql`
    id = ${lease.itemId}::uuid AND status = 'processing'
    AND locked_by = ${lease.workerId}
    AND execution_token = ${lease.executionToken}::uuid
    AND lease_epoch = ${lease.leaseEpoch}
    AND locked_until > transaction_timestamp()
  `;
  if (lease.family === "catalog_scan") {
    count = await db.$executeRaw(Prisma.sql`
      UPDATE catalog_scan_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `);
  } else if (lease.family === "channel_sync") {
    count = await db.$executeRaw(Prisma.sql`
      UPDATE channel_sync_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `);
  } else {
    count = await db.$executeRaw(Prisma.sql`
      UPDATE generic_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `);
  }
  return count === 1;
}

async function guardedFinalize(
  tx: Prisma.TransactionClient,
  lease: TaskLease,
  outcome: TaskOutcome,
): Promise<number> {
  if (lease.family === "catalog_scan" && outcome.status === "skipped") {
    throw new Error("CatalogScan items do not support skipped");
  }
  const result = json(outcome.result);
  const error = json(outcome.error);
  const predicate = Prisma.sql`
    id = ${lease.itemId}::uuid AND status = 'processing'
    AND locked_by = ${lease.workerId}
    AND execution_token = ${lease.executionToken}::uuid
    AND lease_epoch = ${lease.leaseEpoch}
    AND locked_until > transaction_timestamp()
  `;
  if (lease.family === "catalog_scan") {
    return tx.$executeRaw(Prisma.sql`
      UPDATE catalog_scan_task_item SET status = ${outcome.status},
        result = ${result}::jsonb, error = ${error}::jsonb,
        execution_token = NULL, locked_by = NULL, locked_until = NULL,
        heartbeat_at = NULL, finished_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
      WHERE ${predicate}
    `);
  }
  if (lease.family === "channel_sync") {
    return tx.$executeRaw(Prisma.sql`
      UPDATE channel_sync_task_item SET status = ${outcome.status},
        result = ${result}::jsonb, error = ${error}::jsonb,
        execution_token = NULL, locked_by = NULL, locked_until = NULL,
        heartbeat_at = NULL, finished_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
      WHERE ${predicate}
    `);
  }
  return tx.$executeRaw(Prisma.sql`
    UPDATE generic_task_item SET status = ${outcome.status},
      result = ${result}::jsonb, error = ${error}::jsonb,
      execution_token = NULL, locked_by = NULL, locked_until = NULL,
      heartbeat_at = NULL, finished_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
    WHERE ${predicate}
  `);
}

export async function finalizeTaskItem(
  prisma: PrismaClient,
  lease: TaskLease,
  outcome: TaskOutcome,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const affected = await guardedFinalize(tx, lease, outcome);
    if (affected !== 1) throw new LeaseLostError(lease);
    if (outcome.protectedWrite) await outcome.protectedWrite(tx);
    await tx.operationAudit.create({
      data: {
        actorType: "worker",
        actorId: lease.workerId,
        action: `task_item.${outcome.status}`,
        entityType: `${lease.family}_task_item`,
        entityId: lease.itemId,
        taskType: lease.taskType,
        taskId: lease.taskId,
        reason: outcome.status === "failed" ? "worker_terminal_failure" : null,
      },
    });
    await recomputeParentTask(tx, lease.family, lease.taskId);
  });
}
