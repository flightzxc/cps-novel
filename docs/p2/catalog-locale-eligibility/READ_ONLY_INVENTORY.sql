-- Catalog locale eligibility release inventory (read only).
-- Run with psql as an approved analyst/read-only role. Replace the placeholder
-- with the batch.materialize.v1 parent task being investigated.
-- This script returns aggregates and a maximum of 20 pseudonymous slug rows;
-- it never selects raw_payload, title, description, error text, actor ids, or
-- request tokens.

\set ON_ERROR_STOP on
\if :{?batch_task_id}
\else
  \set batch_task_id '00000000-0000-0000-0000-000000000000'
\endif

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

-- 0. Non-secret execution identity. transaction_read_only must be "on".
SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('server_version') AS server_version;

-- 1. Parent inventory. This deliberately follows the worker parser's JSON
-- type contract: absent means legacy v1; only JSON numbers 1/2 are valid.
-- JSON null, strings such as "2", and all other values are classified without
-- printing their raw value.
SELECT CASE
         WHEN NOT (params ? 'enumEligibilityPolicyVersion') THEN 'v1 (legacy missing)'
         WHEN jsonb_typeof(params->'enumEligibilityPolicyVersion') <> 'number' THEN 'invalid type'
         WHEN params->'enumEligibilityPolicyVersion' = '1'::jsonb THEN 'v1'
         WHEN params->'enumEligibilityPolicyVersion' = '2'::jsonb THEN 'v2'
         ELSE 'invalid number'
       END AS eligibility_policy,
       status,
       COALESCE(result->>'enumerationStatus', '[missing]') AS enumeration_status,
       count(*)::bigint AS task_count,
       min(created_at) AS oldest_created_at,
       max(created_at) AS newest_created_at
FROM generic_task
WHERE task_type = 'batch.materialize.v1'
  AND params->>'operation' = 'novel_materialize'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. Non-terminal parent and child inventory used by the cutover/rollback
-- gate. This is aggregate-only; it does not expose task ids or leases.
WITH parents AS (
  SELECT id,
         status,
         CASE
           WHEN NOT (params ? 'enumEligibilityPolicyVersion') THEN 'v1 (legacy missing)'
           WHEN jsonb_typeof(params->'enumEligibilityPolicyVersion') <> 'number' THEN 'invalid type'
           WHEN params->'enumEligibilityPolicyVersion' = '1'::jsonb THEN 'v1'
           WHEN params->'enumEligibilityPolicyVersion' = '2'::jsonb THEN 'v2'
           ELSE 'invalid number'
         END AS policy_version
  FROM generic_task
  WHERE task_type = 'batch.materialize.v1'
    AND params->>'operation' = 'novel_materialize'
), inventory AS (
  SELECT 'parent'::text AS inventory_kind,
         policy_version,
         status,
         count(*)::bigint AS row_count
  FROM parents
  WHERE status IN ('pending', 'processing', 'disabled')
  GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'novel.materialize.v1 child'::text,
         p.policy_version,
         c.status,
         count(*)::bigint
  FROM parents p
  JOIN generic_task c ON c.parent_task_id = p.id
  WHERE c.task_type = 'novel.materialize.v1'
    AND c.status IN ('pending', 'processing', 'disabled')
  GROUP BY 1, 2, 3
)
SELECT * FROM inventory ORDER BY inventory_kind, policy_version, status;

