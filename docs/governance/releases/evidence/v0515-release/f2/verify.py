from pathlib import Path
import json,datetime
p=Path('.tmp/v0515-release/f2');lines=(p/'readonly-sample-second.log').read_text().splitlines()
x=next(json.loads(l) for l in lines if l.startswith('{'));s=next(json.loads(l.split('=',1)[1]) for l in lines if l.startswith('INDEXNOW_STATUS='));h=next(json.loads(l.split('=',1)[1]) for l in lines if l.startswith('HEALTH='))
assert x['transaction_read_only']=='on'
assert x['new_outbox_count']==len(x['newly_published_articles'])==len(x['new_outbox'])==len(x['new_attempts'])==3
articles={a['id'] for a in x['newly_published_articles']};assert articles=={o['article_id'] for o in x['new_outbox']} and all(a['status']=='published' for a in x['newly_published_articles'])
outbox={o['id'] for o in x['new_outbox']};assert outbox=={a['outbox_id'] for a in x['new_attempts']}
assert all(o['status']=='accepted' and o['article_status']=='published' and o['source']=='admin.article.publish' and o['event_type']=='article_first_publish' and o['attempt_count']==1 and o['last_http_status']==200 and o['last_error_kind'] is None and 0<=o['publish_to_response_seconds']<=120 for o in x['new_outbox'])
batches={a['request_batch_id'] for a in x['new_attempts']};assert len(batches)==1 and all(batches)
batch=next(iter(batches));taskids={a['worker_task_id'] for a in x['new_attempts']};assert len(taskids)==1
assert all(a['batch_size']==3 and a['http_status']==200 and a['attempt_no']==1 and a['attempt_state']=='completed' and a['outcome']=='accepted' and a['error_kind'] is None for a in x['new_attempts'])
assert len({a['request_at'] for a in x['new_attempts']})==len({a['response_at'] for a in x['new_attempts']})==1
assert len(x['delivery_task_items'])==1
i=x['delivery_task_items'][0];assert i['task_id'] in taskids and i['task_type']=='indexnow_delivery' and i['task_status']=='completed' and i['total_count']==1 and i['item_status']=='success' and i['target_type']=='indexnow_batch' and i['payload_mode']==i['result_mode']=='batch' and i['payload_has_outbox_id']==False
assert i['result_request_batch_id']==batch and i['result_claimed']=='3' and i['result_http_status']=='200' and i['result_outcome']=='accepted'
assert not s['control']['breaker']['open'] and not s['control']['rateLimit']['waiting'] and not s['outbox']['deadLetters'] and s['outbox']['dueUrls']==0 and s['keyValidation']['state']=='verified' and not s['tasks']['inFlightBatchTasks']
assert x['outbox_urls_by_status']=={'accepted':6}
assert sum(r['urls'] for r in s['attempts']['all'])==6 and sum(r['httpRequests'] for r in s['attempts']['all'])==4 and s['tasks']['deliveryTaskItemsByStatus']=={'success':4}
time=[datetime.datetime.fromisoformat(r['scheduled_for']) for r in x['sweep_schedule_latest']];assert len(time)==10 and all((b-a).total_seconds()==60 for a,b in zip(time,time[1:])) and all(r['status']=='enqueued' for r in x['sweep_schedule_latest'])
assert h['build']['version']=='0.5.15' and h['build']['commit']=='db623505539c3ca55f55b1270aab829b8db102d7' and h['ok'] and h['metadataConsistency']['status']=='passed'
r={'F2':'PASS','verifiedAt':x['read_at'],'final':h['build']['commit'],'transactionReadOnly':True,'samples':x['newly_published_articles'],'outboxRows':x['new_outbox'],'attemptRows':x['new_attempts'],'taskItems':x['delivery_task_items'],'batch':{'requestBatchId':batch,'batchSize':3,'urls':3,'httpRequests':1,'taskItems':1,'httpStatus':200,'publishToAcceptedSeconds':[o['publish_to_response_seconds'] for o in x['new_outbox']]},'totalCounts':{'acceptedUrls':6,'httpRequests':4,'successfulDeliveryTaskItems':4},'indexnowStatus':s,'sweepScheduleLatest':x['sweep_schedule_latest'],'envSha256Unchanged':'823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603','externalSiteRequestsThisFollowup':0,'batchFirstPublication100Limit':'MAY_BE_LIFTED','backfill':'NOT_EXECUTED','businessFlags':'UNCHANGED','nginx':'UNCHANGED'}
(p/'f2-result.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');(p/'indexnow-status.json').write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n')
print('F2=PASS urls=3 httpRequests=1 taskItems=1 batch_size=3 HTTP=200')
print('F2_REQUEST_BATCH_ID='+batch)
print('F2_PUBLISH_TO_ACCEPTED_SECONDS='+','.join(str(o['publish_to_response_seconds']) for o in x['new_outbox']))
print('INDEXNOW_CONTROL=PASS breaker=closed rateLimitWaiting=false deadLetters=0 dueUrls=0 keyValidation=verified')
print('TOTAL_COUNTS accepted_urls=6 httpRequests=4 delivery_success_taskItems=4')
print('MINUTE_SWEEP=PASS last10=10 interval_seconds=60')
print('BATCH_FIRST_PUBLICATION_100_LIMIT=MAY_BE_LIFTED')
