/**
 * Read-only IndexNow delivery status (B-41). Counterpart of CPS
 * `scripts/indexnow-status.ts`, extended for the batch / breaker model.
 *
 * Prints one JSON document:
 *   - `control`: breaker (open + what tripped it + `repeatAfterResume`), the
 *     global 429 wait, the last manual resume, the last bisect;
 *   - `keyValidation`: `verified` (latest accepted request was HTTP 200),
 *     `pending` (it was 202 — protocol accepted, key validation outstanding)
 *     or `none`, with 200/202 counts overall and for the last 24 hours;
 *   - outbox rows by status × source, due backlog, cancelled rows by
 *     `lastErrorKind` (with URLs for `url_invalid` / `url_host_mismatch`),
 *     dead letters (listed);
 *   - attempt results by HTTP status, overall and last 24 hours;
 *   - task items of the batch delivery task and of the minute scan task,
 *     counted separately.
 *
 * Every count carries its unit in the field name — they are three different
 * quantities and must never be added together:
 *   `urls`          — outbox rows / attempt rows (one URL in one request);
 *   `httpRequests`  — distinct `request_batch_id`;
 *   `taskItems`     — `GenericTaskItem` rows.
 *
 * When the breaker is open, the full URL list of the batch that tripped it is
 * included (`breaker.batch`), because "which URLs were in the request" is the
 * first thing an operator needs before deciding to resume.
 *
 * Usage:
 *   tsx scripts/indexnow-status.ts --help
 *   tsx scripts/indexnow-status.ts
 *   tsx scripts/indexnow-status.ts --batch <requestBatchId>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  deriveKeyValidation,
  getIndexNowDeliveryControlState,
  listIndexNowRequestBatch,
  readIndexNowDbNow,
  type IndexNowDeliveryControlState,
} from "../src/lib/indexnow/delivery-control";
import { indexNowDueWhere, redactIndexNowSecrets } from "../src/lib/indexnow/delivery-primitives";
import { INDEXNOW_DELIVERY_TASK_TYPE } from "../src/lib/indexnow/outbox-contract";
import { INDEXNOW_SWEEP_TASK_TYPE } from "../src/lib/tasks/indexnow-sweep";

export const STATUS_USAGE = `Usage:
  tsx scripts/indexnow-status.ts --help
  tsx scripts/indexnow-status.ts
  tsx scripts/indexnow-status.ts --batch <requestBatchId>

Read-only. Counts are named by unit: urls (outbox/attempt rows), httpRequests (distinct request_batch_id),
taskItems (GenericTaskItem rows; the delivery task and the minute scan task are counted separately).
`;

const LISTING_LIMIT = 200;

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

type AttemptWindowRow = { httpStatus: number | null; requestBatchId: string; outcome: string };

function resultsByHttpStatus(rows: readonly AttemptWindowRow[]) {
  const byStatus = new Map<string, { urls: number; batches: Set<string> }>();
  for (const row of rows) {
    const key = row.httpStatus === null ? "none" : String(row.httpStatus);
    const bucket = byStatus.get(key) ?? { urls: 0, batches: new Set<string>() };
    bucket.urls++;
    bucket.batches.add(row.requestBatchId);
    byStatus.set(key, bucket);
  }
  return [...byStatus.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([httpStatus, bucket]) => ({ httpStatus, urls: bucket.urls, httpRequests: bucket.batches.size }));
}

function acceptedByStatus(rows: readonly AttemptWindowRow[]) {
  const count = (status: number) => {
    const matching = rows.filter((row) => row.outcome === "accepted" && row.httpStatus === status);
    return { urls: matching.length, httpRequests: new Set(matching.map((row) => row.requestBatchId)).size };
  };
  return { status200: count(200), status202: count(202) };
}

async function taskItemCounts(db: PrismaClient, taskType: string) {
  const groups = await db.genericTaskItem.groupBy({
    by: ["status"],
    where: { task: { taskType } },
    _count: { _all: true },
  });
  return Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
}

export function describeControl(control: IndexNowDeliveryControlState) {
  return {
    dbNow: control.dbNow,
    breaker: control.breaker.open
      ? {
          open: true,
          repeatAfterResume: control.repeatAfterResume,
          trippedBy: {
            auditId: control.breaker.trippedBy.auditId,
            requestBatchId: control.breaker.trippedBy.requestBatchId,
            httpStatus: control.breaker.trippedBy.httpStatus,
            urls: control.breaker.trippedBy.urlCount,
            heldRetry: control.breaker.trippedBy.heldRetry,
            at: control.breaker.trippedBy.createdAt,
          },
          breakerTripEvents: control.breaker.breakerTripEvents,
        }
      : { open: false },
    rateLimit: control.rateLimit.waiting
      ? { waiting: true, until: control.rateLimit.until, requestBatchId: control.rateLimit.requestBatchId }
      : { waiting: false },
    lastResume: control.lastResume
      ? {
          auditId: control.lastResume.auditId,
          actorId: control.lastResume.actorId,
          reason: control.lastResume.reason,
          at: control.lastResume.createdAt,
          resumedTripAuditId: control.lastResume.resumedTripAuditId,
        }
      : null,
    lastBisect: control.lastBisect
      ? (() => {
          const snapshot = control.lastBisect.snapshot as Record<string, unknown>;
          return {
            auditId: control.lastBisect.auditId,
            at: control.lastBisect.createdAt,
            conclusion: snapshot.conclusion ?? null,
            httpRequests: snapshot.probes ?? null,
            acceptedUrls: snapshot.acceptedCount ?? null,
            culprits: snapshot.culprits ?? [],
            raisedMaxAttemptsBy: snapshot.raisedMaxAttemptsBy ?? null,
            originalRequestBatchId: snapshot.originalRequestBatchId ?? null,
            urls: snapshot.urlCount ?? null,
          };
        })()
      : null,
  };
}

export async function collectIndexNowStatus(db: PrismaClient) {
  const control = await getIndexNowDeliveryControlState(db);
  const dbNow = await readIndexNowDbNow(db);
  const since24h = new Date(dbNow.getTime() - 24 * 60 * 60_000);

  const completedWhere = { attemptState: "completed" } as const;
  const [allAttempts, recentAttempts] = await Promise.all([
    db.indexNowOutboxAttempt.findMany({ where: completedWhere, select: { httpStatus: true, requestBatchId: true, outcome: true } }),
    db.indexNowOutboxAttempt.findMany({
      where: { ...completedWhere, responseAt: { gte: since24h } },
      select: { httpStatus: true, requestBatchId: true, outcome: true },
    }),
  ]);
  const lastAccepted = await db.indexNowOutboxAttempt.findFirst({
    where: { ...completedWhere, outcome: "accepted" },
    orderBy: { id: "desc" },
    select: { httpStatus: true, responseAt: true, requestBatchId: true },
  });

  const outboxGroups = await db.indexNowOutbox.groupBy({
    by: ["status", "source"],
    _count: { _all: true },
  });
  const cancelledGroups = await db.indexNowOutbox.groupBy({
    by: ["lastErrorKind"],
    where: { status: "cancelled" },
    _count: { _all: true },
  });
  const invalidUrls = await db.indexNowOutbox.findMany({
    where: { status: "cancelled", lastErrorKind: { in: ["url_invalid", "url_host_mismatch"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: LISTING_LIMIT,
    select: { id: true, url: true, lastErrorKind: true, lastErrorSummary: true },
  });
  // A URL that failed the format check may carry a query string, and a query string may carry key material.
  const safeInvalidUrls = invalidUrls.map((row) => ({ ...row, url: redactIndexNowSecrets(row.url) }));
  const deadLetters = await db.indexNowOutbox.findMany({
    where: { status: "dead_letter" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: LISTING_LIMIT,
    select: { id: true, url: true, attemptCount: true, maxAttempts: true, lastHttpStatus: true, lastErrorKind: true, lastErrorSummary: true },
  });
  const dueUrls = await db.indexNowOutbox.count({ where: indexNowDueWhere(dbNow) });
  const inFlightBatchTasks = await db.genericTask.findMany({
    where: { taskType: INDEXNOW_DELIVERY_TASK_TYPE, status: { in: ["pending", "processing"] } },
    select: { id: true, status: true, createdAt: true, params: true },
  });

  const breakerBatch =
    control.breaker.open && control.breaker.trippedBy.requestBatchId
      ? (await listIndexNowRequestBatch(db, control.breaker.trippedBy.requestBatchId)).map((row) => ({ ...row, url: redactIndexNowSecrets(row.url) }))
      : null;

  const lastAcceptedStatus = lastAccepted?.httpStatus ?? null;
  return jsonSafe({
    generatedAt: dbNow,
    control: describeControl(control),
    ...(breakerBatch
      ? { breaker: { requestBatchId: control.breaker.open ? control.breaker.trippedBy.requestBatchId : null, repeatAfterResume: control.repeatAfterResume, urls: breakerBatch.length, batch: breakerBatch } }
      : {}),
    keyValidation: {
      state: deriveKeyValidation(lastAcceptedStatus),
      lastAccepted: lastAccepted
        ? { httpStatus: lastAccepted.httpStatus, at: lastAccepted.responseAt, requestBatchId: lastAccepted.requestBatchId }
        : null,
      accepted: { all: acceptedByStatus(allAttempts), last24h: acceptedByStatus(recentAttempts) },
    },
    outbox: {
      urlsByStatusAndSource: outboxGroups
        .map((group) => ({ status: group.status, source: group.source, urls: group._count._all }))
        .sort((a, b) => `${a.status}|${a.source}`.localeCompare(`${b.status}|${b.source}`)),
      dueUrls,
      cancelledUrlsByErrorKind: cancelledGroups.map((group) => ({ lastErrorKind: group.lastErrorKind, urls: group._count._all })),
      invalidUrls: safeInvalidUrls,
      deadLetters: deadLetters.map((row) => ({ ...row, url: redactIndexNowSecrets(row.url) })),
    },
    attempts: {
      all: resultsByHttpStatus(allAttempts),
      last24h: resultsByHttpStatus(recentAttempts),
    },
    tasks: {
      deliveryTaskItemsByStatus: await taskItemCounts(db, INDEXNOW_DELIVERY_TASK_TYPE),
      scanTaskItemsByStatus: await taskItemCounts(db, INDEXNOW_SWEEP_TASK_TYPE),
      inFlightBatchTasks: inFlightBatchTasks.map((task) => ({ taskId: task.id, status: task.status, createdAt: task.createdAt, taskItems: 1 })),
    },
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(STATUS_USAGE);
    return;
  }
  const prisma = new PrismaClient();
  try {
    const batchIndex = argv.indexOf("--batch");
    if (batchIndex >= 0) {
      const requestBatchId = argv[batchIndex + 1];
      if (!requestBatchId || requestBatchId.startsWith("--")) throw new Error("--batch requires a requestBatchId");
      const rows = (await listIndexNowRequestBatch(prisma, requestBatchId)).map((row) => ({ ...row, url: redactIndexNowSecrets(row.url) }));
      console.log(JSON.stringify(jsonSafe({ requestBatchId, urls: rows.length, rows }), null, 2));
      return;
    }
    console.log(JSON.stringify(await collectIndexNowStatus(prisma), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
