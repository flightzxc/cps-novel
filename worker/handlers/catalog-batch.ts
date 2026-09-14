import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { NormalizedCatalogSelection } from "../../src/domain/catalog-batch";
import { evaluateNovelMaterializationLocale } from "../../src/domain/novel-materialization-locale";
import {
  CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1,
  CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2,
  CATALOG_BATCH_CHUNK_SIZE, CATALOG_BATCH_TASK_TYPE,
  CONTENT_CREATE_TARGET_TYPE,
  NOVEL_MATERIALIZE_TASK_TYPE, NOVEL_MATERIALIZE_TARGET_TYPE,
  type CatalogBatchPayload,
} from "../../src/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "../../src/lib/tasks/legacy-content-create";
import { operationScopeHash, UPSTREAM_EXISTING_PROMO_OFFER_TYPE } from "../../src/lib/tasks/promo-link-claim";
import { PROMO_LINK_CLAIM_CAPABILITY_KEY, PROMO_LINK_CLAIM_TASK_TYPE } from "../../src/lib/tasks/promo-link-claim-limits";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../../src/lib/flags";

type SnapshotRow = { id: string; channelAppId: string; sourceLocale: string | null; status: string; novelId: string | null };
const ROW_SELECT = { id: true, channelAppId: true, sourceLocale: true, status: true, novelId: true } as const;

function parsePayload(value: unknown): CatalogBatchPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_batch_payload_invalid");
  const p = value as Partial<CatalogBatchPayload>;
  if ((p.operation !== "content_create" && p.operation !== "promo_claim" && p.operation !== "novel_materialize") || !p.selection
    || typeof p.actorId !== "string" || !p.actorId || typeof p.requestId !== "string" || !p.requestId
    || typeof p.submittedAt !== "string" || !Number.isFinite(Date.parse(p.submittedAt))
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("catalog_batch_payload_invalid");
  if (p.selection.scope === "explicit_ids") {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!Array.isArray(p.selection.ids) || p.selection.ids.some((id) => typeof id !== "string" || !uuid.test(id))) throw new Error("catalog_batch_payload_invalid");
  } else if (p.selection.scope !== "all_filtered" || !p.selection.filter || typeof p.selection.filter.status !== "string") {
    throw new Error("catalog_batch_payload_invalid");
  }
  for (const record of [p.channelAccounts, p.templateKeysByLocale]) {
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record)
      || Object.entries(record).some(([key, item]) => !key || typeof item !== "string" || !item))) throw new Error("catalog_batch_payload_invalid");
  }
  const enumEligibilityPolicyVersion = p.enumEligibilityPolicyVersion === undefined
    ? CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1
    : p.enumEligibilityPolicyVersion;
  if (
    (enumEligibilityPolicyVersion !== CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1
      && enumEligibilityPolicyVersion !== CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2)
    || (enumEligibilityPolicyVersion === CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2
      && p.operation !== "novel_materialize")
  ) {
    throw new Error("catalog_batch_payload_invalid");
  }
  return { ...p, enumEligibilityPolicyVersion } as CatalogBatchPayload;
}

function selectionWhere(selection: NormalizedCatalogSelection): Prisma.NovelSourceItemWhereInput {
  if (selection.scope === "explicit_ids") return { deletedAt: null };
  const f = selection.filter;
  return { deletedAt: null, status: f.status,
    ...(f.search ? { title: { contains: f.search, mode: "insensitive" } } : {}),
    ...(f.sourceLocale ? { sourceLocale: f.sourceLocale === "__unknown" ? null : f.sourceLocale } : {}),
  };
}

