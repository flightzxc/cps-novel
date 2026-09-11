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
-- Grants-returning follow-up (X8 轮 2c, `fix/grants-returning-select`'s own
-- audit flagged this and deliberately deferred it -- see this file's
-- commit history and database-governance.md's X8 轮 2c changelog row,
-- "追加发现、未在本行修复" item (a)): `home_carousel_change_log` was left
-- out of the INSERT/UPDATE list above on purpose (it is append-only, same
-- shape as `operation_audit` just below -- INSERT only, no UPDATE ever),
-- but it was never granted INSERT for `web_app` at all.
-- `upsertHomeCarouselManualSlot`/`deleteHomeCarouselManualSlot`
-- (src/server/home-carousel/service.ts:212,235, reached only via
-- src/app/(admin)/home-carousel/_actions.ts's
-- saveManualCarouselSlotAction/deleteManualCarouselSlotAction, i.e.
-- web_app) each call `tx.homeCarouselChangeLog.create()` inside the same
-- `$transaction` that writes `home_carousel_manual_slot` -- with zero
-- INSERT grant this fails immediately with `permission denied for table
-- home_carousel_change_log` (confirmed read-only against X8 uat before
-- this fix; the RETURNING mechanism from the `worker_app` fix above is not
-- even reached). `web_app` already has table-level SELECT on this table
-- (see the SELECT list above), so INSERT alone closes the gap.
GRANT INSERT ON TABLE home_carousel_change_log TO web_app;
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

-- C-30 / FEATURE_ARTICLE_NOVEL_REBIND (X8 轮 2c 后续, `fix/grants-returning-
-- select`'s own audit flagged this and deliberately deferred it -- see
-- database-governance.md's X8 轮 2c changelog row, "追加发现、未在本行修复"
-- item (b)): `article_novel_rebind_preview`/`_batch`/`_batch_item` had zero
-- grants of any kind for any role, even though `src/server/article-rebind/
-- {preview,batch}.ts` is fully implemented and already wired into
-- `src/app/(admin)/articles/_actions.ts` -- the feature is held back only
-- by `FEATURE_ARTICLE_NOVEL_REBIND` (fail-closed; see
-- `isArticleNovelRebindEnabled`/`isArticleNovelRebindWriteAllowed`,
-- `src/server/article-rebind/guards.ts`), not by grants. Every call site
-- runs through the shared `web_app` PrismaClient exported by
-- `src/app/api/admin/_lib/deps.ts` (`_actions.ts` imports `prisma` from
-- there and passes it into every rebind function it calls, e.g.
-- `submitRebindBatch(prisma, ...)`) -- there is no worker/scheduler
-- entrypoint anywhere in this feature's call graph (confirmed: no file
-- under `worker/` or `scheduler/` references anything rebind-related).
-- `database-schema-dictionary.jsonl` already records
-- `read_roles:[web_app,analyst_ro]` / `write_roles:[migration_owner,
-- web_app]` for all three tables at both table- and field-level (verified
-- before this change; not modified by it, same "grants.sql trails the
-- dictionary's already-declared intent" shape as the two RETURNING gaps
-- closed above). Per-table privilege set below matches the real call
-- graph, not a blanket INSERT/UPDATE/DELETE for all three:
--   - article_novel_rebind_preview: `buildRebindBatchPreview`'s
--     `.create()` (preview.ts:749) and `cleanupExpiredRebindPreviews`'s
--     `.deleteMany()` (preview.ts:889, invoked from `submitRebindBatch`,
--     batch.ts:672) -- INSERT + DELETE; no `.update()`/`.upsert()`
--     anywhere on this model.
--   - article_novel_rebind_batch: `submitRebindBatch`'s `.create()`
--     (batch.ts:218) plus seven `.updateMany()` lease/status-transition
--     call sites (batch.ts:275,284,289,302,534,538,547) -- INSERT +
--     UPDATE; no `.delete()`/`.deleteMany()` anywhere on this model.
--   - article_novel_rebind_batch_item: `submitRebindBatch`'s
--     `.createMany()` (batch.ts:237, no RETURNING risk -- see the
--     RETURNING-fix comment above for why createMany/updateMany/deleteMany
--     are exempt) plus four `.updateMany()` claim/fence/terminal call
--     sites (batch.ts:319,351,374,391) -- INSERT + UPDATE; no
--     `.delete()`/`.deleteMany()` anywhere on this model.
-- All three also need SELECT for `web_app`, for two independent reasons:
-- every function above reads via findUnique/findFirst/findMany before or
-- interleaved with its writes (ordinary SELECT, nothing to do with
-- RETURNING), and each table's own `.create()` call additionally carries
-- the implicit RETURNING this file's header comment describes (its
-- `.updateMany()` calls do not -- see that same comment for why -- but the
-- plain reads already require SELECT regardless). `analyst_ro` gets the
-- same SELECT, matching this file's existing web_app+analyst_ro pairing
-- convention for every other web_app-owned business table.
GRANT SELECT ON TABLE article_novel_rebind_preview, article_novel_rebind_batch,
  article_novel_rebind_batch_item
