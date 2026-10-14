TASK="932851c3-1205-4fde-88f3-0e78355540d9"
query="""
WITH RECURSIVE tree AS (
 SELECT * FROM generic_task WHERE id='932851c3-1205-4fde-88f3-0e78355540d9'::uuid
 UNION ALL SELECT t.* FROM generic_task t JOIN tree p ON t.parent_task_id=p.id
), claim_items AS (
 SELECT i.* FROM generic_task_item i JOIN tree t ON t.id=i.task_id WHERE t.task_type='promo_link.claim.v1'
), targets AS (SELECT DISTINCT target_id FROM claim_items WHERE target_type='novel_source_item')
SELECT json_build_object(
 'readAt',clock_timestamp(),
 'tasks',(SELECT json_agg(json_build_object('id',id,'parentId',parent_task_id,'type',task_type,'status',status,'total',total_count,'success',success_count,'failed',failed_count,'skipped',skipped_count,'appId',channel_app_id,'accountId',channel_account_id,'operation',params->>'operation','selectionScope',params->'selection'->>'scope','selectedCount',jsonb_array_length(params->'selection'->'ids'),'lifecycleRole',params->>'lifecycleRole','createdAt',created_at,'startedAt',started_at,'completedAt',completed_at) ORDER BY created_at,id) FROM tree),
 'items',(SELECT json_agg(json_build_object('id',i.id,'taskId',i.task_id,'sourceId',i.target_id,'targetType',i.target_type,'status',i.status,'attempts',i.attempt_count,'errorPresent',i.error IS NOT NULL AND i.error<>'{}'::jsonb,'errorCodeSha256',CASE WHEN i.error->>'code' IS NOT NULL THEN encode(sha256(convert_to(i.error->>'code','UTF8')),'hex') END,'finishedAt',i.finished_at,'appId',s.channel_app_id,'agencyId',s.external_agency_id,'locale',s.source_locale,'sourceStatus',s.status,'novelLinked',s.novel_id IS NOT NULL,'deleted',s.deleted_at IS NOT NULL) ORDER BY i.target_id) FROM claim_items i LEFT JOIN novel_source_item s ON s.id::text=i.target_id),
 'canaryPromos',(SELECT json_agg(json_build_object('sourceId',p.novel_source_item_id,'status',p.status,'accountId',p.channel_account_id,'appId',p.channel_app_id,'codePresent',p.upstream_code_present,'deleted',p.deleted_at IS NOT NULL) ORDER BY p.novel_source_item_id) FROM promo_link p JOIN targets t ON t.target_id=p.novel_source_item_id::text),
 'canaryIntents',(SELECT json_agg(json_build_object('sourceId',i.request_summary->>'novelSourceItemId','status',i.status,'operation',i.operation_type,'accountId',i.channel_account_id,'appId',i.channel_app_id,'createdAt',i.created_at) ORDER BY i.created_at) FROM side_effect_intent i JOIN targets t ON t.target_id=i.request_summary->>'novelSourceItemId'),
 'manualReviewTotal',(SELECT count(*) FROM side_effect_intent WHERE channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND status='manual_review_required'),
 'manualReviewNew',(SELECT count(*) FROM side_effect_intent WHERE channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND status='manual_review_required' AND created_at>'2026-10-14T12:09:41.203312Z'),
 'moboAccounts',(SELECT json_agg(json_build_object('accountId',channel_account_id,'promos',n)) FROM (SELECT channel_account_id,count(*) n FROM promo_link WHERE channel_app_id='85c2fb3e-28f8-476a-83f2-9647e2206192' AND deleted_at IS NULL GROUP BY channel_account_id) a)
);
"""
raw=sql(query)
x=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
print('CANARY_INSPECT='+json.dumps(x),flush=True)
print('CANARY_INSPECT_READONLY=PASS',flush=True)
