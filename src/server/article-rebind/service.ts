/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.6): the
 * single-article "换小说" (rebind) service. CPS parity —
 * `src/lib/article-drama-switch-service.ts`'s `switchArticleDrama`/
 * `rollbackArticleDrama`/`listCandidates`/`getSwitchView` — adapted for
 * three海阅-specific structural differences (施工工单 §2.3):
 *
 *   1. Two-field atomic write. CPS writes one column (`dramaId`); this
 *      repo's Article directly owns its `promoLinkId` (a海阅-only column,
 *      tied to `novelId` by the composite FK `article_promo_link_novel_fkey`
 *      — `docs/governance/database-governance.md` §5 item 12), so a rebind
 *      must swap BOTH `novelId` and `promoLinkId` in the same conditional
 *      `updateMany`, or the composite FK rejects the write outright.
 *   2. Published-row CHECK fork (C-27): a published `novel_article` still
 *      requires a non-null `promoLinkId` — guard 7 below forks hard/soft on
 *      the ARTICLE's own publish state, not a uniform "promo required".
 *   3. Audit table: this repo has no CPS-style dedicated switch-log table —
 *      every write here lands in the existing `OperationAudit` table
 *      (`action: "article.rebind_novel"` / `"article.rebind_rollback"`),
 *      same shape `src/server/articles/service.ts`'s `updateArticleContent`
 *      already uses for its own before/after snapshots.
 *
 * Fail-closed double gate: `FEATURE_ARTICLE_NOVEL_REBIND` (total) +
 * `ARTICLE_NOVEL_REBIND_ALLOW_WRITE` (write) — both checked at the top of
 * every exported write function; the two read functions
 * (`searchRebindCandidates`/`getRebindView`) check only the total gate (a
 * batch preview's own analogous single-gate exception is documented in
 * `src/lib/flags/feature-flags.ts`, though that specific code path is
 * C-30B).
 *
 * 🔴 The write shape (施工工单 §4A.6, load-bearing, pinned by
 * `tests/backend/article-rebind/service.test.ts`'s "恰好两个字段" test):
 *
 *   tx.article.updateMany({
 *     where: { id: articleId, novelId: expectedOldNovelId },
 *     data:  { novelId: targetNovelId, promoLinkId: resolvedPromoLinkId },
 *   })
 *
 * Nothing else — slug, publicPageShortId, title, body, status,
 * publishedAt, seoMetadata, templateId, contentMode are never touched by
 * this file.
 */
import type { PrismaClient } from "@prisma/client";

import { isArticleNovelRebindEnabled, isArticleNovelRebindWriteAllowed } from "@/lib/flags";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { revalidatePublicArticlePaths } from "@/server/publication/revalidate";
import type { SiteLocale } from "@/lib/locale/locale-canonical";

import {
  RebindArticleNotEligibleError,
  RebindDriftError,
  RebindGuardBlockedError,
  RebindInputError,
  RebindRollbackNotFoundError,
} from "./errors";
import { evaluateRebindGuards, type RebindGuardEvaluation, type RebindGuardLevel } from "./guards";

const REBIND_ACTION = "article.rebind_novel";
const REBIND_ROLLBACK_ACTION = "article.rebind_rollback";
const REASON_MAX_LENGTH = 500;

export type ArticleRebindServiceDependencies = {
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

function envOf(deps: Pick<ArticleRebindServiceDependencies, "env">): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

async function authorize(
  authorization: AdminServiceAuthorization,
  entryId: string,
  requestId: string,
  deps: ArticleRebindServiceDependencies,
) {
  return requireFreshAdminServiceMutation(authorization, "content:rebind", {
    identities: deps.identities,
    sessions: deps.sessions,
    env: deps.env,
    now: deps.now,
    entryId,
    requestId,
  });
}

/** Thrown by every write function when `FEATURE_ARTICLE_NOVEL_REBIND` is off — fail-closed even on a direct call. */
export class RebindFeatureDisabledError extends Error {
  readonly code = "REBIND_FEATURE_DISABLED" as const;
  constructor() {
    super("FEATURE_ARTICLE_NOVEL_REBIND is disabled");
    this.name = "RebindFeatureDisabledError";
  }
}

/** Thrown by every write function when `ARTICLE_NOVEL_REBIND_ALLOW_WRITE` is off — the feature may be on, but no write happens. */
export class RebindWriteDisabledError extends Error {
  readonly code = "REBIND_WRITE_DISABLED" as const;
  constructor() {
    super("ARTICLE_NOVEL_REBIND_ALLOW_WRITE is disabled");
    this.name = "RebindWriteDisabledError";
  }
}

function requireNonBlank(value: string, code: RebindInputError["code"], label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RebindInputError(code, `${label} is required`);
  return trimmed;
}

function requireReason(value: string): string {
  const reason = requireNonBlank(value, "reason_required", "reason");
  if (reason.length > REASON_MAX_LENGTH) {
    throw new RebindInputError("reason_too_long", `reason must be at most ${REASON_MAX_LENGTH} characters`);
  }
  return reason;
}

/** Same `[expected, expected + 1ms)` window discipline as `src/server/articles/service.ts`'s `expectedArticleTimestamp` — kept as a pre-flight check only (see this module's header for why the true CAS is the `novelId`-keyed `updateMany`, not this field). */
function parseExpectedUpdatedAt(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RebindInputError("expected_updated_at_invalid", "expectedUpdatedAt must be a round-tripped ISO-8601 string");
  }
  return parsed;
}

// Prisma delegate args are intentionally generic — see `./guards.ts`'s own note.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DelegateArgs = any;

type ArticleFullRecord = {
  id: string;
  novelId: string | null;
  promoLinkId: string | null;
  locale: string;
  slug: string;
  publicPageShortId: string;
  title: string;
  status: string;
  articleType: string;
  deletedAt: Date | string | null;
  updatedAt: Date;
  novel: { id: string; title: string; status: string } | null;
  promoLink: { id: string; publicRedirectCode: string } | null;
};

/**
 * Deliberately NOT declared as `RebindGuardDb & { article: RebindGuardDb["article"] & {...} }`:
 * intersecting two `findFirst` method signatures for the same key produces
 * an ambiguous overload TypeScript resolves unpredictably. Each delegate
 * below is instead declared once, wide enough to satisfy every call site in
 * this file AND every call site in `./guards.ts`'s narrower `RebindGuardDb`
 * — a wider return type (more fields) structurally satisfies a narrower one
 * (fewer fields), so `ArticleRebindTxClient` is still assignable to
 * `RebindGuardDb` wherever `evaluateRebindGuards(tx, ...)` is called below.
 */
export type ArticleRebindTxClient = {
  article: {
    findFirst(args: DelegateArgs): Promise<ArticleFullRecord | null>;
    updateMany(args: DelegateArgs): Promise<{ count: number }>;
  };
  novel: {
    findFirst(args: DelegateArgs): Promise<{
      id: string;
      title: string;
      locale: string;
      status: string;
      deletedAt: Date | string | null;
    } | null>;
  };
  promoLink: {
    findMany(args: DelegateArgs): Promise<
      Array<{
        id: string;
        status: string;
        webUrl: string | null;
        appUrl: string | null;
        fetchedAt: Date | string | null;
        publicRedirectCode: string;
      }>
    >;
  };
  operationAudit: {
    create(args: DelegateArgs): Promise<{ id: bigint | string }>;
    findFirst(args: DelegateArgs): Promise<{
      id: bigint | string;
      beforeSnapshot: unknown;
      afterSnapshot: unknown;
      reason: string | null;
      createdAt: Date;
      action: string;
    } | null>;
    findMany(args: DelegateArgs): Promise<
      Array<{
        id: bigint | string;
        action: string;
        reason: string | null;
        beforeSnapshot: unknown;
        afterSnapshot: unknown;
        createdAt: Date;
      }>
    >;
  };
};

export type ArticleRebindDb = ArticleRebindTxClient & {
  $transaction<T>(fn: (tx: ArticleRebindTxClient) => Promise<T>): Promise<T>;
};

const ARTICLE_SELECT = {
  id: true,
  novelId: true,
  promoLinkId: true,
  locale: true,
  slug: true,
  publicPageShortId: true,
  title: true,
  status: true,
  articleType: true,
  deletedAt: true,
  updatedAt: true,
  novel: { select: { id: true, title: true, status: true } },
  promoLink: { select: { id: true, publicRedirectCode: true } },
} as const;

async function loadArticleOrThrow(tx: ArticleRebindTxClient, articleId: string): Promise<ArticleFullRecord> {
  const article = await tx.article.findFirst({ where: { id: articleId, deletedAt: null }, select: ARTICLE_SELECT });
  if (!article) throw new RebindArticleNotEligibleError("ARTICLE_NOT_FOUND", "article not found");
  if (article.articleType !== "novel_article") {
    throw new RebindArticleNotEligibleError("NOT_NOVEL_ARTICLE", "only novel_article can rebind");
  }
  if (article.novelId === null) {
    throw new RebindArticleNotEligibleError("ARTICLE_HAS_NO_NOVEL", "article has no current Novel binding");
  }
  return article;
}

function snapshotOf(novelId: string | null, novelTitle: string | null, promoLinkId: string | null, promoRedirectCode: string | null) {
  return { novelId, novelTitle, promoLinkId, promoRedirectCode };
}

export type SwitchArticleNovelInput = {
  authorization: AdminServiceAuthorization;
  requestId: string;
  articleId: string;
  expectedOldNovelId: string;
  expectedUpdatedAt?: string;
  targetNovelId: string;
  reason: string;
  acknowledgeRisks?: boolean;
  /** Internal: selects the audit action name and the ack-override behavior. Callers outside this module never pass `"rollback"` directly — see `rollbackArticleNovel`. */
  source?: "admin_ui" | "rollback";
};

export type SwitchArticleNovelResult = {
  articleId: string;
  oldNovelId: string;
  newNovelId: string;
  oldPromoLinkId: string | null;
  newPromoLinkId: string | null;
  guardLevel: RebindGuardLevel;
  findings: RebindGuardEvaluation["findings"];
  auditId: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
};

/**
 * C-30B (施工工单 §4B.2: "调 单 1 的单篇换绑服务（守卫在写入时刻重新跑一遍，
 * 不信任预览时的判定）"). The guard-then-write-then-audit core, extracted out
 * of `switchArticleNovel` so `./batch.ts`'s per-item execution can reuse the
 * exact same logic — same guard evaluator, same 🔴 two-field write shape,
 * same audit shape — inside its OWN already-open per-item transaction,
 * instead of `switchArticleNovel` opening a second, nested one.
 *
 * `switchArticleNovel` below is unchanged in behavior: it still resolves an
 * `AdminServiceAuthorization` ticket first (a single-article, human-operator
 * mutation) and opens its own `db.$transaction` around this function.
 * `./batch.ts`'s per-item processor does NOT resolve a fresh ticket per item
 * — the batch's OWN submit-time ticket (`admin.article.rebind_batch_apply`/
 * `admin.article.rebind_batch_resume`) already authorized the whole
 * operation once; per-item integrity instead comes from the batch/item
 * *fence* tokens (施工工单 §4B.2), which is why this function takes a plain
 * `actorId`/`requestId` pair rather than a ticket.
 *
 * 🔴 Still the ONLY Article `updateMany` call site in this file (the write
 * below) — `tests/backend/article-rebind/write-shape-static.test.ts` pins
 * that invariant by source-scanning this exact file, so this write must
 * stay here rather than move to `./batch.ts`.
 */
export async function runRebindTransactionalWrite(
  tx: ArticleRebindTxClient,
  params: {
    articleId: string;
    expectedOldNovelId: string;
    /** Single-article CAS pre-flight only (施工工单 §4A.6's own note — the true CAS is the `novelId`-keyed `updateMany` below). Batch execution never passes this: a batch item's own fence tokens are its concurrency guard, and the batch's `expectedNewNovelId`/`expectedOldNovelId` pairing IS the equivalent staleness check via `expectedOldNovelId` above. */
    expectedUpdatedAt?: Date | null;
    targetNovelId: string;
    reason: string;
    acknowledgeRisks: boolean;
    actorId: string;
    requestId: string;
    action: typeof REBIND_ACTION | typeof REBIND_ROLLBACK_ACTION;
  },
): Promise<SwitchArticleNovelResult> {
  const article = await loadArticleOrThrow(tx, params.articleId);

  if (params.expectedUpdatedAt && article.updatedAt.getTime() !== params.expectedUpdatedAt.getTime()) {
    throw new RebindDriftError("Article.updatedAt no longer matches expectedUpdatedAt");
  }

  const evaluation = await evaluateRebindGuards(tx, {
    article: {
      id: article.id,
      novelId: article.novelId,
      locale: article.locale,
      status: article.status,
      articleType: article.articleType,
      deletedAt: article.deletedAt,
    },
    expectedOldNovelId: params.expectedOldNovelId,
    targetNovelId: params.targetNovelId,
  });

  const blockedFindings = evaluation.findings.filter((finding) => finding.level === "blocked");
  if (blockedFindings.length > 0) {
    throw new RebindGuardBlockedError(evaluation.findings);
  }
  if (evaluation.level === "needs_ack" && !params.acknowledgeRisks) {
    throw new RebindGuardBlockedError(evaluation.findings);
  }

  const targetNovel = evaluation.targetNovel;
  if (!targetNovel) {
    // Unreachable given the blocked-findings check above (TARGET_NOT_FOUND
    // is always `blocked`), kept as a type-narrowing guard.
    throw new RebindGuardBlockedError(evaluation.findings);
  }

  const beforeSnapshot = snapshotOf(
    article.novelId,
    article.novel?.title ?? null,
    article.promoLinkId,
    article.promoLink?.publicRedirectCode ?? null,
  );

  let newPromoRedirectCode: string | null = null;
  if (evaluation.resolvedPromoLinkId) {
    const [resolved] = await tx.promoLink.findMany({
      where: { id: evaluation.resolvedPromoLinkId },
      select: { id: true, publicRedirectCode: true },
    });
    newPromoRedirectCode = resolved?.publicRedirectCode ?? null;
  }
  const afterSnapshot = snapshotOf(targetNovel.id, targetNovel.title, evaluation.resolvedPromoLinkId, newPromoRedirectCode);

  // 🔴 The write shape — see this module's header. Exactly two fields.
  const write = await tx.article.updateMany({
    where: { id: article.id, novelId: params.expectedOldNovelId },
    data: { novelId: targetNovel.id, promoLinkId: evaluation.resolvedPromoLinkId },
  });
  if (write.count !== 1) {
    throw new RebindDriftError();
  }

  const audit = await tx.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: params.actorId,
      action: params.action,
      entityType: "Article",
      entityId: article.id,
      requestId: params.requestId,
      reason: params.reason,
      beforeSnapshot,
      afterSnapshot,
    },
  });

  return {
    articleId: article.id,
    oldNovelId: article.novelId!,
    newNovelId: targetNovel.id,
    oldPromoLinkId: article.promoLinkId,
    newPromoLinkId: evaluation.resolvedPromoLinkId,
    guardLevel: evaluation.level,
    findings: evaluation.findings,
    auditId: String(audit.id),
    locale: article.locale,
    slug: article.slug,
    publicPageShortId: article.publicPageShortId,
  };
}

