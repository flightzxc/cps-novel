import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createMoboreaderReadAdapter,
  type ListBooksResponse,
  type MoboreaderReadAdapter,
} from "../../src/lib/adapters";
import {
  isNovelCatalogSyncEnabled,
  isNovelCatalogSyncWriteAllowed,
} from "../../src/lib/flags";
import {
  enqueueMoboreaderPreviewRefreshTask,
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_PREVIEW_DISABLED_REASON,
  MOBOREADER_TASK_TYPES,
} from "../../src/lib/tasks/moboreader";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { decryptCredentialSecretForWorker } from "../credentials/crypto";

export interface MoboreaderCatalogPayload {
  pageIndex: number;
  pageSize: number;
  name: string;
  orderType: number;
  projectType: number;
  safetyMaxPages: number;
  requestedPageEnd: number;
  scheduledPageEnd: number;
  expiresAt: string;
  source: "manual";
  actorId: string;
  requestId: string;
}

export type MoboreaderCatalogStopReason =
  | "expected_total_reached"
  | "expected_pages_reached"
  | "empty_page"
  | "short_page"
  | "safety_limit"
  | "upstream_error";

export function determineMoboreaderCatalogStopReason(input: {
  returnedCount: number;
  pageSize: number;
  fetchedRaw: number;
  batchExpectedCount: number;
  pageIndex: number;
  requestedPageEnd: number;
  scheduledPageEnd: number;
}): Exclude<MoboreaderCatalogStopReason, "upstream_error"> | null {
  if (input.returnedCount === 0) return "empty_page";
  if (input.fetchedRaw >= input.batchExpectedCount) return "expected_total_reached";
  if (input.scheduledPageEnd < input.requestedPageEnd && input.pageIndex >= input.scheduledPageEnd) return "safety_limit";
  if (input.pageIndex >= input.requestedPageEnd) return "expected_pages_reached";
  if (input.returnedCount < input.pageSize) return "short_page";
  return null;
}

export function parseMoboreaderCatalogPayload(value: unknown): MoboreaderCatalogPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_payload_invalid");
  const item = value as Partial<MoboreaderCatalogPayload>;
  const integers = [
    item.pageIndex,
    item.pageSize,
    item.projectType,
    item.safetyMaxPages,
    item.requestedPageEnd,
    item.scheduledPageEnd,
    item.orderType,
  ];
  if (integers.some((number) => !Number.isSafeInteger(number))) throw new Error("catalog_payload_invalid");
  if (item.pageIndex! < 1 || item.pageSize! < 1 || item.pageSize! > MOBOREADER_CATALOG_LIMITS.maxPageSize) {
    throw new Error("catalog_payload_invalid");
  }
  if (item.safetyMaxPages! < 1 || item.requestedPageEnd! < item.pageIndex! || item.scheduledPageEnd! < item.pageIndex!) {
    throw new Error("catalog_payload_invalid");
  }
  if (item.source !== "manual" || typeof item.actorId !== "string" || !item.actorId || typeof item.requestId !== "string" || !item.requestId) {
    throw new Error("manual_source_required");
  }
  if (typeof item.expiresAt !== "string" || Number.isNaN(Date.parse(item.expiresAt))) throw new Error("task_expiry_invalid");
  if (typeof item.name !== "string") throw new Error("catalog_payload_invalid");
  return item as MoboreaderCatalogPayload;
}

interface BindingRow {
  project_type: number;
  credential_id: string;
  encrypted_secret: Uint8Array;
  key_version: number;
}

interface CatalogTaskScope {
  channelAccountId: string;
  channelAppId: string;
  projectType: number;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
}

async function loadAndValidateTaskScope(
  db: PrismaClient,
  taskId: string,
  payload: MoboreaderCatalogPayload,
): Promise<CatalogTaskScope> {
  const task = await db.catalogScanTask.findUnique({
    where: { id: taskId },
    select: {
      channelAccountId: true,
      channelAppId: true,
      projectType: true,
      pageStart: true,
      pageEnd: true,
      pageSize: true,
    },
  });
  if (!task) throw new Error("catalog_task_missing");
  const pageCount = task.pageEnd - task.pageStart + 1;
  if (
    pageCount < 1
    || task.pageSize !== payload.pageSize
    || task.projectType !== payload.projectType
    || task.pageEnd !== payload.requestedPageEnd
    || payload.scheduledPageEnd > task.pageEnd
    || payload.scheduledPageEnd - task.pageStart + 1 > payload.safetyMaxPages
    || payload.pageIndex < task.pageStart
    || payload.pageIndex > payload.scheduledPageEnd
  ) {
    throw new Error("catalog_task_bounds_mismatch");
  }
  return task;
}

