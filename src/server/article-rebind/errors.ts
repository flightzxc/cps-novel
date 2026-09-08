/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.6). Error family
 * for the single-article rebind service. Split the same way this repo's
 * other service-level error classes already are (`ArticleConflictError` in
 * `src/server/articles/service.ts`, `BlogArticleInputError` in
 * `src/server/content-creation/blog.ts`): a distinct class per failure
 * *shape*, each carrying a stable machine-readable `code`.
 */

/** Malformed caller input — not a business state. Same discipline as `BlogArticleInputError`. */
export type RebindInputErrorCode =
  | "article_id_required"
  | "expected_old_novel_id_required"
  | "target_novel_id_required"
  | "reason_required"
  | "reason_too_long"
  | "expected_updated_at_invalid";

export class RebindInputError extends Error {
  readonly code: RebindInputErrorCode;
  constructor(code: RebindInputErrorCode, message: string) {
    super(message);
    this.name = "RebindInputError";
    this.code = code;
  }
}

/**
 * Appendix D's nine guards (施工工单 §附录 D). Every code here is the same
 * machine-readable identifier the guard evaluator (`./guards.ts`), the
 * single-article service (`./service.ts`), and — C-30B — the batch preview
 * classifier and execution re-check all share, so a `blocked`/`needs_ack`
 * reason never has to be re-derived or re-worded at a second layer.
 */
export const REBIND_GUARD_CODES = [
  "NOT_NOVEL_ARTICLE",
  "REBIND_DRIFT",
  "TARGET_ALREADY_BOUND",
  "TARGET_NOT_FOUND",
  "TARGET_LOCALE_MISMATCH",
  "TARGET_RIGHTS_BLOCKED",
  "TARGET_PROMO_NOT_READY",
  "TARGET_LOCALE_OCCUPIED",
  "CROSS_LOCALE_SIBLINGS",
] as const;
export type RebindGuardCode = (typeof REBIND_GUARD_CODES)[number];

/**
 * Thrown by the write path (`switchArticleNovel`/`rollbackArticleNovel`)
 * when the guard evaluation's overall level is `blocked`, or `needs_ack`
 * without `acknowledgeRisks`. Carries every finding, not just the first —
 * the panel/action layer decides how to render them, this error just
 * refuses to write.
 */
export class RebindGuardBlockedError extends Error {
  readonly code = "REBIND_GUARD_BLOCKED" as const;
  readonly findings: ReadonlyArray<{ code: RebindGuardCode; level: "needs_ack" | "blocked"; message: string }>;
  constructor(
    findings: ReadonlyArray<{ code: RebindGuardCode; level: "needs_ack" | "blocked"; message: string }>,
  ) {
    super(`rebind blocked: ${findings.map((finding) => finding.code).join(",")}`);
    this.name = "RebindGuardBlockedError";
    this.findings = findings;
  }
}

/**
 * 🔴 The write-shape invariant (施工工单 §4A.6): the conditional `updateMany`
 * matched zero rows, meaning `Article.novelId` no longer equals
 * `expectedOldNovelId` at the moment of the write (a concurrent switch, or a
 * stale client). Same failure class CPS calls `ARTICLE_BINDING_DRIFT`.
 */
export class RebindDriftError extends Error {
  readonly code = "REBIND_DRIFT" as const;
  constructor(message = "Article.novelId no longer matches expectedOldNovelId") {
    super(message);
    this.name = "RebindDriftError";
  }
}

/** Rollback-specific: no prior `article.rebind_novel` audit row to roll back from. */
export class RebindRollbackNotFoundError extends Error {
  readonly code = "REBIND_ROLLBACK_NOT_FOUND" as const;
  constructor(message = "no prior article.rebind_novel audit row found for rollback") {
    super(message);
    this.name = "RebindRollbackNotFoundError";
  }
}

/** Article not found, not a `novel_article`, soft-deleted, or has no current Novel binding. */
export class RebindArticleNotEligibleError extends Error {
  readonly code: "ARTICLE_NOT_FOUND" | "NOT_NOVEL_ARTICLE" | "ARTICLE_HAS_NO_NOVEL";
  constructor(code: "ARTICLE_NOT_FOUND" | "NOT_NOVEL_ARTICLE" | "ARTICLE_HAS_NO_NOVEL", message: string) {
    super(message);
    this.name = "RebindArticleNotEligibleError";
    this.code = code;
  }
}
