import type { AutoTagCandidate } from "./contracts";
import type { FrozenTagClassifierConfig } from "./classifier-config";
import { detectDescriptionBoilerplate } from "./description-boilerplate";
import type {
  ClassifierTagRule,
  KeywordRuleArtifact,
  TagKeywordField,
  TagKeywordMatchMode,
  TagKeywordRule,
} from "./keyword-artifact";
import { codePointLength, sha256 } from "./stable-json";

export interface NovelClassifierInput {
  title: string;
  description?: string | null;
}

export interface TagClassifierResult {
  candidates: AutoTagCandidate[];
  rawEligibleCount: number;
  selectedCount: number;
  truncatedCount: number;
  /**
   * B-23. Present only when the config carries a description boilerplate
   * list, so a config without one produces exactly the result shape it always
   * did. `matched` means the description was recognised as publisher/reprint
   * front matter and took no part in keyword matching.
   */
  descriptionBoilerplate?: { matched: boolean; patternId: string | null };
}

interface KeywordMatch {
  keywordId: string;
  matchMode: Exclude<TagKeywordMatchMode, "auto">;
  start: number;
  end: number;
  riskFlags: string[];
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codePointOffset(value: string, codeUnitOffset: number): number {
  return Array.from(value.slice(0, codeUnitOffset)).length;
}

function resolvedMode(keyword: TagKeywordRule): Exclude<TagKeywordMatchMode, "auto"> | null {
  if (keyword.matchMode !== "auto") return keyword.matchMode;
  if (keyword.scriptBuckets.length !== 1) return null;
  if (keyword.scriptBuckets[0] === "latin") return "unicode_word";
  if (keyword.scriptBuckets[0] === "cjk") return "cjk_contiguous";
  return null;
}

export function findProductionKeywordMatch(value: string, keyword: TagKeywordRule): KeywordMatch | null {
  const text = value.normalize("NFC");
  const term = keyword.value.normalize("NFC");
  const mode = resolvedMode(keyword);
  if (!mode || term.length === 0) return null;
  let startCodeUnit = -1;
  let endCodeUnit = -1;
  if (mode === "unicode_word") {
    if (!keyword.scriptBuckets.includes("latin")) return null;
    const match = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escapedRegex(term)}(?![\\p{L}\\p{N}\\p{M}_])`, "iu").exec(text);
    if (!match || match.index === undefined) return null;
    startCodeUnit = match.index;
    endCodeUnit = match.index + match[0].length;
  } else {
    if (!keyword.scriptBuckets.includes("cjk") || codePointLength(term) < 2) return null;
    startCodeUnit = text.indexOf(term);
    if (startCodeUnit < 0) return null;
    endCodeUnit = startCodeUnit + term.length;
  }
  return {
    keywordId: keyword.keywordId,
    matchMode: mode,
    start: codePointOffset(text, startCodeUnit),
    end: codePointOffset(text, endCodeUnit),
    riskFlags: [...keyword.riskFlags],
  };
}

function fieldMatches(value: string, tag: ClassifierTagRule, field: TagKeywordField): KeywordMatch[] {
  return tag.keywords
    .filter((keyword) => keyword.allowedFields === undefined || keyword.allowedFields.includes(field))
    .map((keyword) => findProductionKeywordMatch(value, keyword))
    .filter((match): match is KeywordMatch => match !== null);
}

export function classifyNovelText(
  input: NovelClassifierInput,
  artifact: KeywordRuleArtifact,
  config: FrozenTagClassifierConfig,
): TagClassifierResult {
  const title = input.title ?? "";
  const description = input.description ?? "";
  // B-23: front-matter descriptions are not synopses. The field hash in the
  // evidence below still describes the real description; only the keyword
  // matching input is emptied. Titles are never touched.
  const boilerplate = config.descriptionBoilerplate
    ? detectDescriptionBoilerplate(description, config.descriptionBoilerplate)
    : null;
  const descriptionForMatching = boilerplate ? "" : description;
  const eligible = artifact.tags.flatMap((tag) => {
    const titleMatches = fieldMatches(title, tag, "title");
    const descriptionMatches = fieldMatches(descriptionForMatching, tag, "description");
    const titleScore = titleMatches.length > 0 ? config.titleWeight : 0;
    const descriptionScore = descriptionMatches.length > 0 ? config.descriptionWeight : 0;
    const score = titleScore + descriptionScore;
    if (score < config.threshold || (titleMatches.length === 0 && descriptionMatches.length === 0)) return [];
    const candidate: AutoTagCandidate & { stableId: string; textSelectionPriority: number } = {
      canonicalTagId: tag.canonicalTagId,
      stableId: tag.stableId,
      textSelectionPriority: tag.textSelectionPriority,
      score,
      evidence: {
        schemaVersion: 1,
        matchedFields: [
          ...(titleMatches.length > 0 ? ["title"] : []),
          ...(descriptionMatches.length > 0 ? ["description"] : []),
        ],
        fieldSha256: { title: sha256(title), description: sha256(description) },
        scoreBreakdown: { title: titleScore, description: descriptionScore, total: score },
        matches: {
          title: titleMatches.map((match) => ({ ...match })),
          description: descriptionMatches.map((match) => ({ ...match })),
        },
      },
    };
    return [candidate];
  }).sort((left, right) => (
    right.score - left.score
    || left.textSelectionPriority - right.textSelectionPriority
    || left.stableId.localeCompare(right.stableId, "en")
  ));
  const selected = eligible.slice(0, config.maxTextTags).map(({ canonicalTagId, score, evidence }) => ({
    canonicalTagId,
    score,
    evidence,
  }));
  return {
    candidates: selected,
    rawEligibleCount: eligible.length,
    selectedCount: selected.length,
    truncatedCount: Math.max(0, eligible.length - selected.length),
    ...(config.descriptionBoilerplate
      ? { descriptionBoilerplate: { matched: boilerplate !== null, patternId: boilerplate?.patternId ?? null } }
      : {}),
  };
}
