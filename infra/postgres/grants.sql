\set ON_ERROR_STOP on
-- D-9a (施工工单_D9_up数据库准备原子化与镜像保留_2026-09-09.md 三.3.2②): every
-- caller of this file now wraps the whole thing in one --single-transaction
-- (scripts/x8-production-like.sh:924-925 -- 687-688 in the work order's own
-- baseline commit 0a8f150, before this change's earlier additions to that
-- file pushed the same invocation further down; scripts/db/restore-logical.sh:60,
-- scripts/p1-13-restore-smoke.sh:100), so the REVOKE block below and the
-- GRANT block that follows either land together or roll back together --
-- never REVOKE-committed-but-GRANT-failed. Holding one transaction's worth
-- of catalog locks for the whole file (instead of releasing them statement
-- by statement, as the old no-single-transaction invocation did) is exactly
-- what makes that atomicity possible, but it also means those locks are now
-- held for the file's full duration -- this timeout is what stops that from
-- turning into an indefinite stall against a long-running query elsewhere
-- (worker) instead of failing fast and rolling back cleanly like every other
-- failure mode this file already handles.
SET lock_timeout = '10s';

-- Run in the application database as migration_owner after every migration.
-- No runtime role receives schema ownership or DDL privileges.
DO $database_grants$
BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO migration_owner',
    current_database()
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO web_app, worker_app, scheduler_app, analyst_ro, backup_role',
    current_database()
  );
END
$database_grants$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM web_app, worker_app, scheduler_app, analyst_ro, backup_role;
GRANT USAGE ON SCHEMA public TO web_app, worker_app, scheduler_app, analyst_ro, backup_role;
GRANT USAGE, CREATE ON SCHEMA public TO migration_owner;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM web_app, worker_app, scheduler_app, analyst_ro, backup_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM web_app, worker_app, scheduler_app, analyst_ro, backup_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM web_app, worker_app, scheduler_app, analyst_ro, backup_role;

-- Worker is the only runtime allowed to read every application column.
-- backup_role must read every column and sequence value for a complete dump.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_role;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_role;

-- Tables without restricted columns can be read directly by Web and Analyst.
GRANT SELECT ON TABLE
  channel,
  source_app,
  channel_app,
  channel_capability,
  channel_account,
  novel,
  novel_chapter,
  novel_preview_policy,
  source_label,
  novel_source_item_label,
  tracking_event,
  channel_sync_task,
  channel_sync_task_item,
  generic_task,
  generic_task_item,
  operation_audit,
  indexnow_outbox,
  indexnow_outbox_attempt,
  schedule_run,
  cron_run,
  article_template,
  article,
  home_carousel_manual_slot,
  home_carousel_auto_batch,
  home_carousel_auto_candidate,
  home_carousel_serving,
  home_carousel_change_log,
  canonical_tag,
  canonical_tag_translation,
  canonical_tag_keyword,
  source_label_mapping,
  novel_tag_state,
  novel_canonical_tag,
  tag_classification_run,
  _prisma_migrations
TO web_app, analyst_ro;

-- Web owns Admin authentication persistence; other online roles receive no Auth table access.
GRANT SELECT ON TABLE admin_identity, admin_session, admin_two_factor,
  admin_two_factor_challenge, admin_recovery_code, admin_login_attempt TO web_app;
GRANT INSERT, UPDATE ON TABLE admin_identity, admin_session, admin_two_factor,
  admin_two_factor_challenge, admin_recovery_code, admin_login_attempt TO web_app;
GRANT DELETE ON TABLE admin_recovery_code, admin_login_attempt TO web_app;

-- Credential metadata is visible, ciphertext and complete fingerprints are not.
GRANT SELECT (
  id, channel_account_id, credential_type, key_version, fingerprint_prefix,
  expires_at, last_validated_at, status, created_at, updated_at
) ON channel_account_credential TO web_app, analyst_ro;
GRANT SELECT (
  id, credential_id, channel_account_id, credential_type, created_at
) ON channel_credential_active_fingerprint TO web_app, analyst_ro;
GRANT SELECT (
  id, channel_account_id, credential_id, actor_type, actor_id, action, reason,
  detail, created_at
) ON credential_change_log TO web_app, analyst_ro;

