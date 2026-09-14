import { ARTICLE_GENERATE_BATCH_TASK_TYPE } from "./article-generate";
import { CATALOG_BATCH_TASK_TYPE } from "./catalog-batch";

/** Parent tasks whose counters and phase come from children, not the enum item. */
export const PARENT_BATCH_TASK_TYPES = [
  CATALOG_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
] as const;

export type ParentBatchTaskType = (typeof PARENT_BATCH_TASK_TYPES)[number];

export function isParentBatchTaskType(taskType: string | null | undefined): taskType is ParentBatchTaskType {
  return taskType !== null && taskType !== undefined
    && (PARENT_BATCH_TASK_TYPES as readonly string[]).includes(taskType);
}
