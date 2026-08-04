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
export const CATALOG_ITEM_STATUSES = ["pending", "processing", "success", "failed"] as const;
export const TASK_ITEM_STATUSES = ["pending", "processing", "success", "skipped", "failed"] as const;
export const SIDE_EFFECT_INTENT_STATUSES = ["prepared", "confirmed", "failed", "claim_retry_blocked", "manual_review_required"] as const;
export const INDEXNOW_STATUSES = ["pending", "processing", "accepted", "retry_wait", "permanent_failed", "dead_letter", "cancelled"] as const;
export const INDEXNOW_ATTEMPT_STATES = ["started", "accepted", "retryable_failed", "permanent_failed"] as const;
export const ARTICLE_TEMPLATE_STATUSES = ["draft", "active", "retired"] as const;
export const ARTICLE_STATUSES = ["draft", "published", "unpublished", "takedown"] as const;
export const SCHEDULE_RUN_STATUSES = ["due", "enqueued", "misfired", "skipped", "failed"] as const;
export const CRON_RUN_STATUSES = ["created", "task_created", "failed"] as const;
export const SCHEDULE_TRIGGER_KINDS = ["scheduled", "manual"] as const;
export const MISFIRE_POLICIES = ["bounded_catch_up", "skip", "mark_failed"] as const;
export const PREVIEW_MATERIALIZATION_POLICIES = ["upstream_returned_preview"] as const;
export const CAROUSEL_BATCH_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export const CAROUSEL_SOURCES = ["manual", "automatic"] as const;

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
  catalog_scan_task: TASK_STATUS_SEMANTICS,
  catalog_scan_task_item: {
    pending: TASK_ITEM_STATUS_SEMANTICS.pending,
    processing: TASK_ITEM_STATUS_SEMANTICS.processing,
    success: TASK_ITEM_STATUS_SEMANTICS.success,
    failed: TASK_ITEM_STATUS_SEMANTICS.failed,
  },
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
    retired: "Template version remains auditable but cannot be selected for new renders.",
  },
  article: {
    draft: "Rendered article is not public and public routes return 404.",
    published: "Article is publicly renderable and indexable only when all published row CHECKs pass.",
    unpublished: "Article keeps its stable URL as a noindex removal page; HTTP behavior differs from takedown and content remains retained.",
    takedown: "Article is removed for rights or safety reasons; its public route returns HTTP 410 Gone and is removed from index feeds.",
  },
  home_carousel_auto_batch: {
    pending: "Batch is durable and waiting for candidate computation.",
    processing: "Candidate computation is in progress.",
    completed: "Candidate ranking completed and may feed the current serving snapshot.",
    failed: "Candidate computation terminated without replacing the current serving snapshot.",
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
export type ArticleStatus = ValueOf<typeof ARTICLE_STATUSES>;
