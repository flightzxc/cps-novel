import subprocess,json,pathlib,hashlib,datetime,sys,re,time,threading,queue,os
ROOT=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16'); OUT=ROOT/'phase3b-resume'; OUT.mkdir(mode=0o700,exist_ok=True)
FINAL='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'; ENV='23425e8289854167d53d91f1f3673e383239458f0ae76fb4a5c695559e224509'; SHA='ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639'; SCRIPT='0217ad5978a9f4d43c320fed963f479dd43d79d8099013bf74937185590f2129'; APP='00de5521-d075-4472-87eb-cc5d1732f4d0'; MAN='/tmp/plotnovel-b47-20261016-manifest.json'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(a):
 r=subprocess.run(a,stdin=subprocess.DEVNULL,capture_output=True,text=True)
 if r.returncode:raise RuntimeError('command_failed_exit_'+str(r.returncode)+'_stderrsha_'+hashlib.sha256(r.stderr.encode()).hexdigest())
 return r.stdout
def save(name,x):
 p=OUT/name
 with p.open('x') as f:json.dump(x,f,ensure_ascii=False,indent=2);f.write('\n')
 p.chmod(0o600)
def emit(x):print(json.dumps(x,ensure_ascii=False),flush=True)
assert run(['hostname']).strip()=='haiyue-vps'
assert pathlib.Path('/opt/cps-novel/current').resolve().name==FINAL
assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV
assert hashlib.sha256((ROOT/'manifest.json').read_bytes()).hexdigest()==SHA
containers={}
for svc in ['web','worker','worker-light','scheduler','postgres','backup-timer']:
 names=run(['docker','ps','--filter','label=com.docker.compose.project=cps-novel','--filter','label=com.docker.compose.service='+svc,'--format','{{.Names}}']).splitlines();assert len(names)==1,svc
 info=json.loads(run(['docker','inspect',names[0]]))[0]
 assert info['State'].get('Health',{}).get('Status')=='healthy',svc
 containers[svc]={'name':names[0],'id':info['Id'],'healthy':True}
web=containers['web']['name']; pg=containers['postgres']['name']
assert run(['docker','exec',web,'sha256sum','/tmp/plotnovel-bulk-generate-publish.ts']).split()[0]==SCRIPT
assert run(['docker','exec',web,'sha256sum',MAN]).split()[0]==SHA

def sql(query):
 q='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'+query+'\nCOMMIT;'
 r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=q,text=True,capture_output=True)
 if r.returncode:raise RuntimeError('readonly_sql_failed_'+str(r.returncode)+'_stderrsha_'+hashlib.sha256(r.stderr.encode()).hexdigest())
 return json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0]
def snapshot(ids=None):
 filt="p.channel_app_id='"+APP+"' AND a.status='published' AND a.deleted_at IS NULL"
 if ids is not None:filt+=" AND a.id IN ("+','.join("'"+i+"'" for i in ids)+")"
 return sql("SELECT json_build_object('manualCount',(SELECT count(*) FROM side_effect_intent WHERE channel_app_id='"+APP+"' AND status='manual_review_required'),'manualDigest',(SELECT encode(sha256(convert_to(string_agg(id::text||status||response_shape::text,'|' ORDER BY id),'UTF8')),'hex') FROM side_effect_intent WHERE channel_app_id='"+APP+"' AND status='manual_review_required'),'publishedCount',(SELECT count(*) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE "+filt+"),'publishedDigest',(SELECT encode(sha256(convert_to(string_agg(a.id::text||a.status||a.slug||a.public_page_short_id||a.published_at::text||a.body,'|' ORDER BY a.id),'UTF8')),'hex') FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE "+filt+"),'publishedIds',(SELECT json_agg(a.id ORDER BY a.id) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE "+filt+"));")
def logs():
 start=json.loads((ROOT/'phase3b'/'baseline.json').read_text())['start']
 result={}
 for svc,c in containers.items():
  r=subprocess.run(['docker','logs','--since',start,c['name']],stdin=subprocess.DEVNULL,capture_output=True,text=True);assert r.returncode==0
  lines=(r.stdout+'\n'+r.stderr).splitlines()
  result[svc]={'error':sum(bool(re.search(r'(?i)(?:"level"\s*:\s*"error"|\[error\]|\bERROR\b)',line)) for line in lines),'permissionDenied':sum('permission denied' in line.lower() for line in lines),'lines':len(lines)}
 return result
