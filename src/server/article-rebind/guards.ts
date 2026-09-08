/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.6/附录 D). The
 * nine-guard family, evaluated fresh (no cached/preview data trusted) by
 * both `./service.ts`'s single-article write path and — C-30B — the batch
 * preview classifier and per-item execution re-check. One evaluator, shared
 * everywhere a rebind is judged, so the "集合化守卫与单篇守卫逐条相同" C-30B
 * test has a single source of truth to compare against by construction.
 *
 * CPS parity map (施工工单 附录 D):
 *   1. NOT_NOVEL_ARTICLE        — "只有剧集文章能换绑"
 *   2. REBIND_DRIFT             — ARTICLE_BINDING_DRIFT
 *   3. TARGET_ALREADY_BOUND     — 同名守卫
 *   4. TARGET_NOT_FOUND         — "目标剧已删除"
 *   5. TARGET_LOCALE_MISMATCH   — "目标剧语种必须匹配"
 *   6. TARGET_RIGHTS_BLOCKED    — "目标剧权利状态非公开"
 *   7. TARGET_PROMO_NOT_READY   — "目标剧推广字段必填"（按发布状态分档，见下）
 *   8. TARGET_LOCALE_OCCUPIED   — duplicate_page（海阅同时是数据库唯一约束）
 *   9. CROSS_LOCALE_SIBLINGS    — hreflang_siblings（仅同书目跨语种分支；海阅无翻译组列）
 *
 * Guard 7 and guard 8/9 need I/O (PromoLink resolution, Article existence
 * checks) — this module takes a narrow `RebindGuardDb` (a Prisma-shaped
 * subset), the same "inject a fake, run against real Prisma unmodified"
 * discipline `src/server/articles/service.ts` and its own tests already use.
 */
import { isPromoReady } from "@/server/publication/visibility";

import type { RebindGuardCode } from "./errors";

export type RebindGuardLevel = "ok" | "needs_ack" | "blocked";

export type RebindGuardFinding = {
  code: RebindGuardCode;
  level: "needs_ack" | "blocked";
  message: string;
};

export type RebindGuardEvaluation = {
  level: RebindGuardLevel;
  findings: readonly RebindGuardFinding[];
  /** The target Novel row loaded fresh during evaluation, or `null` when guard 4 (TARGET_NOT_FOUND) fired. */
  targetNovel: RebindTargetNovel | null;
  /**
   * The promo link this rebind would bind, resolved fresh during evaluation
   * — `null` when none was found ready (draft articles may still proceed
   * with `promoLinkId: null`; see guard 7).
   */
  resolvedPromoLinkId: string | null;
};

export type RebindArticleRecord = {
  id: string;
  novelId: string | null;
  locale: string;
  status: string;
  articleType: string;
  deletedAt: Date | string | null;
};

export type RebindTargetNovel = {
  id: string;
  title: string;
  locale: string;
  status: string;
  deletedAt: Date | string | null;
};

export type PromoLinkCandidate = {
  id: string;
  status: string;
  webUrl: string | null;
  appUrl: string | null;
  fetchedAt: Date | string | null;
};

// Prisma delegate args are intentionally generic — this module is exercised
// both against injected in-memory fakes (unit tests) and the generated
// Prisma client (integration tests / production), same convention
// `src/server/articles/service.ts`'s own db-shaped types use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DelegateArgs = any;

export type RebindGuardDb = {
  novel: {
    findFirst(args: DelegateArgs): Promise<RebindTargetNovel | null>;
  };
  promoLink: {
    findMany(args: DelegateArgs): Promise<PromoLinkCandidate[]>;
  };
  article: {
    findFirst(args: DelegateArgs): Promise<{ id: string } | null>;
  };
};

const NON_PUBLIC_NOVEL_STATUSES = new Set(["takedown"]);

function isSoftDeleted(value: Date | string | null): boolean {
  return value !== null;
}

