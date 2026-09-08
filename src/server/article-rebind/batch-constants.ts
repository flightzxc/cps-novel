/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.1/§3.1). CPS
 * parity — `DURABLE_BATCH_SWITCH_LIMITS`
 * (`article-drama-batch-switch-service.ts:906-920`), copied verbatim except
 * `apply`.
 *
 * 🔴 `apply`: CPS is 400 — its rebind writes a single `dramaId` column with
 * no composite FK. This repo's rebind writes TWO columns
 * (`novelId`+`promoLinkId`) per item under a composite FK
 * (`article_promo_link_novel_fkey`) plus a per-item `OperationAudit` insert,
 * so each item's own transaction is heavier. Halved to 200 pending the
 * construction order's own §7 item 2 instruction ("需集成测试实测确认") —
 * `tests/integration/article-rebind/batch-200.test.ts` (env-gated,
 * `C30_DATABASE_TEST=1`) records real timing for a 200-item run so this
 * constant can be confirmed or adjusted against real data. This value has
 * NOT been re-tuned from that test in this environment — see this order's
 * delivery report for why (no database available to run it against here).
 */
export const REBIND_BATCH_LIMITS = {
  sourceScan: 20_000,
  destinationScan: 20_000,
  candidate: 1_600,
  apply: 200,
  pageSize: 50,
  defaultPageSize: 25,
  ambiguousDisplayCandidates: 20,
  previewTtlMs: 30 * 60 * 1_000,
  leaseMs: 90 * 1_000,
  leaseRenewEvery: 25,
  leaseRenewThresholdMs: 30 * 1_000,
  cleanupRows: 100,
  cleanupMs: 100,
} as const;

export type RebindPreviewCategory = "executable" | "risk_blocked" | "ambiguous" | "skipped";

export const REBIND_PREVIEW_CATEGORIES: readonly RebindPreviewCategory[] = Object.freeze([
  "executable",
  "risk_blocked",
  "ambiguous",
  "skipped",
]);
