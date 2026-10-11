BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH b AS (SELECT * FROM indexnow_outbox WHERE source='backfill'),
 n AS (SELECT * FROM b WHERE created_at >= '2026-10-10T23:46:49.889795Z'::timestamptz),
 a AS (SELECT at.* FROM indexnow_outbox_attempt at JOIN n ON n.id=at.outbox_id),
 batch AS (SELECT request_batch_id,http_status,outcome,attempt_state,batch_size,count(*) AS urls,
  min(request_at) AS request_at,max(response_at) AS response_at FROM a
  GROUP BY request_batch_id,http_status,outcome,attempt_state,batch_size),
 samples AS (
  (SELECT id,url,locale FROM n WHERE locale='es' ORDER BY random() LIMIT 1)
  UNION ALL (SELECT id,url,locale FROM n WHERE locale='ko' ORDER BY random() LIMIT 1)
  UNION ALL (SELECT id,url,locale FROM n WHERE locale='th' ORDER BY random() LIMIT 1)
 )
SELECT jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'allBackfillStatuses',(SELECT jsonb_agg(t) FROM (SELECT status,count(*) AS urls FROM b GROUP BY status) t),
 'newBackfillStatuses',(SELECT jsonb_agg(t) FROM (SELECT status,count(*) AS urls FROM n GROUP BY status) t),
 'locales',(SELECT jsonb_agg(t) FROM (SELECT locale,count(*) AS all_urls,
    count(*) FILTER (WHERE created_at >= '2026-10-10T23:46:49.889795Z'::timestamptz) AS new_urls FROM b GROUP BY locale ORDER BY locale) t),
 'backfillDuplicateArticles',(SELECT count(*) FROM (SELECT article_id FROM b WHERE article_id IS NOT NULL GROUP BY article_id HAVING count(*)>1) t),
 'allDuplicateArticles',(SELECT count(*) FROM (SELECT article_id FROM indexnow_outbox WHERE article_id IS NOT NULL GROUP BY article_id HAVING count(*)>1) t),
 'invalidDomainUrls',(SELECT count(*) FROM b WHERE url NOT LIKE 'https://pulsenovels.com/%'),
 'cancelledByReason',(SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM (SELECT last_error_kind,count(*) AS urls FROM b WHERE status='cancelled' GROUP BY last_error_kind) t),
 'batches',(SELECT jsonb_agg(t ORDER BY request_at) FROM batch t),
 'httpRequests',(SELECT count(DISTINCT request_batch_id) FROM a),
 'httpDistribution',(SELECT jsonb_agg(t) FROM (SELECT http_status,count(*) AS urls,count(DISTINCT request_batch_id) AS http_requests FROM a GROUP BY http_status) t),
 'tasks',(SELECT jsonb_agg(t) FROM (SELECT id,status,total_count,success_count,failed_count,completed_at FROM generic_task WHERE id IN (SELECT DISTINCT delivery_task_id FROM n)) t),
 'taskItems',(SELECT jsonb_agg(t) FROM (SELECT id,task_id,status,target_type,finished_at FROM generic_task_item WHERE task_id IN (SELECT DISTINCT delivery_task_id FROM n)) t),
 'globalAccepted',(SELECT count(*) FROM indexnow_outbox WHERE status='accepted'),
 'globalRequests',(SELECT count(DISTINCT request_batch_id) FROM indexnow_outbox_attempt),
 'concurrentFirstPublish',(SELECT count(*) FROM indexnow_outbox WHERE source<>'backfill' AND created_at >= '2026-10-10T23:46:49.889795Z'::timestamptz),
 'samples',(SELECT jsonb_agg(t) FROM samples t)
);
COMMIT;
