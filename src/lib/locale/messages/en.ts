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
    footerNote:
      "This site offers free preview chapters. The full story is on the original platform.",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "Language",
  },
  home: {
    works: "Works",
    viewAll: "View all",
    featuredEyebrow: "Featured",
    startPreview: "Start preview",
    viewDetails: "View details",
    carouselLabel: "Featured works",
    carouselRole: "carousel",
    switchFeatured: "Switch featured work",
    slideLabel: "Work {n}",
    slideStatus: "Work {n} of {count}: {title}",
    chapterCount: "{count} chapters",
  },
  novel: {
    coverAlt: "Cover of {title}",
    tagsLabel: "Tags",
    genreTags: "Genre tags",
    chapterCount: "{count} chapters",
    previewCount: "{count} preview chapters",
    startPreview: "Start preview",
    readOnUpstream: "Continue reading",
    synopsis: "Synopsis",
    previewChapters: "Preview chapters",
    previewChaptersDescription:
      "{count} preview chapters on this site, all provided by the original platform.",
    /**
     * 低危清扫第 1 批 · item D-⑥: the count=1 case of
     * `previewChaptersDescription` above ("1 preview chapter**s**...") is a
     * plural-agreement defect — `t()` only does bare `{name}` substitution
     * (no ICU `plural`), so the sentence can't self-correct for a count of
     * exactly one the way `next-intl`'s ICU could. `PreviewChapterList.tsx`
     * only ever calls this description when `chapters.length > 0`, so
     * `chapters.length === 1` is the one case this key exists to cover;
     * `previewChaptersDescription` above still handles every count ≥ 2.
     * (CPS's own analogous key, `preview.previewSubtitle`, sidesteps the
     * whole problem by never stating a count at all — not an option here,
     * since the count itself is the promise this sentence makes.)
     */
    previewChaptersDescriptionOne: "1 preview chapter on this site, provided by the original platform.",
    noPreviewChapters: "This book has no preview chapters yet.",
    relatedWorks: "Related works",
    chapterHeading: "Chapter {number}",
  },
  chapter: {
    nav: "Chapter navigation",
    previous: "Previous chapter",
    next: "Next chapter",
    firstChapter: "This is the first chapter",
    lastPreviewChapter: "This is the last preview chapter",
    heading: "Chapter {number}",
    readerSettings: "Reading settings",
    closeReaderSettings: "Close reading settings",
    previewPosition: "Preview {index} / {total}",
    endOfPreview: "That's the end of the preview on this site.",
    continuePrompt: "Want to keep reading?",
    remainingOnOrigin: "Later chapters continue on the original platform.",
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
    workCount: "{count} works",
    empty: "No works to read here yet.",
    allWorksTitle: "All works",
    allWorksDescription: "Works currently available to read on this site.",
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
    browseSeoDescription: "Published novels.",
    categoryEmpty: "No published novels in this category.",
  },
  unavailable: {
    unpublishedTitle: "This book is temporarily unavailable",
    unpublishedBody:
      "It has been removed from this site. If it returns, this address will still work.",
    takedownTitle: "This book has been withdrawn",
    takedownBody:
      "At the rights holder's request, this site no longer offers this book. This withdrawal is permanent.",
    returnHome: "Back to home",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Articles and updates from this site.",
    empty: "No blog posts yet.",
    publishedOn: "Published {date}",
    unpublishedTitle: "This post is temporarily unavailable",
    unpublishedBody:
      "It has been removed from this site. If it returns, this address will still work.",
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
  pagination: {
    previous: "Previous",
    next: "Next",
    pageOf: "{current} / {total}",
    label: "Pagination",
  },
  meta: {
    notFound: "Not found",
    chapterNotFound: "Chapter not found",
    siteDescription: "Overseas novel distribution site",
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
