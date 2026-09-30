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
    footerNote: "Es werden regelmäßig neue Kapitel hinzugefügt.",
    language: "Sprache",
  },
  home: {
    works: "Werke",
    viewAll: "Alle ansehen",
    featuredEyebrow: "Empfohlen",
    startPreview: "Lesen starten",
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
    previewCount: "{count} Kapitel verfügbar",
    startPreview: "Lesen starten",
    readOnUpstream: "Weiterlesen",
    synopsis: "Zusammenfassung",
    previewChapters: "Kapitel",
    // 施工工单_I18N_复数能力 §6.2 折键；de 只有 one/other 两档，折完即完整。
    // B 组翻译单（2026-09-29）按新英文原文重译。
    previewChaptersDescription:
      "{count, plural, one {1 Kapitel jetzt kostenlos lesbar.} other {{count} Kapitel jetzt kostenlos lesbar.}}",
    noPreviewChapters: "Für dieses Buch gibt es noch keine Kapitel zum Lesen.",
    relatedWorks: "Verwandte Werke",
    chapterHeading: "Kapitel {number}",
    // A3/A4/B1 新增键：B 组翻译单（2026-09-29）译入德语，替换英文占位。
    chapterListTitle: "Kapitelliste",
    chapterListCount: "{count, plural, one {1 Kapitel insgesamt} other {{count} Kapitel insgesamt}}",
    lockedChapterHint: "Gesperrt – tippen, um weiterzulesen",
    expandAllChapters: "Alle {count} Kapitel anzeigen",
    readMoreChapters: "Weitere Kapitel lesen",
    continueReadingModalTitle: "Weiterlesen",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译（与 de 其它文案一致用 du 称呼）；不再说"hier"（就在这里）。
    continueReadingModalBody: "Lies mit Kapitel {number} und dem Rest der Geschichte weiter.",
    closeDialog: "Schließen",
    newReleases: "Neuerscheinungen",
    continueReadingBarLabel: "Leiste zum Weiterlesen",
  },
  chapter: {
    nav: "Kapitelnavigation",
    previous: "Vorheriges Kapitel",
    next: "Nächstes Kapitel",
    firstChapter: "Dies ist das erste Kapitel",
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"kostenlose"（免费）。
    lastPreviewChapter: "Dies ist das letzte kostenlose Kapitel",
    heading: "Kapitel {number}",
    readerSettings: "Leseeinstellungen",
    closeReaderSettings: "Leseeinstellungen schließen",
    previewPosition: "{index} / {total}",
    endOfPreview: "Das ist im Moment alles, was verfügbar ist.",
    continuePrompt: "Möchtest du weiterlesen?",
    remainingOnOrigin: "Lies weiter, um die Geschichte fortzusetzen.",
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
    // Owner 拍板 2026-09-10: plural ICU (one/other), wording unchanged from
    // the prior bare translation — only the singular `Werk` branch is new.
    workCount: "{count, plural, one {Werk: {count}} other {Werke: {count}}}",
    empty: "Hier gibt es noch keine Werke zu lesen.",
    allWorksTitle: "Alle Werke",
    allWorksDescription: "Werke, die derzeit gelesen werden können.",
    allWorksEmpty: "Noch keine öffentlich verfügbaren Werke.",
    genreDescription: "Werke, die du in dieser Sammlung lesen kannst.",
    genreEmpty: "Noch keine Werke in dieser Sammlung.",
    categoryTitle: "{name}-Romane",
    browseSeoDescription: "Veröffentlichte Romane.",
    categoryEmpty: "Noch keine veröffentlichten Romane in dieser Kategorie.",
  },
  unavailable: {
    unpublishedTitle: "Dieses Buch ist vorübergehend nicht verfügbar",
    unpublishedBody: "Falls es zurückkehrt, funktioniert diese Adresse weiterhin.",
    takedownTitle: "Dieses Buch wurde zurückgezogen",
    takedownBody: "Auf Wunsch des Rechteinhabers wird dieses Buch hier nicht mehr angeboten.",
    returnHome: "Zurück zur Startseite",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artikel und Neuigkeiten.",
    empty: "Noch keine Blogbeiträge verfügbar.",
    publishedOn: "Veröffentlicht am {date}",
    unpublishedTitle: "Dieser Beitrag ist vorübergehend nicht verfügbar",
    unpublishedBody: "Falls er zurückkehrt, funktioniert diese Adresse weiterhin.",
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
  localeSwitcher: {
    fallbackToast: "Dieses Buch ist noch nicht auf {locale} verfügbar. Du wurdest zur {locale}-Startseite weitergeleitet.",
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
    siteDescription: "Entdecke Romane und lies kostenlose Kapitel.",
  },
} satisfies LocaleMessages;

export default messages;
