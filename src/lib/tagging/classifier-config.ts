import { TaggingError } from "./contracts";
import { fingerprint } from "./stable-json";

export const TAG_CLASSIFIER_PARAMETER_STATUS = "OWNER_REVIEW_PENDING" as const;
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

export const PRODUCTION_TAG_CLASSIFIER_CONFIG: TagClassifierConfig = Object.freeze({
  status: TAG_CLASSIFIER_PARAMETER_STATUS,
  version: "p2-06-5-owner-review-pending",
  titleWeight: null,
  descriptionWeight: null,
  threshold: null,
  maxTextTags: null,
  fingerprint: null,
});

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
