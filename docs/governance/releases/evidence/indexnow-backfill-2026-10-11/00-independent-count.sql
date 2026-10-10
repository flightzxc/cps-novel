BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'inflight', (SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM
  (SELECT task_type,status,count(*) FROM generic_task
   WHERE (task_type LIKE 'article.publish.%' OR task_type LIKE 'article.generate.%')
     AND status IN ('pending','processing') GROUP BY task_type,status) t),
 'counts', (SELECT jsonb_agg(t) FROM
  (SELECT article_type,COALESCE(locale,'ALL') AS locale,count(*) AS published,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM indexnow_outbox o WHERE o.article_id=a.id)) AS already_outbox,
    count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM indexnow_outbox o WHERE o.article_id=a.id)) AS independent_n
   FROM article a WHERE status='published' AND deleted_at IS NULL
   GROUP BY GROUPING SETS ((article_type,locale),(article_type)) ORDER BY article_type,locale) t)
);
COMMIT;
