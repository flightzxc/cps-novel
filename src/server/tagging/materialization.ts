import type { PrismaClient } from "@prisma/client";
import { isTaggingEnabled, isAutoTaggingEnabled, isAutoTagWriteAuthorized } from "@/lib/flags/feature-flags";
import { TAGGING_NOVEL_IDS_MAX } from "@/lib/tagging/novel-id-scope";
import { fingerprint } from "@/lib/tagging/stable-json";
import { TaggingError } from "@/lib/tagging/contracts";
import { summarizeDbError } from "@/lib/db/db-retry";
import { createTaggingAutoClassifyTask, initializeNovelTagSnapshot, type InitializeNovelTagSnapshotDependencies } from "./tasks";

function gatesOpen(env: NodeJS.ProcessEnv, context: string): boolean {
  const open = isTaggingEnabled(env) && isAutoTaggingEnabled(env) && isAutoTagWriteAuthorized(env);
  if (!open) console.info("[tagging-initialize]", { context, status: "skipped", reason: "tagging_gates_closed" });
  return open;
}

function failed(context: string, error: unknown): void {
  console.error("[tagging-initialize]", { context, status: "failed", error: summarizeDbError(error) });
}

/** Called only after successful creation has committed. Never changes its result. */
export async function initializeCreatedNovelTags(novelId: string, dependencies: InitializeNovelTagSnapshotDependencies): Promise<void> {
  if (!gatesOpen(dependencies.env ?? process.env, novelId)) return;
  try {
    await initializeNovelTagSnapshot(novelId, dependencies);
  } catch (error) {
    failed(novelId, error);
  }
}

export interface MaterializationTaggingDependencies extends InitializeNovelTagSnapshotDependencies {
  /** Test seam: can lower, never raise, the production limit. */
  segmentSize?: number;
}

/** One bounded ID scope per segment, never a locale/all scope. */
export async function initializeCreatedNovelBatchTags(
  novelIds: readonly string[],
  batchId: string,
  dependencies: MaterializationTaggingDependencies,
): Promise<void> {
  if (!gatesOpen(dependencies.env ?? process.env, batchId)) return;
  try {
    const segmentSize = dependencies.segmentSize ?? TAGGING_NOVEL_IDS_MAX;
    if (!Number.isInteger(segmentSize) || segmentSize < 1 || segmentSize > TAGGING_NOVEL_IDS_MAX) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "segmentSize must be between 1 and 5000");
    }
    const ids = [...new Set(novelIds.map((id) => id.toLowerCase()))].sort();
    for (let offset = 0; offset < ids.length; offset += segmentSize) {
      const segment = ids.slice(offset, offset + segmentSize);
      const requestId = fingerprint({ materializationTaskId: batchId, segmentIndex: offset / segmentSize, novelIdsSha256: fingerprint(segment) });
      try {
        await createTaggingAutoClassifyTask({
          db: dependencies.db, env: dependencies.env, dependencies,
          lifecycle: "initialize_missing", mode: "apply",
          scope: { kind: "novels", novelIds: segment }, requestId,
        });
      } catch (error) {
        // A failed segment does not suppress subsequent segments. Replaying the
        // same committed batch uses the same request IDs for every segment.
        failed(`${batchId}:${offset / segmentSize}`, error);
      }
    }
  } catch (error) {
    failed(batchId, error);
  }
}

/** Worker post-commit hook. Persisted item results are the sole creation evidence. */
export async function initializeMaterializedTaskTags(
  db: PrismaClient,
  taskId: string,
  options: Omit<MaterializationTaggingDependencies, "db"> = {},
): Promise<void> {
  if (!gatesOpen(options.env ?? process.env, taskId)) return;
  try {
    const task = await db.genericTask.findUnique({ where: { id: taskId }, select: { taskType: true, mode: true } });
    if (task?.taskType !== "novel.materialize.v1" || task.mode !== "apply") return;
    const unfinished = await db.genericTaskItem.count({ where: { taskId, status: { in: ["pending", "processing"] } } });
    if (unfinished !== 0) return;
    const novelIds: string[] = [];
    let after: string | undefined;
    while (true) {
      const rows = await db.genericTaskItem.findMany({
        where: { taskId, status: "success", ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, result: true }, orderBy: { id: "asc" }, take: TAGGING_NOVEL_IDS_MAX,
      });
      for (const row of rows) {
        const result = row.result;
        if (result && typeof result === "object" && !Array.isArray(result)
          && result.outcome === "created" && typeof result.novelId === "string") novelIds.push(result.novelId);
      }
      if (rows.length < TAGGING_NOVEL_IDS_MAX) break;
      after = rows.at(-1)!.id;
    }
    await initializeCreatedNovelBatchTags(novelIds, taskId, { ...options, db });
  } catch (error) {
    failed(taskId, error);
  }
}
