import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { MoboreaderPreviewChapter } from "../adapters";

/** Changdu-only initialization value. Generic publish/read gates must read the policy row. */
export const CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS = 3;

export interface ChangduPreviewPlan {
  authoritative: boolean;
  upstreamCount: number;
  materializedCount: number;
  chapters: readonly (MoboreaderPreviewChapter & { contentHash: string; charCount: number })[];
  reason: "authoritative_non_empty" | "untrusted_or_empty";
}

export interface BuildChangduPreviewPlanInput {
  chapterList: readonly MoboreaderPreviewChapter[];
  maxMaterializedChapters: number;
  trustedCompleteResponse: boolean;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildChangduPreviewPlan(input: BuildChangduPreviewPlanInput): ChangduPreviewPlan {
  if (!Number.isSafeInteger(input.maxMaterializedChapters) || input.maxMaterializedChapters < 0) {
    throw new Error("invalid_preview_policy_cap");
  }
  if (!input.trustedCompleteResponse || input.chapterList.length === 0) {
    return {
      authoritative: false,
      upstreamCount: input.chapterList.length,
      materializedCount: 0,
      chapters: [],
      reason: "untrusted_or_empty",
    };
  }
  const ordered = [...input.chapterList].sort((left, right) => left.i - right.i);
  const seenNumbers = new Set<number>();
  const seenIds = new Set<string>();
  for (const chapter of ordered) {
    if (!Number.isSafeInteger(chapter.i) || chapter.i < 1 || !chapter.chapterID || !chapter.chapterContent) {
      return {
        authoritative: false,
        upstreamCount: input.chapterList.length,
        materializedCount: 0,
        chapters: [],
        reason: "untrusted_or_empty",
      };
    }
    if (seenNumbers.has(chapter.i) || seenIds.has(chapter.chapterID)) {
      return {
        authoritative: false,
        upstreamCount: input.chapterList.length,
        materializedCount: 0,
        chapters: [],
        reason: "untrusted_or_empty",
      };
    }
    seenNumbers.add(chapter.i);
    seenIds.add(chapter.chapterID);
  }
  const chapters = ordered.slice(0, input.maxMaterializedChapters).map((chapter) => ({
    ...chapter,
    contentHash: hashContent(chapter.chapterContent),
    charCount: [...chapter.chapterContent].length,
  }));
  return {
    authoritative: true,
    upstreamCount: input.chapterList.length,
    materializedCount: chapters.length,
    chapters,
    reason: "authoritative_non_empty",
  };
}

export interface MaterializeChangduPreviewInput {
  novelId: string;
  novelSourceItemId: string;
  sourceFetchId: string;
  actorId: string;
  requestId: string;
  taskId: string;
  chapterList: readonly MoboreaderPreviewChapter[];
  trustedCompleteResponse: boolean;
  allEpis?: number | null;
  payEpisFrom?: number | null;
  now?: Date;
}

export interface MaterializeChangduPreviewResult {
  authoritative: boolean;
  upstreamCount: number;
  materializedCount: number;
  contentWrites: number;
  staleCount: number;
  restoredCount: number;
  hashPrefixes: readonly string[];
}

type PreviewWriteDb = PrismaClient | Prisma.TransactionClient;

function isPrismaClient(db: PreviewWriteDb): db is PrismaClient {
  return "$transaction" in db;
}

export async function materializeChangduPreview(
  prisma: PreviewWriteDb,
  input: MaterializeChangduPreviewInput,
): Promise<MaterializeChangduPreviewResult> {
  if (!input.trustedCompleteResponse || input.chapterList.length === 0) {
    return {
      authoritative: false,
      upstreamCount: input.chapterList.length,
      materializedCount: 0,
      contentWrites: 0,
      staleCount: 0,
      restoredCount: 0,
      hashPrefixes: [],
    };
  }
  const write = async (tx: Prisma.TransactionClient): Promise<MaterializeChangduPreviewResult> => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT n.id
      FROM novel n
      JOIN novel_source_item s ON s.novel_id = n.id
      WHERE n.id = ${input.novelId}::uuid AND s.id = ${input.novelSourceItemId}::uuid
        AND n.deleted_at IS NULL AND s.deleted_at IS NULL
      FOR UPDATE OF n, s
    `);
    if (!locked[0]) throw new Error("preview_source_binding_missing");
    const policy = await tx.novelPreviewPolicy.upsert({
      where: { novelId: input.novelId },
      create: {
        novelId: input.novelId,
        maxMaterializedChapters: CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS,
      },
      update: {},
    });
    const plan = buildChangduPreviewPlan({
      chapterList: input.chapterList,
      maxMaterializedChapters: policy.maxMaterializedChapters,
      trustedCompleteResponse: input.trustedCompleteResponse,
    });
    if (!plan.authoritative) {
      return {
        authoritative: false,
        upstreamCount: plan.upstreamCount,
        materializedCount: 0,
        contentWrites: 0,
        staleCount: 0,
        restoredCount: 0,
        hashPrefixes: [],
      };
    }

    const now = input.now ?? new Date();
    const retainedChapterIds: string[] = [];
    let contentWrites = 0;
    let restoredCount = 0;
    for (const chapter of plan.chapters) {
      const candidates = await tx.novelChapter.findMany({
        where: { novelId: input.novelId, canonicalChapterNumber: chapter.i },
        orderBy: { createdAt: "asc" },
        take: 2,
      });
      if (candidates.length > 1) throw new Error("ambiguous_canonical_chapter");
      const existingChapter = candidates[0];
      if (existingChapter?.status === "withdrawn") throw new Error("withdrawn_chapter_requires_manual_review");
      const canonical = existingChapter
        ? await tx.novelChapter.update({
            where: { id: existingChapter.id },
            data: {
              title: chapter.chapterShowName ?? chapter.chapterName,
              status: "preview",
              deletedAt: null,
            },
          })
        : await tx.novelChapter.create({
            data: {
              novelId: input.novelId,
              canonicalChapterNumber: chapter.i,
              title: chapter.chapterShowName ?? chapter.chapterName,
              status: "preview",
            },
          });
      if (existingChapter?.status === "stale") restoredCount += 1;
      retainedChapterIds.push(canonical.id);
      await tx.novelChapterSourceItem.upsert({
        where: {
          novelSourceItemId_externalChapterId: {
            novelSourceItemId: input.novelSourceItemId,
            externalChapterId: chapter.chapterID,
          },
        },
        create: {
          novelSourceItemId: input.novelSourceItemId,
          novelChapterId: canonical.id,
          externalChapterId: chapter.chapterID,
          sourceChapterNumber: chapter.i,
          chapterName: chapter.chapterName,
          chapterShowName: chapter.chapterShowName,
          status: "materialized",
          lastSeenAt: now,
          rawPayload: {
            i: chapter.i,
            chapterID: chapter.chapterID,
            chapterName: chapter.chapterName,
            chapterShowName: chapter.chapterShowName,
            contentHash: chapter.contentHash,
            charCount: chapter.charCount,
          },
        },
        update: {
          novelChapterId: canonical.id,
          sourceChapterNumber: chapter.i,
          chapterName: chapter.chapterName,
          chapterShowName: chapter.chapterShowName,
          status: "materialized",
          lastSeenAt: now,
          rawPayload: {
            i: chapter.i,
            chapterID: chapter.chapterID,
            chapterName: chapter.chapterName,
            chapterShowName: chapter.chapterShowName,
            contentHash: chapter.contentHash,
            charCount: chapter.charCount,
          },
        },
      });
      const content = await tx.novelChapterContent.findUnique({ where: { novelChapterId: canonical.id } });
      if (content?.contentHash !== chapter.contentHash) {
        await tx.novelChapterContent.upsert({
          where: { novelChapterId: canonical.id },
          create: {
            novelChapterId: canonical.id,
            body: chapter.chapterContent,
            charCount: chapter.charCount,
            contentHash: chapter.contentHash,
            materializedAt: now,
            sourceFetchId: input.sourceFetchId,
          },
          update: {
            body: chapter.chapterContent,
            charCount: chapter.charCount,
            contentHash: chapter.contentHash,
            materializedAt: now,
            sourceFetchId: input.sourceFetchId,
          },
        });
        contentWrites += 1;
      }
    }

    const stale = await tx.novelChapter.updateMany({
      where: {
        novelId: input.novelId,
        status: "preview",
        id: { notIn: retainedChapterIds },
        sourceItems: { some: { novelSourceItemId: input.novelSourceItemId, status: "materialized" } },
      },
      data: { status: "stale" },
    });
    await tx.novelSourceItem.update({
      where: { id: input.novelSourceItemId },
      data: {
        totalChapterCount: input.allEpis ?? undefined,
        paidFromChapter: input.payEpisFrom ?? undefined,
        lastSeenAt: now,
      },
    });
    await tx.novelPreviewPolicy.update({
      where: { novelId: input.novelId },
      data: { materializedChapterCount: plan.materializedCount, lastRefreshedAt: now },
    });
    const auditSnapshot = {
      upstreamCount: plan.upstreamCount,
      materializedCount: plan.materializedCount,
      contentWrites,
      staleCount: stale.count,
      restoredCount,
      characterCount: plan.chapters.reduce((sum, chapter) => sum + chapter.charCount, 0),
      hashPrefixes: plan.chapters.map((chapter) => chapter.contentHash.slice(0, 12)),
    };
    // OperationAudit is append-only for worker_app. A fenced retry of the same
    // manual request retains the first committed record instead of failing.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO operation_audit (
        actor_type, actor_id, action, entity_type, entity_id, request_id,
        task_type, task_id, after_snapshot
      ) VALUES (
        'admin', ${input.actorId}, 'moboreader.preview.materialized',
        'NovelSourceItem', ${input.novelSourceItemId}, ${input.requestId},
        'moboreader.preview_refresh.v1', ${input.taskId}::uuid,
        ${JSON.stringify(auditSnapshot)}::jsonb
      )
      ON CONFLICT DO NOTHING
    `);
    return {
      authoritative: true,
      upstreamCount: plan.upstreamCount,
      materializedCount: plan.materializedCount,
      contentWrites,
      staleCount: stale.count,
      restoredCount,
      hashPrefixes: plan.chapters.map((chapter) => chapter.contentHash.slice(0, 12)),
    };
  };
  return isPrismaClient(prisma) ? prisma.$transaction(write) : write(prisma);
}
