q="""
WITH hist AS (SELECT i.id intent_id,i.channel_account_id account_id,i.request_summary->>'novelSourceItemId' source_id,i.created_at,row_number() OVER(ORDER BY i.created_at,i.id) rn,count(*) OVER() n FROM side_effect_intent i WHERE i.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND i.status='manual_review_required' AND i.created_at<'2026-10-14T12:09:41.203312Z' AND i.response_shape='{"readbackStatus":"promo_missing","failureCategory":"malformed_payload","readbackConfirmed":false}'::jsonb),samples AS (
SELECT 'historical_manual' cohort,intent_id,account_id,source_id,created_at,rn,n FROM hist WHERE rn IN (SELECT 1+round(g*(608-1)::numeric/9)::bigint FROM generate_series(0,9) g)
UNION ALL
SELECT CASE WHEN ti.result->>'decision'='claimed' THEN 'new_confirmed' ELSE 'new_manual' END cohort,i.id,i.channel_account_id,ti.target_id,i.created_at,NULL::bigint,NULL::bigint FROM generic_task_item ti JOIN generic_task t ON t.id=ti.task_id JOIN side_effect_intent i ON i.request_summary->>'novelSourceItemId'=ti.target_id AND i.channel_app_id=t.channel_app_id AND i.created_at>='2026-10-14T13:38:49Z' WHERE t.parent_task_id='932851c3-1205-4fde-88f3-0e78355540d9' AND t.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND ti.result->>'decision' IN ('claimed','manual_review_required')
)
SELECT json_build_object('at',clock_timestamp(),'historicalPopulation',(SELECT max(n) FROM hist),'sampleMethod','created_at,id sorted chronological rank endpoints plus nine equal intervals rounded; 1+round(g*607/9), g=0..9','samples',(SELECT json_agg(json_build_object('cohort',cohort,'intentId',intent_id,'accountId',account_id,'sourceId',source_id,'intentCreatedAt',created_at,'historicalRank',rn) ORDER BY CASE cohort WHEN 'new_manual' THEN 0 WHEN 'new_confirmed' THEN 1 ELSE 2 END,created_at,intent_id) FROM samples),'claimCapability',(SELECT status FROM channel_capability WHERE channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND capability_key='claimPromo'));
"""
raw=sql(q);x=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
from collections import Counter
assert x['historicalPopulation']==608 and x['claimCapability']=='registered_disabled'
assert Counter(v['cohort'] for v in x['samples'])=={'new_manual':26,'new_confirmed':7,'historical_manual':10}
assert len({v['sourceId'] for v in x['samples']})==43
assert {v['accountId'] for v in x['samples']}=={'53f03fd8-951d-433e-ac66-784e82496a84'}
print('READBACK_SAMPLE_PLAN='+json.dumps(x),flush=True)
print('SAMPLE_PLAN_READONLY=PASS',flush=True)
