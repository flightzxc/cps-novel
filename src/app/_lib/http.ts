/**
 * Page-layer HTTP 410 helper.
 *
 * Next 16.1 exposes `notFound()` / `forbidden()` / `unauthorized()` but not
 * `gone()`. Those helpers throw an error whose `digest` is
 * `NEXT_HTTP_ERROR_FALLBACK;<status>`; the App Router maps that digest onto
 * the response status. This module uses the same interrupt so a Server
 * Component can emit a real 410 without putting a database lookup in
 * middleware / `proxy.ts`.
 */

const HTTP_ERROR_FALLBACK_ERROR_CODE = "NEXT_HTTP_ERROR_FALLBACK";
export const GONE_DIGEST = `${HTTP_ERROR_FALLBACK_ERROR_CODE};410`;

export function isGoneError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    (error as { digest?: unknown }).digest === GONE_DIGEST
  );
}

export function gone(): never {
  const error = Object.defineProperty(new Error(GONE_DIGEST), "__NEXT_ERROR_CODE", {
    value: "E394",
    enumerable: false,
    configurable: true,
  }) as Error & { digest: string };
  error.digest = GONE_DIGEST;
  throw error;
}
