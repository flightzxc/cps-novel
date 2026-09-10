/** P1-05A review draft. Database CHECK clauses will be generated from these sets after Claude review. */
export const CHANNEL_STATUSES = ["active", "inactive", "registered_disabled"] as const;
export const CHANNEL_ACCOUNT_STATUSES = ["active", "disabled"] as const;
export const CAPABILITY_STATUSES = ["enabled", "registered_disabled", "registered_partial"] as const;
export const CREDENTIAL_STATUSES = ["active", "superseded", "expired", "invalid"] as const;
export const ADMIN_IDENTITY_STATUSES = ["active", "disabled"] as const;
export const NOVEL_STATUSES = ["draft", "ready", "published", "unpublished", "takedown"] as const;
export const NOVEL_SOURCE_ITEM_STATUSES = ["pending", "linked", "ignored", "stale"] as const;
export const NOVEL_CHAPTER_STATUSES = ["preview", "locked", "stale", "withdrawn"] as const;
export const CHAPTER_SOURCE_ITEM_STATUSES = ["pending", "materialized", "failed"] as const;
export const LABEL_KINDS = ["series_type", "recommend", "language", "agency"] as const;
export const TASK_MODES = ["dry_run", "apply"] as const;
export const PROMO_LINK_STATUSES = ["pending", "fetched", "failed", "registered_disabled"] as const;
export const PROMO_LINK_ORIGINS = ["upstream_existing", "claimed"] as const;
export const TASK_STATUSES = ["pending", "processing", "completed", "completed_with_errors", "failed", "disabled"] as const;
// Phase C: CATALOG_ITEM_STATUSES (pending|processing|success|failed, no
// skipped) removed -- it described CatalogScanTaskItem's own lifecycle,
// which is dropped. GenericTaskItem (including taskType='catalog_scan' rows)
// uses TASK_ITEM_STATUSES below; the worker never emits 'skipped' for a
// catalog_scan item (see store.ts's guardedFinalize guard), but that is now
// a taskType-scoped runtime invariant, not a distinct physical status set.
export const TASK_ITEM_STATUSES = ["pending", "processing", "success", "skipped", "failed"] as const;
export const SIDE_EFFECT_INTENT_STATUSES = ["prepared", "confirmed", "failed", "claim_retry_blocked", "manual_review_required"] as const;
export const INDEXNOW_STATUSES = ["pending", "processing", "accepted", "retry_wait", "permanent_failed", "dead_letter", "cancelled"] as const;
/** `indexnow_outbox_attempt.outcome` (v0.2.0 foundation rename, ex `attempt_state`; values unchanged). HTTP result classification for one delivery attempt. */
export const INDEXNOW_ATTEMPT_OUTCOMES = ["started", "accepted", "retryable_failed", "permanent_failed"] as const;
/** `indexnow_outbox_attempt.attempt_state` (v0.2.0 foundation, new column reusing the name vacated by the rename above). CPS worker crash-recovery semantics — distinct question from `outcome`. */
export const INDEXNOW_ATTEMPT_RECOVERY_STATES = ["started", "completed", "unknown_outcome"] as const;
export const ARTICLE_TEMPLATE_STATUSES = ["draft", "active", "inactive"] as const;
export const ARTICLE_STATUSES = ["draft", "published", "unpublished", "takedown"] as const;
/**
 * `article.article_type` (C-24 article axes foundation). Deliberately the
 * same machine source as `ArticleTemplate.applicable_article_type`
 * (`src/lib/article-templates/applicable-article-type.ts`'s
 * `APPLICABLE_ARTICLE_TYPES`) with `any` removed -- `any` only means "this
 * template applies to every article type"; it is not a value an article
 * itself can hold. `tests/backend/database/c24-article-axes-static.test.ts`
 * asserts this set stays exactly `APPLICABLE_ARTICLE_TYPES` minus `any`.
 */
