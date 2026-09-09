import type { LocaleMessages } from "./en";

/**
 * Brazilian Portuguese UI catalog — WO-3 (2026-09-08 施工工单 §10.2/附录 C).
 *
 * Reuse tiers vs the frozen `en` catalog (see the work order's Appendix C for
 * the full per-key mapping and CPS source key):
 *  - 甲 (verbatim reuse, 11 keys): identical UI words carried over from CPS
 *    `src/messages/pt-BR.json` (e.g. `common.home`, `header.language`,
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
    home: "Início",
    browse: "Todas as obras",
    genres: "Gêneros",
    mainNav: "Navegação principal",
    footerNav: "Navegação do rodapé",
    skipToContent: "Pular para o conteúdo principal",
    openMenu: "Abrir menu",
    closeMenu: "Fechar menu",
    about: "Sobre",
    copyright: "Conteúdo e direitos autorais",
    footerNote: "Este site oferece capítulos de amostra gratuitos. A história completa está na plataforma original.",
    language: "Idioma",
  },
  home: {
    works: "Obras",
    viewAll: "Ver tudo",
    featuredEyebrow: "Destaque",
    startPreview: "Ler amostra",
    viewDetails: "Ver detalhes",
    carouselLabel: "Obras em destaque",
    carouselRole: "carrossel",
    switchFeatured: "Alternar obra em destaque",
    slideLabel: "Obra {n}",
    slideStatus: "Obra {n} de {count}: {title}",
    chapterCount: "Capítulos: {count}",
  },
  novel: {
    coverAlt: "Capa de {title}",
    tagsLabel: "Etiquetas",
    genreTags: "Etiquetas de gênero",
    chapterCount: "Capítulos: {count}",
    previewCount: "Capítulos de amostra: {count}",
    startPreview: "Ler amostra",
    readOnUpstream: "Continuar lendo",
    synopsis: "Sinopse",
    previewChapters: "Capítulos de amostra",
    // 施工工单_I18N_复数能力 §6.2 折键（逐字保留，未改写文案）+ §5.1 第二条：pt-BR 的
    // CLDR 类别含 many（仅整百万命中，如 1000000/2000000），门禁要求必须写，
    // 文本与 other 分支相同，不是漏翻译。
    previewChaptersDescription:
      "{count, plural, one {1 capítulo de amostra neste site, fornecido pela plataforma original.} many {{count} capítulos de amostra neste site, todos fornecidos pela plataforma original.} other {{count} capítulos de amostra neste site, todos fornecidos pela plataforma original.}}",
    noPreviewChapters: "Este livro ainda não tem capítulos de amostra.",
    relatedWorks: "Obras relacionadas",
    chapterHeading: "Capítulo {number}",
  },
  chapter: {
    nav: "Navegação de capítulos",
    previous: "Capítulo anterior",
    next: "Próximo capítulo",
    firstChapter: "Este é o primeiro capítulo",
    lastPreviewChapter: "Este é o último capítulo de amostra",
    heading: "Capítulo {number}",
    readerSettings: "Configurações de leitura",
    closeReaderSettings: "Fechar configurações de leitura",
    previewPosition: "Amostra {index} / {total}",
    endOfPreview: "Aqui termina a amostra neste site.",
    continuePrompt: "Quer continuar lendo?",
    remainingOnOrigin: "Os próximos capítulos continuam na plataforma original.",
    readOnUpstream: "Continuar lendo",
    theme: "Tema",
    fontSize: "Tamanho da fonte",
    lineHeight: "Espaçamento entre linhas",
    measure: "Largura da página",
    persistNote: "As configurações são salvas neste dispositivo e não sincronizam entre dispositivos.",
    resetDefaults: "Restaurar padrões",
    themeSystem: "Igual ao sistema",
    themeLight: "Claro",
    themeDark: "Escuro",
    lineHeightCompact: "Compacto",
    lineHeightStandard: "Padrão",
    lineHeightRelaxed: "Espaçado",
    measureNarrow: "Estreito",
    measureStandard: "Padrão",
    measureWide: "Largo",
  },
  collection: {
    workCount: "Obras: {count}",
    empty: "Ainda não há obras para ler aqui.",
    allWorksTitle: "Todas as obras",
    allWorksDescription: "Obras disponíveis para leitura neste site no momento.",
    allWorksEmpty: "Ainda não há obras disponíveis publicamente.",
    genreDescription: "Obras que você pode ler nesta coleção.",
    genreEmpty: "Ainda não há obras nesta coleção.",
    categoryTitle: "Romances de {name}",
    browseSeoDescription: "Romances publicados.",
    categoryEmpty: "Ainda não há romances publicados nesta categoria.",
  },
  unavailable: {
    unpublishedTitle: "Este livro está temporariamente indisponível",
    unpublishedBody: "Ele foi removido deste site. Se retornar, este endereço continuará funcionando.",
    takedownTitle: "Este livro foi retirado",
    takedownBody: "A pedido do detentor dos direitos, este site não oferece mais este livro. Esta remoção é definitiva.",
    returnHome: "Voltar ao início",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artigos e novidades deste site.",
    empty: "Ainda não há publicações no blog.",
    publishedOn: "Publicado em {date}",
    unpublishedTitle: "Esta publicação está temporariamente indisponível",
    unpublishedBody: "Ela foi removida deste site. Se retornar, este endereço continuará funcionando.",
  },
  errorPage: {
    title: "Ocorreu um erro",
    body: "Não foi possível carregar esta página. Você pode tentar novamente ou voltar ao início.",
    retry: "Tentar novamente",
    digest: "ID do erro {digest}",
  },
  notFoundPage: {
    title: "Esta página não pôde ser encontrada",
    body: "O endereço pode estar incorreto ou esta página não existe mais.",
  },
  pagination: {
    previous: "Anterior",
    next: "Próxima",
    pageOf: "{current} / {total}",
    label: "Paginação",
  },
  meta: {
    notFound: "Não encontrado",
    chapterNotFound: "Capítulo não encontrado",
    siteDescription: "Site de distribuição de romances no exterior",
  },
} satisfies LocaleMessages;

export default messages;
