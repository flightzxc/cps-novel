/**
 * Breadcrumb i18n — localized navigation labels.
 *
 * Ported from CPS `src/lib/breadcrumb-i18n.ts` (d77c3b9). Extra locale
 * entries are kept even though V1 only calls this with `en`.
 *
 * Usage:
 *   import { getHomeName } from "@/lib/seo/breadcrumb-i18n";
 *   const homeName = getHomeName(novel.locale ?? "en");
 */

const HOME_LABELS: Record<string, string> = {
  en: "Home",
  es: "Inicio",
  "pt-BR": "Início",
  id: "Beranda",
  vi: "Trang chủ",
  th: "หน้าหลัก",
  ja: "ホーム",
  ko: "홈",
  "zh-Hant": "首頁",
  ar: "الرئيسية",
  fr: "Accueil",
  ru: "Главная",
  de: "Startseite",
  pl: "Strona główna",
  cs: "Domů",
};

/**
 * Get the localized name for the "Home" breadcrumb link.
 * Falls back to "Home" for unknown locales.
 */
export function getHomeName(locale: string | null | undefined): string {
  const key = locale ?? "en";
  return HOME_LABELS[key] ?? HOME_LABELS["en"];
}
