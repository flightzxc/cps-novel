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
    footerNote: "На этом сайте доступны бесплатные главы для ознакомления. Полная история — на оригинальной платформе.",
    language: "Язык",
  },
  home: {
    works: "Произведения",
    viewAll: "Смотреть все",
    featuredEyebrow: "Избранное",
    startPreview: "Начать ознакомление",
    viewDetails: "Подробнее",
    carouselLabel: "Избранные произведения",
    carouselRole: "карусель",
    switchFeatured: "Переключить избранное произведение",
    slideLabel: "Произведение {n}",
    slideStatus: "Произведение {n} из {count}: {title}",
    chapterCount: "Глав: {count}",
  },
  novel: {
    coverAlt: "Обложка «{title}»",
    tagsLabel: "Теги",
    genreTags: "Теги жанра",
    chapterCount: "Глав: {count}",
    previewCount: "Ознакомительных глав: {count}",
    startPreview: "Начать ознакомление",
    readOnUpstream: "Продолжить чтение",
    synopsis: "Описание",
    previewChapters: "Ознакомительные главы",
    previewChaptersDescription: "{count} ознакомительных глав на этом сайте — все предоставлены оригинальной платформой.",
    noPreviewChapters: "У этой книги пока нет ознакомительных глав.",
    relatedWorks: "Похожие произведения",
    chapterHeading: "Глава {number}",
  },
  chapter: {
    nav: "Навигация по главам",
    previous: "Предыдущая глава",
    next: "Следующая глава",
    firstChapter: "Это первая глава",
    lastPreviewChapter: "Это последняя ознакомительная глава",
    heading: "Глава {number}",
    readerSettings: "Настройки чтения",
    closeReaderSettings: "Закрыть настройки чтения",
    previewPosition: "Ознакомление {index} / {total}",
    endOfPreview: "На этом ознакомительный фрагмент на сайте заканчивается.",
    continuePrompt: "Хотите продолжить чтение?",
    remainingOnOrigin: "Следующие главы продолжаются на оригинальной платформе.",
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
    workCount: "Произведений: {count}",
    empty: "Здесь пока нет произведений для чтения.",
    allWorksTitle: "Все произведения",
    allWorksDescription: "Произведения, доступные для чтения на этом сайте сейчас.",
    allWorksEmpty: "Пока нет публично доступных произведений.",
    genreDescription: "Произведения, которые можно прочитать в этой подборке.",
    genreEmpty: "В этой подборке пока нет произведений.",
    categoryTitle: "Романы «{name}»",
    browseSeoDescription: "Опубликованные романы.",
    categoryEmpty: "В этой категории пока нет опубликованных романов.",
  },
  unavailable: {
    unpublishedTitle: "Эта книга временно недоступна",
    unpublishedBody: "Она была удалена с этого сайта. Если она вернётся, этот адрес продолжит работать.",
    takedownTitle: "Эта книга была отозвана",
    takedownBody: "По запросу правообладателя этот сайт больше не предлагает эту книгу. Это удаление окончательное.",
    returnHome: "Вернуться на главную",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Статьи и новости этого сайта.",
    empty: "Пока нет записей в блоге.",
    publishedOn: "Опубликовано {date}",
    unpublishedTitle: "Эта запись временно недоступна",
    unpublishedBody: "Она была удалена с этого сайта. Если она вернётся, этот адрес продолжит работать.",
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
    siteDescription: "Сайт зарубежного распространения романов",
  },
} satisfies LocaleMessages;

export default messages;
