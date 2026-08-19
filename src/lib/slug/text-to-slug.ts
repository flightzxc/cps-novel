/**
 * Locale-aware text → slug generator, plus a minimum-length "health" check
 * for the generated base slug (P0-S4 content creation pipeline — the first
 * call site is `src/server/content-creation/service.ts`).
 *
 * Design borrows the *shape* of CPS's `textToSlug`
 * (`src/lib/slug-utils.ts:143-207`) — Latin text word-segmented (not
 * character-split), symbols treated purely as separators, and a
 * numeric-suffix-aware minimum-length health check — registered
 * `PATTERN_ONLY` in `docs/governance/port-registry.md`.
 *
 * Deliberately **not** ported: CPS's `pinyin-pro` Chinese-to-pinyin
 * transliteration branch (`shouldTransliterateChinese`/`pushChineseTokens`).
 * `SiteLocale` (`src/lib/locale/locale-canonical.ts`) has exactly one
 * registered member today (`"en"`), and the upstream language registry that
 * drives `resolveSiteLocale` is still empty — there is no exercised call
 * site in this round that would ever route CJK text through a Chinese-family
 * `SiteLocale`. Non-Latin scripts are preserved as their own Unicode slug
 * segments instead — the same fallback CPS itself uses for "other" scripts,
 * and exactly what a browser/HTTP stack percent-encodes at the URL layer
 * regardless. That keeps this module at zero new dependencies. If/when a
 * CJK-family `SiteLocale` is ever registered, that is the natural point to
 * evaluate a transliteration library — not preemptively here.
 */
import type { SiteLocale } from "@/lib/locale/locale-canonical";

const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const NUMBER_RE = /\p{N}/u;
const MARK_RE = /\p{M}/u;
const UNICODE_SLUG_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

/** Fallback when the input normalizes to nothing (e.g. all-punctuation title). Itself a healthy-length slug. */
const FALLBACK_SLUG = "untitled";

export const MIN_HEALTHY_SLUG_LENGTH = 5;

function isLatinWordChar(char: string, currentToken: string): boolean {
  return (
    LATIN_LETTER_RE.test(char)
    || NUMBER_RE.test(char)
    // A combining mark only continues an already-open Latin token — a mark
    // with no preceding base character falls through to the Unicode branch
    // below, same as CPS's original.
    || (currentToken.length > 0 && MARK_RE.test(char))
  );
}

function isUnicodeSlugChar(char: string): boolean {
  return UNICODE_SLUG_CHAR_RE.test(char);
}

function normalizeLatinToken(token: string): string {
  return token
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Script=Latin}\p{N}\p{M}]+/gu, "")
    .trim();
}

function pushLatinToken(tokens: string[], token: string): void {
  const normalized = normalizeLatinToken(token);
  if (normalized) tokens.push(normalized);
}

function pushUnicodeToken(tokens: string[], token: string): void {
  const normalized = token.trim().toLocaleLowerCase();
  if (normalized) tokens.push(normalized);
}

/** Latin-script word segmentation: letters/digits glue into a token, marks continue an open token, everything else is a separator. Non-Latin Unicode runs are preserved verbatim (lowercased) as their own token(s) rather than dropped or transliterated — see module header. */
function latinWordSegmentedSlug(text: string): string {
  const input = text.trim();
  if (!input) return FALLBACK_SLUG;

  const tokens: string[] = [];
  let latinToken = "";
  let unicodeToken = "";

  const flushLatin = () => {
    if (latinToken) {
      pushLatinToken(tokens, latinToken);
      latinToken = "";
    }
  };
  const flushUnicode = () => {
    if (unicodeToken) {
      pushUnicodeToken(tokens, unicodeToken);
      unicodeToken = "";
    }
  };

  for (const char of input) {
    // Apostrophes elide rather than split — "don't" -> "dont", not "don-t".
    if (char === "'" || char === "’") continue;

    if (isLatinWordChar(char, latinToken)) {
      flushUnicode();
      latinToken += char.toLocaleLowerCase();
      continue;
    }
    if (isUnicodeSlugChar(char)) {
      flushLatin();
      unicodeToken += char;
      continue;
    }
    flushLatin();
    flushUnicode();
  }
  flushLatin();
  flushUnicode();

  return tokens.join("-") || FALLBACK_SLUG;
}

/**
 * Per-`SiteLocale` segmentation rule registry. Today's single locale takes
 * the Latin word-segmentation branch. The `never`-typed default below means
 * registering a second `SiteLocale` in `locale-canonical.ts` without adding
 * a matching entry here fails `tsc`, not silently inherits Latin rules for a
 * script that may not want them — the same "must consciously extend"
 * discipline `locale-canonical.ts` itself documents for its own registry.
 */
const LOCALE_SEGMENTATION_RULES: Readonly<Record<SiteLocale, "latin-word-segmentation">> = Object.freeze({
  en: "latin-word-segmentation",
});

/**
 * Converts free text (e.g. a mirrored `NovelSourceItem.title`) into a
 * URL-safe slug for the given site locale. Pure and synchronous — never
 * touches the database, never guarantees uniqueness (see
 * `src/server/content-creation/service.ts`'s `resolveUniqueSlug` for the
 * conflict-suffix loop that sits on top of this).
 */
export function textToSlug(text: string, locale: SiteLocale): string {
  const rule = LOCALE_SEGMENTATION_RULES[locale];
  switch (rule) {
    case "latin-word-segmentation":
      return latinWordSegmentedSlug(text);
    default: {
      const exhaustive: never = rule;
      throw new Error(`textToSlug: no segmentation rule registered for locale ${String(exhaustive)}`);
    }
  }
}

function stripNumericSuffix(slug: string): string {
  return slug.replace(/-\d+$/, "");
}

/**
 * Health predicate for a generated base slug (conflict-resolution numeric
 * suffix ignored, so `"ab-2"` is judged on `"ab"`). A pure predicate, not a
 * throwing assertion — callers (the creation service) decide what refusing
 * an unhealthy slug means for their flow rather than this module dictating
 * control flow via an exception.
 */
export function isHealthySlug(slug: string, minLength: number = MIN_HEALTHY_SLUG_LENGTH): boolean {
  return stripNumericSuffix(slug.trim()).length >= minLength;
}
