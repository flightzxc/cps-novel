from pathlib import Path
r=Path.cwd();o=r/'.tmp/v061-release/phase3b';s=(o/'supervise.py').read_text().split('action=sys.argv[1];')[0]
s+='''
protect(); baseline=json.loads((OUT/'baseline.json').read_text())
assert all(v['permissionDenied']==0 and v['error']==0 for v in logs().values()),'service_logs_stop'
a=json.loads((ROOT/'phase3a-result.json').read_text())
g=json.loads(run(['docker','exec','-w','/app','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-worker-1','tsx','--tsconfig','/app/tsconfig.json','/tmp/v061-group-preview.ts']))
assert g['rows']==a['grouping']['rows'],'preview_grouping_or_counts_changed'
surveys=[]
for old in a['surveys']:
 report=json.loads(run(old['command']));assert report['candidateCount']==len(old['group']['sourceItemIds']) and report['mode']=='survey' and not report['truncated'] and not report['batches'],'survey_count_changed';assert report['preflight']['status']=='usable';surveys.append({'group':old['group'],'report':report})
status=json.loads(run(cmd('status',1)));assert not status['stopReasons'],status['stopReasons'];assert status['generation']['notSubmitted']==58 and status['published']==0 and status['drafts']==0,'prior_execution_detected'
q="SELECT json_build_object('generate',(SELECT count(*) FROM generic_task WHERE task_type LIKE 'article.generate.%' AND status IN ('pending','processing')),'publish',(SELECT count(*) FROM generic_task WHERE task_type LIKE 'article.publish.%' AND status IN ('pending','processing')),'preview',(SELECT count(*) FROM channel_sync_task WHERE task_type='moboreader.preview_refresh.v1' AND status IN ('pending','processing')));"
inflight=sql(q);assert all(v==0 for v in inflight.values()),'inflight_not_zero'
x={'at':now(),'status':'PASS','surveys':surveys,'opsStatus':status,'inflight':inflight,'protection':protect()};save('preapply-recheck.json',x);emit(x)
'''
(o/'recheck-remote.py').write_text(s)
