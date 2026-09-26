import { TaggingError } from "./contracts";

/** Owner WO-7: one classification task contains at most 5,000 explicit novels. */
export const TAGGING_NOVEL_IDS_MAX = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeTaggingNovelIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length > TAGGING_NOVEL_IDS_MAX) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "novelIds exceeds the 5000-item hard limit");
  }
  if (ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "novelIds must contain UUIDs");
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}
