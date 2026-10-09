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
    // แปลรอบที่ 1 ของทีมปฏิบัติการ · กลุ่ม A: ตาม C (Owner ตัดสิน 2026-09-29
    // ให้ตัดคำว่า "เว็บไซต์นี้ / แพลตฟอร์มต้นฉบับ / ตัวอย่าง") แปลใหม่ตาม
    // ต้นฉบับภาษาอังกฤษที่แก้ไขแล้ว ("New chapters are added regularly.")
    // ไม่ใช้คำว่า "เว็บไซต์นี้" หรือ "แพลตฟอร์มต้นฉบับ"
    footerNote: "มีตอนใหม่อัปเดตอย่างสม่ำเสมอ",
    // WO-1 §5.4/§6.4 (new key): the locale switcher's trigger-button aria
    // label. Consumed starting WO-2 — this key only exists so WO-2/WO-3
    // don't both need to touch en.ts (see the work order's rationale).
    language: "ภาษา",
  },
  home: {
    works: "ผลงาน",
    viewAll: "ดูทั้งหมด",
    featuredEyebrow: "แนะนำ",
    // C: "Start preview" → "Start reading" ตัดคำว่า "ตัวอย่าง" ออก
    startPreview: "เริ่มอ่าน",
    viewDetails: "ดูรายละเอียด",
    carouselLabel: "ผลงานแนะนำ",
    carouselRole: "แคโรเซล",
    switchFeatured: "สลับผลงานแนะนำ",
    slideLabel: "ผลงานที่ {n}",
    slideStatus: "ผลงานที่ {n} จาก {count}: {title}",
    chapterCount: "{count} ตอน",
  },
  novel: {
    coverAlt: "{title}",
    tagsLabel: "แท็ก",
    genreTags: "แท็กหมวดหมู่",
    chapterCount: "{count} ตอน",
    // C: ตัดคำว่า "ตัวอย่าง" ออก ตำแหน่ง {count} เหมือนเดิม
    previewCount: "มี {count} ตอนให้อ่าน",
    startPreview: "เริ่มอ่าน",
    readOnUpstream: "อ่านต่อ",
    synopsis: "เรื่องย่อ",
    // คีย์นี้ไม่ถูกอ้างอิงจากคอมโพเนนต์แล้วหลังปรับใช้แนวทาง A3 (หัวข้อ
    // เปลี่ยนไปใช้ chapterListTitle ด้านล่าง) คงค่าไว้เพื่อรักษาชุดคีย์
    // เท่านั้น ปรับตาม C ตัดคำว่า "ตัวอย่าง" ออก
    previewChapters: "ตอน",
    // 施工工单_I18N_复数能力 §6.2 折键：th ของ Intl.PluralRules สามารถ
    // แยกได้แค่หมวด other เท่านั้น (no one category) หมวด one จึงไม่มีทาง
    // ถูกเลือกใน th และจะถูกตัดสินว่าเป็นสาขาส่วนเกินโดยการตรวจสอบความ
    // ครอบคลุมหมวด CLDR ของ门禁——จึงคงไว้เฉพาะสาขา other (มี {count}
    // อยู่แล้ว ถูกต้องตามหลักไวยากรณ์ทุกจำนวน) C: ตัดคำว่า "เว็บไซต์นี้"
    // และ "แพลตฟอร์มต้นฉบับ" ออก พารามิเตอร์/หมวด plural เหมือนเดิม
    previewChaptersDescription: "{count, plural, other {อ่านฟรีได้แล้ว {count} ตอน}}",
    // หลังแยกการเผยแพร่ออกจาก Preview บล็อก "ไม่มีตอน" ทั้งบล็อกไม่ถูก
    // เรนเดอร์แล้ว ไม่มีการอ้างอิง ปรับคำแปลตามความหมายต้นฉบับใหม่ตาม C
    noPreviewChapters: "ยังไม่มีตอนให้อ่าน",
    relatedWorks: "ผลงานที่เกี่ยวข้อง",
    chapterHeading: "ตอนที่ {number}",
    // คีย์ใหม่ A3/B2/A4/B1 · แปลรอบที่ 1 ของทีมปฏิบัติการ กลุ่ม A เสร็จแล้ว
    // หลัก Owner: ห้ามมีความหมาย "เว็บไซต์นี้ / แพลตฟอร์มต้นฉบับ / ตัวอย่าง
    // / พรีวิว" (ถือว่าเว็บไซต์นี้คือเว็บไซต์ทางการ)
    chapterListTitle: "รายการตอน",
    chapterListCount: "{count, plural, other {ทั้งหมด {count} ตอน}}",
    lockedChapterHint: "ล็อกอยู่ — แตะเพื่ออ่านต่อ",
    expandAllChapters: "แสดงทั้งหมด {count} ตอน",
    readMoreChapters: "อ่านตอนเพิ่มเติม",
    continueReadingModalTitle: "อ่านต่อ",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"ที่นี่"（就在这里）。
    continueReadingModalBody: "อ่านต่อตั้งแต่ตอนที่ {number} และเรื่องราวที่เหลือ",
    closeDialog: "ปิด",
    newReleases: "ผลงานใหม่",
    continueReadingBarLabel: "แถบอ่านต่อ",
  },
  chapter: {
    nav: "การนำทางตอน",
    previous: "ตอนก่อนหน้า",
    next: "ตอนถัดไป",
    firstChapter: "นี่คือตอนแรก",
    // C: ตัดคำว่า "ตัวอย่าง" ออก คงรูปประโยคเดียวกับ firstChapter
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"ฟรี"（免费）。
    lastPreviewChapter: "นี่คือตอนฟรีตอนสุดท้าย",
    heading: "ตอนที่ {number}",
    readerSettings: "ตั้งค่าการอ่าน",
    closeReaderSettings: "ปิดการตั้งค่าการอ่าน",
    // C: ตัดคำนำ "ตัวอย่าง" ออก {index}/{total} เหมือนเดิม
    previewPosition: "{index} / {total}",
    // C: ตัดคำว่า "ตัวอย่าง" และ "เว็บไซต์นี้" ออก
    endOfPreview: "ตอนนี้มีเนื้อหาให้อ่านเพียงเท่านี้",
    continuePrompt: "ต้องการอ่านต่อหรือไม่",
    // C: ตัดคำว่า "แพลตฟอร์มต้นฉบับ" ออก
    remainingOnOrigin: "อ่านต่อเพื่อติดตามเรื่องราว",
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
    // C: ตัดคำว่า "บนเว็บไซต์นี้" ออก
    allWorksDescription: "ผลงานที่พร้อมให้อ่านในขณะนี้",
    allWorksEmpty: "ยังไม่มีผลงานที่เปิดให้สาธารณะอ่าน",
    genreDescription: "ผลงานที่คุณสามารถอ่านได้ในคอลเลกชันนี้",
    genreEmpty: "ยังไม่มีผลงานในคอลเลกชันนี้",
    categoryTitle: "นิยาย{name}",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 与 categoryTitle 同形：泰语"นิยาย + 名词/短语"本来就通顺（นิยายสำหรับผู้อ่านหญิง / นิยายแฟนตาซี），不加分隔符。
    categoryHeading: "นิยาย{name}",
    browseSeoDescription: "นิยายที่เผยแพร่แล้ว",
    categoryEmpty: "ยังไม่มีนิยายที่เผยแพร่ในหมวดหมู่นี้",
  },
  unavailable: {
    unpublishedTitle: "หนังสือเล่มนี้ไม่พร้อมให้บริการชั่วคราว",
    // C: ตัดประโยค "ถูกนำออกจากเว็บไซต์นี้แล้ว" ออก คงไว้เฉพาะข้อความที่อยู่
    // ยังใช้งานได้
    unpublishedBody: "หากกลับมา ที่อยู่นี้จะยังใช้งานได้",
    takedownTitle: "หนังสือเล่มนี้ถูกถอดออกแล้ว",
    // C: ตัดคำว่า "เว็บไซต์นี้" ออก
    takedownBody: "ตามคำร้องขอของเจ้าของลิขสิทธิ์ หนังสือเล่มนี้ไม่มีให้บริการที่นี่อีกต่อไป",
    returnHome: "กลับหน้าแรก",
  },
  blog: {
    listTitle: "บล็อก",
    // C: ตัดคำว่า "จากเว็บไซต์นี้" ออก
    listDescription: "บทความและข่าวสาร",
    empty: "ยังไม่มีบทความบล็อก",
    publishedOn: "เผยแพร่เมื่อ {date}",
    unpublishedTitle: "บทความนี้ไม่พร้อมให้บริการชั่วคราว",
    // C: เหตุผลเดียวกับ unavailable.unpublishedBody
    unpublishedBody: "หากกลับมา ที่อยู่นี้จะยังใช้งานได้",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：逐字照搬 CPS v8.5.1 src/messages/th.json:136。
    fallbackToast: "เรื่องนี้ยังไม่มีในภาษา {locale} ระบบพาคุณไปยังหน้าแรกภาษา {locale} แล้ว",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "หน้านี้ยังไม่มีในภาษา {locale} ระบบพาคุณไปยังหน้าแรกภาษา {locale} แล้ว",
  },
  pagination: {
    previous: "ก่อนหน้า",
    next: "ถัดไป",
    pageOf: "{current} / {total}",
    label: "การแบ่งหน้า",
  },
  search: {
    title: "ค้นหา",
    submit: "ค้นหา",
    hintMinLength: "กรอกอย่างน้อย {min} ตัวอักษรเพื่อค้นหา",
    hintMaxLength: "กรอกไม่เกิน {max} ตัวอักษร",
    resultsHeading: "ผลการค้นหาสำหรับ \"{query}\"",
    empty: "ไม่พบผลการค้นหาสำหรับ \"{query}\"",
    unavailable: "ระบบค้นหาไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้งภายหลัง",
    metaTitle: "ผลการค้นหาสำหรับ “{query}”",
    inputLabel: "ค้นหานิยายตามชื่อเรื่อง",
    inputPlaceholder: "ค้นหาตามชื่อเรื่อง…",
    idle: "กรอกชื่อเรื่องเพื่อเริ่มค้นหา",
    emptyHint: "ลองเลือกดูผลงานทั้งหมดแทน",
    metaDescription: "ผลการค้นหาสำหรับ “{query}” บน PulseNovel ค้นพบนิยายและเริ่มอ่านตอนฟรี",
  },
  meta: {
    notFound: "ไม่พบ",
    chapterNotFound: "ไม่พบตอน",
    // C: ตัดคำว่า "ตัวอย่าง" ออก
    siteDescription: "ค้นพบนิยายและเริ่มอ่านตอนฟรี",
    homeTitleFallback: "PulseNovel - ค้นพบนิยายและอ่านหนังสือฟรี",
    pageSuffix: " - หน้า {page}",
    // 第三方（GPT）验收 + Owner 2026-10-09 裁定：บน 前补一个空格，把分类名与后文隔开。
    categoryDescriptionFallback: "ค้นพบนิยาย{name} บน PulseNovel",
  },
} satisfies LocaleMessages;

export default messages;
