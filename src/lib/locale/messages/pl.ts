import type { LocaleMessages } from "./en";

/**
 * Polish UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/pl.json` (e.g. `common.home`, `header.language`,
 *    `sr.tagsLabel`) where CPS's own translation was actually translated
 *    (not itself an untranslated English residue — see the work order §5.3
 *    坑一 for the 15 cells that needed a fresh translation instead).
 *  - 乙 (adapted reuse, 44 keys): CPS drama/episode/watch copy reworded to
 *    novel/chapter/read.
 *  - 丙 (new, 43 keys): no CPS equivalent; translated fresh from the English
 *    source in `en.ts`, preserving every promise made there (free preview
 *    scope, copyright, takedown/removal wording) — see the work order §5.5
 *    丙档 for the list that needs business sign-off.
 *
 * Discipline (Owner 修正三 / 工单三 §10.2):
 *  - No ICU (`{var, plural, ...}` / `{var, select, ...}`) — `t()` only
 *    does `{name}` substitution (`src/lib/locale/messages/index.ts:105`).
 *    Count-bearing strings use plural-agnostic "Label: {count}" wording
 *    instead of a declined noun.
 *  - Interpolation variable names match the English source exactly.
 *  - Every value is non-empty (an empty string is treated as missing by
 *    `loadMessages`'s fallback merge, same as an absent key).
 */