/**
 * Cache invalidation AFTER the transaction commits, never inside it — see
 * this module's header / 施工工单 §4A.6 "缓存失效". The URL is unchanged by a
 * rebind (slug/shortId are never touched), so the paths are identical to
 * what they were before the switch. Exported so `./batch.ts` can call the
 * exact same invalidation for each of a batch's successfully-applied items
 * (施工工单 §4B.2: "对本批成功条目的文章路径顺序调既有安全失效包装") without
 * re-deriving the try/catch-around-`revalidatePublicArticlePaths` shape.
 */
export function invalidateRebindArticleCache(result: Pick<SwitchArticleNovelResult, "locale" | "slug" | "publicPageShortId">): void {
  try {
    revalidatePublicArticlePaths({
      locale: result.locale as SiteLocale,
      slug: result.slug,
      shortId: result.publicPageShortId,
    });
  } catch (error) {
    // Defense-in-depth on top of `revalidatePublicArticlePaths`'s own
    // internal `safeRevalidatePath` swallow — same posture
    // `publish-gate/service.ts`'s `safeInvalidatePublicCache` takes. Never
    // let a cache-invalidation failure surface as a rebind failure; the
    // write already committed.
    console.error("[article-rebind] public cache invalidation failed after a committed write:", error);
  }
}

