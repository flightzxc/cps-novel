import type { LocaleMessages } from "./en";

/**
 * Japanese UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/ja.json` (e.g. `common.home`, `header.language`,
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
    home: "ホーム",
    browse: "すべての作品",
    genres: "ジャンル",
    mainNav: "メインナビゲーション",
    footerNav: "フッターナビゲーション",
    skipToContent: "メインコンテンツへスキップ",
    openMenu: "メニューを開く",
    closeMenu: "メニューを閉じる",
    about: "このサイトについて",
    copyright: "コンテンツと著作権",
    footerNote: "本サイトでは無料で試し読みできる章をご用意しています。全編は原作プラットフォームでお楽しみいただけます。",
    language: "言語",
  },
  home: {
    works: "作品",
    viewAll: "すべて見る",
    featuredEyebrow: "おすすめ",
    startPreview: "試し読みを開始",
    viewDetails: "詳細を見る",
    carouselLabel: "おすすめ作品",
    carouselRole: "カルーセル",
    switchFeatured: "おすすめ作品を切り替える",
    slideLabel: "作品{n}",
    slideStatus: "作品{n}/{count}：{title}",
    chapterCount: "全{count}章",
  },
  novel: {
    coverAlt: "「{title}」の表紙",
    tagsLabel: "タグ",
    genreTags: "ジャンルタグ",
    chapterCount: "全{count}章",
    previewCount: "試し読み：{count}章",
    startPreview: "試し読みを開始",
    readOnUpstream: "続きを読む",
    synopsis: "あらすじ",
    previewChapters: "試し読みできる章",
    previewChaptersDescription: "本サイトでは{count}章を試し読みいただけます。すべて原作プラットフォームより提供されています。",
    previewChaptersDescriptionOne: "本サイトでは1章を試し読みいただけます。原作プラットフォームより提供されています。",
    noPreviewChapters: "この作品にはまだ試し読みできる章がありません。",
    relatedWorks: "関連作品",
    chapterHeading: "第{number}章",
  },
  chapter: {
    nav: "章のナビゲーション",
    previous: "前の章",
    next: "次の章",
    firstChapter: "これが最初の章です",
    lastPreviewChapter: "これが試し読みできる最後の章です",
    heading: "第{number}章",
    readerSettings: "読書設定",
    closeReaderSettings: "読書設定を閉じる",
    previewPosition: "試し読み {index} / {total}",
    endOfPreview: "本サイトでの試し読みはここまでです。",
    continuePrompt: "続きを読みますか？",
    remainingOnOrigin: "続きの章は原作プラットフォームでお読みいただけます。",
    readOnUpstream: "続きを読む",
    theme: "テーマ",
    fontSize: "文字サイズ",
    lineHeight: "行間",
    measure: "ページ幅",
    persistNote: "設定はこの端末に保存され、他の端末とは同期されません。",
    resetDefaults: "初期設定に戻す",
    themeSystem: "システムに合わせる",
    themeLight: "ライト",
    themeDark: "ダーク",
    lineHeightCompact: "狭い",
    lineHeightStandard: "標準",
    lineHeightRelaxed: "広い",
    measureNarrow: "狭い",
    measureStandard: "標準",
    measureWide: "広い",
  },
  collection: {
    workCount: "{count}作品",
    empty: "ここではまだ読める作品がありません。",
    allWorksTitle: "すべての作品",
    allWorksDescription: "本サイトで現在読める作品です。",
    allWorksEmpty: "まだ公開されている作品がありません。",
    genreDescription: "このコレクションで読める作品です。",
    genreEmpty: "このコレクションにはまだ作品がありません。",
    categoryTitle: "{name}の小説",
    browseSeoDescription: "公開中の小説。",
    categoryEmpty: "このカテゴリーにはまだ公開中の小説がありません。",
  },
  unavailable: {
    unpublishedTitle: "この作品は一時的にご利用いただけません",
    unpublishedBody: "本サイトから削除されました。復帰した場合、このアドレスは引き続きご利用いただけます。",
    takedownTitle: "この作品は取り下げられました",
    takedownBody: "権利者からの要請により、本サイトではこの作品の提供を終了しました。この取り下げは永久的なものです。",
    returnHome: "ホームに戻る",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "本サイトの記事や最新情報です。",
    empty: "まだブログ記事がありません。",
    publishedOn: "{date}に公開",
    unpublishedTitle: "この記事は一時的にご利用いただけません",
    unpublishedBody: "本サイトから削除されました。復帰した場合、このアドレスは引き続きご利用いただけます。",
  },
  errorPage: {
    title: "問題が発生しました",
    body: "このページを読み込めませんでした。再試行するか、ホームに戻ってください。",
    retry: "再試行",
    digest: "エラーID {digest}",
  },
  notFoundPage: {
    title: "このページは見つかりませんでした",
    body: "アドレスが間違っているか、このページはすでに存在しません。",
  },
  pagination: {
    previous: "前へ",
    next: "次へ",
    pageOf: "{current} / {total}",
    label: "ページネーション",
  },
  meta: {
    notFound: "見つかりません",
    chapterNotFound: "章が見つかりません",
    siteDescription: "海外向け小説配信サイト",
  },
} satisfies LocaleMessages;

export default messages;
