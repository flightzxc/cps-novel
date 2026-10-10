BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT json_build_object('section','task','readAt',clock_timestamp(),'id',id,'status',status,'totalCount',total_count,'successCount',success_count,'failedCount',failed_count,'skippedCount',skipped_count,'startedAt',started_at,'completedAt',completed_at) FROM channel_sync_task WHERE id='943f0f7f-1196-4792-b28f-2ea53bcdf7d1';
SELECT json_build_object('section','itemStatusCounts','counts',json_agg(row_to_json(q))) FROM (SELECT status,count(*) AS count FROM channel_sync_task_item WHERE task_id='943f0f7f-1196-4792-b28f-2ea53bcdf7d1' GROUP BY status ORDER BY status) q;
SELECT json_build_object('section','failureGroups','groups',json_agg(row_to_json(q))) FROM (SELECT error#>>'{detail,kind}' AS kind,error#>>'{detail,stage}' AS stage,error#>>'{detail,receivedType}' AS "receivedType",error#>>'{detail,chapterIndex}' AS "chapterIndex",count(*) AS count FROM channel_sync_task_item WHERE task_id='943f0f7f-1196-4792-b28f-2ea53bcdf7d1' AND status='failed' GROUP BY 1,2,3,4 ORDER BY 1,2,3,4) q;
COMMIT;
