import type { LocaleMessages } from "./en";

/**
 * Spanish UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/es.json` (e.g. `common.home`, `header.language`,
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
    home: "Inicio",
    browse: "Todas las obras",
    genres: "Géneros",
    mainNav: "Navegación principal",
    footerNav: "Navegación del pie de página",
    skipToContent: "Saltar al contenido principal",
    openMenu: "Abrir menú",
    closeMenu: "Cerrar menú",
    about: "Acerca de",
    copyright: "Contenido y derechos de autor",
    footerNote: "Añadimos capítulos nuevos con regularidad.",
    language: "Idioma",
  },
  home: {
    works: "Obras",
    viewAll: "Ver todo",
    featuredEyebrow: "Destacado",
    startPreview: "Comenzar a leer",
    viewDetails: "Ver detalles",
    carouselLabel: "Obras destacadas",
    carouselRole: "carrusel",
    switchFeatured: "Cambiar obra destacada",
    slideLabel: "Obra {n}",
    slideStatus: "Obra {n} de {count}: {title}",
    chapterCount: "Capítulos: {count}",
  },
  novel: {
    coverAlt: "{title}",
    tagsLabel: "Etiquetas",
    genreTags: "Etiquetas de género",
    chapterCount: "Capítulos: {count}",
    previewCount: "{count} capítulos disponibles",
    startPreview: "Comenzar a leer",
    readOnUpstream: "Continuar leyendo",
    synopsis: "Sinopsis",
    previewChapters: "Capítulos",
    // 施工工单_I18N_复数能力 §6.2 折键 + §5.1 第二条：es 的 CLDR 类别含 many
    // （仅整百万命中，如 1000000/2000000），门禁要求必须写，文本与 other
    // 分支相同，不是漏翻译。B 组翻译单（2026-09-29）按新英文原文重译。
    previewChaptersDescription:
      "{count, plural, one {1 capítulo gratis para leer ahora.} many {{count} capítulos gratis para leer ahora.} other {{count} capítulos gratis para leer ahora.}}",
    noPreviewChapters: "Aún no hay capítulos para leer.",
    relatedWorks: "Obras relacionadas",
    chapterHeading: "Capítulo {number}",
    // A3/A4/B1 新增键：B 组翻译单（2026-09-29）译入西班牙语，替换英文占位。
    chapterListTitle: "Lista de capítulos",
    chapterListCount: "{count, plural, many {{count} capítulos en total} one {1 capítulo en total} other {{count} capítulos en total}}",
    lockedChapterHint: "Bloqueado: toca para continuar leyendo",
    expandAllChapters: "Mostrar todos los {count} capítulos",
    readMoreChapters: "Leer más capítulos",
    continueReadingModalTitle: "Continuar leyendo",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"aquí"（就在这里）。
    continueReadingModalBody: "Continúa con el capítulo {number} y el resto de la historia.",
    closeDialog: "Cerrar",
    newReleases: "Novedades",
    continueReadingBarLabel: "Barra de continuar leyendo",
  },
  chapter: {
    nav: "Navegación de capítulos",
    previous: "Capítulo anterior",
    next: "Capítulo siguiente",
    firstChapter: "Este es el primer capítulo",
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"gratis"（免费）。
    lastPreviewChapter: "Este es el último capítulo gratis",
    heading: "Capítulo {number}",
    readerSettings: "Ajustes de lectura",
    closeReaderSettings: "Cerrar ajustes de lectura",
    previewPosition: "{index} / {total}",
    endOfPreview: "Esto es todo lo disponible por ahora.",
    continuePrompt: "¿Quieres seguir leyendo?",
    remainingOnOrigin: "Sigue leyendo para continuar la historia.",
    readOnUpstream: "Continuar leyendo",
    theme: "Tema",
    fontSize: "Tamaño de fuente",
    lineHeight: "Interlineado",
    measure: "Ancho de página",
    persistNote: "Los ajustes se guardan en este dispositivo y no se sincronizan entre dispositivos.",
    resetDefaults: "Restablecer valores predeterminados",
    themeSystem: "Igual que el sistema",
    themeLight: "Claro",
    themeDark: "Oscuro",
    lineHeightCompact: "Compacto",
    lineHeightStandard: "Estándar",
    lineHeightRelaxed: "Amplio",
    measureNarrow: "Estrecho",
    measureStandard: "Estándar",
    measureWide: "Ancho",
  },
  collection: {
    // Owner 拍板 2026-09-10: plural ICU (one/many/other), wording unchanged
    // from the prior bare translation — only the singular `Obra` branch is
    // new; `many` shares `other`'s text (same plural noun form in Spanish).
    workCount: "{count, plural, one {Obra: {count}} many {Obras: {count}} other {Obras: {count}}}",
    empty: "Aún no hay obras para leer aquí.",
    allWorksTitle: "Todas las obras",
    allWorksDescription: "Obras disponibles actualmente para leer.",
    allWorksEmpty: "Aún no hay obras disponibles públicamente.",
    genreDescription: "Obras que puedes leer en esta colección.",
    genreEmpty: "Aún no hay obras en esta colección.",
    categoryTitle: "Novelas de {name}",
    browseSeoDescription: "Novelas publicadas.",
    categoryEmpty: "Aún no hay novelas publicadas en esta categoría.",
  },
  unavailable: {
    unpublishedTitle: "Este libro no está disponible temporalmente",
    unpublishedBody: "Si vuelve a estar disponible, esta dirección seguirá funcionando.",
    takedownTitle: "Este libro ha sido retirado",
    takedownBody: "A petición del titular de los derechos, este libro ya no está disponible aquí.",
    returnHome: "Volver al inicio",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artículos y novedades.",
    empty: "Aún no hay publicaciones en el blog.",
    publishedOn: "Publicado el {date}",
    unpublishedTitle: "Esta publicación no está disponible temporalmente",
    unpublishedBody: "Si vuelve a estar disponible, esta dirección seguirá funcionando.",
  },
  errorPage: {
    title: "Se produjo un error",
    body: "No se pudo cargar esta página. Puedes intentarlo de nuevo o volver al inicio.",
    retry: "Intentar de nuevo",
    digest: "ID de error {digest}",
  },
  notFoundPage: {
    title: "No se pudo encontrar esta página",
    body: "Es posible que la dirección sea incorrecta o que esta página ya no exista.",
  },
  localeSwitcher: {
    // 书页（详情页、章节页）：逐字照搬 CPS v8.5.1 src/messages/es.json:136。
    fallbackToast: "Este título aún no está disponible en {locale}. Te llevamos a la página principal en {locale}.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Esta página aún no está disponible en {locale}. Te llevamos a la página principal en {locale}.",
  },
  pagination: {
    previous: "Anterior",
    next: "Siguiente",
    pageOf: "{current} / {total}",
    label: "Paginación",
  },
  meta: {
    notFound: "No encontrado",
    chapterNotFound: "Capítulo no encontrado",
    siteDescription: "Descubre novelas y empieza a leer capítulos gratis.",
    homeTitleFallback: "PulseNovel - Descubre novelas y lee libros gratis",
    pageSuffix: " - Página {page}",
    categoryDescriptionFallback: "Descubre novelas de {name} en PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
