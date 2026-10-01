import b23Config from "./artifacts/classifier-config-b23-v1.json";
import laneCFinalConfig from "./artifacts/classifier-config-final.json";

import { TaggingError } from "./contracts";
import {
  descriptionBoilerplateFingerprint,
  loadDescriptionBoilerplateAuthority,
  type DescriptionBoilerplateAuthority,
} from "./description-boilerplate";
import {
  CURRENT_KEYWORD_ELIGIBILITY_SHA256,
  CURRENT_KEYWORD_ELIGIBILITY_VERSION,
} from "./keyword-eligibility";
import { CANONICAL_TAG_V1_SHA256 } from "./keyword-artifact";
import { fingerprint } from "./stable-json";

export const TAG_CLASSIFIER_PARAMETER_STATUS = "FROZEN" as const;
export const TAG_CLASSIFIER_TEXT_FIELDS = {
  strong: ["title"],
  weak: ["description"],
  excluded: ["author", "country", "region", "completionStatus", "sourceLanguageCode", "sourceLanguageName", "sourceLocale", "rawPayload", "chapters"],
} as const;

export interface TagClassifierConfig {
  status: "OWNER_REVIEW_PENDING" | "FROZEN";
  version: string;
  titleWeight: number | null;
  descriptionWeight: number | null;
  threshold: number | null;
  maxTextTags: number | null;
  fingerprint: string | null;
  /**
   * B-23. Absent (not null) on every config that predates it, so those
   * configs' fingerprints are unchanged. When present, a description that
   * matches the list is excluded from keyword matching (title unaffected).
   */
  descriptionBoilerplate?: DescriptionBoilerplateAuthority | null;
}

export interface FrozenTagClassifierConfig extends TagClassifierConfig {
  status: "FROZEN";
  titleWeight: number;
  descriptionWeight: number;
  threshold: number;
  maxTextTags: number;
  fingerprint: string;
}

function configPayload(config: Pick<FrozenTagClassifierConfig, "version" | "titleWeight" | "descriptionWeight" | "threshold" | "maxTextTags"> & {
  descriptionBoilerplate?: DescriptionBoilerplateAuthority | null;
}) {
  return {
    version: config.version,
    titleWeight: config.titleWeight,
    descriptionWeight: config.descriptionWeight,
    threshold: config.threshold,
    maxTextTags: config.maxTextTags,
    // Only present when the rule is on, so a config without it keeps the
    // exact payload (and therefore the exact fingerprint) it always had.
    ...(config.descriptionBoilerplate
      ? { descriptionBoilerplate: { version: config.descriptionBoilerplate.version, sha256: config.descriptionBoilerplate.sha256 } }
      : {}),
  };
}

export function createFrozenTagClassifierConfig(
  input: Omit<FrozenTagClassifierConfig, "status" | "fingerprint">,
): FrozenTagClassifierConfig {
  const payload = configPayload(input);
  return Object.freeze({ status: "FROZEN", ...input, fingerprint: fingerprint(payload) });
}

function productionConfigFromFinalAuthority(): FrozenTagClassifierConfig {
  const artifact = laneCFinalConfig;
  const parameters = artifact.text_parameters;
  if (
    artifact.status !== "FROZEN" || artifact.lane_status !== "FINAL" || parameters.status !== "FROZEN"
    || parameters.chapter_weight !== 0
    || artifact.keyword_eligibility_overlay.version !== CURRENT_KEYWORD_ELIGIBILITY_VERSION
    || artifact.keyword_eligibility_overlay.sha256 !== CURRENT_KEYWORD_ELIGIBILITY_SHA256
    || artifact.lineage.canonical_sha256 !== CANONICAL_TAG_V1_SHA256
    || artifact.auto_write_authorized !== "NO"
  ) {
    throw new TaggingError("CONFIG_NOT_READY", "Lane C Final classifier authority is inconsistent");
  }
  return createFrozenTagClassifierConfig({
    version: artifact.authoritative_run.run_id,
    titleWeight: parameters.title_weight,
    descriptionWeight: parameters.description_weight,
    threshold: parameters.threshold,
    maxTextTags: parameters.max_text_tags,
  });
}

