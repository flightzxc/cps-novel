import {
  ADMIN_CONTENT_MAX_PAGE_SIZE,
  type AdminChapterListInput,
  type AdminNovelListInput,
  type AdminSourceLabelListInput,
} from "@/domain/admin-content";

/**
 * Query parsing for the content routes.
 *
 * There is no guard here any more. `content:view` / `content:read` are ordinary
 * `AdminCapability` members, so the content routes authorise through the same
 * `guardRead` as every other admin route: `requireAdminRouteAccess` resolves the
 * path against the registry, requires a session, calls the kernel step-up gate
 * — X12 requires every human admin API/Action session to have completed it —
 * and then calls `enforceCapability`, which reads the grant off the
 * registration. These two are configured `requiresTwoFactor: false`, but that
 * is the capability axis only: it adds no additional step-up requirement on
 * top of the session-level gate that already ran.
 *
 * The bespoke `guardContentRead` that used to live here was a second
 * authorisation implementation. It is gone, and nothing replaced it — that is
 * the point.
 */

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
    labelId: optional(params, "labelId"),
  };
}

/** Same parse-only discipline as {@link novelListQuery} — `labelKind` and
 * `activity` are registered-value lists the kernel owns, not this layer. */
export function sourceLabelListQuery(url: URL): AdminSourceLabelListInput {
  const params = url.searchParams;
  const page = optional(params, "page");
  const pageSize = optional(params, "pageSize");
  return {
    page: page === undefined ? undefined : Number(page),
    pageSize: pageSize === undefined ? undefined : Number(pageSize),
    labelKind: optional(params, "labelKind") as AdminSourceLabelListInput["labelKind"],
    search: optional(params, "search"),
    activity: optional(params, "activity") as AdminSourceLabelListInput["activity"],
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
