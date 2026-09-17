import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";

export type NovelMaterializationLocaleBlockCode = "missing_locale" | "unsupported_locale";

export type NovelMaterializationLocaleEligibility =
  | Readonly<{ eligible: true; locale: SiteLocale }>
  | Readonly<{ eligible: false; code: NovelMaterializationLocaleBlockCode }>;

/**
 * Pure, shared eligibility rule for turning a source item into a Novel.
 * Source facts are never guessed or normalized here: ingestion owns mapping,
 * and materialization accepts only an exact registered site locale.
 */
export function evaluateNovelMaterializationLocale(
  sourceLocale: string | null,
): NovelMaterializationLocaleEligibility {
  if (!sourceLocale?.trim()) return { eligible: false, code: "missing_locale" };
  if (!(SITE_LOCALES as readonly string[]).includes(sourceLocale)) {
    return { eligible: false, code: "unsupported_locale" };
  }
  return { eligible: true, locale: sourceLocale as SiteLocale };
}
