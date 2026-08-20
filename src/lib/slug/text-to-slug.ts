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
 * `SiteLocale` (`src/lib/locale/locale-canonical.ts`) is registered for 15
 * locales as of P0-S10, but `PUBLISHABLE_LOCALES` there is still empty and
 * the upstream language registry that drives `resolveSiteLocale` is still
 * empty too — there is no exercised call site in this round that would ever
 * route CJK/Thai/Arabic text through this module for a locale content can
 * actually publish under. Non-Latin scripts are preserved as their own
 * Unicode slug segments instead — the same fallback CPS itself uses for
 * "other" scripts, and exactly what a browser/HTTP stack percent-encodes at
 * the URL layer regardless. That keeps this module at zero new dependencies.
 * If/when a CJK-family (or Thai/Arabic) `SiteLocale` is ever added to
 * `PUBLISHABLE_LOCALES`, that is the natural point to evaluate a
 * transliteration/segmentation library for it — not preemptively here. See
 * `LOCALE_SEGMENTATION_RULES` below for the per-locale placeholder registry.
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
 * Per-`SiteLocale` segmentation rule registry. The `Record<SiteLocale, ...>`
 * type means registering a new `SiteLocale` in `locale-canonical.ts` without
 * adding a matching entry here fails `tsc` — the same "must consciously
 * extend" discipline `locale-canonical.ts` documents for its own registry.
 *
 * P0-S10 (2026-08-20): `locale-canonical.ts` expanded `SiteLocale` from 1
 * member (`en`) to 15 (aligned with CPS's 15-language site locale set), which
 * turned this `Record` into a `tsc` error (TS2740 — 14 keys missing). All 14
 * new locales are registered here as `"latin-word-segmentation"` too. This is
 * an **evaluated placeholder, not a verified per-script segmentation
 * strategy**:
 *
 * 1. `PUBLISHABLE_LOCALES` (`locale-canonical.ts`) is still empty — no
 *    non-`en` content can reach slug generation through any real call site
 *    in this round, so there is nothing to validate a different strategy
 *    against yet.
 * 2. The Latin-word-segmentation branch already degrades safely for non-Latin
 *    input: it preserves non-Latin Unicode runs as their own slug segment
 *    (see `latinWordSegmentedSlug` above) rather than mangling or dropping
 *    them, and whatever it produces still gets percent-encoded at the
 *    browser/HTTP layer like any other URL path segment. That is a usable,
 *    if generic, fallback — not a broken one.
 * 3. The locales that most need a real per-script segmentation policy
 *    (`ja`, `ko`, `zh-Hant`, `ar`, `th` at minimum — word-boundary rules for
 *    these scripts differ meaningfully from Latin) should get one evaluated
 *    at the point one of them actually enters `PUBLISHABLE_LOCALES`, because
 *    that is the first moment a real call site exists to verify the choice
 *    against. Guessing a strategy now, with nothing to exercise it, would be
 *    exactly the kind of unverified mapping `locale-canonical.ts` itself
 *    warns against for upstream language codes.
 *
 * Do not read the 14 new entries below as "Latin segmentation was evaluated
 * and chosen for Thai/Japanese/Arabic/etc." — it was not. It is a
 * placeholder registration that satisfies the exhaustiveness check while
 * those locales remain unpublishable, and it must be revisited (not
 * silently trusted) at each locale's publish-readiness review.
 */
const LOCALE_SEGMENTATION_RULES: Readonly<Record<SiteLocale, "latin-word-segmentation">> = Object.freeze({
  en: "latin-word-segmentation",
  es: "latin-word-segmentation",
  "pt-BR": "latin-word-segmentation",
  id: "latin-word-segmentation",
  vi: "latin-word-segmentation",
  th: "latin-word-segmentation",
  ja: "latin-word-segmentation",
  ko: "latin-word-segmentation",
  "zh-Hant": "latin-word-segmentation",
  ar: "latin-word-segmentation",
  fr: "latin-word-segmentation",
  de: "latin-word-segmentation",
  pl: "latin-word-segmentation",
  cs: "latin-word-segmentation",
  ru: "latin-word-segmentation",
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
