import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  isNovelCatalogSyncEnabled,
  isNovelCatalogSyncWriteAllowed,
} from "../flags";

export const MOBOREADER_TASK_TYPES = Object.freeze({
  catalogScan: "catalog_scan",
  previewRefresh: "moboreader.preview_refresh.v1",
});

export const MOBOREADER_CATALOG_LIMITS = Object.freeze({
  defaultSafetyMaxPages: 2_000,
  maxPageSize: 100,
  ttlMs: 6 * 60 * 60 * 1_000,
});

export const MOBOREADER_CATALOG_SAFETY_MAX_PAGES_ENV = "MOBOREADER_CATALOG_SAFETY_MAX_PAGES";

export const MOBOREADER_PREVIEW_RUNTIME_STATUS = "enabled" as const;

export interface CreateMoboreaderCatalogScanTaskInput {
  channelAccountId: string;
  channelAppId: string;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
  requestToken: string;
  actorId: string;
  requestId: string;
  mode?: "dry_run" | "apply";
  name?: string;
  orderType?: number;
}

export type MoboreaderTaskCreationResult =
  | { status: "enqueued"; taskId: string; taskStatus: "pending" | "disabled" }
  | { status: "duplicate"; taskId: string }
  | { status: "active_conflict"; taskId: string };

export interface CreateMoboreaderPreviewRefreshTaskInput {
  channelAccountId: string;
  channelAppId: string;
  novelSourceItemIds: readonly string[];
  requestToken: string;
  actorId: string;
  requestId: string;
  mode?: "dry_run" | "apply";
}

interface EnqueueMoboreaderPreviewRefreshTaskInput extends CreateMoboreaderPreviewRefreshTaskInput {
  trigger: "manual" | "auto";
  catalogScanTaskId?: string;
}

export type MoboreaderPreviewTaskCreationResult =
  | { status: "enqueued"; taskId: string; taskStatus: "pending" | "disabled"; eligibleCount: number; skipReasonCounts: Record<string, number> }
  | { status: "duplicate"; taskId: string }
  | { status: "active_conflict"; taskId: string }
  | { status: "no_eligible_sources"; skipReasonCounts: Record<string, number> };

export const MOBOREADER_PREVIEW_RUNTIME_DEFAULTS = Object.freeze({
  chunkSize: 25,
  concurrency: 2,
  timeoutMs: 20_000,
  freshnessMs: 24 * 60 * 60 * 1_000,
});

export const MOBOREADER_PREVIEW_ENV = Object.freeze({
  chunkSize: "MOBOREADER_PREVIEW_CHUNK_SIZE",
  concurrency: "MOBOREADER_PREVIEW_CONCURRENCY",
  timeoutMs: "MOBOREADER_PREVIEW_TIMEOUT_MS",
  freshnessMs: "MOBOREADER_PREVIEW_FRESHNESS_MS",
  sourceAppCodes: "MOBOREADER_PREVIEW_SOURCE_APP_CODES",
  sourceItemAllowlist: "MOBOREADER_PREVIEW_SOURCE_ITEM_ALLOWLIST",
});

export interface MoboreaderPreviewRuntimeConfig {
  chunkSize: number;
  concurrency: number;
  timeoutMs: number;
  freshnessMs: number;
}

export class MoboreaderTaskInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MoboreaderTaskInputError";
  }
}

export function resolveMoboreaderPreviewRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): MoboreaderPreviewRuntimeConfig {
  const configured = (key: string, fallback: number, code: string) => {
    const raw = env[key];
    return raw === undefined || raw.trim() === "" ? fallback : positiveInteger(Number(raw), code);
  };
  return Object.freeze({
    chunkSize: configured(MOBOREADER_PREVIEW_ENV.chunkSize, MOBOREADER_PREVIEW_RUNTIME_DEFAULTS.chunkSize, "preview_chunk_size_invalid"),
    concurrency: configured(MOBOREADER_PREVIEW_ENV.concurrency, MOBOREADER_PREVIEW_RUNTIME_DEFAULTS.concurrency, "preview_concurrency_invalid"),
    timeoutMs: configured(MOBOREADER_PREVIEW_ENV.timeoutMs, MOBOREADER_PREVIEW_RUNTIME_DEFAULTS.timeoutMs, "preview_timeout_invalid"),
    freshnessMs: configured(MOBOREADER_PREVIEW_ENV.freshnessMs, MOBOREADER_PREVIEW_RUNTIME_DEFAULTS.freshnessMs, "preview_freshness_invalid"),
  });
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new MoboreaderTaskInputError(code);
  return value;
}

function required(value: string, code: string, maxLength = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new MoboreaderTaskInputError(code);
  return normalized;
}

export interface ValidatedCatalogScanInput {
  channelAccountId: string;
  channelAppId: string;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
  safetyMaxPages: number;
  requestToken: string;
  actorId: string;
  requestId: string;
  mode: "dry_run" | "apply";
  name: string;
  orderType: number;
}