/**
 * Writes the two-field atomic swap inside one transaction, re-evaluating
 * every guard fresh (never trusting a caller-supplied preview) — see this
 * module's header for the exact write shape.
 */
export async function switchArticleNovel(
  input: SwitchArticleNovelInput,
  deps: ArticleRebindServiceDependencies,
): Promise<SwitchArticleNovelResult> {
  const env = envOf(deps);
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  if (!isArticleNovelRebindWriteAllowed(env)) throw new RebindWriteDisabledError();

  // Entry id must match whichever action id the caller actually authorized
  // through — `rollbackArticleNovel` obtains its ticket against
  // `admin.article.rebind_rollback` (a distinct registry entry, §4A.4) and
  // forwards it here with `source: "rollback"`; `requireFreshAdminServiceMutation`
  // rejects a ticket whose `entryId` does not match what is passed here.
  const entryId = input.source === "rollback" ? "admin.article.rebind_rollback" : "admin.article.rebind_novel";
  const context = await authorize(input.authorization, entryId, input.requestId, deps);

  const articleId = requireNonBlank(input.articleId, "article_id_required", "articleId");
  const expectedOldNovelId = requireNonBlank(input.expectedOldNovelId, "expected_old_novel_id_required", "expectedOldNovelId");
  const targetNovelId = requireNonBlank(input.targetNovelId, "target_novel_id_required", "targetNovelId");
  const reason = requireReason(input.reason);
  const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
  const acknowledgeRisks = input.acknowledgeRisks ?? false;
  const source = input.source ?? "admin_ui";

  const db = deps.db as unknown as ArticleRebindDb;

  return db.$transaction((tx) =>
    runRebindTransactionalWrite(tx, {
      articleId,
      expectedOldNovelId,
      expectedUpdatedAt,
      targetNovelId,
      reason,
      acknowledgeRisks,
      actorId: context.identity.id,
      requestId: input.requestId,
      action: source === "rollback" ? REBIND_ROLLBACK_ACTION : REBIND_ACTION,
    }),
  ).then((result) => {
    invalidateRebindArticleCache(result);
    return result;
  });
}

