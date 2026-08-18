-- v0.2.0 foundation (Stream F): the one migration for this round.
-- 1) IndexNowOutbox/-Attempt CPS-parity fields (delivery lifecycle, review-defer workflow,
--    task correlation). Task-correlation columns are GenericTask.id typed (String @db.Uuid),
--    not CPS's SQLite Int; intentionally left as bare UUID columns (no FK/relation) so that
--    GenericTask's 365-day head retention can never be blocked by IndexNow outbox rows that
--    outlive it. See docs/governance/database-governance.md and
--    docs/p2/V020_FOUNDATION_INTERFACES.md.
-- 2) IndexNowOutboxAttempt.attemptState (HTTP result classification, zero verified consumers)
--    is renamed to `outcome` with values preserved; the vacated `attemptState` name is reused
--    for CPS's worker crash-recovery semantics (started | completed | unknown_outcome).
-- 3) SiteSetting: singleton global site configuration table, PostgreSQL-ized from CPS.

-- ---------------------------------------------------------------------------
-- IndexNowOutbox: add CPS-parity lifecycle / review-defer / task-correlation columns
-- ---------------------------------------------------------------------------

ALTER TABLE "indexnow_outbox"
  ADD COLUMN "last_request_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_response_at" TIMESTAMPTZ(6),
  ADD COLUMN "defer_reason" VARCHAR(96),
  ADD COLUMN "released_at" TIMESTAMPTZ(6),
  ADD COLUMN "release_reason" TEXT,
  ADD COLUMN "release_commit" VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "payload_host" VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN "delivery_task_id" UUID;

CREATE INDEX "indexnow_outbox_defer_reason_status_idx" ON "indexnow_outbox"("defer_reason", "status");

-- ---------------------------------------------------------------------------
-- IndexNowOutboxAttempt: rename attempt_state -> outcome (values unchanged), then reuse the
-- vacated attempt_state name for CPS crash-recovery semantics. Also add worker_task_id.
-- ---------------------------------------------------------------------------

ALTER TABLE "indexnow_outbox_attempt" RENAME COLUMN "attempt_state" TO "outcome";
ALTER TABLE "indexnow_outbox_attempt"
  RENAME CONSTRAINT "indexnow_outbox_attempt_attempt_state_check" TO "indexnow_outbox_attempt_outcome_check";

ALTER TABLE "indexnow_outbox_attempt"
  ADD COLUMN "attempt_state" VARCHAR(32) NOT NULL DEFAULT 'started',
  ADD COLUMN "worker_task_id" UUID;

ALTER TABLE "indexnow_outbox_attempt"
  ADD CONSTRAINT "indexnow_outbox_attempt_attempt_state_check"
  CHECK ("attempt_state" IN ('started', 'completed', 'unknown_outcome'));

-- ---------------------------------------------------------------------------
-- SiteSetting: singleton global site configuration
-- ---------------------------------------------------------------------------

CREATE TABLE "site_setting" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "site_name" VARCHAR(160) NOT NULL DEFAULT 'CPS Novel',
  "site_description" TEXT NOT NULL DEFAULT '',
  "home_meta_title" VARCHAR(500) NOT NULL DEFAULT '',
  "home_meta_description" TEXT NOT NULL DEFAULT '',
  "default_og_image" TEXT NOT NULL DEFAULT '',
  "google_search_console_verification" VARCHAR(255) NOT NULL DEFAULT '',
  "footer_copyright_text" TEXT NOT NULL DEFAULT '',
  "footer_disclaimer_text" TEXT NOT NULL DEFAULT '',
  "friend_links" JSONB NOT NULL DEFAULT '[]',
  "indexnow_host" VARCHAR(255) NOT NULL DEFAULT '',
  "indexnow_key" VARCHAR(255) NOT NULL DEFAULT '',
  "indexnow_key_location" VARCHAR(255) NOT NULL DEFAULT '',
  "ga4_measurement_id" VARCHAR(64),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "site_setting_pkey" PRIMARY KEY ("id"),
  -- Defense in depth beyond CPS: CPS relies purely on application discipline (always querying
  -- id=1) to keep this a singleton. PostgreSQL enforces it directly here.
  CONSTRAINT "site_setting_singleton_check" CHECK ("id" = 1)
);

-- `updated_at` has no DB-level DEFAULT because it is a Prisma `@updatedAt` field (matches every
-- other `updated_at` column in this schema, e.g. `channel.updated_at`); Prisma Client sets it on
-- every write. The seed row below supplies it explicitly for this one migration-time INSERT.
INSERT INTO "site_setting" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP);