/**
 * Guard 7's deterministic pick, factored out so `./preview.ts`'s bulk
 * resolution (one `IN (...)` query across every candidate target Novel,
 * grouped by `novelId` client-side, each group pre-sorted the same way) can
 * apply the exact same selection rule per group instead of re-deriving it.
 * `isPromoReady` (the one authoritative promo-readiness predicate,
 * `src/server/publication/visibility.ts`) is re-applied here rather than
 * trusted from a `status = 'fetched'` DB filter alone — same "DB filter
 * narrows, isPromoReady has the final word" discipline that function's own
 * doc comment requires of every caller. `candidates` must already be sorted
 * `fetchedAt DESC, id ASC` (施工工单 §4A.6) — both call sites below produce
 * that order via their own `orderBy`.
 */
export function pickReadyPromoLink(candidates: readonly PromoLinkCandidate[]): PromoLinkCandidate | null {
  return candidates.find((candidate) => isPromoReady(candidate)) ?? null;
}

async function resolveTargetPromoLink(
  db: RebindGuardDb,
  targetNovelId: string,
): Promise<PromoLinkCandidate | null> {
  const candidates = await db.promoLink.findMany({
    where: { novelId: targetNovelId, status: "fetched", deletedAt: null },
    select: { id: true, status: true, webUrl: true, appUrl: true, fetchedAt: true },
    orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
  });
  return pickReadyPromoLink(candidates);
}

export type EvaluateRebindGuardsInput = {
  article: RebindArticleRecord;
  /**
   * The article's current `novelId` as the caller last observed it —
   * compared against the freshly-loaded `article.novelId` for guard 2. For
   * a freshly-loaded article this is naturally `article.novelId` itself
   * (drift never fires); a caller re-validating an older read passes the
   * value it last saw.
   */
  expectedOldNovelId: string;
  targetNovelId: string;
};

/**
 * C-30B (施工工单 §4B.1 "集合化守卫"). The nine guards' pure decision logic,
 * factored out of {@link evaluateRebindGuards} so there is exactly ONE place
 * that decides "given these facts, what are the findings" — `evaluateRebindGuards`
 * below resolves each fact with one row-scoped Prisma call per guard (single-
 * article path); `./preview.ts`'s batch classifier resolves the identical
 * facts with a handful of *bulk* (`IN (...)`) queries covering an entire
 * preview's candidate set, then calls this same function once per candidate
 * row. Two different I/O strategies, one decision function — this is what
 * makes the "集合化守卫与单篇守卫逐条相同" test (施工工单 §4B.5) true by
 * construction rather than by hoping two hand-written copies stay in sync.
 *
 * Every field here is a *fact already resolved by the caller* — this
 * function performs no I/O and never throws for a business-state failure.
 */
export type RebindGuardFacts = {
  articleId: string;
  articleType: string;
  articleLocale: string;
  articleStatus: string;
  /** The article's actually-current `novelId`, freshly loaded (or re-derived from bulk data) by the caller — compared against `expectedOldNovelId` for guard 2. */
  currentNovelId: string | null;
  expectedOldNovelId: string;
  targetNovelId: string;
  /** The target Novel row, already loaded and known non-soft-deleted by the caller — `null` means guard 4 (TARGET_NOT_FOUND) fires and every later guard is skipped, exactly like a per-row `db.novel.findFirst` miss. */
  targetNovel: RebindTargetNovel | null;
  /** Guard 7's already-resolved pick (`resolveTargetPromoLink` for the single-row path; a bulk-grouped equivalent for the batch path) — `null` means no ready `PromoLink` was found for the target. */
  resolvedPromoLinkId: string | null;
  /** Guard 8's already-resolved fact: does the target Novel have an existing Article (any status, 🔴 including soft-deleted — see this guard's own note below) at `articleLocale`, other than this article itself? */
  targetLocaleOccupied: boolean;
  /** Guard 9's already-resolved fact: does `currentNovelId` have another published, non-deleted Article in a locale other than `articleLocale`? */
  crossLocaleSiblingExists: boolean;
};

