import type { LocaleMessages } from "./en";

/**
 * Korean UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/ko.json` (e.g. `common.home`, `header.language`,
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
    home: "홈",
    browse: "전체 작품",
    genres: "장르",
    mainNav: "메인 내비게이션",
    footerNav: "푸터 내비게이션",
    skipToContent: "본문으로 건너뛰기",
    openMenu: "메뉴 열기",
    closeMenu: "메뉴 닫기",
    about: "사이트 소개",
    copyright: "콘텐츠 및 저작권",
    footerNote: "이 사이트는 무료 미리보기 챕터를 제공합니다. 전체 이야기는 원작 플랫폼에서 볼 수 있습니다.",
    language: "언어",
  },
  home: {
    works: "작품",
    viewAll: "전체 보기",
    featuredEyebrow: "추천",
    startPreview: "미리보기 시작",
    viewDetails: "상세 보기",
    carouselLabel: "추천 작품",
    carouselRole: "캐러셀",
    switchFeatured: "추천 작품 전환",
    slideLabel: "작품 {n}",
    slideStatus: "작품 {n}/{count}: {title}",
    chapterCount: "총 {count}장",
  },
  novel: {
    coverAlt: "{title} 표지",
    tagsLabel: "태그",
    genreTags: "장르 태그",
    chapterCount: "총 {count}장",
    previewCount: "미리보기 {count}장",
    startPreview: "미리보기 시작",
    readOnUpstream: "이어서 읽기",
    synopsis: "시놉시스",
    previewChapters: "미리보기 챕터",
    // 施工工单_I18N_复数能力 §6.2 折键：ko 的 Intl.PluralRules 只解出 other 一档
    // （no one category），one 分支在 ko 永远选不中，会被门禁的 CLDR
    // 类别覆盖检查判为多余分支——因此这里只保留原 previewChaptersDescription
    // 一句（已含 {count}，任意数量下都语法正确），原 …One 的单数措辞变体停用，
    // 不再单独出现。
    previewChaptersDescription:
      "{count, plural, other {이 사이트에서 미리보기 챕터 {count}개를 볼 수 있으며, 모두 원작 플랫폼에서 제공합니다.}}",
    noPreviewChapters: "이 작품은 아직 미리보기 챕터가 없습니다.",
    relatedWorks: "관련 작품",
    chapterHeading: "{number}장",
  },
  chapter: {
    nav: "챕터 내비게이션",
    previous: "이전 챕터",
    next: "다음 챕터",
    firstChapter: "첫 번째 챕터입니다",
    lastPreviewChapter: "마지막 미리보기 챕터입니다",
    heading: "{number}장",
    readerSettings: "읽기 설정",
    closeReaderSettings: "읽기 설정 닫기",
    previewPosition: "미리보기 {index} / {total}",
    endOfPreview: "이 사이트에서 제공하는 미리보기는 여기까지입니다.",
    continuePrompt: "계속 읽으시겠어요?",
    remainingOnOrigin: "다음 챕터는 원작 플랫폼에서 이어집니다.",
    readOnUpstream: "이어서 읽기",
    theme: "테마",
    fontSize: "글자 크기",
    lineHeight: "줄 간격",
    measure: "페이지 너비",
    persistNote: "설정은 이 기기에 저장되며 다른 기기와 동기화되지 않습니다.",
    resetDefaults: "기본값으로 재설정",
    themeSystem: "시스템 설정 사용",
    themeLight: "라이트",
    themeDark: "다크",
    lineHeightCompact: "좁게",
    lineHeightStandard: "표준",
    lineHeightRelaxed: "넓게",
    measureNarrow: "좁게",
    measureStandard: "표준",
    measureWide: "넓게",
  },
  collection: {
    workCount: "작품 {count}개",
    empty: "여기서 읽을 수 있는 작품이 아직 없습니다.",
    allWorksTitle: "전체 작품",
    allWorksDescription: "현재 이 사이트에서 읽을 수 있는 작품입니다.",
    allWorksEmpty: "공개된 작품이 아직 없습니다.",
    genreDescription: "이 컬렉션에서 읽을 수 있는 작품입니다.",
    genreEmpty: "이 컬렉션에는 아직 작품이 없습니다.",
    categoryTitle: "{name} 소설",
    browseSeoDescription: "공개된 소설입니다.",
    categoryEmpty: "이 카테고리에는 아직 공개된 소설이 없습니다.",
  },
  unavailable: {
    unpublishedTitle: "이 작품은 일시적으로 이용할 수 없습니다",
    unpublishedBody: "이 사이트에서 삭제되었습니다. 다시 게시되면 이 주소는 계속 작동합니다.",
    takedownTitle: "이 작품은 내려졌습니다",
    takedownBody: "저작권자의 요청에 따라 이 사이트는 더 이상 이 작품을 제공하지 않습니다. 이 조치는 영구적입니다.",
    returnHome: "홈으로 돌아가기",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "이 사이트의 게시물과 소식입니다.",
    empty: "아직 블로그 게시물이 없습니다.",
    publishedOn: "{date} 게시",
    unpublishedTitle: "이 게시물은 일시적으로 이용할 수 없습니다",
    unpublishedBody: "이 사이트에서 삭제되었습니다. 다시 게시되면 이 주소는 계속 작동합니다.",
  },
  errorPage: {
    title: "문제가 발생했습니다",
    body: "이 페이지를 불러올 수 없습니다. 다시 시도하거나 홈으로 돌아가세요.",
    retry: "다시 시도",
    digest: "오류 ID {digest}",
  },
  notFoundPage: {
    title: "이 페이지를 찾을 수 없습니다",
    body: "주소가 잘못되었거나 이 페이지가 더 이상 존재하지 않습니다.",
  },
  pagination: {
    previous: "이전",
    next: "다음",
    pageOf: "{current} / {total}",
    label: "페이지네이션",
  },
  meta: {
    notFound: "찾을 수 없음",
    chapterNotFound: "챕터를 찾을 수 없음",
    siteDescription: "해외 소설 유통 사이트",
  },
} satisfies LocaleMessages;

export default messages;
