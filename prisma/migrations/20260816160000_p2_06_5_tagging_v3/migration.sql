-- P2-06.5 Tagging V3 persistence foundation.
-- This additive migration creates structure only. It intentionally contains no
-- taxonomy/mapping seed, historical scope backfill, classifier, or external call.

ALTER TABLE "novel_source_item"
  ADD COLUMN "raw_language_scope" TEXT;

CREATE TABLE "canonical_tag" (
  "id" UUID NOT NULL,
  "stable_id" VARCHAR(160) NOT NULL,
  "slug" VARCHAR(160) NOT NULL,
  "canonical_definition" TEXT NOT NULL,
  "aliases" JSONB NOT NULL DEFAULT '[]',
  "facet" VARCHAR(64),
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "sort_order" INTEGER NOT NULL,
  "taxonomy_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "canonical_tag_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_tag_stable_id_check" CHECK ("stable_id" ~ '^ct-v1-[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "canonical_tag_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "canonical_tag_definition_check" CHECK (btrim("canonical_definition") <> ''),
  CONSTRAINT "canonical_tag_aliases_shape_check" CHECK (jsonb_typeof("aliases") = 'array'),
  CONSTRAINT "canonical_tag_facet_check" CHECK ("facet" IS NULL OR btrim("facet") <> ''),
  CONSTRAINT "canonical_tag_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "canonical_tag_sort_order_check" CHECK ("sort_order" >= 0),
  CONSTRAINT "canonical_tag_taxonomy_version_check" CHECK (btrim("taxonomy_version") <> '')
);

CREATE UNIQUE INDEX "canonical_tag_stable_id_key" ON "canonical_tag"("stable_id");
CREATE UNIQUE INDEX "canonical_tag_slug_key" ON "canonical_tag"("slug");
CREATE INDEX "canonical_tag_status_sort_idx" ON "canonical_tag"("status", "sort_order", "stable_id");

CREATE TABLE "canonical_tag_translation" (
  "id" UUID NOT NULL,
  "canonical_tag_id" UUID NOT NULL,
  "locale" VARCHAR(16) NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "canonical_tag_translation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_tag_translation_locale_check" CHECK (btrim("locale") <> ''),
  CONSTRAINT "canonical_tag_translation_display_name_check" CHECK (btrim("display_name") <> '')
);

CREATE UNIQUE INDEX "canonical_tag_translation_locale_key" ON "canonical_tag_translation"("canonical_tag_id", "locale");
CREATE INDEX "canonical_tag_translation_locale_name_idx" ON "canonical_tag_translation"("locale", "display_name");

CREATE TABLE "canonical_tag_keyword" (
  "id" UUID NOT NULL,
  "keyword_id" VARCHAR(200) NOT NULL,
  "canonical_tag_id" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "script_buckets" JSONB NOT NULL DEFAULT '[]',
  "match_mode" VARCHAR(32) NOT NULL,
  "risk_flags" JSONB NOT NULL DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lexicon_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "canonical_tag_keyword_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_tag_keyword_id_check" CHECK (btrim("keyword_id") <> ''),
  CONSTRAINT "canonical_tag_keyword_value_check" CHECK (length("value") > 0),
  CONSTRAINT "canonical_tag_keyword_script_buckets_shape_check" CHECK (jsonb_typeof("script_buckets") = 'array'),
  CONSTRAINT "canonical_tag_keyword_match_mode_check" CHECK ("match_mode" IN ('unicode_word', 'cjk_contiguous', 'auto')),
  CONSTRAINT "canonical_tag_keyword_risk_flags_shape_check" CHECK (jsonb_typeof("risk_flags") = 'array'),
  CONSTRAINT "canonical_tag_keyword_lexicon_version_check" CHECK (btrim("lexicon_version") <> '')
);

CREATE UNIQUE INDEX "canonical_tag_keyword_stable_key" ON "canonical_tag_keyword"("keyword_id");
CREATE INDEX "canonical_tag_keyword_tag_active_idx" ON "canonical_tag_keyword"("canonical_tag_id", "active");
CREATE INDEX "canonical_tag_keyword_version_active_idx" ON "canonical_tag_keyword"("lexicon_version", "active");