export function classifyRebindGuardFindings(facts: RebindGuardFacts): RebindGuardEvaluation {
  const findings: RebindGuardFinding[] = [];

  // Guard 1: only novel_article can rebind. Short-circuits everything else
  // — a non-novel_article has no current Novel binding to reason about.
  if (facts.articleType !== "novel_article") {
    return {
      level: "blocked",
      findings: [{ code: "NOT_NOVEL_ARTICLE", level: "blocked", message: "只有小说文章能换绑" }],
      targetNovel: null,
      resolvedPromoLinkId: null,
    };
  }

  // Guard 2: current binding drift (optimistic-concurrency signal).
  if (facts.currentNovelId !== facts.expectedOldNovelId) {
    findings.push({
      code: "REBIND_DRIFT",
      level: "blocked",
      message: "当前书目已被其他操作改变，请刷新后重试",
    });
  }

  // Guard 3: self-rebind.
  if (facts.currentNovelId === facts.targetNovelId) {
    findings.push({ code: "TARGET_ALREADY_BOUND", level: "blocked", message: "目标书目与当前书目相同" });
  }

  // Guard 4: target exists and is not soft-deleted.
  const targetNovel = facts.targetNovel;
  if (!targetNovel || isSoftDeleted(targetNovel.deletedAt)) {
    findings.push({ code: "TARGET_NOT_FOUND", level: "blocked", message: "目标书目不存在或已删除" });
    return { level: "blocked", findings, targetNovel: null, resolvedPromoLinkId: null };
  }

  // Guard 5: target locale must match the article's own locale.
  if (targetNovel.locale !== facts.articleLocale) {
    findings.push({
      code: "TARGET_LOCALE_MISMATCH",
      level: "blocked",
      message: `目标书目语种（${targetNovel.locale}）与文章语种（${facts.articleLocale}）不一致`,
    });
  }

  // Guard 6: target rights state must not be takedown.
  if (NON_PUBLIC_NOVEL_STATUSES.has(targetNovel.status)) {
    findings.push({ code: "TARGET_RIGHTS_BLOCKED", level: "blocked", message: "目标书目权利状态为下架" });
  }

  // Guard 7: target promo-link readiness, forked by the ARTICLE's own
  // publish state (施工工单 §4A.6 / 附录 D 第 7 条) — a published article
  // needs a promo link the moment it rebinds (the published-row CHECK would
  // otherwise reject the write outright); a non-published article (draft,
  // unpublished, takedown) is allowed to proceed with `promoLinkId: null`,
  // surfaced as a confirm-required finding rather than a silent gap.
  if (!facts.resolvedPromoLinkId) {
    if (facts.articleStatus === "published") {
      findings.push({
        code: "TARGET_PROMO_NOT_READY",
        level: "blocked",
        message: "目标书目没有就绪的推广链接，已发布文章无法换绑",
      });
    } else {
      findings.push({
        code: "TARGET_PROMO_NOT_READY",
        level: "needs_ack",
        message: "目标书目暂无就绪的推广链接；换绑后本文章的推广链接将为空，直到目标书目有可用推广链接",
      });
    }
  }

  // Guard 8: same-locale page conflict on the TARGET novel — 🔴 must count a
  // soft-deleted Article too (`article_novel_locale_key` has no soft-delete
  // exemption, unlike `article_locale_slug_active_uidx` — see
  // docs/governance/database-governance.md §5 item 22 / §4's C-30A note).
  if (facts.targetLocaleOccupied) {
    findings.push({
      code: "TARGET_LOCALE_OCCUPIED",
      level: "blocked",
      message: "目标书目在该语种下已有文章占位（含已软删除的文章）",
    });
  }

  // Guard 9: cross-locale siblings — this Article's CURRENT Novel has
  // another published, non-deleted Article in a different locale. A
  // confirm-required warning (not a hard block): rebinding away may break
  // that hreflang group, but the operator may have a reason to proceed.
  if (facts.currentNovelId && facts.crossLocaleSiblingExists) {
    findings.push({
      code: "CROSS_LOCALE_SIBLINGS",
      level: "needs_ack",
      message: "本文章所属书目在其他语种下另有已发布文章，换绑可能影响该书目的跨语种关联",
    });
  }

  const blocked = findings.filter((finding) => finding.level === "blocked");
  const level: RebindGuardLevel = blocked.length > 0 ? "blocked" : findings.length > 0 ? "needs_ack" : "ok";

  return {
    level,
    findings,
    targetNovel,
    resolvedPromoLinkId: facts.resolvedPromoLinkId,
  };
}

