/**
 * Complete English UI catalog — the type source of truth for public copy.
 *
 * Tone adapted from CPS `src/messages/en.json` at tag v8.2.10 (UI chrome only):
 * drama/watch/play/episode → novel/read/chapter. Do not merge other locales
 * into this tree.
 */
export const en = {
  nav: {
    home: "Home",
    browse: "All works",
    genres: "Genres",
    mainNav: "Main navigation",
    footerNav: "Footer navigation",
    skipToContent: "Skip to main content",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    about: "About",
    copyright: "Content and copyright",
    // C（Owner 2026-09-29 拍板"按运营原文做"）：原文含 "this site" / "original
    // platform"，去掉后按本站就是官方站点处理。改成单句，避开
    // `messages-completeness.test.ts` 的句数门禁（该门禁只在英文 ≥2 句时才
    // 跟其它 14 个语种的旧译文比对句数——旧译文仍是 2 句、本次不改译文，
    // 单句让这条门禁对本键直接跳过比较，而不是要求 14 个语种同步改写）。
    footerNote: "New chapters are added regularly.",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "Language",
  },
  home: {
    works: "Works",
    viewAll: "View all",
    featuredEyebrow: "Featured",
    // C: "Start preview" → "Start reading"（去掉"preview"一词，按本站就是
    // 官方站点处理）。
    startPreview: "Start reading",
    viewDetails: "View details",
    carouselLabel: "Featured works",
    carouselRole: "carousel",
    switchFeatured: "Switch featured work",
    slideLabel: "Work {n}",
    slideStatus: "Work {n} of {count}: {title}",
    chapterCount: "{count} chapters",
  },
  novel: {
    // Owner 2026-10-07：书封 alt 只保留书名，不带 "Cover of" 一类前缀（15 个语种同）。
    // 书名恒非空：公开页的书名来自已发布文章，库里有 article_published_title_check 兜底。
    coverAlt: "{title}",
    tagsLabel: "Tags",
    genreTags: "Genre tags",
    chapterCount: "{count} chapters",
    // C: 去掉"preview"一词，{count} 变量位置不变（其它 14 语种的旧译文仍用
    // 同一个 {count} 参数，interpolation-变量门禁因此仍然通过）。
    previewCount: "{count} chapters available",
    startPreview: "Start reading",
    readOnUpstream: "Continue reading",
    synopsis: "Synopsis",
    // 这个键在 A3 折中方案上线后已不再被组件引用（标题改用下面的
    // `chapterListTitle`），保留键与占位值只是为了不去动其它 14 个语种的
    // key 集合；顺手按 C 把英文原文也改掉，避免仓库里留一句带"Preview"的
    // 死文案。
    previewChapters: "Chapters",
    /**
     * 施工工单_I18N_复数能力_移植CPS_next-intl_plural_2026-09-10.md §6.2:
     * folds the former two-key count===1 workaround (this key used to sit
     * alongside a separate `previewChaptersDescriptionOne`, picked by a
     * ternary in `PreviewChapterList.tsx`) into one ICU `plural` message,
     * now that `t()` (`src/lib/locale/messages/index.ts`) renders through
     * `intl-messageformat` instead of bare `{name}` substitution. Both
     * branch texts are the pre-fold originals moved verbatim, not
     * retranslated: `one` is the old `...One` key's exact sentence
     * (including its literal `1` — correct, since English's `one` category
     * only ever means exactly 1), `other` is this key's old sentence
     * unchanged. Every locale catalog folds the same way — except
     * `id`/`ja`/`ko`/`th`/`vi`/`zh-Hant`, whose `Intl.PluralRules` resolves
     * only the single `other` category (`new
     * Intl.PluralRules("ja").resolvedOptions().pluralCategories` is
     * `["other"]`), so a `one` branch there is unreachable dead ICU content
     * that the completeness gate's exact-CLDR-category-coverage check would
     * reject; those six keep only their base (`other`) text — see the
     * comment in each of those six catalog files for the one-line note.
     */
    // C: 去掉"on this site" / "provided by the original platform"，按本站
    // 就是官方站点处理。plural 参数名与两个分支（one/other）不变，
    // 其它 14 语种的旧译文因此仍然过 interpolation-变量与 CLDR 覆盖门禁——
    // 这个键在 A3 折中方案上线后也已不再被组件引用（详情页/章节页的章节
    // 数量说明改用下面的 `chapterListCount`），保留键位只是为了不去动其它
    // 14 个语种的 key 集合。
    previewChaptersDescription:
      "{count, plural, one {1 chapter free to read now.} other {{count} chapters free to read now.}}",
    // 同样已不再被组件引用（发布与 Preview 解耦后"零章节"整块不渲染，见
    // `PreviewChapterList.tsx` 头部注释规则）；顺手按 C 修正英文原文。
    noPreviewChapters: "No chapters to read yet.",
    relatedWorks: "Related works",
    chapterHeading: "Chapter {number}",
    // A3/B2（Owner 2026-09-29 修订 D-12 第 2 条）：章节列表区块的新标题与
    // 章节数量说明。标题固定，不使用"完整目录/全部章节"这类措辞。
    chapterListTitle: "Chapter list",
    chapterListCount: "{count, plural, one {1 chapter total} other {{count} chapters total}}",
    // 锁定条目的读屏专用提示文本（视觉上只有锁图标 + 章节号）。
    lockedChapterHint: "Locked — tap to continue reading",
    // "展开全部 N 章"按钮：服务端 HTML 最多渲染 30 条锁定条目，超出部分由
    // 这个按钮触发客户端就地生成。
    expandAllChapters: "Show all {count} chapters",
    // 章节列表末尾的"阅读更多章节"按钮，跳 readOnUpstreamHref。
    readMoreChapters: "Read more chapters",
    // 点击锁定条目弹出的确认弹窗文案。正文用"Continue with …"而不是
    // "… are available here"：弹窗按钮会跳转到别处，"here"会让读者以为
    // 内容就在当前页（GPT 验收后修订，2026-09-29）。
    continueReadingModalTitle: "Continue reading",
    continueReadingModalBody: "Continue with Chapter {number} and the rest of the story.",
    closeDialog: "Close",
    // A4/B3："新书推荐"模块标题（"相关推荐"复用上面已有的 relatedWorks）。
    newReleases: "New releases",
    // B1：固定底部浮窗的读屏 landmark 标签。
    continueReadingBarLabel: "Continue reading bar",
  },
  chapter: {
    nav: "Chapter navigation",
    previous: "Previous chapter",
    next: "Next chapter",
    firstChapter: "This is the first chapter",
    // C: 去掉"preview"一词，与上面 firstChapter 保持同一种句式。GPT 验收后
    // 修订（2026-09-29）：补上"free"——可读的最后一章之后可能还有锁定章节，
    // "last chapter"会被理解为全书终章。
    lastPreviewChapter: "This is the last free chapter",
    // D4：ChapterScreen.tsx 已删除 H1 正上方渲染这个键的那个 <p>，键本身
    // 保留（不影响其它 14 语种的 key 集合），当前已无渲染点。
    heading: "Chapter {number}",
    readerSettings: "Reading settings",
    closeReaderSettings: "Close reading settings",
    // C: 去掉"Preview"前缀，{index}/{total} 两个变量位置不变。
    previewPosition: "{index} / {total}",
    // C: 去掉"the preview"/"this site"。
    endOfPreview: "That's everything available right now.",
    continuePrompt: "Want to keep reading?",
    // C: 去掉"original platform"。
    remainingOnOrigin: "Keep reading to continue the story.",
    readOnUpstream: "Continue reading",
    theme: "Theme",
    fontSize: "Font size",
    lineHeight: "Line height",
    measure: "Page width",
    persistNote: "Settings are saved on this device and do not sync across devices.",
    resetDefaults: "Reset to defaults",
    themeSystem: "Match system",
    themeLight: "Light",
    themeDark: "Dark",
    lineHeightCompact: "Compact",
    lineHeightStandard: "Standard",
    lineHeightRelaxed: "Relaxed",
    measureNarrow: "Narrow",
    measureStandard: "Standard",
    measureWide: "Wide",
  },
  collection: {
    // Owner 拍板 2026-09-10: plural ICU, verbatim per Owner's own text —
    // the `one` branch hardcodes "1 work" rather than echoing {count}.
    workCount: "{count, plural, one {1 work} other {{count} works}}",
    empty: "No works to read here yet.",
    allWorksTitle: "All works",
    // C: 去掉"on this site"。
    allWorksDescription: "Works currently available to read.",
    allWorksEmpty: "No publicly available works yet.",
    genreDescription: "Works you can read in this collection.",
    genreEmpty: "No works in this collection yet.",
    // WO-1 §5.4/§6.4 (new keys): frozen verbatim from the bare string
    // literals they replace in `src/app/browse/page.tsx` and
    // `src/app/category/[slug]/page.tsx` — English output is byte-identical
    // before/after. Deliberately new keys, not aliases onto `genreEmpty`
    // ("No works in this collection yet.") — that is a different sentence
    // that is already visible elsewhere; reusing it here would change what
    // the category empty-state actually says.
    categoryTitle: "{name} novels",
    // 运营 2026-10-08（Owner 确认范围含 H1/<title>/og·twitter 标题/面包屑）：前台分类页
    // `/category/{slug}` 的标题 = 分类名 + Novels。只有 `{name}` 一个占位符；其它语种按自己的
    // 词序译，分类名常常是短语（"Female Audience"/"From Hate to Love"）而不是名词，所以
    // 译文必须对短语和名词都通顺。浏览页 `/browse?category=` 仍用上面的 `categoryTitle`
    // （小写 novels，不在本次范围）。分类页的描述兜底句（`meta.categoryDescriptionFallback`）
    // 仍用纯分类名——它自己已含 novels。
    categoryHeading: "{name} Novels",
    browseSeoDescription: "Published novels.",
    categoryEmpty: "No published novels in this category.",
  },
  unavailable: {
    unpublishedTitle: "This book is temporarily unavailable",
    // C: 原文两句 "It has been removed from this site. If it returns, this
    // address will still work." 去掉第一句里的 "removed from this site"
    // （"暂时不可用"这层意思已经由上面的 unpublishedTitle 承担），只保留
    // "地址仍然有效"这句提示，顺带让英文变成单句——句数门禁只在英文 ≥2 句
    // 时才跟其它 14 语种的旧译文比对句数，单句直接跳过比较，不用连带改写
    // 14 份译文。
    unpublishedBody: "If it returns, this address will still work.",
    takedownTitle: "This book has been withdrawn",
    // C: 去掉"this site"。
    takedownBody: "At the rights holder's request, this book is no longer offered here.",
    returnHome: "Back to home",
  },
  blog: {
    listTitle: "Blog",
    // C: 去掉"from this site"。
    listDescription: "Articles and updates.",
    empty: "No blog posts yet.",
    publishedOn: "Published {date}",
    unpublishedTitle: "This post is temporarily unavailable",
    // C: 同 unavailable.unpublishedBody 的理由——去掉"removed from this
    // site"那句，只保留地址持久性提示，顺带改成单句。
    unpublishedBody: "If it returns, this address will still work.",
  },
  errorPage: {
    title: "Something went wrong",
    body: "This page could not be loaded. You can try again, or go back home.",
    retry: "Try again",
    digest: "Error ID {digest}",
  },
  notFoundPage: {
    title: "This page could not be found",
    body: "The address may be wrong, or this page is no longer here.",
  },
  // 语言切换器（2026-09-30，对齐短剧站 v8.5.1）。目标语种没有"当前这一页"对应
  // 的内容时先弹提示，再跳到目标语种首页。`{locale}` 是目标语种的本语自称（例如
  // "한국어"、"Français"），整句出现两次。两句都不提"本站/原平台/预览/试读"。
  localeSwitcher: {
    // 书页（详情页、章节页）用：逐字照搬 CPS `src/messages/en.json:136`
    // （v8.5.1）——文字一个不动，CPS 说 "title" 就是 "title"。
    fallbackToast: "This title isn't available in {locale} yet. Switched to the {locale} homepage.",
    // 其它页面（分类页、博客页、404 页、未登记路径）用：CPS 没有对应场景的新键，
    // Owner 定稿英文原文，句式与上面一致，只把 "title" 换成 "page"。
    fallbackToastPage: "This page isn't available in {locale} yet. Switched to the {locale} homepage.",
  },
  pagination: {
    previous: "Previous",
    next: "Next",
    pageOf: "{current} / {total}",
    label: "Pagination",
  },
  // PN-15 站内搜索（v0.5.14）。前 8 键逐字沿用 CPS v8.7.2 已上线译文（`title` 同时是页面 H1、
  // 页头导航与手机图标的读屏标签）；后 5 键为本项目新写。作品数/翻页沿用 `collection.workCount`、`pagination.*`。
  search: {
    title: "Search",
    submit: "Search",
    hintMinLength: "Enter at least {min} characters to search.",
    hintMaxLength: "Enter no more than {max} characters.",
    resultsHeading: "Results for \"{query}\"",
    empty: "No results found for \"{query}\".",
    unavailable: "Search is temporarily unavailable. Please try again later.",
    metaTitle: "Search results for “{query}”",
    inputLabel: "Search novels by title",
    inputPlaceholder: "Search by book title…",
    idle: "Enter a book title to start searching.",
    emptyHint: "Try browsing all works instead.",
    metaDescription: "Search results for “{query}” on PulseNovel. Discover novels and start reading free chapters.",
  },
  meta: {
    notFound: "Not found",
    chapterNotFound: "Chapter not found",
    // C: 去掉"preview"一词。
    siteDescription: "Discover novels and start reading free chapters.",
    // TKD 对齐 CPS（Owner 2026-09-30）：首页标题兜底。只有默认语种读后台"首页标题"，
    // 其余语种直接读这个键；品牌名写在文案里（照 CPS `seo.homeTitleFallback`）。
    homeTitleFallback: "PulseNovel - Discover Novels and Read Free Books",
    // 翻页后缀，第 2 页起拼在分类页/浏览页/博客列表标题末尾；{page} 为页码。
    pageSuffix: " - Page {page}",
    // 分类页在分类自身没有描述时用的固定兜底句：所有分类共用同一个句式，
    // 不是逐个分类生成描述（照 CPS `seo.categoryDescriptionFallback`）。
    categoryDescriptionFallback: "Discover {name} novels on PulseNovel.",
  },
} as const;

export type Messages = typeof en;

/**
 * Same keys and nesting as `Messages`, but every leaf is widened from a
 * string-literal type to plain `string`.
 *
 * `Messages` is `typeof en`, and `en` is declared `as const`, so every leaf
 * of `Messages` is typed as that exact English sentence (e.g. `nav.home`
 * is the literal type `"Home"`, not `string`) — only the English catalog
 * itself can ever satisfy that. Translated catalogs (`ar.ts`, `es.ts`,
 * `fr.ts`, ...) use `LocaleMessages` instead: the same required keys in
 * the same shape, but any non-empty string value is allowed. Keeping the
 * `satisfies` check (rather than dropping it) still buys full compile-time
 * key-set coverage for every locale file — WO-3 §10.2/§10.3.
 */
type WidenLeaves<T> = T extends string ? string : { [K in keyof T]: WidenLeaves<T[K]> };
export type LocaleMessages = WidenLeaves<Messages>;