async function loadBinding(db: PrismaClient, payload: MoboreaderCatalogPayload, accountId: string, appId: string) {
  const rows = await db.$queryRaw<BindingRow[]>(Prisma.sql`
    SELECT ca.project_type, credential.id AS credential_id,
           credential.encrypted_secret, credential.key_version
    FROM channel_app ca
    JOIN channel c ON c.id = ca.channel_id AND c.status = 'active'
    JOIN channel_account account ON account.channel_id = c.id
      AND account.id = ${accountId}::uuid AND account.status = 'active' AND account.deleted_at IS NULL
    JOIN channel_account_credential credential ON credential.channel_account_id = account.id
      AND credential.status = 'active'
    JOIN channel_capability capability ON capability.channel_app_id = ca.id
      AND capability.capability_key = 'getlistpc' AND capability.status = 'enabled'
      AND capability.side_effecting = false
    WHERE ca.id = ${appId}::uuid AND ca.status = 'active'
      AND ca.project_type = ${payload.projectType}
    ORDER BY credential.created_at DESC
    LIMIT 2
  `);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? "catalog_binding_unavailable" : "credential_ambiguous");
  return rows[0];
}

function decimal(value: number | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}

async function persistLabels(
  tx: Prisma.TransactionClient,
  channelAppId: string,
  sourceItemId: string,
  labels: readonly { kind: "series_type" | "recommend" | "language" | "agency"; value: string }[],
  now: Date,
) {
  for (const label of labels) {
    if (!label.value || label.value.length > 300) continue;
    const sourceLabel = await tx.sourceLabel.upsert({
      where: {
        channelAppId_labelKind_externalLabelValue: {
          channelAppId,
          labelKind: label.kind,
          externalLabelValue: label.value,
        },
      },
      create: { channelAppId, labelKind: label.kind, externalLabelValue: label.value },
      update: {},
    });
    await tx.novelSourceItemLabel.upsert({
      where: {
        novelSourceItemId_sourceLabelId: { novelSourceItemId: sourceItemId, sourceLabelId: sourceLabel.id },
      },
      create: { novelSourceItemId: sourceItemId, sourceLabelId: sourceLabel.id, lastSeenAt: now },
      update: { active: true, lastSeenAt: now },
    });
  }
}

