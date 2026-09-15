import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  normalizeArticleGenerateFilter,
  type ArticleGenerateFilter,
  type NormalizedArticleGenerateFilter,
} from "../../src/domain/article-generation";
import {
  articleGenerateEligibleWhere,
  resolveArticleGenerateAdmissions,
} from "../../src/server/content-creation/eligibility";
import {
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE_V2,
  ARTICLE_GENERATE_BATCH_V1_FILTER_REJECTED_CODE,
  ARTICLE_GENERATE_BATCH_V1_FILTER_REJECTED_MESSAGE,
  ARTICLE_GENERATE_LEAF_MAX,
  ARTICLE_GENERATE_TASK_TYPE,
  createArticleGenerateLeafTask,
} from "../../src/lib/tasks/article-generate";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";

type ParentEnvelope = Readonly<{
  actorId: string;
  requestId: string;
  submittedAt: string;
  expiresAt: string;
  templateKeysByLocale?: Readonly<Record<string, string>>;
}>;

function parseEnvelope(value: unknown): ParentEnvelope & { readonly rawFilter: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  const p = value as Record<string, unknown>;
  if (typeof p.actorId !== "string" || !p.actorId || typeof p.requestId !== "string" || !p.requestId
    || typeof p.submittedAt !== "string" || !Number.isFinite(Date.parse(p.submittedAt))
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))
    || !p.filter || typeof p.filter !== "object" || Array.isArray(p.filter)) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  const templateKeysByLocale = p.templateKeysByLocale;
  if (templateKeysByLocale !== undefined && (typeof templateKeysByLocale !== "object" || templateKeysByLocale === null || Array.isArray(templateKeysByLocale))) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  return {
    actorId: p.actorId,
    requestId: p.requestId,
    submittedAt: p.submittedAt,
    expiresAt: p.expiresAt,
    ...(templateKeysByLocale ? { templateKeysByLocale: templateKeysByLocale as Record<string, string> } : {}),
    rawFilter: p.filter,
  };
}

/** Frozen — the only shape `article.generate.batch.v1` was ever enqueued with. */
const LEGACY_FILTER_KEYS = new Set(["search", "locale"]);

type ParsedFilter =
  | Readonly<{ kind: "legacy_shape_rejected" }>
  | Readonly<{ kind: "ok"; filter: NormalizedArticleGenerateFilter }>;

/**
 * v1 (`ARTICLE_GENERATE_BATCH_TASK_TYPE`) is drain-only: it must keep
 * reading exactly the frozen legacy `{search?, locale?}` shape it was
 * always enqueued with, and reject — never silently ignore — anything
 * beyond that (see `ARTICLE_GENERATE_BATCH_V1_FILTER_REJECTED_CODE`'s doc
 * comment for why). It deliberately does NOT call the current
 * `normalizeArticleGenerateFilter` — that function no longer reads
 * `locale` at all, so running a v1 payload through it would silently drop
 * the one field v1 payloads actually carry, exactly the scope-widening bug
 * this split exists to prevent.
 *
 * v2 (`ARTICLE_GENERATE_BATCH_TASK_TYPE_V2`) re-runs the real normalizer
 * against the persisted snapshot rather than trusting it verbatim — cheap
 * defense in depth against a hand-edited or future-shape row reaching an
 * older worker build.
 */
function parseFilterForTaskType(taskType: string, rawFilter: unknown): ParsedFilter {
  if (taskType !== ARTICLE_GENERATE_BATCH_TASK_TYPE) {
    return { kind: "ok", filter: normalizeArticleGenerateFilter(rawFilter as ArticleGenerateFilter) };
  }
  const keys = Object.keys(rawFilter as Record<string, unknown>);
  if (keys.some((key) => !LEGACY_FILTER_KEYS.has(key))) {
    return { kind: "legacy_shape_rejected" };
  }
  const raw = rawFilter as { search?: unknown; locale?: unknown };
  if ((raw.search !== undefined && typeof raw.search !== "string")
    || (raw.locale !== undefined && typeof raw.locale !== "string")) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  const search = typeof raw.search === "string" ? raw.search.trim() : "";
  const locale = typeof raw.locale === "string" ? raw.locale.trim() : "";
  if (search.length > 200 || locale.length > 16) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  return {
    kind: "ok",
    filter: Object.freeze({
      ...(search ? { search } : {}),
      ...(locale ? { locales: Object.freeze([locale]) } : {}),
    }),
  };
}

function childToken(parentId: string, afterId: string): string {
  return `article_generate_child:${createHash("sha256").update(`${parentId}\n${afterId}`).digest("hex")}`;
}

