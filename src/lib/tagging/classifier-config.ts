import laneCFinalConfig from "../../../docs/p2/p2-06-5-lane-c/final/2026-08-17/classifier-config-final.json";

import { TaggingError } from "./contracts";
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
}

export interface FrozenTagClassifierConfig extends TagClassifierConfig {
  status: "FROZEN";
  titleWeight: number;
  descriptionWeight: number;
  threshold: number;
  maxTextTags: number;
  fingerprint: string;
}

function configPayload(config: Pick<FrozenTagClassifierConfig, "version" | "titleWeight" | "descriptionWeight" | "threshold" | "maxTextTags">) {
  return {
    version: config.version,
    titleWeight: config.titleWeight,
    descriptionWeight: config.descriptionWeight,
    threshold: config.threshold,
    maxTextTags: config.maxTextTags,
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

export const PRODUCTION_TAG_CLASSIFIER_CONFIG: FrozenTagClassifierConfig = productionConfigFromFinalAuthority();

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
  if (fingerprint(configPayload(frozen)) !== frozen.fingerprint) {
    throw new TaggingError("CONFIG_NOT_READY", "Classifier config fingerprint mismatch");
  }
  return Object.freeze({ ...frozen });
}