-- Raw upstream payloads and promo codes remain Worker-only. Web receives the
-- two resolved destination columns because both the publish gate and the
-- public /go route must test/resolve them. Analyst never receives them.
GRANT SELECT (
  id, channel_app_id, novel_id, external_book_id, source_language_code,
  source_language_name, source_locale, raw_language_scope, title, description, cover_url,
  total_chapter_count, paid_from_chapter, split_ratio, tto_split_ratio,
  external_agency_id, source_created_at_raw, source_created_at,
  source_updated_at, last_seen_at, status, deleted_at, created_at, updated_at
) ON novel_source_item TO web_app, analyst_ro;
GRANT SELECT (
  id, novel_source_item_id, novel_chapter_id, external_chapter_id,
  source_chapter_number, chapter_name, chapter_show_name, status, last_seen_at,
  source_updated_at, created_at, updated_at
) ON novel_chapter_source_item TO web_app, analyst_ro;
GRANT SELECT (
  id, novel_chapter_id, char_count, content_hash, materialized_at,
  source_fetch_id, created_at, updated_at
) ON novel_chapter_content TO analyst_ro;
GRANT SELECT ON TABLE novel_chapter_content TO web_app;
GRANT SELECT (
  id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
  offer_type, public_redirect_code, idempotency_key, origin, status, expires_at,
  error_kind, error_message, fetched_at, last_attempted_at, deleted_at,
  created_at, updated_at
) ON promo_link TO web_app, analyst_ro;
GRANT SELECT (web_url, app_url) ON promo_link TO web_app;
GRANT SELECT (
  id, effect_key, operation_type, idempotency_key, target_type, target_id,
  task_item_type, task_item_id, channel_account_id, channel_app_id, promo_link_id,
  status, request_summary, response_shape, committed_at, confirmed_at, created_at
) ON side_effect_intent TO web_app, analyst_ro;

-- SiteSetting boundary. Web serves public configuration and owns the guarded
-- admin write service; Worker reads IndexNow/SEO execution config. Analyst
-- deliberately receives no access because the singleton contains the S2
-- IndexNow key. Scheduler is not exempt from that boundary either: PR6 lane E
-- gives it a column-scoped exception limited to the two columns it needs to
-- time the home-carousel cron (`id` is required too, since it appears in the
-- `WHERE id = 1` lookup) -- it still cannot see `indexnow_key` or any other
-- column. Carousel config is owned by the same settings capability.
-- INSERT/DELETE remain migration_owner-only.
GRANT SELECT ON TABLE site_setting TO web_app, worker_app;
GRANT SELECT (id, carousel_config_json) ON site_setting TO scheduler_app;
GRANT UPDATE (
  site_name, site_description, home_meta_title, home_meta_description,
  default_og_image, google_search_console_verification,
  footer_copyright_text, footer_disclaimer_text, friend_links,
  indexnow_host, indexnow_key, indexnow_key_location, ga4_measurement_id,
  carousel_config_json, updated_at
) ON site_setting TO web_app;

-- X9: Web may adjudicate a manual-review intent only through the guarded
-- task-admin service. It cannot change intent identity, request evidence,
-- linkage, or timestamps other than the explicit confirmation time.
GRANT UPDATE (status, response_shape, confirmed_at) ON side_effect_intent TO web_app;

-- Web writes operational metadata and enqueues validate/supersede work. For
-- Owner-approved synchronous add/replace it may insert a new ciphertext and
-- rotate lifecycle metadata, but it still cannot SELECT persisted ciphertext.
GRANT INSERT, UPDATE ON TABLE
  channel, source_app, channel_app, channel_capability, channel_account,
  novel, novel_preview_policy, source_label, novel_source_item_label,
  article_template, article, home_carousel_manual_slot, tracking_event,
  canonical_tag, canonical_tag_translation, canonical_tag_keyword,
  source_label_mapping, novel_tag_state, novel_canonical_tag, tag_classification_run,
  channel_sync_task, channel_sync_task_item, generic_task, generic_task_item, schedule_run,
  cron_run, indexnow_outbox
TO web_app;
-- Content creation links an already-sanitized source row to its new Novel.
-- Keep this column-scoped: Web must not be able to alter raw_payload or any
-- other upstream evidence maintained exclusively by Worker.
GRANT UPDATE (novel_id, status, updated_at) ON novel_source_item TO web_app;
GRANT DELETE ON TABLE canonical_tag_translation, canonical_tag_keyword,
  source_label_mapping, novel_canonical_tag TO web_app;
GRANT INSERT ON TABLE operation_audit TO web_app;
GRANT INSERT (
  id, channel_account_id, credential_type, encrypted_secret, key_version,
  secret_fingerprint, fingerprint_prefix, expires_at, last_validated_at,
  status, created_at, updated_at
) ON channel_account_credential TO web_app;
GRANT UPDATE (status, updated_at) ON channel_account_credential TO web_app;
GRANT INSERT (
  id, fingerprint, credential_id, channel_account_id, credential_type, created_at
) ON channel_credential_active_fingerprint TO web_app;
GRANT DELETE ON TABLE channel_credential_active_fingerprint TO web_app;
GRANT INSERT (
  channel_account_id, credential_id, actor_type, actor_id, action,
  old_fingerprint, new_fingerprint, reason, detail, created_at
) ON credential_change_log TO web_app;

