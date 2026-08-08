import { notFound } from "next/navigation";

import { projectErrorEnvelope, type ErrorEnvelope } from "@/contracts";
import { AdminContentQueryError } from "@/server/admin-content";

/**
 * Turn a kernel throw into the right page outcome.
 *
 * The failure mode this exists to prevent is `.catch(() => null)`: it reads as
 * "no such novel", but it also swallows a dropped database connection, a query
 * timeout and a driver error, and reports all three to the operator as a clean
 * 404. That is the worst possible answer — it says "this book does not exist"
 * when the truth is "we could not find out", and it sends someone looking for a
 * deleted row instead of a broken database.
 *
 * So exactly one code maps to 404, and everything else is re-thrown to the
 * segment's error boundary.
 */
export function notFoundIfMissingIdentifier(error: unknown): never {
  if (error instanceof AdminContentQueryError && error.code === "invalid_identifier") {
    notFound();
  }
  throw error;
}

/**
 * Query-string validation errors are the operator's to fix, not an outage.
 *
 * `?page=0` or `?status=bogus` reaches the kernel and is rejected; the page
 * renders an inline panel naming the bad parameter rather than falling through
 * to the error boundary, which would replace the whole screen for what is a
 * typo in a URL. Returns null for anything else so the caller re-throws.
 */
export function queryErrorEnvelope(error: unknown): ErrorEnvelope | null {
  if (!(error instanceof AdminContentQueryError)) return null;
  // A malformed id is a broken link, not a bad filter — that one is a 404.
  if (error.code === "invalid_identifier") return null;
  return projectErrorEnvelope({ code: error.code, status: 400 });
}
