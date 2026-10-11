BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'inflight',(SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM
  (SELECT task_type,status,count(*) FROM generic_task
   WHERE (task_type LIKE 'article.publish.%' OR task_type LIKE 'article.generate.%')
    AND status IN ('pending','processing') GROUP BY task_type,status) t),
 'accepted',(SELECT count(*) FROM indexnow_outbox WHERE status='accepted'),
 'httpRequests',(SELECT count(DISTINCT request_batch_id) FROM indexnow_outbox_attempt),
 'backfillRows',(SELECT count(*) FROM indexnow_outbox WHERE source='backfill')
);
COMMIT;