export function validateMoboreaderCatalogScanInput(
  input: CreateMoboreaderCatalogScanTaskInput,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedCatalogScanInput {
  const pageStart = positiveInteger(input.pageStart, "page_start_invalid");
  const pageEnd = positiveInteger(input.pageEnd, "page_end_invalid");
  const pageSize = positiveInteger(input.pageSize, "page_size_invalid");
  const safetyMaxPages = resolveMoboreaderCatalogSafetyMaxPages(env);
  if (pageEnd < pageStart) throw new MoboreaderTaskInputError("page_range_invalid");
  if (pageSize > MOBOREADER_CATALOG_LIMITS.maxPageSize) {
    throw new MoboreaderTaskInputError("page_size_exceeded");
  }
  const mode = input.mode ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") throw new MoboreaderTaskInputError("mode_invalid");
  if (input.name !== undefined && input.name.length > 500) throw new MoboreaderTaskInputError("name_too_long");
  if (input.orderType !== undefined && !Number.isSafeInteger(input.orderType)) {
    throw new MoboreaderTaskInputError("order_type_invalid");
  }
  return {
    channelAccountId: required(input.channelAccountId, "channel_account_required"),
    channelAppId: required(input.channelAppId, "channel_app_required"),
    pageStart,
    pageEnd,
    pageSize,
    safetyMaxPages,
    requestToken: required(input.requestToken, "request_token_required"),
    actorId: required(input.actorId, "actor_required", 128),
    requestId: required(input.requestId, "request_id_required"),
    mode,
    name: input.name ?? "",
    orderType: input.orderType ?? 0,
  };
}

export function resolveMoboreaderCatalogSafetyMaxPages(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[MOBOREADER_CATALOG_SAFETY_MAX_PAGES_ENV];
  if (raw === undefined || raw.trim() === "") return MOBOREADER_CATALOG_LIMITS.defaultSafetyMaxPages;
  const parsed = Number(raw);
  return positiveInteger(parsed, "safety_max_pages_invalid");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createMoboreaderCatalogScanTask(
  prisma: PrismaClient,
  rawInput: CreateMoboreaderCatalogScanTaskInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MoboreaderTaskCreationResult> {
  const input = validateMoboreaderCatalogScanInput(rawInput, env);
  const duplicate = await prisma.catalogScanTask.findUnique({ where: { requestToken: input.requestToken } });
  if (duplicate) return { status: "duplicate", taskId: duplicate.id };

  const binding = await prisma.channelApp.findFirst({
    where: {
      id: input.channelAppId,
      status: "active",
      channel: { status: "active", channelAccounts: { some: { id: input.channelAccountId, status: "active", deletedAt: null } } },
    },
    select: { id: true, projectType: true },
  });
  if (!binding) throw new MoboreaderTaskInputError("active_channel_binding_required");
  const existing = await prisma.catalogScanTask.findFirst({
    where: {
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      projectType: binding.projectType,
      status: { in: ["pending", "processing"] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return { status: "active_conflict", taskId: existing.id };

  const enabled = isNovelCatalogSyncEnabled(env);
  const writeAllowed = isNovelCatalogSyncWriteAllowed(env);
  const taskStatus = enabled && (input.mode === "dry_run" || writeAllowed) ? "pending" : "disabled";
  const expiresAt = new Date(Date.now() + MOBOREADER_CATALOG_LIMITS.ttlMs);
  const taskId = randomUUID();
  const scheduledPageEnd = Math.min(input.pageEnd, input.pageStart + input.safetyMaxPages - 1);
  const pages = Array.from({ length: scheduledPageEnd - input.pageStart + 1 }, (_, index) => input.pageStart + index);
  const safeParams = {
    source: "manual",
    actorId: input.actorId,
    requestId: input.requestId,
    safetyMaxPages: input.safetyMaxPages,
    requestedPageEnd: input.pageEnd,
    scheduledPageEnd,
    expiresAt: expiresAt.toISOString(),
    featureFlagEnabled: enabled,
    allowWriteEnabled: writeAllowed,
    registeredDetailStatus: MOBOREADER_PREVIEW_RUNTIME_STATUS,
  } satisfies Prisma.InputJsonObject;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.catalogScanTask.create({
        data: {
          id: taskId,
          channelAccountId: input.channelAccountId,
          channelAppId: input.channelAppId,
          projectType: binding.projectType,
          mode: input.mode,
          status: taskStatus,
          requestToken: input.requestToken,
          pageStart: input.pageStart,
          pageEnd: input.pageEnd,
          pageSize: input.pageSize,
          totalCount: pages.length,
          params: safeParams,
          items: {
            create: pages.map((pageIndex) => {
              const payload = {
                pageIndex,
                pageSize: input.pageSize,
                name: input.name,
                orderType: input.orderType,
                projectType: binding.projectType,
                safetyMaxPages: input.safetyMaxPages,
                requestedPageEnd: input.pageEnd,
                scheduledPageEnd,
                expiresAt: expiresAt.toISOString(),
                source: "manual",
                actorId: input.actorId,
                requestId: input.requestId,
              };
              return { pageIndex, requestFingerprint: digest(payload), payload };
            }),
          },
        },
      });
      await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: input.actorId,
          action: "moboreader.catalog_scan.queued",
          entityType: "CatalogScanTask",
          entityId: taskId,
          requestId: input.requestId,
          taskType: MOBOREADER_TASK_TYPES.catalogScan,
          taskId,
          afterSnapshot: {
            source: "manual",
            mode: input.mode,
            status: taskStatus,
            pageStart: input.pageStart,
            pageEnd: input.pageEnd,
            pageSize: input.pageSize,
            safetyMaxPages: input.safetyMaxPages,
            requestedPageEnd: input.pageEnd,
            scheduledPageEnd,
          },
        },
      });
      return { status: "enqueued", taskId, taskStatus } as const;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const exact = await prisma.catalogScanTask.findUnique({ where: { requestToken: input.requestToken } });
    if (exact) return { status: "duplicate", taskId: exact.id };
    const active = await prisma.catalogScanTask.findFirst({
      where: {
        channelAccountId: input.channelAccountId,
        channelAppId: input.channelAppId,
        projectType: binding.projectType,
        status: { in: ["pending", "processing"] },
      },
      orderBy: { createdAt: "asc" },
    });
    if (active) return { status: "active_conflict", taskId: active.id };
    throw error;
  }
}

type TaskDb = PrismaClient | Prisma.TransactionClient;

function csvSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function increment(counts: Record<string, number>, reason: string, amount = 1): void {
  counts[reason] = (counts[reason] ?? 0) + amount;
}

function validatedPreviewInput(input: EnqueueMoboreaderPreviewRefreshTaskInput) {
  const ids = Array.from(new Set(input.novelSourceItemIds.map((id) => required(id, "novel_source_items_required"))));
  if (ids.length === 0) throw new MoboreaderTaskInputError("novel_source_items_required");
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new MoboreaderTaskInputError("novel_source_item_id_invalid");
  }
  const mode = input.mode ?? "apply";
  if (mode !== "dry_run" && mode !== "apply") throw new MoboreaderTaskInputError("mode_invalid");
  return {
    ...input,
    channelAccountId: required(input.channelAccountId, "channel_account_required"),
    channelAppId: required(input.channelAppId, "channel_app_required"),
    requestToken: required(input.requestToken, "request_token_required"),
    actorId: required(input.actorId, "actor_required", 128),
    requestId: required(input.requestId, "request_id_required"),
    novelSourceItemIds: ids,
    mode,
  };
}

async function enqueueMoboreaderPreviewRefreshTaskInDb(
  db: TaskDb,
  rawInput: EnqueueMoboreaderPreviewRefreshTaskInput,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<MoboreaderPreviewTaskCreationResult> {
  const input = validatedPreviewInput(rawInput);
  const duplicate = await db.channelSyncTask.findUnique({ where: { requestToken: input.requestToken } });
  if (duplicate) return { status: "duplicate", taskId: duplicate.id };

  const skipReasonCounts: Record<string, number> = {};
  const binding = await db.channelApp.findFirst({
    where: { id: input.channelAppId, status: "active", channel: { status: "active" }, sourceApp: { status: "active" } },
    select: { id: true, sourceApp: { select: { code: true } } },
  });
  if (!binding) {
    increment(skipReasonCounts, "inactive_channel_binding", input.novelSourceItemIds.length);
    return { status: "no_eligible_sources", skipReasonCounts };
  }
  const sourceAppAllowlist = csvSet(env[MOBOREADER_PREVIEW_ENV.sourceAppCodes]);
  if (!sourceAppAllowlist.has(binding.sourceApp.code)) {
    increment(skipReasonCounts, "source_app_not_allowlisted", input.novelSourceItemIds.length);
    return { status: "no_eligible_sources", skipReasonCounts };
  }
  const account = await db.channelAccount.findFirst({
    where: {
      id: input.channelAccountId,
      channel: { channelApps: { some: { id: input.channelAppId } } },
      status: "active",
      deletedAt: null,
    },
    select: {
      id: true,
      credentials: {
        where: { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true },
        take: 2,
      },
    },
  });
  if (!account || account.credentials.length !== 1) {
    increment(skipReasonCounts, account ? "credential_ambiguous" : "account_unavailable", input.novelSourceItemIds.length);
    return { status: "no_eligible_sources", skipReasonCounts };
  }

  const runtime = resolveMoboreaderPreviewRuntimeConfig(env);
  const optionalAllowlist = csvSet(env[MOBOREADER_PREVIEW_ENV.sourceItemAllowlist]);
  const sources = await db.novelSourceItem.findMany({
    where: { id: { in: input.novelSourceItemIds }, channelAppId: input.channelAppId },
    select: {
      id: true,
      novelId: true,
      deletedAt: true,
      novel: { select: { previewPolicy: { select: { lastRefreshedAt: true } } } },
    },
  });
  const byId = new Map(sources.map((source) => [source.id, source]));
  const eligibleIds: string[] = [];
  for (const sourceId of input.novelSourceItemIds) {
    const source = byId.get(sourceId);
    if (!source || source.deletedAt || !source.novelId) {
      increment(skipReasonCounts, "source_unlinked_or_deleted");
      continue;
    }
    if (optionalAllowlist.size > 0 && !optionalAllowlist.has(sourceId)) {
      increment(skipReasonCounts, "source_item_not_allowlisted");
      continue;
    }
    const refreshedAt = source.novel?.previewPolicy?.lastRefreshedAt;
    if (refreshedAt && now.valueOf() - refreshedAt.valueOf() < runtime.freshnessMs) {
      increment(skipReasonCounts, "fresh_preview");
      continue;
    }
    eligibleIds.push(sourceId);
  }
  if (eligibleIds.length === 0) return { status: "no_eligible_sources", skipReasonCounts };

  const taskId = randomUUID();
  const operationScopeHash = digest([...eligibleIds].sort());
  const active = await db.channelSyncTask.findFirst({
    where: {
      taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      operationScopeHash,
      status: { in: ["pending", "processing"] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (active) return { status: "active_conflict", taskId: active.id };
  const enabled = isNovelCatalogSyncEnabled(env);
  const writeAllowed = isNovelCatalogSyncWriteAllowed(env);
  const taskStatus = enabled && (input.mode === "dry_run" || writeAllowed) ? "pending" : "disabled";
  await db.channelSyncTask.create({
    data: {
      id: taskId,
      taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      operationScopeHash,
      requestToken: input.requestToken,
      mode: input.mode,
      status: taskStatus,
      totalCount: eligibleIds.length,
      params: {
        trigger: input.trigger,
        catalogScanTaskId: input.catalogScanTaskId ?? null,
        runtime: { ...runtime },
        featureFlagEnabled: enabled,
        allowWriteEnabled: writeAllowed,
        skipReasonCounts,
        evidence: {
          dataId: "confirmed_getlistpc_series_id",
          materialType: "confirmed_runtime_selection_policy",
          materialTypeGlobalConstant: "not_asserted",
          materialType1001: "rejected",
          productionPreviewCall: "enabled",
        },
      },
      result: { eligibleCount: eligibleIds.length, skipReasonCounts },
      items: {
        createMany: {
          data: eligibleIds.map((novelSourceItemId) => ({
            novelSourceItemId,
            payload: {
              trigger: input.trigger,
              runtime: { ...runtime },
              actorId: input.actorId,
              requestId: input.requestId,
              contractStatus: MOBOREADER_PREVIEW_RUNTIME_STATUS,
            },
          })),
        },
      },
    },
  });
  await db.operationAudit.create({
    data: {
      actorType: input.trigger === "auto" ? "worker" : "admin",
      actorId: input.actorId,
      action: taskStatus === "pending" ? "moboreader.preview_refresh.queued" : "moboreader.preview_refresh.queued_disabled",
      entityType: "ChannelSyncTask",
      entityId: taskId,
      requestId: input.requestId,
      taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      taskId,
      afterSnapshot: {
        trigger: input.trigger,
        status: taskStatus,
        eligibleCount: eligibleIds.length,
        skipReasonCounts,
      },
    },
  });
  return { status: "enqueued", taskId, taskStatus, eligibleCount: eligibleIds.length, skipReasonCounts };
}

export async function enqueueMoboreaderPreviewRefreshTask(
  tx: Prisma.TransactionClient,
  input: EnqueueMoboreaderPreviewRefreshTaskInput,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<MoboreaderPreviewTaskCreationResult> {
  return enqueueMoboreaderPreviewRefreshTaskInDb(tx, input, env, now);
}

export async function createMoboreaderPreviewRefreshTask(
  prisma: PrismaClient,
  input: CreateMoboreaderPreviewRefreshTaskInput,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<MoboreaderPreviewTaskCreationResult> {
  try {
    return await prisma.$transaction((tx) => enqueueMoboreaderPreviewRefreshTaskInDb(tx, {
      ...input,
      trigger: "manual",
    }, env, now));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const duplicate = await prisma.channelSyncTask.findUnique({ where: { requestToken: input.requestToken } });
    if (duplicate) return { status: "duplicate", taskId: duplicate.id };
    throw error;
  }
}