export function createArticleGenerateBatchHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    if (
      (lease.taskType !== ARTICLE_GENERATE_BATCH_TASK_TYPE && lease.taskType !== ARTICLE_GENERATE_BATCH_TASK_TYPE_V2)
      || lease.itemId === ""
    ) {
      throw new Error("article_generate_batch_lease_invalid");
    }
    const envelope = parseEnvelope(lease.payload);
    const parsedFilter = parseFilterForTaskType(lease.taskType, envelope.rawFilter);
    if (parsedFilter.kind === "legacy_shape_rejected") {
      return {
        status: "failed",
        error: {
          code: ARTICLE_GENERATE_BATCH_V1_FILTER_REJECTED_CODE,
          message: ARTICLE_GENERATE_BATCH_V1_FILTER_REJECTED_MESSAGE,
        },
      };
    }
    const payload = {
      actorId: envelope.actorId,
      requestId: envelope.requestId,
      submittedAt: envelope.submittedAt,
      expiresAt: envelope.expiresAt,
      ...(envelope.templateKeysByLocale ? { templateKeysByLocale: envelope.templateKeysByLocale } : {}),
      filter: parsedFilter.filter,
    };
    return {
      status: "success",
      transactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      transactionTimeoutMs: 120_000,
      protectedWrite: async (tx) => {
        const expiry = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiry) || Date.now() >= expiry) {
          await tx.genericTask.update({
            where: { id: lease.taskId },
            data: { result: {
              enumerationStatus: "expired",
              selectedCount: 0,
              submittedCount: 0,
              blockedCount: 0,
              blockedReasonCounts: {},
              childTaskCount: 0,
            } },
          });
          return { status: "skipped", result: { enumerationStatus: "expired" } };
        }

        const where = articleGenerateEligibleWhere(payload.filter);
        let after: string | undefined;
        let selectedCount = 0;
        let submittedCount = 0;
        let childTaskCount = 0;
        const blockedReasonCounts: Record<string, number> = {};
        const templates = payload.templateKeysByLocale;
        while (true) {
          const rows = await tx.novel.findMany({
            where: {
              ...where,
              ...(after ? { id: { gt: after } } : {}),
            },
            orderBy: { id: "asc" },
            take: ARTICLE_GENERATE_LEAF_MAX,
            select: {
              id: true,
              title: true,
              locale: true,
              businessId: true,
              deletedAt: true,
              articles: { select: { id: true, locale: true, deletedAt: true } },
            },
          });
          if (rows.length === 0) break;
          const pageNovelIds = rows.map((row) => row.id);
          selectedCount += pageNovelIds.length;
          const admissions = await resolveArticleGenerateAdmissions(tx, pageNovelIds, rows);
          const readyNovelIds = pageNovelIds.filter((novelId) => {
            const admission = admissions.get(novelId)!;
            if (admission.canGenerate) return true;
            if (admission.blockedReason) {
              blockedReasonCounts[admission.blockedReason] = (blockedReasonCounts[admission.blockedReason] ?? 0) + 1;
            }
            return false;
          });
          if (readyNovelIds.length > 0) {
            const childId = randomUUID();
            const leafPayload = {
              novelIds: readyNovelIds,
              actorId: payload.actorId,
              requestId: `${payload.requestId}:${childTaskCount}`,
              submittedAt: payload.submittedAt,
              expiresAt: payload.expiresAt,
              ...(templates ? { templateKeysByLocale: templates } : {}),
            };
            await createArticleGenerateLeafTask(tx, {
              taskId: childId,
              parentTaskId: lease.taskId,
              requestToken: childToken(lease.taskId, after ?? "start"),
              novelIds: readyNovelIds,
              actorId: payload.actorId,
              requestId: payload.requestId,
              inputFingerprint: createHash("sha256").update(JSON.stringify(leafPayload)).digest("hex"),
              payload: leafPayload,
              templates,
            });
            submittedCount += readyNovelIds.length;
            childTaskCount += 1;
          }
          after = rows.at(-1)!.id;
          if (rows.length < ARTICLE_GENERATE_LEAF_MAX) break;
        }

        await tx.genericTask.update({
          where: { id: lease.taskId },
          data: {
            result: {
              enumerationStatus: "completed",
              selectedCount,
              submittedCount,
              blockedCount: selectedCount - submittedCount,
              blockedReasonCounts,
              childTaskCount,
              expiresAt: payload.expiresAt,
            },
          },
        });
        return {
          status: "success",
          result: {
            enumerationStatus: "completed",
            selectedCount,
            submittedCount,
            blockedCount: selectedCount - submittedCount,
            blockedReasonCounts,
            childTaskCount,
          },
        };
      },
    };
  };
}

export function createArticleGenerateBatchWorkerHandlers(db: PrismaClient) {
  // Same handler instance for both — it branches on `lease.taskType`
  // internally (`parseFilterForTaskType`) to pick the v1 drain-only
  // fail-closed path vs the v2 re-normalize path.
  const handler = createArticleGenerateBatchHandler(db);
  return createHandlerRegistry({
    [ARTICLE_GENERATE_BATCH_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler },
    [ARTICLE_GENERATE_BATCH_TASK_TYPE_V2]: { family: "generic", maxAttempts: 3, handler },
  });
}

export const ARTICLE_GENERATE_CHILD_TASK_TYPE = ARTICLE_GENERATE_TASK_TYPE;