const messages = {
  nav: {
    home: "Strona główna",
    browse: "Wszystkie dzieła",
    genres: "Gatunki",
    mainNav: "Nawigacja główna",
    footerNav: "Nawigacja w stopce",
    skipToContent: "Przejdź do treści głównej",
    openMenu: "Otwórz menu",
    closeMenu: "Zamknij menu",
    about: "O stronie",
    copyright: "Treść i prawa autorskie",
    footerNote: "Ta strona oferuje darmowe przykładowe rozdziały. Pełna historia jest dostępna na oryginalnej platformie.",
    language: "Język",
  },
  home: {
    works: "Dzieła",
    viewAll: "Zobacz wszystko",
    featuredEyebrow: "Wyróżnione",
    startPreview: "Rozpocznij przykład",
    viewDetails: "Zobacz szczegóły",
    carouselLabel: "Wyróżnione dzieła",
    carouselRole: "karuzela",
    switchFeatured: "Zmień wyróżnione dzieło",
    slideLabel: "Dzieło {n}",
    slideStatus: "Dzieło {n} z {count}: {title}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("pl") 实测；
    // other 为小数专用罕见分支，与 many 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} rozdział} few {{count} rozdziały} many {{count} rozdziałów} other {{count} rozdziałów}}",
  },
  novel: {
    coverAlt: "Okładka {title}",
    tagsLabel: "Tagi",
    genreTags: "Tagi gatunku",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("pl") 实测；
    // other 为小数专用罕见分支，与 many 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} rozdział} few {{count} rozdziały} many {{count} rozdziałów} other {{count} rozdziałów}}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other）。
    previewCount:
      "{count, plural, one {{count} przykładowy rozdział} few {{count} przykładowe rozdziały} many {{count} przykładowych rozdziałów} other {{count} przykładowych rozdziałów}}",
    startPreview: "Rozpocznij przykład",
    readOnUpstream: "Czytaj dalej",
    synopsis: "Opis fabuły",
    previewChapters: "Przykładowe rozdziały",
    // 施工工单_I18N_复数能力 §六.1/步骤 3: 承诺句，四档补全（one 分支沿用步骤 2
    // 折键时逐字保留的原文；few/many 为步骤 3 新译，other 与 many 同文——
    // 小数专用罕见分支，非漏翻译）。
    previewChaptersDescription:
      "{count, plural, one {1 przykładowy rozdział na tej stronie, dostarczony przez oryginalną platformę.} few {{count} przykładowe rozdziały na tej stronie, dostarczone przez oryginalną platformę.} many {{count} przykładowych rozdziałów na tej stronie, wszystkie dostarczone przez oryginalną platformę.} other {{count} przykładowych rozdziałów na tej stronie, wszystkie dostarczone przez oryginalną platformę.}}",
    noPreviewChapters: "Ta książka nie ma jeszcze przykładowych rozdziałów.",
    relatedWorks: "Powiązane dzieła",
    chapterHeading: "Rozdział {number}",
  },
  chapter: {
    nav: "Nawigacja po rozdziałach",
    previous: "Poprzedni rozdział",
    next: "Następny rozdział",
    firstChapter: "To jest pierwszy rozdział",
    lastPreviewChapter: "To jest ostatni przykładowy rozdział",
    heading: "Rozdział {number}",
    readerSettings: "Ustawienia czytania",
    closeReaderSettings: "Zamknij ustawienia czytania",
    previewPosition: "Przykład {index} / {total}",
    endOfPreview: "To koniec przykładu na tej stronie.",
    continuePrompt: "Chcesz czytać dalej?",
    remainingOnOrigin: "Kolejne rozdziały są kontynuowane na oryginalnej platformie.",
    readOnUpstream: "Czytaj dalej",
    theme: "Motyw",
    fontSize: "Rozmiar czcionki",
    lineHeight: "Odstęp między wierszami",
    measure: "Szerokość strony",
    persistNote: "Ustawienia są zapisywane na tym urządzeniu i nie synchronizują się między urządzeniami.",
    resetDefaults: "Przywróć ustawienia domyślne",
    themeSystem: "Zgodnie z systemem",
    themeLight: "Jasny",
    themeDark: "Ciemny",
    lineHeightCompact: "Wąski",
    lineHeightStandard: "Standardowy",
    lineHeightRelaxed: "Szeroki",
    measureNarrow: "Wąska",
    measureStandard: "Standardowa",
    measureWide: "Szeroka",
  },
  collection: {
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other）。
    workCount:
      "{count, plural, one {{count} dzieło} few {{count} dzieła} many {{count} dzieł} other {{count} dzieł}}",
    empty: "Nie ma tu jeszcze żadnych dzieł do przeczytania.",
    allWorksTitle: "Wszystkie dzieła",
    allWorksDescription: "Dzieła obecnie dostępne do czytania na tej stronie.",
    allWorksEmpty: "Nie ma jeszcze publicznie dostępnych dzieł.",
    genreDescription: "Dzieła, które możesz przeczytać w tej kolekcji.",
    genreEmpty: "Nie ma jeszcze dzieł w tej kolekcji.",
    categoryTitle: "Powieści {name}",
    browseSeoDescription: "Opublikowane powieści.",
    categoryEmpty: "Nie ma jeszcze opublikowanych powieści w tej kategorii.",
  },
  unavailable: {
    unpublishedTitle: "Ta książka jest tymczasowo niedostępna",
    unpublishedBody: "Została usunięta z tej strony. Jeśli powróci, ten adres nadal będzie działać.",
    takedownTitle: "Ta książka została wycofana",
    takedownBody: "Na prośbę właściciela praw ta strona nie oferuje już tej książki.",
    returnHome: "Powrót do strony głównej",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artykuły i aktualności z tej strony.",
    empty: "Nie ma jeszcze wpisów na blogu.",
    publishedOn: "Opublikowano {date}",
    unpublishedTitle: "Ten wpis jest tymczasowo niedostępny",
    unpublishedBody: "Został usunięty z tej strony. Jeśli powróci, ten adres nadal będzie działać.",
  },
  errorPage: {
    title: "Coś poszło nie tak",
    body: "Nie udało się wczytać tej strony. Możesz spróbować ponownie lub wrócić do strony głównej.",
    retry: "Spróbuj ponownie",
    digest: "ID błędu {digest}",
  },
  notFoundPage: {
    title: "Nie można znaleźć tej strony",
    body: "Adres może być nieprawidłowy albo ta strona już nie istnieje.",
  },
  pagination: {
    previous: "Poprzednia",
    next: "Następna",
    pageOf: "{current} / {total}",
    label: "Paginacja",
  },
  meta: {
    notFound: "Nie znaleziono",
    chapterNotFound: "Nie znaleziono rozdziału",
    siteDescription: "Odkryj powieści i czytaj przykładowe rozdziały.",
  },
} satisfies LocaleMessages;

export default messages;
