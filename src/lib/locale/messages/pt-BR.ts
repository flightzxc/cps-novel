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
    footerNote: "Novos capítulos são adicionados regularmente.",
    language: "Idioma",
  },
  home: {
    works: "Obras",
    viewAll: "Ver tudo",
    featuredEyebrow: "Destaque",
    startPreview: "Começar a ler",
    viewDetails: "Ver detalhes",
    carouselLabel: "Obras em destaque",
    carouselRole: "carrossel",
    switchFeatured: "Alternar obra em destaque",
    slideLabel: "Obra {n}",
    slideStatus: "Obra {n} de {count}: {title}",
    chapterCount: "Capítulos: {count}",
  },
  novel: {
    coverAlt: "{title}",
    tagsLabel: "Etiquetas",
    genreTags: "Etiquetas de gênero",
    chapterCount: "Capítulos: {count}",
    previewCount: "{count} capítulos disponíveis",
    startPreview: "Começar a ler",
    readOnUpstream: "Continuar lendo",
    synopsis: "Sinopse",
    previewChapters: "Capítulos",
    // 施工工单_I18N_复数能力 §6.2 折键 + §5.1 第二条：pt-BR 的 CLDR 类别含 many
    // （仅整百万命中，如 1000000/2000000），门禁要求必须写，文本与 other
    // 分支相同，不是漏翻译。B 组翻译单（2026-09-29）按新英文原文重译。
    previewChaptersDescription:
      "{count, plural, one {1 capítulo grátis para ler agora.} many {{count} capítulos grátis para ler agora.} other {{count} capítulos grátis para ler agora.}}",
    noPreviewChapters: "Ainda não há capítulos para ler.",
    relatedWorks: "Obras relacionadas",
    chapterHeading: "Capítulo {number}",
    // A3/A4/B1 新增键：B 组翻译单（2026-09-29）译入巴西葡萄牙语，替换英文占位。
    chapterListTitle: "Lista de capítulos",
    chapterListCount: "{count, plural, many {{count} capítulos no total} one {1 capítulo no total} other {{count} capítulos no total}}",
    lockedChapterHint: "Bloqueado — toque para continuar lendo",
    expandAllChapters: "Mostrar todos os {count} capítulos",
    readMoreChapters: "Ler mais capítulos",
    continueReadingModalTitle: "Continuar lendo",
    // GPT 验收后修订（2026-09-29）：随英文 "Continue with Chapter {number} and the rest of the story." 重译；不再说"aqui"（就在这里）。
    continueReadingModalBody: "Continue com o capítulo {number} e o restante da história.",
    closeDialog: "Fechar",
    newReleases: "Lançamentos",
    continueReadingBarLabel: "Barra para continuar lendo",
  },
  chapter: {
    nav: "Navegação de capítulos",
    previous: "Capítulo anterior",
    next: "Próximo capítulo",
    firstChapter: "Este é o primeiro capítulo",
    // GPT 验收后修订（2026-09-29）：随英文 "This is the last free chapter" 补上"grátis"（免费）。
    lastPreviewChapter: "Este é o último capítulo grátis",
    heading: "Capítulo {number}",
    readerSettings: "Configurações de leitura",
    closeReaderSettings: "Fechar configurações de leitura",
    previewPosition: "{index} / {total}",
    endOfPreview: "Isso é tudo que está disponível no momento.",
    continuePrompt: "Quer continuar lendo?",
    remainingOnOrigin: "Continue lendo para acompanhar a história.",
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
    // Owner 拍板 2026-09-10: plural ICU (one/many/other), wording unchanged
    // from the prior bare translation — only the singular `Obra` branch is
    // new; `many` shares `other`'s text (same plural noun form in pt-BR).
    workCount: "{count, plural, one {Obra: {count}} many {Obras: {count}} other {Obras: {count}}}",
    empty: "Ainda não há obras para ler aqui.",
    allWorksTitle: "Todas as obras",
    allWorksDescription: "Obras disponíveis para leitura no momento.",
    allWorksEmpty: "Ainda não há obras disponíveis publicamente.",
    genreDescription: "Obras que você pode ler nesta coleção.",
    genreEmpty: "Ainda não há obras nesta coleção.",
    // 运营 2026-10-08（Owner 追加）：只用于 /browse?category= 的 <title>；与 categoryHeading 同值，
    // 让浏览页和分类页的标题形式一致（旧值 "Romances de {name}" 套短语型分类名会不通顺）。
    categoryTitle: "Romances: {name}",
    // 运营 2026-10-08：前台分类页 H1/<title>/面包屑 = 分类名 + "小说"一词；分类名常是短语。
    // 旧 categoryTitle "Romances de {name}" 套短语名会变 "Romances de Para leitoras"，所以改成冒号隔开。
    categoryHeading: "Romances: {name}",
    browseSeoDescription: "Romances publicados.",
    categoryEmpty: "Ainda não há romances publicados nesta categoria.",
  },
  unavailable: {
    unpublishedTitle: "Este livro está temporariamente indisponível",
    unpublishedBody: "Se retornar, este endereço continuará funcionando.",
    takedownTitle: "Este livro foi retirado",
    takedownBody: "A pedido do detentor dos direitos, este livro não está mais disponível aqui.",
    returnHome: "Voltar ao início",
  },
  blog: {
    listTitle: "Blog",
    listDescription: "Artigos e novidades.",
    empty: "Ainda não há publicações no blog.",
    publishedOn: "Publicado em {date}",
    unpublishedTitle: "Esta publicação está temporariamente indisponível",
    unpublishedBody: "Se retornar, este endereço continuará funcionando.",
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
  localeSwitcher: {
    // 书页（详情页、章节页）：逐字照搬 CPS v8.5.1 src/messages/pt-BR.json:136。
    fallbackToast: "Este título ainda não está disponível em {locale}. Você foi levado para a página inicial em {locale}.",
    // 其它页面（分类页、博客页、404 页、未登记路径）：新键，CPS 无此场景。
    fallbackToastPage: "Esta página ainda não está disponível em {locale}. Você foi levado para a página inicial em {locale}.",
  },
  pagination: {
    previous: "Anterior",
    next: "Próxima",
    pageOf: "{current} / {total}",
    label: "Paginação",
  },
  search: {
    title: "Pesquisar",
    submit: "Pesquisar",
    hintMinLength: "Digite pelo menos {min} caracteres para pesquisar.",
    hintMaxLength: "Digite no máximo {max} caracteres.",
    resultsHeading: "Resultados para \"{query}\"",
    empty: "Nenhum resultado encontrado para \"{query}\".",
    unavailable: "A pesquisa está temporariamente indisponível. Tente novamente mais tarde.",
    metaTitle: "Resultados da busca por “{query}”",
    inputLabel: "Pesquisar romances por título",
    inputPlaceholder: "Pesquisar por título do livro…",
    idle: "Digite o título de um livro para começar a pesquisar.",
    emptyHint: "Tente explorar todas as obras em vez disso.",
    metaDescription: "Resultados da busca por “{query}” no PulseNovel. Descubra romances e comece a ler capítulos grátis.",
  },
  meta: {
    notFound: "Não encontrado",
    chapterNotFound: "Capítulo não encontrado",
    siteDescription: "Descubra romances e comece a ler capítulos grátis.",
    homeTitleFallback: "PulseNovel - Descubra romances e leia livros grátis",
    pageSuffix: " - Página {page}",
    // 运营 2026-10-08（Owner 追加）：分类名是短语时旧句 "Descubra romances de {name} no PulseNovel." 不通顺，用该语种的引号把分类名隔开。
    categoryDescriptionFallback: "Descubra romances da categoria “{name}” no PulseNovel.",
  },
} satisfies LocaleMessages;

export default messages;