async function streamSelection(
  tx: Prisma.TransactionClient,
  selection: NormalizedCatalogSelection,
  visit: (rows: readonly SnapshotRow[]) => Promise<void>,
): Promise<void> {
  if (selection.scope === "explicit_ids") {
    for (let i = 0; i < selection.ids.length; i += CATALOG_BATCH_CHUNK_SIZE) {
      const rows = await tx.novelSourceItem.findMany({
        where: { ...selectionWhere(selection), id: { in: selection.ids.slice(i, i + CATALOG_BATCH_CHUNK_SIZE) } },
        orderBy: { id: "asc" }, select: ROW_SELECT,
      });
      await visit(rows);
    }
    return;
  }
  let after: string | undefined;
  while (true) {
    const rows = await tx.novelSourceItem.findMany({
      where: { ...selectionWhere(selection), ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: CATALOG_BATCH_CHUNK_SIZE, select: ROW_SELECT,
    });
    if (!rows.length) return;
    await visit(rows); after = rows.at(-1)!.id;
    if (rows.length < CATALOG_BATCH_CHUNK_SIZE) return;
  }
}

function childToken(parentId: string, operation: string, group: string): string {
  return `catalog_child:${createHash("sha256").update(`${parentId}\n${operation}\n${group}`).digest("hex")}`;
}

export function createCatalogBatchHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    if (lease.taskType !== CATALOG_BATCH_TASK_TYPE || lease.itemId === "") throw new Error("catalog_batch_lease_invalid");
    const payload = parsePayload(lease.payload);
    const enumEligibilityPolicyVersion = payload.enumEligibilityPolicyVersion!;
    return {
      status: "success",
      transactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      transactionTimeoutMs: 120_000,
      protectedWrite: async (tx) => {
        if (payload.operation === "content_create") {
          await tx.genericTask.update({
            where: { id: lease.taskId },
            data: {
              result: {
                enumerationStatus: "failed",
                reason: LEGACY_CONTENT_CREATE_RETIRED_CODE,
                message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
                enumEligibilityPolicyVersion,
              },
            },
          });
          return {
            status: "failed",
            error: { code: LEGACY_CONTENT_CREATE_RETIRED_CODE, message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE },
            result: { enumerationStatus: "failed", reason: LEGACY_CONTENT_CREATE_RETIRED_CODE, enumEligibilityPolicyVersion },
          };
        }
        const expiry = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiry) || Date.now() >= expiry) {
          await tx.genericTask.update({ where: { id: lease.taskId }, data: { result: {
            enumerationStatus: "expired", submittedCount: 0, ineligibleCount: 0,
            expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
          } } });
          return { status: "skipped", result: { enumerationStatus: "expired", enumEligibilityPolicyVersion } };
        }

        const groups = new Map<string, SnapshotRow[]>();
        let selectedCount = payload.selection.scope === "explicit_ids" ? payload.selection.ids.length : 0;
        let observedCount = 0;
        let submittedCount = 0;
        let ineligibleCount = 0;
        let alreadyLinkedCount = 0;
        const blockedReasonCounts: Record<string, number> = {};
        await streamSelection(tx, payload.selection, async (rows) => {
          if (payload.selection.scope === "all_filtered") selectedCount += rows.length;
          observedCount += rows.length;
          let activePromo = new Set<string>();
          if (payload.operation === "promo_claim" && rows.length) {
            const active = await tx.genericTaskItem.findMany({ where: {
              targetType: CONTENT_CREATE_TARGET_TYPE, targetId: { in: rows.map((r) => r.id) },
              task: { taskType: PROMO_LINK_CLAIM_TASK_TYPE, status: { in: ["pending", "processing"] } },
            }, select: { targetId: true } });
            activePromo = new Set(active.map((r) => r.targetId));
          }
          for (const row of rows) {
            if (payload.operation === "promo_claim" && activePromo.has(row.id)) {
              blockedReasonCounts.active_item_conflict = (blockedReasonCounts.active_item_conflict ?? 0) + 1;
              continue;
            }
            if (payload.operation === "novel_materialize" && row.status === "linked" && row.novelId !== null) {
              alreadyLinkedCount += 1;
              continue;
            }
            const eligible = payload.operation === "novel_materialize"
              ? row.status === "pending" && row.novelId === null
              : row.status === "linked" && row.novelId !== null;
            if (!eligible) { ineligibleCount += 1; continue; }
            if (
              payload.operation === "novel_materialize"
              && enumEligibilityPolicyVersion === CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2
            ) {
              const localeEligibility = evaluateNovelMaterializationLocale(row.sourceLocale);
              if (!localeEligibility.eligible) {
                blockedReasonCounts[localeEligibility.code] = (blockedReasonCounts[localeEligibility.code] ?? 0) + 1;
                continue;
              }
            }
            const accountId = payload.operation === "promo_claim" ? payload.channelAccounts?.[row.channelAppId] : undefined;
            if (payload.operation === "promo_claim" && !accountId) {
              blockedReasonCounts.channel_account_required = (blockedReasonCounts.channel_account_required ?? 0) + 1;
              continue;
            }
            const key = payload.operation === "promo_claim" ? `${row.channelAppId}\n${accountId}` : row.channelAppId;
            const bucket = groups.get(key) ?? [];
            bucket.push(row); groups.set(key, bucket); submittedCount += 1;
          }
        });
        if (payload.selection.scope === "explicit_ids") ineligibleCount += selectedCount - observedCount;

        let childTaskCount = 0;
        for (const [groupKey, members] of groups) {
          const channelAppId = members[0]!.channelAppId;
          const channelAccountId = payload.operation === "promo_claim" ? payload.channelAccounts![channelAppId]! : null;
          if (payload.operation === "promo_claim") {
            const binding = await tx.channelApp.findFirst({ where: {
              id: channelAppId, status: "active", channel: { status: "active", channelAccounts: { some: { id: channelAccountId!, status: "active", deletedAt: null } } },
              capabilities: { some: { capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled" } },
            }, select: { id: true } });
            if (!binding) {
              blockedReasonCounts.channel_binding_or_capability_unavailable = (blockedReasonCounts.channel_binding_or_capability_unavailable ?? 0) + members.length;
              submittedCount -= members.length;
              continue;
            }
          }
          const taskType = payload.operation === "promo_claim" ? PROMO_LINK_CLAIM_TASK_TYPE : NOVEL_MATERIALIZE_TASK_TYPE;
          const promoFeatureEnabled = isPromoLinkClaimEnabled();
          const promoWriteAllowed = isPromoLinkClaimWriteAllowed();
          const childStatus = payload.operation === "promo_claim" && (!promoFeatureEnabled || !promoWriteAllowed) ? "disabled" : "pending";
          const scopeHash = payload.operation === "promo_claim"
            ? operationScopeHash(members.map((m) => ({ novelSourceItemId: m.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE })))
            : createHash("sha256").update(JSON.stringify(members.map((m) => m.id).sort())).digest("hex");
          const existingScope = await tx.genericTask.findFirst({ where: {
            taskType, channelAppId, channelAccountId,
            operationScopeHash: scopeHash, status: { in: ["pending", "processing"] },
          }, select: { id: true } });
          if (existingScope) {
            blockedReasonCounts.active_scope_conflict = (blockedReasonCounts.active_scope_conflict ?? 0) + members.length;
            submittedCount -= members.length;
            continue;
          }
          const childId = randomUUID();
          await tx.genericTask.create({ data: {
            id: childId, parentTaskId: lease.taskId, taskType, channelAppId, channelAccountId,
            operationScopeHash: scopeHash, mode: "apply", status: childStatus,
            requestToken: childToken(lease.taskId, payload.operation, groupKey), totalCount: members.length,
            params: { actorId: payload.actorId, requestId: payload.requestId, submittedAt: payload.submittedAt, expiresAt: payload.expiresAt,
              ...(payload.operation === "promo_claim" ? { featureFlagEnabled: promoFeatureEnabled, allowWriteEnabled: promoWriteAllowed } : {}) },
          } });
          childTaskCount += 1;
          for (let i = 0; i < members.length; i += CATALOG_BATCH_CHUNK_SIZE) {
            await tx.genericTaskItem.createMany({ data: members.slice(i, i + CATALOG_BATCH_CHUNK_SIZE).map((member) => ({
              taskId: childId,
              targetType: payload.operation === "promo_claim" ? "novel_source_item" : NOVEL_MATERIALIZE_TARGET_TYPE,
              targetId: member.id,
              payload: payload.operation === "promo_claim" ? {
                novelSourceItemId: member.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
                channelAccountId: channelAccountId!, channelAppId, actorId: payload.actorId,
                requestId: `${payload.requestId}:${member.id}`, expiresAt: payload.expiresAt,
              } : {
                novelSourceItemId: member.id, channelAppId, actorId: payload.actorId,
                requestId: `${payload.requestId}:${member.id}`, expiresAt: payload.expiresAt,
              },
            })) });
          }
          await tx.operationAudit.create({ data: {
            actorType: "worker", actorId: lease.workerId, action: `${taskType}.queued`,
            entityType: "GenericTask", entityId: childId, requestId: payload.requestId,
            taskType, taskId: childId,
            afterSnapshot: {
              parentTaskId: lease.taskId,
              eligibleCount: members.length,
              expiresAt: payload.expiresAt,
              enumEligibilityPolicyVersion,
            },
          } });
        }
        const blockedCount = Object.values(blockedReasonCounts).reduce((sum, count) => sum + count, 0);
        await tx.genericTask.update({ where: { id: lease.taskId }, data: { result: {
          enumerationStatus: "completed", selectedCount, submittedCount, ineligibleCount, alreadyLinkedCount,
          blockedCount, failedCount: 0,
          childTaskCount, blockedReasonCounts, expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
        } } });
        await tx.operationAudit.create({ data: {
          actorType: "worker", actorId: lease.workerId, action: "catalog_batch.materialized",
          entityType: "GenericTask", entityId: lease.taskId, requestId: payload.requestId,
          taskType: CATALOG_BATCH_TASK_TYPE, taskId: lease.taskId,
          afterSnapshot: {
            selectedCount, submittedCount, ineligibleCount, alreadyLinkedCount, blockedReasonCounts,
            expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
          },
        } });
        return { status: "success", result: {
          enumerationStatus: "completed", submittedCount, ineligibleCount, alreadyLinkedCount, blockedCount,
          enumEligibilityPolicyVersion,
        } };
      },
    };
  };
}

export function createCatalogBatchWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({ [CATALOG_BATCH_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createCatalogBatchHandler(db) } });
}