def protect():
 assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV
 b=json.loads((ROOT/'phase3b'/'baseline.json').read_text());s=snapshot(b['protected']['publishedIds']);assert s==b['protected'],'protected_rows_changed';assert containers==b['containers'],'container_changed';return {'protectedIdentical':True,'envSha256':ENV,'containersIdentical':True}
def cmd(action,w):
 a=['docker','exec','-w','/app']
 if action=='status':a+=['-e','PGOPTIONS=-c default_transaction_read_only=on']
 a+=[web,'tsx','--tsconfig','/app/tsconfig.json','/tmp/plotnovel-bulk-generate-publish.ts',action,'--manifest',MAN,'--manifest-sha256',SHA,'--actor-id','71f0e655-0640-4f07-bcbb-041f027fa7cb','--wave',str(w)]
 if action!='status':a+=['--confirm','PLOTNOVEL_BULK_'+action.upper()]
 return a


RESOLUTION={'decision': 'Owner判定book_upstream_code_leak为检查器误报，不是真实泄露，批准修正检查器后重查及继续34本', 'basis': [{'source': 'Owner转述主控只读统计', 'protectedCodes': 2035, 'allSixDigitNumeric': True}, {'source': 'Owner转述主控同页两次只读抓取', 'sixDigitWindowsPerPage': 96, 'coincidenceProbabilityPercent': 17.8, 'differentWindows': 32, 'mainCause': '封面图地址13位时间戳；每次推荐封面变化导致窗口变化'}, {'source': 'Owner结构与部署后权限验证', 'codeRetrievalOnly': 'src/app/go/[code]/app/page.tsx via src/app/go/_lib/code-mode-page-data.ts calls code_mode_upstream_code()', 'webDirectUpstreamCodeRead': 'permission denied previously verified; no new negative probe'}], 'checkerRule': '(?<![0-9])CODE(?![0-9])', 'newHttpBudget': 9, 'cumulativeHttpBudget': 12, 'preserveHistoricalStop': True}
assert json.loads((ROOT/'phase3b'/'STOP.json').read_text())['reason']=='public_book_upstream_code_check_failed'
assert PUBLIC['status']=='PASS' and PUBLIC['requests']==9 and PUBLIC['stageCumulativeRequests']==12
save('owner-resolution.json',{'at':now(),**RESOLUTION,'publicAcceptance':PUBLIC})
protect();assert not (OUT/'STOP.json').exists();assert not (OUT/'preview-apply-moboreader.json').exists(),'prior_apply_exists';assert all(not v['error'] and not v['permissionDenied'] for v in logs().values())
a=json.loads((ROOT/'phase3a-result.json').read_text());g=json.loads(run(['docker','exec','-w','/app','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-worker-1','tsx','--tsconfig','/app/tsconfig.json','/tmp/v061-group-preview.ts']));assert g['rows']==a['grouping']['rows'],'grouping_or_count_changed'
reports=[]
for old in a['surveys']:
 survey=json.loads(run(old['command']));assert survey['candidateCount']==len(old['group']['sourceItemIds']) and not survey['truncated'] and survey['preflight']['status']=='usable','survey_count_changed'
 command=[v for v in old['command'] if v not in ['-e','PGOPTIONS=-c default_transaction_read_only=on']]+['--apply','--confirm','APPLY_PREVIEW_BACKFILL']
 started=now();raw=run(command);report=json.loads(raw);save('preview-apply-'+old['group']['appCode']+'.json',{'startedAt':started,'command':command,'survey':survey,'report':report,'group':old['group']});emit({'command':command,'report':report})
 assert report['mode']=='apply' and report['candidateCount']==len(old['group']['sourceItemIds']) and report['preflight']['status']=='usable' and not report.get('refused'),'apply_refused'
 reports.append(report)
emit({'status':'APPLY_SUBMITTED','groups':len(reports),'protection':protect(),'logs':logs()})
