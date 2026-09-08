/**
 * Fix 3 (Opus review of C-21/22/23): the "trim, reject blank, cap at 1000
 * chars" validation for an operator-authored, audit-writing reason used to
 * live only inside `../_actions.ts`'s private `requireNonBlankReason` —
 * duplicated by hand wherever a reason field needed the same guard before
 * this module existed. Both `../_actions.ts` (withdraw/takedown/restore) and
 * `../../articles/_components/article-list.tsx` (the article list's
 * row-level "下线" dialog) now call this single function instead.
 *
 * Returns a discriminated result rather than throwing: `../_actions.ts`
 * wraps the throwing shape it already had (`PublishActionInputError`) around
 * this, while `article-list.tsx` — a `"use client"` component with no
 * try/catch-driven control flow for this — reads the result directly.
 *
 * The 1000-char ceiling is not read from anywhere: `applyNovelRightsTransition`'s
 * own `trimmedReason` in `src/server/publish-gate/service.ts` hardcodes the
 * same 1000, and that function is the actual source of truth this module
 * mirrors client-side (same "UI-side early warning only, not the
 * enforcement" posture `./batch-publish-constants.ts` documents for
 * `MAX_BATCH_PUBLISH_SELECTION`).
 */
export const REASON_MAX_LENGTH = 1000;

export type ReasonValidationCode = "reason_required" | "reason_too_long";

export type ReasonValidation =
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly code: ReasonValidationCode };

export function validateReason(reason: string): ReasonValidation {
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "reason_required" };
  if (trimmed.length > REASON_MAX_LENGTH) return { ok: false, code: "reason_too_long" };
  return { ok: true, reason: trimmed };
}
