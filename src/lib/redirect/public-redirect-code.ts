/**
 * `public_redirect_code` — the single generation entry point for the whole
 * project (`src/lib/redirect/README.md`, `CLAUDE.md` §3.2.1/§5 修正 6).
 *
 * 🔴 Frozen invariants (README + CLAUDE.md §5 修正 6), all enforced here or
 * by the database, never by caller discipline alone:
 *   - **Globally unique**: `promo_link.public_redirect_code` carries a
 *     non-partial `UNIQUE` index (`promo_link_public_redirect_code_key`) —
 *     not excluded for soft-deleted rows, unlike this project's usual
 *     "partial unique index excludes soft-delete" convention. That is
 *     deliberate: a code must never be reassigned even after its PromoLink
 *     is soft-deleted.
 *   - **Never reused**: this module never reads or recycles a previously
 *     allocated code; every call mints a fresh random candidate.
 *   - **Immutable after creation**: enforced by the database trigger
 *     `reject_promo_public_redirect_code_change`
 *     (`prisma/migrations/20260803090000_p1_initial_schema/migration.sql`)
 *     — an `UPDATE` that touches this column always fails. This module only
 *     ever supplies the value for the initial `INSERT`; it has no update
 *     path and must never be given one.
 *   - **Never derived from `upstream_code`**: the two codes are
 *     independently generated. `upstream_code` (the channel's real promo
 *     code) must never appear in the public code, in a public URL, or in
 *     any audit/log line — see `worker/handlers/promo-link-claim.ts`'s
 *     `redactUpstreamCode`.
 *
 * Port registry: `docs/governance/port-registry.md` — `ADAPT` from CPS
 * `createArticlePublicPageShortId` / `createWithArticlePublicPageShortIdRetry`
 * / `isArticlePublicPageShortIdUniqueConflict`
 * (`src/lib/article-public-page-id.ts:36-85`, baseline
 * `d77c3b968285698529cf97c7f0f97b286d7a2a9c`): same alphabet-plus-forced-
 * digit generation and P2002-bounded-retry shape, adapted to this project's
 * different table/column/constraint names and a longer length (10 vs CPS's
 * 8) — this code is a *permanent, never-reissued* per-asset identifier
 * (unlike CPS's `publicPageShortId`, which is scoped to one Article and can
 * in principle be regenerated), so it gets extra collision headroom for a
 * project with a much longer intended lifetime. `promo_link.public_redirect_
 * code` is `VARCHAR(32)`, so 10 leaves ample room without approaching the
 * column limit.
 */
import { randomInt } from "node:crypto";

export const PUBLIC_REDIRECT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const PUBLIC_REDIRECT_CODE_LENGTH = 10;
const PUBLIC_REDIRECT_CODE_DIGIT = /\d/;
const PUBLIC_REDIRECT_CODE_FORMAT = new RegExp(
  `^[a-z0-9]{${PUBLIC_REDIRECT_CODE_LENGTH}}$`,
);

/** Database identifiers this project's unique-violation error can name for this column — kept in sync with the Prisma model/migration by `tests/backend/redirect/no-bypass.test.ts`. */
const PUBLIC_REDIRECT_CODE_UNIQUE_TARGETS = new Set([
  "publicRedirectCode",
  "public_redirect_code",
  "promo_link_public_redirect_code_key",
]);

/**
 * Mints one candidate code. Not itself collision-checked against the
 * database — callers must go through `createWithPublicRedirectCodeRetry`
 * (or independently catch `isPublicRedirectCodeUniqueConflict`) so the
 * database's `UNIQUE` index remains the actual correctness backstop.
 */
export function createPublicRedirectCode(): string {
  while (true) {
    let value = "";
    for (let index = 0; index < PUBLIC_REDIRECT_CODE_LENGTH; index += 1) {
      value += PUBLIC_REDIRECT_CODE_ALPHABET[randomInt(PUBLIC_REDIRECT_CODE_ALPHABET.length)];
    }
    // Forcing at least one digit (same CPS convention this is ported from)
    // keeps the code visibly distinct from an all-letter word, lowering the
    // odds it collides with a human-typed vanity string or reads as an
    // accidental real word in a support ticket.
    if (PUBLIC_REDIRECT_CODE_DIGIT.test(value)) return value;
  }
}

/** Defensive format check — used by the static-scan test and available to any future defense-in-depth caller. Never itself a source of truth for uniqueness. */
export function isPublicRedirectCodeFormatValid(value: string): boolean {
  return PUBLIC_REDIRECT_CODE_FORMAT.test(value);
}

export function isPublicRedirectCodeUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;
  const target = candidate.meta?.target;
  const targets = Array.isArray(target) ? target : target ? [target] : [];
  return targets.some(
    (item) => typeof item === "string" && PUBLIC_REDIRECT_CODE_UNIQUE_TARGETS.has(item),
  );
}

/**
 * Runs `run(code)` with a freshly minted candidate, retrying with a new
 * candidate only when the failure is this column's own unique-violation
 * (i.e. two concurrent inserts raced the same random value — statistically
 * negligible at this alphabet/length but not impossible, and the row-level
 * INSERT is the only place this code is ever assigned). Any other error
 * (including an unrelated unique violation, e.g. the row's own
 * `idempotency_key`) propagates immediately without a retry — this module
 * has no opinion on the caller's other constraints.
 */
export async function createWithPublicRedirectCodeRetry<T>(
  run: (code: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(createPublicRedirectCode());
    } catch (error) {
      if (attempt < attempts && isPublicRedirectCodeUniqueConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("unreachable public redirect code retry state");
}
