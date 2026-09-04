import eligibilityV1 from "./artifacts/keyword-eligibility-v1.json";
import eligibilityV2 from "./artifacts/keyword-eligibility-v2.json";
import laneCFinalConfig from "./artifacts/classifier-config-final.json";

import { TaggingError } from "./contracts";
import type { ClassifierTagRule, TagKeywordField } from "./keyword-artifact";

export const KEYWORD_ELIGIBILITY_SHA256_BY_VERSION = Object.freeze({
  "keyword-eligibility-v1": "781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4",
  "keyword-eligibility-v2": laneCFinalConfig.keyword_eligibility_overlay.sha256,
} as const);

export type KeywordEligibilityVersion = keyof typeof KEYWORD_ELIGIBILITY_SHA256_BY_VERSION;
export const CURRENT_KEYWORD_ELIGIBILITY_VERSION: KeywordEligibilityVersion = "keyword-eligibility-v2";
export const CURRENT_KEYWORD_ELIGIBILITY_SHA256 = KEYWORD_ELIGIBILITY_SHA256_BY_VERSION[CURRENT_KEYWORD_ELIGIBILITY_VERSION];

interface RawEligibilityRule {
  canonical_tag_id?: unknown;
  normalized_seed?: unknown;
  enabled?: unknown;
  allowed_fields?: unknown;
  blocked_description_named_scopes?: unknown;
  reason?: unknown;
}

interface RawEligibilityArtifact {
  version?: unknown;
  schema_version?: unknown;
  rules?: unknown;
}

export interface KeywordEligibilityRule {
  canonicalTagId: string;
  normalizedSeed: string;
  enabled: boolean;
  allowedFields: readonly TagKeywordField[] | null;
  blockedDescriptionNamedScopes: readonly string[];
  reason: string;
}

export interface KeywordEligibilityAuthority {
  version: KeywordEligibilityVersion;
  sha256: string;
  rules: readonly KeywordEligibilityRule[];
}

const RAW_AUTHORITIES: Readonly<Record<KeywordEligibilityVersion, RawEligibilityArtifact>> = Object.freeze({
  "keyword-eligibility-v1": eligibilityV1,
  "keyword-eligibility-v2": eligibilityV2,
});

export function normalizeKeywordEligibilitySeed(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function ruleKey(canonicalTagId: string, normalizedSeed: string): string {
  return `${canonicalTagId}\n${normalizedSeed}`;
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `Invalid ${field} in keyword eligibility authority`);
  }
  return [...value];
}

export function loadKeywordEligibilityAuthority(
  version: KeywordEligibilityVersion = CURRENT_KEYWORD_ELIGIBILITY_VERSION,
): KeywordEligibilityAuthority {
  const raw = RAW_AUTHORITIES[version];
  if (!raw || raw.schema_version !== 1 || raw.version !== version || !Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `Invalid keyword eligibility authority: ${version}`);
  }
  const seen = new Set<string>();
  const rules = (raw.rules as RawEligibilityRule[]).map((rule) => {
    if (
      typeof rule.canonical_tag_id !== "string" || rule.canonical_tag_id.length === 0
      || typeof rule.normalized_seed !== "string" || rule.normalized_seed.length === 0
      || typeof rule.enabled !== "boolean" || typeof rule.reason !== "string" || rule.reason.length === 0
    ) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", `Invalid keyword eligibility rule in ${version}`);
    }
    const key = ruleKey(rule.canonical_tag_id, rule.normalized_seed);
    if (seen.has(key)) throw new TaggingError("DATA_INVARIANT_VIOLATION", `Duplicate keyword eligibility rule: ${key}`);
    seen.add(key);
    const allowedFields = rule.allowed_fields === undefined
      ? null
      : validateStringArray(rule.allowed_fields, "allowed_fields") as TagKeywordField[];
    if (allowedFields?.length === 0 || allowedFields?.some((field) => field !== "title" && field !== "description")) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "Production keyword eligibility only supports title/description");
    }
    const blockedDescriptionNamedScopes = rule.blocked_description_named_scopes === undefined
      ? []
      : validateStringArray(rule.blocked_description_named_scopes, "blocked_description_named_scopes");
    if (!rule.enabled && (allowedFields !== null || blockedDescriptionNamedScopes.length > 0)) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "Disabled keyword eligibility rule has restrictions");
    }
    return Object.freeze({
      canonicalTagId: rule.canonical_tag_id,
      normalizedSeed: rule.normalized_seed,
      enabled: rule.enabled,
      allowedFields: allowedFields === null ? null : Object.freeze(allowedFields),
      blockedDescriptionNamedScopes: Object.freeze(blockedDescriptionNamedScopes),
      reason: rule.reason,
    });
  });
  return Object.freeze({
    version,
    sha256: KEYWORD_ELIGIBILITY_SHA256_BY_VERSION[version],
    rules: Object.freeze(rules),
  });
}

export function applyKeywordEligibilityAuthority(
  tags: readonly ClassifierTagRule[],
  authority: KeywordEligibilityAuthority = loadKeywordEligibilityAuthority(),
  options: { requireEnabledRuleCoverage?: boolean } = {},
): ClassifierTagRule[] {
  if (authority.rules.some((rule) => rule.blockedDescriptionNamedScopes.length > 0)) {
    throw new TaggingError(
      "DATA_INVARIANT_VIOLATION",
      `${authority.version} contains retired locale-dependent rules and is reproduction-only`,
    );
  }
  const byKey = new Map(authority.rules.map((rule) => [ruleKey(rule.canonicalTagId, rule.normalizedSeed), rule]));
  const matchedRuleKeys = new Set<string>();
  const applied = tags.map((tag) => ({
    ...tag,
    keywords: tag.keywords.flatMap((keyword) => {
      const key = ruleKey(tag.stableId, normalizeKeywordEligibilitySeed(keyword.value));
      const rule = byKey.get(key);
      if (!rule) return [{ ...keyword }];
      matchedRuleKeys.add(key);
      if (!rule.enabled) return [];
      return [{ ...keyword, ...(rule.allowedFields === null ? {} : { allowedFields: [...rule.allowedFields] }) }];
    }),
  }));
  if (options.requireEnabledRuleCoverage) {
    const missing = authority.rules.filter((rule) => rule.enabled && !matchedRuleKeys.has(ruleKey(rule.canonicalTagId, rule.normalizedSeed)));
    if (missing.length > 0) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", `Keyword eligibility authority coverage is incomplete: ${missing.length}`);
    }
  }
  return applied;
}
