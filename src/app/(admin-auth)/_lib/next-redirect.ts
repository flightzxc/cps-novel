/**
 * True when `error` is the exception Next.js throws from `redirect()` /
 * `permanentRedirect()` (its `digest` starts with `NEXT_REDIRECT`).
 *
 * Client forms that wrap a Server Action call in `try/catch` must re-throw
 * these untouched: a redirect is control flow, not a failure, and swallowing
 * it would leave the operator on the current page after the server already
 * decided to send them elsewhere. Every other exception (network failure, a
 * stale page whose Server Action no longer exists after a deploy, a proxy
 * 401/429 answering with HTML instead of the action payload) is a real failure
 * and gets the shared copy `ADMIN_ACTION_REQUEST_FAILED_COPY`.
 *
 * Deliberately free of server-only imports so client components can use it.
 */
export function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}
