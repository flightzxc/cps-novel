import type { LocaleMessages } from "./en";

/**
 * Indonesian UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/id.json` (e.g. `common.home`, `header.language`,
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
    home: "Beranda",
    browse: "Semua karya",
    genres: "Genre",
    mainNav: "Navigasi utama",
    footerNav: "Navigasi footer",
    skipToContent: "Lewati ke konten utama",
    openMenu: "Buka menu",
    closeMenu: "Tutup menu",
    about: "Tentang",
    copyright: "Konten dan hak cipta",
    footerNote: "Bab baru ditambahkan secara berkala.",
    language: "Bahasa",
  },
  home: {
    works: "Karya",
    viewAll: "Lihat Semua",
    featuredEyebrow: "Unggulan",
    startPreview: "Mulai membaca",
    viewDetails: "Lihat detail",
    carouselLabel: "Karya unggulan",
    carouselRole: "korsel",
    switchFeatured: "Ganti karya unggulan",
    slideLabel: "Karya {n}",
    slideStatus: "Karya {n} dari {count}: {title}",
    chapterCount: "{count} bab",
  },
  novel: {
    coverAlt: "Sampul {title}",
    tagsLabel: "Tag",
    genreTags: "Tag genre",
    chapterCount: "{count} bab",
    previewCount: "{count} bab tersedia",
    startPreview: "Mulai membaca",
    readOnUpstream: "Lanjutkan membaca",
    synopsis: "Sinopsis",
    previewChapters: "Bab",
    // 施工工单_I18N_复数能力 §6.2 折键：id 的 Intl.PluralRules 只解出 other 一档
    // （no one category），只保留 other 一支即可满足 CLDR 类别覆盖检查。
    // B 组翻译单（2026-09-29）按新英文原文重译。
    previewChaptersDescription: "{count, plural, other {{count} bab gratis untuk dibaca sekarang.}}",
    noPreviewChapters: "Belum ada bab untuk dibaca.",
    relatedWorks: "Karya terkait",
    chapterHeading: "Bab {number}",
    // A3/A4/B1 新增键：B 组翻译单（2026-09-29）译入印尼语，替换英文占位。
    chapterListTitle: "Daftar bab",
    chapterListCount: "{count, plural, other {Total {count} bab}}",
    lockedChapterHint: "Terkunci — ketuk untuk melanjutkan membaca",
    expandAllChapters: "Tampilkan semua {count} bab",
    readMoreChapters: "Baca bab lainnya",
    continueReadingModalTitle: "Lanjutkan membaca",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"di sini"（就在这里）。
    continueReadingModalBody: "Lanjutkan dengan Bab {number} dan kelanjutan ceritanya.",
    closeDialog: "Tutup",
    newReleases: "Terbitan baru",
    continueReadingBarLabel: "Bilah lanjutkan membaca",
  },
  chapter: {
    nav: "Navigasi bab",
    previous: "Bab sebelumnya",
    next: "Bab berikutnya",
    firstChapter: "Ini adalah bab pertama",
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"gratis"（免费）。
    lastPreviewChapter: "Ini adalah bab gratis terakhir",
    heading: "Bab {number}",
    readerSettings: "Pengaturan membaca",
    closeReaderSettings: "Tutup pengaturan membaca",
    previewPosition: "{index} / {total}",
    endOfPreview: "Itulah semua yang tersedia saat ini.",
    continuePrompt: "Ingin terus membaca?",
    remainingOnOrigin: "Terus membaca untuk melanjutkan cerita.",
    readOnUpstream: "Lanjutkan membaca",
    theme: "Tema",
    fontSize: "Ukuran font",
    lineHeight: "Jarak baris",
    measure: "Lebar halaman",
    persistNote: "Pengaturan disimpan di perangkat ini dan tidak disinkronkan di perangkat lain.",
    resetDefaults: "Setel ulang ke default",
    themeSystem: "Ikuti sistem",
    themeLight: "Terang",
    themeDark: "Gelap",
    lineHeightCompact: "Rapat",
    lineHeightStandard: "Standar",
    lineHeightRelaxed: "Renggang",
    measureNarrow: "Sempit",
    measureStandard: "Standar",
    measureWide: "Lebar",
  },
  collection: {
    workCount: "{count} karya",
    empty: "Belum ada karya untuk dibaca di sini.",
    allWorksTitle: "Semua karya",
    allWorksDescription: "Karya yang saat ini tersedia untuk dibaca.",
    allWorksEmpty: "Belum ada karya yang tersedia untuk umum.",
    genreDescription: "Karya yang dapat Anda baca di koleksi ini.",
    genreEmpty: "Belum ada karya di koleksi ini.",
    categoryTitle: "Novel {name}",
    browseSeoDescription: "Novel yang diterbitkan.",
    categoryEmpty: "Belum ada novel yang diterbitkan di kategori ini.",
  },
  unavailable: {
    unpublishedTitle: "Buku ini untuk sementara tidak tersedia",
    unpublishedBody: "Jika kembali, alamat ini akan tetap berfungsi.",
    takedownTitle: "Buku ini telah ditarik",
    takedownBody: "Atas permintaan pemegang hak, buku ini tidak lagi tersedia di sini.",
    returnHome: "Kembali ke beranda",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artikel dan pembaruan.",
    empty: "Belum ada postingan blog.",
    publishedOn: "Diterbitkan {date}",
    unpublishedTitle: "Postingan ini untuk sementara tidak tersedia",
    unpublishedBody: "Jika kembali, alamat ini akan tetap berfungsi.",
  },
  errorPage: {
    title: "Terjadi kesalahan",
    body: "Halaman ini tidak dapat dimuat. Anda dapat mencoba lagi, atau kembali ke beranda.",
    retry: "Coba lagi",
    digest: "ID kesalahan {digest}",
  },
  notFoundPage: {
    title: "Halaman ini tidak dapat ditemukan",
    body: "Alamatnya mungkin salah, atau halaman ini sudah tidak ada lagi.",
  },
  localeSwitcher: {
    // 书页（详情页、章节页）：逐字照搬 CPS v8.5.1 src/messages/id.json:136。
    fallbackToast: "Judul ini belum tersedia dalam {locale}. Dialihkan ke beranda {locale}.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Halaman ini belum tersedia dalam {locale}. Dialihkan ke beranda {locale}.",
  },
  pagination: {
    previous: "Sebelumnya",
    next: "Berikutnya",
    pageOf: "{current} / {total}",
    label: "Navigasi halaman",
  },
  meta: {
    notFound: "Tidak ditemukan",
    chapterNotFound: "Bab tidak ditemukan",
    siteDescription: "Temukan novel dan mulai membaca bab gratis.",
    homeTitleFallback: "PulseNovel - Temukan novel dan baca buku gratis",
    pageSuffix: " - Halaman {page}",
    categoryDescriptionFallback: "Temukan novel {name} di PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
