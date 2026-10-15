import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { MoboreaderPreviewChapter } from "../adapters";
import { paidFromChapterForUpdate, totalChapterCountForUpdate } from "../tasks/moboreader";

/** Changdu-only initialization value. Generic publish/read gates must read the policy row. */
export const CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS = 3;

export interface ChangduPreviewPlan {
  authoritative: boolean;
  upstreamCount: number;
  materializedCount: number;
  chapters: readonly (MoboreaderPreviewChapter & { contentHash: string; charCount: number })[];
  /**
   * B-42：本次响应里正文为空的章节号（升序）。这些章节不物化；数据库里已有的同号章节
   * 由 `materializeChangduPreview` 原样保留（不覆盖、不置 stale）。
   */
  emptyChapterNumbers: readonly number[];
  reason: "authoritative_non_empty" | "untrusted_or_empty" | "all_content_empty";
}

/**
 * B-42：正文是否为空（空串或纯空白）。与此前适配器拒绝空正文用的是同一个判定
 * （`!content.trim()`），只是从"整本失败"改成"跳过这一章"。
 */
export function isBlankPreviewContent(content: string): boolean {
  return content.trim() === "";
}

/**
 * B-42：一份上游响应里正文为空的章节号（升序）。给编排层用——试读编排（任务 handler）
 * 按约定不直接碰章节正文（`tests/backend/contracts/p2-05-secret-and-scope.test.ts`），
 * 只拿这份不含正文的章节号清单来决定"全部为空即无试读"并留痕。
 */
export function emptyPreviewChapterNumbers(chapterList: readonly MoboreaderPreviewChapter[]): number[] {
  return chapterList
    .filter((chapter) => isBlankPreviewContent(chapter.chapterContent))
    .map((chapter) => chapter.i)
    .sort((left, right) => left - right);
}

export interface BuildChangduPreviewPlanInput {
  chapterList: readonly MoboreaderPreviewChapter[];
  maxMaterializedChapters: number;
  trustedCompleteResponse: boolean;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 试读物化计划（纯函数）。
 *
 * B-42（Owner 2026-10-11 口径："空正文收录，我们就是只要有推广链接就可以了"）：一章正文为空
 * 不再让整本作废。所有行照旧过序号、章节 ID 与去重校验（任何一行不合格仍整份不可信）；
 * 校验通过后跳过空正文章节，从第一个非空章节起按章节号升序取至多 `maxMaterializedChapters`
 * 章。全部为空时不可信、不写任何东西（`all_content_empty`），由调用方记为"无试读"。
 */
export function buildChangduPreviewPlan(input: BuildChangduPreviewPlanInput): ChangduPreviewPlan {
  if (!Number.isSafeInteger(input.maxMaterializedChapters) || input.maxMaterializedChapters < 0) {
    throw new Error("invalid_preview_policy_cap");
  }
  const untrusted = (reason: ChangduPreviewPlan["reason"] = "untrusted_or_empty"): ChangduPreviewPlan => ({
    authoritative: false,
    upstreamCount: input.chapterList.length,
    materializedCount: 0,
    chapters: [],
    emptyChapterNumbers: [],
    reason,
  });
  if (!input.trustedCompleteResponse || input.chapterList.length === 0) return untrusted();
  const ordered = [...input.chapterList].sort((left, right) => left.i - right.i);
  const seenNumbers = new Set<number>();
  const seenIds = new Set<string>();
  for (const chapter of ordered) {
    if (!Number.isSafeInteger(chapter.i) || chapter.i < 1 || !chapter.chapterID || typeof chapter.chapterContent !== "string") {
      return untrusted();
    }
    if (seenNumbers.has(chapter.i) || seenIds.has(chapter.chapterID)) return untrusted();
    seenNumbers.add(chapter.i);
    seenIds.add(chapter.chapterID);
  }
  const readable = ordered.filter((chapter) => !isBlankPreviewContent(chapter.chapterContent));
  if (readable.length === 0) return untrusted("all_content_empty");
  const chapters = readable.slice(0, input.maxMaterializedChapters).map((chapter) => ({
    ...chapter,
    contentHash: hashContent(chapter.chapterContent),
    charCount: [...chapter.chapterContent].length,
  }));
  return {
    authoritative: true,
    upstreamCount: input.chapterList.length,
    materializedCount: chapters.length,
    chapters,
    emptyChapterNumbers: ordered.filter((chapter) => isBlankPreviewContent(chapter.chapterContent)).map((chapter) => chapter.i),
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
  /** B-42：本次响应里正文为空、因而跳过的章节数。 */
  emptyContentCount: number;
  /** B-42：空正文章节号上已有、本次原样保留的试读章节数（不覆盖、不置 stale）。 */
  preservedCount: number;
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
      emptyContentCount: 0,
      preservedCount: 0,
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
        emptyContentCount: 0,
        preservedCount: 0,
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

    // B-42：本次正文为空的章节号上，已有的试读章节原样保留——"空正文"只说明这次没拿到正文，
    // 不说明这一章不再属于试读。置 stale 会让已收录的章节页 404 并移出站点地图（公开网址冻结）。
    const preserved = plan.emptyChapterNumbers.length === 0
      ? []
      : await tx.novelChapter.findMany({
          where: {
            novelId: input.novelId,
            status: "preview",
            canonicalChapterNumber: { in: [...plan.emptyChapterNumbers] },
            id: { notIn: retainedChapterIds },
          },
          select: { id: true, deletedAt: true, content: { select: { novelChapterId: true } } },
        });
    const stale = await tx.novelChapter.updateMany({
      where: {
        novelId: input.novelId,
        status: "preview",
        id: { notIn: [...retainedChapterIds, ...preserved.map((chapter) => chapter.id)] },
        sourceItems: { some: { novelSourceItemId: input.novelSourceItemId, status: "materialized" } },
      },
      data: { status: "stale" },
    });
    // 策略行的章节数与后台"实际落地"比对（`policyCountMatchesActual`），保留下来的可读章节要算进去。
    const preservedReadableCount = preserved.filter((chapter) => chapter.deletedAt === null && chapter.content !== null).length;
    await tx.novelSourceItem.update({
      where: { id: input.novelSourceItemId },
      data: {
        totalChapterCount: totalChapterCountForUpdate(input.allEpis),
        // See worker/handlers/moboreader.ts / `paidFromChapterForUpdate` for
        // why this cannot be `input.payEpisFrom ?? undefined`: an upstream 0
        // must overwrite an existing positive value with NULL ("free now"),
        // not be swallowed into "leave unchanged".
        paidFromChapter: paidFromChapterForUpdate(input.payEpisFrom),
        lastSeenAt: now,
      },
    });
    await tx.novelPreviewPolicy.update({
      where: { novelId: input.novelId },
      data: { materializedChapterCount: plan.materializedCount + preservedReadableCount, lastRefreshedAt: now },
    });
    const auditSnapshot = {
      upstreamCount: plan.upstreamCount,
      materializedCount: plan.materializedCount,
      contentWrites,
      staleCount: stale.count,
      restoredCount,
      emptyContentCount: plan.emptyChapterNumbers.length,
      preservedCount: preserved.length,
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
      emptyContentCount: plan.emptyChapterNumbers.length,
      preservedCount: preserved.length,
      hashPrefixes: plan.chapters.map((chapter) => chapter.contentHash.slice(0, 12)),
    };
  };
  return isPrismaClient(prisma) ? prisma.$transaction(write) : write(prisma);
}
