import type { Prisma } from "@prisma/client";

export type TagMode = "automatic" | "manual";
export type PersistedTagSource = "manual" | "auto";
export type EffectiveTagProvenance = "manual" | "mapped" | "auto";

export interface EffectiveTag {
  canonicalTagId: string;
  stableId: string;
  slug: string;
  displayName: string;
  provenance: EffectiveTagProvenance[];
  sortOrder: number;
}

export interface EffectiveTagLayers {
  mode: TagMode;
  revision: bigint;
  effective: EffectiveTag[];
  manual: EffectiveTag[];
  mapped: EffectiveTag[];
  auto: EffectiveTag[];
}

export interface TaggingActor {
  id: string;
  type: "admin";
}

export interface AutoTagCandidate {
  canonicalTagId: string;
  score: number;
  evidence: Prisma.InputJsonObject;
}

export interface TagClassificationRunMetadata {
  method: "deterministic_text" | "offline_llm";
  taxonomyVersion: string;
  taxonomySha256: string;
  keywordLexiconVersion: string;
  keywordFingerprint: string;
  classifierConfigVersion: string;
  classifierConfigFingerprint: string;
  taskType?: string;
  taskId?: string;
  resultSummary: Prisma.InputJsonObject;
}

export const TAGGING_ERROR_CODES = [
  "TAGGING_DISABLED", "NOVEL_NOT_FOUND", "DATA_INVARIANT_VIOLATION",
  "REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "TAG_NOT_ACTIVE",
  "CONFIG_NOT_READY", "AUTO_WRITE_NOT_AUTHORIZED",
] as const;

export type TaggingErrorCode = (typeof TAGGING_ERROR_CODES)[number];

export class TaggingError extends Error {
  constructor(readonly code: TaggingErrorCode, message: string = code) {
    super(message);
    this.name = "TaggingError";
  }
}

