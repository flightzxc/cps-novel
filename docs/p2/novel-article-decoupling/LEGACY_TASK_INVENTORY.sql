-- 旧耦合任务盘点（只读）。待现场核验，本轮不执行生产处置。
-- 在生产只读副本或经批准的分析连接上运行。

-- 1) 仍存活的旧叶任务
SELECT id, task_type, status, total_count, success_count, failed_count, skipped_count,
       locked_until, lease_epoch, created_at, updated_at
FROM generic_task
WHERE task_type = 'content.create.v1'
  AND status IN ('pending', 'processing', 'disabled')
ORDER BY created_at;

-- 2) 仍存活的旧父任务
SELECT id, task_type, status, params->>'operation' AS operation,
       result->>'enumerationStatus' AS enumeration_status,
       created_at, updated_at
FROM generic_task
WHERE task_type = 'batch.materialize.v1'
  AND params->>'operation' = 'content_create'
  AND status IN ('pending', 'processing', 'disabled')
ORDER BY created_at;

-- 3) 旧叶任务的 lease / 重试面
SELECT i.id, i.task_id, i.status, i.attempt_count, i.locked_until, i.lease_epoch, t.status AS task_status
FROM generic_task_item i
JOIN generic_task t ON t.id = i.task_id
WHERE t.task_type = 'content.create.v1'
  AND i.status IN ('pending', 'processing')
ORDER BY i.updated_at;

-- 4) 新协议是否已有库存（切换后对照）
SELECT task_type, status, count(*)
FROM generic_task
WHERE task_type IN (
  'content.create.v1',
  'novel.materialize.v1',
  'article.generate.v1',
  'batch.materialize.v1'
)
GROUP BY 1, 2
ORDER BY 1, 2;
