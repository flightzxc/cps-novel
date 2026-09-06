# Launch-day health checks

These checks are read-only evidence queries for the first production window.
Run them with `analyst_ro` (or another explicitly read-only role), never with
the migration owner. They do not repair, retry, resolve, or otherwise mutate
state. Start a read-only transaction if the SQL client does not already enforce
one:

```sql
BEGIN TRANSACTION READ ONLY;
```

## 1. Task and item status distribution

This is the broad queue/parent overview. A growing `pending` or `processing`
count is a prompt to inspect the later queries, not permission to mutate rows.

Phase C (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`) folded
`catalog_scan_task`/`catalog_scan_task_item` into `generic_task`/
`generic_task_item` (`task_type = 'catalog_scan'`); the queries below now
have two family branches instead of three.

```sql
WITH states AS (
  SELECT 'channel_sync'::text AS family, 'task'::text AS level, status FROM channel_sync_task
  UNION ALL
  SELECT 'channel_sync', 'item', status FROM channel_sync_task_item
  UNION ALL
  SELECT 'generic', 'task', status FROM generic_task
  UNION ALL
  SELECT 'generic', 'item', status FROM generic_task_item
)
SELECT family, level, status, count(*) AS row_count
FROM states
GROUP BY family, level, status
ORDER BY family, level, status;
```

## 2. Expired processing locks

Any result means a lease is eligible for normal Worker recovery. Do not update
the item manually; verify that recovery is advancing and that terminal
recoveries create `task_item.failed / stale_processing` audit facts.

```sql
WITH expired AS (
  SELECT 'channel_sync'::text AS family, t.task_type, i.locked_until
  FROM channel_sync_task_item i
  JOIN channel_sync_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  UNION ALL
  SELECT 'generic', t.task_type, i.locked_until
  FROM generic_task_item i
  JOIN generic_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
)
SELECT family, task_type, count(*) AS expired_count,
       min(locked_until) AS oldest_expiry,
       max(transaction_timestamp() - locked_until) AS maximum_overdue
FROM expired
GROUP BY family, task_type
ORDER BY maximum_overdue DESC, family, task_type;
```

## 3. Side-effect intents awaiting manual review

This is an aggregate only: it intentionally omits idempotency keys, request
summaries, response shapes, URLs, and upstream evidence.

```sql
SELECT operation_type, target_type, count(*) AS waiting_count,
       min(created_at) AS oldest_created_at,
       max(transaction_timestamp() - created_at) AS maximum_age
FROM side_effect_intent
WHERE status = 'manual_review_required'
GROUP BY operation_type, target_type
ORDER BY maximum_age DESC, operation_type, target_type;
```

## 4. PromoLink rows pending for more than 15 minutes

This query surfaces likely stalled local state without selecting upstream codes,
redirect codes, real URLs, raw links, or error messages.

```sql
SELECT origin, offer_type, coalesce(error_kind, '(none)') AS error_kind,
       count(*) AS stalled_count,
       min(updated_at) AS oldest_updated_at,
       max(transaction_timestamp() - updated_at) AS maximum_age
FROM promo_link
WHERE status = 'pending'
  AND deleted_at IS NULL
  AND updated_at < transaction_timestamp() - interval '15 minutes'
GROUP BY origin, offer_type, coalesce(error_kind, '(none)')
ORDER BY maximum_age DESC, origin, offer_type, error_kind;
```

## 5. Durable task failure audits from the last 24 hours

`worker_terminal_failure` is a handler-finalized failure;
`stale_processing` is a terminal expired-lease recovery. OperationAudit is the
durable fact source; webhook delivery is best-effort and process-local cooldown
state is not evidence.

```sql
SELECT entity_type, task_type, reason, count(*) AS failure_count,
       min(created_at) AS first_seen_at,
       max(created_at) AS last_seen_at
FROM operation_audit
WHERE action = 'task_item.failed'
  AND created_at >= transaction_timestamp() - interval '24 hours'
GROUP BY entity_type, task_type, reason
ORDER BY last_seen_at DESC, entity_type, task_type, reason;
```

Finish the evidence session explicitly:

```sql
COMMIT;
```
