/**
 * Composable public-visibility predicate family (v0.2.0 foundation, Stream F).
 *
 * Deliberately NOT a single "isVisible" boolean. Each predicate answers one
 * narrow question and higher-level predicates compose lower-level ones, per
 * the P2-07~12 round's total principle: "inherit CPS's validated business
 * behavior; do not inherit its historical schema accidents, duplicated
 * logic, or already-confirmed defects." CPS's promo-readiness check was
 * reimplemented four times with a real semantic drift (`sitemap.ts`'s DB
 * filter used un-trimmed `promoUrl: { not: "" }`, silently more permissive
 * than the trim-based application-layer checks used everywhere else — see
 * `P2-07-12-移植审计-2026-08-12/DECISION-CHECK.md` 核查 3). `isPromoReady` is
 * this codebase's single authoritative definition; nobody else may
 * reimplement the "is this promo link usable" question.
 *
 * CPS's `checkDramaSlugAccess` (src/proxy.ts) never checked its promo field
 * at the public-access boundary at all — not a drift, a boundary that was
 * simply never implemented. `isPubliclyAccessible` closes that gap
 * deliberately (Owner-approved net-new invariant for this project, not a
 * CPS parity port) — see docs/p2/V020_FOUNDATION_INTERFACES.md.
 *
 * Semantics are frozen against `src/contracts/publish-gate.ts` (the
 * `promo_link_missing` / `promo_link_not_ready` reasons) and against
 * `docs/governance/database-governance.md` §4's Novel/Article status
 * semantics table. Do not add a fifth ad hoc visibility check anywhere
 * else in the codebase — extend this module instead.
 *
 * Soft-delete is intentionally NOT modeled by the predicate functions above
 * (`isPublicationStatePublic`, `isPubliclyAccessible`, etc.) — they only see
 * `status`, never `deletedAt`. The `buildPrimary*Where`/`buildPublic*Where`
 * fragments below are what enforce `deletedAt: null`. This is safe today
 * because this module's only caller, `access.ts`'s
 * `checkNovelArticlePublicAccess`, always loads its row through
 * `buildPrimaryArticleWhere` first. A future caller that loads a row by id
 * directly (skipping the where-builder) and then calls a predicate function
 * on it would incorrectly treat a soft-deleted row as publicly accessible —
 * always route through a `build*Where` fragment before calling a predicate.
 */
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Narrow input shapes. Callers pass whatever Prisma `select` projection they
// already have; these types intentionally accept a structural subset rather
// than requiring a full Prisma model object.
// ---------------------------------------------------------------------------

export type NovelPublicationState = {
  readonly status: string;
};

export type ArticlePublicationState = {
  readonly status: string;
};

export type PromoLinkReadinessState = {
  readonly status: string;
  readonly webUrl: string | null;
  readonly appUrl: string | null;
} | null;

function isNonBlank(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}

/**
 * Authoritative promo-readiness check. `status === "fetched"` alone is not
 * sufficient — CPS's four independent reimplementations of this check drifted
 * because one of them (the sitemap DB filter) skipped trimming. This is the
 * one place in the codebase allowed to answer "is this promo link usable";
 * every other boundary (publish gate evaluator, public access, IndexNow
 * eligibility, sitemap inclusion) must call this function rather than
 * reimplementing an equivalent check.
 *
 * A DB-layer pre-filter (see `buildPublicArticleWhere` below) may narrow
 * candidates by `promoLink.status === "fetched"` for index selectivity, but
 * that pre-filter is never authoritative on its own — this function's trim
 * check always has the final word before anything is rendered, indexed, or
 * submitted to IndexNow.
 */
export function isPromoReady(promoLink: PromoLinkReadinessState): boolean {
  if (!promoLink) return false;
  if (promoLink.status !== "fetched") return false;
  return isNonBlank(promoLink.webUrl) || isNonBlank(promoLink.appUrl);
}

/**
 * True only when both the Novel and its Article have reached `published`.
 * Does not consider promo readiness or rights state — see
 * `isPubliclyAccessible` for the composed check.
 */
export function isPublicationStatePublic(
  novel: NovelPublicationState,
  article: ArticlePublicationState,
): boolean {
  return novel.status === "published" && article.status === "published";
}

/**
 * Rights-removal state (Novel or Article `takedown`) always wins over every
 * other state — this is `publish-gate.ts`'s `rights_blocked` reason made
 * readable at the public-access boundary. A takedown Novel forces every one
 * of its Articles to read as rights-blocked regardless of the Article's own
 * status column (rights removal cascades down, never up).
 */
export function isRightsBlocked(
  novel: NovelPublicationState,
  article: ArticlePublicationState,
): boolean {
  return novel.status === "takedown" || article.status === "takedown";
}

