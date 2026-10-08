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
    // 운영 문안 1라운드 · A조 번역: C(Owner 2026-09-29 "본站/원작 플랫폼/미리보기"
    // 표현 제거)에 맞춰 새 영어 원문("New chapters are added regularly.")을
    // 다시 번역. "이 사이트", "원작 플랫폼" 표현을 쓰지 않음.
    footerNote: "새 챕터가 정기적으로 업데이트됩니다.",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "언어",
  },
  home: {
    works: "작품",
    viewAll: "전체 보기",
    featuredEyebrow: "추천",
    // C: "Start preview" → "Start reading". "미리보기" 표현 제거.
    startPreview: "읽기 시작",
    viewDetails: "상세 보기",
    carouselLabel: "추천 작품",
    carouselRole: "캐러셀",
    switchFeatured: "추천 작품 전환",
    slideLabel: "작품 {n}",
    slideStatus: "작품 {n}/{count}: {title}",
    chapterCount: "총 {count}장",
  },
  novel: {
    coverAlt: "{title}",
    tagsLabel: "태그",
    genreTags: "장르 태그",
    chapterCount: "총 {count}장",
    // C: "preview" 표현 제거, {count} 위치 동일.
    previewCount: "{count}장 이용 가능",
    startPreview: "읽기 시작",
    readOnUpstream: "이어서 읽기",
    synopsis: "시놉시스",
    // 이 키는 A3 절충안 반영 후 더 이상 컴포넌트에서 참조되지 않음(제목은
    // 아래 chapterListTitle 사용). key 집합 유지를 위해 값만 유지, C에 맞춰
    // "미리보기" 표현은 제거.
    previewChapters: "챕터",
    // 施工工单_I18N_复数能力 §6.2 折键：ko 의 Intl.PluralRules 는 other 한
    // 카테고리만 해석되므로(no one category) one 분기는 ko에서 선택될 수 없어
    // 门禁의 CLDR 카테고리 커버리지 검사에서 잉여 분기로 판정됨——따라서 other
    // 분기 하나만 유지(이미 {count}를 포함해 어떤 수량에도 문법적으로 맞음).
    // C: "이 사이트", "원작 플랫폼" 표현 제거, plural 파라미터/카테고리는 그대로.
    previewChaptersDescription: "{count, plural, other {지금 {count}개 챕터를 무료로 읽을 수 있습니다.}}",
    // 발행과 Preview 분리 이후 "0개 챕터" 블록 전체가 렌더링되지 않아 더 이상
    // 참조되지 않음; C에 맞춰 영문 원문 취지대로 번역만 갱신.
    noPreviewChapters: "아직 읽을 수 있는 챕터가 없습니다.",
    relatedWorks: "관련 작품",
    chapterHeading: "{number}장",
    // A3/B2/A4/B1 신규 키 · 운영 문안 1라운드 A조 번역 완료. Owner 원칙: "이
    // 사이트", "원작 플랫폼", "미리보기" 표현을 쓰지 않음(본 사이트가 곧
    // 공식 사이트라는 전제로 작성).
    chapterListTitle: "챕터 목록",
    chapterListCount: "{count, plural, other {총 {count}장}}",
    lockedChapterHint: "잠김 — 탭하면 이어서 읽기",
    expandAllChapters: "전체 {count}장 보기",
    readMoreChapters: "챕터 더 읽기",
    continueReadingModalTitle: "이어서 읽기",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"여기서"（就在这里）。
    continueReadingModalBody: "{number}장과 나머지 이야기를 이어서 읽어 보세요.",
    closeDialog: "닫기",
    newReleases: "신작",
    continueReadingBarLabel: "이어서 읽기 바",
  },
  chapter: {
    nav: "챕터 내비게이션",
    previous: "이전 챕터",
    next: "다음 챕터",
    firstChapter: "첫 번째 챕터입니다",
    // C: "preview" 표현 제거, firstChapter와 동일한 문형 유지.
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"무료"（免费）。
    lastPreviewChapter: "마지막 무료 챕터입니다",
    heading: "{number}장",
    readerSettings: "읽기 설정",
    closeReaderSettings: "읽기 설정 닫기",
    // C: "미리보기" 접두어 제거, {index}/{total} 위치 동일.
    previewPosition: "{index} / {total}",
    // C: "미리보기", "이 사이트" 표현 제거.
    endOfPreview: "지금 읽을 수 있는 내용은 여기까지입니다.",
    continuePrompt: "계속 읽으시겠어요?",
    // C: "원작 플랫폼" 표현 제거.
    remainingOnOrigin: "이어서 읽으면 이야기가 계속됩니다.",
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
    // C: "이 사이트" 표현 제거.
    allWorksDescription: "현재 읽을 수 있는 작품입니다.",
    allWorksEmpty: "공개된 작품이 아직 없습니다.",
    genreDescription: "이 컬렉션에서 읽을 수 있는 작품입니다.",
    genreEmpty: "이 컬렉션에는 아직 작품이 없습니다.",
    categoryTitle: "{name} 소설",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 与 categoryTitle 同形："{name} 소설" 对名词和短语名都通顺（여성향 소설 / 미움에서 사랑으로 소설）。
    categoryHeading: "{name} 소설",
    browseSeoDescription: "공개된 소설입니다.",
    categoryEmpty: "이 카테고리에는 아직 공개된 소설이 없습니다.",
  },
  unavailable: {
    unpublishedTitle: "이 작품은 일시적으로 이용할 수 없습니다",
    // C: "이 사이트에서 삭제되었습니다" 문장 제거, "주소는 계속 작동합니다"만 유지.
    unpublishedBody: "다시 게시되면 이 주소는 계속 사용할 수 있습니다.",
    takedownTitle: "이 작품은 내려졌습니다",
    // C: "이 사이트" 표현 제거.
    takedownBody: "저작권자의 요청에 따라 이 작품은 더 이상 제공되지 않습니다.",
    returnHome: "홈으로 돌아가기",
  },
  blog: {
    listTitle: "블로그",
    // C: "이 사이트의" 표현 제거.
    listDescription: "글과 소식입니다.",
    empty: "아직 블로그 게시물이 없습니다.",
    publishedOn: "{date} 게시",
    unpublishedTitle: "이 게시물은 일시적으로 이용할 수 없습니다",
    // C: unavailable.unpublishedBody와 동일한 이유로 수정.
    unpublishedBody: "다시 게시되면 이 주소는 계속 사용할 수 있습니다.",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：CPS v8.5.1 src/messages/ko.json:136 原句是“{locale}로 제공되지…”，助词“로”写死；
    // 韩语的“로/으로”取决于前一个词是否以辅音收尾，语种自称（Français、Русский、繁體中文…）无法判断，写死会不合语法。
    // 按第三方验收（GPT，2026-09-30）+ Owner 拍板，改成与下面非书页句同一种写法“{locale} 버전으로”
    // （“버전”是固定名词，助词接在它后面），主语仍是“이 작품”。
    fallbackToast: "이 작품은 아직 {locale} 버전으로 제공되지 않습니다. {locale} 홈으로 이동했습니다.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景；2026-09-30 验收后由“{locale}로”改为“{locale} 버전으로”。
    fallbackToastPage: "이 페이지는 아직 {locale} 버전으로 제공되지 않습니다. {locale} 홈으로 이동했습니다.",
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
    // C: "미리보기" 표현 제거.
    siteDescription: "소설을 만나보고 무료 챕터부터 읽어보세요.",
    homeTitleFallback: "PulseNovel - 소설을 만나보고 무료로 읽어보세요",
    pageSuffix: " - {page}페이지",
    categoryDescriptionFallback: "PulseNovel에서 {name} 소설을 만나보세요.",
  },
} satisfies LocaleMessages;

export default messages;