async function persistCatalogPage(
  tx: Prisma.TransactionClient,
  input: {
    response: ListBooksResponse;
    payload: MoboreaderCatalogPayload;
    taskId: string;
    itemId: string;
    channelAppId: string;
    env: NodeJS.ProcessEnv;
    now: Date;
  },
) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM catalog_scan_task WHERE id = ${input.taskId}::uuid FOR UPDATE`);
  await tx.catalogScanTaskItem.update({
    where: { id: input.itemId },
    data: { returnedCount: input.response.items.length },
  });
  const now = input.now;
  const sourceItemIds: string[] = [];
  for (const book of input.response.items) {
    const source = await tx.novelSourceItem.upsert({
      where: {
        channelAppId_externalBookId_sourceLanguageCode: {
          channelAppId: input.channelAppId,
          externalBookId: book.externalBookId,
          sourceLanguageCode: book.language,
        },
      },
      create: {
        channelAppId: input.channelAppId,
        externalBookId: book.externalBookId,
        sourceLanguageCode: book.language,
        sourceLanguageName: book.languageName,
        title: book.title,
        description: book.description ?? "",
        coverUrl: book.coverUrl,
        totalChapterCount: book.allEpis ?? 0,
        paidFromChapter: book.payEpisFrom,
        splitRatio: decimal(book.splitRatio),
        ttoSplitRatio: decimal(book.ttoSplitRatio),
        externalAgencyId: book.agencyId,
        sourceCreatedAtRaw: book.createTime,
        lastSeenAt: now,
        rawPayload: book.rawEvidence as Prisma.InputJsonObject,
      },
      update: {
        sourceLanguageName: book.languageName ?? undefined,
        title: book.title,
        description: book.description ?? undefined,
        coverUrl: book.coverUrl ?? undefined,
        totalChapterCount: book.allEpis ?? undefined,
        paidFromChapter: book.payEpisFrom ?? undefined,
        splitRatio: book.splitRatio === null ? undefined : decimal(book.splitRatio),
        ttoSplitRatio: book.ttoSplitRatio === null ? undefined : decimal(book.ttoSplitRatio),
        externalAgencyId: book.agencyId ?? undefined,
        sourceCreatedAtRaw: book.createTime ?? undefined,
        lastSeenAt: now,
        deletedAt: null,
        rawPayload: book.rawEvidence as Prisma.InputJsonObject,
      },
    });
    sourceItemIds.push(source.id);
    const labels: Array<{ kind: "series_type" | "recommend" | "language" | "agency"; value: string }> = [
      ...book.seriesTypeList.map((value) => ({ kind: "series_type" as const, value })),
      ...book.recommendList.map((value) => ({ kind: "recommend" as const, value })),
      { kind: "language", value: book.language },
      ...(book.agencyId ? [{ kind: "agency" as const, value: book.agencyId }] : []),
    ];
    await persistLabels(tx, input.channelAppId, source.id, labels, now);
  }

  const [beforeStop] = await tx.$queryRaw<Array<{ total: bigint; max_page: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(returned_count), 0)::bigint AS total,
           COALESCE(MAX(page_index) FILTER (
             WHERE status = 'success' AND COALESCE((result->>'stoppedBeforeFetch')::boolean, false) = false
           ), ${input.payload.pageIndex})::int AS max_page
    FROM catalog_scan_task_item
    WHERE task_id = ${input.taskId}::uuid AND status = 'success'
  `);
  const fetchedRaw = Number(beforeStop.total);
  const task = await tx.catalogScanTask.findUniqueOrThrow({
    where: { id: input.taskId },
    select: { pageStart: true, pageEnd: true, pageSize: true },
  });
  const requestedCapacity = (task.pageEnd - task.pageStart + 1) * task.pageSize;
  const upstreamRemaining = Math.max(0, input.response.totalCount - (task.pageStart - 1) * task.pageSize);
  const batchExpectedCount = Math.min(requestedCapacity, upstreamRemaining);
  const stopReason = determineMoboreaderCatalogStopReason({
    returnedCount: input.response.items.length,
    pageSize: input.payload.pageSize,
    fetchedRaw,
    batchExpectedCount,
    pageIndex: input.payload.pageIndex,
    requestedPageEnd: input.payload.requestedPageEnd,
    scheduledPageEnd: input.payload.scheduledPageEnd,
  });

  await tx.catalogScanTaskItem.update({
    where: { id: input.itemId },
    data: {
      result: {
        source: "manual",
        pageIndex: input.payload.pageIndex,
        returnedCount: input.response.items.length,
        observedTotal: input.response.totalCount,
        sourceItemIds,
        stopReason,
      },
    },
  });
  if (stopReason) {
    await tx.catalogScanTaskItem.updateMany({
      where: { taskId: input.taskId, status: "pending", pageIndex: { gt: input.payload.pageIndex } },
      data: {
        status: "success",
        returnedCount: 0,
        result: { stoppedBeforeFetch: true, stopReason },
        finishedAt: now,
      },
    });
  }

  const [afterStop] = await tx.$queryRaw<Array<{ actual: bigint; pending: bigint; processing: bigint; failed: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(returned_count), 0)::bigint AS actual,
           COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
           COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
           COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
    FROM catalog_scan_task_item WHERE task_id = ${input.taskId}::uuid
  `);
  const batchActualCount = Number(afterStop.actual);
  const terminal = Number(afterStop.pending) === 0 && Number(afterStop.processing) === 0;
  const partialFailed = terminal && (
    stopReason === "safety_limit"
    || Number(afterStop.failed) > 0
    || batchActualCount < batchExpectedCount
  );
  let previewEnqueue: Prisma.InputJsonObject | null = null;
  let touchedSourceItemIds = sourceItemIds;
  if (terminal) {
    const itemResults = await tx.catalogScanTaskItem.findMany({
      where: { taskId: input.taskId },
      select: { result: true },
    });
    touchedSourceItemIds = Array.from(new Set(itemResults.flatMap(({ result }) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return [];
      const ids = (result as Record<string, unknown>).sourceItemIds;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    })));
    if (touchedSourceItemIds.length > 0) {
      const preview = await enqueueMoboreaderPreviewRefreshTask(tx, {
        trigger: "auto",
        catalogScanTaskId: input.taskId,
        channelAccountId: (await tx.catalogScanTask.findUniqueOrThrow({ where: { id: input.taskId } })).channelAccountId,
        channelAppId: input.channelAppId,
        novelSourceItemIds: touchedSourceItemIds,
        requestToken: `moboreader.preview_refresh.v1:${input.taskId}`,
        actorId: input.payload.actorId,
        requestId: input.payload.requestId,
        mode: "apply",
      }, input.env, now);
      previewEnqueue = preview as unknown as Prisma.InputJsonObject;
    }
  }
  await tx.catalogScanTask.update({
    where: { id: input.taskId },
    data: {
      catalogObservedTotal: input.response.totalCount,
      batchExpectedCount,
      batchActualCount,
      result: {
        checkpoint: {
          lastCompletedPage: beforeStop.max_page,
          returnedCount: input.response.items.length,
          observedTotal: input.response.totalCount,
          completedAt: now.toISOString(),
        },
        stopReason,
        terminalState: terminal ? (partialFailed ? "partial_failed" : "completed") : "processing",
        completeness: {
          expected: batchExpectedCount,
          actual: batchActualCount,
          fetchedUniqueSourceItems: touchedSourceItemIds.length,
          duplicateObservations: Math.max(0, batchActualCount - touchedSourceItemIds.length),
        },
        previewEnqueue,
      },
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: input.payload.actorId,
      action: `moboreader.catalog_page.applied.${input.payload.pageIndex}`,
      entityType: "CatalogScanTaskItem",
      entityId: input.itemId,
      requestId: input.payload.requestId,
      taskType: MOBOREADER_TASK_TYPES.catalogScan,
      taskId: input.taskId,
      afterSnapshot: {
        pageIndex: input.payload.pageIndex,
        returnedCount: input.response.items.length,
        observedTotal: input.response.totalCount,
        stopReason,
      },
    },
  });
}

async function persistCatalogUpstreamFailure(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    itemId: string;
    payload: MoboreaderCatalogPayload;
    channelAppId: string;
    env: NodeJS.ProcessEnv;
    now: Date;
  },
) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM catalog_scan_task WHERE id = ${input.taskId}::uuid FOR UPDATE`);
  const now = input.now;
  await tx.catalogScanTaskItem.updateMany({
    where: { taskId: input.taskId, status: "pending", pageIndex: { gt: input.payload.pageIndex } },
    data: {
      status: "failed",
      error: { code: "upstream_error", message: "Catalog scan stopped after an upstream error" },
      result: { stoppedBeforeFetch: true, stopReason: "upstream_error" },
      finishedAt: now,
    },
  });
  const [totals] = await tx.$queryRaw<Array<{ actual: bigint; expected: number | null }>>(Prisma.sql`
    SELECT COALESCE(SUM(i.returned_count), 0)::bigint AS actual, t.batch_expected_count AS expected
    FROM catalog_scan_task t
    LEFT JOIN catalog_scan_task_item i ON i.task_id = t.id
    WHERE t.id = ${input.taskId}::uuid
    GROUP BY t.batch_expected_count
  `);
  const actual = Number(totals.actual);
  const expected = totals.expected ?? actual;
  const itemResults = await tx.catalogScanTaskItem.findMany({
    where: { taskId: input.taskId },
    select: { result: true },
  });
  const touchedSourceItemIds = Array.from(new Set(itemResults.flatMap(({ result }) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    const ids = (result as Record<string, unknown>).sourceItemIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  })));
  let previewEnqueue: Prisma.InputJsonObject | null = null;
  if (touchedSourceItemIds.length > 0) {
    const task = await tx.catalogScanTask.findUniqueOrThrow({ where: { id: input.taskId } });
    const preview = await enqueueMoboreaderPreviewRefreshTask(tx, {
      trigger: "auto",
      catalogScanTaskId: input.taskId,
      channelAccountId: task.channelAccountId,
      channelAppId: input.channelAppId,
      novelSourceItemIds: touchedSourceItemIds,
      requestToken: `moboreader.preview_refresh.v1:${input.taskId}`,
      actorId: input.payload.actorId,
      requestId: input.payload.requestId,
      mode: "apply",
    }, input.env, now);
    previewEnqueue = preview as unknown as Prisma.InputJsonObject;
  }
  await tx.catalogScanTask.update({
    where: { id: input.taskId },
    data: {
      batchActualCount: actual,
      result: {
        stopReason: "upstream_error",
        terminalState: "partial_failed",
        completeness: { expected, actual },
        previewEnqueue,
      },
    },
  });
}

