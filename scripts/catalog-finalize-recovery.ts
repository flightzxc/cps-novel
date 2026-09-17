/**
 * Controlled catalog-gap recovery. The default mode is read-only and the
 * write mode requires both a pinned gap fingerprint and two explicit
 * confirmations. This tool is shipped for a future operator run; it is not
 * invoked by deployment or by the worker.
 *
 * Discover/dry-run:
 *   npx tsx scripts/catalog-finalize-recovery.ts \
 *     --task-id <uuid> --expected-total <n> --terminal-page <n> \
 *     --request-id <stable-id> --gap-fingerprint discover
 *
 * Apply after reviewing the dry-run output:
 *   npx tsx scripts/catalog-finalize-recovery.ts \
 *     --task-id <uuid> --expected-total <n> --terminal-page <n> \
 *     --request-id <same-stable-id> --gap-fingerprint <sha256> \
 *     --apply --confirm-task-id <same-uuid> --confirm APPLY_CATALOG_RECOVERY
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  createMoboreaderReadAdapter,
  moboreaderUpstreamRateGate,
  resolveMoboreaderUpstreamRateLimitConfig,
  type MoboreaderReadAdapter,
} from "../src/lib/adapters";
import {
  catalogFinalizeGeneration,
  MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
  MOBOREADER_CATALOG_TARGET_TYPES,
  MOBOREADER_TASK_TYPES,
} from "../src/lib/tasks/moboreader";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";
import {
  catalogRecoveryFingerprint,
  parseCatalogScanTaskParams,
  type CatalogRecoveryIdentity,
  type MoboreaderCatalogPayload,
} from "../worker/handlers/moboreader";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type RecoveryArgs = Readonly<{
  taskId: string;
  expectedTotal: number;
  terminalPage: number;
  requestId: string;
  gapFingerprint: string;
  apply: boolean;
  confirmTaskId?: string;
  confirm?: string;
}>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(raw: string | undefined, code: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

export function parseCatalogRecoveryArgs(): RecoveryArgs {
  const taskId = option("--task-id") ?? "";
  const requestId = option("--request-id") ?? "";
  const gapFingerprint = option("--gap-fingerprint") ?? "";
  const apply = process.argv.includes("--apply");
  if (!UUID.test(taskId)) throw new Error("task_id_invalid");
  if (!requestId.trim() || requestId.length > 160) throw new Error("request_id_invalid");
  if (gapFingerprint !== "discover" && !SHA256.test(gapFingerprint)) throw new Error("gap_fingerprint_invalid");
  if (apply && gapFingerprint === "discover") throw new Error("apply_requires_pinned_gap_fingerprint");
  const args: RecoveryArgs = {
    taskId,
    expectedTotal: positiveInteger(option("--expected-total"), "expected_total_invalid"),
    terminalPage: positiveInteger(option("--terminal-page"), "terminal_page_invalid"),
    requestId,
    gapFingerprint,
    apply,
    confirmTaskId: option("--confirm-task-id"),
    confirm: option("--confirm"),
  };
  if (apply && (args.confirmTaskId !== taskId || args.confirm !== "APPLY_CATALOG_RECOVERY")) {
    throw new Error("apply_confirmation_invalid");
  }
  return args;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function identityKey(identity: CatalogRecoveryIdentity): string {
  return JSON.stringify([identity.externalBookId, identity.sourceLanguageCode]);
}

async function loadRecoveryContext(db: PrismaClient, args: RecoveryArgs) {
  const task = await db.genericTask.findUnique({
    where: { id: args.taskId },
    select: {
      id: true, taskType: true, status: true, mode: true, params: true, result: true,
      channelAccountId: true, channelAppId: true,
    },
  });
  if (!task || task.taskType !== MOBOREADER_TASK_TYPES.catalogScan) throw new Error("catalog_task_not_found");
  if (task.status !== "paused") throw new Error("catalog_task_must_remain_paused");
  if (task.mode !== "apply") throw new Error("catalog_task_apply_mode_required");
  if (!task.channelAccountId || !task.channelAppId) throw new Error("catalog_task_scope_missing");
  const result = jsonObject(task.result);
  if (result.catalogObservedTotal !== args.expectedTotal) throw new Error("expected_total_mismatch");
  if (result.terminalPage !== args.terminalPage && jsonObject(result.checkpoint).lastCompletedPage !== args.terminalPage - 1) {
    throw new Error("terminal_page_mismatch");
  }
  const processingCount = await db.genericTaskItem.count({ where: { taskId: task.id, status: "processing" } });
  if (processingCount !== 0) throw new Error("catalog_task_has_processing_items");
  const pageItem = await db.genericTaskItem.findUnique({
    where: { taskId_targetType_targetId: {
      taskId: task.id, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page, targetId: String(args.terminalPage),
    } },
    select: { payload: true },
  });
  if (!pageItem) throw new Error("terminal_page_item_missing");
  const payload = pageItem.payload as unknown as MoboreaderCatalogPayload;
  const params = parseCatalogScanTaskParams(task.params);
  if (payload.pageIndex !== args.terminalPage || payload.pageSize !== params.pageSize || payload.projectType !== params.projectType) {
    throw new Error("terminal_page_payload_mismatch");
  }
  const credentials = await db.channelAccountCredential.findMany({
    where: {
      channelAccountId: task.channelAccountId,
      status: "active",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, encryptedSecret: true, keyVersion: true },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  if (credentials.length !== 1) throw new Error("active_credential_not_unique");
  return { task, result, payload, credential: credentials[0] };
}

export async function runCatalogRecovery(
  db: PrismaClient,
  args: RecoveryArgs,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { adapter?: MoboreaderReadAdapter } = {},
) {
  const context = await loadRecoveryContext(db, args);
  const rateLimit = resolveMoboreaderUpstreamRateLimitConfig(env);
  const adapter = dependencies.adapter ?? createMoboreaderReadAdapter({
    rateGate: moboreaderUpstreamRateGate,
    upstreamRateLimitPolicy: {
      maxAttempts: rateLimit.maxRateLimitRetries,
      backoffBaseMs: rateLimit.backoffBaseMs,
      backoffCapMs: rateLimit.backoffCapMs,
      retryAfterCapMs: rateLimit.retryAfterCapMs,
      totalBudgetMs: rateLimit.totalBudgetMs,
    },
  });
  const token = decryptCredentialSecretForWorker(
    context.credential.encryptedSecret,
    context.task.channelAccountId!,
    context.credential.id,
    context.credential.keyVersion,
    env,
  );
  const response = await adapter.listBooks({
    name: context.payload.name,
    orderType: context.payload.orderType,
    pageIndex: args.terminalPage,
    pageSize: context.payload.pageSize,
    projectType: context.payload.projectType,
  }, token, AbortSignal.timeout(30_000));
  if (response.totalCount !== args.expectedTotal) throw new Error("upstream_total_drift");
  if (response.items.length > context.payload.pageSize) throw new Error("upstream_page_limit_exceeded");
  const upstreamIdentities = response.items.map((book) => ({
    externalBookId: book.externalBookId,
    sourceLanguageCode: book.language,
  }));
  const existing = upstreamIdentities.length === 0 ? [] : await db.novelSourceItem.findMany({
    where: {
      channelAppId: context.task.channelAppId!,
      OR: upstreamIdentities.map((identity) => ({
        externalBookId: identity.externalBookId,
        sourceLanguageCode: identity.sourceLanguageCode,
      })),
    },
    select: { externalBookId: true, sourceLanguageCode: true },
  });
  const existingKeys = new Set(existing.map(identityKey));
  const missingIdentities = upstreamIdentities.filter((identity) => !existingKeys.has(identityKey(identity)));
  const computedFingerprint = catalogRecoveryFingerprint(missingIdentities);
  const failedPages = await db.genericTaskItem.count({
    where: { taskId: args.taskId, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page, status: "failed" },
  });
  const [pendingRow] = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM generic_task_item
    WHERE task_id = ${args.taskId}::uuid AND target_type = 'catalog_page' AND status = 'pending'
      AND (target_id)::int > ${args.terminalPage}
  `);
  const pendingAfterTerminal = Number(pendingRow.count);
  const report = {
    mode: args.apply ? "apply" : "dry_run",
    taskId: args.taskId,
    taskStatus: context.task.status,
    expectedTotal: args.expectedTotal,
    terminalPage: args.terminalPage,
    upstreamPageCount: response.items.length,
    missingCount: missingIdentities.length,
    missingIdentities,
    gapFingerprint: computedFingerprint,
    historicalFailedPages: failedPages,
    pendingPagesToTerminate: pendingAfterTerminal,
  } as const;
  if (!args.apply) {
    if (args.gapFingerprint !== "discover" && args.gapFingerprint !== computedFingerprint) {
      throw new Error("gap_fingerprint_mismatch");
    }
    return report;
  }
  if (args.gapFingerprint !== computedFingerprint) throw new Error("gap_fingerprint_mismatch");

  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT status FROM generic_task WHERE id = ${args.taskId}::uuid FOR UPDATE
    `);
    if (locked[0]?.status !== "paused") throw new Error("catalog_task_must_remain_paused");
    const processing = await tx.genericTaskItem.count({ where: { taskId: args.taskId, status: "processing" } });
    if (processing !== 0) throw new Error("catalog_task_has_processing_items");
    await tx.$executeRaw(Prisma.sql`
      UPDATE generic_task_item SET
        status = 'success',
        result = jsonb_build_object('stoppedBeforeFetch', true, 'stopReason', 'controlled_recovery', 'returnedCount', 0),
        error = NULL, finished_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE task_id = ${args.taskId}::uuid AND target_type = 'catalog_page' AND status = 'pending'
        AND (target_id)::int > ${args.terminalPage}
    `);
    if (missingIdentities.length > 0) {
      await tx.genericTaskItem.upsert({
        where: { taskId_targetType_targetId: {
          taskId: args.taskId,
          targetType: MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage,
          targetId: String(args.terminalPage),
        } },
        create: {
          taskId: args.taskId,
          targetType: MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage,
          targetId: String(args.terminalPage),
          payload: {
            ...context.payload,
            kind: MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            requestId: args.requestId,
            missingIdentities,
            gapFingerprint: computedFingerprint,
          },
        },
        update: {
          status: "pending", attemptCount: 0, executionToken: null, lockedBy: null,
          lockedUntil: null, heartbeatAt: null, result: Prisma.DbNull,
          error: Prisma.DbNull, finishedAt: null,
          payload: {
            ...context.payload,
            kind: MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            requestId: args.requestId,
            missingIdentities,
            gapFingerprint: computedFingerprint,
          },
        },
      });
    }
    const existingFinalize = await tx.genericTaskItem.findUnique({
      where: { taskId_targetType_targetId: {
        taskId: args.taskId,
        targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
      } },
      select: { payload: true },
    });
    const existingFinalizePayload = jsonObject(existingFinalize?.payload);
    const priorFinalization = jsonObject(context.result.finalization);
    const generation = Math.max(
      catalogFinalizeGeneration(existingFinalizePayload.generation),
      catalogFinalizeGeneration(priorFinalization.generation),
    ) + 1;
    const finalizePayload = {
      kind: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      actorId: context.payload.actorId,
      requestId: args.requestId,
      generation,
    };
    await tx.genericTaskItem.upsert({
      where: { taskId_targetType_targetId: {
        taskId: args.taskId,
        targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
      } },
      create: {
        taskId: args.taskId,
        targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
        targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
        payload: finalizePayload,
      },
      update: {
        status: "pending", attemptCount: 0, executionToken: null, lockedBy: null,
        lockedUntil: null, heartbeatAt: null, result: Prisma.DbNull,
        error: Prisma.DbNull, finishedAt: null, payload: finalizePayload,
      },
    });
    await tx.genericTask.update({
      where: { id: args.taskId },
      data: {
        status: "pending",
        completedAt: null,
        result: {
          ...context.result,
          terminalPage: args.terminalPage,
          finalization: { status: "pending", targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID, generation },
          terminalState: "processing",
          recovery: {
            requestId: args.requestId,
            terminalPage: args.terminalPage,
            gapFingerprint: computedFingerprint,
            missingCount: missingIdentities.length,
            generation,
          },
        },
      },
    });
    await tx.operationAudit.create({
      data: {
        actorType: "admin",
        actorId: context.payload.actorId,
        action: "moboreader.catalog_recovery.queued",
        entityType: "GenericTask",
        entityId: args.taskId,
        requestId: args.requestId,
        taskType: MOBOREADER_TASK_TYPES.catalogScan,
        taskId: args.taskId,
        afterSnapshot: {
          terminalPage: args.terminalPage,
          gapFingerprint: computedFingerprint,
          missingCount: missingIdentities.length,
          generation,
          historicalFailedPages: failedPages,
          pendingPagesTerminated: pendingAfterTerminal,
        },
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return report;
}

async function main(): Promise<void> {
  const args = parseCatalogRecoveryArgs();
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await runCatalogRecovery(db, args), null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
