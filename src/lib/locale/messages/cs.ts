import type { LocaleMessages } from "./en";

/**
 * Czech UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/cs.json` (e.g. `common.home`, `header.language`,
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
    home: "Domů",
    browse: "Všechna díla",
    genres: "Žánry",
    mainNav: "Hlavní navigace",
    footerNav: "Navigace v zápatí",
    skipToContent: "Přeskočit na hlavní obsah",
    openMenu: "Otevřít menu",
    closeMenu: "Zavřít menu",
    about: "O webu",
    copyright: "Obsah a autorská práva",
    footerNote: "Tento web nabízí bezplatné ukázkové kapitoly. Celý příběh najdete na původní platformě.",
    language: "Jazyk",
  },
  home: {
    works: "Díla",
    viewAll: "Zobrazit vše",
    featuredEyebrow: "Doporučené",
    startPreview: "Spustit ukázku",
    viewDetails: "Zobrazit podrobnosti",
    carouselLabel: "Doporučená díla",
    carouselRole: "kolotoč",
    switchFeatured: "Přepnout doporučené dílo",
    slideLabel: "Dílo {n}",
    slideStatus: "Dílo {n} z {count}: {title}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("cs") 实测；
    // many 为小数专用罕见分支，与 few 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} kapitola} few {{count} kapitoly} many {{count} kapitoly} other {{count} kapitol}}",
  },
  novel: {
    coverAlt: "Obálka {title}",
    tagsLabel: "Tagy",
    genreTags: "Žánrové tagy",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("cs") 实测；
    // many 为小数专用罕见分支，与 few 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} kapitola} few {{count} kapitoly} many {{count} kapitoly} other {{count} kapitol}}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other）。
    previewCount:
      "{count, plural, one {{count} ukázková kapitola} few {{count} ukázkové kapitoly} many {{count} ukázkové kapitoly} other {{count} ukázkových kapitol}}",
    startPreview: "Spustit ukázku",
    readOnUpstream: "Pokračovat ve čtení",
    synopsis: "Synopse",
    previewChapters: "Ukázkové kapitoly",
    // 施工工单_I18N_复数能力 §六.1/步骤 3: 承诺句，四档补全（one 分支沿用步骤 2
    // 折键时逐字保留的原文；other 沿用步骤 2 已保留的旧 base 原文（属格复数，
    // 恰好是 cs 的 other 类别正确形态）；few 为步骤 3 新译，many 与 few 同文——
    // 小数专用罕见分支，非漏翻译）。
    previewChaptersDescription:
      "{count, plural, one {1 ukázková kapitola na tomto webu, poskytnutá původní platformou.} few {{count} ukázkové kapitoly na tomto webu, poskytnuté původní platformou.} many {{count} ukázkové kapitoly na tomto webu, poskytnuté původní platformou.} other {{count} ukázkových kapitol na tomto webu, všechny poskytnuté původní platformou.}}",
    noPreviewChapters: "Tato kniha zatím nemá žádné ukázkové kapitoly.",
    relatedWorks: "Související díla",
    chapterHeading: "Kapitola {number}",
  },
  chapter: {
    nav: "Navigace kapitolami",
    previous: "Předchozí kapitola",
    next: "Další kapitola",
    firstChapter: "Toto je první kapitola",
    lastPreviewChapter: "Toto je poslední ukázková kapitola",
    heading: "Kapitola {number}",
    readerSettings: "Nastavení čtení",
    closeReaderSettings: "Zavřít nastavení čtení",
    previewPosition: "Ukázka {index} / {total}",
    endOfPreview: "Zde ukázka na tomto webu končí.",
    continuePrompt: "Chcete pokračovat ve čtení?",
    remainingOnOrigin: "Další kapitoly pokračují na původní platformě.",
    readOnUpstream: "Pokračovat ve čtení",
    theme: "Motiv",
    fontSize: "Velikost písma",
    lineHeight: "Řádkování",
    measure: "Šířka stránky",
    persistNote: "Nastavení se ukládají na tomto zařízení a nesynchronizují se mezi zařízeními.",
    resetDefaults: "Obnovit výchozí nastavení",
    themeSystem: "Podle systému",
    themeLight: "Světlý",
    themeDark: "Tmavý",
    lineHeightCompact: "Kompaktní",
    lineHeightStandard: "Standardní",
    lineHeightRelaxed: "Volné",
    measureNarrow: "Úzká",
    measureStandard: "Standardní",
    measureWide: "Široká",
  },
  collection: {
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other）。
    workCount:
      "{count, plural, one {{count} dílo} few {{count} díla} many {{count} díla} other {{count} děl}}",
    empty: "Zatím zde nejsou žádná díla ke čtení.",
    allWorksTitle: "Všechna díla",
    allWorksDescription: "Díla, která lze na tomto webu aktuálně číst.",
    allWorksEmpty: "Zatím nejsou žádná veřejně dostupná díla.",
    genreDescription: "Díla, která si můžete v této kolekci přečíst.",
    genreEmpty: "V této kolekci zatím nejsou žádná díla.",
    categoryTitle: "Romány {name}",
    browseSeoDescription: "Publikované romány.",
    categoryEmpty: "V této kategorii zatím nejsou žádné publikované romány.",
  },
  unavailable: {
    unpublishedTitle: "Tato kniha je dočasně nedostupná",
    unpublishedBody: "Byla odstraněna z tohoto webu. Pokud se vrátí, tato adresa bude nadále fungovat.",
    takedownTitle: "Tato kniha byla stažena",
    takedownBody: "Na žádost držitele práv tento web tuto knihu již nenabízí. Toto stažení je trvalé.",
    returnHome: "Zpět domů",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Články a novinky z tohoto webu.",
    empty: "Zatím nejsou dostupné žádné blogové články.",
    publishedOn: "Publikováno {date}",
    unpublishedTitle: "Tento příspěvek je dočasně nedostupný",
    unpublishedBody: "Byl odstraněn z tohoto webu. Pokud se vrátí, tato adresa bude nadále fungovat.",
  },
  errorPage: {
    title: "Něco se pokazilo",
    body: "Tuto stránku se nepodařilo načíst. Můžete to zkusit znovu nebo se vrátit domů.",
    retry: "Zkusit znovu",
    digest: "ID chyby {digest}",
  },
  notFoundPage: {
    title: "Tuto stránku nelze najít",
    body: "Adresa může být chybná, nebo tato stránka již neexistuje.",
  },
  pagination: {
    previous: "Předchozí",
    next: "Další",
    pageOf: "{current} / {total}",
    label: "Stránkování",
  },
  meta: {
    notFound: "Nenalezeno",
    chapterNotFound: "Kapitola nenalezena",
    siteDescription: "Web pro distribuci románů v zahraničí",
  },
} satisfies LocaleMessages;

export default messages;
