import { getSiteUrl } from "@/lib/seo/site-url";
import { ADMIN_API_NAMESPACE, ADMIN_PAGE_ROOTS, resolveAdminPage, type AdminRegistry } from "@/server/auth/registry";

/**
 * RC-9 admin-host isolation (2026-09-03, Owner): pure host/path
 * classification consumed by `src/proxy.ts`.
 *
 * `src/proxy.ts` runs in the proxy/Edge runtime and therefore cannot import
 * `src/app/api/admin/_lib/deps.ts` — that module pulls in `@prisma/client`
 * and `next/headers`, neither of which is safe there. This file has zero
 * Node-specific or Prisma dependencies so it is.
 *
 * This is a companion to, not a replacement for, `deps.ts`'s
 * `canonicalOrigin()`: that function's one-line
 * `process.env.ADMIN_CANONICAL_ORIGIN?.trim() ?? ""` is pinned verbatim by
 * `tests/backend/auth/security-boundaries.test.ts` and is left untouched.
 * `readAdminCanonicalOrigin()` below reads the same env var the same way
 * (trim, empty string when unset) so the two can never define "read
 * ADMIN_CANONICAL_ORIGIN" differently; `tests/ui/proxy-admin-host.test.ts`
 * pins that this file's read expression matches deps.ts's, byte for byte.
 * The actual new logic here — parsing the value into a hostname and
 * comparing it against the site host — does not exist anywhere else in the
 * repo: `deps.ts` never parses the value into a URL at all (validation
 * happens downstream, per-mutation, inside `requireSameOrigin`), so there is
 * nothing to de-duplicate on that front.
 */

export class AdminOriginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminOriginConfigurationError";
  }
}

/** Mirrors `deps.ts`'s `canonicalOrigin()` read exactly — see file doc comment. */
export function readAdminCanonicalOrigin(
  env: Readonly<{ ADMIN_CANONICAL_ORIGIN?: string }> = {
    ADMIN_CANONICAL_ORIGIN: process.env.ADMIN_CANONICAL_ORIGIN,
  },
): string {
  return env.ADMIN_CANONICAL_ORIGIN?.trim() ?? "";
}

export type AdminHostResolution =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: "missing" | "invalid" };

/**
 * Parses a raw `ADMIN_CANONICAL_ORIGIN` value into a lowercase hostname (no
 * port, no scheme). Never throws: an unset or malformed value resolves to
 * `{ ok: false }` rather than crashing every request, because the safe
 * behavior on misconfiguration is "no host is ever recognised as the admin
 * host" — `evaluateAdminHostAccess` below turns that into "every admin path
 * 404s on every host" (fail-closed), not an outage of the whole app.
 */
export function resolveAdminHost(raw: string): AdminHostResolution {
  if (!raw) return { ok: false, reason: "missing" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, host: parsed.hostname.toLowerCase() };
}

/** Lowercase hostname (no port) of an already-validated absolute origin, e.g. `getSiteUrl()`'s return value. */
export function hostnameOf(originUrl: string): string {
  return new URL(originUrl).hostname.toLowerCase();
}

/**
 * `getSiteUrl()`'s hostname, or `null` if `SITE_URL` is unset/malformed.
 *
 * Deliberately swallows `SiteUrlConfigurationError` here rather than letting
 * it propagate out of the proxy: a broken `SITE_URL` must not turn into a
 * full-site outage on every request. Falling back to `null` routes the
 * request through `evaluateAdminHostAccess`'s "host did not match anything
 * recognised" branch, which still fail-closes every admin path while
 * leaving public traffic unaffected — degrade the guarantee this module
 * exists to provide, not the rest of the site.
 */
export function resolveSiteHostSafely(): string | null {
  try {
    return hostnameOf(getSiteUrl());
  } catch {
    return null;
  }
}

/** Strips an optional port from a raw `Host` request header value, tolerant of IPv6 bracket notation. Returns `null` for empty/missing input. */
export function normalizeRequestHost(hostHeader: string | null | undefined): string | null {
  const raw = hostHeader?.trim();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Single source of truth for "is this an admin path" at the proxy layer:
 * `ADMIN_PAGE_ROOTS` (the `(admin)` route group, `src/server/auth/registry.ts`)
 * plus the two `(admin-auth)` roots that are not page-guard-registered
 * because they exist to *establish* the session in the first place
 * (`/login`, `/two-factor` — see `src/app/(admin)/_lib/page-guard.ts`'s own
 * doc comment on why `/login` is deliberately outside `ADMIN_PAGE_ROOTS`),
 * plus the `/api/admin` namespace. No second literal admin-path list exists
 * anywhere else in the proxy/nginx layer:
 * `scripts/lib/admin-path-roots.json` (nginx's defense-in-depth allow/deny
 * list) is authored to match this exact set and
 * `tests/ui/admin-path-roots-parity.test.ts` pins that it does.
 *
 * Reuses `resolveAdminPage`'s existing normalisation (percent-decoding,
 * backslash/`..`/double-slash rejection, case-insensitive segment matching)
 * instead of re-implementing path matching a second time.
 */
