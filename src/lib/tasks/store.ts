import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { withDbRetry } from "@/lib/db/db-retry";
import type {
  RecoveryResult,
  TaskFamily,
  TaskClaimTarget,
  TaskLease,
  TaskMode,
  TaskOutcome,
} from "./types";
import { TASK_FAMILIES } from "./types";
import { sanitizePersistedTaskError } from "./errors";

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
  mode: TaskMode;
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

export function validateTaskClaimTarget(target: TaskClaimTarget): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!target || !TASK_FAMILIES.includes(target.family)
    || typeof target.taskId !== "string" || !uuid.test(target.taskId)
    || typeof target.itemId !== "string" || !uuid.test(target.itemId)) {
    throw new Error("task_claim_target_invalid");
  }
}

async function selectPending(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskTypes: string[],
  target?: TaskClaimTarget,
): Promise<CandidateRow | null> {
  if (family === "catalog_scan" && !taskTypes.includes("catalog_scan")) return null;
  const targetClause = target
    ? Prisma.sql`AND i.task_id = ${target.taskId}::uuid AND i.id = ${target.itemId}::uuid`
    : Prisma.empty;
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
          WHERE i.status = 'pending' ${cursorClause} ${targetClause}
            AND NOT EXISTS (
              SELECT 1 FROM catalog_scan_task_item earlier
              WHERE earlier.task_id = i.task_id AND earlier.page_index < i.page_index
                AND earlier.status IN ('pending', 'processing')
            )
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
          WHERE i.status = 'pending' ${cursorClause} ${targetClause}
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
          WHERE i.status = 'pending' ${cursorClause} ${targetClause}
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
      UPDATE catalog_scan_task_item i
      SET status = 'processing', attempt_count = i.attempt_count + 1,
          execution_token = ${executionToken}::uuid, lease_epoch = lease_epoch + 1,
          locked_by = ${workerId},
          locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
          heartbeat_at = transaction_timestamp(),
          started_at = COALESCE(i.started_at, transaction_timestamp()),
          finished_at = NULL, updated_at = transaction_timestamp()
      FROM catalog_scan_task t
      WHERE i.id = ${itemId}::uuid AND i.status = 'pending' AND t.id = i.task_id
      RETURNING i.id, i.task_id, 'catalog_scan'::text AS task_type, t.mode, i.payload,
                i.attempt_count, i.lease_epoch, i.execution_token, i.locked_until
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
      RETURNING i.id, i.task_id, t.task_type, t.mode, i.payload,
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
      RETURNING i.id, i.task_id, t.task_type, t.mode, i.payload,
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
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM catalog_scan_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
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
          WHEN t.result->>'terminalState' = 'partial_failed'
            OR EXISTS (
              SELECT 1 FROM catalog_scan_task_item terminal_item
              WHERE terminal_item.task_id = t.id
                AND terminal_item.result->>'terminalState' = 'partial_failed'
            ) THEN 'completed_with_errors'
          WHEN c.failed > 0 AND c.success = 0 THEN 'failed'
          WHEN c.failed > 0 THEN 'completed_with_errors'
          ELSE 'completed' END,
        started_at = COALESCE(t.started_at, transaction_timestamp()),
        completed_at = CASE WHEN c.pending + c.processing = 0 THEN transaction_timestamp() ELSE NULL END,
        updated_at = transaction_timestamp()
      FROM counts c WHERE t.id = ${taskId}::uuid
    `);
  } else if (family === "channel_sync") {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM channel_sync_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
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
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generic_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
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
    claimTarget?: TaskClaimTarget;
  },
): Promise<TaskLease | null> {
  if (input.claimTarget !== undefined) {
    validateTaskClaimTarget(input.claimTarget);
    if (input.claimTarget.family !== input.family) return null;
  }
  if (input.taskTypes.length === 0) return null;
  if (input.leaseMs < 1) throw new Error("leaseMs must be positive");
  // `withDbRetry` wraps the whole `$transaction` call, never a statement
  // inside it — Postgres aborts the entire transaction on most errors, so a
  // partial-statement retry inside an already-open transaction cannot work
  // (see `src/server/publish-gate/service.ts`'s `applyPublishTransition` for
  // the same reasoning). Safe to retry from scratch: nothing commits until
  // the callback returns, so a genuinely transient failure (lock-wait
  // timeout, serialization failure) leaves no lease assigned and a retry
  // simply re-selects a pending candidate. If the failure was instead an
  // ambiguous commit (the write actually landed but the connection dropped
  // before the ack), `selectPending`'s `status = 'pending'` predicate no
  // longer matches that row on retry — the retry picks a *different*
  // pending item (or none) and the first item's real, committed lease is
  // simply not returned to this caller. That is not a new failure mode:
  // it is the same "lease exists but no worker is actively holding it"
  // state a crashed worker already leaves behind, and `recoverExpiredItem`
  // already exists to reclaim it once `locked_until` passes.
  return withDbRetry(
    () =>
      prisma.$transaction(async (tx) => {
        const candidate = await selectPending(tx, input.family, input.taskTypes, input.claimTarget);
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
          mode: row.mode,
          itemId: row.id,
          taskId: row.task_id,
          workerId: input.workerId,
          executionToken: row.execution_token,
          leaseEpoch: row.lease_epoch,
          attemptCount: row.attempt_count,
          lockedUntil: row.locked_until,
          payload: row.payload,
        };
      }),
    { op: "tasks.claimPendingItem", sourceKey: input.family },
  );
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
  input: {
    family: TaskFamily;
    taskTypes: string[];
    maxAttemptsByType: Record<string, number>;
    workerId?: string;
  },
): Promise<RecoveryResult | null> {
  if (input.taskTypes.length === 0) return null;
  // Same whole-transaction retry shape as `claimPendingItem` above, and safe
  // for the same reason: nothing commits until the callback returns, and
  // `selectExpired`'s `status = 'processing'` predicate no longer matches a
  // row this same function already (ambiguously) recovered, so a retry
  // after an ack-lost commit picks a different expired candidate rather
  // than double-processing the first one.
  return withDbRetry(
    () =>
      prisma.$transaction(async (tx) => {
    const row = await selectExpired(tx, input.family, input.taskTypes);
    if (!row) return null;
    const maxAttempts = input.maxAttemptsByType[row.task_type] ?? 3;
    const terminal = row.attempt_count >= maxAttempts;
    const error = json(sanitizePersistedTaskError({
      code: "stale_processing",
      message: `Processing lease expired at attempt ${row.attempt_count} of ${maxAttempts}`,
    }));
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
    if (terminal) {
      await tx.operationAudit.create({
        data: {
          actorType: "worker",
          actorId: input.workerId ?? "lease-recovery",
          action: "task_item.failed",
          entityType: `${input.family}_task_item`,
          entityId: row.id,
          taskType: row.task_type,
          taskId: row.task_id,
          reason: "stale_processing",
        },
      });
    }
    await recomputeParentTask(tx, input.family, row.task_id);
    return {
      family: input.family,
      taskType: row.task_type,
      itemId: row.id,
      taskId: row.task_id,
      action: terminal ? "failed" : "requeued",
      attemptCount: row.attempt_count,
      leaseEpoch: row.lease_epoch,
    };
      }),
    { op: "tasks.recoverExpiredItem", sourceKey: input.family },
  );
}

export async function heartbeatTaskItem(
  db: Db,
  lease: TaskLease,
  leaseMs: number,
): Promise<boolean> {
  const predicate = Prisma.sql`
    id = ${lease.itemId}::uuid AND status = 'processing'
    AND locked_by = ${lease.workerId}
    AND execution_token = ${lease.executionToken}::uuid
    AND lease_epoch = ${lease.leaseEpoch}
    AND locked_until > transaction_timestamp()
  `;
  let statement: Prisma.Sql;
  if (lease.family === "catalog_scan") {
    statement = Prisma.sql`
      UPDATE catalog_scan_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `;
  } else if (lease.family === "channel_sync") {
    statement = Prisma.sql`
      UPDATE channel_sync_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `;
  } else {
    statement = Prisma.sql`
      UPDATE generic_task_item SET
        locked_until = transaction_timestamp() + (${leaseMs} * interval '1 millisecond'),
        heartbeat_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE ${predicate}
    `;
  }
  // A single `$executeRaw` statement is its own implicit transaction — no
  // multi-statement transaction to worry about retrying part of. Re-running
  // this exact conditional UPDATE (fencing on `execution_token`/
  // `lease_epoch`/`locked_by`/`status`) after a transient failure is
  // idempotent either way: if the first attempt never committed, the retry
  // applies it once; if it ambiguously did commit, the retry's `locked_until
  // > transaction_timestamp()` predicate still matches (the row is still
  // `processing` under the same lease) and it just extends `locked_until`
  // a little further — never a fencing violation, never a double side
  // effect visible to the caller.
  const count = await withDbRetry(
    () => db.$executeRaw(statement),
    { op: "tasks.heartbeatTaskItem", itemId: lease.itemId, sourceKey: lease.family },
  );
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
  const error = json(
    outcome.status === "failed" ? sanitizePersistedTaskError(outcome.error) : null,
  );
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
  // Whole-transaction retry, same shape as `claimPendingItem`/
  // `recoverExpiredItem` above. `guardedFinalize`'s fencing predicate
  // (`execution_token`/`lease_epoch`/`locked_by`/`status = 'processing'`)
  // is the safety net an ambiguous-commit-then-retry relies on: if the
  // first attempt actually committed before the connection dropped, the
  // retried `guardedFinalize` no longer matches the row (it is no longer
  // `processing`) and `affected !== 1`, so this throws `LeaseLostError`
  // instead of re-applying `outcome`. Per the frozen fencing contract
  // (CLAUDE.md §5 修正3), a fencing mismatch must reject and must never be
  // retried further — `LeaseLostError` never matches `isTransientDbError`
  // (its message names no transient condition), so `withDbRetry` rethrows
  // it immediately. This means a genuine ambiguous-commit race surfaces to
  // the caller as `LeaseLostError` even though the finalize actually
  // succeeded — a conservative, fail-closed outcome (never a double write)
  // rather than a fully accurate one; see `src/lib/tasks/store.ts` in this
  // PR's write-up for why that trade-off was accepted rather than adding a
  // new idempotency read here.
  await withDbRetry(
    () =>
      prisma.$transaction(async (tx) => {
    const affected = await guardedFinalize(tx, lease, outcome);
    if (affected !== 1) throw new LeaseLostError(lease);
    if (lease.family === "catalog_scan" && outcome.result && typeof outcome.result === "object" && !Array.isArray(outcome.result)) {
      const stopReason = (outcome.result as Record<string, unknown>).stopReason;
      if (typeof stopReason === "string" && [
        "expected_total_reached",
        "expected_pages_reached",
        "empty_page",
        "short_page",
        "safety_limit",
        "upstream_error",
      ].includes(stopReason)) {
        const terminalStatus = stopReason === "upstream_error" ? "failed" : "success";
        await tx.$executeRaw(Prisma.sql`
          UPDATE catalog_scan_task_item remaining
          SET status = ${terminalStatus}, returned_count = COALESCE(returned_count, 0),
              result = jsonb_build_object('stoppedBeforeFetch', true, 'stopReason', ${stopReason}),
              error = ${stopReason === "upstream_error"
                ? JSON.stringify(sanitizePersistedTaskError({ code: "upstream_error", message: "Catalog scan stopped after an upstream error" }))
                : null}::jsonb,
              finished_at = transaction_timestamp(), updated_at = transaction_timestamp()
          WHERE remaining.task_id = ${lease.taskId}::uuid AND remaining.status = 'pending'
            AND remaining.page_index > (
              SELECT current_item.page_index FROM catalog_scan_task_item current_item
              WHERE current_item.id = ${lease.itemId}::uuid
            )
        `);
      }
    }
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
      }),
    { op: "tasks.finalizeTaskItem", itemId: lease.itemId, sourceKey: lease.family },
  );
}
