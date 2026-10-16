import subprocess,json,pathlib,hashlib,datetime,sys,re,time,threading,queue,os
ROOT=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16'); OUT=ROOT/'phase3b'; OUT.mkdir(mode=0o700,exist_ok=True)
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
 start=json.loads((OUT/'baseline.json').read_text())['start']
 result={}
 for svc,c in containers.items():
  r=subprocess.run(['docker','logs','--since',start,c['name']],stdin=subprocess.DEVNULL,capture_output=True,text=True);assert r.returncode==0
  lines=(r.stdout+'\n'+r.stderr).splitlines()
  result[svc]={'error':sum(bool(re.search(r'(?i)(?:"level"\s*:\s*"error"|\[error\]|\bERROR\b)',line)) for line in lines),'permissionDenied':sum('permission denied' in line.lower() for line in lines),'lines':len(lines)}
 return result
def protect():
 assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV
 b=json.loads((OUT/'baseline.json').read_text());s=snapshot(b['protected']['publishedIds']);assert s==b['protected'],'protected_rows_changed';assert containers==b['containers'],'container_changed';return {'protectedIdentical':True,'envSha256':ENV,'containersIdentical':True}
def cmd(action,w):
 a=['docker','exec','-w','/app']
 if action=='status':a+=['-e','PGOPTIONS=-c default_transaction_read_only=on']
 a+=[web,'tsx','--tsconfig','/app/tsconfig.json','/tmp/plotnovel-bulk-generate-publish.ts',action,'--manifest',MAN,'--manifest-sha256',SHA,'--actor-id','71f0e655-0640-4f07-bcbb-041f027fa7cb','--wave',str(w)]
 if action!='status':a+=['--confirm','PLOTNOVEL_BULK_'+action.upper()]
 return a


sys.argv=['supervise.py','publish','1']
action=sys.argv[1];w=int(sys.argv[2]) if len(sys.argv)>2 else 0
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
if action=='init':
 assert not (OUT/'baseline.json').exists()
 s=snapshot();assert s['manualCount']==635 and s['publishedCount']==1977
 phase1=json.loads((ROOT/'phase3a-result.json').read_text())['protectionBefore'];assert s['manualDigest']==phase1['manualDigest'] and s['publishedDigest']==phase1['publishedDigest']
 b={'start':now(),'approval':{'opsCommit':'c3578aa6f8c18bc0ee39bcd14da95703aaad3098','manifestSha256':SHA,'ownerApproved':True,'controlReviewPassed':True,'waveSizes':[58]},'containers':containers,'protected':s,'envSha256':ENV,'final':FINAL,'activeExternalHttp':0}
 save('baseline.json',b);emit(b)
elif action in ['status','protect','logs']:
 p=protect();l=logs();r={'at':now(),'action':action,'wave':w,'protection':p,'logs':l}
 if action=='status':r['status']=json.loads(run(cmd(action,w)))
 save(stamp+'-'+action+'-w'+str(w)+'.json',r);emit(r)
elif action in ['generate','publish']:
 protect();l=logs();assert all(x['permissionDenied']==0 and x['error']==0 for x in l.values()),'service_logs_stop'
 assert not (OUT/'STOP.json').exists(),'prior_supervisor_stop'
 before=json.loads(run(cmd('status',w)));assert not before['stopReasons'],before['stopReasons']
 a=cmd(action,w);q=queue.Queue();errors=[];events=[];started=now()
 # Capture only controlled JSON stdout; never persist raw stderr or response bodies.
 p=subprocess.Popen(a,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 def reader(stream,tag):
  for line in stream:q.put((tag,line))
  q.put((tag,None))
 for stream,tag in [(p.stdout,'out'),(p.stderr,'err')]:threading.Thread(target=reader,args=(stream,tag),daemon=True).start()
 done=0;last=time.monotonic();stopped=False
 while done<2:
  try:tag,line=q.get(timeout=1)
  except queue.Empty:tag,line=None,''
  if tag and line is None:done+=1
  elif tag=='err':errors.append(line)
  elif tag=='out':
   try:
    x=json.loads(line);assert isinstance(x,dict);events.append(x);emit({'action':action,'event':x})
   except (ValueError,AssertionError):errors.append(line)
  if (tag=='out' and line) or time.monotonic()-last>=30:
   l=logs();last=time.monotonic();emit({'at':now(),'action':action,'supervisionLogs':l})
   if any(x['permissionDenied'] or x['error'] for x in l.values()) and not stopped:
    stopped=True
    interrupt="const fs=require('fs');let n=0;for(const p of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(p)){try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0));if(a.includes('/tmp/plotnovel-bulk-generate-publish.ts')&&a.includes('--wave')&&a.includes('WAVE_PLACEHOLDER')&&Number(p)!==process.pid){process.kill(Number(p),'SIGINT');n++}}catch{}}console.log(JSON.stringify({interruptedProcesses:n}))"
    # Signal only the exact approved CLI process; its handler stops after the current call.
    interrupt=interrupt.replace('WAVE_PLACEHOLDER',str(w))
    emit({'interruption':json.loads(run(['docker','exec',web,'node','-e',interrupt]))})
 exitcode=p.wait();after=json.loads(run(cmd('status',w)));protection=protect()
 result={'startedAt':started,'finishedAt':now(),'command':a,'exit':exitcode,'events':events,'unexpectedOutputLines':len(errors),'unexpectedOutputSha256':hashlib.sha256(''.join(errors).encode()).hexdigest(),'status':after,'logs':logs(),'protection':protection}
 save(stamp+'-'+action+'-w'+str(w)+'.json',result);emit(result)
 if stopped or exitcode or errors or after['stopReasons']:
  save('STOP.json',{'at':now(),'wave':w,'action':action,'reason':'command_or_gate_failure','exit':exitcode,'unexpectedOutputLines':len(errors),'stopReasons':after['stopReasons']});sys.exit(2)
else:raise RuntimeError('unknown_action')
