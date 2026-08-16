import type { LaneCEligibilityOverlay } from "./lexicon-eligibility.mjs";

export interface LaneCBuiltKeyword {
  keywordId: string;
  value: string;
  scriptBuckets: string[];
  matchMode: string;
  sourceLanguageCodes: string[];
  riskFlags: string[];
  allowedFields?: string[];
  blockedDescriptionNamedScopes?: string[];
}

export interface LaneCBuiltTag {
  canonicalTagId: string;
  slug: string;
  definition: string;
  textSelectionPriority: number;
  keywordCoverageStatus: string;
  keywords: LaneCBuiltKeyword[];
}

export interface LaneCBuiltLexicon {
  taxonomy: {
    taxonomyVersion: string;
    keywordLexiconVersion: string;
    canonicalTags: LaneCBuiltTag[];
  };
  audit: {
    source: string;
    normalization_for_collision_audit_only: string;
    active_keyword_count: number;
    coverage_insufficient_tag_count: number;
    disabled_seed_count: number;
    disabled: Array<Record<string, unknown>>;
    tie_break: string;
    restricted_seed_count?: number;
    restricted?: Array<Record<string, unknown>>;
    lexicon_override_version?: string;
  };
}

export function buildLexicon(canonical: unknown, overlay?: LaneCEligibilityOverlay | null): LaneCBuiltLexicon;
export function verifyOwnerFinalC1(directory: string): Promise<{
  ok: boolean;
  failures: unknown[];
  manifest: { lineage: Record<string, unknown> };
}>;
