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
    // Bản dịch vòng 1 của đội vận hành · nhóm A: theo C (Owner chốt
    // 2026-09-29 bỏ cách nói "trang này / nền tảng gốc / xem trước"), dịch
    // lại theo nguyên văn tiếng Anh mới ("New chapters are added
    // regularly."). Không dùng "trang này" hay "nền tảng gốc".
    footerNote: "Chương mới được cập nhật thường xuyên.",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "Ngôn ngữ",
  },
  home: {
    works: "Tác phẩm",
    viewAll: "Xem tất cả",
    featuredEyebrow: "Nổi bật",
    // C: "Start preview" → "Start reading", bỏ chữ "xem trước".
    startPreview: "Bắt đầu đọc",
    viewDetails: "Xem chi tiết",
    carouselLabel: "Tác phẩm nổi bật",
    carouselRole: "băng chuyền",
    switchFeatured: "Đổi tác phẩm nổi bật",
    slideLabel: "Tác phẩm {n}",
    slideStatus: "Tác phẩm {n} trong {count}: {title}",
    chapterCount: "{count} chương",
  },
  novel: {
    coverAlt: "{title}",
    tagsLabel: "Thẻ",
    genreTags: "Thẻ thể loại",
    chapterCount: "{count} chương",
    // C: bỏ chữ "xem trước", vị trí {count} không đổi.
    previewCount: "{count} chương có thể đọc",
    startPreview: "Bắt đầu đọc",
    readOnUpstream: "Tiếp tục đọc",
    synopsis: "Tóm tắt",
    // Khóa này không còn được component nào tham chiếu sau khi triển khai
    // phương án A3 (tiêu đề đã đổi sang chapterListTitle bên dưới); giữ
    // giá trị chỉ để không đổi tập hợp khóa, theo C bỏ chữ "xem trước".
    previewChapters: "Chương",
    // 施工工单_I18N_复数能力 §6.2 折键：Intl.PluralRules của vi chỉ phân
    // giải được duy nhất hạng mục other (no one category), nhánh one ở vi
    // không bao giờ được chọn nên bị门禁 kiểm tra độ phủ hạng mục CLDR coi
    // là nhánh thừa——vì vậy chỉ giữ nhánh other (đã có {count}, đúng ngữ
    // pháp với mọi số lượng). C: bỏ "trang này", "nền tảng gốc"; tham số/
    // hạng mục plural không đổi.
    previewChaptersDescription: "{count, plural, other {Hiện có {count} chương đọc miễn phí.}}",
    // Sau khi tách phát hành khỏi Preview, khối "0 chương" không còn được
    // render nên không còn tham chiếu; theo C cập nhật bản dịch đúng ý
    // nguyên văn mới.
    noPreviewChapters: "Chưa có chương nào để đọc.",
    relatedWorks: "Tác phẩm liên quan",
    chapterHeading: "Chương {number}",
    // Khóa mới A3/B2/A4/B1 · Bản dịch vòng 1 của đội vận hành, nhóm A đã
    // hoàn tất. Nguyên tắc Owner: không mang nghĩa "trang này / nền tảng
    // gốc / xem trước / bản xem trước" (coi trang này chính là trang chính
    // thức).
    chapterListTitle: "Danh sách chương",
    chapterListCount: "{count, plural, other {Tổng {count} chương}}",
    lockedChapterHint: "Đã khoá — chạm để tiếp tục đọc",
    expandAllChapters: "Xem tất cả {count} chương",
    readMoreChapters: "Đọc thêm chương",
    continueReadingModalTitle: "Tiếp tục đọc",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"ở đây"（就在这里）。
    continueReadingModalBody: "Hãy đọc tiếp từ chương {number} và phần còn lại của câu chuyện.",
    closeDialog: "Đóng",
    newReleases: "Tác phẩm mới",
    continueReadingBarLabel: "Thanh tiếp tục đọc",
  },
  chapter: {
    nav: "Điều hướng chương",
    previous: "Chương trước",
    next: "Chương sau",
    firstChapter: "Đây là chương đầu tiên",
    // C: bỏ chữ "xem trước", giữ cùng cấu trúc câu với firstChapter.
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"miễn phí"（免费）。
    lastPreviewChapter: "Đây là chương miễn phí cuối cùng",
    heading: "Chương {number}",
    readerSettings: "Cài đặt đọc",
    closeReaderSettings: "Đóng cài đặt đọc",
    // C: bỏ tiền tố "xem trước", {index}/{total} không đổi.
    previewPosition: "{index} / {total}",
    // C: bỏ "xem trước", "trang này".
    endOfPreview: "Hiện chỉ có sẵn đến đây.",
    continuePrompt: "Bạn muốn đọc tiếp không?",
    // C: bỏ "nền tảng gốc".
    remainingOnOrigin: "Đọc tiếp để theo dõi câu chuyện.",
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
    // C: bỏ "trên trang này".
    allWorksDescription: "Các tác phẩm hiện có thể đọc.",
    allWorksEmpty: "Chưa có tác phẩm nào công khai.",
    genreDescription: "Các tác phẩm bạn có thể đọc trong bộ sưu tập này.",
    genreEmpty: "Chưa có tác phẩm nào trong bộ sưu tập này.",
    // 运营 2026-10-08（Owner 追加）：只用于 /browse?category= 的 <title>；与 categoryHeading 同值，
    // 让浏览页和分类页的标题形式一致（旧值 "Tiểu thuyết {name}" 套短语型分类名会不通顺）。
    categoryTitle: "Tiểu thuyết: {name}",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 旧 categoryTitle "Tiểu thuyết {name}" 套短语名会变 "Tiểu thuyết Dành cho nữ"，所以改成冒号隔开。
    categoryHeading: "Tiểu thuyết: {name}",
    browseSeoDescription: "Tiểu thuyết đã xuất bản.",
    categoryEmpty: "Chưa có tiểu thuyết nào được xuất bản trong danh mục này.",
  },
  unavailable: {
    unpublishedTitle: "Cuốn sách này tạm thời không có sẵn",
    // C: bỏ câu "đã bị gỡ khỏi trang này", chỉ giữ lời nhắc địa chỉ vẫn
    // hoạt động.
    unpublishedBody: "Nếu quay lại, địa chỉ này vẫn sẽ hoạt động.",
    takedownTitle: "Cuốn sách này đã bị gỡ bỏ",
    // C: bỏ "trang này".
    takedownBody: "Theo yêu cầu của chủ sở hữu bản quyền, sách này không còn được cung cấp ở đây.",
    returnHome: "Về trang chủ",
  },
  blog: {
    listTitle: "Blog",
    // C: bỏ "từ trang này".
    listDescription: "Bài viết và cập nhật.",
    empty: "Chưa có bài viết blog nào.",
    publishedOn: "Đăng ngày {date}",
    unpublishedTitle: "Bài viết này tạm thời không có sẵn",
    // C: cùng lý do với unavailable.unpublishedBody.
    unpublishedBody: "Nếu quay lại, địa chỉ này vẫn sẽ hoạt động.",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：CPS v8.5.1 src/messages/vi.json:136 的句式是“Tựa phim này…”；Owner 2026-09-30 先换成“Tựa sách”，
    // 按第三方验收（GPT，2026-09-30）+ Owner 拍板，再改用更自然的“Cuốn sách này”（这本书），其余句式不变。
    fallbackToast: "Cuốn sách này chưa có bằng {locale}. Đã chuyển đến trang chủ {locale}.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Trang này chưa có bằng {locale}. Đã chuyển đến trang chủ {locale}.",
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
    // C: bỏ "xem trước".
    siteDescription: "Khám phá tiểu thuyết và bắt đầu đọc chương miễn phí.",
    homeTitleFallback: "PulseNovel - Khám phá tiểu thuyết và đọc sách miễn phí",
    pageSuffix: " - Trang {page}",
    // 运营 2026-10-08（Owner 追加）：分类名是短语时旧句 "Khám phá tiểu thuyết {name} trên PulseNovel." 不通顺，用该语种的引号把分类名隔开。
    categoryDescriptionFallback: "Khám phá tiểu thuyết thuộc danh mục “{name}” trên PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
