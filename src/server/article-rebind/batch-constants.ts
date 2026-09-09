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
 *
 * 🔴 `proxyWindowMs` / `requestBudgetMs` (C-30 单 3 W-2/W-3,
 * 施工工单_C30单3_批量换小说分块执行_移植CPS_V2_2026-09-09.md §3.1/§2.5).
 * CPS HAS NO corresponding constant — these two are new here, derived from
 * CPS's own v7.9.7 §10.3 rule ("单批全链路 p99 必须小于代理窗口的 80%") applied
 * to THIS repo's actual proxy window, which is HALF of CPS's:
 *
 *   proxyWindowMs (this repo) = 30_000 ms — EXPLICIT nginx config, not a
 *     60s default assumption: `infra/production-like/nginx/snippets/
 *     proxy-headers.conf:9` (`proxy_read_timeout 30s;`), included by the
 *     admin content route that this batch's submit/resume Server Actions
 *     POST through (`infra/production-like/nginx/full.conf.template:
 *     206-207`). CPS itself sets nothing (`nginx/` has zero
 *     `proxy_read_timeout` lines) and so rides nginx's own 60s default —
 *     do NOT assume 60s here; it would be double this repo's real window.
 *   0.80             = CPS's own safety coefficient (v7.9.7 design doc
 *                       §10.3), reused verbatim, not re-derived.
 *   requestBudgetMs  = proxyWindowMs * 0.80 = 24_000 ms. Written as the
 *                       literal (not the expression) for the same reason
 *                       every other field here is a literal: `as const`
 *                       under a computed expression loses its literal
 *                       type, and this object's own convention is bare
 *                       numbers.
 *
 * Per-item allowed cost check (both sides land on the same number):
 *   this repo: 24,000 ms / apply:200 = 120 ms/item
 *   CPS:       48,000 ms / apply:400 = 120 ms/item   (CPS's proxy window
 *              60,000 ms x 0.80 = 48,000 ms; CPS's own p99 gate was never
 *              actually run — see the construction order's §0 for the
 *              citations — so this repo's own 200-item integration timing
 *              in `tests/integration/article-rebind/batch-200.test.ts` is
 *              the only real measurement on either side of this link)
 *
 * NOT a per-request item-count limit — `apply: 200` above is still the
 * only count-dimension ceiling and it does not change. `requestBudgetMs`
 * only gates `executeRebindBatch`'s wall clock (`batch.ts`'s own loop,
 * checked once per item BEFORE claiming it — see that function's own
 * comment for why before-claim, not after).
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
  proxyWindowMs: 30_000,
  requestBudgetMs: 24_000,
} as const;

export type RebindPreviewCategory = "executable" | "risk_blocked" | "ambiguous" | "skipped";

export const REBIND_PREVIEW_CATEGORIES: readonly RebindPreviewCategory[] = Object.freeze([
  "executable",
  "risk_blocked",
  "ambiguous",
  "skipped",
]);
