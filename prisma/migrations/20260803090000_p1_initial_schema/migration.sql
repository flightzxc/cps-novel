-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "channel" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_app" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_app" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "source_app_id" UUID NOT NULL,
    "external_app_id" VARCHAR(128) NOT NULL,
    "project_type" SMALLINT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_capability" (
    "id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "capability_key" VARCHAR(96) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'registered_disabled',
    "side_effecting" BOOLEAN NOT NULL DEFAULT false,
    "evidence_level" VARCHAR(48) NOT NULL,
    "reason_code" VARCHAR(96),
    "enabled_gate" VARCHAR(160),
    "qps_limit" DECIMAL(8,3),
    "timeout_ms" INTEGER,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_account" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "business_id" VARCHAR(96) NOT NULL,
    "account_name" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "last_validated_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_account_credential" (
    "id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "credential_type" VARCHAR(64) NOT NULL DEFAULT 'bearer_jwt',
    "encrypted_secret" BYTEA NOT NULL,
    "key_version" SMALLINT NOT NULL,
    "secret_fingerprint" VARCHAR(96) NOT NULL,
    "fingerprint_prefix" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "last_validated_at" TIMESTAMPTZ(6),
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_account_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_credential_active_fingerprint" (
    "id" UUID NOT NULL,
    "fingerprint" VARCHAR(96) NOT NULL,
    "credential_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "credential_type" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_credential_active_fingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_change_log" (
    "id" BIGSERIAL NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "credential_id" UUID,
    "actor_type" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(128),
    "action" VARCHAR(64) NOT NULL,
    "old_fingerprint" VARCHAR(96),
    "new_fingerprint" VARCHAR(96),
    "reason" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel" (
    "id" UUID NOT NULL,
    "business_id" VARCHAR(96) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT NOT NULL,
    "cover_url" TEXT,
    "locale" VARCHAR(16) NOT NULL,
    "slug" VARCHAR(240) NOT NULL,
    "author" VARCHAR(300),
    "completion_status" VARCHAR(64),
    "country" VARCHAR(96),
    "region" VARCHAR(96),
    "total_chapter_count" INTEGER NOT NULL DEFAULT 0,
    "paid_from_chapter" INTEGER,
    "split_ratio" DECIMAL(9,4),
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_source_item" (
    "id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "novel_id" UUID,
    "external_book_id" VARCHAR(160) NOT NULL,
    "source_language_code" VARCHAR(64) NOT NULL,
    "source_language_name" VARCHAR(160),
    "source_locale" VARCHAR(16),
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT NOT NULL,
    "cover_url" TEXT,
    "total_chapter_count" INTEGER NOT NULL DEFAULT 0,
    "paid_from_chapter" INTEGER,
    "split_ratio" DECIMAL(9,4),
    "tto_split_ratio" DECIMAL(9,4),
    "external_agency_id" VARCHAR(128),
    "source_created_at_raw" TEXT,
    "source_created_at" TIMESTAMPTZ(6),
    "source_updated_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "raw_payload" JSONB NOT NULL,
    "raw_payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_source_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapter" (
    "id" UUID NOT NULL,
    "novel_id" UUID NOT NULL,
    "canonical_chapter_number" INTEGER NOT NULL,
    "title" VARCHAR(500),
    "status" VARCHAR(32) NOT NULL DEFAULT 'preview',
    "source_updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_chapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapter_source_item" (
    "id" UUID NOT NULL,
    "novel_source_item_id" UUID NOT NULL,
    "novel_chapter_id" UUID,
    "external_chapter_id" VARCHAR(160) NOT NULL,
    "source_chapter_number" INTEGER,
    "chapter_name" VARCHAR(500),
    "chapter_show_name" VARCHAR(500),
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "last_seen_at" TIMESTAMPTZ(6),
    "source_updated_at" TIMESTAMPTZ(6),
    "raw_payload" JSONB NOT NULL,
    "raw_payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_chapter_source_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_chapter_content" (
    "id" UUID NOT NULL,
    "novel_chapter_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "materialized_at" TIMESTAMPTZ(6) NOT NULL,
    "source_fetch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_chapter_content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_preview_policy" (
    "id" UUID NOT NULL,
    "novel_id" UUID NOT NULL,
    "materialization_policy" VARCHAR(64) NOT NULL DEFAULT 'upstream_returned_preview',
    "materialized_chapter_count" INTEGER NOT NULL DEFAULT 0,
    "display_authorized" BOOLEAN NOT NULL DEFAULT true,
    "index_authorized" BOOLEAN NOT NULL DEFAULT true,
    "cache_authorized" BOOLEAN NOT NULL DEFAULT true,
    "max_materialized_chapters" INTEGER NOT NULL,
    "last_refreshed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "novel_preview_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_label" (
    "id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "label_kind" VARCHAR(32) NOT NULL,
    "external_label_value" VARCHAR(300) NOT NULL,
    "display_value" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_source_item_label" (
    "id" UUID NOT NULL,
    "novel_source_item_id" UUID NOT NULL,
    "source_label_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "novel_source_item_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_link" (
    "id" UUID NOT NULL,
    "novel_id" UUID NOT NULL,
    "novel_source_item_id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "offer_type" VARCHAR(64) NOT NULL,
    "origin" VARCHAR(32) NOT NULL DEFAULT 'upstream_existing',
    "upstream_code" TEXT,
    "public_redirect_code" VARCHAR(32) NOT NULL,
    "web_url" TEXT,
    "app_url" TEXT,
    "idempotency_key" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "error_kind" VARCHAR(96),
    "error_message" TEXT,
    "fetched_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "last_attempted_at" TIMESTAMPTZ(6),
    "raw_links" JSONB NOT NULL DEFAULT '{}',
    "raw_links_schema_version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promo_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_event" (
    "id" BIGSERIAL NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "article_id" UUID,
    "novel_id" UUID,
    "promo_link_id" UUID,
    "public_redirect_code" VARCHAR(32),
    "session_hash" CHAR(64),
    "request_hash" CHAR(64),
    "ip_hash" CHAR(64),
    "user_agent_hash" CHAR(64),
    "salt_version" SMALLINT NOT NULL DEFAULT 1,
    "context" JSONB NOT NULL DEFAULT '{}',
    "context_schema_version" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_scan_task" (
    "id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "project_type" SMALLINT NOT NULL,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'apply',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "request_token" VARCHAR(160) NOT NULL,
    "page_start" INTEGER NOT NULL,
    "page_end" INTEGER NOT NULL,
    "page_size" INTEGER NOT NULL,
    "catalog_observed_total" INTEGER,
    "batch_expected_count" INTEGER,
    "batch_actual_count" INTEGER,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_scan_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_scan_task_item" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "page_index" INTEGER NOT NULL,
    "page_range_end" INTEGER,
    "request_fingerprint" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "execution_token" UUID,
    "lease_epoch" BIGINT NOT NULL DEFAULT 0,
    "locked_by" VARCHAR(160),
    "locked_until" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "returned_count" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_scan_task_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_task" (
    "id" UUID NOT NULL,
    "task_type" VARCHAR(96) NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "channel_app_id" UUID NOT NULL,
    "operation_scope_hash" CHAR(64) NOT NULL,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'apply',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "request_token" VARCHAR(160) NOT NULL,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_sync_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_task_item" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "novel_source_item_id" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "execution_token" UUID,
    "lease_epoch" BIGINT NOT NULL DEFAULT 0,
    "locked_by" VARCHAR(160),
    "locked_until" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_sync_task_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generic_task" (
    "id" UUID NOT NULL,
    "task_type" VARCHAR(96) NOT NULL,
    "channel_account_id" UUID,
    "channel_app_id" UUID,
    "operation_scope_hash" CHAR(64) NOT NULL,
    "origin_task_id" UUID,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'apply',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "request_token" VARCHAR(160) NOT NULL,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "generic_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generic_task_item" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "execution_token" UUID,
    "lease_epoch" BIGINT NOT NULL DEFAULT 0,
    "locked_by" VARCHAR(160),
    "locked_until" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "generic_task_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "side_effect_intent" (
    "id" UUID NOT NULL,
    "effect_key" CHAR(64) NOT NULL,
    "operation_type" VARCHAR(96) NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(160) NOT NULL,
    "task_item_type" VARCHAR(64),
    "task_item_id" UUID,
    "channel_account_id" UUID,
    "channel_app_id" UUID,
    "promo_link_id" UUID,
    "status" VARCHAR(32) NOT NULL DEFAULT 'prepared',
    "attempt_fingerprint" CHAR(64),
    "request_summary" JSONB NOT NULL DEFAULT '{}',
    "response_shape" JSONB,
    "committed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "side_effect_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_audit" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(128),
    "action" VARCHAR(96) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(160) NOT NULL,
    "request_id" VARCHAR(160),
    "task_type" VARCHAR(64),
    "task_id" UUID,
    "reason" TEXT,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexnow_outbox" (
    "id" UUID NOT NULL,
    "article_id" UUID,
    "url" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "event_type" VARCHAR(48) NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6),
    "available_at" TIMESTAMPTZ(6),
    "last_http_status" INTEGER,
    "last_error_kind" VARCHAR(96),
    "last_error_summary" TEXT,
    "source" VARCHAR(64) NOT NULL,
    "source_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "indexnow_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexnow_outbox_attempt" (
    "id" BIGSERIAL NOT NULL,
    "outbox_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "attempt_state" VARCHAR(32) NOT NULL DEFAULT 'started',
    "request_batch_id" VARCHAR(160) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_at" TIMESTAMPTZ(6) NOT NULL,
    "response_at" TIMESTAMPTZ(6),
    "http_status" INTEGER,
    "error_kind" VARCHAR(96),
    "response_summary" TEXT,
    "batch_size" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "indexnow_outbox_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_run" (
    "id" UUID NOT NULL,
    "schedule_key" VARCHAR(128) NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "trigger_kind" VARCHAR(32) NOT NULL DEFAULT 'scheduled',
    "scheduled_for" TIMESTAMPTZ(6),
    "manual_trigger_id" VARCHAR(160),
    "timezone" VARCHAR(64) NOT NULL,
    "misfire_policy" VARCHAR(32) NOT NULL DEFAULT 'bounded_catch_up',
    "max_catch_up_runs" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL DEFAULT 'due',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_run" (
    "id" UUID NOT NULL,
    "schedule_run_id" UUID NOT NULL,
    "generic_task_id" UUID,
    "status" VARCHAR(32) NOT NULL DEFAULT 'created',
    "claimed_by" VARCHAR(160),
    "claimed_at" TIMESTAMPTZ(6),
    "enqueued_at" TIMESTAMPTZ(6),
    "error" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_template" (
    "id" UUID NOT NULL,
    "template_key" VARCHAR(96) NOT NULL,
    "locale" VARCHAR(16),
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "body_template" TEXT NOT NULL,
    "seo_template" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "article_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article" (
    "id" UUID NOT NULL,
    "novel_id" UUID NOT NULL,
    "template_id" UUID,
    "promo_link_id" UUID,
    "locale" VARCHAR(16) NOT NULL,
    "slug" VARCHAR(240) NOT NULL,
    "public_page_short_id" VARCHAR(32) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "seo_metadata" JSONB NOT NULL DEFAULT '{}',
    "seo_schema_version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "publish_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_carousel_manual_slot" (
    "id" UUID NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "position" INTEGER NOT NULL,
    "novel_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "created_by" VARCHAR(128) NOT NULL,
    "updated_by" VARCHAR(128) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "home_carousel_manual_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_carousel_auto_batch" (
    "id" UUID NOT NULL,
    "unique_key" VARCHAR(160) NOT NULL,
    "run_date" DATE NOT NULL,
    "trigger_source" VARCHAR(64) NOT NULL,
    "locale_scope" VARCHAR(16),
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "algorithm_version" VARCHAR(64) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_by" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_carousel_auto_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_carousel_auto_candidate" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "novel_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "score" DECIMAL(12,6),
    "rank" INTEGER NOT NULL,
    "reason" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_carousel_auto_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_carousel_serving" (
    "id" UUID NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "position" INTEGER NOT NULL,
    "novel_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "manual_slot_id" UUID,
    "batch_id" UUID,
    "merged_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_carousel_serving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_carousel_change_log" (
    "id" BIGSERIAL NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "manual_slot_id" UUID,
    "actor_type" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(128),
    "before_state" JSONB,
    "after_state" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "home_carousel_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_code_key" ON "channel"("code");

-- CreateIndex
CREATE INDEX "channel_status_idx" ON "channel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "source_app_code_key" ON "source_app"("code");

-- CreateIndex
CREATE INDEX "source_app_status_idx" ON "source_app"("status");

-- CreateIndex
CREATE INDEX "channel_app_status_idx" ON "channel_app"("status");

-- CreateIndex
CREATE INDEX "channel_app_project_status_idx" ON "channel_app"("project_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_app_binding_key" ON "channel_app"("channel_id", "source_app_id", "external_app_id");

-- CreateIndex
CREATE INDEX "channel_capability_status_effect_idx" ON "channel_capability"("status", "side_effecting");

-- CreateIndex
CREATE UNIQUE INDEX "channel_capability_app_key" ON "channel_capability"("channel_app_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "channel_account_business_id_key" ON "channel_account"("business_id");

-- CreateIndex
CREATE INDEX "channel_account_channel_status_idx" ON "channel_account"("channel_id", "status");

-- CreateIndex
CREATE INDEX "channel_account_status_deleted_idx" ON "channel_account"("status", "deleted_at");

-- CreateIndex
CREATE INDEX "credential_account_status_idx" ON "channel_account_credential"("channel_account_id", "status");

-- CreateIndex
CREATE INDEX "credential_type_status_idx" ON "channel_account_credential"("credential_type", "status");

-- CreateIndex
CREATE INDEX "credential_expires_at_idx" ON "channel_account_credential"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_credential_active_fingerprint_fingerprint_key" ON "channel_credential_active_fingerprint"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "channel_credential_active_fingerprint_credential_id_key" ON "channel_credential_active_fingerprint"("credential_id");

-- CreateIndex
CREATE INDEX "active_fingerprint_account_type_idx" ON "channel_credential_active_fingerprint"("channel_account_id", "credential_type");

-- CreateIndex
CREATE INDEX "credential_log_account_created_idx" ON "credential_change_log"("channel_account_id", "created_at");

-- CreateIndex
CREATE INDEX "credential_log_actor_created_idx" ON "credential_change_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "credential_log_action_created_idx" ON "credential_change_log"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "novel_business_id_key" ON "novel"("business_id");

-- CreateIndex
CREATE INDEX "novel_status_updated_idx" ON "novel"("status", "updated_at");

-- CreateIndex
CREATE INDEX "novel_locale_status_idx" ON "novel"("locale", "status");

-- CreateIndex
CREATE INDEX "novel_source_novel_idx" ON "novel_source_item"("novel_id");

-- CreateIndex
CREATE INDEX "novel_source_app_locale_idx" ON "novel_source_item"("channel_app_id", "source_locale");

-- CreateIndex
CREATE INDEX "novel_source_app_split_ratio_idx" ON "novel_source_item"("channel_app_id", "split_ratio");

-- CreateIndex
CREATE INDEX "novel_source_updated_idx" ON "novel_source_item"("source_updated_at");

-- CreateIndex
CREATE INDEX "novel_source_status_seen_idx" ON "novel_source_item"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "novel_source_identity_key" ON "novel_source_item"("channel_app_id", "external_book_id", "source_language_code");

-- CreateIndex
CREATE INDEX "novel_chapter_listing_idx" ON "novel_chapter"("novel_id", "status", "canonical_chapter_number");

-- CreateIndex
CREATE INDEX "chapter_source_chapter_idx" ON "novel_chapter_source_item"("novel_chapter_id");

-- CreateIndex
CREATE INDEX "chapter_source_updated_idx" ON "novel_chapter_source_item"("source_updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_source_identity_key" ON "novel_chapter_source_item"("novel_source_item_id", "external_chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "novel_chapter_content_novel_chapter_id_key" ON "novel_chapter_content"("novel_chapter_id");

-- CreateIndex
CREATE INDEX "chapter_content_hash_idx" ON "novel_chapter_content"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "novel_preview_policy_novel_id_key" ON "novel_preview_policy"("novel_id");

-- CreateIndex
CREATE INDEX "source_label_kind_idx" ON "source_label"("label_kind");

-- CreateIndex
CREATE UNIQUE INDEX "source_label_identity_key" ON "source_label"("channel_app_id", "label_kind", "external_label_value");

-- CreateIndex
CREATE INDEX "novel_source_label_active_idx" ON "novel_source_item_label"("source_label_id", "active");

-- CreateIndex
CREATE INDEX "novel_source_item_label_active_idx" ON "novel_source_item_label"("novel_source_item_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "novel_source_label_key" ON "novel_source_item_label"("novel_source_item_id", "source_label_id");

-- CreateIndex
CREATE UNIQUE INDEX "promo_link_public_redirect_code_key" ON "promo_link"("public_redirect_code");

-- CreateIndex
CREATE UNIQUE INDEX "promo_link_idempotency_key_key" ON "promo_link"("idempotency_key");

-- CreateIndex
CREATE INDEX "promo_link_source_idx" ON "promo_link"("novel_source_item_id");

-- CreateIndex
CREATE INDEX "promo_link_novel_status_idx" ON "promo_link"("novel_id", "status");

-- CreateIndex
CREATE INDEX "promo_link_account_status_idx" ON "promo_link"("channel_account_id", "status");

-- CreateIndex
CREATE INDEX "promo_link_status_fetched_idx" ON "promo_link"("status", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "promo_link_id_novel_key" ON "promo_link"("id", "novel_id");

-- CreateIndex
CREATE INDEX "tracking_event_type_time_idx" ON "tracking_event"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "tracking_public_code_time_idx" ON "tracking_event"("public_redirect_code", "occurred_at");

-- CreateIndex
CREATE INDEX "tracking_promo_time_idx" ON "tracking_event"("promo_link_id", "occurred_at");

-- CreateIndex
CREATE INDEX "tracking_novel_time_idx" ON "tracking_event"("novel_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_scan_task_request_token_key" ON "catalog_scan_task"("request_token");

-- CreateIndex
CREATE INDEX "catalog_scan_status_created_idx" ON "catalog_scan_task"("status", "created_at");

-- CreateIndex
CREATE INDEX "catalog_scan_scope_idx" ON "catalog_scan_task"("channel_account_id", "channel_app_id", "project_type");

-- CreateIndex
CREATE INDEX "catalog_scan_item_task_status_idx" ON "catalog_scan_task_item"("task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_scan_item_page_key" ON "catalog_scan_task_item"("task_id", "page_index");

-- CreateIndex
CREATE UNIQUE INDEX "channel_sync_task_request_token_key" ON "channel_sync_task"("request_token");

-- CreateIndex
CREATE INDEX "channel_sync_type_status_created_idx" ON "channel_sync_task"("task_type", "status", "created_at");

-- CreateIndex
CREATE INDEX "channel_sync_account_app_idx" ON "channel_sync_task"("channel_account_id", "channel_app_id");

-- CreateIndex
CREATE INDEX "channel_sync_item_task_status_idx" ON "channel_sync_task_item"("task_id", "status");

-- CreateIndex
CREATE INDEX "channel_sync_item_source_idx" ON "channel_sync_task_item"("novel_source_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_sync_item_source_key" ON "channel_sync_task_item"("task_id", "novel_source_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "generic_task_request_token_key" ON "generic_task"("request_token");

-- CreateIndex
CREATE INDEX "generic_task_claim_idx" ON "generic_task"("status", "task_type", "created_at");

-- CreateIndex
CREATE INDEX "generic_task_account_app_idx" ON "generic_task"("channel_account_id", "channel_app_id");

-- CreateIndex
CREATE UNIQUE INDEX "generic_task_origin_key" ON "generic_task"("task_type", "origin_task_id");

-- CreateIndex
CREATE INDEX "generic_task_item_task_status_idx" ON "generic_task_item"("task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generic_task_item_target_key" ON "generic_task_item"("task_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "side_effect_intent_effect_key_key" ON "side_effect_intent"("effect_key");

-- CreateIndex
CREATE INDEX "side_effect_target_created_idx" ON "side_effect_intent"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "side_effect_status_created_idx" ON "side_effect_intent"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "side_effect_operation_idempotency_key" ON "side_effect_intent"("operation_type", "idempotency_key");

-- CreateIndex
CREATE INDEX "operation_audit_entity_created_idx" ON "operation_audit"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "operation_audit_request_idx" ON "operation_audit"("request_id");

-- CreateIndex
CREATE INDEX "operation_audit_task_idx" ON "operation_audit"("task_type", "task_id");

-- CreateIndex
CREATE INDEX "indexnow_outbox_status_retry_idx" ON "indexnow_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "indexnow_outbox_status_available_idx" ON "indexnow_outbox"("status", "available_at");

-- CreateIndex
CREATE INDEX "indexnow_outbox_article_idx" ON "indexnow_outbox"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "indexnow_outbox_url_revision_key" ON "indexnow_outbox"("url", "revision");

-- CreateIndex
CREATE INDEX "indexnow_attempt_request_batch_idx" ON "indexnow_outbox_attempt"("request_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "indexnow_attempt_number_key" ON "indexnow_outbox_attempt"("outbox_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_run_manual_trigger_id_key" ON "schedule_run"("manual_trigger_id");

-- CreateIndex
CREATE INDEX "schedule_run_due_idx" ON "schedule_run"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_run_scheduled_key" ON "schedule_run"("schedule_key", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "cron_run_schedule_run_id_key" ON "cron_run"("schedule_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "cron_run_generic_task_id_key" ON "cron_run"("generic_task_id");

-- CreateIndex
CREATE INDEX "cron_run_status_created_idx" ON "cron_run"("status", "created_at");

-- CreateIndex
CREATE INDEX "article_template_status_locale_idx" ON "article_template"("status", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "article_template_version_key" ON "article_template"("template_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "article_public_page_short_id_key" ON "article"("public_page_short_id");

-- CreateIndex
CREATE INDEX "article_status_published_idx" ON "article"("status", "published_at");

-- CreateIndex
CREATE INDEX "article_locale_status_idx" ON "article"("locale", "status");

-- CreateIndex
CREATE INDEX "article_promo_link_idx" ON "article"("promo_link_id");

-- CreateIndex
CREATE UNIQUE INDEX "article_novel_locale_key" ON "article"("novel_id", "locale");

-- CreateIndex
CREATE INDEX "carousel_manual_locale_enabled_idx" ON "home_carousel_manual_slot"("locale", "enabled", "position");

-- CreateIndex
CREATE INDEX "carousel_manual_article_idx" ON "home_carousel_manual_slot"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "home_carousel_auto_batch_unique_key_key" ON "home_carousel_auto_batch"("unique_key");

-- CreateIndex
CREATE INDEX "carousel_batch_status_created_idx" ON "home_carousel_auto_batch"("status", "created_at");

-- CreateIndex
CREATE INDEX "carousel_batch_run_date_idx" ON "home_carousel_auto_batch"("run_date");

-- CreateIndex
CREATE INDEX "carousel_candidate_batch_locale_idx" ON "home_carousel_auto_candidate"("batch_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "carousel_candidate_batch_locale_rank_key" ON "home_carousel_auto_candidate"("batch_id", "locale", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "carousel_candidate_batch_novel_key" ON "home_carousel_auto_candidate"("batch_id", "novel_id");

-- CreateIndex
CREATE INDEX "carousel_serving_article_idx" ON "home_carousel_serving"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "carousel_serving_locale_position_key" ON "home_carousel_serving"("locale", "position");

-- CreateIndex
CREATE INDEX "carousel_change_locale_created_idx" ON "home_carousel_change_log"("locale", "created_at");

-- CreateIndex
CREATE INDEX "carousel_change_manual_slot_idx" ON "home_carousel_change_log"("manual_slot_id");

-- AddForeignKey
ALTER TABLE "channel_app" ADD CONSTRAINT "channel_app_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_app" ADD CONSTRAINT "channel_app_source_app_id_fkey" FOREIGN KEY ("source_app_id") REFERENCES "source_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_capability" ADD CONSTRAINT "channel_capability_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account" ADD CONSTRAINT "channel_account_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_credential" ADD CONSTRAINT "channel_account_credential_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_credential_active_fingerprint" ADD CONSTRAINT "channel_credential_active_fingerprint_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "channel_account_credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_credential_active_fingerprint" ADD CONSTRAINT "channel_credential_active_fingerprint_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_change_log" ADD CONSTRAINT "credential_change_log_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_change_log" ADD CONSTRAINT "credential_change_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "channel_account_credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_source_item" ADD CONSTRAINT "novel_source_item_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_source_item" ADD CONSTRAINT "novel_source_item_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter" ADD CONSTRAINT "novel_chapter_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_source_item" ADD CONSTRAINT "novel_chapter_source_item_novel_source_item_id_fkey" FOREIGN KEY ("novel_source_item_id") REFERENCES "novel_source_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_source_item" ADD CONSTRAINT "novel_chapter_source_item_novel_chapter_id_fkey" FOREIGN KEY ("novel_chapter_id") REFERENCES "novel_chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_content" ADD CONSTRAINT "novel_chapter_content_novel_chapter_id_fkey" FOREIGN KEY ("novel_chapter_id") REFERENCES "novel_chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_chapter_content" ADD CONSTRAINT "novel_chapter_content_source_fetch_id_fkey" FOREIGN KEY ("source_fetch_id") REFERENCES "channel_sync_task_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_preview_policy" ADD CONSTRAINT "novel_preview_policy_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_label" ADD CONSTRAINT "source_label_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_source_item_label" ADD CONSTRAINT "novel_source_item_label_novel_source_item_id_fkey" FOREIGN KEY ("novel_source_item_id") REFERENCES "novel_source_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_source_item_label" ADD CONSTRAINT "novel_source_item_label_source_label_id_fkey" FOREIGN KEY ("source_label_id") REFERENCES "source_label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_novel_source_item_id_fkey" FOREIGN KEY ("novel_source_item_id") REFERENCES "novel_source_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_event" ADD CONSTRAINT "tracking_event_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_event" ADD CONSTRAINT "tracking_event_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_event" ADD CONSTRAINT "tracking_event_promo_link_id_fkey" FOREIGN KEY ("promo_link_id") REFERENCES "promo_link"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_scan_task_item" ADD CONSTRAINT "catalog_scan_task_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "catalog_scan_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_task_item" ADD CONSTRAINT "channel_sync_task_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "channel_sync_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_task_item" ADD CONSTRAINT "channel_sync_task_item_novel_source_item_id_fkey" FOREIGN KEY ("novel_source_item_id") REFERENCES "novel_source_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generic_task_item" ADD CONSTRAINT "generic_task_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "generic_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_effect_intent" ADD CONSTRAINT "side_effect_intent_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_effect_intent" ADD CONSTRAINT "side_effect_intent_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "side_effect_intent" ADD CONSTRAINT "side_effect_intent_promo_link_id_fkey" FOREIGN KEY ("promo_link_id") REFERENCES "promo_link"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexnow_outbox" ADD CONSTRAINT "indexnow_outbox_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexnow_outbox_attempt" ADD CONSTRAINT "indexnow_outbox_attempt_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "indexnow_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_run" ADD CONSTRAINT "cron_run_schedule_run_id_fkey" FOREIGN KEY ("schedule_run_id") REFERENCES "schedule_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_run" ADD CONSTRAINT "cron_run_generic_task_id_fkey" FOREIGN KEY ("generic_task_id") REFERENCES "generic_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article" ADD CONSTRAINT "article_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article" ADD CONSTRAINT "article_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "article_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article" ADD CONSTRAINT "article_promo_link_novel_fkey" FOREIGN KEY ("promo_link_id", "novel_id") REFERENCES "promo_link"("id", "novel_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_manual_slot" ADD CONSTRAINT "home_carousel_manual_slot_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_manual_slot" ADD CONSTRAINT "home_carousel_manual_slot_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_auto_candidate" ADD CONSTRAINT "home_carousel_auto_candidate_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "home_carousel_auto_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_auto_candidate" ADD CONSTRAINT "home_carousel_auto_candidate_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_auto_candidate" ADD CONSTRAINT "home_carousel_auto_candidate_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_manual_slot_id_fkey" FOREIGN KEY ("manual_slot_id") REFERENCES "home_carousel_manual_slot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "home_carousel_auto_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PostgreSQL-only CHECK constraints: status and restricted values.
ALTER TABLE "channel" ADD CONSTRAINT "channel_status_check" CHECK ("status" IN ('active', 'inactive', 'registered_disabled'));
ALTER TABLE "source_app" ADD CONSTRAINT "source_app_status_check" CHECK ("status" IN ('active', 'inactive', 'registered_disabled'));
ALTER TABLE "channel_app" ADD CONSTRAINT "channel_app_status_check" CHECK ("status" IN ('active', 'inactive', 'registered_disabled'));
ALTER TABLE "channel_capability" ADD CONSTRAINT "channel_capability_status_check" CHECK ("status" IN ('enabled', 'registered_disabled', 'registered_partial'));
ALTER TABLE "channel_account" ADD CONSTRAINT "channel_account_status_check" CHECK ("status" IN ('active', 'disabled'));
ALTER TABLE "channel_account_credential" ADD CONSTRAINT "channel_account_credential_status_check" CHECK ("status" IN ('active', 'superseded', 'revoked', 'expired'));
ALTER TABLE "novel" ADD CONSTRAINT "novel_status_check" CHECK ("status" IN ('draft', 'ready', 'published', 'unpublished', 'takedown'));
ALTER TABLE "novel_source_item" ADD CONSTRAINT "novel_source_item_status_check" CHECK ("status" IN ('pending', 'linked', 'ignored', 'stale'));
ALTER TABLE "novel_chapter" ADD CONSTRAINT "novel_chapter_status_check" CHECK ("status" IN ('preview', 'locked', 'stale', 'withdrawn'));
ALTER TABLE "novel_chapter_source_item" ADD CONSTRAINT "novel_chapter_source_item_status_check" CHECK ("status" IN ('pending', 'materialized', 'failed'));
ALTER TABLE "novel_preview_policy" ADD CONSTRAINT "novel_preview_policy_materialization_policy_check" CHECK ("materialization_policy" IN ('upstream_returned_preview'));
ALTER TABLE "source_label" ADD CONSTRAINT "source_label_label_kind_check" CHECK ("label_kind" IN ('series_type', 'recommend', 'language', 'agency'));
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_status_check" CHECK ("status" IN ('pending', 'fetched', 'failed', 'registered_disabled'));
ALTER TABLE "promo_link" ADD CONSTRAINT "promo_link_origin_check" CHECK ("origin" IN ('upstream_existing', 'claimed'));
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'disabled'));
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_mode_check" CHECK ("mode" IN ('dry_run', 'apply'));
ALTER TABLE "catalog_scan_task_item" ADD CONSTRAINT "catalog_scan_task_item_status_check" CHECK ("status" IN ('pending', 'processing', 'success', 'failed'));
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'disabled'));
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_mode_check" CHECK ("mode" IN ('dry_run', 'apply'));
ALTER TABLE "channel_sync_task_item" ADD CONSTRAINT "channel_sync_task_item_status_check" CHECK ("status" IN ('pending', 'processing', 'success', 'skipped', 'failed'));
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'disabled'));
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_mode_check" CHECK ("mode" IN ('dry_run', 'apply'));
ALTER TABLE "generic_task_item" ADD CONSTRAINT "generic_task_item_status_check" CHECK ("status" IN ('pending', 'processing', 'success', 'skipped', 'failed'));
ALTER TABLE "side_effect_intent" ADD CONSTRAINT "side_effect_intent_status_check" CHECK ("status" IN ('prepared', 'confirmed', 'failed', 'claim_retry_blocked', 'manual_review_required'));
ALTER TABLE "indexnow_outbox" ADD CONSTRAINT "indexnow_outbox_status_check" CHECK ("status" IN ('pending', 'processing', 'accepted', 'retry_wait', 'permanent_failed', 'dead_letter', 'cancelled'));
ALTER TABLE "indexnow_outbox_attempt" ADD CONSTRAINT "indexnow_outbox_attempt_attempt_state_check" CHECK ("attempt_state" IN ('started', 'accepted', 'retryable_failed', 'permanent_failed'));
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_status_check" CHECK ("status" IN ('due', 'enqueued', 'misfired', 'skipped', 'failed'));
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_trigger_kind_check" CHECK ("trigger_kind" IN ('scheduled', 'manual'));
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_misfire_policy_check" CHECK ("misfire_policy" IN ('bounded_catch_up', 'skip', 'mark_failed'));
ALTER TABLE "cron_run" ADD CONSTRAINT "cron_run_status_check" CHECK ("status" IN ('created', 'task_created', 'failed'));
ALTER TABLE "article_template" ADD CONSTRAINT "article_template_status_check" CHECK ("status" IN ('draft', 'active', 'retired'));
ALTER TABLE "article" ADD CONSTRAINT "article_status_check" CHECK ("status" IN ('draft', 'published', 'unpublished', 'takedown'));
ALTER TABLE "home_carousel_auto_batch" ADD CONSTRAINT "home_carousel_auto_batch_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'failed'));
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_source_check" CHECK ("source" IN ('manual', 'automatic'));

-- PostgreSQL-only CHECK constraints: numeric, temporal, lease, and publication shape.
ALTER TABLE "channel_app" ADD CONSTRAINT "channel_app_project_type_check" CHECK ("project_type" > 0);
ALTER TABLE "channel_capability" ADD CONSTRAINT "channel_capability_limits_check" CHECK (("qps_limit" IS NULL OR "qps_limit" > 0) AND ("timeout_ms" IS NULL OR "timeout_ms" > 0));
ALTER TABLE "channel_account_credential" ADD CONSTRAINT "channel_account_credential_key_version_check" CHECK ("key_version" > 0);
ALTER TABLE "novel" ADD CONSTRAINT "novel_chapter_metadata_check" CHECK ("total_chapter_count" >= 0 AND ("paid_from_chapter" IS NULL OR "paid_from_chapter" > 0));
ALTER TABLE "novel_source_item" ADD CONSTRAINT "novel_source_item_metadata_check" CHECK ("total_chapter_count" >= 0 AND ("paid_from_chapter" IS NULL OR "paid_from_chapter" > 0) AND "raw_payload_schema_version" > 0);
ALTER TABLE "novel_chapter" ADD CONSTRAINT "novel_chapter_number_check" CHECK ("canonical_chapter_number" > 0);
ALTER TABLE "novel_chapter_content" ADD CONSTRAINT "novel_chapter_content_char_count_check" CHECK ("char_count" >= 0);
ALTER TABLE "novel_preview_policy" ADD CONSTRAINT "novel_preview_policy_counts_check" CHECK ("materialized_chapter_count" >= 0 AND "max_materialized_chapters" >= 0);
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_page_shape_check" CHECK ("project_type" > 0 AND "page_start" > 0 AND "page_end" >= "page_start" AND "page_size" > 0);
ALTER TABLE "catalog_scan_task" ADD CONSTRAINT "catalog_scan_task_counts_check" CHECK ("total_count" >= 0 AND "success_count" >= 0 AND "failed_count" >= 0 AND ("catalog_observed_total" IS NULL OR "catalog_observed_total" >= 0) AND ("batch_expected_count" IS NULL OR "batch_expected_count" >= 0) AND ("batch_actual_count" IS NULL OR "batch_actual_count" >= 0));
ALTER TABLE "catalog_scan_task_item" ADD CONSTRAINT "catalog_scan_task_item_page_shape_check" CHECK ("page_index" > 0 AND ("page_range_end" IS NULL OR "page_range_end" >= "page_index") AND ("returned_count" IS NULL OR "returned_count" >= 0));
ALTER TABLE "catalog_scan_task_item" ADD CONSTRAINT "catalog_scan_task_item_lease_shape_check" CHECK ("attempt_count" >= 0 AND "lease_epoch" >= 0 AND ("status" <> 'pending' OR ("execution_token" IS NULL AND "locked_by" IS NULL AND "locked_until" IS NULL AND "heartbeat_at" IS NULL)) AND ("status" <> 'processing' OR ("execution_token" IS NOT NULL AND "locked_by" IS NOT NULL AND "locked_until" IS NOT NULL)));
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_counts_check" CHECK ("total_count" >= 0 AND "success_count" >= 0 AND "failed_count" >= 0 AND "skipped_count" >= 0);
ALTER TABLE "channel_sync_task_item" ADD CONSTRAINT "channel_sync_task_item_lease_shape_check" CHECK ("attempt_count" >= 0 AND "lease_epoch" >= 0 AND ("status" <> 'pending' OR ("execution_token" IS NULL AND "locked_by" IS NULL AND "locked_until" IS NULL AND "heartbeat_at" IS NULL)) AND ("status" <> 'processing' OR ("execution_token" IS NOT NULL AND "locked_by" IS NOT NULL AND "locked_until" IS NOT NULL)));
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_counts_check" CHECK ("total_count" >= 0 AND "success_count" >= 0 AND "failed_count" >= 0 AND "skipped_count" >= 0);
ALTER TABLE "generic_task_item" ADD CONSTRAINT "generic_task_item_lease_shape_check" CHECK ("attempt_count" >= 0 AND "lease_epoch" >= 0 AND ("status" <> 'pending' OR ("execution_token" IS NULL AND "locked_by" IS NULL AND "locked_until" IS NULL AND "heartbeat_at" IS NULL)) AND ("status" <> 'processing' OR ("execution_token" IS NOT NULL AND "locked_by" IS NOT NULL AND "locked_until" IS NOT NULL)));
ALTER TABLE "indexnow_outbox" ADD CONSTRAINT "indexnow_outbox_attempts_check" CHECK ("revision" >= 0 AND "attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts");
ALTER TABLE "indexnow_outbox_attempt" ADD CONSTRAINT "indexnow_outbox_attempt_numbers_check" CHECK ("attempt_no" > 0 AND "batch_size" > 0);
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_numbers_check" CHECK ("schedule_revision" > 0 AND "max_catch_up_runs" >= 0);
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_trigger_shape_check" CHECK (("trigger_kind" = 'scheduled' AND "scheduled_for" IS NOT NULL AND "manual_trigger_id" IS NULL) OR ("trigger_kind" = 'manual' AND "scheduled_for" IS NULL AND "manual_trigger_id" IS NOT NULL));
ALTER TABLE "cron_run" ADD CONSTRAINT "cron_run_task_shape_check" CHECK ("status" <> 'task_created' OR "generic_task_id" IS NOT NULL);
ALTER TABLE "article_template" ADD CONSTRAINT "article_template_versions_check" CHECK ("version" > 0 AND "schema_version" > 0);
ALTER TABLE "article" ADD CONSTRAINT "article_seo_schema_version_check" CHECK ("seo_schema_version" > 0);
ALTER TABLE "article" ADD CONSTRAINT "article_published_title_check" CHECK ("status" <> 'published' OR btrim("title") <> '');
ALTER TABLE "article" ADD CONSTRAINT "article_published_slug_check" CHECK ("status" <> 'published' OR btrim("slug") <> '');
ALTER TABLE "article" ADD CONSTRAINT "article_published_body_check" CHECK ("status" <> 'published' OR btrim("body") <> '');
ALTER TABLE "article" ADD CONSTRAINT "article_published_promo_link_check" CHECK ("status" <> 'published' OR "promo_link_id" IS NOT NULL);
ALTER TABLE "article" ADD CONSTRAINT "article_published_published_at_check" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL);
ALTER TABLE "home_carousel_manual_slot" ADD CONSTRAINT "carousel_manual_position_check" CHECK ("position" > 0);
ALTER TABLE "home_carousel_manual_slot" ADD CONSTRAINT "carousel_manual_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at");
ALTER TABLE "home_carousel_auto_candidate" ADD CONSTRAINT "carousel_candidate_rank_check" CHECK ("rank" > 0);
ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "carousel_serving_position_check" CHECK ("position" > 0);

-- PostgreSQL-only partial unique indexes.
CREATE UNIQUE INDEX "credential_active_account_type_uidx" ON "channel_account_credential"("channel_account_id", "credential_type") WHERE "status" = 'active';
CREATE UNIQUE INDEX "novel_locale_slug_active_uidx" ON "novel"("locale", "slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "novel_chapter_number_active_uidx" ON "novel_chapter"("novel_id", "canonical_chapter_number") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "article_locale_slug_active_uidx" ON "article"("locale", "slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "catalog_scan_active_scope_uidx" ON "catalog_scan_task"("channel_account_id", "channel_app_id", "project_type") WHERE "status" IN ('pending', 'processing');
CREATE UNIQUE INDEX "channel_sync_active_scope_uidx" ON "channel_sync_task"("task_type", "channel_account_id", "channel_app_id", "operation_scope_hash") WHERE "status" IN ('pending', 'processing');
CREATE UNIQUE INDEX "generic_task_active_scope_uidx" ON "generic_task"("task_type", "channel_account_id", "channel_app_id", "operation_scope_hash") NULLS NOT DISTINCT WHERE "status" IN ('pending', 'processing');
CREATE UNIQUE INDEX "carousel_manual_position_active_uidx" ON "home_carousel_manual_slot"("locale", "position") WHERE "enabled" IS TRUE AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "carousel_manual_novel_active_uidx" ON "home_carousel_manual_slot"("locale", "novel_id") WHERE "enabled" IS TRUE AND "deleted_at" IS NULL;

-- Worker claim and expired-lease recovery are intentionally separate paths and indexes.
CREATE INDEX "catalog_scan_task_item_pending_claim_idx" ON "catalog_scan_task_item"("task_id", "created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "catalog_scan_task_item_pending_global_idx" ON "catalog_scan_task_item"("created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "catalog_scan_task_item_expired_lease_idx" ON "catalog_scan_task_item"("locked_until", "id") WHERE "status" = 'processing' AND "locked_until" IS NOT NULL;
CREATE INDEX "channel_sync_task_item_pending_claim_idx" ON "channel_sync_task_item"("task_id", "created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "channel_sync_task_item_pending_global_idx" ON "channel_sync_task_item"("created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "channel_sync_task_item_expired_lease_idx" ON "channel_sync_task_item"("locked_until", "id") WHERE "status" = 'processing' AND "locked_until" IS NOT NULL;
CREATE INDEX "generic_task_item_pending_claim_idx" ON "generic_task_item"("task_id", "created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "generic_task_item_pending_global_idx" ON "generic_task_item"("created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "generic_task_item_expired_lease_idx" ON "generic_task_item"("locked_until", "id") WHERE "status" = 'processing' AND "locked_until" IS NOT NULL;

-- Immutable public redirect codes retain their global unique reservation after soft delete.
CREATE FUNCTION "reject_promo_public_redirect_code_change"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."public_redirect_code" IS DISTINCT FROM OLD."public_redirect_code" THEN
    RAISE EXCEPTION 'public_redirect_code is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'promo_public_code_immutable_trigger';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promo_public_code_immutable_trigger"
BEFORE UPDATE OF "public_redirect_code" ON "promo_link"
FOR EACH ROW EXECUTE FUNCTION "reject_promo_public_redirect_code_change"();

-- operation_audit is append-only; P1-06 will add role-level permissions separately.
CREATE FUNCTION "reject_operation_audit_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operation_audit is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'operation_audit_append_only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER "operation_audit_append_only"
BEFORE UPDATE OR DELETE ON "operation_audit"
FOR EACH ROW EXECUTE FUNCTION "reject_operation_audit_mutation"();