/**
 * The config in force through v0.5.6 (Owner Final 2026-08-17). Kept as the
 * historical version and as the "rule off" state of B-23: production
 * classification with the boilerplate rule disabled is exactly this config.
 */
export const LEGACY_TAG_CLASSIFIER_CONFIG_V2: FrozenTagClassifierConfig = productionConfigFromFinalAuthority();

interface B23ConfigArtifact {
  status: string;
  version: string;
  extends: { artifact: string; version: string; fingerprint: string };
  description_boilerplate: { enabled: boolean; version: string; sha256: string };
  auto_write_authorized: string;
}

/** Resolves the production config from the B-23 artifact on top of the frozen Owner Final base. */
export function resolveProductionTagClassifierConfig(
  artifact: B23ConfigArtifact = b23Config,
  base: FrozenTagClassifierConfig = LEGACY_TAG_CLASSIFIER_CONFIG_V2,
): FrozenTagClassifierConfig {
  if (
    artifact.status !== "FROZEN"
    || artifact.extends.artifact !== "classifier-config-final.json"
    || artifact.extends.version !== base.version
    || artifact.extends.fingerprint !== base.fingerprint
    || artifact.auto_write_authorized !== "NO"
    || typeof artifact.version !== "string" || artifact.version.trim().length === 0
    || artifact.version === base.version
  ) {
    throw new TaggingError("CONFIG_NOT_READY", "B-23 classifier config is inconsistent with the Owner Final base");
  }
  const rule = artifact.description_boilerplate;
  if (!rule.enabled) return base;
  const authority = loadDescriptionBoilerplateAuthority(rule.version);
  if (authority.sha256 !== rule.sha256) {
    throw new TaggingError("CONFIG_NOT_READY", "Description boilerplate list does not match the pinned fingerprint");
  }
  return createFrozenTagClassifierConfig({
    version: artifact.version,
    titleWeight: base.titleWeight,
    descriptionWeight: base.descriptionWeight,
    threshold: base.threshold,
    maxTextTags: base.maxTextTags,
    descriptionBoilerplate: authority,
  });
}

export const PRODUCTION_TAG_CLASSIFIER_CONFIG: FrozenTagClassifierConfig = resolveProductionTagClassifierConfig();

export function loadTagClassifierConfig(
  configured: TagClassifierConfig = PRODUCTION_TAG_CLASSIFIER_CONFIG,
): FrozenTagClassifierConfig {
  if (configured.status !== "FROZEN") throw new TaggingError("CONFIG_NOT_READY");
  const values = [configured.titleWeight, configured.descriptionWeight, configured.threshold];
  if (values.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)) {
    throw new TaggingError("CONFIG_NOT_READY", "Classifier weights and threshold must be non-negative safe integers");
  }
  if (!Number.isSafeInteger(configured.maxTextTags) || Number(configured.maxTextTags) < 1) {
    throw new TaggingError("CONFIG_NOT_READY", "maxTextTags must be a positive safe integer");
  }
  if (!configured.version.trim() || configured.fingerprint === null) throw new TaggingError("CONFIG_NOT_READY");
  const frozen = configured as FrozenTagClassifierConfig;
  if (frozen.descriptionBoilerplate) {
    const { version, sha256, patterns } = frozen.descriptionBoilerplate;
    if (descriptionBoilerplateFingerprint(version, patterns) !== sha256) {
      throw new TaggingError("CONFIG_NOT_READY", "Description boilerplate fingerprint mismatch");
    }
  }
  if (fingerprint(configPayload(frozen)) !== frozen.fingerprint) {
    throw new TaggingError("CONFIG_NOT_READY", "Classifier config fingerprint mismatch");
  }
  return Object.freeze({ ...frozen });
}
