/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.1). Batch-rebind
 * PREVIEW: bounded scan, bipartite (locale, title_normalized, 来源应用) pairing,
 * set-based (never N+1) guard evaluation reusing `./guards.ts`'s
 * `classifyRebindGuardFindings` — the exact same pure decision function the
 * single-article path's `evaluateRebindGuards` calls — and a frozen,
 * hashed, TTL-bounded snapshot row.
 *
 * CPS parity map (施工工单 §3.1/§3.2):
 *   - `classifyArticlesAgainstBipartite`/`findTargetsForArticle`/
 *     `buildTheaterIndexedDests` — ported verbatim in shape, "theater"
 *     renamed 来源应用 (`SourceApp.code`), "syncSource" renamed 渠道
 *     (`Channel.code`), theater evidence sourced from
 *     `NovelSourceItem.channelApp.{channel,sourceApp}` (one loader, not
 *     CPS's two — 施工工单 §2.3 item 8).
 *   - `buildDurableBatchFacets`/`loadDurableSourceUniverse`/
 *     `loadRelevantDurableDestinations` — adapted field-for-field.
 *   - `buildDurableUniqueRiskRows` — NOT ported as a bespoke risk-only
 *     query. 海阅 has no CPS-style "eligibility pre-filter that is not a
 *     guard" (CPS's `isTargetEligible` folds deletedAt/status/rights/promo-
 *     presence into "skipped(ineligible)" separately from "risk" title_
 *     mismatch/hreflang/duplicate_page). This module instead calls the
 *     SAME nine-guard classifier the single-article path uses, once per
 *     bulk-resolved candidate pair — see this file's own
 *     `buildCandidateGuardFacts`. A category simplification follows from
 *     that: ANY non-`ok` guard level (`blocked` OR `needs_ack`) maps to
 *     `risk_blocked` (matching CPS's own `riskLevel === "ok" ? executable :
 *     risk_blocked`); `skipped` is reserved for genuinely zero-candidate
 *     (bipartite-unresolved) rows only. This is a deliberate simplification
 *     (not in the construction order's 🔴 list), made because Appendix D's
 *     guard table itself treats guards 4/6/7/8 uniformly as `blocked` and
 *     guard 9 as `needs_ack` with no third tier — inventing a CPS-style
 *     ineligible/risk split here would not correspond to anything in that
 *     table and would risk the exact "两套判定漂移" this order explicitly
 *     warns against (§4B.5's "🔴 集合化守卫与单篇守卫逐条相同").
 *   - `createDurablePreviewSnapshotWithRetry`/
 *     `classifyPreviewSnapshotCreateError` — NOT ported (SQLite-specific,
 *     施工工单 §2.4). Replaced by this repo's own `withDbRetry`
 *     (`@/lib/db/db-retry`), which already classifies PostgreSQL P1008/
 *     P2034/transient-message failures.
 *   - `cleanupExpiredBatchSwitchPreviews` — ported verbatim (row + time
 *     double-bound).
 *
 * Snapshot JSON shape: unlike CPS's `{schemaVersion, rows}` envelope (its
 * `schemaVersion` field exists to let one column's parser branch between two
 * *historical* shapes), this repo tracks JSONB schema versions in a
 * dedicated sibling column per §9 of `docs/governance/database-governance.md`
 * (`matches_json_schema_version`/`filters_json_schema_version`, both
 * `DEFAULT 1` — `prisma/migrations/20260911090000_c30_novel_rebind_foundation/
 * migration.sql`). There is no second, older shape to distinguish inside the
 * JSON itself, so `matchesJson`/`filtersJson` below carry no internal
 * `schemaVersion` field of their own — the sibling column IS the version
 * registry, and it is written as `1` (order 1's own default, never bumped
 * since this is the only shape that has ever existed).
 */
import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { withDbRetry } from "@/lib/db/db-retry";
import { isArticleNovelRebindEnabled } from "@/lib/flags";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { SITE_LOCALE_LABELS } from "@/lib/locale/locale-canonical";

import { REBIND_BATCH_LIMITS, type RebindPreviewCategory } from "./batch-constants";
import { rebindBatchDomainError } from "./errors";
import {
  classifyRebindGuardFindings,
  pickReadyPromoLink,
  type PromoLinkCandidate,
  type RebindGuardFinding,
  type RebindTargetNovel,
} from "./guards";
import { RebindFeatureDisabledError } from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DelegateArgs = any;

/**
 * Loosely-typed Prisma delegate subset, same "wide enough for every call
 * site here, `any` on individual query args/selects" convention
 * `./service.ts`'s `ArticleRebindTxClient` and `./guards.ts`'s
 * `RebindGuardDb` already use — this module is exercised against both an
 * injected in-memory fake (unit tests) and the generated Prisma client.
 */
export type RebindPreviewDb = {
  channel: { findMany(args: DelegateArgs): Promise<Array<{ id: string; code: string; name: string }>> };
  sourceApp: { findMany(args: DelegateArgs): Promise<Array<{ id: string; code: string; name: string }>> };
  novelSourceItem: {
    findMany(args: DelegateArgs): Promise<DelegateArgs[]>;
  };
  article: {
    count(args: DelegateArgs): Promise<number>;
    findMany(args: DelegateArgs): Promise<DelegateArgs[]>;
    groupBy(args: DelegateArgs): Promise<DelegateArgs[]>;
  };
  novel: { findMany(args: DelegateArgs): Promise<RebindTargetNovel[]> };
  promoLink: { findMany(args: DelegateArgs): Promise<PromoLinkCandidate[]> };
  articleNovelRebindPreview: {
    create(args: DelegateArgs): Promise<DelegateArgs>;
    findUnique(args: DelegateArgs): Promise<DelegateArgs | null>;
    findMany(args: DelegateArgs): Promise<DelegateArgs[]>;
    deleteMany(args: DelegateArgs): Promise<{ count: number }>;
  };
};

const SQL_BIND_CHUNK_SIZE = 500;

function trimText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function chunked<T>(values: readonly T[], size = SQL_BIND_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * "剧场证据" (施工工单 §2.3 item 8): the set of `SourceApp.code` values a
 * Novel is associated with under one Channel, derived from
 * `NovelSourceItem.channelApp.{channel,sourceApp}` — ONE loader for both
 * source- and target-side evidence (CPS needs two: a 北斗-specific prefix-
 * table loader and a 畅读relation-chain loader; this repo has only the
 * relation chain).
 */
async function loadTheaterEvidence(
  db: RebindPreviewDb,
  channelCode: string,
  novelIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const evidence = new Map<string, Set<string>>();
  if (novelIds.length === 0) return evidence;
  for (const chunk of chunked(novelIds)) {
    const rows = await db.novelSourceItem.findMany({
      where: {
        novelId: { in: chunk },
        deletedAt: null,
        channelApp: { channel: { code: channelCode } },
      },
      select: {
        novelId: true,
        channelApp: { select: { sourceApp: { select: { code: true } } } },
      },
    });
    for (const row of rows as Array<{ novelId: string | null; channelApp: { sourceApp: { code: string } } }>) {
      if (!row.novelId) continue;
      const code = trimText(row.channelApp.sourceApp.code);
      if (!code) continue;
      const set = evidence.get(row.novelId) ?? new Set<string>();
      set.add(code);
      evidence.set(row.novelId, set);
    }
  }
  return evidence;
}

function identityKey(locale: string, titleNormalized: string): string {
  return `${locale}\u0000${titleNormalized}`;
}

function theaterIndexKey(locale: string, titleNormalized: string, sourceApp: string): string {
  return `${identityKey(locale, titleNormalized)}\u0000${sourceApp}`;
}

export type RebindSourceArticle = {
  id: string;
  novelId: string;
  locale: string;
  status: string;
  novel: RebindTargetNovel & { titleNormalized: string | null };
};

/** CPS parity: `buildTheaterIndexedDests`. */
function buildTheaterIndexedDests(
  destNovels: readonly RebindTargetNovel[],
  destTitleNormalized: Map<string, string>,
  theaterEvidence: Map<string, Set<string>>,
): Map<string, RebindTargetNovel[]> {
  const index = new Map<string, RebindTargetNovel[]>();
  for (const novel of destNovels) {
    const theaters = theaterEvidence.get(novel.id);
    if (!theaters || theaters.size === 0) continue;
    const titleNormalized = destTitleNormalized.get(novel.id);
    if (!titleNormalized) continue;
    for (const theater of theaters) {
      const key = theaterIndexKey(novel.locale, titleNormalized, theater);
      const list = index.get(key) ?? [];
      list.push(novel);
      index.set(key, list);
    }
  }
  return index;
}

/** CPS parity: `findTargetsForArticle`. */
function findTargetsForArticle(
  article: RebindSourceArticle,
  sourceTheaterEvidence: Map<string, Set<string>>,
  destIndex: Map<string, RebindTargetNovel[]>,
): RebindTargetNovel[] {
  const sourceTheaters = sourceTheaterEvidence.get(article.novelId);
  const titleNormalized = trimText(article.novel.titleNormalized);
  if (!sourceTheaters || sourceTheaters.size === 0 || !titleNormalized) return [];
  const byId = new Map<string, RebindTargetNovel>();
  for (const theater of sourceTheaters) {
    const key = theaterIndexKey(article.locale, titleNormalized, theater);
    for (const target of destIndex.get(key) ?? []) {
      if (target.id === article.novelId) continue;
      byId.set(target.id, target);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type ClassifiedArticle = {
  article: RebindSourceArticle;
  targets: RebindTargetNovel[];
  uniqueTarget: RebindTargetNovel | null;
  kind: "unique" | "ambiguous" | "skipped";
};

/** CPS parity: `classifyArticlesAgainstBipartite` — "唯一匹配 + 反向度数为 1 才算唯一". */
function classifyArticlesAgainstBipartite(
  articles: readonly RebindSourceArticle[],
  sourceTheaterEvidence: Map<string, Set<string>>,
  destIndex: Map<string, RebindTargetNovel[]>,
): ClassifiedArticle[] {
  const edgesByArticle = new Map<string, RebindTargetNovel[]>();
  const reverseDegree = new Map<string, number>();
  for (const article of articles) {
    const targets = findTargetsForArticle(article, sourceTheaterEvidence, destIndex);
    edgesByArticle.set(article.id, targets);
    for (const target of targets) reverseDegree.set(target.id, (reverseDegree.get(target.id) ?? 0) + 1);
  }
  return articles.map((article) => {
    const targets = edgesByArticle.get(article.id) ?? [];
    if (targets.length === 0) return { article, targets, uniqueTarget: null, kind: "skipped" as const };
    if (targets.length > 1) return { article, targets, uniqueTarget: null, kind: "ambiguous" as const };
    const uniqueTarget = targets[0]!;
    if ((reverseDegree.get(uniqueTarget.id) ?? 0) !== 1) {
      return { article, targets, uniqueTarget: null, kind: "ambiguous" as const };
    }
    return { article, targets, uniqueTarget, kind: "unique" as const };
  });
}

export type RebindPreviewSnapshotRow = {
  category: RebindPreviewCategory;
  articleId: string;
  oldNovelId: string;
  targetNovelId: string | null;
  targetPromoLinkId: string | null;
  sourceApps: string[];
  targetApps: string[];
  findings: RebindGuardFinding[];
  conflictArticle: { articleId: string; title: string; locale: string } | null;
  candidateNovelIds: string[];
  candidateCount: number;
  candidatesTruncated: boolean;
  skipReason: "unresolved" | null;
};

export type RebindPreviewSnapshot = {
  rows: RebindPreviewSnapshotRow[];
};

export type RebindPreviewFilters = {
  locale: string;
  sourceApp?: string;
};

/** CPS parity: `buildDurableUniqueRiskRows`, but calling the shared nine-guard classifier instead of a bespoke risk-only query — see this file's header. */
async function buildCandidateFindings(
  db: RebindPreviewDb,
  filters: RebindPreviewFilters,
  candidates: ReadonlyArray<{ article: RebindSourceArticle; target: RebindTargetNovel }>,
): Promise<
  Map<
    string,
    {
      level: "ok" | "needs_ack" | "blocked";
      findings: RebindGuardFinding[];
      resolvedPromoLinkId: string | null;
      conflictArticle: { articleId: string; title: string; locale: string } | null;
    }
  >
> {
  const result = new Map<
    string,
    {
      level: "ok" | "needs_ack" | "blocked";
      findings: RebindGuardFinding[];
      resolvedPromoLinkId: string | null;
      conflictArticle: { articleId: string; title: string; locale: string } | null;
    }
  >();
  if (candidates.length === 0) return result;

  const targetNovelIds = [...new Set(candidates.map((row) => row.target.id))];
  const sourceNovelIds = [...new Set(candidates.map((row) => row.article.novelId))];

  // Guard 7's fact, bulk: every ready PromoLink for every candidate target,
  // pre-sorted `fetchedAt DESC, id ASC` (施工工单 §4A.6) so `pickReadyPromoLink`
  // can apply the exact same pick per group `resolveTargetPromoLink` (the
  // single-row path, `./guards.ts`) applies per call. Chunked like every
  // other bulk `{ in: [...] } }` lookup in this file (C-30 施工单2复核 §6.3
  // item 1 — this call was the odd one out, unchunked while
  // `loadTheaterEvidence`/`loadRelevantDestinations` both already chunk).
  // `targetNovelIds.length` is bounded by `REBIND_BATCH_LIMITS.candidate`
  // (1,600 today, checked by this function's only caller BEFORE it calls
  // in — see `buildRebindBatchPreview`'s own `CANDIDATE_CEILING_EXCEEDED`
  // check), well under the repo's 5,000 unchunked-`in` convention, but
  // chunking here keeps this call consistent with its siblings and stays
  // correct if `candidate` is ever raised. Per-chunk ordering is preserved:
  // chunks partition `targetNovelIds` into disjoint id sets, so every row
  // for a given novelId still arrives from exactly one chunk query, sorted
  // `fetchedAt DESC, id ASC` within that query same as before.
  const promoRows: Array<PromoLinkCandidate & { novelId: string }> = [];
  for (const chunk of chunked(targetNovelIds)) {
    const rows = await db.promoLink.findMany({
      where: { novelId: { in: chunk }, status: "fetched", deletedAt: null },
      select: { id: true, novelId: true, status: true, webUrl: true, appUrl: true, fetchedAt: true },
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
    });
    promoRows.push(...(rows as Array<PromoLinkCandidate & { novelId: string }>));
  }
  const promoByNovel = new Map<string, PromoLinkCandidate[]>();
  for (const row of promoRows) {
    const list = promoByNovel.get(row.novelId) ?? [];
    list.push(row);
    promoByNovel.set(row.novelId, list);
  }
  const resolvedPromoByNovel = new Map<string, string | null>();
  for (const novelId of targetNovelIds) {
    resolvedPromoByNovel.set(novelId, pickReadyPromoLink(promoByNovel.get(novelId) ?? [])?.id ?? null);
  }

  // Guard 8's fact, bulk: 🔴 no `deletedAt: null` — an existing Article at
  // (targetNovelId, filters.locale), soft-deleted or not, still occupies the
  // slot (`docs/governance/database-governance.md` §5 item 22). Chunked —
  // same rationale as the promoLink query above.
  const occupyingRows: Array<{ id: string; title: string; locale: string; novelId: string | null }> = [];
  for (const chunk of chunked(targetNovelIds)) {
    const rows = await db.article.findMany({
      where: { novelId: { in: chunk }, locale: filters.locale },
      select: { id: true, title: true, locale: true, novelId: true },
    });
    occupyingRows.push(...(rows as Array<{ id: string; title: string; locale: string; novelId: string | null }>));
  }
  const conflictByTargetNovel = new Map<string, { articleId: string; title: string; locale: string }>();
  for (const row of occupyingRows) {
    if (!row.novelId) continue;
    if (!conflictByTargetNovel.has(row.novelId)) {
      conflictByTargetNovel.set(row.novelId, { articleId: row.id, title: row.title, locale: row.locale });
    }
  }

  // Guard 9's fact, bulk: does the SOURCE (current) Novel have another
  // published, non-deleted Article outside `filters.locale`? Independent of
  // the target — a property of the article's own current binding.
  //
  // 🔴 Bound (C-30 施工单2复核 §6.3 item 2): without `distinct`, this query's
  // worst case is `sourceNovelIds.length × (site locale count − 1)` rows —
  // ≈22,400 for 1,600 source novels across ~15 site locales — because a
  // source novel can have one sibling Article per OTHER locale. Only the
  // SET of novelIds that have >=1 such sibling is ever consulted below
  // (`siblingNovelIds.has(...)`), so `distinct: ["novelId"]` pushes that
  // dedup into the query itself: it caps the rows THIS query can return at
  // `sourceNovelIds.length` (≤ `REBIND_BATCH_LIMITS.candidate`, 1,600 today
  // — already enforced by this function's caller, see the promoLink comment
  // above), same order of magnitude as every other bulk lookup in this
  // function and structurally incapable of the 22k blowup regardless of how
  // many locales the site adds. No separate truncation/rejection branch is
  // needed: the bound is a property of `distinct` (rows ≤ distinct input
  // ids), not a runtime check that could silently drop data.
  const siblingRows: Array<{ novelId: string | null }> = [];
  for (const chunk of chunked(sourceNovelIds)) {
    const rows = await db.article.findMany({
      where: { novelId: { in: chunk }, locale: { not: filters.locale }, status: "published", deletedAt: null },
      select: { novelId: true },
      distinct: ["novelId"],
    });
    siblingRows.push(...(rows as Array<{ novelId: string | null }>));
  }
  const siblingNovelIds = new Set(
    siblingRows.map((row) => row.novelId).filter((id): id is string => Boolean(id)),
  );

  for (const { article, target } of candidates) {
    const evaluation = classifyRebindGuardFindings({
      articleId: article.id,
      articleType: "novel_article",
      articleLocale: article.locale,
      articleStatus: article.status,
      currentNovelId: article.novelId,
      expectedOldNovelId: article.novelId,
      targetNovelId: target.id,
      targetNovel: target,
      resolvedPromoLinkId: resolvedPromoByNovel.get(target.id) ?? null,
      targetLocaleOccupied: conflictByTargetNovel.has(target.id),
      crossLocaleSiblingExists: siblingNovelIds.has(article.novelId),
    });
    result.set(article.id, {
      level: evaluation.level,
      findings: [...evaluation.findings],
      resolvedPromoLinkId: evaluation.resolvedPromoLinkId,
      conflictArticle: conflictByTargetNovel.get(target.id) ?? null,
    });
  }
  return result;
}

const ARTICLE_SOURCE_SELECT = {
  id: true,
  novelId: true,
  locale: true,
  status: true,
  novel: { select: { id: true, title: true, titleNormalized: true, locale: true, status: true, deletedAt: true } },
} as const;

async function loadSourceUniverse(
  db: RebindPreviewDb,
  sourceChannelCode: string,
  locale: string,
): Promise<{ count: number; articles: RebindSourceArticle[] }> {
  const where = {
    articleType: "novel_article",
    status: "published",
    deletedAt: null,
    locale,
    novel: { is: { sourceItems: { some: { deletedAt: null, channelApp: { channel: { code: sourceChannelCode } } } } } },
  };
  const count = await db.article.count({ where });
  if (count === 0) rebindBatchDomainError("INVALID_LOCALE", "locale has no eligible source articles");
  if (count > REBIND_BATCH_LIMITS.sourceScan) {
    rebindBatchDomainError("SOURCE_SCAN_CEILING_EXCEEDED", `source universe contains ${count} articles`);
  }
  const rows = await db.article.findMany({
    where,
    select: ARTICLE_SOURCE_SELECT,
    orderBy: { id: "asc" },
    take: REBIND_BATCH_LIMITS.sourceScan + 1,
  });
  if (rows.length > REBIND_BATCH_LIMITS.sourceScan) rebindBatchDomainError("SOURCE_SCAN_CEILING_EXCEEDED");
  return { count, articles: rows as RebindSourceArticle[] };
}

async function loadRelevantDestinations(
  db: RebindPreviewDb,
  targetChannelCode: string,
  locale: string,
  sourceArticles: readonly RebindSourceArticle[],
): Promise<RebindTargetNovel[]> {
  const titles = [...new Set(sourceArticles.map((article) => trimText(article.novel.titleNormalized)).filter(Boolean))].sort();
  const byId = new Map<string, RebindTargetNovel>();
  const ceiling = REBIND_BATCH_LIMITS.destinationScan;
  for (const chunk of chunked(titles)) {
    const remaining = ceiling - byId.size;
    if (remaining <= 0) rebindBatchDomainError("DESTINATION_SCAN_CEILING_EXCEEDED");
    const rows = await db.novel.findMany({
      where: {
        deletedAt: null,
        locale,
        titleNormalized: { in: chunk },
        sourceItems: { some: { deletedAt: null, channelApp: { channel: { code: targetChannelCode } } } },
      },
      select: { id: true, title: true, locale: true, status: true, deletedAt: true, titleNormalized: true },
      orderBy: { id: "asc" },
      take: remaining + 1,
    });
    for (const row of rows) byId.set(row.id, row);
    if (byId.size > ceiling) rebindBatchDomainError("DESTINATION_SCAN_CEILING_EXCEEDED");
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export type RebindFacet = { value: string; label: string; count: number };

export type RebindBatchFacets = {
  channels: RebindFacet[];
  locales: RebindFacet[];
  sourceApps: RebindFacet[];
  selectedLocale: string | null;
  selectedLocaleSourceCount: number | null;
  sourceCeiling: number;
  previewAllowed: boolean;
};

/**
 * CPS parity: `buildDurableBatchFacets`. Channels come from a live query
 * ("界面上方向选择器只列已登记渠道", 施工工单 §2.3 item 1) rather than a
 * hardcoded pair — this repo has one registered channel today
 * (`scripts/register-moboreader-foundation.ts`), unlike CPS's fixed
 * beidou/changdu pair.
 */
export async function buildRebindBatchFacets(
  dbClient: PrismaClient | RebindPreviewDb,
  input: { sourceChannelCode: string; targetChannelCode: string; locale?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindBatchFacets> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  const db = dbClient as unknown as RebindPreviewDb;
  const channelRows = await db.channel.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true } });
  const channels: RebindFacet[] = channelRows
    .map((row) => ({ value: row.code, label: row.name, count: 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const grouped = (await db.article.groupBy({
    by: ["locale"],
    where: {
      articleType: "novel_article",
      status: "published",
      deletedAt: null,
      novel: { is: { sourceItems: { some: { deletedAt: null, channelApp: { channel: { code: input.sourceChannelCode } } } } } },
    },
    _count: { _all: true },
    orderBy: { locale: "asc" },
  })) as Array<{ locale: string; _count: { _all: number } }>;
  const locales: RebindFacet[] = grouped
    .map((row) => ({
      value: row.locale,
      label: `${SITE_LOCALE_LABELS[row.locale as SiteLocale] ?? row.locale} (${row.locale})`,
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const selectedLocale = trimText(input.locale) || null;
  const selectedFacet = selectedLocale ? locales.find((facet) => facet.value === selectedLocale) ?? null : null;
  if (selectedLocale && !selectedFacet) {
    rebindBatchDomainError("INVALID_LOCALE", "locale is not available for this source channel");
  }
  if (!selectedFacet) {
    return {
      channels,
      locales,
      sourceApps: [],
      selectedLocale,
      selectedLocaleSourceCount: null,
      sourceCeiling: REBIND_BATCH_LIMITS.sourceScan,
      previewAllowed: false,
    };
  }

  const previewAllowed = selectedFacet.count <= REBIND_BATCH_LIMITS.sourceScan;
  if (!previewAllowed) {
    return {
      channels,
      locales,
      sourceApps: [],
      selectedLocale,
      selectedLocaleSourceCount: selectedFacet.count,
      sourceCeiling: REBIND_BATCH_LIMITS.sourceScan,
      previewAllowed: false,
    };
  }

  const source = await loadSourceUniverse(db, input.sourceChannelCode, selectedFacet.value);
  const registeredApps = await db.sourceApp.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true } });
  const evidence = await loadTheaterEvidence(
    db,
    input.sourceChannelCode,
    source.articles.map((article) => article.novelId),
  );
  const counts = new Map<string, number>();
  for (const article of source.articles) {
    for (const code of evidence.get(article.novelId) ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const labelByCode = new Map(registeredApps.map((app) => [trimText(app.code), trimText(app.name) || trimText(app.code)]));
  const sourceApps: RebindFacet[] = [...counts.entries()]
    .map(([value, count]) => ({ value, label: `${labelByCode.get(value) ?? value} (${value})`, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    channels,
    locales,
    sourceApps,
    selectedLocale,
    selectedLocaleSourceCount: selectedFacet.count,
    sourceCeiling: REBIND_BATCH_LIMITS.sourceScan,
    previewAllowed: true,
  };
}

export type RebindBatchSummary = {
  previewId: string;
  sourceChannelCode: string;
  targetChannelCode: string;
  filters: RebindPreviewFilters;
  sourceScanned: number;
  matchedCount: number;
  executableCount: number;
  riskBlockedCount: number;
  ambiguousCount: number;
  skippedCount: number;
  expiresAt: string;
};

export type BuildRebindPreviewInput = {
  sourceChannelCode: string;
  targetChannelCode: string;
  locale: string;
  sourceApp?: string;
  createdBy: string;
};

/**
 * CPS parity: `buildDurableBatchSummary`. Scans the bounded source universe,
 * resolves relevant destinations, classifies via the bipartite pairing,
 * runs the shared nine-guard classifier over every unique-matched pair in
 * bulk, freezes the result into one hashed, TTL-bounded snapshot row, and
 * returns the four-category summary.
 *
 * 🔴 Preview single-gate exception (`src/lib/flags/feature-flags.ts`'s own
 * header comment, 施工工单 §4A.5): only `FEATURE_ARTICLE_NOVEL_REBIND` is
 * checked here — NOT `ARTICLE_NOVEL_REBIND_ALLOW_WRITE`. This function does
 * write one `article_novel_rebind_preview` row, but never touches
 * `Article.novelId`/`promoLinkId`.
 */
export async function buildRebindBatchPreview(
  dbClient: PrismaClient | RebindPreviewDb,
  input: BuildRebindPreviewInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindBatchSummary> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  const db = dbClient as unknown as RebindPreviewDb;
  const locale = trimText(input.locale);
  if (!locale) rebindBatchDomainError("INVALID_LOCALE", "locale is required");
  const filters: RebindPreviewFilters = { locale, sourceApp: trimText(input.sourceApp) || undefined };

  const source = await loadSourceUniverse(db, input.sourceChannelCode, locale);
  const destinations = await loadRelevantDestinations(db, input.targetChannelCode, locale, source.articles);
  const destTitleNormalized = new Map(destinations.map((novel) => [novel.id, trimText((novel as { titleNormalized?: string | null }).titleNormalized)]));
  const sourceTheaterEvidence = await loadTheaterEvidence(db, input.sourceChannelCode, source.articles.map((a) => a.novelId));
  const destTheaterEvidence = await loadTheaterEvidence(db, input.targetChannelCode, destinations.map((n) => n.id));

  if (filters.sourceApp) {
    const appExists = source.articles.some((article) => sourceTheaterEvidence.get(article.novelId)?.has(filters.sourceApp!));
    if (!appExists) rebindBatchDomainError("INVALID_SOURCE_APP", "sourceApp is not available for this source channel and locale");
  }

  const destIndex = buildTheaterIndexedDests(destinations, destTitleNormalized, destTheaterEvidence);
  const classified = classifyArticlesAgainstBipartite(source.articles, sourceTheaterEvidence, destIndex);

  const rows: RebindPreviewSnapshotRow[] = [];
  const candidates: Array<{ article: RebindSourceArticle; target: RebindTargetNovel }> = [];
  for (const entry of classified) {
    const sourceApps = [...(sourceTheaterEvidence.get(entry.article.novelId) ?? [])].sort();
    if (filters.sourceApp && !sourceApps.includes(filters.sourceApp)) continue;

    if (entry.kind === "ambiguous") {
      const candidateNovelIds = entry.targets.slice(0, REBIND_BATCH_LIMITS.ambiguousDisplayCandidates).map((t) => t.id);
      rows.push({
        category: "ambiguous",
        articleId: entry.article.id,
        oldNovelId: entry.article.novelId,
        targetNovelId: null,
        targetPromoLinkId: null,
        sourceApps,
        targetApps: [],
        findings: [],
        conflictArticle: null,
        candidateNovelIds,
        candidateCount: entry.targets.length,
        candidatesTruncated: entry.targets.length > candidateNovelIds.length,
        skipReason: null,
      });
      continue;
    }
    if (entry.kind !== "unique" || !entry.uniqueTarget) {
      rows.push({
        category: "skipped",
        articleId: entry.article.id,
        oldNovelId: entry.article.novelId,
        targetNovelId: null,
        targetPromoLinkId: null,
        sourceApps,
        targetApps: [],
        findings: [],
        conflictArticle: null,
        candidateNovelIds: [],
        candidateCount: 0,
        candidatesTruncated: false,
        skipReason: "unresolved",
      });
      continue;
    }
    candidates.push({ article: entry.article, target: entry.uniqueTarget });
  }

  if (candidates.length > REBIND_BATCH_LIMITS.candidate) {
    rebindBatchDomainError("CANDIDATE_CEILING_EXCEEDED", `preview contains ${candidates.length} matches`);
  }

  const findingsByArticle = await buildCandidateFindings(db, filters, candidates);
  for (const { article, target } of candidates) {
    const resolved = findingsByArticle.get(article.id);
    const sourceApps = [...(sourceTheaterEvidence.get(article.novelId) ?? [])].sort();
    const targetApps = [...(destTheaterEvidence.get(target.id) ?? [])].sort();
    rows.push({
      category: resolved && resolved.level === "ok" ? "executable" : "risk_blocked",
      articleId: article.id,
      oldNovelId: article.novelId,
      targetNovelId: target.id,
      targetPromoLinkId: resolved?.resolvedPromoLinkId ?? null,
      sourceApps,
      targetApps,
      findings: resolved?.findings ?? [],
      conflictArticle: resolved?.conflictArticle ?? null,
      candidateNovelIds: [],
      candidateCount: 1,
      candidatesTruncated: false,
      skipReason: null,
    });
  }
  rows.sort((a, b) => a.articleId.localeCompare(b.articleId));

  const executableCount = rows.filter((row) => row.category === "executable").length;
  const riskBlockedCount = rows.filter((row) => row.category === "risk_blocked").length;
  const ambiguousCount = rows.filter((row) => row.category === "ambiguous").length;
  const skippedCount = rows.filter((row) => row.category === "skipped").length;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + REBIND_BATCH_LIMITS.previewTtlMs);
  const matchesJson: RebindPreviewSnapshot = { rows };
  const planHash = sha256(JSON.stringify(matchesJson));
  const previewId = randomUUID();

  const created = await withDbRetry(
    () =>
      db.articleNovelRebindPreview.create({
        data: {
          id: previewId,
          createdBy: input.createdBy,
          sourceChannelCode: input.sourceChannelCode,
          targetChannelCode: input.targetChannelCode,
          filtersJson: filters,
          planHash,
          sourceScanned: source.count,
          matchedCount: executableCount + riskBlockedCount,
          ambiguousCount,
          skippedCount,
          matchesJson,
          expiresAt,
        },
      }),
    { op: "article_novel_rebind_preview.create", idempotencyKey: previewId },
  );

  return {
    previewId: created.id,
    sourceChannelCode: input.sourceChannelCode,
    targetChannelCode: input.targetChannelCode,
    filters,
    sourceScanned: source.count,
    matchedCount: executableCount + riskBlockedCount,
    executableCount,
    riskBlockedCount,
    ambiguousCount,
    skippedCount,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function loadOwnedRebindPreview(
  db: RebindPreviewDb,
  previewId: string,
  createdBy: string,
  options: { allowExpired?: boolean } = {},
): Promise<DelegateArgs> {
  const preview = await db.articleNovelRebindPreview.findUnique({ where: { id: previewId } });
  if (!preview) rebindBatchDomainError("PREVIEW_NOT_FOUND");
  if (preview.createdBy !== createdBy) rebindBatchDomainError("PREVIEW_FORBIDDEN");
  if (!options.allowExpired && new Date(preview.expiresAt).getTime() <= Date.now()) {
    rebindBatchDomainError("PREVIEW_EXPIRED");
  }
  return preview;
}

export type RebindPreviewPageItem = RebindPreviewSnapshotRow & {
  articleTitle: string;
  articleSlug: string;
  articleAdminUrl: string;
  articleLocale: string;
  oldNovelTitle: string;
  targetNovelTitle: string | null;
  candidateNovelTitles: string[];
  drifted: boolean;
};

export type RebindPreviewPage = {
  previewId: string;
  category: RebindPreviewCategory;
  items: RebindPreviewPageItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/** CPS parity: `getDurableBatchPage` (minus the schemaVersion-1 legacy branch — 施工工单 §2.4). */
export async function getRebindBatchPage(
  dbClient: PrismaClient | RebindPreviewDb,
  input: { previewId: string; category?: RebindPreviewCategory; page?: number; pageSize?: number; createdBy: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindPreviewPage> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  const db = dbClient as unknown as RebindPreviewDb;
  const preview = await loadOwnedRebindPreview(db, trimText(input.previewId), input.createdBy);
  const category = input.category ?? "executable";
  if (!["executable", "risk_blocked", "ambiguous", "skipped"].includes(category)) {
    rebindBatchDomainError("INVALID_PREVIEW_CATEGORY");
  }
  if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1)) rebindBatchDomainError("INVALID_PAGE");
  if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1)) {
    rebindBatchDomainError("INVALID_PAGE_SIZE");
  }
  const pageSize = Math.min(REBIND_BATCH_LIMITS.pageSize, input.pageSize ?? REBIND_BATCH_LIMITS.defaultPageSize);
  const page = input.page ?? 1;

  const snapshot = preview.matchesJson as RebindPreviewSnapshot;
  const sourceRows = snapshot.rows.filter((row) => row.category === category);
  const total = sourceRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRows = sourceRows.slice((page - 1) * pageSize, page * pageSize);
  if (pageRows.length === 0) return { previewId: preview.id, category, items: [], page, pageSize, total, totalPages };

  const articleIds = pageRows.map((row) => row.articleId);
  const novelIds = [
    ...new Set(
      pageRows.flatMap((row) => [row.oldNovelId, ...(row.targetNovelId ? [row.targetNovelId] : []), ...row.candidateNovelIds]),
    ),
  ];
  const articles = await db.article.findMany({
    where: { id: { in: articleIds } },
    select: { id: true, title: true, slug: true, locale: true, deletedAt: true },
  });
  const novels = await db.novel.findMany({ where: { id: { in: novelIds } }, select: { id: true, title: true } });
  const articleById = new Map((articles as Array<{ id: string; title: string; slug: string; locale: string; deletedAt: Date | null }>).map((a) => [a.id, a]));
  const novelById = new Map((novels as Array<{ id: string; title: string }>).map((n) => [n.id, n]));

  const items: RebindPreviewPageItem[] = pageRows.map((row) => {
    const article = articleById.get(row.articleId);
    const drifted = !article || Boolean(article.deletedAt);
    return {
      ...row,
      articleTitle: article?.title ?? "",
      articleSlug: article?.slug ?? "",
      articleAdminUrl: `/articles/${row.articleId}`,
      articleLocale: article?.locale ?? "",
      oldNovelTitle: novelById.get(row.oldNovelId)?.title ?? "",
      targetNovelTitle: row.targetNovelId ? novelById.get(row.targetNovelId)?.title ?? null : null,
      candidateNovelTitles: row.candidateNovelIds.map((id) => novelById.get(id)?.title ?? ""),
      drifted,
    };
  });

  return { previewId: preview.id, category, items, page, pageSize, total, totalPages };
}

/** CPS parity: `cleanupExpiredBatchSwitchPreviews` — bounded row + time double-gate. */
export async function cleanupExpiredRebindPreviews(db: RebindPreviewDb, now = new Date()): Promise<number> {
  const started = Date.now();
  const expired = await db.articleNovelRebindPreview.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
    take: REBIND_BATCH_LIMITS.cleanupRows,
  });
  if (expired.length === 0 || Date.now() - started >= REBIND_BATCH_LIMITS.cleanupMs) return 0;
  const deleted = await db.articleNovelRebindPreview.deleteMany({
    where: { id: { in: (expired as Array<{ id: string }>).map((row) => row.id) } },
  });
  return deleted.count;
}
