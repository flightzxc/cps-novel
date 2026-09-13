/**
 * Novel materialization from a `NovelSourceItem`.
 *
 * This is the Novel-only write path. It must not query templates,
 * render an article draft, plan an Article slug/short id, or insert
 * an Article row. A linked Novel with zero Articles is a normal stage.
 *
 * Article generation lives in `./generate.ts` and is a later, explicit
 * operator action that requires a ready PromoLink.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { withDbRetry } from "@/lib/db/db-retry";
import { normalizeNovelTitle } from "@/lib/novel/novel-identity";
import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { createNovelWithBusinessIdRetry } from "./business-id";
import {
  enqueueContentCreationPreview,
} from "./preview-enqueue";
import {
  auditActorId,
  auditActorType,
  deriveLocale,
  existsCheck,
  NOVEL_CREATE_AUDIT_ACTION,
  requireActor,
  requireRequestId,
  requireUuid,
  resolveUniqueSlug,
} from "./shared";
import type {
  CreateContentActor,
  CreateContentFromSourceItemInput,
  CreateContentResult,
  CreatedContentSummary,
  ContentCreationInputErrorCode,
  ContentCreationPlan,
  MaterializeNovelFromSourceItemInput,
  MaterializedNovelSummary,
  NovelMaterializeResult,
} from "./types";
import { ContentCreationInputError } from "./types";

export {
  ContentCreationInputError,
  type ContentCreationInputErrorCode,
  type ContentCreationPlan,
  type CreateContentActor,
  type CreateContentFromSourceItemInput,
  type CreateContentResult,
  type CreatedContentSummary,
  type MaterializeNovelFromSourceItemInput,
  type MaterializedNovelSummary,
  type NovelMaterializeResult,
};

class ContentCreationConflictSignal extends Error {}

type SourceItemRow = {
  id: string;
  novelId: string | null;
  status: string;
  title: string;
  description: string;
  coverUrl: string | null;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: Prisma.Decimal | null;
  sourceLocale: string | null;
  deletedAt: Date | null;
};

const SOURCE_ITEM_PLAN_SELECT = Object.freeze({
  id: true,
  novelId: true,
  status: true,
  title: true,
  description: true,
  coverUrl: true,
  totalChapterCount: true,
  paidFromChapter: true,
  splitRatio: true,
  sourceLocale: true,
  deletedAt: true,
} as const);

type NovelRow = { id: string; businessId: string; locale: string; slug: string; deletedAt: Date | null };

type ReadClient = {
  novelSourceItem: {
    findFirst: (args: {
      where: { id: string };
      select: typeof SOURCE_ITEM_PLAN_SELECT;
    }) => Promise<SourceItemRow | null>;
  };
  novel: {
    findFirst: (args: {
      where: { id?: string; locale?: string; slug?: string; deletedAt?: null };
      select?: { id: true };
    }) => Promise<NovelRow | { id: string } | null>;
  };
};

type WriteClient = ReadClient & {
  novel: ReadClient["novel"] & { create: (args: { data: Record<string, unknown> }) => Promise<NovelRow> };
  novelSourceItem: ReadClient["novelSourceItem"] & {
    updateMany: (args: {
      where: { id: string; novelId: null; deletedAt: null };
      data: { novelId: string; status: "linked" };
    }) => Promise<{ count: number }>;
  };
  operationAudit: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
};

async function loadPlan(
  client: ReadClient,
  novelSourceItemId: string,
): Promise<
  | { readonly stage: "blocked"; readonly result: NovelMaterializeResult }
  | { readonly stage: "already_exists"; readonly summary: MaterializedNovelSummary }
  | { readonly stage: "ready"; readonly sourceItem: SourceItemRow; readonly locale: SiteLocale; readonly novelSlug: string }
> {
  const sourceItem = await client.novelSourceItem.findFirst({
    where: { id: novelSourceItemId },
    select: SOURCE_ITEM_PLAN_SELECT,
  });
  if (!sourceItem) return { stage: "blocked", result: { outcome: "source_item_not_found" } };
  if (sourceItem.deletedAt !== null) return { stage: "blocked", result: { outcome: "source_item_deleted" } };

  const locale = deriveLocale(sourceItem.sourceLocale);

  if (sourceItem.novelId !== null) {
    const existingNovel = (await client.novel.findFirst({ where: { id: sourceItem.novelId } })) as NovelRow | null;
    if (!existingNovel || existingNovel.deletedAt !== null) {
      return { stage: "blocked", result: { outcome: "source_item_inconsistent_state" } };
    }
    if (existingNovel.locale !== locale) {
      return {
        stage: "blocked",
        result: {
          outcome: "locale_conflict",
          reason: "source_item_already_linked_to_different_locale",
          existingNovelId: existingNovel.id,
          existingLocale: existingNovel.locale,
          derivedLocale: locale,
        },
      };
    }
    return {
      stage: "already_exists",
      summary: {
        novelId: existingNovel.id,
        novelBusinessId: existingNovel.businessId,
        locale,
        novelSlug: existingNovel.slug,
      },
    };
  }

  if (sourceItem.status === "ignored") return { stage: "blocked", result: { outcome: "source_item_ignored" } };
  if (sourceItem.status === "stale") return { stage: "blocked", result: { outcome: "source_item_stale" } };
  if (sourceItem.status !== "pending") return { stage: "blocked", result: { outcome: "source_item_inconsistent_state" } };

  const novelSlugResult = await resolveUniqueSlug(
    sourceItem.title,
    locale,
    existsCheck((args) => client.novel.findFirst(args) as Promise<{ id: string } | null>, locale),
  );
  if (novelSlugResult.outcome !== "ok") {
    return { stage: "blocked", result: { outcome: novelSlugResult.outcome, field: "novel", baseSlug: novelSlugResult.baseSlug } };
  }

  return { stage: "ready", sourceItem, locale, novelSlug: novelSlugResult.slug };
}

async function runDryRun(db: PrismaClient, novelSourceItemId: string): Promise<NovelMaterializeResult> {
  const plan = await loadPlan(db as unknown as ReadClient, novelSourceItemId);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };
  return {
    outcome: "dry_run",
    plan: {
      locale: plan.locale,
      title: plan.sourceItem.title,
      novelSlug: plan.novelSlug,
    },
  };
}

async function runMaterializeTransaction(
  tx: WriteClient,
  input: { novelSourceItemId: string; actorType: "admin" | "system"; actorId: string; requestId: string },
): Promise<NovelMaterializeResult> {
  const plan = await loadPlan(tx, input.novelSourceItemId);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };

  const { sourceItem, locale, novelSlug } = plan;
  const novel = await createNovelWithBusinessIdRetry((businessId) =>
    tx.novel.create({
      data: {
        businessId,
        title: sourceItem.title,
        titleNormalized: normalizeNovelTitle(sourceItem.title),
        description: sourceItem.description,
        coverUrl: sourceItem.coverUrl,
        locale,
        slug: novelSlug,
        totalChapterCount: sourceItem.totalChapterCount,
        paidFromChapter: sourceItem.paidFromChapter,
        splitRatio: sourceItem.splitRatio,
      },
    }),
  );

  const link = await tx.novelSourceItem.updateMany({
    where: { id: sourceItem.id, novelId: null, deletedAt: null },
    data: { novelId: novel.id, status: "linked" },
  });
  if (link.count !== 1) {
    throw new ContentCreationConflictSignal();
  }

  await tx.operationAudit.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: NOVEL_CREATE_AUDIT_ACTION,
      entityType: "Novel",
      entityId: novel.id,
      requestId: input.requestId,
      afterSnapshot: {
        novelId: novel.id,
        novelBusinessId: novel.businessId,
        locale,
        novelSlug,
        novelSourceItemId: sourceItem.id,
      },
    },
  });

  return {
    outcome: "created",
    novelId: novel.id,
    novelBusinessId: novel.businessId,
    locale,
    novelSlug,
  };
}

export async function materializeNovelFromSourceItemInTransaction(
  tx: Prisma.TransactionClient,
  input: Omit<MaterializeNovelFromSourceItemInput, "mode" | "deferPreviewEnqueue">,
): Promise<NovelMaterializeResult> {
  const novelSourceItemId = requireUuid(input.novelSourceItemId, "invalid_novel_source_item_id");
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);
  return runMaterializeTransaction(tx as unknown as WriteClient, {
    novelSourceItemId,
    actorType: auditActorType(input.actor),
    actorId: auditActorId(input.actor),
    requestId,
  });
}

export async function materializeNovelFromSourceItem(
  db: PrismaClient,
  input: MaterializeNovelFromSourceItemInput,
): Promise<NovelMaterializeResult> {
  const novelSourceItemId = requireUuid(input.novelSourceItemId, "invalid_novel_source_item_id");
  const mode = input.mode ?? "dry_run";
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);

  if (mode === "dry_run") {
    return runDryRun(db, novelSourceItemId);
  }

  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  try {
    const result = await withDbRetry(
      () =>
        db.$transaction((tx) =>
          runMaterializeTransaction(tx as unknown as WriteClient, {
            novelSourceItemId,
            actorType,
            actorId,
            requestId,
          }),
        ),
      { op: "content-creation.materializeNovelFromSourceItem", sourceItemId: novelSourceItemId, idempotencyKey: requestId },
    );
    if (result.outcome !== "created" || input.deferPreviewEnqueue) return result;
    const previewEnqueue = await enqueueContentCreationPreview(db, {
      novelSourceItemIds: [novelSourceItemId],
      requestToken: `moboreader.preview_refresh.v1:novel_materialize:${novelSourceItemId}`,
      requestId,
      actorId,
    });
    return { ...result, previewEnqueue };
  } catch (error) {
    if (error instanceof ContentCreationConflictSignal) {
      return { outcome: "concurrent_creation_conflict" };
    }
    throw error;
  }
}

/** @deprecated Use materializeNovelFromSourceItemInTransaction. */
export const createContentFromSourceItemInTransaction = materializeNovelFromSourceItemInTransaction;
/** @deprecated Use materializeNovelFromSourceItem. */
export const createContentFromSourceItem = materializeNovelFromSourceItem;
