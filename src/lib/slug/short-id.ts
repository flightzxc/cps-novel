/**
 * `Article.publicPageShortId` generator — the sole, project-wide entry
 * point for this field, per `src/lib/slug/README.md` ("公开页面身份短码
 * (public_page_id)"). Distinct from and never to be confused with
 * `src/lib/redirect/public-redirect-code.ts`'s `public_redirect_code` (the
 * `/go/{code}` promo redirect code) — this README's "两码必须分离" framing:
 * this module owns *page identity*, the redirect module owns *promo
 * redirects*, and they must never share an implementation or a value space.
 *
 * Algorithm `ADAPT`-ed from CPS `src/lib/article-public-page-id.ts:8-16,33-79`
 * (`PUBLIC_PAGE_SHORT_ID_ALPHABET`/`createArticlePublicPageShortId`/
 * `isArticlePublicPageShortIdUniqueConflict`/
 * `createWithArticlePublicPageShortIdRetry`) — registered in
 * `docs/governance/port-registry.md`. Same alphabet, same length, same
 * forced-at-least-one-digit rule, same bounded-retry-on-P2002 shape; renamed
 * to drop CPS's Article/Drama-specific naming and generalized to this
 * project's field name. `isPublicPageShortIdConflict` is intentionally
 * layered *on top of* `isUniqueConstraintViolation`
 * (`src/lib/db/db-retry.ts`) rather than re-implementing a `P2002` check —
 * that module documents itself as the one place a `P2002` test may live.
 *
 * `tests/backend/slug/short-id-sole-source.test.ts` statically enforces that
 * this stays the only place in the repo that (a) writes a
 * `publicPageShortId:` key into an `.article.` create/update/upsert call, or
 * (b) redefines this module's alphabet constant.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";

import { isUniqueConstraintViolation } from "@/lib/db/db-retry";

/** Lowercase alphanumeric, ADAPTed from CPS's identical alphabet — see module header. */
export const PUBLIC_PAGE_SHORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const PUBLIC_PAGE_SHORT_ID_LENGTH = 8;

const HAS_DIGIT_RE = /\d/;

/**
 * Every form a Postgres unique-violation on this field's index might surface
 * as `PrismaClientKnownRequestError.meta.target` (Prisma's own shape varies:
 * sometimes the model field name, sometimes the `@map`-ed column name,
 * sometimes the DB constraint name) — checking all three, same defensive
 * spread as the CPS original, is cheaper than betting on exactly one.
 */
const PUBLIC_PAGE_SHORT_ID_UNIQUE_TARGETS = new Set([
  "publicPageShortId",
  "public_page_short_id",
  "article_public_page_short_id_key",
]);

/**
 * Generates one candidate short id. Not guaranteed unique on its own — pair
 * with `createWithPublicPageShortIdRetry` (or an equivalent P2002-bounded
 * retry) around the actual `Article` insert.
 */
export function generatePublicPageShortIdCandidate(): string {
  for (;;) {
    let value = "";
    for (let index = 0; index < PUBLIC_PAGE_SHORT_ID_LENGTH; index += 1) {
      value += PUBLIC_PAGE_SHORT_ID_ALPHABET[randomInt(PUBLIC_PAGE_SHORT_ID_ALPHABET.length)];
    }
    if (HAS_DIGIT_RE.test(value)) return value;
  }
}

/** True only for a unique-violation on *this specific* field's index — a collision on some other constraint in the same `create` call must propagate, not trigger a pointless regenerate-and-retry. */
export function isPublicPageShortIdConflict(error: unknown): boolean {
  if (!isUniqueConstraintViolation(error)) return false;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targets.some((item) => typeof item === "string" && PUBLIC_PAGE_SHORT_ID_UNIQUE_TARGETS.has(item));
}

/**
 * Runs `run` with a freshly generated candidate short id, regenerating and
 * retrying (bounded) only when the failure is a collision on this field's
 * own unique index. Any other error — including a unique violation on a
 * *different* field in the same insert — propagates immediately on the
 * first attempt, since regenerating this field cannot fix that.
 */
export async function createWithPublicPageShortIdRetry<T>(
  run: (publicPageShortId: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(generatePublicPageShortIdCandidate());
    } catch (error) {
      if (attempt < attempts && isPublicPageShortIdConflict(error)) continue;
      throw error;
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("createWithPublicPageShortIdRetry: exhausted attempts without returning or throwing");
}
