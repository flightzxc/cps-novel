-- C-30A: 换小说地基 (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1).
--
-- CPS parity: `article_drama_switch_preview` / `article_drama_switch_batch` /
-- `article_drama_switch_batch_item` (cps-admin-v851-admin-host HEAD c37602c,
-- prisma/schema.prisma:626-746). Field lists copied verbatim except the
-- following 海阅-specific deviations:
--   (a) UUID primary keys where this repo's own convention already uses
--       UUID (CPS uses integer autoincrement / cuid);
--   (b) the batch item's "old / expected / applied" triad is doubled to
--       cover BOTH novel_id AND promo_link_id, because 海阅's rebind is a
--       two-field atomic swap (novel + its promo link, tied together by the
--       existing composite FK `article_promo_link_novel_fkey`) where CPS's
--       switch is a single `drama_id` column;
--   (c) CPS's single `direction VARCHAR` column (present on both its
--       preview and batch tables) is split here into two explicit columns,
--       `source_channel_code`/`target_channel_code`, matching this repo's
--       own multi-channel vocabulary instead of CPS's implicit direction
--       string;
--   (d) `filters_json`/`matches_json` are `JSONB` here, not CPS's `TEXT`
--       columns of the same name, each paired with its own
--       `*_schema_version INTEGER NOT NULL DEFAULT 1` column (three such
--       pairs across these tables: preview.filters_json,
--       preview.matches_json, batch.filters_json) — this repo's own
--       JSONB-plus-version-column convention (§9 of
--       `docs/governance/database-governance.md`), which predates CPS's
--       schema and which CPS does not use;
--   (e) CPS's `ArticleDramaSwitchBatch.errorLog` column is dropped: this
--       repo keeps no per-batch inline error log, only each item's own
--       `error_kind`/`error_message`;
--   (f) CPS's `ArticleDramaSwitchBatchItem.switchLogId` (a pointer into
--       CPS's own dedicated `article_drama_switch_log` table) is renamed
--       `audit_id` here and points at this repo's existing
--       `operation_audit.id` instead — this repo has no dedicated
--       switch-log table (see `audit_id`'s own column comment below);
--   (g) `preview_id` carries no FK to `article_novel_rebind_preview` — CPS
--       parity with `ArticleDramaSwitchBatch.previewId`, which is likewise
--       FK-less: the preview row is bounded-lifetime (30-minute expiry +
--       bounded cleanup sweep) and may legitimately be gone long before
--       this batch row's own long-term retention ends.
--
-- Four things this migration does:
--   1. `novel.title_normalized` (nullable VARCHAR(500)) + a
--      `(locale, title_normalized)` index — CPS parity with
--      `Drama.nameNormalized`. Nullable and unread by any query this
--      migration ships with: no backfill runs inside this DDL (see
--      `scripts/backfill-novel-title-normalized.ts`, a separate, idempotent,
--      re-runnable script per the construction order — deliberately NOT
--      folded into this migration so the migration itself stays a fast,
--      lock-light DDL-only change on a table with production rows).
--   2. `article_novel_rebind_preview` — bounded-lifetime (30 min) snapshot
--      of a bipartite-matched batch-rebind plan.
--   3. `article_novel_rebind_batch` — durable batch header (submission,
--      idempotency token, lease, counts, terminal status).
--   4. `article_novel_rebind_batch_item` — one row per article in a batch,
--      carrying its own before/expected/after novel+promo-link pair.
--
-- Tables 2-4 are additive and empty on creation: zero existing rows,
-- zero behavior change for any existing query. This migration's own
-- guard (bottom of file) certifies `novel.title_normalized` lands NULL for
-- every existing row (the column has no DEFAULT, so this is mechanically
-- guaranteed by ADD COLUMN itself — the guard exists so a future edit to
-- this file that adds a DEFAULT or a backfill UPDATE fails loudly instead of
-- silently changing this migration's own "DDL-only, no data mutation"
-- contract).
--
-- Status/error-kind value lists (src/domain/database-statuses.ts, this same
-- commit):
--   * article_novel_rebind_batch.status: ready | processing | completed |
--     partial | failed
--   * article_novel_rebind_batch_item.status: pending | processing |
--     applied | skipped | failed
--   * article_novel_rebind_batch_item.error_kind: drift | not_found |
--     blocked | ineligible | fence_lost | unknown (nullable — NULL means
--     "no error recorded yet / terminal without an error")

-- ---------------------------------------------------------------------
-- 1. novel.title_normalized
-- ---------------------------------------------------------------------
ALTER TABLE "novel" ADD COLUMN "title_normalized" VARCHAR(500);

CREATE INDEX "novel_locale_title_normalized_idx" ON "novel"("locale", "title_normalized");

-- ---------------------------------------------------------------------
-- 2. article_novel_rebind_preview
-- ---------------------------------------------------------------------
CREATE TABLE "article_novel_rebind_preview" (
    "id" UUID NOT NULL,
    "created_by" VARCHAR(128) NOT NULL,
    "source_channel_code" VARCHAR(64) NOT NULL,
    "target_channel_code" VARCHAR(64) NOT NULL,
    "filters_json" JSONB NOT NULL,
    "filters_json_schema_version" INTEGER NOT NULL DEFAULT 1,
    "plan_hash" CHAR(64) NOT NULL,
    "source_scanned" INTEGER NOT NULL,
    "matched_count" INTEGER NOT NULL,
    "ambiguous_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "matches_json" JSONB NOT NULL,
    "matches_json_schema_version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_novel_rebind_preview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "article_novel_rebind_preview_created_by_created_idx" ON "article_novel_rebind_preview"("created_by", "created_at");
CREATE INDEX "article_novel_rebind_preview_expires_idx" ON "article_novel_rebind_preview"("expires_at");

-- ---------------------------------------------------------------------
-- 3. article_novel_rebind_batch
-- ---------------------------------------------------------------------
CREATE TABLE "article_novel_rebind_batch" (
    -- Human-readable batch number (rebind-{yyyymmddhhmmss}-{8 random}),
    -- application-supplied — never a bare UUID (施工工单 §4B.4 "零裸 UUID").
    "id" VARCHAR(64) NOT NULL,
    "created_by" VARCHAR(128) NOT NULL,
    "request_token" VARCHAR(160) NOT NULL,
    "preview_id" UUID NOT NULL,
    "selection_hash" CHAR(64) NOT NULL,
    "request_payload_hash" CHAR(64) NOT NULL,
    "source_channel_code" VARCHAR(64) NOT NULL,
    "target_channel_code" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'ready',
    "acknowledge_risks" BOOLEAN NOT NULL DEFAULT false,
    "submitted_count" INTEGER NOT NULL DEFAULT 0,
    "resolvable_count" INTEGER NOT NULL DEFAULT 0,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "filters_json" JSONB NOT NULL,
    "filters_json_schema_version" INTEGER NOT NULL DEFAULT 1,
    "plan_hash" CHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "execution_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "article_novel_rebind_batch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_novel_rebind_batch_request_token_key" ON "article_novel_rebind_batch"("request_token");
CREATE INDEX "article_novel_rebind_batch_status_created_idx" ON "article_novel_rebind_batch"("status", "created_at");
CREATE INDEX "article_novel_rebind_batch_created_by_created_idx" ON "article_novel_rebind_batch"("created_by", "created_at");
CREATE INDEX "article_novel_rebind_batch_preview_idx" ON "article_novel_rebind_batch"("preview_id");

ALTER TABLE "article_novel_rebind_batch" ADD CONSTRAINT "article_novel_rebind_batch_status_check"
  CHECK ("status" IN ('ready', 'processing', 'completed', 'partial', 'failed'));

-- Not a hard FK to article_novel_rebind_preview: the preview row is
-- bounded-lifetime (30-minute expiry + bounded cleanup sweep,
-- `cleanupExpiredBatchSwitchPreviews`, C-30B) and may legitimately be gone
-- long before this batch row's own retention ends. `preview_id` is kept as a
-- plain UUID column (see the Prisma model's own doc comment) for CPS parity
-- with `ArticleDramaSwitchBatch.previewId`, which likewise carries no FK.

-- Not a hard FK to admin_identity for `created_by`: this repo's own
-- OperationAudit.actor_id (P1-06) already establishes the "actor id is a
-- plain VARCHAR(128), not an FK" convention for exactly this reason — an
-- audit-shaped record must remain legible even if the identity row is later
-- removed.

-- ---------------------------------------------------------------------
-- 4. article_novel_rebind_batch_item
-- ---------------------------------------------------------------------
CREATE TABLE "article_novel_rebind_batch_item" (
    "id" UUID NOT NULL,
    "batch_id" VARCHAR(64) NOT NULL,
    "article_id" UUID NOT NULL,
    "old_novel_id" UUID NOT NULL,
    "old_promo_link_id" UUID,
    "expected_new_novel_id" UUID NOT NULL,
    "expected_new_promo_link_id" UUID,
    "applied_new_novel_id" UUID,
    "applied_new_promo_link_id" UUID,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "processing_token" UUID,
    "error_kind" VARCHAR(32),
    "error_message" TEXT,
    "audit_id" BIGINT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "article_novel_rebind_batch_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_novel_rebind_batch_item_batch_article_key" ON "article_novel_rebind_batch_item"("batch_id", "article_id");
CREATE INDEX "article_novel_rebind_batch_item_batch_status_id_idx" ON "article_novel_rebind_batch_item"("batch_id", "status", "id");
CREATE INDEX "article_novel_rebind_batch_item_article_status_idx" ON "article_novel_rebind_batch_item"("article_id", "status");
CREATE INDEX "article_novel_rebind_batch_item_processing_token_idx" ON "article_novel_rebind_batch_item"("processing_token");

ALTER TABLE "article_novel_rebind_batch_item" ADD CONSTRAINT "article_novel_rebind_batch_item_status_check"
  CHECK ("status" IN ('pending', 'processing', 'applied', 'skipped', 'failed'));

ALTER TABLE "article_novel_rebind_batch_item" ADD CONSTRAINT "article_novel_rebind_batch_item_error_kind_check"
  CHECK ("error_kind" IS NULL OR "error_kind" IN ('drift', 'not_found', 'blocked', 'ineligible', 'fence_lost', 'unknown'));

-- `batch_id` is the one hard FK across tables 2-4: an item is meaningless
-- without its batch, and CASCADE on batch delete matches CPS's own
-- `ArticleDramaSwitchBatchItem.batch` relation (`onDelete: Cascade`).
-- `article_id`/`old_novel_id`/`old_promo_link_id`/`expected_new_novel_id`/
-- `expected_new_promo_link_id`/`applied_new_novel_id`/
-- `applied_new_promo_link_id` carry no FK — same CPS-parity reasoning as
-- `preview_id` above: this table is an audit-shaped record of what was
-- planned/attempted per article, and it must stay legible even after the
-- article, novel, or promo link it names is later soft- or hard-deleted by
-- an unrelated path (CPS's own `ArticleDramaSwitchBatchItem.articleId`/
-- `oldDramaId`/`expectedNewDramaId`/`appliedNewDramaId` carry none either).
-- `audit_id` (references `operation_audit.id`, a BIGSERIAL) is likewise a
-- plain column: `operation_audit` is an append-only log table with no
-- back-relation anywhere in this schema (P1-06).
ALTER TABLE "article_novel_rebind_batch_item" ADD CONSTRAINT "article_novel_rebind_batch_item_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "article_novel_rebind_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. Self-certifying guard. This migration adds one nullable, no-DEFAULT
-- column to a table with production rows (novel) and three brand-new, empty
-- tables. Every existing `novel` row is therefore mechanically guaranteed to
-- read `title_normalized IS NULL` immediately after this migration — the
-- guard exists so a future edit to this file that adds a DEFAULT or a
-- backfill UPDATE (folding the separate, idempotent
-- `scripts/backfill-novel-title-normalized.ts` script's job into this DDL)
-- fails loudly instead of silently turning a fast, lock-light schema-only
-- migration into a data-mutating one on a table with live rows.
-- ---------------------------------------------------------------------
DO $c30_novel_rebind_foundation_guard$
DECLARE
    off_default_count BIGINT;
BEGIN
    SELECT count(*)
      INTO off_default_count
      FROM "novel"
     WHERE "title_normalized" IS NOT NULL;

    IF off_default_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'C-30A novel rebind foundation migration blocked: found %s novel row(s) with a non-NULL title_normalized immediately after ADD COLUMN; this migration must stay DDL-only with zero data mutation',
                off_default_count
            );
    END IF;
END;
$c30_novel_rebind_foundation_guard$;
