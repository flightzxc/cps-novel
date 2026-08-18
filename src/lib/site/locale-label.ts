import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import type { LocaleBadge } from "@/features/public-ui/types";

export const PUBLIC_SITE_LOCALE: SiteLocale = "en";

export function asSiteLocale(value: string): SiteLocale | null {
  return (SITE_LOCALES as readonly string[]).includes(value) ? (value as SiteLocale) : null;
}

/** Display badge only — not a second locale mapping table. */
export function localeBadge(code: string): LocaleBadge {
  return { code, label: code === "en" ? "English" : code };
}
