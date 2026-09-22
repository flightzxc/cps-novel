/**
 * Public CanonicalTag display-name resolver.
 *
 * Identity stays on `slug` / CanonicalTag id. This helper only picks a
 * human label. Public pages must not invent a second i18n table in
 * components — they render whatever this (or the matching SQL COALESCE)
 * returns.
 *
 * Fallback order is requested SITE_LOCALE → en → zh → slug. Empty or
 * whitespace-only translation rows are treated as missing so a blank
 * admin save cannot hide a later fallback. The function never throws.
 */
export function resolveCanonicalTagLabel(input: {
  requested?: string | null;
  en?: string | null;
  zh?: string | null;
  slug: string;
}): string {
  const pick = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return pick(input.requested) ?? pick(input.en) ?? pick(input.zh) ?? input.slug;
}