export type RollbackArticleNovelInput = {
  authorization: AdminServiceAuthorization;
  requestId: string;
  articleId: string;
  reason: string;
};

/**
 * Reads the article's most recent `article.rebind_novel` audit row (施工工单
 * §4A.6 — deliberately NOT the most recent rebind action of either kind;
 * see this file's own delivery notes) and rebinds back to that row's
 * `beforeSnapshot.novelId`, with risks auto-acknowledged (a rollback is
 * itself an operator decision; only a hard `blocked` guard still stops it).
 */
export async function rollbackArticleNovel(
  input: RollbackArticleNovelInput,
  deps: ArticleRebindServiceDependencies,
): Promise<SwitchArticleNovelResult> {
  const env = envOf(deps);
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  if (!isArticleNovelRebindWriteAllowed(env)) throw new RebindWriteDisabledError();

  const articleId = requireNonBlank(input.articleId, "article_id_required", "articleId");
  const db = deps.db as unknown as ArticleRebindDb;

  const latest = await db.operationAudit.findFirst({
    where: { entityType: "Article", entityId: articleId, action: REBIND_ACTION },
    orderBy: { createdAt: "desc" },
    select: { id: true, beforeSnapshot: true, createdAt: true, action: true, reason: true, afterSnapshot: true },
  });
  const beforeNovelId =
    latest && typeof latest.beforeSnapshot === "object" && latest.beforeSnapshot !== null
      ? (latest.beforeSnapshot as { novelId?: unknown }).novelId
      : null;
  if (!latest || typeof beforeNovelId !== "string" || !beforeNovelId) {
    throw new RebindRollbackNotFoundError();
  }

  const current = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: { id: true, novelId: true },
  });
  if (!current || !current.novelId) {
    throw new RebindArticleNotEligibleError("ARTICLE_NOT_FOUND", "article not found");
  }

  return switchArticleNovel(
    {
      authorization: input.authorization,
      requestId: input.requestId,
      articleId,
      expectedOldNovelId: current.novelId,
      targetNovelId: beforeNovelId,
      reason: input.reason,
      acknowledgeRisks: true,
      source: "rollback",
    },
    deps,
  );
}