const ADMIN_HOST_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: Object.freeze([...ADMIN_PAGE_ROOTS, "/login", "/two-factor", ADMIN_API_NAMESPACE]),
  routes: Object.freeze([]),
  actions: Object.freeze([]),
});

export const ADMIN_HOST_PATH_ROOTS: readonly string[] = ADMIN_HOST_REGISTRY.pageRoots;

export function isAdminPath(pathname: string): boolean {
  return resolveAdminPage(pathname, ADMIN_HOST_REGISTRY) !== null;
}

/** Paths every host must serve regardless of the admin/public split — currently just the health endpoints (UptimeRobot probes both origins). */
const SHARED_PATH_PREFIXES = ["/api/health"] as const;

function isSharedPath(pathname: string): boolean {
  return SHARED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export interface AdminHostAccessInput {
  readonly requestHostHeader: string | null;
  readonly pathname: string;
  readonly nodeEnv: string | undefined;
}

export interface AdminHostAccessConfig {
  readonly siteHost: string | null;
  readonly adminHostResolution: AdminHostResolution;
}

export interface AdminHostAccessResult {
  readonly allow: boolean;
  /**
   * True exactly when this evaluation ran the same-origin-in-production
   * misconfiguration branch (`ADMIN_CANONICAL_ORIGIN` host ===  `SITE_URL`
   * host, `NODE_ENV=production`). Callers use this to log the
   * misconfiguration once, independent of which specific request path
   * triggered it.
   */
  readonly sameOriginProductionMisconfig: boolean;
}

/**
 * The RC-9 rule table (also documented at the top of `src/proxy.ts`):
 *
 * | request host                              | admin path | public path | shared path |
 * | ------------------------------------------ | ---------- | ----------- | ----------- |
 * | == adminHost, adminHost != siteHost         | allow      | **404**     | allow       |
 * | == siteHost                                 | **404**    | allow       | allow       |
 * | other / missing, or adminHost unresolved    | **404**    | allow       | allow       |
 * | adminHost == siteHost (same-origin), prod   | **404**    | allow       | allow       |
 * | adminHost == siteHost (same-origin), dev    | allow      | allow       | allow       |
 *
 * Shared paths (`isSharedPath`) are decided before any host branching, so
 * they always pass regardless of which host the request came in on.
 */
export function evaluateAdminHostAccess(
  input: AdminHostAccessInput,
  config: AdminHostAccessConfig,
): AdminHostAccessResult {
  if (isSharedPath(input.pathname)) {
    return { allow: true, sameOriginProductionMisconfig: false };
  }

  const admin = isAdminPath(input.pathname);
  const { siteHost, adminHostResolution } = config;
  const adminHost = adminHostResolution.ok ? adminHostResolution.host : null;

  if (adminHost !== null && siteHost !== null && adminHost === siteHost) {
    if (input.nodeEnv === "production") {
      return { allow: !admin, sameOriginProductionMisconfig: true };
    }
    // Non-production same-origin fallback (plain `npm run dev` with a single
    // ADMIN_CANONICAL_ORIGIN/SITE_URL pair, e.g. scripts/lib/p1-12-local-env.sh's
    // default). Never the shape production is allowed to be in.
    return { allow: true, sameOriginProductionMisconfig: false };
  }

  const requestHost = normalizeRequestHost(input.requestHostHeader);

  if (adminHost !== null && requestHost === adminHost) {
    return { allow: admin, sameOriginProductionMisconfig: false };
  }
  if (siteHost !== null && requestHost === siteHost) {
    return { allow: !admin, sameOriginProductionMisconfig: false };
  }
  // Missing/unrecognised Host header, an unresolved SITE_URL, or an
  // unconfigured/invalid ADMIN_CANONICAL_ORIGIN: fail closed the same way as
  // the public host for everything that isn't an admin path (nginx's default
  // server decides what an unrecognised Host does), and never for one that
  // is.
  return { allow: !admin, sameOriginProductionMisconfig: false };
}
