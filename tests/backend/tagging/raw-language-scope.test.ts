import { describe, expect, it } from "vitest";

import {
  rawJsonIdentity,
  rawLanguageIdentity,
  rawLanguageScopeFromPayload,
} from "@/lib/tagging/raw-language-scope";
import { loadTagClassifierConfig, TAG_CLASSIFIER_PARAMETER_STATUS, TAG_CLASSIFIER_TEXT_FIELDS } from "@/lib/tagging/classifier-config";

describe("RAW_LANGUAGE_SCOPE_V1", () => {
  it("preserves JSON type and exact value", () => {
    expect(rawJsonIdentity(2)).not.toBe(rawJsonIdentity("2"));
    expect(rawLanguageIdentity(" EN ", " English ")).not.toBe(rawLanguageIdentity("en", "English"));
    expect(rawLanguageIdentity("é")).not.toBe(rawLanguageIdentity("e\u0301"));
  });

  it("preserves missing, null, empty, and whitespace languageName", () => {
    const scopes = [
      rawLanguageScopeFromPayload({ language: 2 }),
      rawLanguageScopeFromPayload({ language: 2, languageName: null }),
      rawLanguageScopeFromPayload({ language: 2, languageName: "" }),
      rawLanguageScopeFromPayload({ language: 2, languageName: " " }),
    ];
    expect(new Set(scopes).size).toBe(4);
    expect(scopes.every((scope) => scope?.startsWith('["RAW_LANGUAGE_SCOPE_V1"'))).toBe(true);
  });

  it("fails closed when raw language identity is not reliably derivable", () => {
    expect(rawLanguageScopeFromPayload({ languageName: "English" })).toBeNull();
    expect(rawLanguageScopeFromPayload({ language: 2, languageName: 2 })).toBeNull();
    expect(rawLanguageScopeFromPayload(null)).toBeNull();
    expect(() => rawJsonIdentity(Number.NaN)).toThrow(/non-finite/);
  });
});

describe("Phase 1 classifier registration", () => {
  it("is fail-closed and excludes noisy/source metadata", async () => {
    expect(TAG_CLASSIFIER_PARAMETER_STATUS).toBe("OWNER_REVIEW_PENDING");
    expect(TAG_CLASSIFIER_TEXT_FIELDS.strong).toEqual(["title"]);
    expect(TAG_CLASSIFIER_TEXT_FIELDS.weak).toEqual(["description"]);
    expect(TAG_CLASSIFIER_TEXT_FIELDS.excluded).toContain("sourceLanguageCode");
    expect(TAG_CLASSIFIER_TEXT_FIELDS.excluded).toContain("chapters");
    expect(() => loadTagClassifierConfig()).toThrow(expect.objectContaining({ code: "CONFIG_NOT_READY" }));
  });
});