/**
 * Runs all nine guards and returns a single classified result: `blocked` if
 * any hard-reject guard fired, else `needs_ack` if any confirm-required
 * guard fired, else `ok` (施工工单 附录 D "分档规则"). Never throws for a
 * business-state failure — every guard failure is a `finding` in the
 * result, matching `src/server/publish-gate/evaluator.ts`'s "pure
 * classifier, caller decides what to do with it" shape. Malformed input
 * (missing ids) is the caller's responsibility to validate before calling
 * this (see `./service.ts`'s own input validation).
 *
 * Resolves each of {@link classifyRebindGuardFindings}'s facts with one
 * row-scoped query apiece, then delegates the actual decision to that pure
 * function — see its own doc comment for why.
 */
export async function evaluateRebindGuards(
  db: RebindGuardDb,
  input: EvaluateRebindGuardsInput,
): Promise<RebindGuardEvaluation> {
  const { article, expectedOldNovelId, targetNovelId } = input;

  if (article.articleType !== "novel_article") {
    return classifyRebindGuardFindings({
      articleId: article.id,
      articleType: article.articleType,
      articleLocale: article.locale,
      articleStatus: article.status,
      currentNovelId: article.novelId,
      expectedOldNovelId,
      targetNovelId,
      targetNovel: null,
      resolvedPromoLinkId: null,
      targetLocaleOccupied: false,
      crossLocaleSiblingExists: false,
    });
  }

  // Guard 4's fact: target exists and is not soft-deleted.
  const targetNovel = await db.novel.findFirst({
    where: { id: targetNovelId },
    select: { id: true, title: true, locale: true, status: true, deletedAt: true },
  });
  const targetExists = Boolean(targetNovel) && !isSoftDeleted(targetNovel!.deletedAt);
  if (!targetExists) {
    return classifyRebindGuardFindings({
      articleId: article.id,
      articleType: article.articleType,
      articleLocale: article.locale,
      articleStatus: article.status,
      currentNovelId: article.novelId,
      expectedOldNovelId,
      targetNovelId,
      targetNovel: null,
      resolvedPromoLinkId: null,
      targetLocaleOccupied: false,
      crossLocaleSiblingExists: false,
    });
  }

  // Guard 7's fact.
  const resolvedPromoLink = await resolveTargetPromoLink(db, targetNovel!.id);

  // Guard 8's fact — 🔴 deliberately omits `deletedAt: null` from this
  // `where`, see the guard's own note in `classifyRebindGuardFindings`.
  const occupying = await db.article.findFirst({
    where: {
      id: { not: article.id },
      novelId: targetNovel!.id,
      locale: article.locale,
    },
    select: { id: true },
  });

  // Guard 9's fact.
  let siblingExists = false;
  if (article.novelId) {
    const sibling = await db.article.findFirst({
      where: {
        id: { not: article.id },
        novelId: article.novelId,
        locale: { not: article.locale },
        status: "published",
        deletedAt: null,
      },
      select: { id: true },
    });
    siblingExists = Boolean(sibling);
  }

  return classifyRebindGuardFindings({
    articleId: article.id,
    articleType: article.articleType,
    articleLocale: article.locale,
    articleStatus: article.status,
    currentNovelId: article.novelId,
    expectedOldNovelId,
    targetNovelId,
    targetNovel: targetNovel!,
    resolvedPromoLinkId: resolvedPromoLink?.id ?? null,
    targetLocaleOccupied: Boolean(occupying),
    crossLocaleSiblingExists: siblingExists,
  });
}

