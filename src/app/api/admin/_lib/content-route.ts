import {
  ADMIN_CONTENT_MAX_PAGE_SIZE,
  type AdminChapterListInput,
  type AdminNovelListInput,
} from "@/domain/admin-content";
import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminAuthContext } from "@/lib/auth/types";
import { resolveAdminRoute } from "@/server/auth/registry";

import { requireContentReadCapability } from "./content-capabilities";
import { P2_04_ADMIN_REGISTRY, contentReadCapabilityForRoute } from "./registry";
import { guardRead } from "./route";

/**
 * The single entry point for every P2-04 content route.
 *
 * Three gates, in order:
 *
 * 1. `guardRead` — resolves the path against the registry (unregistered ⇒ 404
 *    before any session lookup) and requires a valid Admin session.
 * 2. registry lookup — which read grant this route runs under.
 * 3. `requireContentReadCapability` — the grant itself, with no 2FA step-up.
 *
 * The capability is **not** a parameter. A handler cannot name its own grant, so
 * it cannot name the wrong one, and a route that reaches here without being
 * registered as a content route is refused rather than run ungated. Resolution
 * reuses the kernel's `resolveAdminRoute`, so path normalisation and matching
 * have one implementation, not two.
 */
export async function guardContentRead(request: Request): Promise<AdminAuthContext> {
  const context = await guardRead(request);
  const route = resolveAdminRoute(
    new URL(request.url).pathname,
    request.method,
    P2_04_ADMIN_REGISTRY,
  );
  const capability = route ? contentReadCapabilityForRoute(route.id) : null;
  if (!capability) {
    // Unreachable while every content route is registered; if it ever is
    // reached, the route is not a content route and must not borrow one's grant.
    throw new AdminAccessError(
      "admin_route_not_registered",
      404,
      "Route is not registered as an admin content read route",
    );
  }
  requireContentReadCapability(context, capability);
  return context;
}

/**
 * Chapter-content reads are audited, and the audit row wants a request id.
 *
 * Unlike a mutation id this one is not an idempotency key and carries no
 * conflict semantics — nothing is written twice if it repeats. A client-supplied
 * `x-request-id` is used when present so an operator's browser call can be
 * correlated end-to-end; otherwise one is minted here. Length is clamped to what
 * `readAdminChapterContent` accepts, so a hostile header cannot turn into a
 * validation error the operator has to decode.
 */
export function contentReadRequestId(request: Request): string {
  const header = request.headers.get("x-request-id")?.trim() ?? "";
  return header.length > 0 && header.length <= 160 ? header : crypto.randomUUID();
}

function optional(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

/**
 * Parses only what the kernel validates.
 *
 * Numbers are passed through as `Number(...)`, including `NaN` for junk input:
 * `normalizeAdminNovelListInput` rejects anything that is not a positive integer
 * with `invalid_page` / `invalid_page_size`, and re-implementing that check here
 * would create a second, drifting definition of "valid page". Same for `status`
 * and `locale` — the kernel owns the registered-value lists.
 */
export function novelListQuery(url: URL): AdminNovelListInput {
  const params = url.searchParams;
  const page = optional(params, "page");
  const pageSize = optional(params, "pageSize");
  return {
    page: page === undefined ? undefined : Number(page),
    pageSize: pageSize === undefined ? undefined : Number(pageSize),
    status: optional(params, "status") as AdminNovelListInput["status"],
    locale: optional(params, "locale"),
    search: optional(params, "search"),
  };
}

export function chapterListQuery(url: URL): AdminChapterListInput {
  const params = url.searchParams;
  const page = optional(params, "page");
  const pageSize = optional(params, "pageSize");
  return {
    novelId: params.get("novelId")?.trim() ?? "",
    page: page === undefined ? undefined : Number(page),
    pageSize: pageSize === undefined ? undefined : Number(pageSize),
    status: optional(params, "status") as AdminChapterListInput["status"],
  };
}

export { ADMIN_CONTENT_MAX_PAGE_SIZE };
