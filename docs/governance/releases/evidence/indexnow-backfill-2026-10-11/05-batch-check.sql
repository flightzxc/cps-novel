BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH b AS (SELECT * FROM indexnow_outbox WHERE source='backfill'),
 batches AS (
  SELECT a.request_batch_id,a.http_status,a.outcome,a.attempt_state,a.batch_size,
    count(*) AS urls,min(a.request_at) AS request_at_utc,max(a.response_at) AS response_at_utc,
    max(a.response_at) AT TIME ZONE 'Asia/Tokyo' AS response_at_jst
  FROM indexnow_outbox_attempt a JOIN b ON b.id=a.outbox_id
  GROUP BY a.request_batch_id,a.http_status,a.outcome,a.attempt_state,a.batch_size
 ),
 special AS (SELECT id,url,locale FROM b WHERE locale IN ('ar','zh-Hant') ORDER BY random() LIMIT 1),
 others AS (SELECT id,url,locale FROM b WHERE id NOT IN (SELECT id FROM special) ORDER BY random() LIMIT 2),
 sample AS (SELECT * FROM special UNION ALL SELECT * FROM others)
SELECT jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'batchRows',(SELECT count(*) FROM b),
 'acceptedRows',(SELECT count(*) FROM b WHERE status='accepted'),
 'cancelledRows',(SELECT count(*) FROM b WHERE status='cancelled'),
 'batches',(SELECT jsonb_agg(t) FROM batches t),
 'locales',(SELECT jsonb_agg(t) FROM (SELECT locale,count(*) AS urls FROM b GROUP BY locale ORDER BY locale) t),
 'tasks',(SELECT jsonb_agg(t) FROM (SELECT id,task_type,status,total_count,success_count,failed_count,completed_at
    FROM generic_task WHERE id IN (SELECT DISTINCT delivery_task_id FROM b)) t),
 'items',(SELECT jsonb_agg(t) FROM (SELECT id,task_id,target_type,status,started_at,finished_at
    FROM generic_task_item WHERE task_id IN (SELECT DISTINCT delivery_task_id FROM b)) t),
 'samples',(SELECT jsonb_agg(t) FROM sample t),
 'globalAccepted',(SELECT count(*) FROM indexnow_outbox WHERE status='accepted'),
 'globalHttpRequests',(SELECT count(DISTINCT request_batch_id) FROM indexnow_outbox_attempt),
 'globalDeadLetters',(SELECT count(*) FROM indexnow_outbox WHERE status='dead_letter'),
 'globalInvalidCancelled',(SELECT count(*) FROM indexnow_outbox WHERE status='cancelled' AND last_error_kind IN ('url_invalid','url_host_mismatch'))
);
COMMIT;
