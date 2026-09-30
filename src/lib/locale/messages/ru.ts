import type { LocaleMessages } from "./en";

/**
 * Russian UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/ru.json` (e.g. `common.home`, `header.language`,
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
    home: "Главная",
    browse: "Все произведения",
    genres: "Жанры",
    mainNav: "Главная навигация",
    footerNav: "Навигация в подвале",
    skipToContent: "Перейти к основному содержимому",
    openMenu: "Открыть меню",
    closeMenu: "Закрыть меню",
    about: "О сайте",
    copyright: "Контент и авторские права",
    // 运营前端与SEO优化第一轮 · C（Owner 2026-09-29 拍板）：去掉"этот
    // сайт"/"оригинальная платформа"，按本站就是官方站点处理，按新英文
    // "New chapters are added regularly." 重新翻译。
    footerNote: "Новые главы публикуются регулярно.",
    language: "Язык",
  },
  home: {
    works: "Произведения",
    viewAll: "Смотреть все",
    featuredEyebrow: "Избранное",
    // C: 去掉"ознакомление/preview"，按新英文"Start reading"重新翻译。
    startPreview: "Начать чтение",
    viewDetails: "Подробнее",
    carouselLabel: "Избранные произведения",
    carouselRole: "карусель",
    switchFeatured: "Переключить избранное произведение",
    slideLabel: "Произведение {n}",
    slideStatus: "Произведение {n} из {count}: {title}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("ru") 实测）。
    chapterCount:
      "{count, plural, one {{count} глава} few {{count} главы} many {{count} глав} other {{count} главы}}",
  },
  novel: {
    coverAlt: "Обложка «{title}»",
    tagsLabel: "Теги",
    genreTags: "Теги жанра",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other，Intl.PluralRules("ru") 实测）。
    chapterCount:
      "{count, plural, one {{count} глава} few {{count} главы} many {{count} глав} other {{count} главы}}",
    // C: 去掉"ознакомительный"（preview），按新英文"{count} chapters
    // available"重新翻译；{count} 变量位置不变。ru 的 one 类别不止对应字面
    // 1（21/101/121 等也落在 one，Intl.PluralRules("ru").select(21) ===
    // "one"），one 分支用 {count} 而非硬编码「1」。
    previewCount:
      "{count, plural, one {{count} глава доступна} few {{count} главы доступны} many {{count} глав доступно} other {{count} главы доступны}}",
    // C: 去掉"ознакомление"，按新英文"Start reading"重新翻译。
    startPreview: "Начать чтение",
    readOnUpstream: "Продолжить чтение",
    synopsis: "Описание",
    // C: 已停用（组件改用 chapterListTitle），按新英文"Chapters"重新翻译。
    previewChapters: "Главы",
    // 施工工单_I18N_复数能力 §六.1/步骤 3 + C（本轮）：已停用（组件改用
    // chapterListCount）。按新英文"{count, plural, one {1 chapter free to
    // read now.} other {{count} chapters free to read now.}}"重新翻译，
    // 去掉"на этом сайте"/"оригинальной платформой"。one 分支用 {count}
    // 而非硬编码「1」（理由同上 previewCount）。
    previewChaptersDescription:
      "{count, plural, one {{count} глава доступна бесплатно прямо сейчас.} few {{count} главы доступны бесплатно прямо сейчас.} many {{count} глав доступно бесплатно прямо сейчас.} other {{count} главы доступны бесплатно прямо сейчас.}}",
    // C: 已停用，按新英文"No chapters to read yet."重新翻译。
    noPreviewChapters: "Пока нет глав для чтения.",
    relatedWorks: "Похожие произведения",
    chapterHeading: "Глава {number}",
    // A3/B2 新增键：章节列表区块标题，不使用"полный список/все главы"这类
    // 宣称完整性的措辞。
    chapterListTitle: "Список глав",
    // A3/B2 新增键，ICU plural（ru: one/few/many/other）。one 分支用
    // {count} 而非硬编码「1」（理由同上）。
    chapterListCount:
      "{count, plural, one {Всего {count} глава} few {Всего {count} главы} many {Всего {count} глав} other {Всего {count} главы}}",
    lockedChapterHint: "Заблокировано — нажмите, чтобы продолжить чтение",
    // A3 新增键，ICU plural（ru: one/few/many/other），与 chapterCount 的
    // 名词变形一致。
    expandAllChapters:
      "Показать все {count, plural, one {{count} главу} few {{count} главы} many {{count} глав} other {{count} главы}}",
    readMoreChapters: "Читать больше глав",
    continueReadingModalTitle: "Продолжить чтение",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"здесь"（就在这里）。
    continueReadingModalBody: "Продолжите чтение с главы {number} и до конца истории.",
    closeDialog: "Закрыть",
    newReleases: "Новинки",
    continueReadingBarLabel: "Панель продолжения чтения",
  },
  chapter: {
    nav: "Навигация по главам",
    previous: "Предыдущая глава",
    next: "Следующая глава",
    firstChapter: "Это первая глава",
    // C: 去掉"ознакомительная"，与上面 firstChapter 保持同一种句式。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"бесплатная"（免费）。
    lastPreviewChapter: "Это последняя бесплатная глава",
    heading: "Глава {number}",
    readerSettings: "Настройки чтения",
    closeReaderSettings: "Закрыть настройки чтения",
    // C: 去掉"Ознакомление"前缀，{index}/{total} 两个变量位置不变；用
    // "из"代替"/"以避免与英文原文字面完全相同（触发 leftover-English 门禁）。
    previewPosition: "{index} из {total}",
    // C: 去掉"ознакомительный фрагмент"/"на сайте"。
    endOfPreview: "Пока это всё, что доступно.",
    continuePrompt: "Хотите продолжить чтение?",
    // C: 去掉"оригинальной платформе"。
    remainingOnOrigin: "Читайте дальше, чтобы продолжить историю.",
    readOnUpstream: "Продолжить чтение",
    theme: "Тема",
    fontSize: "Размер шрифта",
    lineHeight: "Межстрочный интервал",
    measure: "Ширина страницы",
    persistNote: "Настройки сохраняются на этом устройстве и не синхронизируются между устройствами.",
    resetDefaults: "Сбросить настройки",
    themeSystem: "Как в системе",
    themeLight: "Светлая",
    themeDark: "Тёмная",
    lineHeightCompact: "Компактный",
    lineHeightStandard: "Стандартный",
    lineHeightRelaxed: "Свободный",
    measureNarrow: "Узкая",
    measureStandard: "Стандартная",
    measureWide: "Широкая",
  },
  collection: {
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（one/few/many/other）。
    workCount:
      "{count, plural, one {{count} произведение} few {{count} произведения} many {{count} произведений} other {{count} произведения}}",
    empty: "Здесь пока нет произведений для чтения.",
    allWorksTitle: "Все произведения",
    // C: 去掉"на этом сайте"。
    allWorksDescription: "Произведения, доступные для чтения.",
    allWorksEmpty: "Пока нет публично доступных произведений.",
    genreDescription: "Произведения, которые можно прочитать в этой подборке.",
    genreEmpty: "В этой подборке пока нет произведений.",
    categoryTitle: "Романы «{name}»",
    browseSeoDescription: "Опубликованные романы.",
    categoryEmpty: "В этой категории пока нет опубликованных романов.",
  },
  unavailable: {
    unpublishedTitle: "Эта книга временно недоступна",
    // C: 原两句去掉第一句里的"удалена с этого сайта"（"暂时不可用"已由
    // unpublishedTitle 承担），只保留地址持久性提示，沿用旧译文的第二句。
    unpublishedBody: "Если она вернётся, этот адрес продолжит работать.",
    takedownTitle: "Эта книга была отозвана",
    // C: 去掉"этот сайт"，用"здесь"（here）对应新英文"no longer offered
    // here"。
    takedownBody: "По запросу правообладателя эта книга больше не предлагается здесь.",
    returnHome: "Вернуться на главную",
  },
  blog: {
    listTitle: "Блог",
    // C: 去掉"этого сайта"。
    listDescription: "Статьи и новости.",
    empty: "Пока нет записей в блоге.",
    publishedOn: "Опубликовано {date}",
    unpublishedTitle: "Эта запись временно недоступна",
    // C: 同 unavailable.unpublishedBody 的理由。
    unpublishedBody: "Если она вернётся, этот адрес продолжит работать.",
  },
  errorPage: {
    title: "Что-то пошло не так",
    body: "Не удалось загрузить эту страницу. Вы можете попробовать снова или вернуться на главную.",
    retry: "Попробовать снова",
    digest: "ID ошибки {digest}",
  },
  notFoundPage: {
    title: "Эта страница не найдена",
    body: "Возможно, адрес неверен, или этой страницы больше не существует.",
  },
  pagination: {
    previous: "Назад",
    next: "Далее",
    pageOf: "{current} / {total}",
    label: "Постраничная навигация",
  },
  meta: {
    notFound: "Не найдено",
    chapterNotFound: "Глава не найдена",
    // C: 去掉"ознакомительные"（preview）。
    siteDescription: "Открывайте романы и начинайте читать бесплатные главы.",
    homeTitleFallback: "PulseNovel - открывайте романы и читайте книги бесплатно",
    pageSuffix: " - страница {page}",
    categoryDescriptionFallback: "Открывайте романы в категории «{name}» на PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
