import type { LocaleMessages } from "./en";

/**
 * Arabic UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/ar.json` (e.g. `common.home`, `header.language`,
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
    home: "الرئيسية",
    browse: "جميع الأعمال",
    genres: "الأنواع",
    mainNav: "التنقل الرئيسي",
    footerNav: "تنقل التذييل",
    skipToContent: "تخطى إلى المحتوى الرئيسي",
    openMenu: "افتح القائمة",
    closeMenu: "أغلق القائمة",
    about: "حول الموقع",
    copyright: "المحتوى وحقوق النشر",
    footerNote: "يقدم هذا الموقع فصولاً مجانية للمعاينة. القصة الكاملة متوفرة على المنصة الأصلية.",
    language: "اللغة",
  },
  home: {
    works: "الأعمال",
    viewAll: "عرض الكل",
    featuredEyebrow: "مميز",
    startPreview: "ابدأ المعاينة",
    viewDetails: "عرض التفاصيل",
    carouselLabel: "الأعمال المميزة",
    carouselRole: "عرض دوّار",
    switchFeatured: "تبديل العمل المميز",
    slideLabel: "العمل {n}",
    slideStatus: "العمل {n} من {count}: {title}",
    chapterCount: "الفصول: {count}",
  },
  novel: {
    coverAlt: "غلاف {title}",
    tagsLabel: "العلامات",
    genreTags: "علامات النوع",
    chapterCount: "الفصول: {count}",
    previewCount: "فصول المعاينة: {count}",
    startPreview: "ابدأ المعاينة",
    readOnUpstream: "متابعة القراءة",
    synopsis: "القصة",
    previewChapters: "فصول المعاينة",
    previewChaptersDescription: "يوفر هذا الموقع {count} فصلاً للمعاينة، جميعها مقدَّمة من المنصة الأصلية.",
    noPreviewChapters: "لا توجد فصول معاينة لهذا الكتاب بعد.",
    relatedWorks: "أعمال ذات صلة",
    chapterHeading: "الفصل {number}",
  },
  chapter: {
    nav: "التنقل بين الفصول",
    previous: "الفصل السابق",
    next: "الفصل التالي",
    firstChapter: "هذا هو الفصل الأول",
    lastPreviewChapter: "هذا هو آخر فصل معاينة",
    heading: "الفصل {number}",
    readerSettings: "إعدادات القراءة",
    closeReaderSettings: "إغلاق إعدادات القراءة",
    previewPosition: "معاينة {index} / {total}",
    endOfPreview: "هذه نهاية المعاينة على هذا الموقع.",
    continuePrompt: "هل تريد متابعة القراءة؟",
    remainingOnOrigin: "الفصول التالية تُتابَع على المنصة الأصلية.",
    readOnUpstream: "متابعة القراءة",
    theme: "المظهر",
    fontSize: "حجم الخط",
    lineHeight: "تباعد الأسطر",
    measure: "عرض الصفحة",
    persistNote: "تُحفظ الإعدادات على هذا الجهاز ولا تتم مزامنتها بين الأجهزة.",
    resetDefaults: "إعادة الضبط الافتراضي",
    themeSystem: "مطابقة النظام",
    themeLight: "فاتح",
    themeDark: "داكن",
    lineHeightCompact: "مضغوط",
    lineHeightStandard: "قياسي",
    lineHeightRelaxed: "واسع",
    measureNarrow: "ضيق",
    measureStandard: "قياسي",
    measureWide: "عريض",
  },
  collection: {
    workCount: "الأعمال: {count}",
    empty: "لا توجد أعمال للقراءة هنا بعد.",
    allWorksTitle: "جميع الأعمال",
    allWorksDescription: "الأعمال المتاحة حاليًا للقراءة على هذا الموقع.",
    allWorksEmpty: "لا توجد أعمال متاحة للجميع بعد.",
    genreDescription: "أعمال يمكنك قراءتها في هذه المجموعة.",
    genreEmpty: "لا توجد أعمال في هذه المجموعة بعد.",
    categoryTitle: "روايات {name}",
    browseSeoDescription: "روايات منشورة.",
    categoryEmpty: "لا توجد روايات منشورة في هذه الفئة بعد.",
  },
  unavailable: {
    unpublishedTitle: "هذا الكتاب غير متاح مؤقتًا",
    unpublishedBody: "تمت إزالته من هذا الموقع. إذا عاد، سيظل هذا العنوان يعمل.",
    takedownTitle: "تم سحب هذا الكتاب",
    takedownBody: "بناءً على طلب صاحب الحقوق، لم يعد هذا الموقع يقدم هذا الكتاب. هذا السحب نهائي.",
    returnHome: "العودة إلى الرئيسية",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "مقالات وتحديثات من هذا الموقع.",
    empty: "لا توجد تدوينات بعد.",
    publishedOn: "نُشر في {date}",
    unpublishedTitle: "هذا المنشور غير متاح مؤقتًا",
    unpublishedBody: "تمت إزالته من هذا الموقع. إذا عاد، سيظل هذا العنوان يعمل.",
  },
  errorPage: {
    title: "حدث خطأ ما",
    body: "تعذر تحميل هذه الصفحة. يمكنك المحاولة مرة أخرى أو العودة إلى الرئيسية.",
    retry: "حاول مرة أخرى",
    digest: "معرّف الخطأ {digest}",
  },
  notFoundPage: {
    title: "تعذر العثور على هذه الصفحة",
    body: "قد يكون العنوان غير صحيح، أو أن هذه الصفحة لم تعد موجودة.",
  },
  pagination: {
    previous: "السابق",
    next: "التالي",
    pageOf: "{current} / {total}",
    label: "ترقيم الصفحات",
  },
  meta: {
    notFound: "غير موجود",
    chapterNotFound: "الفصل غير موجود",
    siteDescription: "موقع لتوزيع الروايات في الخارج",
  },
} satisfies LocaleMessages;

export default messages;