export const ARTICLE_TYPES = ["novel_article", "blog_article", "listicle", "guide"] as const;
/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * "类型属于博客系列" -- every `ArticleType` except `novel_article`. Derived
 * from `ARTICLE_TYPES` (filter, not a second hand-typed literal array) so a
 * future addition to that set is automatically included here without a
 * second edit -- same "avoid a drift-prone duplicate enumeration"
 * discipline `tests/backend/database/c24-article-axes-static.test.ts`
 * already applies to `APPLICABLE_ARTICLE_TYPES` vs `ARTICLE_TYPES` above.
 * Consumed by `src/server/publication/visibility.ts`'s
 * `PUBLIC_BLOG_ARTICLE_RECORD` (the blog-family public where-fragment) and
 * `src/lib/seo/sitemap.ts`'s blog sitemap family -- both need "is this
 * Article a blog/listicle/guide" as an index-friendly `{ in: [...] }`
 * clause rather than a `{ not: "novel_article" }` negation, matching
 * `article_type_locale_status_published_idx`'s (C-24) own intent ("供 ...
 * C-29 的博客列表走索引"). `listicle`/`guide` have no creation path yet
 * (C-26's own "不建任何入口、不建任何专属渲染" exception) so this set is
 * `["blog_article"]`-equivalent in practice today, but the derivation keeps
 * it correct if that ever changes.
 */
export const BLOG_FAMILY_ARTICLE_TYPES = ARTICLE_TYPES.filter(
  (type): type is Exclude<(typeof ARTICLE_TYPES)[number], "novel_article"> => type !== "novel_article",
);
/** `article.content_mode` (C-24 article axes foundation). CPS parity, copied verbatim. */
export const ARTICLE_CONTENT_MODES = ["manual", "template"] as const;
/** `article.seo_visibility` (C-24 article axes foundation). CPS parity, copied verbatim. */
export const ARTICLE_SEO_VISIBILITIES = ["public", "seo_only", "hidden"] as const;
/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1). CPS parity:
 * `ArticleDramaSwitchBatch.status` value set, copied verbatim (`ready` is
 * this repo's own naming — CPS's own physical default is likewise "the
 * batch has a plan but has not started executing").
 */
export const REBIND_BATCH_STATUSES = ["ready", "processing", "completed", "partial", "failed"] as const;
/** C-30A. CPS parity: `ArticleDramaSwitchBatchItem.status` value set, copied verbatim. */
export const REBIND_ITEM_STATUSES = ["pending", "processing", "applied", "skipped", "failed"] as const;
/**
 * C-30A. Nullable column — `NULL` means "no error recorded yet, or this
 * item's terminal state is not `failed`". CPS parity: collapses CPS's
 * `classifyDurableSwitchError` six-way classification into the same six
 * physical values.
 */
export const REBIND_ERROR_KINDS = ["drift", "not_found", "blocked", "ineligible", "fence_lost", "unknown"] as const;
export const SCHEDULE_RUN_STATUSES = ["due", "enqueued", "misfired", "skipped", "failed"] as const;
export const CRON_RUN_STATUSES = ["created", "task_created", "failed"] as const;
export const SCHEDULE_TRIGGER_KINDS = ["scheduled", "manual"] as const;
export const MISFIRE_POLICIES = ["bounded_catch_up", "skip", "mark_failed"] as const;
export const PREVIEW_MATERIALIZATION_POLICIES = ["upstream_returned_preview"] as const;
export const CAROUSEL_BATCH_STATUSES = ["pending", "processing", "completed", "failed"] as const;
/**
 * `home_carousel_serving.source` (and, as a subset, `home_carousel_auto_candidate.source`,
 * which never writes `"manual"`). Schema-contract-drift fix
 * (`20260912100000_carousel_serving_source_check_fix`): this used to be
 * `["manual", "automatic"]`, a two-bucket set nothing in this repo ever
 * wrote -- `src/server/home-carousel/service.ts`'s `computeHomeCarouselInTx`
 * has always written the finer-grained `"manual" | "new_novel" | "recency"`
 * (matching CPS `3a76877:src/lib/home-carousel-merge.ts:134,154`'s own
 * `manual`/`candidate.source` write into the CPS equivalent column, which has
 * no restricting CHECK at all), so every automatic compute's
 * `homeCarouselServing.createMany()` failed PostgreSQL's CHECK with 23514.
 * `tests/backend/database/carousel-serving-source-check-static.test.ts`
 * pins this constant, the migration's CHECK clause, and `service.ts`'s
 * written literals to the same three values so the two sides cannot drift
 * apart again. No `"revenue"` value (CPS has one) -- Novel V1 has no
 * revenue-scored candidate branch (`revenueEnabled` is hard-wired `false`).
 */
export const CAROUSEL_SOURCES = ["manual", "new_novel", "recency"] as const;
export const CANONICAL_TAG_STATUSES = ["active", "inactive"] as const;
export const NOVEL_TAG_MODES = ["automatic", "manual"] as const;
export const NOVEL_TAG_SOURCES = ["manual", "auto"] as const;
export const TAG_CLASSIFICATION_METHODS = ["deterministic_text", "offline_llm"] as const;

const REGISTRY_STATUS_SEMANTICS = {
  active: "Registered and available for normal use.",
  inactive: "Registered but administratively unavailable.",
  registered_disabled: "Registered without an enabled, evidenced execution contract.",
} as const;

const TASK_STATUS_SEMANTICS = {
  pending: "Durable task exists and has not started processing.",
  processing: "At least one worker-owned execution is in progress.",
  completed: "All required items reached successful terminal outcomes.",
  completed_with_errors: "Task reached terminal state with both accepted and failed or skipped outcomes.",
  failed: "Task reached a terminal failure and will not continue automatically under this run.",
  disabled: "Task is retained but execution is administratively prohibited.",
} as const;

const TASK_ITEM_STATUS_SEMANTICS = {
  pending: "Item is claimable only by the pending-claim query.",
  processing: "Item has a current execution_token, lease_epoch, owner, and lease expiry.",
  success: "The fenced execution committed its protected result.",
  skipped: "Item intentionally produced no business write and is terminal.",
  failed: "The fenced execution recorded a terminal failure for this item.",
} as const;

/** Per-table status terminology; dictionary generation must preserve these meanings verbatim or semantically. */
export const DATABASE_STATUS_SEMANTICS = {
  channel: REGISTRY_STATUS_SEMANTICS,
  source_app: REGISTRY_STATUS_SEMANTICS,
  channel_app: REGISTRY_STATUS_SEMANTICS,
  channel_capability: {
    enabled: "Capability has sufficient evidence and its enablement gate is open.",
    registered_disabled: "Capability is known but cannot execute; unproven external interfaces stay here.",
    registered_partial: "Only the explicitly evidenced subset is registered; missing operations remain disabled.",
  },
  channel_account: {
    active: "Account may be selected by explicitly account-scoped operations.",
    disabled: "Account remains auditable but cannot be selected for new work.",
  },
  channel_account_credential: {
    active: "Credential is the account/type active version and owns the fingerprint latch.",
    superseded: "Credential was replaced by a newer version and cannot be used for new work.",
    expired: "Credential passed its expiry boundary and must not be used.",
    invalid: "Credential validation failed and it must not be used unless replaced or revalidated.",
  },
  novel: {
    draft: "Canonical record is incomplete and public routes return 404.",
    ready: "Canonical record passed internal readiness but is not public; public routes return 404.",
    published: "Novel is publicly renderable subject to its Article and preview authorization.",
    unpublished: "Novel is intentionally offline with a stable noindex removal page; retained content is not publicly rendered.",
    takedown: "Rights or safety removal; public routes return HTTP 410 Gone and protected chapter content follows the deletion workflow.",
  },
  novel_source_item: {
    pending: "Source row is mirrored but not linked to a canonical Novel.",
    linked: "Source row is linked to exactly one source-language Novel.",
    ignored: "Source row is intentionally excluded without deleting the upstream mirror.",
    stale: "Source row disappeared from a trustworthy catalog response and is excluded from ordinary selection until seen again.",
  },
  novel_chapter: {
    preview: "Chapter is materialized, publicly displayable when authorized, and eligible for indexing.",
    locked: "Paid chapter is not materialized or publicly rendered in V1.",
    stale: "Chapter was absent from a successful, structurally complete, non-empty response; display and sitemap stop immediately while body is retained, and a later trustworthy reappearance automatically restores preview.",
    withdrawn: "Operator or rights withdrawal; route returns 404 and this is the only chapter state whose workflow deletes NovelChapterContent.",
  },
  novel_chapter_source_item: {
    pending: "Upstream chapter identity is mirrored but no canonical preview materialization is confirmed.",
    materialized: "Upstream chapter is linked to a canonical chapter whose body materialization completed.",
    failed: "The current materialization attempt failed without inventing canonical content.",
  },
  promo_link: {
    pending: "Asset identity exists but verified link material is not yet available.",
    fetched: "Verified upstream asset was read and the permanent public redirect code may resolve through it.",
    failed: "Asset retrieval or validation failed; public resolution must not guess a fallback.",
    registered_disabled: "Asset capability is registered but the external interface is unproven or disabled.",
  },
  // Phase C: catalog_scan_task(_item) dropped -- CatalogScan is now
  // GenericTask(taskType='catalog_scan'), covered by generic_task/
  // generic_task_item below.
  channel_sync_task: TASK_STATUS_SEMANTICS,
  channel_sync_task_item: TASK_ITEM_STATUS_SEMANTICS,
  generic_task: TASK_STATUS_SEMANTICS,
  generic_task_item: TASK_ITEM_STATUS_SEMANTICS,
  side_effect_intent: {
    prepared: "Permanent intent committed independently before the external call.",
    confirmed: "External effect outcome is reliably confirmed.",
    failed: "External call is confirmed failed and policy determines any later retry.",
    claim_retry_blocked: "Outcome is ambiguous; automatic retry is forbidden to avoid duplicate effects.",
    manual_review_required: "Human adjudication is required before any further effect attempt.",
  },
  indexnow_outbox: {
    pending: "URL revision is durable and awaiting first claim.",
    processing: "A worker currently owns the delivery attempt.",
    accepted: "IndexNow accepted this URL revision; terminal success.",
    retry_wait: "Retryable failure is waiting until next_attempt_at.",
    permanent_failed: "Provider response is non-retryable; terminal failure.",
    dead_letter: "Retry budget was exhausted and operator inspection is required.",
    cancelled: "Delivery was deliberately cancelled because the revision is no longer actionable.",
  },
  /**
   * indexnow_outbox_attempt has no plain `status` column; these two enum
   * columns fill that role and answer two different questions per row
   * (docs/governance/database-governance.md §4 cross-references both by
   * name — keep them in sync).
   */
  indexnow_outbox_attempt: {
    outcome: {
      started: "Attempt was created and its HTTP request has not yet been classified.",
      accepted: "IndexNow accepted this attempt (HTTP 200/202).",
      retryable_failed: "Attempt failed with a retryable HTTP status (429/5xx) or network error.",
      permanent_failed: "Attempt failed with a non-retryable HTTP status (400/403/422).",
    },
    attemptState: {
      started: "Request was sent but the worker has not yet recorded a response for this attempt.",
      completed: "Worker recorded a response and applied its terminal classification to `outcome`.",
      unknown_outcome: "Worker process ended after the request was sent but before a response was recorded; retried safely since IndexNow submission is idempotent.",
    },
  },
  schedule_run: {
    due: "A deterministic scheduled instant or manual trigger awaits atomic enqueue.",
    enqueued: "The corresponding CronRun and GenericTask were durably created.",
    misfired: "The scheduled instant was missed and awaits its declared misfire policy.",
    skipped: "Misfire policy intentionally skipped this run.",
    failed: "Scheduler failed to create the durable task for this run.",
  },
  cron_run: {
    created: "Cron marker exists and is awaiting atomic task association.",
    task_created: "Exactly one GenericTask was linked in the enqueue transaction.",
    failed: "Atomic enqueue failed and no successful task association may be inferred.",
  },
  article_template: {
    draft: "Template version is editable and cannot be selected for publishing.",
    active: "Template version is approved for article rendering.",
    inactive: "Template version remains auditable but cannot be selected for new renders.",
  },
  article: {
    draft: "Rendered article is not public and public routes return 404.",
    published: "Article is publicly renderable and indexable only when all published row CHECKs pass.",
    unpublished: "Article keeps its stable URL as a noindex removal page; HTTP behavior differs from takedown and content remains retained.",
    takedown: "Article is removed for rights or safety reasons; its public route returns HTTP 410 Gone and is removed from index feeds.",
  },
  /**
   * `article.article_type` (C-24 article axes foundation). Kept as its own
   * top-level entry rather than nested under `article` above so that key
   * keeps its existing flat status-value shape; none of these three column
   * names collides with an existing table name. As of C-24 this column has
   * no reader anywhere in the codebase (schema-only, zero behavior change);
   * these are the intended business meanings C-25/C-26/C-27 wire up.
   */
  article_type: {
    novel_article: "Article renders one Novel's SEO landing page; requires a Novel and, once published, a same-Novel PromoLink (enforced by the composite FK and the published-row CHECKs).",
    blog_article: "Article is a standalone editorial page with no Novel binding (novel_id is null once C-27 relaxes that column).",
    listicle: "Legacy CPS type carried for enum parity only; no dedicated public route or admin entry point in this repo.",
    guide: "Legacy CPS type carried for enum parity only; no dedicated public route or admin entry point in this repo.",
  },
  /** `article.content_mode` (C-24 article axes foundation). See note on `article_type` above about why this is a top-level entry. */
  content_mode: {
    manual: "Body was last written by an operator through the manual-edit path and template re-generation must not silently overwrite it.",
    template: "Body was last written by the template engine (creation or re-generation) and re-generation may overwrite it freely.",
  },
  /** `article.seo_visibility` (C-24 article axes foundation). See note on `article_type` above about why this is a top-level entry. */
  seo_visibility: {
    public: "Article is indexable and appears in every site list (home, browse, category) it would otherwise qualify for.",
    seo_only: "Article is indexable (index,follow) and stays in sitemap/IndexNow, but is excluded from every on-site list.",
    hidden: "Article is unreachable on the public site (404), excluded from sitemap, and excluded from IndexNow.",
  },
  home_carousel_auto_batch: {
    pending: "Batch is durable and waiting for candidate computation.",
    processing: "Candidate computation is in progress.",
    completed: "Candidate ranking completed and may feed the current serving snapshot.",
    failed: "Candidate computation terminated without replacing the current serving snapshot.",
  },
  canonical_tag: {
    active: "The global CanonicalTag may be returned by effective Tag resolution.",
    inactive: "The identity remains auditable but is excluded from mapped, auto, and manual effective results.",
  },
  novel_tag_state: {
    automatic: "Effective Tags are the union of exact read-derived mapped Tags and the current qualified auto snapshot.",
    manual: "The complete manual snapshot owns the effective result, including an explicit empty snapshot.",
  },
  /** `article_novel_rebind_batch.status` (C-30A). See `article_type` above for why this is a top-level entry rather than nested under `article`. */
  article_novel_rebind_batch: {
    ready: "Batch was durably created from an owned, unexpired preview and has not started executing.",
    processing: "An execution holds the batch's current, unexpired lease and is working through its items.",
    completed: "Every item reached a successful terminal outcome (applied); no skipped or failed items.",
    partial: "Batch reached a terminal state with a mix of applied and skipped/failed items.",
    failed: "Every item ended skipped or failed; zero items applied.",
  },
  /** `article_novel_rebind_batch_item.status` (C-30A). */
  article_novel_rebind_batch_item: {
    pending: "Item is claimable only by the batch's own execution loop (not the generic task claim query).",
    processing: "Item holds a current `processing_token` and is inside the single-article rebind service's own transaction.",
    applied: "The two-field (novel_id, promo_link_id) atomic swap committed and its OperationAudit row was written.",
    skipped: "Item was judged non-executable at batch-creation time (e.g. the article was already locked by another batch) and never entered execution.",
    failed: "Execution attempted the swap and it did not commit; see the item's own `error_kind`/`error_message`.",
  },
  /** `article_novel_rebind_batch_item.error_kind` (C-30A, nullable — see the constant's own doc comment in `src/domain/database-statuses.ts`). */
  article_novel_rebind_batch_item_error_kind: {
    drift: "The article's current (novel_id, promo_link_id) no longer matched the item's `old_novel_id`/`old_promo_link_id` snapshot at execution time (optimistic-concurrency CAS miss).",
    not_found: "The article or its target Novel could not be loaded at execution time (soft-deleted or removed after the preview was generated).",
    blocked: "A hard guard (see `src/server/article-rebind/guards.ts`) rejected the swap at execution time, re-evaluated fresh rather than trusted from the preview.",
    ineligible: "The item was not in the `executable` preview category and the batch-apply submission guard should have excluded it; recorded defensively if it is ever reached anyway.",
    fence_lost: "The batch or item execution fence (lease/processing_token) was lost mid-attempt — a concurrent execution or a lease expiry raced this one.",
    unknown: "An unclassified failure occurred; see `error_message` for detail.",
  },
} as const;

export type ValueOf<T extends readonly string[]> = T[number];
export type ChannelStatus = ValueOf<typeof CHANNEL_STATUSES>;
export type ChannelAccountStatus = ValueOf<typeof CHANNEL_ACCOUNT_STATUSES>;
export type CapabilityStatus = ValueOf<typeof CAPABILITY_STATUSES>;
export type CredentialStatus = ValueOf<typeof CREDENTIAL_STATUSES>;
export type AdminIdentityStatus = ValueOf<typeof ADMIN_IDENTITY_STATUSES>;
export type NovelStatus = ValueOf<typeof NOVEL_STATUSES>;
export type NovelSourceItemStatus = ValueOf<typeof NOVEL_SOURCE_ITEM_STATUSES>;
export type NovelChapterStatus = ValueOf<typeof NOVEL_CHAPTER_STATUSES>;
export type ChapterSourceItemStatus = ValueOf<typeof CHAPTER_SOURCE_ITEM_STATUSES>;
export type LabelKind = ValueOf<typeof LABEL_KINDS>;
export type PromoLinkStatus = ValueOf<typeof PROMO_LINK_STATUSES>;
export type TaskStatus = ValueOf<typeof TASK_STATUSES>;
export type TaskItemStatus = ValueOf<typeof TASK_ITEM_STATUSES>;
export type SideEffectIntentStatus = ValueOf<typeof SIDE_EFFECT_INTENT_STATUSES>;
export type IndexNowStatus = ValueOf<typeof INDEXNOW_STATUSES>;
export type IndexNowAttemptOutcome = ValueOf<typeof INDEXNOW_ATTEMPT_OUTCOMES>;
export type IndexNowAttemptRecoveryState = ValueOf<typeof INDEXNOW_ATTEMPT_RECOVERY_STATES>;
export type ArticleStatus = ValueOf<typeof ARTICLE_STATUSES>;
export type ArticleType = ValueOf<typeof ARTICLE_TYPES>;
export type ArticleContentMode = ValueOf<typeof ARTICLE_CONTENT_MODES>;
export type ArticleSeoVisibility = ValueOf<typeof ARTICLE_SEO_VISIBILITIES>;
export type RebindBatchStatus = ValueOf<typeof REBIND_BATCH_STATUSES>;
export type RebindItemStatus = ValueOf<typeof REBIND_ITEM_STATUSES>;
export type RebindErrorKind = ValueOf<typeof REBIND_ERROR_KINDS>;
export type CanonicalTagStatus = ValueOf<typeof CANONICAL_TAG_STATUSES>;
export type NovelTagMode = ValueOf<typeof NOVEL_TAG_MODES>;
export type NovelTagSource = ValueOf<typeof NOVEL_TAG_SOURCES>;
export type TagClassificationMethod = ValueOf<typeof TAG_CLASSIFICATION_METHODS>;
