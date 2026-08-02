import type { ParentTaskStatus, TaskItemCounts } from "./types";

export function deriveParentTaskStatus(counts: TaskItemCounts): ParentTaskStatus {
  if (counts.pending + counts.processing > 0) return "processing";
  if (counts.failed > 0 && counts.success === 0 && counts.skipped === 0) return "failed";
  if (counts.failed > 0) return "completed_with_errors";
  return "completed";
}
