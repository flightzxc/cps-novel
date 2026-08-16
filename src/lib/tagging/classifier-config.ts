import { TaggingError } from "./contracts";

export const TAG_CLASSIFIER_PARAMETER_STATUS = "OWNER_REVIEW_PENDING" as const;
export const TAG_CLASSIFIER_TEXT_FIELDS = {
  strong: ["title"],
  weak: ["description"],
  excluded: ["author", "country", "region", "completionStatus", "sourceLanguageCode", "sourceLanguageName", "sourceLocale", "rawPayload", "chapters"],
} as const;

export interface TagClassifierConfig {
  titleWeight: number;
  descriptionWeight: number;
  threshold: number;
  maxTextTags: number;
  version: string;
  fingerprint: string;
}

export function loadTagClassifierConfig(): TagClassifierConfig {
  throw new TaggingError("CONFIG_NOT_READY");
}