-- 3. Non-terminal parent-enumeration items and child execution items. Lease
-- state is DB-side task evidence only: even zero active leases cannot prove
-- that every old Worker process has exited. locked_by and execution tokens are
-- intentionally not returned.
WITH parents AS (
  SELECT id,
         CASE
           WHEN NOT (params ? 'enumEligibilityPolicyVersion') THEN 'v1 (legacy missing)'
           WHEN jsonb_typeof(params->'enumEligibilityPolicyVersion') <> 'number' THEN 'invalid type'
           WHEN params->'enumEligibilityPolicyVersion' = '1'::jsonb THEN 'v1'
           WHEN params->'enumEligibilityPolicyVersion' = '2'::jsonb THEN 'v2'
           ELSE 'invalid number'
         END AS policy_version
  FROM generic_task
  WHERE task_type = 'batch.materialize.v1'
    AND params->>'operation' = 'novel_materialize'
), inventory AS (
  SELECT 'parent enumeration item'::text AS item_kind,
         p.policy_version,
         i.status,
         CASE
           WHEN i.locked_until IS NULL THEN 'unleased'
           WHEN i.locked_until > transaction_timestamp() THEN 'active lease'
           ELSE 'expired lease'
         END AS lease_state,
         i.updated_at
  FROM parents p
  JOIN generic_task_item i
    ON i.task_id = p.id
   AND i.target_type = 'catalog_filter_snapshot'
  WHERE i.status IN ('pending', 'processing')
  UNION ALL
  SELECT 'novel.materialize.v1 child item'::text,
         p.policy_version,
         i.status,
         CASE
           WHEN i.locked_until IS NULL THEN 'unleased'
           WHEN i.locked_until > transaction_timestamp() THEN 'active lease'
           ELSE 'expired lease'
         END,
         i.updated_at
  FROM parents p
  JOIN generic_task c
    ON c.parent_task_id = p.id
   AND c.task_type = 'novel.materialize.v1'
  JOIN generic_task_item i ON i.task_id = c.id
  WHERE i.status IN ('pending', 'processing')
)
SELECT item_kind,
       policy_version,
       status,
       lease_state,
       count(*)::bigint AS item_count,
       max(updated_at) AS latest_item_update
FROM inventory
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- 4. Reconstruct the selected source set for one parent and bucket language
-- facts. This mirrors the current explicit_ids/all_filtered selection shape.
-- It cannot recreate a historical point-in-time snapshot after sources have
-- changed; interpret the output as current facts only.
WITH target_batch AS (
  SELECT 1
  FROM generic_task
  WHERE id = :'batch_task_id'::uuid
    AND task_type = 'batch.materialize.v1'
    AND params->>'operation' = 'novel_materialize'
)
SELECT (count(*) = 1) AS target_batch_found
FROM target_batch;

WITH target_batch AS (
  SELECT params->'selection' AS selection
  FROM generic_task
  WHERE id = :'batch_task_id'::uuid
    AND task_type = 'batch.materialize.v1'
    AND params->>'operation' = 'novel_materialize'
), selection_input AS (
  SELECT selection,
         selection->>'scope' AS selection_scope,
         selection->'filter'->>'status' AS filter_status,
         NULLIF(btrim(selection->'filter'->>'search'), '') AS search_text,
         selection->'filter'->>'sourceLocale' AS source_locale_filter,
         (selection->'filter' ? 'sourceLocale') AS has_source_locale_filter
  FROM target_batch
), selected AS (
  SELECT n.source_language_code,
         n.source_language_name,
         n.source_locale,
         n.status,
         n.novel_id
  FROM novel_source_item n
  CROSS JOIN selection_input b
  WHERE n.deleted_at IS NULL
    AND (
      (
        b.selection_scope = 'explicit_ids'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(b.selection->'ids', '[]'::jsonb)) AS selected_id(id)
          WHERE selected_id.id = n.id::text
        )
      )
      OR
      (
        b.selection_scope = 'all_filtered'
        AND n.status = b.filter_status
        AND (
          b.search_text IS NULL
          OR n.title ILIKE ('%' || b.search_text || '%')
        )
        AND (
          NOT b.has_source_locale_filter
          OR (
            b.source_locale_filter = '__unknown'
            AND n.source_locale IS NULL
          )
          OR (
            b.source_locale_filter <> '__unknown'
            AND n.source_locale = b.source_locale_filter
          )
        )
      )
    )
)
SELECT source_language_code,
       COALESCE(NULLIF(btrim(source_language_name), ''), '[NULL/BLANK]') AS source_language_name_bucket,
       CASE
         WHEN source_locale IS NULL THEN 'sql_null'
         WHEN btrim(source_locale) = '' THEN 'blank_or_whitespace'
         WHEN source_locale <> btrim(source_locale) THEN 'noncanonical_whitespace'
         ELSE 'exact_value'
       END AS source_locale_kind,
       CASE
         WHEN source_locale IS NULL THEN '[SQL NULL]'
         WHEN btrim(source_locale) = '' THEN '[BLANK/WHITESPACE]'
         WHEN source_locale <> btrim(source_locale) THEN '[NONCANONICAL WHITESPACE]'
         ELSE source_locale
       END AS source_locale_bucket,
       status,
       (novel_id IS NOT NULL) AS has_novel,
       count(*)::bigint AS source_count
