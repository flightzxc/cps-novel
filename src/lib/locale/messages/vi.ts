import type { LocaleMessages } from "./en";

/**
 * Vietnamese UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/vi.json` (e.g. `common.home`, `header.language`,
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
    home: "Trang chủ",
    browse: "Tất cả tác phẩm",
    genres: "Thể loại",
    mainNav: "Điều hướng chính",
    footerNav: "Điều hướng chân trang",
    skipToContent: "Bỏ qua để đến nội dung chính",
    openMenu: "Mở menu",
    closeMenu: "Đóng menu",
    about: "Giới thiệu",
    copyright: "Nội dung và bản quyền",
    footerNote: "Trang này cung cấp các chương xem trước miễn phí. Toàn bộ câu chuyện có trên nền tảng gốc.",
    language: "Ngôn ngữ",
  },
  home: {
    works: "Tác phẩm",
    viewAll: "Xem tất cả",
    featuredEyebrow: "Nổi bật",
    startPreview: "Bắt đầu xem trước",
    viewDetails: "Xem chi tiết",
    carouselLabel: "Tác phẩm nổi bật",
    carouselRole: "băng chuyền",
    switchFeatured: "Đổi tác phẩm nổi bật",
    slideLabel: "Tác phẩm {n}",
    slideStatus: "Tác phẩm {n} trong {count}: {title}",
    chapterCount: "{count} chương",
  },
  novel: {
    coverAlt: "Ảnh bìa {title}",
    tagsLabel: "Thẻ",
    genreTags: "Thẻ thể loại",
    chapterCount: "{count} chương",
    previewCount: "{count} chương xem trước",
    startPreview: "Bắt đầu xem trước",
    readOnUpstream: "Tiếp tục đọc",
    synopsis: "Tóm tắt",
    previewChapters: "Chương xem trước",
    previewChaptersDescription: "{count} chương xem trước trên trang này, tất cả do nền tảng gốc cung cấp.",
    previewChaptersDescriptionOne: "1 chương xem trước trên trang này, do nền tảng gốc cung cấp.",
    noPreviewChapters: "Cuốn sách này chưa có chương xem trước.",
    relatedWorks: "Tác phẩm liên quan",
    chapterHeading: "Chương {number}",
  },
  chapter: {
    nav: "Điều hướng chương",
    previous: "Chương trước",
    next: "Chương sau",
    firstChapter: "Đây là chương đầu tiên",
    lastPreviewChapter: "Đây là chương xem trước cuối cùng",
    heading: "Chương {number}",
    readerSettings: "Cài đặt đọc",
    closeReaderSettings: "Đóng cài đặt đọc",
    previewPosition: "Xem trước {index} / {total}",
    endOfPreview: "Đây là hết phần xem trước trên trang này.",
    continuePrompt: "Bạn muốn đọc tiếp không?",
    remainingOnOrigin: "Các chương sau tiếp tục trên nền tảng gốc.",
    readOnUpstream: "Tiếp tục đọc",
    theme: "Giao diện",
    fontSize: "Cỡ chữ",
    lineHeight: "Giãn dòng",
    measure: "Độ rộng trang",
    persistNote: "Cài đặt được lưu trên thiết bị này và không đồng bộ giữa các thiết bị.",
    resetDefaults: "Đặt lại mặc định",
    themeSystem: "Theo hệ thống",
    themeLight: "Sáng",
    themeDark: "Tối",
    lineHeightCompact: "Hẹp",
    lineHeightStandard: "Tiêu chuẩn",
    lineHeightRelaxed: "Rộng",
    measureNarrow: "Hẹp",
    measureStandard: "Tiêu chuẩn",
    measureWide: "Rộng",
  },
  collection: {
    workCount: "{count} tác phẩm",
    empty: "Chưa có tác phẩm nào để đọc ở đây.",
    allWorksTitle: "Tất cả tác phẩm",
    allWorksDescription: "Các tác phẩm hiện có thể đọc trên trang này.",
    allWorksEmpty: "Chưa có tác phẩm nào công khai.",
    genreDescription: "Các tác phẩm bạn có thể đọc trong bộ sưu tập này.",
    genreEmpty: "Chưa có tác phẩm nào trong bộ sưu tập này.",
    categoryTitle: "Tiểu thuyết {name}",
    browseSeoDescription: "Tiểu thuyết đã xuất bản.",
    categoryEmpty: "Chưa có tiểu thuyết nào được xuất bản trong danh mục này.",
  },
  unavailable: {
    unpublishedTitle: "Cuốn sách này tạm thời không có sẵn",
    unpublishedBody: "Cuốn sách đã bị gỡ khỏi trang này. Nếu quay lại, địa chỉ này vẫn sẽ hoạt động.",
    takedownTitle: "Cuốn sách này đã bị gỡ bỏ",
    takedownBody: "Theo yêu cầu của chủ sở hữu bản quyền, trang này không còn cung cấp cuốn sách này nữa. Việc gỡ bỏ này là vĩnh viễn.",
    returnHome: "Về trang chủ",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Bài viết và cập nhật từ trang này.",
    empty: "Chưa có bài viết blog nào.",
    publishedOn: "Đăng ngày {date}",
    unpublishedTitle: "Bài viết này tạm thời không có sẵn",
    unpublishedBody: "Bài viết đã bị gỡ khỏi trang này. Nếu quay lại, địa chỉ này vẫn sẽ hoạt động.",
  },
  errorPage: {
    title: "Đã xảy ra lỗi",
    body: "Không thể tải trang này. Bạn có thể thử lại hoặc quay về trang chủ.",
    retry: "Thử lại",
    digest: "Mã lỗi {digest}",
  },
  notFoundPage: {
    title: "Không tìm thấy trang này",
    body: "Địa chỉ có thể sai, hoặc trang này không còn tồn tại.",
  },
  pagination: {
    previous: "Trước",
    next: "Sau",
    pageOf: "{current} / {total}",
    label: "Phân trang",
  },
  meta: {
    notFound: "Không tìm thấy",
    chapterNotFound: "Không tìm thấy chương",
    siteDescription: "Trang phân phối tiểu thuyết ở nước ngoài",
  },
} satisfies LocaleMessages;

export default messages;
