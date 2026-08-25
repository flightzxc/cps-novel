/**
 * Breadcrumb i18n — localized navigation labels.
 *
 * Ported from CPS `src/lib/breadcrumb-i18n.ts` (d77c3b9). Extra locale
 * entries are kept even though V1 only calls this with `en`.
 *
 * Usage:
 *   import { getHomeName } from "@/lib/seo/breadcrumb-i18n";
 *   const homeName = getHomeName(novel.locale ?? "en");
 *
 * 🔴 P0-S14：这张表曾经是 `Record<string, string>` + `?? HOME_LABELS["en"]`
 * 的兜底写法——第 16 个 locale 加进 `SiteLocale` 时，这里不会报编译错，
 * 少一个 label 就会静默吐出英文 "Home"，经 JSON-LD `BreadcrumbList` 进公开
 * DOM。改成 `Record<SiteLocale, string>` 后，`SiteLocale` 一多一个成员，
 * 这张字面量对象就编译不过，逼着改动者当场把新 locale 的 label 补齐——
 * 和 U3 messages 目录「无 fallback，缺失即抛」的纪律对齐。
 */

import type { SiteLocale } from "@/lib/locale/locale-canonical";

const HOME_LABELS: Record<SiteLocale, string> = {
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

function isKnownHomeLabelLocale(value: string): value is SiteLocale {
  return Object.prototype.hasOwnProperty.call(HOME_LABELS, value);
}

/**
 * Get the localized name for the "Home" breadcrumb link.
 *
 * 🔴 No fallback. An unregistered locale throws instead of silently
 * rendering the English label into a non-English page's JSON-LD
 * `BreadcrumbList` — that silent substitution is exactly the shape of the
 * CPS v6.0.4 incident (a locale went live without its back-office copy
 * being registered, and nothing failed loudly until production).
 */
export function getHomeName(locale: string | null | undefined): string {
  const key = locale ?? "en";
  if (!isKnownHomeLabelLocale(key)) {
    throw new Error(
      `getHomeName: no breadcrumb "Home" label registered for locale "${key}". ` +
        "Register it in HOME_LABELS (src/lib/seo/breadcrumb-i18n.ts) — do not fall back to English.",
    );
  }
  return HOME_LABELS[key];
}
