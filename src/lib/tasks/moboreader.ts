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
  maxPages: 2_000,
  maxItems: 1_000,
  maxPageSize: 100,
  ttlMs: 6 * 60 * 60 * 1_000,
});

export const MOBOREADER_PREVIEW_RUNTIME_STATUS = "registered_disabled" as const;
export const MOBOREADER_PREVIEW_DISABLED_REASON = "material_type_contract_unproven" as const;

export interface CreateMoboreaderCatalogScanTaskInput {
  channelAccountId: string;
  channelAppId: string;
  pageStart: number;
  pageEnd: number;
  pageSize: number;
  maxPages?: number;
  maxItems?: number;
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

export class MoboreaderTaskInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MoboreaderTaskInputError";
  }
}

export class MoboreaderPreviewContractDisabledError extends Error {
  readonly code = MOBOREADER_PREVIEW_DISABLED_REASON;
  readonly status = MOBOREADER_PREVIEW_RUNTIME_STATUS;

  constructor() {
    super("MoboReader preview refresh is disabled until materialType has a proven contract");
    this.name = "MoboreaderPreviewContractDisabledError";
  }
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
  maxPages: number;
  maxItems: number;
  requestToken: string;
  actorId: string;
  requestId: string;
  mode: "dry_run" | "apply";
  name: string;
  orderType: number;
}

export function validateMoboreaderCatalogScanInput(
  input: CreateMoboreaderCatalogScanTaskInput,
): ValidatedCatalogScanInput {
  const pageStart = positiveInteger(input.pageStart, "page_start_invalid");
  const pageEnd = positiveInteger(input.pageEnd, "page_end_invalid");
  const pageSize = positiveInteger(input.pageSize, "page_size_invalid");
  const maxPages = positiveInteger(input.maxPages ?? MOBOREADER_CATALOG_LIMITS.maxPages, "max_pages_invalid");
  const maxItems = positiveInteger(input.maxItems ?? MOBOREADER_CATALOG_LIMITS.maxItems, "max_items_invalid");
  if (pageEnd < pageStart) throw new MoboreaderTaskInputError("page_range_invalid");
  if (pageEnd - pageStart + 1 > maxPages || maxPages > MOBOREADER_CATALOG_LIMITS.maxPages) {
    throw new MoboreaderTaskInputError("max_pages_exceeded");
  }
  if (pageSize > MOBOREADER_CATALOG_LIMITS.maxPageSize) {
    throw new MoboreaderTaskInputError("page_size_exceeded");
  }
  if (maxItems > MOBOREADER_CATALOG_LIMITS.maxItems) {
    throw new MoboreaderTaskInputError("max_items_exceeded");
  }
  if ((pageEnd - pageStart + 1) * pageSize > maxItems) {
    throw new MoboreaderTaskInputError("max_items_exceeded");
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
    maxPages,
    maxItems,
    requestToken: required(input.requestToken, "request_token_required"),
    actorId: required(input.actorId, "actor_required", 128),
    requestId: required(input.requestId, "request_id_required"),
    mode,
    name: input.name ?? "",
    orderType: input.orderType ?? 0,
  };
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
  const input = validateMoboreaderCatalogScanInput(rawInput);
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
  const pages = Array.from({ length: input.pageEnd - input.pageStart + 1 }, (_, index) => input.pageStart + index);
  const safeParams = {
    source: "manual",
    actorId: input.actorId,
    requestId: input.requestId,
    maxPages: input.maxPages,
    maxItems: input.maxItems,
    expiresAt: expiresAt.toISOString(),
    featureFlagEnabled: enabled,
    allowWriteEnabled: writeAllowed,
    registeredDetailStatus: MOBOREADER_PREVIEW_RUNTIME_STATUS,
    registeredDetailReason: MOBOREADER_PREVIEW_DISABLED_REASON,
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
                maxPages: input.maxPages,
                maxItems: input.maxItems,
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
            maxPages: input.maxPages,
            maxItems: input.maxItems,
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

export async function createMoboreaderPreviewRefreshTask(
  _prisma: PrismaClient,
  input: CreateMoboreaderPreviewRefreshTaskInput,
): Promise<never> {
  required(input.channelAccountId, "channel_account_required");
  required(input.channelAppId, "channel_app_required");
  required(input.requestToken, "request_token_required");
  required(input.actorId, "actor_required", 128);
  required(input.requestId, "request_id_required");
  if (input.novelSourceItemIds.length === 0 || input.novelSourceItemIds.some((id) => !id.trim())) {
    throw new MoboreaderTaskInputError("novel_source_items_required");
  }
  throw new MoboreaderPreviewContractDisabledError();
}
