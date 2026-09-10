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
    footerNote: "Situs ini menawarkan bab pratinjau gratis. Cerita lengkapnya ada di platform asli.",
    language: "Bahasa",
  },
  home: {
    works: "Karya",
    viewAll: "Lihat Semua",
    featuredEyebrow: "Unggulan",
    startPreview: "Mulai pratinjau",
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
    previewCount: "{count} bab pratinjau",
    startPreview: "Mulai pratinjau",
    readOnUpstream: "Lanjutkan membaca",
    synopsis: "Sinopsis",
    previewChapters: "Bab pratinjau",
    // 施工工单_I18N_复数能力 §6.2 折键：id 的 Intl.PluralRules 只解出 other 一档
    // （no one category），一个 one 分支在 id 永远选不中，会被门禁的 CLDR
    // 类别覆盖检查判为多余分支——因此这里只保留原 previewChaptersDescription
    // 一句（已含 {count}，任意数量下都语法正确），原 …One 的" disediakan"
    // 单数措辞变体停用，不再单独出现。
    previewChaptersDescription:
      "{count, plural, other {{count} bab pratinjau di situs ini, semuanya disediakan oleh platform asli.}}",
    noPreviewChapters: "Buku ini belum memiliki bab pratinjau.",
    relatedWorks: "Karya terkait",
    chapterHeading: "Bab {number}",
  },
  chapter: {
    nav: "Navigasi bab",
    previous: "Bab sebelumnya",
    next: "Bab berikutnya",
    firstChapter: "Ini adalah bab pertama",
    lastPreviewChapter: "Ini adalah bab pratinjau terakhir",
    heading: "Bab {number}",
    readerSettings: "Pengaturan membaca",
    closeReaderSettings: "Tutup pengaturan membaca",
    previewPosition: "Pratinjau {index} / {total}",
    endOfPreview: "Itulah akhir pratinjau di situs ini.",
    continuePrompt: "Ingin terus membaca?",
    remainingOnOrigin: "Bab selanjutnya berlanjut di platform asli.",
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
    allWorksDescription: "Karya yang saat ini tersedia untuk dibaca di situs ini.",
    allWorksEmpty: "Belum ada karya yang tersedia untuk umum.",
    genreDescription: "Karya yang dapat Anda baca di koleksi ini.",
    genreEmpty: "Belum ada karya di koleksi ini.",
    categoryTitle: "Novel {name}",
    browseSeoDescription: "Novel yang diterbitkan.",
    categoryEmpty: "Belum ada novel yang diterbitkan di kategori ini.",
  },
  unavailable: {
    unpublishedTitle: "Buku ini untuk sementara tidak tersedia",
    unpublishedBody: "Buku ini telah dihapus dari situs ini. Jika kembali, alamat ini akan tetap berfungsi.",
    takedownTitle: "Buku ini telah ditarik",
    takedownBody: "Atas permintaan pemegang hak, situs ini tidak lagi menyediakan buku ini.",
    returnHome: "Kembali ke beranda",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artikel dan pembaruan dari situs ini.",
    empty: "Belum ada postingan blog.",
    publishedOn: "Diterbitkan {date}",
    unpublishedTitle: "Postingan ini untuk sementara tidak tersedia",
    unpublishedBody: "Postingan ini telah dihapus dari situs ini. Jika kembali, alamat ini akan tetap berfungsi.",
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
  pagination: {
    previous: "Sebelumnya",
    next: "Berikutnya",
    pageOf: "{current} / {total}",
    label: "Navigasi halaman",
  },
  meta: {
    notFound: "Tidak ditemukan",
    chapterNotFound: "Bab tidak ditemukan",
    siteDescription: "Temukan novel dan baca bab pratinjau.",
  },
} satisfies LocaleMessages;

export default messages;
