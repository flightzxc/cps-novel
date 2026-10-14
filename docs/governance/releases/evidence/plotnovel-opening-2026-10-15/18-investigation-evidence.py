q="""
WITH targets AS (SELECT ti.id item_id,ti.target_id source_id,t.channel_app_id app_id,ti.status,ti.result FROM generic_task_item ti JOIN generic_task t ON t.id=ti.task_id WHERE t.parent_task_id='932851c3-1205-4fde-88f3-0e78355540d9'),batch_intents AS (SELECT i.* FROM side_effect_intent i JOIN targets t ON t.source_id=i.request_summary->>'novelSourceItemId' AND t.app_id=i.channel_app_id WHERE i.created_at>='2026-10-14T13:38:49Z')
SELECT json_build_object('at',clock_timestamp(),'taskDecisionGroups',(SELECT json_agg(x) FROM (SELECT app_id,CASE WHEN result->>'decision' IN ('claimed','already_available','readback_recovered','manual_review_required','skipped_claimed') THEN result->>'decision' ELSE 'other_or_unavailable' END decision,status,count(*) n FROM targets GROUP BY app_id,decision,status) x),'confirmedGroups',(SELECT json_agg(x) FROM (SELECT channel_app_id,response_shape->>'confirmedFrom' confirmed_from,response_shape->'hasWebUrl' has_web_url,response_shape->'hasAppUrl' has_app_url,count(*) n FROM batch_intents WHERE status='confirmed' GROUP BY channel_app_id,response_shape->>'confirmedFrom',response_shape->'hasWebUrl',response_shape->'hasAppUrl') x),'manualPromoGroups',(SELECT json_agg(x) FROM (SELECT p.status,p.upstream_code_present,count(DISTINCT i.id) n FROM side_effect_intent i JOIN promo_link p ON p.novel_source_item_id::text=i.request_summary->>'novelSourceItemId' AND p.channel_app_id=i.channel_app_id AND p.channel_account_id=i.channel_account_id AND p.idempotency_key=i.target_id WHERE i.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND i.status='manual_review_required' GROUP BY p.status,p.upstream_code_present) x),'rawPromoKeysRetained',(SELECT json_agg(x) FROM (SELECT app_id,jsonb_typeof(s.raw_payload->'kocCode') koc_code_type,jsonb_typeof(s.raw_payload->'publicUrl') public_url_type,jsonb_typeof(s.raw_payload->'homeLink') home_link_type,count(*) n FROM targets t JOIN novel_source_item s ON s.id::text=t.source_id GROUP BY app_id,jsonb_typeof(s.raw_payload->'kocCode'),jsonb_typeof(s.raw_payload->'publicUrl'),jsonb_typeof(s.raw_payload->'homeLink')) x));
"""
raw=sql(q);print('INVESTIGATION_DB_CORRECTED='+json.dumps(json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]),flush=True)
wi=json.loads(run(['docker','inspect',NAMES['worker']]).stdout)[0]
wenv=dict(x.split('=',1) for x in wi['Config']['Env'])
policy={k:int(wenv[k]) if k in wenv else None for k in ['PROMO_LINK_CLAIM_READBACK_ATTEMPTS','PROMO_LINK_CLAIM_READBACK_INTERVAL_MS']}
print('READBACK_POLICY_ENV='+json.dumps(policy),flush=True)
from collections import Counter
all_summaries=[]
for service in ['worker','worker-light']:
 r=subprocess.run(['docker','logs','--timestamps','--since','2026-10-14T13:38:49Z','--until','2026-10-14T13:48:01Z',NAMES[service]],stdin=subprocess.DEVNULL,text=True,capture_output=True)
 assert r.returncode==0
 buckets={k:Counter() for k in ['moboreader_window','plotnovel_window']};events=[];json_count=0;not_json=0
 for line in (r.stdout+'\n'+r.stderr).splitlines():
  ts,sep,body=line.partition(' ')
  if not sep:continue
  try:x=json.loads(body)
  except (ValueError,TypeError):not_json+=1;continue
  if not isinstance(x,dict):continue
  json_count+=1
  if x.get('event')!='upstream_call':continue
  endpoint=x.get('endpoint');outcome=x.get('outcome');http=x.get('httpStatus')
  if endpoint not in ['getlistpc','getcode','getbydataid','getchapterinfo'] or outcome not in ['ok','http_error','timeout','transport_error'] or (http is not None and not isinstance(http,int)):continue
  cohort='moboreader_window' if ts<'2026-10-14T13:44:04.981121' else 'plotnovel_window'
  buckets[cohort][(endpoint,http,outcome)]+=1
  events.append({'at':ts,'endpoint':endpoint,'httpStatus':http,'outcome':outcome,'latencyMs':x.get('latencyMs') if isinstance(x.get('latencyMs'),(int,float)) else None,'gateWaitMs':x.get('gateWaitMs') if isinstance(x.get('gateWaitMs'),(int,float)) else None})
 summary={'service':service,'cohorts':{k:[{'endpoint':a,'httpStatus':b,'outcome':c,'count':n} for (a,b,c),n in v.items()] for k,v in buckets.items()},'jsonLogLines':json_count,'unparsedLogLines':not_json,'upstreamObservations':events,'rawLogsSaved':False,'rawResponseBodiesAvailableInObservation':False}
 all_summaries.append(summary)
print('INVESTIGATION_LOGS='+json.dumps(all_summaries),flush=True)
print('INVESTIGATION_READONLY=PASS',flush=True)
