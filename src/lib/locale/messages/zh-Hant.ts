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
    // 運營文案第一輪・A組翻譯：按 C（Owner 2026-09-29"去掉本站/原平台/試讀"
    // 拍板）用新英文原文("New chapters are added regularly.")重新翻譯，
    // 不使用「本站」「原始平台」等表述。
    footerNote: "新章節定期更新。",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "語言",
  },
  home: {
    works: "作品",
    viewAll: "查看全部",
    featuredEyebrow: "精選",
    // C: "Start preview" → "Start reading"，去掉「試讀」表述。
    startPreview: "開始閱讀",
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
    // C: 去掉「試讀」表述，{count} 位置不變。
    previewCount: "{count}章可讀",
    startPreview: "開始閱讀",
    readOnUpstream: "繼續閱讀",
    synopsis: "劇情簡介",
    // A3 折中方案上線後此鍵已不再被組件引用(標題改用下面的
    // chapterListTitle)，保留值只為維持 key 集合，按 C 去掉「試讀」表述。
    previewChapters: "章節",
    // 施工工单_I18N_复数能力 §6.2 折键：zh-Hant 的 Intl.PluralRules 只解出
    // other 一檔(no one category)，one 分支在 zh-Hant 永遠選不中，會被門禁
    // 的 CLDR 類別覆蓋檢查判為多餘分支——因此只保留 other 分支(已含
    // {count}，任意數量下都語法正確)。C: 去掉「本站」「原始平台」表述，
    // plural 參數/類別不變。
    previewChaptersDescription: "{count, plural, other {現在可免費閱讀{count}章。}}",
    // 發布與 Preview 解耦後「零章節」整塊不渲染，已無引用；按 C 把英文原文
    // 的意思同步改譯。
    noPreviewChapters: "目前尚無可閱讀的章節。",
    relatedWorks: "相關作品",
    chapterHeading: "第{number}章",
    // A3/B2/A4/B1 新增鍵・運營文案第一輪 A 組翻譯完成。Owner 原則：不出現
    // 「本站」「原始平台」「試讀」「預覽」的意思，按本站就是官方站點處理。
    chapterListTitle: "章節列表",
    chapterListCount: "{count, plural, other {共{count}章}}",
    lockedChapterHint: "已鎖定，點擊繼續閱讀",
    expandAllChapters: "顯示全部{count}章",
    readMoreChapters: "閱讀更多章節",
    continueReadingModalTitle: "繼續閱讀",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"在這裡"（就在这里）。
    continueReadingModalBody: "繼續閱讀第{number}章及故事的其餘部分。",
    closeDialog: "關閉",
    newReleases: "新書上架",
    continueReadingBarLabel: "繼續閱讀列",
  },
  chapter: {
    nav: "章節導覽",
    previous: "上一章",
    next: "下一章",
    firstChapter: "這是第一章",
    // C: 去掉「試讀」表述，與上面 firstChapter 保持同一種句式。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"免費"。
    lastPreviewChapter: "這是最後一個免費章節",
    heading: "第{number}章",
    readerSettings: "閱讀設定",
    closeReaderSettings: "關閉閱讀設定",
    // C: 去掉「試讀」前綴，{index}/{total} 位置不變。
    previewPosition: "{index} / {total}",
    // C: 去掉「試讀」「本站」表述。
    endOfPreview: "目前可閱讀的內容到此為止。",
    continuePrompt: "想繼續閱讀嗎？",
    // C: 去掉「原始平台」表述。
    remainingOnOrigin: "繼續閱讀，故事仍在延續。",
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
    // C: 去掉「本站」表述。
    allWorksDescription: "目前可供閱讀的作品。",
    allWorksEmpty: "目前尚無公開作品。",
    genreDescription: "您可以在此合輯中閱讀的作品。",
    genreEmpty: "此合輯目前尚無作品。",
    categoryTitle: "{name}小說",
    browseSeoDescription: "已發布的小說。",
    categoryEmpty: "此分類目前尚無已發布的小說。",
  },
  unavailable: {
    unpublishedTitle: "本書暫時無法閱讀",
    // C: 去掉「本書已從本站下架」這句，只保留地址持續有效的提示。
    unpublishedBody: "若日後恢復，此網址仍可使用。",
    takedownTitle: "本書已被撤回",
    // C: 去掉「本站」表述。
    takedownBody: "應版權方要求，本書已不再提供閱讀。",
    returnHome: "回首頁",
  },
  blog: {
    listTitle: "部落格",
    // C: 去掉「本站的」表述。
    listDescription: "文章與最新消息。",
    empty: "目前尚無部落格文章。",
    publishedOn: "發佈於 {date}",
    unpublishedTitle: "本篇文章暫時無法閱讀",
    // C: 同 unavailable.unpublishedBody 的理由修改。
    unpublishedBody: "若日後恢復，此網址仍可使用。",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：照搬 CPS v8.5.1 src/messages/zh-Hant.json:136 的句式，仅把“劇目”换成“作品”（Owner 2026-09-30）。
    fallbackToast: "此作品尚未提供{locale}版本，已切換至{locale}首頁。",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "此頁面尚未提供{locale}版本。已切換至{locale}首頁。",
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
    // C: 去掉「試讀」表述。
    siteDescription: "探索小說，開始閱讀免費章節。",
    homeTitleFallback: "PulseNovel - 探索小說，免費閱讀書籍",
    pageSuffix: " - 第{page}頁",
    categoryDescriptionFallback: "在PulseNovel探索{name}小說。",
  },
} satisfies LocaleMessages;

export default messages;
