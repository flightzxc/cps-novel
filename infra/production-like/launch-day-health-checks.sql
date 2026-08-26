\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo 'X8_HEALTH_SQL_GROUP_1_TASK_DISTRIBUTION'
WITH states AS (
  SELECT 'catalog_scan'::text AS family, 'task'::text AS level, status FROM catalog_scan_task
  UNION ALL SELECT 'catalog_scan', 'item', status FROM catalog_scan_task_item
  UNION ALL SELECT 'channel_sync', 'task', status FROM channel_sync_task
  UNION ALL SELECT 'channel_sync', 'item', status FROM channel_sync_task_item
  UNION ALL SELECT 'generic', 'task', status FROM generic_task
  UNION ALL SELECT 'generic', 'item', status FROM generic_task_item
)
SELECT family, level, status, count(*) AS row_count
FROM states GROUP BY family, level, status ORDER BY family, level, status;

\echo 'X8_HEALTH_SQL_GROUP_2_EXPIRED_LOCKS'
WITH expired AS (
  SELECT 'catalog_scan'::text AS family, 'catalog_scan'::text AS task_type, i.locked_until
  FROM catalog_scan_task_item i
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  UNION ALL
  SELECT 'channel_sync', t.task_type, i.locked_until
  FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  UNION ALL
  SELECT 'generic', t.task_type, i.locked_until
  FROM generic_task_item i JOIN generic_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
)
SELECT family, task_type, count(*) AS expired_count, min(locked_until) AS oldest_expiry,
       max(transaction_timestamp() - locked_until) AS maximum_overdue
FROM expired GROUP BY family, task_type ORDER BY maximum_overdue DESC, family, task_type;

\echo 'X8_HEALTH_SQL_GROUP_3_MANUAL_REVIEW'
SELECT operation_type, target_type, count(*) AS waiting_count,
       min(created_at) AS oldest_created_at,
       max(transaction_timestamp() - created_at) AS maximum_age
FROM side_effect_intent WHERE status = 'manual_review_required'
GROUP BY operation_type, target_type ORDER BY maximum_age DESC, operation_type, target_type;

\echo 'X8_HEALTH_SQL_GROUP_4_STALLED_PROMO'
SELECT origin, offer_type, coalesce(error_kind, '(none)') AS error_kind,
       count(*) AS stalled_count, min(updated_at) AS oldest_updated_at,
       max(transaction_timestamp() - updated_at) AS maximum_age
FROM promo_link
WHERE status = 'pending' AND deleted_at IS NULL
  AND updated_at < transaction_timestamp() - interval '15 minutes'
GROUP BY origin, offer_type, coalesce(error_kind, '(none)')
ORDER BY maximum_age DESC, origin, offer_type, error_kind;

\echo 'X8_HEALTH_SQL_GROUP_5_DURABLE_FAILURES'
SELECT entity_type, task_type, reason, count(*) AS failure_count,
       min(created_at) AS first_seen_at, max(created_at) AS last_seen_at
FROM operation_audit
WHERE action = 'task_item.failed'
  AND created_at >= transaction_timestamp() - interval '24 hours'
GROUP BY entity_type, task_type, reason
ORDER BY last_seen_at DESC, entity_type, task_type, reason;

COMMIT;
