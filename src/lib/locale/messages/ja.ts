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
    about: "私たちについて",
    copyright: "コンテンツと著作権",
    // 運営コピー第1ラウンド・A班翻訳: C（Owner 2026-09-29「当サイト／原作
    // プラットフォーム／試し読み」表現の削除）に合わせて新しい英語原文
    // （"New chapters are added regularly."）を再翻訳。「本サイト」「原作
    // プラットフォーム」は使わない。
    footerNote: "新しい章を随時追加しています。",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "言語",
  },
  home: {
    works: "作品",
    viewAll: "すべて見る",
    featuredEyebrow: "おすすめ",
    // C: "Start preview" → "Start reading"。「試し読み」表現を削除。
    startPreview: "読み始める",
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
    // C: 「試し読み」表現を削除、{count} の位置は変更なし。
    previewCount: "{count}章読めます",
    startPreview: "読み始める",
    readOnUpstream: "続きを読む",
    synopsis: "あらすじ",
    // A3折衷案の実装後、このキーはコンポーネントから参照されなくなった
    // （見出しは下の chapterListTitle に置き換え）。key 集合を維持するため
    // 値のみ残し、Cに合わせて「試し読み」表現を削除。
    previewChapters: "章",
    // 施工工单_I18N_复数能力 §6.2 折键：ja の Intl.PluralRules は other の
    // 一カテゴリのみ解決される（no one category）ため、one 分岐は ja では
    // 選ばれることがなく、门禁の CLDR カテゴリカバレッジ検査で余剰分岐と
    // 判定される——そのため other 分岐のみを残す（{count} を含み、どの数量
    // でも文法的に成立する）。C: 「本サイト」「原作プラットフォーム」表現を
    // 削除、plural パラメータ/カテゴリは変更なし。
    previewChaptersDescription: "{count, plural, other {今すぐ{count}章を無料で読めます。}}",
    // 公開とPreviewの分離後、「0章」ブロック全体が描画されなくなったため
    // 参照なし。Cに合わせて英語原文の趣旨どおり翻訳のみ更新。
    noPreviewChapters: "まだ読める章がありません。",
    relatedWorks: "関連作品",
    chapterHeading: "第{number}章",
    // A3/B2/A4/B1 新規キー・運営コピー第1ラウンドA班翻訳済み。Owner原則:
    // 「本サイト」「原作プラットフォーム」「試し読み」「プレビュー」を
    // 使わない（本サイトが公式サイトそのものという前提で記述）。
    chapterListTitle: "章一覧",
    chapterListCount: "{count, plural, other {全{count}章}}",
    lockedChapterHint: "ロック中 — タップして続きを読む",
    expandAllChapters: "全{count}章を表示",
    readMoreChapters: "さらに章を読む",
    continueReadingModalTitle: "続きを読む",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；去掉"など"的举例语气，也不再说"ここで"（就在这里）。
    continueReadingModalBody: "第{number}章と物語の続きを読み進めましょう。",
    closeDialog: "閉じる",
    newReleases: "新着",
    continueReadingBarLabel: "続きを読むバー",
  },
  chapter: {
    nav: "章のナビゲーション",
    previous: "前の章",
    next: "次の章",
    firstChapter: "これが最初の章です",
    // C: 「試し読み」表現を削除、firstChapter と同じ文型を維持。
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 改为"無料で読める最後の章"。
    lastPreviewChapter: "これが無料で読める最後の章です",
    heading: "第{number}章",
    readerSettings: "読書設定",
    closeReaderSettings: "読書設定を閉じる",
    // C: 「試し読み」接頭辞を削除、{index}/{total} の位置は変更なし。
    previewPosition: "{index} / {total}",
    // C: 「試し読み」「本サイト」表現を削除。
    endOfPreview: "現在読めるのはここまでです。",
    continuePrompt: "続きを読みますか？",
    // C: 「原作プラットフォーム」表現を削除。
    remainingOnOrigin: "読み進めると物語が続きます。",
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
    // C: 「本サイトで」表現を削除。
    allWorksDescription: "現在読める作品です。",
    allWorksEmpty: "まだ公開されている作品がありません。",
    genreDescription: "このコレクションで読める作品です。",
    genreEmpty: "このコレクションにはまだ作品がありません。",
    categoryTitle: "{name}の小説",
    browseSeoDescription: "公開中の小説。",
    categoryEmpty: "このカテゴリーにはまだ公開中の小説がありません。",
  },
  unavailable: {
    unpublishedTitle: "この作品は一時的にご利用いただけません",
    // C: 「本サイトから削除されました」の文を削除、アドレスの有効性のみ残す。
    unpublishedBody: "再公開された場合、このURLは引き続き使えます。",
    takedownTitle: "この作品は取り下げられました",
    // C: 「本サイトでは」表現を削除。
    takedownBody: "権利者からの要請により、この作品はここでは提供されていません。",
    returnHome: "ホームに戻る",
  },
  blog: {
    listTitle: "ブログ",
    // C: 「本サイトの」表現を削除。
    listDescription: "記事と最新情報です。",
    empty: "まだブログ記事がありません。",
    publishedOn: "{date}に公開",
    unpublishedTitle: "この記事は一時的にご利用いただけません",
    // C: unavailable.unpublishedBody と同じ理由で修正。
    unpublishedBody: "再公開された場合、このURLは引き続き使えます。",
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
    // C: 「試し読み」表現を削除。
    siteDescription: "小説を見つけて、無料の章から読み始めよう。",
    homeTitleFallback: "PulseNovel - 小説を見つけて無料で読もう",
    pageSuffix: " - {page}ページ",
    categoryDescriptionFallback: "PulseNovelで{name}の小説を見つけよう。",
  },
} satisfies LocaleMessages;

export default messages;
