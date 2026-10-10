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
    // 运营前端与SEO优化第一轮 · C（Owner 2026-09-29 拍板）：去掉"tento
    // web"/"původní platforma"，按本站就是官方站点处理，按新英文"New
    // chapters are added regularly." 重新翻译。
    footerNote: "Nové kapitoly přibývají pravidelně.",
    language: "Jazyk",
  },
  home: {
    works: "Díla",
    viewAll: "Zobrazit vše",
    featuredEyebrow: "Doporučené",
    // C: 去掉"ukázka"（preview），按新英文"Start reading"重新翻译。
    startPreview: "Začít číst",
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
    coverAlt: "{title}",
    tagsLabel: "Tagy",
    genreTags: "Žánrové tagy",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("cs") 实测；
    // many 为小数专用罕见分支，与 few 同文，非漏翻译）。
    chapterCount:
      "{count, plural, one {{count} kapitola} few {{count} kapitoly} many {{count} kapitoly} other {{count} kapitol}}",
    // C: 去掉"ukázková"（preview），按新英文"{count} chapters available"
    // 重新翻译；{count} 变量位置不变；分支与 chapterCount 的名词变形一致，
    // many 与 few 同文（小数专用罕见分支）。
    previewCount:
      "{count, plural, one {{count} kapitola dostupná} few {{count} kapitoly dostupné} many {{count} kapitoly dostupné} other {{count} kapitol dostupných}}",
    // C: 去掉"ukázku"。
    startPreview: "Začít číst",
    readOnUpstream: "Pokračovat ve čtení",
    synopsis: "Synopse",
    // C: 已停用（组件改用 chapterListTitle），按新英文"Chapters"重新翻译。
    previewChapters: "Kapitoly",
    // 施工工单_I18N_复数能力 §六.1/步骤 3 + C（本轮）：已停用（组件改用
    // chapterListCount）。按新英文"{count, plural, one {1 chapter free to
    // read now.} other {{count} chapters free to read now.}}"重新翻译，
    // 去掉"na tomto webu"/"původní platformou"。
    previewChaptersDescription:
      "{count, plural, one {{count} kapitola je nyní zdarma k přečtení.} few {{count} kapitoly jsou nyní zdarma k přečtení.} many {{count} kapitoly jsou nyní zdarma k přečtení.} other {{count} kapitol je nyní zdarma k přečtení.}}",
    // C: 已停用，按新英文"No chapters to read yet."重新翻译。
    noPreviewChapters: "Zatím zde nejsou žádné kapitoly ke čtení.",
    relatedWorks: "Související díla",
    chapterHeading: "Kapitola {number}",
    // A3/B2 新增键：章节列表区块标题，不使用"úplný seznam/všechny
    // kapitoly"这类宣称完整性的措辞。
    chapterListTitle: "Seznam kapitol",
    // A3/B2 新增键，ICU plural（cs: one/few/many/other，many 与 few 同文）。
    chapterListCount:
      "{count, plural, one {Celkem {count} kapitola} few {Celkem {count} kapitoly} many {Celkem {count} kapitoly} other {Celkem {count} kapitol}}",
    lockedChapterHint: "Uzamčeno — klepnutím budete pokračovat ve čtení",
    // A3 新增键，ICU plural（cs: one/few/many/other）。省略"všechny/všech"
    // （避免与后面数量名词的格搭配冲突），直接用"Zobrazit {count} kapitol"
    // 与 chapterCount 的名词变形一致。
    expandAllChapters:
      "Zobrazit {count, plural, one {{count} kapitolu} few {{count} kapitoly} many {{count} kapitoly} other {{count} kapitol}}",
    readMoreChapters: "Číst další kapitoly",
    continueReadingModalTitle: "Pokračovat ve čtení",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"zde"（就在这里）。
    continueReadingModalBody: "Pokračujte kapitolou {number} a zbytkem příběhu.",
    closeDialog: "Zavřít",
    newReleases: "Novinky",
    continueReadingBarLabel: "Panel pokračování čtení",
  },
  chapter: {
    nav: "Navigace kapitolami",
    previous: "Předchozí kapitola",
    next: "Další kapitola",
    firstChapter: "Toto je první kapitola",
    // C: 去掉"ukázková"，与上面 firstChapter 保持同一种句式。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"bezplatná"（免费）。
    lastPreviewChapter: "Toto je poslední bezplatná kapitola",
    heading: "Kapitola {number}",
    readerSettings: "Nastavení čtení",
    closeReaderSettings: "Zavřít nastavení čtení",
    // C: 去掉"Ukázka"前缀，{index}/{total} 两个变量位置不变；用
    // "z"代替"/"以避免与英文原文字面完全相同（触发 leftover-English 门禁）。
    previewPosition: "{index} z {total}",
    // C: 去掉"ukázka"/"na tomto webu"。
    endOfPreview: "To je prozatím vše, co je k dispozici.",
    continuePrompt: "Chcete pokračovat ve čtení?",
    // C: 去掉"původní platformě"。
    remainingOnOrigin: "Čtěte dál, abyste pokračovali v příběhu.",
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
    // C: 去掉"na tomto webu"。
    allWorksDescription: "Díla aktuálně dostupná ke čtení.",
    allWorksEmpty: "Zatím nejsou žádná veřejně dostupná díla.",
    genreDescription: "Díla, která si můžete v této kolekci přečíst.",
    genreEmpty: "V této kolekci zatím nejsou žádná díla.",
    // 运营 2026-10-08（Owner 追加）：只用于 /browse?category= 的 <title>；与 categoryHeading 同值，
    // 让浏览页和分类页的标题形式一致（旧值 "Romány {name}" 套短语型分类名会不通顺）。
    categoryTitle: "Romány: {name}",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 旧 categoryTitle "Romány {name}" 套短语名会变 "Romány Pro čtenářky"（句中大写），所以改成冒号隔开。
    categoryHeading: "Romány: {name}",
    browseSeoDescription: "Publikované romány.",
    categoryEmpty: "V této kategorii zatím nejsou žádné publikované romány.",
  },
  unavailable: {
    unpublishedTitle: "Tato kniha je dočasně nedostupná",
    // C: 原两句去掉第一句里的"odstraněna z tohoto webu"（"暂时不可用"已由
    // unpublishedTitle 承担），只保留地址持久性提示，沿用旧译文的第二句。
    unpublishedBody: "Pokud se vrátí, tato adresa bude nadále fungovat.",
    takedownTitle: "Tato kniha byla stažena",
    // C: 去掉"tento web"，用"zde"（here）对应新英文"no longer offered
    // here"。
    takedownBody: "Na žádost držitele práv už tato kniha zde není nabízena.",
    returnHome: "Zpět domů",
  },
  blog: {
    listTitle: "Blog",
    // C: 去掉"z tohoto webu"。
    listDescription: "Články a novinky.",
    empty: "Zatím nejsou dostupné žádné blogové články.",
    publishedOn: "Publikováno {date}",
    unpublishedTitle: "Tento příspěvek je dočasně nedostupný",
    // C: 同 unavailable.unpublishedBody 的理由。
    unpublishedBody: "Pokud se vrátí, tato adresa bude nadále fungovat.",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：CPS v8.5.1 src/messages/cs.json:136 把语种自称直接放在“v jazyce”后，捷克语无法变格；
    // 按第三方验收（GPT，2026-09-30）+ Owner 拍板，改成与下面非书页句同一种写法“v jazyce „{locale}“”，主语仍是“Tento titul”。
    fallbackToast: "Tento titul zatím není dostupný v jazyce „{locale}“. Zobrazena domovská stránka v jazyce „{locale}“.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Tato stránka zatím není dostupná v jazyce „{locale}“. Zobrazena domovská stránka v jazyce „{locale}“.",
  },
  pagination: {
    previous: "Předchozí",
    next: "Další",
    pageOf: "{current} / {total}",
    label: "Stránkování",
  },
  search: {
    title: "Hledat",
    submit: "Hledat",
    // 第三方 GPT 验收（v0.5.14，Owner 2026-10-09 同意）：捷克语名词随数字变形——1 znak、2～4 znaky、5 及以上 znaků。
    // 最短长度常量 SITE_SEARCH_MIN_QUERY_LENGTH 现为 2，写死 "znaků" 会显示成错误的 "2 znaků"，故用 ICU plural
    // （t() 走 intl-messageformat，见 index.ts:235；本文件头部"No ICU"的说明已过时，chapterCount 等键早已用 plural）。
    // 分支 one/few/many/other 与 Intl.PluralRules("cs") 一致：many 是小数专用罕见分支（整数常量走不到），按语法给单数属格 "znaku"。
    hintMinLength: "Zadejte alespoň {min, plural, one {{min} znak} few {{min} znaky} many {{min} znaku} other {{min} znaků}} pro vyhledávání.",
    hintMaxLength: "Zadejte nejvýše {max, plural, one {{max} znak} few {{max} znaky} many {{max} znaku} other {{max} znaků}}.",
    resultsHeading: "Výsledky pro „{query}“",
    empty: "Nebyly nalezeny žádné výsledky pro „{query}“.",
    unavailable: "Vyhledávání je dočasně nedostupné. Zkuste to prosím později.",
    metaTitle: "Výsledky hledání pro „{query}“",
    inputLabel: "Hledat romány podle názvu",
    inputPlaceholder: "Hledat podle názvu knihy…",
    idle: "Zadejte název knihy a začněte hledat.",
    emptyHint: "Zkuste místo toho procházet všechna díla.",
    metaDescription: "Výsledky hledání pro „{query}“ na PulseNovel. Objevujte romány a začněte číst bezplatné kapitoly.",
  },
  meta: {
    notFound: "Nenalezeno",
    chapterNotFound: "Kapitola nenalezena",
    // C: 去掉"ukázkové"（preview）。
    siteDescription: "Objevujte romány a začněte číst bezplatné kapitoly.",
    homeTitleFallback: "PulseNovel - objevujte romány a čtěte knihy zdarma",
    pageSuffix: " - Strana {page}",
    // 运营 2026-10-08（Owner 追加）：分类名是短语时旧句 "Objevujte romány {name} na PulseNovel." 不通顺，用该语种的引号把分类名隔开。
    categoryDescriptionFallback: "Objevujte romány z kategorie „{name}“ na PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
