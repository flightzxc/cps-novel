import {
  ADMIN_CONTENT_MAX_PAGE_SIZE,
  type AdminChapterListInput,
  type AdminNovelListInput,
} from "@/domain/admin-content";
import type { AdminAuthContext } from "@/lib/auth/types";

import { requireContentReadCapability, type ContentReadCapability } from "./content-capabilities";
import { guardRead } from "./route";

/**
 * The single entry point for every P2-04 content route.
 *
 * Two gates, in order:
 *
 * 1. `guardRead` — resolves the path against the registry (unregistered ⇒ 404
 *    before any session lookup) and requires a valid Admin session.
 * 2. `requireContentReadCapability` — the read grant, with no 2FA step-up.
 *
 * Routes call this and nothing else; `tests/ui/admin-content-registry.test.ts`
 * greps every content `route.ts` for exactly this call with the capability the
 * registry binds to it, so a new route cannot ship with a weaker gate.
 */
export async function guardContentRead(
  request: Request,
  capability: ContentReadCapability,
): Promise<AdminAuthContext> {
  const context = await guardRead(request);
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
