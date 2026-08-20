import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../flags";
import { isUniqueConstraintViolation as isUniqueViolation } from "@/lib/db/db-retry";
import {
  PROMO_LINK_CLAIM_LIMITS,
  PROMO_LINK_CLAIM_TARGET_TYPE,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "./promo-link-claim-limits";

/**
 * Task factory for the promo-link claim chain
 * (`docs/architecture/candidate-v0.2.1/novel-v1-adapter-and-workflow-
 * v0.2.1.md` §3.9/§3.10). One `GenericTask` (`taskType =
 * PROMO_LINK_CLAIM_TASK_TYPE`, family `"generic"`) with one
 * `GenericTaskItem` per `(novelSourceItemId, offerType)` pair
 * (`targetType = PROMO_LINK_CLAIM_TARGET_TYPE`, `targetId =
 * novelSourceItemId`).
 *
 * What the worker handler (`worker/handlers/promo-link-claim.ts`) does with
 * each item is a single unified decision tree covering *both* halves of the
 * architecture doc's flow: the always-enabled "read the promo fields the
 * catalog sync already fetched" pre-read (§3.9, zero additional upstream
 * calls) and the disabled `claimPromo` side-effecting placeholder (§3.10).
 * This factory only decides *which source items are in scope for a run* —
 * it does not know or care which of the two paths an item will resolve
 * through.
 */

export class PromoLinkClaimTaskInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PromoLinkClaimTaskInputError";
  }
}

export interface PromoLinkClaimScopeItem {
  novelSourceItemId: string;
  /** `PromoLink.offerType` — free text today (no frozen enum yet); `"read"` is the only value seen in fixtures/tests so far. */
  offerType: string;
}

export interface CreatePromoLinkClaimTaskInput {
  channelAccountId: string;
  channelAppId: string;
  /**
   * Explicit, caller-enumerated scope — never a filter descriptor. Doc §4
   * item 15 ("拒绝按筛选全量、只接受显式区间"): this factory has no "select
   * everything matching X" input shape at all, by construction, not just by
   * validation.
   */
  items: readonly PromoLinkClaimScopeItem[];
  requestToken: string;
  actorId: string;
  requestId: string;
  mode?: "dry_run" | "apply";
}

export type PromoLinkClaimTaskCreationResult =
  | {
      status: "enqueued";
      taskId: string;
      taskStatus: "pending" | "disabled";
      eligibleCount: number;
      skipReasonCounts: Record<string, number>;
    }
  | { status: "duplicate"; taskId: string }
  | { status: "active_conflict"; taskId: string }
  | { status: "no_eligible_sources"; skipReasonCounts: Record<string, number> };

function required(value: string, code: string, maxLength = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new PromoLinkClaimTaskInputError(code);
  return normalized;
}

function increment(counts: Record<string, number>, reason: string, amount = 1): void {
  counts[reason] = (counts[reason] ?? 0) + amount;
}

interface ValidatedInput {
  channelAccountId: string;
  channelAppId: string;
  items: PromoLinkClaimScopeItem[];
  requestToken: string;
  actorId: string;
  requestId: string;
  mode: "dry_run" | "apply";
}

