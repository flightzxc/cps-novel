import type { LocaleMessages } from "./en";

/**
 * German UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/de.json` (e.g. `common.home`, `header.language`,
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
    home: "Startseite",
    browse: "Alle Werke",
    genres: "Genre",
    mainNav: "Hauptnavigation",
    footerNav: "Fußzeilen-Navigation",
    skipToContent: "Zum Hauptinhalt springen",
    openMenu: "Menü öffnen",
    closeMenu: "Menü schließen",
    about: "Über uns",
    copyright: "Inhalt und Urheberrecht",
    footerNote: "Diese Website bietet kostenlose Vorschaukapitel. Die vollständige Geschichte findest du auf der Originalplattform.",
    language: "Sprache",
  },
  home: {
    works: "Werke",
    viewAll: "Alle ansehen",
    featuredEyebrow: "Empfohlen",
    startPreview: "Vorschau starten",
    viewDetails: "Details ansehen",
    carouselLabel: "Empfohlene Werke",
    carouselRole: "Karussell",
    switchFeatured: "Empfohlenes Werk wechseln",
    slideLabel: "Werk {n}",
    slideStatus: "Werk {n} von {count}: {title}",
    chapterCount: "Kapitel: {count}",
  },
  novel: {
    coverAlt: "Cover von {title}",
    tagsLabel: "Schlagwörter",
    genreTags: "Genre-Schlagwörter",
    chapterCount: "Kapitel: {count}",
    previewCount: "Vorschaukapitel: {count}",
    startPreview: "Vorschau starten",
    readOnUpstream: "Weiterlesen",
    synopsis: "Zusammenfassung",
    previewChapters: "Vorschaukapitel",
    previewChaptersDescription: "{count} Vorschaukapitel auf dieser Website, alle bereitgestellt von der Originalplattform.",
    previewChaptersDescriptionOne: "1 Vorschaukapitel auf dieser Website, bereitgestellt von der Originalplattform.",
    noPreviewChapters: "Für dieses Buch gibt es noch keine Vorschaukapitel.",
    relatedWorks: "Verwandte Werke",
    chapterHeading: "Kapitel {number}",
  },
  chapter: {
    nav: "Kapitelnavigation",
    previous: "Vorheriges Kapitel",
    next: "Nächstes Kapitel",
    firstChapter: "Dies ist das erste Kapitel",
    lastPreviewChapter: "Dies ist das letzte Vorschaukapitel",
    heading: "Kapitel {number}",
    readerSettings: "Leseeinstellungen",
    closeReaderSettings: "Leseeinstellungen schließen",
    previewPosition: "Vorschau {index} / {total}",
    endOfPreview: "Das ist das Ende der Vorschau auf dieser Website.",
    continuePrompt: "Möchtest du weiterlesen?",
    remainingOnOrigin: "Weitere Kapitel gibt es auf der Originalplattform.",
    readOnUpstream: "Weiterlesen",
    theme: "Design",
    fontSize: "Schriftgröße",
    lineHeight: "Zeilenabstand",
    measure: "Seitenbreite",
    persistNote: "Einstellungen werden auf diesem Gerät gespeichert und nicht geräteübergreifend synchronisiert.",
    resetDefaults: "Auf Standard zurücksetzen",
    themeSystem: "Systemeinstellung übernehmen",
    themeLight: "Hell",
    themeDark: "Dunkel",
    lineHeightCompact: "Kompakt",
    lineHeightStandard: "Normal",
    lineHeightRelaxed: "Weit",
    measureNarrow: "Schmal",
    measureStandard: "Normal",
    measureWide: "Breit",
  },
  collection: {
    workCount: "Werke: {count}",
    empty: "Hier gibt es noch keine Werke zu lesen.",
    allWorksTitle: "Alle Werke",
    allWorksDescription: "Werke, die derzeit auf dieser Website gelesen werden können.",
    allWorksEmpty: "Noch keine öffentlich verfügbaren Werke.",
    genreDescription: "Werke, die du in dieser Sammlung lesen kannst.",
    genreEmpty: "Noch keine Werke in dieser Sammlung.",
    categoryTitle: "{name}-Romane",
    browseSeoDescription: "Veröffentlichte Romane.",
    categoryEmpty: "Noch keine veröffentlichten Romane in dieser Kategorie.",
  },
  unavailable: {
    unpublishedTitle: "Dieses Buch ist vorübergehend nicht verfügbar",
    unpublishedBody: "Es wurde von dieser Website entfernt. Falls es zurückkehrt, funktioniert diese Adresse weiterhin.",
    takedownTitle: "Dieses Buch wurde zurückgezogen",
    takedownBody: "Auf Wunsch des Rechteinhabers bietet diese Website dieses Buch nicht mehr an. Dieser Rückzug ist endgültig.",
    returnHome: "Zurück zur Startseite",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artikel und Neuigkeiten von dieser Website.",
    empty: "Noch keine Blogbeiträge verfügbar.",
    publishedOn: "Veröffentlicht am {date}",
    unpublishedTitle: "Dieser Beitrag ist vorübergehend nicht verfügbar",
    unpublishedBody: "Er wurde von dieser Website entfernt. Falls er zurückkehrt, funktioniert diese Adresse weiterhin.",
  },
  errorPage: {
    title: "Etwas ist schiefgelaufen",
    body: "Diese Seite konnte nicht geladen werden. Du kannst es erneut versuchen oder zur Startseite zurückkehren.",
    retry: "Erneut versuchen",
    digest: "Fehler-ID {digest}",
  },
  notFoundPage: {
    title: "Diese Seite konnte nicht gefunden werden",
    body: "Die Adresse ist möglicherweise falsch, oder diese Seite existiert nicht mehr.",
  },
  pagination: {
    previous: "Zurück",
    next: "Weiter",
    pageOf: "{current} / {total}",
    label: "Seitennummerierung",
  },
  meta: {
    notFound: "Nicht gefunden",
    chapterNotFound: "Kapitel nicht gefunden",
    siteDescription: "Website für den internationalen Vertrieb von Romanen",
  },
} satisfies LocaleMessages;

export default messages;
