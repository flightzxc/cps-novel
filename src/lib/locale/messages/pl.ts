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
 *  - ICU cardinal `plural` is allowed: `t()` renders every value through
 *    intl-messageformat (see `t()` in `src/lib/locale/messages/index.ts`),
 *    so `{count, plural, ...}` works alongside plain `{name}` substitution.
 *    Each plural block must cover exactly this locale's CLDR plural
 *    categories (no missing, no extra), and each branch spells out `{var}`
 *    instead of using `#`. Every other ICU form is banned (select,
 *    selectordinal, number/date/time, tags, `=N` exact-match branches,
 *    doubled apostrophes); `tests/ui/messages-completeness.test.ts` is the
 *    source of truth for these rules.
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
    // 运营前端与SEO优化第一轮 · C（Owner 2026-09-29 拍板）：去掉"ta
    // strona"/"oryginalna platforma"，按本站就是官方站点处理，按新英文
    // "New chapters are added regularly." 重新翻译。
    footerNote: "Nowe rozdziały są dodawane regularnie.",
    language: "Język",
  },
  home: {
    works: "Dzieła",
    viewAll: "Zobacz wszystko",
    featuredEyebrow: "Wyróżnione",
    // C: 去掉"przykład"（preview），按新英文"Start reading"重新翻译。
    startPreview: "Zacznij czytać",
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
    coverAlt: "{title}",
    tagsLabel: "Tagi",
    genreTags: "Tagi gatunku",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("pl") 实测；
    // other 为小数专用罕见分支，与 many 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} rozdział} few {{count} rozdziały} many {{count} rozdziałów} other {{count} rozdziałów}}",
    // C: 去掉"przykładowy"（preview），按新英文"{count} chapters
    // available"重新翻译；{count} 变量位置不变；分支与 chapterCount 的名词
    // 变形一致，other 与 many 同文（小数专用罕见分支）。
    previewCount:
      "{count, plural, one {{count} rozdział dostępny} few {{count} rozdziały dostępne} many {{count} rozdziałów dostępnych} other {{count} rozdziałów dostępnych}}",
    // C: 去掉"przykład"。
    startPreview: "Zacznij czytać",
    readOnUpstream: "Czytaj dalej",
    synopsis: "Opis fabuły",
    // C: 已停用（组件改用 chapterListTitle），按新英文"Chapters"重新翻译。
    previewChapters: "Rozdziały",
    // 施工工单_I18N_复数能力 §六.1/步骤 3 + C（本轮）：已停用（组件改用
    // chapterListCount）。按新英文"{count, plural, one {1 chapter free to
    // read now.} other {{count} chapters free to read now.}}"重新翻译，
    // 去掉"na tej stronie"/"oryginalną platformę"。
    previewChaptersDescription:
      "{count, plural, one {{count} rozdział dostępny do czytania za darmo już teraz.} few {{count} rozdziały dostępne do czytania za darmo już teraz.} many {{count} rozdziałów dostępnych do czytania za darmo już teraz.} other {{count} rozdziałów dostępnych do czytania za darmo już teraz.}}",
    // C: 已停用，按新英文"No chapters to read yet."重新翻译。
    noPreviewChapters: "Nie ma jeszcze rozdziałów do przeczytania.",
    relatedWorks: "Powiązane dzieła",
    chapterHeading: "Rozdział {number}",
    // A3/B2 新增键：章节列表区块标题，不使用"pełna lista/wszystkie
    // rozdziały"这类宣称完整性的措辞。
    chapterListTitle: "Lista rozdziałów",
    // A3/B2 新增键，ICU plural（pl: one/few/many/other，other 与 many 同文）。
    chapterListCount:
      "{count, plural, one {Łącznie {count} rozdział} few {Łącznie {count} rozdziały} many {Łącznie {count} rozdziałów} other {Łącznie {count} rozdziałów}}",
    lockedChapterHint: "Zablokowane — dotknij, aby kontynuować czytanie",
    // A3 新增键，ICU plural（pl: one/few/many/other），与 chapterCount 的
    // 名词变形一致。
    expandAllChapters:
      "Pokaż wszystkie {count, plural, one {{count} rozdział} few {{count} rozdziały} many {{count} rozdziałów} other {{count} rozdziałów}}",
    readMoreChapters: "Czytaj więcej rozdziałów",
    continueReadingModalTitle: "Kontynuuj czytanie",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"tutaj"（就在这里）。
    continueReadingModalBody: "Kontynuuj od rozdziału {number} i poznaj resztę historii.",
    closeDialog: "Zamknij",
    newReleases: "Nowości",
    continueReadingBarLabel: "Pasek kontynuacji czytania",
  },
  chapter: {
    nav: "Nawigacja po rozdziałach",
    previous: "Poprzedni rozdział",
    next: "Następny rozdział",
    firstChapter: "To jest pierwszy rozdział",
    // C: 去掉"przykładowy"，与上面 firstChapter 保持同一种句式。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"darmowy"（免费）。
    lastPreviewChapter: "To jest ostatni darmowy rozdział",
    heading: "Rozdział {number}",
    readerSettings: "Ustawienia czytania",
    closeReaderSettings: "Zamknij ustawienia czytania",
    // C: 去掉"Przykład"前缀，{index}/{total} 两个变量位置不变；用
    // "z"代替"/"以避免与英文原文字面完全相同（触发 leftover-English 门禁）。
    previewPosition: "{index} z {total}",
    // C: 去掉"przykładu"/"na tej stronie"。
    endOfPreview: "To wszystko, co jest teraz dostępne.",
    continuePrompt: "Chcesz czytać dalej?",
    // C: 去掉"oryginalnej platformie"。
    remainingOnOrigin: "Czytaj dalej, aby kontynuować historię.",
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
    // C: 去掉"na tej stronie"。
    allWorksDescription: "Dzieła obecnie dostępne do czytania.",
    allWorksEmpty: "Nie ma jeszcze publicznie dostępnych dzieł.",
    genreDescription: "Dzieła, które możesz przeczytać w tej kolekcji.",
    genreEmpty: "Nie ma jeszcze dzieł w tej kolekcji.",
    // 运营 2026-10-08（Owner 追加）：只用于 /browse?category= 的 <title>；与 categoryHeading 同值，
    // 让浏览页和分类页的标题形式一致（旧值 "Powieści {name}" 套短语型分类名会不通顺）。
    categoryTitle: "Powieści: {name}",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 旧 categoryTitle "Powieści {name}" 套短语名会变 "Powieści Dla czytelniczek"（句中大写），所以改成冒号隔开。
    categoryHeading: "Powieści: {name}",
    browseSeoDescription: "Opublikowane powieści.",
    categoryEmpty: "Nie ma jeszcze opublikowanych powieści w tej kategorii.",
  },
  unavailable: {
    unpublishedTitle: "Ta książka jest tymczasowo niedostępna",
    // C: 原两句去掉第一句里的"usunięta z tej strony"（"暂时不可用"已由
    // unpublishedTitle 承担），只保留地址持久性提示，沿用旧译文的第二句。
    unpublishedBody: "Jeśli powróci, ten adres nadal będzie działać.",
    takedownTitle: "Ta książka została wycofana",
    // C: 去掉"ta strona"，用"tutaj"（here）对应新英文"no longer offered
    // here"。
    takedownBody: "Na prośbę właściciela praw ta książka nie jest już tutaj oferowana.",
    returnHome: "Powrót do strony głównej",
  },
  blog: {
    listTitle: "Blog",
    // C: 去掉"z tej strony"。
    listDescription: "Artykuły i aktualności.",
    empty: "Nie ma jeszcze wpisów na blogu.",
    publishedOn: "Opublikowano {date}",
    unpublishedTitle: "Ten wpis jest tymczasowo niedostępny",
    // C: 同 unavailable.unpublishedBody 的理由。
    unpublishedBody: "Jeśli powróci, ten adres nadal będzie działać.",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：CPS v8.5.1 src/messages/pl.json:136 把语种自称直接放在“w języku”后，波兰语无法变格；
    // 按第三方验收（GPT，2026-09-30）+ Owner 拍板，改成与下面非书页句同一种写法“w języku „{locale}””，主语仍是“Ten tytuł”。
    fallbackToast: "Ten tytuł nie jest jeszcze dostępny w języku „{locale}”. Przełączono na stronę główną w języku „{locale}”.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Ta strona nie jest jeszcze dostępna w języku „{locale}”. Przełączono na stronę główną w języku „{locale}”.",
  },
  pagination: {
    previous: "Poprzednia",
    next: "Następna",
    pageOf: "{current} / {total}",
    label: "Paginacja",
  },
  search: {
    title: "Szukaj",
    submit: "Szukaj",
    // 第三方 GPT 验收（v0.5.14，Owner 2026-10-09 同意）：波兰语名词随数字变形——1 znak、2～4 znaki、5 及以上 znaków。
    // 最短长度常量 SITE_SEARCH_MIN_QUERY_LENGTH 现为 2，写死 "znaków" 会显示成错误的 "2 znaków"，故用 ICU plural
    // （t() 走 intl-messageformat，见 index.ts 的 t()；plural 规则见本文件头部 Discipline 段，chapterCount 等键早已用 plural）。
    // 分支 one/few/many/other 与 Intl.PluralRules("pl") 一致：other 是小数专用罕见分支（整数常量走不到），按语法给单数属格 "znaku"。
    hintMinLength: "Wpisz co najmniej {min, plural, one {{min} znak} few {{min} znaki} many {{min} znaków} other {{min} znaku}}, aby wyszukać.",
    hintMaxLength: "Wpisz maksymalnie {max, plural, one {{max} znak} few {{max} znaki} many {{max} znaków} other {{max} znaku}}.",
    resultsHeading: "Wyniki dla \"{query}\"",
    empty: "Brak wyników dla \"{query}\".",
    unavailable: "Wyszukiwanie jest chwilowo niedostępne. Spróbuj ponownie później.",
    metaTitle: "Wyniki wyszukiwania dla „{query}”",
    inputLabel: "Szukaj powieści według tytułu",
    inputPlaceholder: "Szukaj według tytułu książki…",
    idle: "Wpisz tytuł książki, aby rozpocząć wyszukiwanie.",
    emptyHint: "Spróbuj zamiast tego przeglądać wszystkie dzieła.",
    metaDescription: "Wyniki wyszukiwania dla „{query}” w serwisie PulseNovel. Odkrywaj powieści i zacznij czytać darmowe rozdziały.",
  },
  meta: {
    notFound: "Nie znaleziono",
    chapterNotFound: "Nie znaleziono rozdziału",
    // C: 去掉"przykładowe"（preview）。
    siteDescription: "Odkrywaj powieści i zacznij czytać darmowe rozdziały.",
    homeTitleFallback: "PulseNovel - odkrywaj powieści i czytaj książki za darmo",
    pageSuffix: " - strona {page}",
    // 运营 2026-10-08（Owner 追加）：分类名是短语时旧句 "Odkrywaj powieści z kategorii {name} na PulseNovel." 不通顺，用该语种的引号把分类名隔开。
    categoryDescriptionFallback: "Odkrywaj powieści z kategorii „{name}” na PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