CREATE TABLE "source_label_mapping" (
  "id" UUID NOT NULL,
  "channel_app_id" UUID NOT NULL,
  "raw_language_scope" TEXT COLLATE "C" NOT NULL,
  "raw_token" TEXT COLLATE "C" NOT NULL,
  "canonical_tag_id" UUID NOT NULL,
  "mapping_version" VARCHAR(96) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "approved_by" UUID NOT NULL,
  "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "source_label_mapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_label_mapping_scope_check" CHECK (length("raw_language_scope") > 0),
  CONSTRAINT "source_label_mapping_token_check" CHECK (length("raw_token") > 0),
  CONSTRAINT "source_label_mapping_version_check" CHECK (btrim("mapping_version") <> '')
);

CREATE UNIQUE INDEX "source_label_mapping_edge_key"
  ON "source_label_mapping"("channel_app_id", "raw_language_scope", "raw_token", "canonical_tag_id");
CREATE INDEX "source_label_mapping_exact_active_idx"
  ON "source_label_mapping"("channel_app_id", "raw_language_scope", "raw_token")
  WHERE "active" IS TRUE;
CREATE INDEX "source_label_mapping_tag_active_idx" ON "source_label_mapping"("canonical_tag_id", "active");

CREATE TABLE "novel_tag_state" (
  "novel_id" UUID NOT NULL,
  "mode" VARCHAR(16) NOT NULL DEFAULT 'automatic',
  "revision" BIGINT NOT NULL DEFAULT 0,
  "current_auto_run_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "novel_tag_state_pkey" PRIMARY KEY ("novel_id"),
  CONSTRAINT "novel_tag_state_mode_check" CHECK ("mode" IN ('automatic', 'manual')),
  CONSTRAINT "novel_tag_state_revision_check" CHECK ("revision" >= 0)
);

CREATE UNIQUE INDEX "novel_tag_state_current_auto_run_key" ON "novel_tag_state"("current_auto_run_id", "novel_id");
CREATE INDEX "novel_tag_state_mode_updated_idx" ON "novel_tag_state"("mode", "updated_at");