function validateInput(input: CreatePromoLinkClaimTaskInput): ValidatedInput {
  const channelAccountId = required(input.channelAccountId, "channel_account_required");
  const channelAppId = required(input.channelAppId, "channel_app_required");
  const requestToken = required(input.requestToken, "request_token_required");
  const actorId = required(input.actorId, "actor_required", 128);
  const requestId = required(input.requestId, "request_id_required");
  const mode = input.mode ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") throw new PromoLinkClaimTaskInputError("mode_invalid");

  if (input.items.length === 0) throw new PromoLinkClaimTaskInputError("items_required");
  if (input.items.length > PROMO_LINK_CLAIM_LIMITS.maxBatchSize) {
    throw new PromoLinkClaimTaskInputError("batch_size_exceeded");
  }
  const seen = new Set<string>();
  const items: PromoLinkClaimScopeItem[] = [];
  for (const item of input.items) {
    const novelSourceItemId = required(item.novelSourceItemId, "novel_source_item_id_required");
    const offerType = required(item.offerType, "offer_type_required", 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(novelSourceItemId)) {
      throw new PromoLinkClaimTaskInputError("novel_source_item_id_invalid");
    }
    const key = `${novelSourceItemId}\n${offerType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ novelSourceItemId, offerType });
  }
  if (items.length === 0) throw new PromoLinkClaimTaskInputError("items_required");
  return { channelAccountId, channelAppId, items, requestToken, actorId, requestId, mode };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationScopeHash(items: readonly PromoLinkClaimScopeItem[]): string {
  const normalized = items
    .map((item) => `${item.novelSourceItemId}\n${item.offerType}`)
    .sort();
  return digest(normalized);
}

async function findActiveConflict(
  db: PrismaClient,
  channelAccountId: string,
  channelAppId: string,
  scopeHash: string,
) {
  return db.genericTask.findFirst({
    where: {
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      channelAccountId,
      channelAppId,
      operationScopeHash: scopeHash,
      status: { in: ["pending", "processing"] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

export async function createPromoLinkClaimTask(
  prisma: PrismaClient,
  rawInput: CreatePromoLinkClaimTaskInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromoLinkClaimTaskCreationResult> {
  const input = validateInput(rawInput);

  const duplicate = await prisma.genericTask.findUnique({ where: { requestToken: input.requestToken } });
  if (duplicate) return { status: "duplicate", taskId: duplicate.id };

  const binding = await prisma.channelApp.findFirst({
    where: {
      id: input.channelAppId,
      status: "active",
      channel: {
        status: "active",
        channelAccounts: { some: { id: input.channelAccountId, status: "active", deletedAt: null } },
      },
    },
    select: { id: true },
  });
  if (!binding) throw new PromoLinkClaimTaskInputError("active_channel_binding_required");

  const skipReasonCounts: Record<string, number> = {};
  const requestedIds = input.items.map((item) => item.novelSourceItemId);
  const sources = await prisma.novelSourceItem.findMany({
    where: { id: { in: requestedIds }, channelAppId: input.channelAppId },
    select: { id: true, novelId: true, status: true, deletedAt: true },
  });
  const byId = new Map(sources.map((source) => [source.id, source]));

  const structurallyEligible: PromoLinkClaimScopeItem[] = [];
  for (const item of input.items) {
    const source = byId.get(item.novelSourceItemId);
    if (!source || source.deletedAt) {
      increment(skipReasonCounts, "source_unlinked_or_deleted");
      continue;
    }
    if (source.status !== "linked" || !source.novelId) {
      increment(skipReasonCounts, "source_not_linked");
      continue;
    }
    structurallyEligible.push(item);
  }
  if (structurallyEligible.length === 0) return { status: "no_eligible_sources", skipReasonCounts };

  // Exact-resubmission check runs *before* the cross-task overlap precheck
  // below, on the full structurally-eligible set. Doc §4 verification item
  // 2 requires an identical-scope resubmission to fail explicitly
  // (`active_conflict`), not silently degrade into "nothing left to do"
  // once its own items are (correctly) seen as "already active elsewhere"
  // by the overlap precheck.
  const fullScopeHash = operationScopeHash(structurallyEligible);
  const identicalActive = await findActiveConflict(prisma, input.channelAccountId, input.channelAppId, fullScopeHash);
  if (identicalActive) return { status: "active_conflict", taskId: identicalActive.id };

  // Cross-task overlap precheck (doc §4.6: the DB's active-scope unique
  // index only backstops an *exact* resubmission — this is the
  // application-layer precheck for partially-overlapping-but-different
  // selections). `PromoLink.idempotency_key`'s own DB unique constraint is
  // the final backstop the worker handler relies on if this precheck still
  // races a concurrent submission.
  const alreadyActive = await prisma.genericTaskItem.findMany({
    where: {
      targetType: PROMO_LINK_CLAIM_TARGET_TYPE,
      targetId: { in: structurallyEligible.map((item) => item.novelSourceItemId) },
      task: { taskType: PROMO_LINK_CLAIM_TASK_TYPE, status: { in: ["pending", "processing"] } },
    },
    select: { targetId: true },
  });
  const activeElsewhere = new Set(alreadyActive.map((row) => row.targetId));

  const eligible = structurallyEligible.filter((item) => {
    if (!activeElsewhere.has(item.novelSourceItemId)) return true;
    increment(skipReasonCounts, "item_already_active_elsewhere");
    return false;
  });
  if (eligible.length === 0) return { status: "no_eligible_sources", skipReasonCounts };

  const scopeHash = operationScopeHash(eligible);
  const active = await findActiveConflict(prisma, input.channelAccountId, input.channelAppId, scopeHash);
  if (active) return { status: "active_conflict", taskId: active.id };

  const enabled = isPromoLinkClaimEnabled(env);
  const writeAllowed = isPromoLinkClaimWriteAllowed(env);
  const taskStatus = enabled && (input.mode === "dry_run" || writeAllowed) ? "pending" : "disabled";
  const expiresAt = new Date(Date.now() + PROMO_LINK_CLAIM_LIMITS.ttlMs);
  const taskId = randomUUID();
  const itemPayload = (item: PromoLinkClaimScopeItem) =>
    ({
      novelSourceItemId: item.novelSourceItemId,
      offerType: item.offerType,
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      actorId: input.actorId,
      requestId: input.requestId,
      expiresAt: expiresAt.toISOString(),
    }) satisfies Prisma.InputJsonObject;

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.genericTask.create({
        data: {
          id: taskId,
          taskType: PROMO_LINK_CLAIM_TASK_TYPE,
          channelAccountId: input.channelAccountId,
          channelAppId: input.channelAppId,
          operationScopeHash: scopeHash,
          mode: input.mode,
          status: taskStatus,
          requestToken: input.requestToken,
          totalCount: eligible.length,
          params: {
            actorId: input.actorId,
            requestId: input.requestId,
            expiresAt: expiresAt.toISOString(),
            featureFlagEnabled: enabled,
            allowWriteEnabled: writeAllowed,
            skipReasonCounts,
          },
          items: {
            create: eligible.map((item) => ({
              targetType: PROMO_LINK_CLAIM_TARGET_TYPE,
              targetId: item.novelSourceItemId,
              payload: itemPayload(item),
            })),
          },
        },
      });
      await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: input.actorId,
          action: taskStatus === "pending" ? "promo_link_claim.queued" : "promo_link_claim.queued_disabled",
          entityType: "GenericTask",
          entityId: taskId,
          requestId: input.requestId,
          taskType: PROMO_LINK_CLAIM_TASK_TYPE,
          taskId,
          afterSnapshot: {
            mode: input.mode,
            status: taskStatus,
            eligibleCount: eligible.length,
            skipReasonCounts,
          },
        },
      });
      return {
        status: "enqueued",
        taskId,
        taskStatus,
        eligibleCount: eligible.length,
        skipReasonCounts,
      } as const;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const exact = await prisma.genericTask.findUnique({ where: { requestToken: input.requestToken } });
    if (exact) return { status: "duplicate", taskId: exact.id };
    const conflict = await findActiveConflict(prisma, input.channelAccountId, input.channelAppId, scopeHash);
    if (conflict) return { status: "active_conflict", taskId: conflict.id };
    throw error;
  }
}
