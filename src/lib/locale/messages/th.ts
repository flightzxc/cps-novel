import type { LocaleMessages } from "./en";

/**
 * Thai UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/th.json` (e.g. `common.home`, `header.language`,
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
    home: "หน้าแรก",
    browse: "ผลงานทั้งหมด",
    genres: "หมวดหมู่",
    mainNav: "เมนูนำทางหลัก",
    footerNav: "เมนูนำทางท้ายหน้า",
    skipToContent: "ข้ามไปยังเนื้อหาหลัก",
    openMenu: "เปิดเมนู",
    closeMenu: "ปิดเมนู",
    about: "เกี่ยวกับ",
    copyright: "เนื้อหาและลิขสิทธิ์",
    footerNote: "เว็บไซต์นี้มีตอนตัวอย่างให้อ่านฟรี เนื้อเรื่องเต็มอยู่บนแพลตฟอร์มต้นฉบับ",
    language: "ภาษา",
  },
  home: {
    works: "ผลงาน",
    viewAll: "ดูทั้งหมด",
    featuredEyebrow: "แนะนำ",
    startPreview: "เริ่มอ่านตัวอย่าง",
    viewDetails: "ดูรายละเอียด",
    carouselLabel: "ผลงานแนะนำ",
    carouselRole: "แคโรเซล",
    switchFeatured: "สลับผลงานแนะนำ",
    slideLabel: "ผลงานที่ {n}",
    slideStatus: "ผลงานที่ {n} จาก {count}: {title}",
    chapterCount: "{count} ตอน",
  },
  novel: {
    coverAlt: "ปก {title}",
    tagsLabel: "แท็ก",
    genreTags: "แท็กหมวดหมู่",
    chapterCount: "{count} ตอน",
    previewCount: "{count} ตอนตัวอย่าง",
    startPreview: "เริ่มอ่านตัวอย่าง",
    readOnUpstream: "อ่านต่อ",
    synopsis: "เรื่องย่อ",
    previewChapters: "ตอนตัวอย่าง",
    previewChaptersDescription: "ตอนตัวอย่าง {count} ตอนบนเว็บไซต์นี้ ทั้งหมดจัดหาโดยแพลตฟอร์มต้นฉบับ",
    noPreviewChapters: "หนังสือเล่มนี้ยังไม่มีตอนตัวอย่าง",
    relatedWorks: "ผลงานที่เกี่ยวข้อง",
    chapterHeading: "ตอนที่ {number}",
  },
  chapter: {
    nav: "การนำทางตอน",
    previous: "ตอนก่อนหน้า",
    next: "ตอนถัดไป",
    firstChapter: "นี่คือตอนแรก",
    lastPreviewChapter: "นี่คือตอนตัวอย่างสุดท้าย",
    heading: "ตอนที่ {number}",
    readerSettings: "ตั้งค่าการอ่าน",
    closeReaderSettings: "ปิดการตั้งค่าการอ่าน",
    previewPosition: "ตัวอย่าง {index} / {total}",
    endOfPreview: "นี่คือจุดสิ้นสุดของตัวอย่างบนเว็บไซต์นี้",
    continuePrompt: "ต้องการอ่านต่อหรือไม่",
    remainingOnOrigin: "ตอนถัดไปมีต่อบนแพลตฟอร์มต้นฉบับ",
    readOnUpstream: "อ่านต่อ",
    theme: "ธีม",
    fontSize: "ขนาดตัวอักษร",
    lineHeight: "ระยะห่างบรรทัด",
    measure: "ความกว้างหน้า",
    persistNote: "การตั้งค่าจะถูกบันทึกไว้บนอุปกรณ์นี้และจะไม่ซิงค์ข้ามอุปกรณ์",
    resetDefaults: "รีเซ็ตเป็นค่าเริ่มต้น",
    themeSystem: "ตามระบบ",
    themeLight: "สว่าง",
    themeDark: "มืด",
    lineHeightCompact: "แน่น",
    lineHeightStandard: "มาตรฐาน",
    lineHeightRelaxed: "หลวม",
    measureNarrow: "แคบ",
    measureStandard: "มาตรฐาน",
    measureWide: "กว้าง",
  },
  collection: {
    workCount: "{count} ผลงาน",
    empty: "ยังไม่มีผลงานให้อ่านที่นี่",
    allWorksTitle: "ผลงานทั้งหมด",
    allWorksDescription: "ผลงานที่พร้อมให้อ่านบนเว็บไซต์นี้ในขณะนี้",
    allWorksEmpty: "ยังไม่มีผลงานที่เปิดให้สาธารณะอ่าน",
    genreDescription: "ผลงานที่คุณสามารถอ่านได้ในคอลเลกชันนี้",
    genreEmpty: "ยังไม่มีผลงานในคอลเลกชันนี้",
    categoryTitle: "นิยาย{name}",
    browseSeoDescription: "นิยายที่เผยแพร่แล้ว",
    categoryEmpty: "ยังไม่มีนิยายที่เผยแพร่ในหมวดหมู่นี้",
  },
  unavailable: {
    unpublishedTitle: "หนังสือเล่มนี้ไม่พร้อมให้บริการชั่วคราว",
    unpublishedBody: "หนังสือเล่มนี้ถูกนำออกจากเว็บไซต์นี้แล้ว หากกลับมา ที่อยู่นี้จะยังใช้งานได้",
    takedownTitle: "หนังสือเล่มนี้ถูกถอดออกแล้ว",
    takedownBody: "ตามคำร้องขอของเจ้าของลิขสิทธิ์ เว็บไซต์นี้จะไม่ให้บริการหนังสือเล่มนี้อีกต่อไป การถอดออกนี้ถาวร",
    returnHome: "กลับหน้าแรก",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "บทความและข่าวสารจากเว็บไซต์นี้",
    empty: "ยังไม่มีบทความบล็อก",
    publishedOn: "เผยแพร่เมื่อ {date}",
    unpublishedTitle: "บทความนี้ไม่พร้อมให้บริการชั่วคราว",
    unpublishedBody: "บทความนี้ถูกนำออกจากเว็บไซต์นี้แล้ว หากกลับมา ที่อยู่นี้จะยังใช้งานได้",
  },
  errorPage: {
    title: "เกิดข้อผิดพลาด",
    body: "ไม่สามารถโหลดหน้านี้ได้ คุณสามารถลองใหม่หรือกลับหน้าแรก",
    retry: "ลองใหม่",
    digest: "รหัสข้อผิดพลาด {digest}",
  },
  notFoundPage: {
    title: "ไม่พบหน้านี้",
    body: "ที่อยู่อาจไม่ถูกต้อง หรือหน้านี้ไม่มีอยู่แล้ว",
  },
  pagination: {
    previous: "ก่อนหน้า",
    next: "ถัดไป",
    pageOf: "{current} / {total}",
    label: "การแบ่งหน้า",
  },
  meta: {
    notFound: "ไม่พบ",
    chapterNotFound: "ไม่พบตอน",
    siteDescription: "เว็บไซต์เผยแพร่นิยายในต่างประเทศ",
  },
} satisfies LocaleMessages;

export default messages;
