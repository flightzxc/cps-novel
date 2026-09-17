import type { LocaleMessages } from "./en";

/**
 * Traditional Chinese UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/zh-Hant.json` (e.g. `common.home`, `header.language`,
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
    home: "首頁",
    browse: "全部作品",
    genres: "類型",
    mainNav: "主導覽",
    footerNav: "頁尾導覽",
    skipToContent: "跳至主要內容",
    openMenu: "開啟選單",
    closeMenu: "關閉選單",
    about: "關於我們",
    copyright: "內容與著作權",
    footerNote: "本站提供免費試讀章節,完整故事請前往原始平台閱讀。",
    language: "語言",
  },
  home: {
    works: "作品",
    viewAll: "查看全部",
    featuredEyebrow: "精選",
    startPreview: "開始試讀",
    viewDetails: "查看詳情",
    carouselLabel: "精選作品",
    carouselRole: "輪播",
    switchFeatured: "切換精選作品",
    slideLabel: "作品 {n}",
    slideStatus: "作品 {n} / {count}：{title}",
    chapterCount: "共{count}章",
  },
  novel: {
    coverAlt: "《{title}》封面",
    tagsLabel: "標籤",
    genreTags: "類型標籤",
    chapterCount: "共{count}章",
    previewCount: "試讀{count}章",
    startPreview: "開始試讀",
    readOnUpstream: "繼續閱讀",
    synopsis: "劇情簡介",
    previewChapters: "試讀章節",
    // 施工工单_I18N_复数能力 §6.2 折键：zh-Hant 的 Intl.PluralRules 只解出 other
    // 一档（no one category），one 分支在 zh-Hant 永远选不中，会被门禁的 CLDR
    // 类别覆盖检查判为多余分支——因此这里只保留原 previewChaptersDescription
    // 一句（已含 {count}，任意数量下都语法正确），原 …One 的单数措辞变体停用，
    // 不再单独出现。
    previewChaptersDescription:
      "{count, plural, other {本站提供{count}章試讀,均由原始平台提供。}}",
    noPreviewChapters: "本書目前尚無試讀章節。",
    relatedWorks: "相關作品",
    chapterHeading: "第{number}章",
  },
  chapter: {
    nav: "章節導覽",
    previous: "上一章",
    next: "下一章",
    firstChapter: "這是第一章",
    lastPreviewChapter: "這是最後一章試讀章節",
    heading: "第{number}章",
    readerSettings: "閱讀設定",
    closeReaderSettings: "關閉閱讀設定",
    previewPosition: "試讀 {index} / {total}",
    endOfPreview: "本站的試讀到此結束。",
    continuePrompt: "想繼續閱讀嗎？",
    remainingOnOrigin: "後續章節請前往原始平台繼續閱讀。",
    readOnUpstream: "繼續閱讀",
    theme: "主題",
    fontSize: "字體大小",
    lineHeight: "行距",
    measure: "頁面寬度",
    persistNote: "設定會儲存在此裝置上,不會在裝置間同步。",
    resetDefaults: "重設為預設值",
    themeSystem: "跟隨系統",
    themeLight: "淺色",
    themeDark: "深色",
    lineHeightCompact: "緊湊",
    lineHeightStandard: "標準",
    lineHeightRelaxed: "寬鬆",
    measureNarrow: "窄",
    measureStandard: "標準",
    measureWide: "寬",
  },
  collection: {
    workCount: "{count}部作品",
    empty: "這裡目前還沒有可閱讀的作品。",
    allWorksTitle: "全部作品",
    allWorksDescription: "目前本站可供閱讀的作品。",
    allWorksEmpty: "目前尚無公開作品。",
    genreDescription: "您可以在此合輯中閱讀的作品。",
    genreEmpty: "此合輯目前尚無作品。",
    categoryTitle: "{name}小說",
    browseSeoDescription: "已發布的小說。",
    categoryEmpty: "此分類目前尚無已發布的小說。",
  },
  unavailable: {
    unpublishedTitle: "本書暫時無法閱讀",
    unpublishedBody: "本書已從本站下架。若日後恢復,此網址仍可使用。",
    takedownTitle: "本書已被撤回",
    takedownBody: "應版權方要求,本站不再提供本書。",
    returnHome: "回首頁",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "本站的文章與最新消息。",
    empty: "目前尚無部落格文章。",
    publishedOn: "發佈於 {date}",
    unpublishedTitle: "本篇文章暫時無法閱讀",
    unpublishedBody: "本文已從本站下架。若日後恢復,此網址仍可使用。",
  },
  errorPage: {
    title: "發生錯誤",
    body: "無法載入此頁面。您可以重試,或返回首頁。",
    retry: "重試",
    digest: "錯誤 ID {digest}",
  },
  notFoundPage: {
    title: "找不到此頁面",
    body: "網址可能有誤,或此頁面已不存在。",
  },
  pagination: {
    previous: "上一頁",
    next: "下一頁",
    pageOf: "{current} / {total}",
    label: "分頁",
  },
  meta: {
    notFound: "找不到頁面",
    chapterNotFound: "找不到章節",
    siteDescription: "探索小說,閱讀試讀章節。",
  },
} satisfies LocaleMessages;

export default messages;
