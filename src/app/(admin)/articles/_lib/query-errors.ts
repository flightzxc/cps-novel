import { projectErrorEnvelope, type ErrorEnvelope } from "@/contracts";
import { AdminContentQueryError } from "@/server/admin-content";

/**
 * M7 list-filter validation errors → an inline 400 panel, never the segment
 * error boundary.
 *
 * Deliberately narrower than `../../novels/_lib/content-errors.ts`'s
 * `queryErrorEnvelope`: that one special-cases `invalid_identifier` as "this
 * is actually a 404" because on `/novels/[novelId]` an invalid id is the
 * *page's own* resource identifier. Here `novelId`/`templateId` are list
 * *filters* on `/articles`'s query string, not a path segment naming one
 * article — a malformed one is "fix your filter", the same 400 as a bad
 * `status` or `locale`, never "this article does not exist". So every
 * `AdminContentQueryError` code maps to 400 here, with no exception.
 */
export function articleQueryErrorEnvelope(error: unknown): ErrorEnvelope | null {
  if (!(error instanceof AdminContentQueryError)) return null;
  return projectErrorEnvelope({ code: error.code, status: 400 });
}