export type RebindCandidate = {
  novelId: string;
  title: string;
  businessId: string;
  slug: string;
  locale: string;
  status: string;
  guardLevel: RebindGuardLevel;
  findings: RebindGuardEvaluation["findings"];
  /** Non-guard yellow hint (施工工单 §4A.7/附录 D "非守卫的提示") — target title differs from the article's current book title. Never blocks. */
  titleMismatch: boolean;
};

export type SearchRebindCandidatesInput = {
  articleId: string;
  query: string;
  limit?: number;
};

const CANDIDATE_SEARCH_DEFAULT_LIMIT = 20;
const CANDIDATE_SEARCH_MAX_LIMIT = 50;

/**
 * 🔴 Search-based candidate selector (施工工单 §4A.7: "禁裸 UUID 输入框").
 * Matches on book title / business id / slug — "沿用书目列表既有搜索约定"
 * (`src/server/admin-content/service.ts`'s `novelFilters`, same three
 * fields, case-insensitive `contains`). Every returned candidate carries a
 * freshly-evaluated guard result (same evaluator the write path uses) so
 * the panel can render the three-tier banner before the operator commits.
 */
export async function searchRebindCandidates(
  db: PrismaClient,
  input: SearchRebindCandidatesInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindCandidate[]> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();

  const articleId = requireNonBlank(input.articleId, "article_id_required", "articleId");
  const query = input.query.trim();
  const limit = Math.min(input.limit ?? CANDIDATE_SEARCH_DEFAULT_LIMIT, CANDIDATE_SEARCH_MAX_LIMIT);
  if (!query) return [];

  const tx = db as unknown as ArticleRebindTxClient;
  const article = await loadArticleOrThrow(tx, articleId);

  const rows = await (db as unknown as {
    novel: {
      findMany(args: DelegateArgs): Promise<
        Array<{ id: string; title: string; businessId: string; slug: string; locale: string; status: string }>
      >;
    };
  }).novel.findMany({
    where: {
      deletedAt: null,
      id: { not: article.novelId },
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { businessId: { contains: query, mode: "insensitive" } },
        { slug: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true, businessId: true, slug: true, locale: true, status: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: limit,
  });

  const currentTitle = article.novel?.title ?? "";
  return Promise.all(
    rows.map(async (row): Promise<RebindCandidate> => {
      const evaluation = await evaluateRebindGuards(tx, {
        article: {
          id: article.id,
          novelId: article.novelId,
          locale: article.locale,
          status: article.status,
          articleType: article.articleType,
          deletedAt: article.deletedAt,
        },
        expectedOldNovelId: article.novelId!,
        targetNovelId: row.id,
      });
      return {
        novelId: row.id,
        title: row.title,
        businessId: row.businessId,
        slug: row.slug,
        locale: row.locale,
        status: row.status,
        guardLevel: evaluation.level,
        findings: evaluation.findings,
        titleMismatch: row.title.trim() !== currentTitle.trim(),
      };
    }),
  );
}

export type RebindHistoryEntry = {
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
};

export type RebindView = {
  article: { id: string; locale: string; slug: string; publicPageShortId: string; title: string; status: string };
  currentNovel: {
    id: string;
    title: string;
    locale: string;
    status: string;
    promoLinkId: string | null;
    promoRedirectCode: string | null;
  } | null;
  history: readonly RebindHistoryEntry[];
};

const REBIND_HISTORY_LIMIT = 20;

/** Editor-page panel's initial read: current book card + recent rebind history (for the "换回上一次" affordance). */
export async function getRebindView(
  db: PrismaClient,
  input: { articleId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindView> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();

  const articleId = requireNonBlank(input.articleId, "article_id_required", "articleId");
  const tx = db as unknown as ArticleRebindTxClient;
  const article = await loadArticleOrThrow(tx, articleId);

  const history = await tx.operationAudit.findMany({
    where: { entityType: "Article", entityId: article.id, action: { in: [REBIND_ACTION, REBIND_ROLLBACK_ACTION] } },
    orderBy: { createdAt: "desc" },
    take: REBIND_HISTORY_LIMIT,
    select: { id: true, action: true, reason: true, createdAt: true, beforeSnapshot: true, afterSnapshot: true },
  });

  return {
    article: {
      id: article.id,
      locale: article.locale,
      slug: article.slug,
      publicPageShortId: article.publicPageShortId,
      title: article.title,
      status: article.status,
    },
    currentNovel: article.novel
      ? {
          id: article.novel.id,
          title: article.novel.title,
          locale: article.locale,
          status: article.novel.status,
          promoLinkId: article.promoLinkId,
          promoRedirectCode: article.promoLink?.publicRedirectCode ?? null,
        }
      : null,
    history: history.map((row) => ({
      id: String(row.id),
      action: row.action,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      beforeSnapshot: row.beforeSnapshot,
      afterSnapshot: row.afterSnapshot,
    })),
  };
}
