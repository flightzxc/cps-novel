\set ON_ERROR_STOP on

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
    'GRANT CONNECT ON DATABASE %I TO web_app, worker_app, analyst_ro, backup_role',
    current_database()
  );
END
$database_grants$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM web_app, worker_app, analyst_ro, backup_role;
GRANT USAGE ON SCHEMA public TO web_app, worker_app, analyst_ro, backup_role;
GRANT USAGE, CREATE ON SCHEMA public TO migration_owner;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM web_app, worker_app, analyst_ro, backup_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM web_app, worker_app, analyst_ro, backup_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM web_app, worker_app, analyst_ro, backup_role;

-- Worker is the only runtime allowed to read every application column.
-- backup_role must read every column and sequence value for a complete dump.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO worker_app, backup_role;
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
  catalog_scan_task,
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
  _prisma_migrations
TO web_app, analyst_ro;

-- Web may inspect task request fingerprints; Analyst may not.
GRANT SELECT ON TABLE catalog_scan_task_item TO web_app;
GRANT SELECT (
  id, task_id, page_index, page_range_end, status, attempt_count, execution_token,
  lease_epoch, locked_by, locked_until, heartbeat_at, returned_count, payload,
  result, error, started_at, finished_at, created_at, updated_at
) ON catalog_scan_task_item TO analyst_ro;

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

-- Raw upstream payloads and real destination URLs remain Worker-only.
GRANT SELECT (
  id, channel_app_id, novel_id, external_book_id, source_language_code,
  source_language_name, source_locale, title, description, cover_url,
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
GRANT SELECT (
  id, effect_key, operation_type, idempotency_key, target_type, target_id,
  task_item_type, task_item_id, channel_account_id, channel_app_id, promo_link_id,
  status, request_summary, response_shape, committed_at, confirmed_at, created_at
) ON side_effect_intent TO web_app, analyst_ro;

-- Web writes operational metadata and enqueues work, but never writes credentials.
GRANT INSERT, UPDATE ON TABLE
  channel, source_app, channel_app, channel_capability, channel_account,
  novel, novel_preview_policy, source_label, novel_source_item_label,
  article_template, article, home_carousel_manual_slot, tracking_event,
  catalog_scan_task, catalog_scan_task_item, channel_sync_task,
  channel_sync_task_item, generic_task, generic_task_item, schedule_run,
  cron_run, indexnow_outbox
TO web_app;
GRANT INSERT ON TABLE operation_audit TO web_app;

-- Worker can mutate business/task state. Append-only tables are INSERT-only;
-- hard delete is limited to withdrawn chapter content.
GRANT INSERT, UPDATE ON TABLE
  channel, source_app, channel_app, channel_capability, channel_account,
  channel_account_credential, channel_credential_active_fingerprint,
  novel, novel_source_item, novel_chapter, novel_chapter_source_item,
  novel_chapter_content, novel_preview_policy, source_label,
  novel_source_item_label, promo_link, tracking_event, catalog_scan_task,
  catalog_scan_task_item, channel_sync_task, channel_sync_task_item,
  generic_task, generic_task_item, side_effect_intent, indexnow_outbox,
  schedule_run, cron_run, article_template, article,
  home_carousel_manual_slot, home_carousel_auto_batch,
  home_carousel_auto_candidate, home_carousel_serving
TO worker_app;
GRANT DELETE ON TABLE novel_chapter_content TO worker_app;
GRANT INSERT ON TABLE
  credential_change_log, operation_audit, indexnow_outbox_attempt,
  home_carousel_change_log
TO worker_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_app, worker_app;

-- Future objects start closed. P1 grants must be revised explicitly when a
-- migration adds a table or sensitive column.
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
