import type { LocaleMessages } from "./en";

/**
 * French UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/fr.json` (e.g. `common.home`, `header.language`,
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
    home: "Accueil",
    browse: "Toutes les œuvres",
    genres: "Genres",
    mainNav: "Navigation principale",
    footerNav: "Navigation du pied de page",
    skipToContent: "Passer au contenu principal",
    openMenu: "Ouvrir le menu",
    closeMenu: "Fermer le menu",
    about: "À propos",
    copyright: "Contenu et droits d'auteur",
    footerNote: "Ce site propose gratuitement des chapitres en extrait. L'histoire complète se trouve sur la plateforme d'origine.",
    language: "Langue",
  },
  home: {
    works: "Œuvres",
    viewAll: "Tout voir",
    featuredEyebrow: "À la une",
    startPreview: "Lire l'extrait",
    viewDetails: "Voir les détails",
    carouselLabel: "Œuvres à la une",
    carouselRole: "carrousel",
    switchFeatured: "Changer l'œuvre à la une",
    slideLabel: "Œuvre {n}",
    slideStatus: "Œuvre {n} sur {count} : {title}",
    chapterCount: "Chapitres : {count}",
  },
  novel: {
    coverAlt: "Couverture de {title}",
    tagsLabel: "Étiquettes",
    genreTags: "Étiquettes de genre",
    chapterCount: "Chapitres : {count}",
    previewCount: "Chapitres proposés en extrait : {count}",
    startPreview: "Lire l'extrait",
    readOnUpstream: "Continuer la lecture",
    synopsis: "Résumé",
    previewChapters: "Chapitres proposés en extrait",
    // 施工工单_I18N_复数能力 §6.2 折键（逐字保留，未改写文案）+ §5.1 第二条：fr 的
    // CLDR 类别含 many（仅整百万命中，如 1000000/2000000），门禁要求必须写，
    // 文本与 other 分支相同，不是漏翻译。
    previewChaptersDescription:
      "{count, plural, one {1 chapitre est proposé en extrait sur ce site, fourni par la plateforme d'origine.} many {{count} chapitres sont proposés en extrait sur ce site, tous fournis par la plateforme d'origine.} other {{count} chapitres sont proposés en extrait sur ce site, tous fournis par la plateforme d'origine.}}",
    noPreviewChapters: "Aucun chapitre de ce livre n'est encore proposé en extrait.",
    relatedWorks: "Œuvres associées",
    chapterHeading: "Chapitre {number}",
  },
  chapter: {
    nav: "Navigation des chapitres",
    previous: "Chapitre précédent",
    next: "Chapitre suivant",
    firstChapter: "Ceci est le premier chapitre",
    lastPreviewChapter: "Ceci est le dernier chapitre proposé en extrait",
    heading: "Chapitre {number}",
    readerSettings: "Réglages de lecture",
    closeReaderSettings: "Fermer les réglages de lecture",
    previewPosition: "Extrait {index} / {total}",
    endOfPreview: "C'est la fin de l'extrait sur ce site.",
    continuePrompt: "Envie de continuer la lecture ?",
    remainingOnOrigin: "Les chapitres suivants continuent sur la plateforme d'origine.",
    readOnUpstream: "Continuer la lecture",
    theme: "Thème",
    fontSize: "Taille de police",
    lineHeight: "Interligne",
    measure: "Largeur de page",
    persistNote: "Les réglages sont enregistrés sur cet appareil et ne sont pas synchronisés entre les appareils.",
    resetDefaults: "Rétablir les valeurs par défaut",
    themeSystem: "Suivre le système",
    themeLight: "Clair",
    themeDark: "Sombre",
    lineHeightCompact: "Serré",
    lineHeightStandard: "Normal",
    lineHeightRelaxed: "Aéré",
    measureNarrow: "Étroit",
    measureStandard: "Normal",
    measureWide: "Large",
  },
  collection: {
    // Owner 拍板 2026-09-10: plural ICU (one/many/other), wording unchanged
    // from the prior bare translation — only the singular `Œuvre` branch is
    // new; `many` shares `other`'s text (same plural noun form in French).
    workCount: "{count, plural, one {Œuvre : {count}} many {Œuvres : {count}} other {Œuvres : {count}}}",
    empty: "Aucune œuvre à lire ici pour le moment.",
    allWorksTitle: "Toutes les œuvres",
    allWorksDescription: "Œuvres actuellement disponibles à la lecture sur ce site.",
    allWorksEmpty: "Aucune œuvre publique disponible pour le moment.",
    genreDescription: "Œuvres que vous pouvez lire dans cette collection.",
    genreEmpty: "Aucune œuvre dans cette collection pour le moment.",
    categoryTitle: "Romans {name}",
    browseSeoDescription: "Romans publiés.",
    categoryEmpty: "Aucun roman publié dans cette catégorie pour le moment.",
  },
  unavailable: {
    unpublishedTitle: "Ce livre est temporairement indisponible",
    unpublishedBody: "Il a été retiré de ce site. S'il revient, cette adresse fonctionnera toujours.",
    takedownTitle: "Ce livre a été retiré",
    takedownBody: "À la demande du titulaire des droits, ce site ne propose plus ce livre.",
    returnHome: "Retour à l'accueil",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Articles et actualités de ce site.",
    empty: "Aucun article de blog pour le moment.",
    publishedOn: "Publié le {date}",
    unpublishedTitle: "Cet article est temporairement indisponible",
    unpublishedBody: "Il a été retiré de ce site. S'il revient, cette adresse fonctionnera toujours.",
  },
  errorPage: {
    title: "Un problème est survenu",
    body: "Cette page n'a pas pu être chargée. Vous pouvez réessayer ou retourner à l'accueil.",
    retry: "Réessayer",
    digest: "ID d'erreur {digest}",
  },
  notFoundPage: {
    title: "Cette page est introuvable",
    body: "L'adresse est peut-être incorrecte, ou cette page n'existe plus.",
  },
  pagination: {
    previous: "Précédent",
    next: "Suivant",
    pageOf: "{current} / {total}",
    label: "Pagination",
  },
  meta: {
    notFound: "Introuvable",
    chapterNotFound: "Chapitre introuvable",
    siteDescription: "Découvrez des romans et lisez des extraits.",
  },
} satisfies LocaleMessages;

export default messages;