FROM selected
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY source_count DESC, 1, 2, 3, 4, 5, 6;

-- 5. Persisted catalog-ingestion fuse evidence. Counts pages on which the
-- worker suspended a language code because of code/name conflicts. It does
-- not prove that any individual current NULL row came from that fuse.
SELECT suspended.code AS source_language_code,
       count(*)::bigint AS catalog_page_count,
       min(i.finished_at) AS first_observed_at,
       max(i.finished_at) AS last_observed_at
FROM generic_task t
JOIN generic_task_item i
  ON i.task_id = t.id
 AND i.target_type = 'catalog_page'
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(i.result->'suspendedLanguageCodes') = 'array'
      THEN i.result->'suspendedLanguageCodes'
    ELSE '[]'::jsonb
  END
) AS suspended(code)
WHERE t.task_type = 'catalog_scan'
GROUP BY suspended.code
ORDER BY catalog_page_count DESC, suspended.code;

-- 6a. Persisted failure-code classes for the selected parent's materialize
-- items. finalize_failed is intentionally distinct: its database row cannot
-- recover whether the original handler error was locale-, slug-, or another
-- failure. "other_redacted" never prints the unknown raw code.
SELECT CASE
         WHEN COALESCE(i.error->>'code', i.error->'detail'->>'code') = 'slug_unhealthy'
           THEN 'direct_slug_unhealthy'
         WHEN i.error->>'code' = 'finalize_failed'
           THEN 'finalize_failed_original_cause_unrecoverable'
         WHEN COALESCE(i.error->>'code', i.error->'detail'->>'code') IS NULL
           THEN 'missing_persisted_code'
         ELSE 'other_redacted'
       END AS persisted_failure_class,
       count(*)::bigint AS failed_item_count
FROM generic_task c
JOIN generic_task_item i
  ON i.task_id = c.id
 AND i.target_type = 'novel_source_item'
WHERE c.parent_task_id = :'batch_task_id'::uuid
  AND c.task_type = 'novel.materialize.v1'
  AND i.status = 'failed'
GROUP BY 1
ORDER BY 1;

-- 6b. Limited, pseudonymous metadata for directly persisted slug_unhealthy
-- items. No title or source UUID is returned. Zero rows here does not prove
-- zero slug failures because finalize_failed loses the original cause in DB.
SELECT left(md5(n.id::text), 12) AS source_pseudonym,
       char_length(n.title) AS title_character_count,
       octet_length(n.title) AS title_byte_count,
       (btrim(n.title) = '') AS title_blank_after_trim,
       (n.title ~ '[A-Za-z0-9]') AS contains_ascii_alphanumeric
FROM generic_task c
JOIN generic_task_item i
  ON i.task_id = c.id
 AND i.target_type = 'novel_source_item'
JOIN novel_source_item n ON n.id::text = i.target_id
WHERE c.parent_task_id = :'batch_task_id'::uuid
  AND c.task_type = 'novel.materialize.v1'
  AND i.status = 'failed'
  AND COALESCE(i.error->>'code', i.error->'detail'->>'code') = 'slug_unhealthy'
ORDER BY source_pseudonym
LIMIT 20;

ROLLBACK;