-- Worker can mutate business/task state. Append-only tables are INSERT-only;
-- hard delete is limited to withdrawn chapter content.
GRANT INSERT, UPDATE ON TABLE
  channel, source_app, channel_app, channel_capability, channel_account,
  channel_account_credential, channel_credential_active_fingerprint,
  novel, novel_source_item, novel_chapter, novel_chapter_source_item,
  novel_chapter_content, novel_preview_policy, source_label,
  novel_source_item_label, promo_link, tracking_event, channel_sync_task,
  channel_sync_task_item,
  generic_task, generic_task_item, side_effect_intent, indexnow_outbox,
  schedule_run, cron_run, article_template, article,
  home_carousel_manual_slot, home_carousel_auto_batch,
  home_carousel_auto_candidate, home_carousel_serving,
  canonical_tag, canonical_tag_translation, canonical_tag_keyword,
  source_label_mapping, novel_tag_state, novel_canonical_tag, tag_classification_run
TO worker_app;
GRANT DELETE ON TABLE novel_chapter_content TO worker_app;
GRANT DELETE ON TABLE channel_credential_active_fingerprint TO worker_app;
-- PR6 lane E: computeHomeCarouselInTx (src/server/home-carousel/service.ts)
-- fully replaces the serving snapshot each run with `deleteMany` followed by
-- `createMany` -- there is no fixed row set to UPDATE in place, so DELETE is
-- the only way to express "clear this locale's current serving rows".
GRANT DELETE ON TABLE home_carousel_serving TO worker_app;
GRANT INSERT ON TABLE
  credential_change_log, operation_audit, indexnow_outbox_attempt,
  home_carousel_change_log
TO worker_app;

-- Worker read surface is explicit and excludes every Admin Auth table.
GRANT SELECT ON TABLE channel_account, channel_account_credential,
  channel_credential_active_fingerprint, credential_change_log,
  generic_task, generic_task_item, side_effect_intent, operation_audit TO worker_app;
GRANT SELECT ON TABLE channel, source_app, channel_app, channel_capability,
  novel, novel_source_item, novel_chapter, novel_chapter_source_item,
  novel_chapter_content, novel_preview_policy, source_label,
  novel_source_item_label, channel_sync_task, channel_sync_task_item, promo_link, article,
  canonical_tag, canonical_tag_translation, canonical_tag_keyword,
  source_label_mapping, novel_tag_state, novel_canonical_tag, tag_classification_run TO worker_app;
-- PR6 lane E: computeHomeCarouselInTx reads the manual-slot roster and its
-- own prior batch/candidate/serving rows within the same transaction
-- (findMany/update/deleteMany all evaluate a WHERE clause), which needs
-- SELECT, not just the INSERT/UPDATE granted above.
GRANT SELECT ON TABLE home_carousel_manual_slot, home_carousel_auto_batch,
  home_carousel_auto_candidate, home_carousel_serving TO worker_app;

-- Scheduler only creates scheduling and GenericTask metadata. It never reads Credential/Auth secrets.
GRANT SELECT, INSERT, UPDATE ON TABLE schedule_run, cron_run, generic_task, generic_task_item TO scheduler_app;

-- L10N P5.2: scheduler now resolves the home-carousel cron's active-locale
-- fan-out itself every tick (`queryActiveLocales`, src/lib/locale/
-- active-locales.ts) via a `prisma.article.groupBy` reusing sitemap.ts's
-- `activePublicArticleWhere` collectability filter over Article/Novel/
-- PromoLink -- same "scheduler is not exempt from least privilege" carve-out
-- discipline PR6 lane E already set for `site_setting` above, not a table-
-- wide SELECT. The three column lists below are the exact set the generated
-- SQL references (bookkeeping columns the WHERE/JOIN touch, verified against
-- a live `DEBUG=prisma:query` capture of this exact call, not derived from
-- reading the Prisma schema alone) -- never `article.body`/`novel.title`/
-- `promo_link.upstream_code` or any other content/business column, and never
-- a write.
GRANT SELECT (locale, deleted_at, status, novel_id, promo_link_id) ON article TO scheduler_app;
GRANT SELECT (id, deleted_at, status) ON novel TO scheduler_app;
GRANT SELECT (id, novel_id, status, deleted_at, web_url, app_url) ON promo_link TO scheduler_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_app, worker_app, scheduler_app;

-- Future objects start closed. P1 grants must be revised explicitly when a
-- migration adds a table or sensitive column.
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
