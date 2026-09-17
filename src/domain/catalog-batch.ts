export type CatalogFilterSnapshot = Readonly<{
  status?: string;
  search?: string;
  sourceLocale?: string;
}>;

export type CatalogSelection =
  | Readonly<{ scope: "explicit_ids"; ids: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: CatalogFilterSnapshot }>;

export type NormalizedCatalogFilterSnapshot = Readonly<{
  status: "pending" | "linked" | "ignored" | "stale";
  search?: string;
  sourceLocale?: string;
}>;

export type NormalizedCatalogSelection =
  | Readonly<{ scope: "explicit_ids"; ids: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: NormalizedCatalogFilterSnapshot }>;

export class CatalogSelectionInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CatalogSelectionInputError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "linked", "ignored", "stale"]);

/** Browser-safe canonicalization used by actions and catalog UI. */
export function normalizeCatalogSelection(selection: CatalogSelection): NormalizedCatalogSelection {
  if (!selection || typeof selection !== "object") throw new CatalogSelectionInputError("selection_required");
  if (selection.scope === "explicit_ids") {
    if (!Array.isArray(selection.ids) || selection.ids.some((id) => typeof id !== "string")) {
      throw new CatalogSelectionInputError("items_invalid");
    }
    const ids = Array.from(new Set(selection.ids.map((id) => id.trim().toLowerCase()))).sort();
    if (ids.length === 0) throw new CatalogSelectionInputError("items_required");
    if (ids.some((id) => !UUID.test(id))) throw new CatalogSelectionInputError("novel_source_item_id_invalid");
    return Object.freeze({ scope: "explicit_ids", ids: Object.freeze(ids) });
  }
  if (selection.scope !== "all_filtered") throw new CatalogSelectionInputError("selection_scope_invalid");
  if (!selection.filter || typeof selection.filter !== "object" || Array.isArray(selection.filter)) {
    throw new CatalogSelectionInputError("filter_invalid");
  }
  const raw = selection.filter;
  if (raw.status !== undefined && typeof raw.status !== "string") throw new CatalogSelectionInputError("filter_status_invalid");
  if (raw.search !== undefined && typeof raw.search !== "string") throw new CatalogSelectionInputError("filter_search_invalid");
  if (raw.sourceLocale !== undefined && typeof raw.sourceLocale !== "string") throw new CatalogSelectionInputError("filter_source_locale_invalid");
  const status = raw.status?.trim() || "pending";
  if (!STATUSES.has(status)) throw new CatalogSelectionInputError("filter_status_invalid");
  const search = raw.search?.trim();
  if (search && search.length > 200) throw new CatalogSelectionInputError("filter_search_too_long");
  const sourceLocale = raw.sourceLocale?.trim();
  if (sourceLocale && sourceLocale.length > 16) throw new CatalogSelectionInputError("filter_source_locale_too_long");
  return Object.freeze({
    scope: "all_filtered",
    filter: Object.freeze({
      status: status as NormalizedCatalogFilterSnapshot["status"],
      ...(search ? { search } : {}),
      ...(sourceLocale ? { sourceLocale } : {}),
    }),
  });
}

/**
 * X10 task control (pause/resume/abort): `paused`/`cancelled` are additive
 * next to `disabled` — a catalog_batch parent (or one of its children) is
 * just as reachable through the generic `TaskControlButtons` UI as any other
 * task, and `pauseTask`/`abortTask` (`src/server/task-admin/service.ts`) now
 * write these two formal statuses instead of `disabled` for that. Guarded
 * the same way `disabled` always was: checked before the
 * `enumerationStatus`-driven aggregation below, so an explicitly paused/
 * aborted batch is never silently re-derived back into `materializing`/
 * `executing`/`completed*` from its enumeration state or its children's
 * counts.
 */
export type CatalogBatchPhase = "queued" | "disabled" | "paused" | "cancelled" | "materializing" | "executing" | "completed" | "completed_with_errors" | "failed" | "expired";

export function deriveCatalogBatchPhase(input: {
  parentStatus: string;
  enumerationStatus?: unknown;
  childStatuses?: readonly string[];
  blockedCount?: number;
}): CatalogBatchPhase {
  if (input.parentStatus === "disabled") return "disabled";
  if (input.parentStatus === "paused") return "paused";
  if (input.parentStatus === "cancelled") return "cancelled";
  if (input.enumerationStatus === "expired") return "expired";
  if (input.enumerationStatus !== "completed") {
    if (input.parentStatus === "failed" || input.parentStatus === "completed_with_errors") return "failed";
    return input.parentStatus === "processing" ? "materializing" : "queued";
  }
  const children = input.childStatuses ?? [];
  if (children.some((status) => status === "pending" || status === "processing")) return "executing";
  if (children.some((status) => status === "cancelled")) return "cancelled";
  if (children.some((status) => status === "paused")) return "paused";
  if (children.some((status) => status === "disabled")) return "disabled";
  if (input.parentStatus === "processing") return "executing";
  if (input.parentStatus === "failed") return "failed";
  if (input.parentStatus === "completed_with_errors") return "completed_with_errors";
  const failures = children.filter((status) => status === "failed" || status === "completed_with_errors").length;
  if (children.length > 0 && children.every((status) => status === "failed")) return "failed";
  if (failures > 0 || (input.blockedCount ?? 0) > 0) return "completed_with_errors";
  return "completed";
}

export type CatalogBatchContext = Readonly<{
  submittedCount: number | null;
  channelGroups: readonly Readonly<{
    channelAppId: string;
    channelCode: string;
    channelName: string;
    active: boolean;
    claimCapabilityEnabled: boolean;
    eligibleCount: number;
    accounts: readonly Readonly<{ id: string; name: string }>[];
  }>[];
  locales: readonly Readonly<{
    locale: string;
    eligibleCount: number;
    templates: readonly Readonly<{ key: string; name: string }> [];
  }>[];
}>;

/**
 * Only ever populated for `operation: "promo_claim"`, and only when at least
 * one `(channelAppId, channelAccountId)` pair in the submitted scope has a
 * currently-usable credential that is expiring within the promo-claim
 * batch's own TTL window (`CREDENTIAL_EXPIRY_WARNING_WINDOW_MS`,
 * `src/lib/credentials/claim-readiness.ts`) — advisory only, the batch was
 * already admitted. Absent (never an empty array) when there is nothing to
 * warn about, matching this codebase's "absent, not empty" convention for
 * every other optional derived field.
 */
export type PromoLinkClaimCredentialWarning = Readonly<{
  channelAppId: string;
  channelAccountId: string;
  expiresAt: string;
}>;

export type CatalogBatchEnqueueResult = Readonly<{
  taskId: string;
  phase: CatalogBatchPhase;
  credentialWarnings?: readonly PromoLinkClaimCredentialWarning[];
}>;

export type CatalogBatchSummary = Readonly<{
  taskId: string;
  phase: CatalogBatchPhase;
  submittedCount: number | null;
  ineligibleCount: number | null;
  alreadyLinkedCount: number | null;
  blockedCount: number | null;
}>;