/**
 * Stable noindex removal-page state: Novel or Article `unpublished`, and not
 * already rights-blocked (rights-blocked takes precedence). Distinct from a
 * plain 404 — `docs/governance/database-governance.md` §4 freezes
 * `unpublished` as "a stable removal page that exits the index while content
 * is retained", which is not the same HTTP/UX outcome as `draft`/`ready`
 * (plain 404) or `takedown` (410 Gone). Callers rendering the public route
 * must route these three outcomes to three different pages/status codes.
 */
export function isNoIndexRemovalState(
  novel: NovelPublicationState,
  article: ArticlePublicationState,
): boolean {
  if (isRightsBlocked(novel, article)) return false;
  return novel.status === "unpublished" || article.status === "unpublished";
}

/**
 * The composed "should this page render its normal public content" check:
 * both records are `published` AND the Article's promo link is currently
 * ready. A Novel/Article that reached `published` once but whose promo link
 * later degraded (e.g. re-fetch failure) is NOT publicly accessible even
 * though the publish-time gate (Stream A evaluator) is satisfied by the
 * `published` row CHECK alone — this function re-verifies promo readiness at
 * read time rather than trusting the publish-time gate forever, which is the
 * Owner-approved net-new invariant referenced in this file's header comment.
 */
export function isPubliclyAccessible(
  novel: NovelPublicationState,
  article: ArticlePublicationState,
  promoLink: PromoLinkReadinessState,
): boolean {
  return isPublicationStatePublic(novel, article) && isPromoReady(promoLink);
}

/**
 * IndexNow submission eligibility. Equal to `isPubliclyAccessible` at this
 * Novel/Article layer today — kept as its own named predicate (rather than
 * an alias) because Stream E's outbox enqueue path is expected to compose
 * additional IndexNow-specific conditions on top (e.g. locale allowlist,
 * per-chapter staleness) without callers needing to know which Novel/Article
 * conditions are shared with plain public accessibility versus which are
 * IndexNow-specific. Do not collapse this back into `isPubliclyAccessible`
 * even though the bodies currently match.
 */
export function isIndexNowEligible(
  novel: NovelPublicationState,
  article: ArticlePublicationState,
  promoLink: PromoLinkReadinessState,
): boolean {
  return isPubliclyAccessible(novel, article, promoLink);
}

// ---------------------------------------------------------------------------
// DB pre-filter where-fragment helpers (composable, CPS drama-query-helpers
// pattern). These are cheap, index-friendly SUPERSETS meant to shrink a
// candidate set before application code applies the authoritative
// `isPromoReady`/`isPubliclyAccessible` checks above — they are never
// authoritative on their own. In particular `promoLink.status === "fetched"`
// is not trim-checked here; do not treat a DB-filtered row list as safe to
// render/index/submit without also calling `isPromoReady` per row. This is
// the exact CPS defect (`sitemap.ts`'s un-trimmed `promoUrl: { not: "" }`)
// this project must not reproduce — the DB layer only pre-filters, the
// application layer's trim check is authoritative.
// ---------------------------------------------------------------------------

export const PRIMARY_NOVEL_RECORD = {
  deletedAt: null,
} satisfies Prisma.NovelWhereInput;

export const PUBLIC_NOVEL_RECORD = {
  ...PRIMARY_NOVEL_RECORD,
  status: "published",
} satisfies Prisma.NovelWhereInput;

export function buildPrimaryNovelWhere(
  extra: Prisma.NovelWhereInput = {},
): Prisma.NovelWhereInput {
  return { AND: [PRIMARY_NOVEL_RECORD, extra] };
}

export function buildPublicNovelWhere(
  extra: Prisma.NovelWhereInput = {},
): Prisma.NovelWhereInput {
  return { AND: [PUBLIC_NOVEL_RECORD, extra] };
}

export const PRIMARY_ARTICLE_RECORD = {
  deletedAt: null,
} satisfies Prisma.ArticleWhereInput;

export const PUBLIC_ARTICLE_RECORD = {
  ...PRIMARY_ARTICLE_RECORD,
  status: "published",
  novel: { is: PUBLIC_NOVEL_RECORD },
  // Coarse pre-filter only (not trim-checked) — see module header. Callers
  // MUST still call `isPromoReady` on the loaded row before treating it as
  // publicly accessible.
  promoLink: { is: { status: "fetched" } },
} satisfies Prisma.ArticleWhereInput;

export function buildPrimaryArticleWhere(
  extra: Prisma.ArticleWhereInput = {},
): Prisma.ArticleWhereInput {
  return { AND: [PRIMARY_ARTICLE_RECORD, extra] };
}

export function buildPublicArticleWhere(
  extra: Prisma.ArticleWhereInput = {},
): Prisma.ArticleWhereInput {
  return { AND: [PUBLIC_ARTICLE_RECORD, extra] };
}
