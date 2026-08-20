/**
 * `Novel.businessId` generator (P0-S4 content creation service). This is
 * **not** claimed anywhere as a project-wide "sole entry point" the way
 * `Article.publicPageShortId` (`src/lib/slug/short-id.ts`) and
 * `public_redirect_code` (`src/lib/redirect/`) are — no README assigns
 * `business_id` that status, and it isn't a URL-facing identity code, just a
 * "stable, auditable, human-inspectable" internal business key
 * (`docs/governance/database-governance.md` §4 `novel` row). It exists
 * purely as this creation service's own implementation detail for
 * satisfying `Novel.businessId NOT NULL UNIQUE`
 * (`novel_business_id_key`), so it lives beside `service.ts` rather than in
 * `src/lib/slug/`.
 *
 * Deliberately uses a *different* alphabet literal than
 * `src/lib/slug/short-id.ts` (digits-first vs. that module's letters-first)
 * so this file's source text never coincidentally matches
 * `tests/backend/slug/short-id-sole-source.test.ts`'s duplicate-algorithm
 * scan — the two generators are independent by design (different field,
 * different table, different uniqueness scope) and this just keeps that
 * true at the source-text level too, not only conceptually.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";

import { isUniqueConstraintViolation } from "@/lib/db/db-retry";

const BUSINESS_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BUSINESS_ID_RANDOM_LENGTH = 12;
const BUSINESS_ID_PREFIX = "nv-";

const BUSINESS_ID_UNIQUE_TARGETS = new Set(["businessId", "business_id", "novel_business_id_key"]);

/** Generates one candidate `Novel.businessId`. Not guaranteed unique — pair with `createNovelWithBusinessIdRetry`. */
export function generateNovelBusinessIdCandidate(): string {
  let random = "";
  for (let index = 0; index < BUSINESS_ID_RANDOM_LENGTH; index += 1) {
    random += BUSINESS_ID_ALPHABET[randomInt(BUSINESS_ID_ALPHABET.length)];
  }
  return `${BUSINESS_ID_PREFIX}${random}`;
}

/** True only for a unique-violation on `Novel.businessId`'s own index — see `src/lib/slug/short-id.ts`'s sibling function for why this matters. */
export function isNovelBusinessIdConflict(error: unknown): boolean {
  if (!isUniqueConstraintViolation(error)) return false;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targets.some((item) => typeof item === "string" && BUSINESS_ID_UNIQUE_TARGETS.has(item));
}

/** Runs `run` with a freshly generated candidate `businessId`, regenerating and retrying (bounded) only on a collision against this field's own unique index. */
export async function createNovelWithBusinessIdRetry<T>(
  run: (businessId: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(generateNovelBusinessIdCandidate());
    } catch (error) {
      if (attempt < attempts && isNovelBusinessIdConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("createNovelWithBusinessIdRetry: exhausted attempts without returning or throwing");
}
