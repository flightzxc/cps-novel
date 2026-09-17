import { ARTICLE_GENERATE_BATCH_TASK_TYPE, ARTICLE_GENERATE_BATCH_TASK_TYPE_V2 } from "./article-generate";
import { CATALOG_BATCH_TASK_TYPE } from "./catalog-batch";

/**
 * Parent tasks whose counters and phase come from children, not the enum
 * item. Both `article.generate.batch.v1` (drain-only) and `.v2` (current)
 * are listed — an already-enqueued v1 parent still needs its progress/
 * detail read to come from its children, exactly like a v2 one, until its
 * TTL clears it.
 */
export const PARENT_BATCH_TASK_TYPES = [
  CATALOG_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE_V2,
] as const;

export type ParentBatchTaskType = (typeof PARENT_BATCH_TASK_TYPES)[number];

export function isParentBatchTaskType(taskType: string | null | undefined): taskType is ParentBatchTaskType {
  return taskType !== null && taskType !== undefined
    && (PARENT_BATCH_TASK_TYPES as readonly string[]).includes(taskType);
}