CREATE TABLE "tag_classification_run" (
  "id" UUID NOT NULL,
  "novel_id" UUID NOT NULL,
  "method" VARCHAR(32) NOT NULL,
  "taxonomy_version" VARCHAR(64) NOT NULL,
  "taxonomy_sha256" CHAR(64) NOT NULL,
  "keyword_lexicon_version" VARCHAR(64) NOT NULL,
  "keyword_fingerprint" CHAR(64) NOT NULL,
  "classifier_config_version" VARCHAR(64) NOT NULL,
  "classifier_config_fingerprint" CHAR(64) NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "request_id" VARCHAR(160) NOT NULL,
  "task_type" VARCHAR(96),
  "task_id" UUID,
  "result_summary" JSONB NOT NULL DEFAULT '{}',
  "result_schema_version" INTEGER NOT NULL DEFAULT 1,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tag_classification_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tag_classification_run_method_check" CHECK ("method" IN ('deterministic_text', 'offline_llm')),
  CONSTRAINT "tag_classification_run_taxonomy_version_check" CHECK (btrim("taxonomy_version") <> ''),
  CONSTRAINT "tag_classification_run_taxonomy_sha_check" CHECK ("taxonomy_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tag_classification_run_keyword_version_check" CHECK (btrim("keyword_lexicon_version") <> ''),
  CONSTRAINT "tag_classification_run_keyword_fingerprint_check" CHECK ("keyword_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tag_classification_run_config_version_check" CHECK (btrim("classifier_config_version") <> ''),
  CONSTRAINT "tag_classification_run_config_fingerprint_check" CHECK ("classifier_config_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tag_classification_run_content_sha_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tag_classification_run_request_id_check" CHECK (btrim("request_id") <> ''),
  CONSTRAINT "tag_classification_run_task_metadata_check" CHECK (("task_type" IS NULL AND "task_id" IS NULL) OR ("task_type" IS NOT NULL AND "task_id" IS NOT NULL)),
  CONSTRAINT "tag_classification_run_result_shape_check" CHECK (jsonb_typeof("result_summary") = 'object'),
  CONSTRAINT "tag_classification_run_result_version_check" CHECK ("result_schema_version" = 1)
);

CREATE UNIQUE INDEX "tag_classification_run_novel_request_key" ON "tag_classification_run"("novel_id", "request_id");
CREATE UNIQUE INDEX "tag_classification_run_id_novel_key" ON "tag_classification_run"("id", "novel_id");
CREATE INDEX "tag_classification_run_novel_created_idx" ON "tag_classification_run"("novel_id", "created_at");
CREATE INDEX "tag_classification_run_task_idx" ON "tag_classification_run"("task_type", "task_id");

CREATE TABLE "novel_canonical_tag" (
  "id" UUID NOT NULL,
  "novel_id" UUID NOT NULL,
  "canonical_tag_id" UUID NOT NULL,
  "source" VARCHAR(16) NOT NULL,
  "score" INTEGER,
  "classification_run_id" UUID,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "evidence_schema_version" INTEGER NOT NULL DEFAULT 1,
  "decided_by" UUID,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "novel_canonical_tag_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "novel_canonical_tag_source_check" CHECK ("source" IN ('manual', 'auto')),
  CONSTRAINT "novel_canonical_tag_score_check" CHECK ("score" IS NULL OR "score" >= 0),
  CONSTRAINT "novel_canonical_tag_evidence_shape_check" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "novel_canonical_tag_evidence_version_check" CHECK ("evidence_schema_version" = 1),
  CONSTRAINT "novel_canonical_tag_source_shape_check" CHECK (
    ("source" = 'manual' AND "decided_by" IS NOT NULL AND "classification_run_id" IS NULL AND "score" IS NULL) OR
    ("source" = 'auto' AND "decided_by" IS NULL AND "classification_run_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "novel_canonical_tag_source_key" ON "novel_canonical_tag"("novel_id", "canonical_tag_id", "source");
CREATE INDEX "novel_canonical_tag_novel_source_idx" ON "novel_canonical_tag"("novel_id", "source");
CREATE INDEX "novel_canonical_tag_tag_source_idx" ON "novel_canonical_tag"("canonical_tag_id", "source");
CREATE INDEX "novel_canonical_tag_run_idx" ON "novel_canonical_tag"("classification_run_id");

ALTER TABLE "canonical_tag_translation" ADD CONSTRAINT "canonical_tag_translation_tag_id_fkey"
  FOREIGN KEY ("canonical_tag_id") REFERENCES "canonical_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canonical_tag_keyword" ADD CONSTRAINT "canonical_tag_keyword_tag_id_fkey"
  FOREIGN KEY ("canonical_tag_id") REFERENCES "canonical_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_label_mapping" ADD CONSTRAINT "source_label_mapping_channel_app_id_fkey"
  FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_label_mapping" ADD CONSTRAINT "source_label_mapping_tag_id_fkey"
  FOREIGN KEY ("canonical_tag_id") REFERENCES "canonical_tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_label_mapping" ADD CONSTRAINT "source_label_mapping_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "admin_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_tag_state" ADD CONSTRAINT "novel_tag_state_novel_id_fkey"
  FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tag_classification_run" ADD CONSTRAINT "tag_classification_run_novel_id_fkey"
  FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "novel_canonical_tag" ADD CONSTRAINT "novel_canonical_tag_novel_id_fkey"
  FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "novel_canonical_tag" ADD CONSTRAINT "novel_canonical_tag_tag_id_fkey"
  FOREIGN KEY ("canonical_tag_id") REFERENCES "canonical_tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_canonical_tag" ADD CONSTRAINT "novel_canonical_tag_run_id_fkey"
  FOREIGN KEY ("classification_run_id", "novel_id") REFERENCES "tag_classification_run"("id", "novel_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "novel_canonical_tag" ADD CONSTRAINT "novel_canonical_tag_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "admin_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The state/run cycle is intentional: a run belongs to a Novel and state points
-- at at most one current auto run. Add this FK after both tables exist.
ALTER TABLE "novel_tag_state" ADD CONSTRAINT "novel_tag_state_current_auto_run_id_fkey"
  FOREIGN KEY ("current_auto_run_id", "novel_id") REFERENCES "tag_classification_run"("id", "novel_id") ON DELETE RESTRICT ON UPDATE CASCADE;
