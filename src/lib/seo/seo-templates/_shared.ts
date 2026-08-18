/**
 * Shared SEO primitives for metadata templates.
 *
 * Ported from CPS `src/lib/seo-templates/_shared.ts` (d77c3b9).
 * PulseDrama brand constants and the CPS default domain are not ported.
 */

const OPEN_GRAPH_TAGS: Record<string, string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
  "zh-Hant": "zh_TW",
  ja: "ja_JP",
  ko: "ko_KR",
  es: "es_ES",
  fr: "fr_FR",
  de: "de_DE",
  pt: "pt_BR",
  "pt-BR": "pt_BR",
  it: "it_IT",
  ru: "ru_RU",
  ar: "ar_SA",
  th: "th_TH",
  vi: "vi_VN",
  id: "id_ID",
  ms: "ms_MY",
  tr: "tr_TR",
  pl: "pl_PL",
  cs: "cs_CZ",
  nl: "nl_NL",
};

// Single source (v0.2.0 integration): `src/lib/seo/site-url.ts` is the only
// implementation of getSiteUrl/SiteUrlConfigurationError in this repo, per the
// round's arbitration. This module re-exports for existing consumers; the
// former local duplicate (semantically identical) was removed as planned by
// the TODO it carried.
import { getSiteUrl, SiteUrlConfigurationError } from "@/lib/seo/site-url";

export { getSiteUrl, SiteUrlConfigurationError };

export function toAbsoluteUrl(path: ""): undefined;
export function toAbsoluteUrl(path: null | undefined): undefined;
export function toAbsoluteUrl(path: string): string;
export function toAbsoluteUrl(path: string | null | undefined): string | undefined;
export function toAbsoluteUrl(path: string | null | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getSiteUrl()}${normalizedPath}`;
}

/** Truncate text to maxLen, ending at word boundary with ellipsis. */
export function truncateDescription(text: string, maxLen = 155): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const last = cut.lastIndexOf(" ");
  return (last > maxLen * 0.6 ? cut.slice(0, last) : cut) + "…";
}

/** CPS `toOgLocale` renamed so it does not look like a second locale mapper. */
export function openGraphLocaleTag(locale: string): string {
  return OPEN_GRAPH_TAGS[locale] || "en_US";
}

/** Build absolute canonical URL for a path. */
export function buildCanonical(path: string): string {
  const siteUrl = getSiteUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl}${normalized}`;
}

/**
 * Build locale-aware absolute canonical URL.
 * `en` has no path prefix (localePrefix: "as-needed").
 * Other locales get /<locale>/ prefix. Root "/" becomes "/<locale>".
 */
export function buildLocaleCanonical(locale: string, path: string): string {
  const siteUrl = getSiteUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === "en") return `${siteUrl}${normalized}`;
  if (normalized === "/") return `${siteUrl}/${locale}`;
  return `${siteUrl}/${locale}${normalized}`;
}

/** Resolve OG image to absolute URL. Missing image + missing fallback fails closed. */
export function resolveOgImage(imageUrl?: string | null, fallback?: string | null): string {
  const resolved = toAbsoluteUrl(imageUrl ?? undefined) ?? toAbsoluteUrl(fallback ?? undefined);
  if (!resolved) {
    throw new Error("OG image is required: pass coverUrl or defaultOgImage");
  }
  return resolved;
}

/** Pagination pages are indexable by default; omit robots metadata. */
export function paginatedRobots(_pageNumber?: number) {
  void _pageNumber;
  return undefined;
}
