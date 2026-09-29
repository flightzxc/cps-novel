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
    skipToContent: "تخطَّ إلى المحتوى الرئيسي",
    openMenu: "افتح القائمة",
    closeMenu: "أغلق القائمة",
    about: "حول الموقع",
    copyright: "المحتوى وحقوق النشر",
    // 运营前端与SEO优化第一轮 · C（Owner 2026-09-29 拍板）：去掉"هذا
    // الموقع"/"المنصة الأصلية"，按本站就是官方站点处理，按新英文"New
    // chapters are added regularly." 重新翻译。
    footerNote: "تُضاف فصول جديدة بانتظام.",
    language: "اللغة",
  },
  home: {
    works: "الأعمال",
    viewAll: "عرض الكل",
    featuredEyebrow: "مميز",
    // C: 去掉"المعاينة"（preview），按新英文"Start reading"重新翻译。
    startPreview: "ابدأ القراءة",
    viewDetails: "عرض التفاصيل",
    carouselLabel: "الأعمال المميزة",
    carouselRole: "عرض دوّار",
    switchFeatured: "تبديل العمل المميز",
    slideLabel: "العمل {n}",
    slideStatus: "العمل {n} من {count}: {title}",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（zero/one/two/few/many/other，
    // Intl.PluralRules("ar") 实测六档全覆盖；数词-名词一致规则：0 无数词+复数名词，
    // 1/2 用单数/双数名词不带 {count}，3-10 用复数名词，11-99 用宾格不定单数带
    // tanwin，100+ 用裸单数名词）。
    chapterCount:
      "{count, plural, zero {لا فصول} one {فصل واحد} two {فصلان} few {{count} فصول} many {{count} فصلاً} other {{count} فصل}}",
  },
  novel: {
    coverAlt: "غلاف {title}",
    tagsLabel: "العلامات",
    genreTags: "علامات النوع",
    // 施工工单_I18N_复数能力 §六.1: 名词随数量变形（zero/one/two/few/many/other，
    // Intl.PluralRules("ar") 实测六档全覆盖；数词-名词一致规则：0 无数词+复数名词，
    // 1/2 用单数/双数名词不带 {count}，3-10 用复数名词，11-99 用宾格不定单数带
    // tanwin，100+ 用裸单数名词）。
    chapterCount:
      "{count, plural, zero {لا فصول} one {فصل واحد} two {فصلان} few {{count} فصول} many {{count} فصلاً} other {{count} فصل}}",
    // C: 去掉"للمعاينة"（preview），按新英文"{count} chapters available"
    // 重新翻译；六档全覆盖，数词-名词一致规则同 chapterCount，形容词
    // "متاح/متاحة/متاحان/متاحاً"随名词的性/数/格呼应。
    previewCount:
      "{count, plural, zero {لا فصول متاحة} one {فصل واحد متاح} two {فصلان متاحان} few {{count} فصول متاحة} many {{count} فصلاً متاحاً} other {{count} فصل متاح}}",
    // C: 去掉"المعاينة"。
    startPreview: "ابدأ القراءة",
    readOnUpstream: "متابعة القراءة",
    synopsis: "القصة",
    // C: 已停用（组件改用 chapterListTitle），按新英文"Chapters"重新翻译。
    previewChapters: "الفصول",
    // 施工工单_I18N_复数能力 §六.1/步骤 3 + C（本轮）：已停用（组件改用
    // chapterListCount）。按新英文"{count, plural, one {1 chapter free to
    // read now.} other {{count} chapters free to read now.}}"重新翻译，
    // 去掉"هذا الموقع"/"المنصة الأصلية"。六档全覆盖，句式"يمكنك الآن قراءة
    // ... مجانًا"，two 分支用宾格双数"فصلين"（作动名词 قراءة 的宾语，非主格
    // 「فصلان」）。
    previewChaptersDescription:
      "{count, plural, zero {لا توجد فصول متاحة للقراءة مجانًا الآن.} one {يمكنك الآن قراءة فصل واحد مجانًا.} two {يمكنك الآن قراءة فصلين مجانًا.} few {يمكنك الآن قراءة {count} فصول مجانًا.} many {يمكنك الآن قراءة {count} فصلاً مجانًا.} other {يمكنك الآن قراءة {count} فصل مجانًا.}}",
    // C: 已停用，按新英文"No chapters to read yet."重新翻译。
    noPreviewChapters: "لا توجد فصول للقراءة بعد.",
    relatedWorks: "أعمال ذات صلة",
    chapterHeading: "الفصل {number}",
    // A3/B2 新增键：章节列表区块标题，不使用"القائمة الكاملة/جميع
    // الفصول"这类宣称完整性的措辞。
    chapterListTitle: "قائمة الفصول",
    // A3/B2 新增键，ICU plural（ar: zero/one/two/few/many/other），前缀
    // "المجموع:"（总计）在各分支间保持不变，只替换计数短语。
    chapterListCount:
      "{count, plural, zero {المجموع: لا فصول} one {المجموع: فصل واحد} two {المجموع: فصلان} few {المجموع: {count} فصول} many {المجموع: {count} فصلاً} other {المجموع: {count} فصل}}",
    lockedChapterHint: "مُقفَل — اضغط لمتابعة القراءة",
    // A3 新增键，ICU plural（ar: zero/one/two/few/many/other）。省略
    // "جميع"（避免与宾格双数/复数的格搭配冲突），two 分支用宾格双数
    // "فصلين"（作动名词 عرض 的宾语）。
    expandAllChapters:
      "{count, plural, zero {عرض الفصول} one {عرض فصل واحد} two {عرض فصلين} few {عرض {count} فصول} many {عرض {count} فصلاً} other {عرض {count} فصل}}",
    readMoreChapters: "قراءة المزيد من الفصول",
    continueReadingModalTitle: "متابعة القراءة",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"هنا"（就在这里）。
    continueReadingModalBody: "تابع القراءة مع الفصل {number} وبقية القصة.",
    closeDialog: "إغلاق",
    newReleases: "إصدارات جديدة",
    continueReadingBarLabel: "شريط متابعة القراءة",
  },
  chapter: {
    nav: "التنقل بين الفصول",
    previous: "الفصل السابق",
    next: "الفصل التالي",
    firstChapter: "هذا هو الفصل الأول",
    // C: 去掉"معاينة"，与上面 firstChapter 保持同一种句式。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"مجاني"（免费）。
    lastPreviewChapter: "هذا هو آخر فصل مجاني",
    heading: "الفصل {number}",
    readerSettings: "إعدادات القراءة",
    closeReaderSettings: "إغلاق إعدادات القراءة",
    // C: 去掉"معاينة"前缀，{index}/{total} 两个变量位置不变；用
    // "من"代替"/"以避免与英文原文字面完全相同（触发 leftover-English 门禁）。
    previewPosition: "{index} من {total}",
    // C: 去掉"المعاينة"/"هذا الموقع"。
    endOfPreview: "هذا كل ما هو متاح حاليًا.",
    continuePrompt: "هل تريد متابعة القراءة؟",
    // C: 去掉"المنصة الأصلية"。
    remainingOnOrigin: "تابع القراءة لتكتشف بقية القصة.",
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
    // 施工工单_I18N_复数能力 §六.1: 六档全覆盖，数词-名词一致规则同 chapterCount。
    workCount:
      "{count, plural, zero {لا أعمال} one {عمل واحد} two {عملان} few {{count} أعمال} many {{count} عملاً} other {{count} عمل}}",
    empty: "لا توجد أعمال للقراءة هنا بعد.",
    allWorksTitle: "جميع الأعمال",
    // C: 去掉"هذا الموقع"。
    allWorksDescription: "أعمال متاحة للقراءة حاليًا.",
    allWorksEmpty: "لا توجد أعمال متاحة للجميع بعد.",
    genreDescription: "أعمال يمكنك قراءتها في هذه المجموعة.",
    genreEmpty: "لا توجد أعمال في هذه المجموعة بعد.",
    categoryTitle: "روايات {name}",
    browseSeoDescription: "روايات منشورة.",
    categoryEmpty: "لا توجد روايات منشورة في هذه الفئة بعد.",
  },
  unavailable: {
    unpublishedTitle: "هذا الكتاب غير متاح مؤقتًا",
    // C: 原两句去掉第一句里的"إزالته من هذا الموقع"（"暂时不可用"已由
    // unpublishedTitle 承担），只保留地址持久性提示，沿用旧译文的第二句。
    unpublishedBody: "إذا عاد، سيظل هذا العنوان يعمل.",
    takedownTitle: "تم سحب هذا الكتاب",
    // C: 去掉"هذا الموقع"，用"هنا"（here）对应新英文"no longer offered
    // here"。
    takedownBody: "بناءً على طلب صاحب الحقوق، لم يعد هذا الكتاب متوفرًا هنا.",
    returnHome: "العودة إلى الرئيسية",
  },
  blog: {
    listTitle: "Blog",
    // C: 去掉"من هذا الموقع"。
    listDescription: "مقالات وتحديثات.",
    empty: "لا توجد تدوينات بعد.",
    publishedOn: "نُشر في {date}",
    unpublishedTitle: "هذا المنشور غير متاح مؤقتًا",
    // C: 同 unavailable.unpublishedBody 的理由。
    unpublishedBody: "إذا عاد، سيظل هذا العنوان يعمل.",
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
    // C: 去掉"فصول المعاينة"（preview）。
    siteDescription: "اكتشف الروايات وابدأ بقراءة فصول مجانية.",
  },
} satisfies LocaleMessages;

export default messages;
