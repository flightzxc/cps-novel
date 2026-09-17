import { TaggingError } from "./contracts";
import { codePointLength, fingerprint } from "./stable-json";

export const CANONICAL_TAG_V1_COUNT = 123;
export const CANONICAL_TAG_V1_SHA256 = "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad";
export const KEYWORD_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const TAG_KEYWORD_SCRIPT_BUCKETS = ["latin", "cjk", "other", "unknown"] as const;
export const TAG_KEYWORD_MATCH_MODES = ["unicode_word", "cjk_contiguous", "auto"] as const;
export type TagKeywordScriptBucket = (typeof TAG_KEYWORD_SCRIPT_BUCKETS)[number];
export type TagKeywordMatchMode = (typeof TAG_KEYWORD_MATCH_MODES)[number];
export type TagKeywordField = "title" | "description";

export interface TagKeywordRule {
  keywordId: string;
  value: string;
  scriptBuckets: TagKeywordScriptBucket[];
  matchMode: TagKeywordMatchMode;
  riskFlags: string[];
  allowedFields?: TagKeywordField[];
}

export interface ClassifierTagRule {
  canonicalTagId: string;
  stableId: string;
  textSelectionPriority: number;
  keywords: TagKeywordRule[];
}

export interface KeywordRuleArtifact {
  schemaVersion: 1;
  taxonomyVersion: string;
  taxonomySha256: string;
  keywordLexiconVersion: string;
  keywordEligibilityVersion: string | null;
  keywordEligibilitySha256: string | null;
  keywordFingerprint: string;
  tags: ClassifierTagRule[];
}

export type KeywordRuleArtifactInput = Omit<KeywordRuleArtifact, "keywordFingerprint" | "keywordEligibilityVersion" | "keywordEligibilitySha256"> & {
  keywordFingerprint?: string;
  keywordEligibilityVersion?: string | null;
  keywordEligibilitySha256?: string | null;
};

function artifactPayload(artifact: Omit<KeywordRuleArtifact, "keywordFingerprint">) {
  return {
    schemaVersion: artifact.schemaVersion,
    taxonomyVersion: artifact.taxonomyVersion,
    taxonomySha256: artifact.taxonomySha256,
    keywordLexiconVersion: artifact.keywordLexiconVersion,
    keywordEligibilityVersion: artifact.keywordEligibilityVersion,
    keywordEligibilitySha256: artifact.keywordEligibilitySha256,
    tags: artifact.tags,
  };
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `${field} must be a string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `${field} must not contain duplicates`);
  }
  return [...value];
}

export function validateKeywordRuleArtifact(input: KeywordRuleArtifactInput): KeywordRuleArtifact {
  if (input.schemaVersion !== KEYWORD_ARTIFACT_SCHEMA_VERSION) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Unsupported keyword artifact schema version");
  }
  if (!input.taxonomyVersion.trim() || !input.keywordLexiconVersion.trim()) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Keyword artifact versions must not be empty");
  }
  if (!/^[0-9a-f]{64}$/.test(input.taxonomySha256)) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid taxonomy SHA-256");
  }
  const keywordEligibilityVersion = input.keywordEligibilityVersion ?? null;
  const keywordEligibilitySha256 = input.keywordEligibilitySha256 ?? null;
  if (
    (keywordEligibilityVersion === null) !== (keywordEligibilitySha256 === null)
    || (keywordEligibilityVersion !== null && keywordEligibilityVersion.length === 0)
    || (keywordEligibilitySha256 !== null && !/^[0-9a-f]{64}$/.test(keywordEligibilitySha256))
  ) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid keyword eligibility authority identity");
  }
  const tagIds = new Set<string>();
  const stableIds = new Set<string>();
  const keywordIds = new Set<string>();
  const tags = input.tags.map((rawTag) => {
    if (!rawTag.canonicalTagId || !rawTag.stableId || tagIds.has(rawTag.canonicalTagId) || stableIds.has(rawTag.stableId)) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "Duplicate or empty classifier Tag identity");
    }
    if (!Number.isSafeInteger(rawTag.textSelectionPriority) || rawTag.textSelectionPriority < 0) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid text selection priority");
    }
    tagIds.add(rawTag.canonicalTagId);
    stableIds.add(rawTag.stableId);
    const keywords = rawTag.keywords.map((rawKeyword) => {
      if (!rawKeyword.keywordId || keywordIds.has(rawKeyword.keywordId) || rawKeyword.value.length === 0) {
        throw new TaggingError("DATA_INVARIANT_VIOLATION", "Duplicate or empty keyword identity/value");
      }
      keywordIds.add(rawKeyword.keywordId);
      const scriptBuckets = strings(rawKeyword.scriptBuckets, "scriptBuckets") as TagKeywordScriptBucket[];
      if (scriptBuckets.some((bucket) => !TAG_KEYWORD_SCRIPT_BUCKETS.includes(bucket))) {
        throw new TaggingError("DATA_INVARIANT_VIOLATION", `Unsupported keyword script bucket: ${rawKeyword.keywordId}`);
      }
      if (!TAG_KEYWORD_MATCH_MODES.includes(rawKeyword.matchMode)) {
        throw new TaggingError("DATA_INVARIANT_VIOLATION", `Unsupported keyword match mode: ${rawKeyword.keywordId}`);
      }
      const resolvesCjk = rawKeyword.matchMode === "cjk_contiguous"
        || (rawKeyword.matchMode === "auto" && scriptBuckets.length === 1 && scriptBuckets[0] === "cjk");
      if (resolvesCjk && codePointLength(rawKeyword.value.normalize("NFC")) < 2) {
        throw new TaggingError("DATA_INVARIANT_VIOLATION", `CJK keyword is shorter than two code points: ${rawKeyword.keywordId}`);
      }
      const allowedFields = rawKeyword.allowedFields === undefined
        ? undefined
        : strings(rawKeyword.allowedFields, "allowedFields") as TagKeywordField[];
      if (allowedFields?.some((field) => field !== "title" && field !== "description")) {
        throw new TaggingError("DATA_INVARIANT_VIOLATION", `Unsupported keyword field: ${rawKeyword.keywordId}`);
      }
      return {
        keywordId: rawKeyword.keywordId,
        value: rawKeyword.value,
        scriptBuckets,
        matchMode: rawKeyword.matchMode,
        riskFlags: strings(rawKeyword.riskFlags, "riskFlags"),
        ...(allowedFields === undefined ? {} : { allowedFields }),
      };
    }).sort((left, right) => left.keywordId.localeCompare(right.keywordId, "en"));
    return {
      canonicalTagId: rawTag.canonicalTagId,
      stableId: rawTag.stableId,
      textSelectionPriority: rawTag.textSelectionPriority,
      keywords,
    };
  }).sort((left, right) => left.stableId.localeCompare(right.stableId, "en"));
  const payload = artifactPayload({
    ...input,
    keywordEligibilityVersion,
    keywordEligibilitySha256,
    tags,
  } as Omit<KeywordRuleArtifact, "keywordFingerprint">);
  const computed = fingerprint(payload);
  if (input.keywordFingerprint !== undefined && input.keywordFingerprint !== computed) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Keyword artifact fingerprint mismatch");
  }
  return Object.freeze({ ...payload, keywordFingerprint: computed });
}