TO web_app, analyst_ro;
GRANT INSERT ON TABLE article_novel_rebind_preview, article_novel_rebind_batch,
  article_novel_rebind_batch_item
TO web_app;
GRANT UPDATE ON TABLE article_novel_rebind_batch, article_novel_rebind_batch_item
TO web_app;
GRANT DELETE ON TABLE article_novel_rebind_preview TO web_app;

-- Novel takedown (Owner-approved 窄范围修复 lane, 2026-09-11):
-- `applyNovelRightsTransition`'s takedown branch (`src/server/publish-gate/
-- service.ts:763-786`), inside the same `$transaction` that flips
-- Novel/Article status, chunks every non-withdrawn `NovelChapter` and per
-- chunk runs `tx.novelChapterContent.deleteMany({ where: { novelChapterId:
-- { in: idChunk } } })` followed by `tx.novelChapter.updateMany({ where: {
-- id: { in: idChunk } }, data: { status: "withdrawn" } })`. The schema's
-- `NovelChapter.updatedAt` carries `@updatedAt`, so that `updateMany`'s
-- UPDATE statement also touches `updated_at`, not just `status`.
-- `web_app` had neither grant: `novel_chapter` only had the table-level
-- SELECT above (no UPDATE at all), and `novel_chapter_content`'s only
-- `web_app` grant anywhere in this file was the SELECT a few lines above
-- (DELETE was `worker_app`-only, see below). `grep -rn
-- "novelChapter\.\(create\|update\|upsert\|delete\)\|novelChapterContent\."
-- src/app/(admin) src/app/api/admin src/server` confirms these are the only
-- writes either table needs from `web_app` -- `deleteMany` then
-- `updateMany({data:{status}})`, nothing else, no `createMany`. Without
-- these two grants, takedown of any published Novel that has chapters fails
-- on the very first chunk with `42501 permission denied`; this is not a
-- RETURNING gap (bulk methods carry no implicit RETURNING -- see this file's
-- and grants-returning.test.ts's header comments) but a missing base
-- UPDATE/DELETE statement privilege, a layer the existing RETURNING guard
-- never covered.
GRANT UPDATE (status, updated_at) ON novel_chapter TO web_app;
GRANT DELETE ON TABLE novel_chapter_content TO web_app;

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
-- Follow-up (Owner-approved 2026-09-11, grants+runPublish micro-fix lane):
-- `replaceAutoTagSnapshotInTransaction`'s `tx.novelCanonicalTag.deleteMany({
-- where: { novelId, source: "auto" } })` (src/server/tagging/service.ts:425),
-- reached only via `worker/handlers/novel-tag-backfill.ts`'s auto-classify
-- handler (i.e. `worker_app`'s shared PrismaClient, never web_app/scheduler_app
-- -- `grep -rn replaceAutoTagSnapshotInTransaction src worker` returns only
-- service.ts's own definition and this one handler's call site), is a bulk
-- `deleteMany` and so carries no implicit RETURNING (see the RETURNING-fix
-- comment above), but PostgreSQL still enforces the base DELETE statement
-- privilege independent of that. `worker_app` already had INSERT/UPDATE and
-- table-level SELECT on `novel_canonical_tag` (see the two blocks below) but
-- had never held DELETE -- this was `tests/backend/database/
-- grants-returning.test.ts`'s registered, Owner-deferred
-- `WORKER_APP_BULK_METHOD_KNOWN_GAPS` entry for
-- `novel_canonical_tag::deleteMany`, now closed by this grant (that
-- registry entry is removed in the same change). `web_app`'s own two
-- `deleteMany` call sites on this table (source: "manual", inside
-- `replaceManualTagSnapshot`/`exitManualTagMode`) are unaffected -- web_app
-- already holds table-level DELETE there (see the DELETE list above).
GRANT DELETE ON TABLE novel_canonical_tag TO worker_app;
-- PR6 lane E: computeHomeCarouselInTx (src/server/home-carousel/service.ts)
-- fully replaces the serving snapshot each run with `deleteMany` followed by
-- `createMany` -- there is no fixed row set to UPDATE in place, so DELETE is
-- the only way to express "clear this locale's current serving rows".
GRANT DELETE ON TABLE home_carousel_serving TO worker_app;
GRANT INSERT ON TABLE
  credential_change_log, operation_audit, indexnow_outbox_attempt,
  home_carousel_change_log
TO worker_app;
-- Follow-up (Owner-approved 2026-09-11, same lane as the DELETE grant just
-- above): `worker/handlers/indexnow-delivery.ts:210`'s
-- `db.indexNowOutboxAttempt.updateMany({ where: { outboxId, attemptNo },
-- data: { attemptState, outcome, responseAt, httpStatus, errorKind,
-- responseSummary } })` is the table's only bulk write call site in the
-- whole repo (`grep -rn "indexNowOutboxAttempt\." worker src` confirms the
-- table's only other call is the `.create()` a few lines above, already
-- INSERT-granted). `worker_app` had INSERT (immediately above) and
-- table-level SELECT (the RETURNING-fix grant further below) but no UPDATE
-- of any kind -- this was `grants-returning.test.ts`'s registered
-- `WORKER_APP_BULK_METHOD_KNOWN_GAPS` entry for
-- `indexnow_outbox_attempt::updateMany`, now closed (that registry entry is
-- removed in the same change). Column-scoped to exactly the six columns
-- this one call site's `data` object sets (verified against the handler
-- source, mapped through `prisma/schema.prisma`'s `@map`s:
-- attemptState->attempt_state, outcome->outcome, responseAt->response_at,
-- httpStatus->http_status, errorKind->error_kind,
-- responseSummary->response_summary) rather than table-level UPDATE --
-- worker_app must not gain write access to `outbox_id`/`attempt_no`
-- (the unique-key pair the `create()` call site's own comment relies on
-- staying immutable) or `started_at`/`request_at`/`batch_size`/
-- `worker_task_id` (set once at `create()` time, never revised).
GRANT UPDATE (
  attempt_state, outcome, response_at, http_status, error_kind, response_summary
) ON indexnow_outbox_attempt TO worker_app;

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

-- RETURNING fix (X8 uat real-transaction repro on `home_carousel_change_log`,
-- plus a full-repo audit of every worker_app INSERT/UPDATE/DELETE grant
-- above that had no matching SELECT): Prisma's `.create()`/`.update()`/
-- `.upsert()`/`.delete()` compile to SQL carrying an implicit
-- `RETURNING <every scalar column>` unless the call site passes its own
-- narrow `select`, and PostgreSQL checks SELECT privilege on every
-- RETURNING column -- not just the columns actually written. A role with
-- INSERT/UPDATE but zero SELECT on the target table therefore cannot
-- execute a bare `.create()`/`.update()` at all: the very first row fails
-- with `permission denied for table ...` and rolls back its whole
-- transaction. `worker_app` already had INSERT (and for four of these six,
-- UPDATE) on the tables below with no SELECT of any kind:
--   - `home_carousel_change_log`: confirmed root cause. `worker/handlers/
--     home-carousel.ts` -> `computeHomeCarouselInTx`'s
--     `homeCarouselChangeLog.create()` (src/server/home-carousel/
--     service.ts) is exactly this failure, reproduced read-only against X8
--     uat before this fix (see database-governance.md's changelog entry).
--   - `indexnow_outbox` / `indexnow_outbox_attempt`: also currently live --
--     `worker/handlers/indexnow-delivery.ts`'s `indexNowOutbox.update()`
--     (four call sites) and `indexNowOutboxAttempt.create()` hit the
--     identical failure on every delivery attempt the worker processes.
--   - `tracking_event` / `schedule_run` / `cron_run` / `article_template`:
--     no worker-side `.create()`/`.update()`/`.upsert()`/`.delete()` call
--     site exists in this codebase today (the only current writers are
--     `web_app` for `tracking_event`/`article_template`, already SELECT-
--     complete there, and `scheduler_app` for `schedule_run`/`cron_run`,
--     already self-granted SELECT+INSERT+UPDATE above) -- but the
--     worker_app INSERT/UPDATE grant already exists for all four, so the
--     identical RETURNING trap is waiting for the first worker code that
--     uses it. Closed the same way rather than left as a live landmine;
--     `tests/backend/database/grants-returning.test.ts` guards all seven
--     (and any future same-shape gap) going forward.
-- Table-level SELECT matches worker_app's existing style for every other
-- table it can read (no column-scoped SELECT is used for worker_app
-- anywhere in this file) -- none of these six tables carries a
-- worker-hidden sensitive column the way credential/side-effect tables do.
GRANT SELECT ON TABLE home_carousel_change_log, indexnow_outbox_attempt,
  tracking_event, indexnow_outbox, schedule_run, cron_run, article_template
TO worker_app;

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