export interface MoboreaderHandlerDependencies {
  adapter?: MoboreaderReadAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function createMoboreaderCatalogHandler(
  db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
): TaskHandler {
  const adapter = dependencies.adapter ?? createMoboreaderReadAdapter();
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  return async ({ lease, mode, signal }) => {
    const payload = parseMoboreaderCatalogPayload(lease.payload);
    if (!isNovelCatalogSyncEnabled(env)) {
      return { status: "failed", error: { code: "feature_disabled", message: "Catalog sync feature is disabled" } };
    }
    if (mode === "apply" && !isNovelCatalogSyncWriteAllowed(env)) {
      return { status: "failed", error: { code: "write_disabled", message: "Catalog sync write gate is disabled" } };
    }
    if (now().valueOf() >= Date.parse(payload.expiresAt)) {
      return { status: "failed", error: { code: "task_expired", message: "Catalog scan task expired" } };
    }
    const scope = await loadAndValidateTaskScope(db, lease.taskId, payload);
    const binding = await loadBinding(db, payload, scope.channelAccountId, scope.channelAppId);
    const token = decryptCredentialSecretForWorker(
      binding.encrypted_secret,
      scope.channelAccountId,
      binding.credential_id,
      binding.key_version,
    );
    let response: ListBooksResponse;
    try {
      response = await adapter.listBooks({
        name: payload.name,
        orderType: payload.orderType,
        pageIndex: payload.pageIndex,
        pageSize: payload.pageSize,
        projectType: payload.projectType,
      }, token, signal);
    } catch {
      return {
        status: "failed",
        result: { stopReason: "upstream_error", terminalState: "partial_failed" },
        error: { code: "upstream_error", message: "MoboReader catalog read failed" },
        protectedWrite: async (tx) => persistCatalogUpstreamFailure(tx, {
          taskId: lease.taskId,
          itemId: lease.itemId,
          payload,
          channelAppId: scope.channelAppId,
          env,
          now: now(),
        }),
      };
    }
    if (response.items.length > payload.pageSize) {
      return {
        status: "failed",
        result: { stopReason: "upstream_error", terminalState: "partial_failed" },
        error: { code: "upstream_page_limit_exceeded", message: "Upstream page exceeded the requested page size" },
        protectedWrite: async (tx) => persistCatalogUpstreamFailure(tx, {
          taskId: lease.taskId,
          itemId: lease.itemId,
          payload,
          channelAppId: scope.channelAppId,
          env,
          now: now(),
        }),
      };
    }
    const observedFetchedPosition = (payload.pageIndex - 1) * payload.pageSize + response.items.length;
    const stopReason = determineMoboreaderCatalogStopReason({
      returnedCount: response.items.length,
      pageSize: payload.pageSize,
      fetchedRaw: observedFetchedPosition,
      batchExpectedCount: response.totalCount,
      pageIndex: payload.pageIndex,
      requestedPageEnd: payload.requestedPageEnd,
      scheduledPageEnd: payload.scheduledPageEnd,
    });
    const result = {
      source: "manual",
      mode,
      pageIndex: payload.pageIndex,
      returnedCount: response.items.length,
      observedTotal: response.totalCount,
      plannedSourceIds: response.items.map((item) => `${item.externalBookId}:${item.language}`),
      checkpoint: { pageIndex: payload.pageIndex },
      stopReason,
      terminalState: stopReason === "safety_limit" ? "partial_failed" : undefined,
    };
    return {
      status: "success",
      result,
      protectedWrite: async (tx) => persistCatalogPage(tx, {
        response,
        payload,
        taskId: lease.taskId,
        itemId: lease.itemId,
        channelAppId: scope.channelAppId,
        env,
        now: now(),
      }),
    };
  };
}

export function createMoboreaderPreviewHandler(
  _db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
): TaskHandler {
  const adapter = dependencies.adapter ?? createMoboreaderReadAdapter();
  return async () => {
    // Deliberately do not inspect a source row or invoke either preview endpoint:
    // materialType and dataId provenance are still unproven production inputs.
    void adapter;
    return {
      status: "failed",
      error: {
        code: MOBOREADER_PREVIEW_DISABLED_REASON,
        message: "Preview production call is fail-closed pending materialType and dataId evidence",
      },
    };
  };
}

export function createMoboreaderWorkerHandlers(
  db: PrismaClient,
  dependencies: MoboreaderHandlerDependencies = {},
) {
  return createHandlerRegistry({
    [MOBOREADER_TASK_TYPES.catalogScan]: {
      family: "catalog_scan",
      maxAttempts: 3,
      handler: createMoboreaderCatalogHandler(db, dependencies),
    },
    [MOBOREADER_TASK_TYPES.previewRefresh]: {
      family: "channel_sync",
      maxAttempts: 1,
      handler: createMoboreaderPreviewHandler(db, dependencies),
    },
  });
}
