import time
q="SELECT json_build_object('at',clock_timestamp(),'task',(SELECT row_to_json(t) FROM (SELECT id,task_type,status,total_count,success_count,failed_count,skipped_count,created_at,started_at,completed_at FROM generic_task WHERE id='431d9fdb-87d0-4006-b5ba-1042326e5eba') t));"
for n in range(30):
 raw=sql(q);x=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
 print('SITEMAP_TASK='+json.dumps(x),flush=True)
 if x['task']['status']=='completed':
  assert x['task']['failed_count']==0
  print('SITEMAP_TASK=PASS',flush=True);break
 assert x['task']['status'] in ['pending','processing','queued'], 'sitemap terminal failure'
 time.sleep(10)
else:raise RuntimeError('sitemap wait exceeded; no resubmission')
