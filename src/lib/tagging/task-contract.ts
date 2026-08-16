export const TAGGING_AUTO_CLASSIFY_TASK_TYPE = "tagging.auto_classify" as const;
export const TAGGING_TASK_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const TAGGING_ALL_APPLY_CONFIRMATION = "P2_06_5_TAGGING_ALL_APPLY" as const;

export const TAGGING_TASK_LIFECYCLES = ["initialize_missing", "reclassify_existing"] as const;
export type TaggingTaskLifecycle = (typeof TAGGING_TASK_LIFECYCLES)[number];

export interface TaggingAutoClassifyTaskPayload {
  schemaVersion: 1;
  lifecycle: TaggingTaskLifecycle;
  novelId: string;
  expectedContentSha256: string;
  expectedEntityFingerprint: string;
  taxonomyVersion: string;
  taxonomySha256: string;
  keywordLexiconVersion: string;
  keywordFingerprint: string;
  classifierConfigVersion: string;
  classifierConfigFingerprint: string;
  classificationRequestId: string;
}

export function parseTaggingAutoClassifyTaskPayload(value: unknown): TaggingAutoClassifyTaskPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tagging_task_payload_invalid");
  const payload = value as Partial<TaggingAutoClassifyTaskPayload>;
  const hashes = [
    payload.expectedContentSha256,
    payload.expectedEntityFingerprint,
    payload.taxonomySha256,
    payload.keywordFingerprint,
    payload.classifierConfigFingerprint,
  ];
  if (
    payload.schemaVersion !== TAGGING_TASK_PAYLOAD_SCHEMA_VERSION
    || !TAGGING_TASK_LIFECYCLES.includes(payload.lifecycle as TaggingTaskLifecycle)
    || typeof payload.novelId !== "string"
    || typeof payload.taxonomyVersion !== "string"
    || typeof payload.keywordLexiconVersion !== "string"
    || typeof payload.classifierConfigVersion !== "string"
    || typeof payload.classificationRequestId !== "string"
    || hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
  ) {
    throw new Error("tagging_task_payload_invalid");
  }
  return payload as TaggingAutoClassifyTaskPayload;
}

