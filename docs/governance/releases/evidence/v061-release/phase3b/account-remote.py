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


FILES={'account.ts': 'import {createRequire} from \'node:module\';import fs from \'node:fs\';\nconst req=createRequire(\'/app/package.json\'),{PrismaClient}=req(\'@prisma/client\'),db=new PrismaClient();\nasync function main(){const meta=JSON.parse(fs.readFileSync(\'/app/.build-metadata.json\',\'utf8\'));if(process.cwd()!=\'/app\'||meta.commit!==\'cb255e0f1c93041eda6aefeefbb541d7eddfc15f\'||meta.version!==\'0.6.1\')throw Error(\'identity\');\n const input=JSON.parse(fs.readFileSync(\'/tmp/v061-account-input.json\',\'utf8\'));\n const x=await db.$transaction(async(tx:any)=>{await tx.$executeRawUnsafe(\'SET TRANSACTION READ ONLY\');const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_setting(\'transaction_read_only\') readonly");if(role.role!==\'worker_app\'||role.readonly!==\'on\')throw Error(\'role\');\n const articles=await tx.article.findMany({where:{novelId:{in:input.novelIds},deletedAt:null},select:{id:true,novelId:true,status:true,publishedAt:true}});\n const previews=await tx.$queryRawUnsafe(`SELECT i.id AS "itemId",i.novel_source_item_id AS "sourceItemId",s.novel_id AS "novelId",i.task_id AS "taskId",i.status,i.attempt_count AS "attemptCount",i.finished_at AS "finishedAt",\n CASE WHEN i.result->>\'reason\' ~ \'^[A-Za-z0-9_.:-]{1,160}$\' THEN i.result->>\'reason\' END AS reason,\n CASE WHEN i.error->>\'kind\' ~ \'^[A-Za-z0-9_.:-]{1,160}$\' THEN i.error->>\'kind\' END AS "failureKind",\n CASE WHEN i.error->>\'code\' ~ \'^[A-Za-z0-9_.:-]{1,160}$\' THEN i.error->>\'code\' END AS "failureCode",\n COALESCE((i.result->>\'contentWrites\')::int,0) AS "contentWrites",COALESCE((i.result->>\'materializedCount\')::int,0) AS "materializedCount",COALESCE((i.result->>\'preservedCount\')::int,0) AS "preservedCount",COALESCE((i.result->>\'restoredCount\')::int,0) AS "restoredCount",COALESCE((i.result->>\'staleCount\')::int,0) AS "staleCount",i.result->\'emptyChapterNumbers\' AS "emptyChapterNumbers"\n FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id=i.task_id JOIN novel_source_item s ON s.id=i.novel_source_item_id WHERE t.task_type=\'moboreader.preview_refresh.v1\' AND t.mode=\'apply\' AND i.created_at >= $1::timestamptz AND (s.novel_id=ANY($2::uuid[]) OR s.id=ANY($3::uuid[])) ORDER BY s.id,i.created_at`,input.since,input.novelIds,input.sourceItemIds);\n const taskIds=[...new Set(previews.map((i:any)=>i.taskId))];const tasks=taskIds.length?await tx.$queryRawUnsafe(`SELECT id,status,completed_at AS "completedAt",result->\'sitemapRefresh\' AS "sitemapRefresh" FROM channel_sync_task WHERE id=ANY($1::uuid[]) ORDER BY id`,taskIds):[];\n const refreshIds=[...new Set(tasks.map((t:any)=>t.sitemapRefresh?.taskId).filter(Boolean))];const refreshes=refreshIds.length?await tx.genericTask.findMany({where:{id:{in:refreshIds}},select:{id:true,status:true,params:true,completedAt:true}}):[];\n const latest=await tx.genericTask.findFirst({where:{taskType:\'sitemap_refresh\'},orderBy:{createdAt:\'desc\'},select:{id:true,status:true,params:true,createdAt:true,completedAt:true}});\n const totals=await tx.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id=\'00de5521-d075-4472-87eb-cc5d1732f4d0\' AND a.status=\'published\' AND a.deleted_at IS NULL) AS published,\n (SELECT count(*)::int FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id=i.task_id WHERE t.task_type=\'moboreader.preview_refresh.v1\' AND i.status IN (\'pending\',\'processing\')) AS "previewBacklog"`);\n return {at:new Date().toISOString(),role,articles,previews,tasks,refreshes,latestSitemap:latest,totals:totals[0]};},{isolationLevel:\'RepeatableRead\',timeout:120000});console.log(JSON.stringify(x));}\nmain().catch(()=>{console.error(JSON.stringify({status:\'STOP\',code:\'account_read_failed\'}));process.exitCode=1}).finally(()=>db.$disconnect());\n'}
a=json.loads((ROOT/'phase3a-result.json').read_text());m=json.loads((ROOT/'manifest.json').read_text());b=json.loads((OUT/'baseline.json').read_text());inp={'since':b['start'],'novelIds':[n for w in m['waves'] for c in w['chunks'] for n in c['novelIds']],'sourceItemIds':[i['sourceItemId'] for i in a['grouping']['rows']]}
for name,content in [('v061-account.ts',FILES['account.ts']),('v061-account-input.json',json.dumps(inp))]:
 p=OUT/name
 if p.exists():assert p.read_text()==content
 else:p.write_text(content);p.chmod(0o644);run(['docker','cp',str(p),'cps-novel-worker-1:/tmp/'+name])
protect();data=json.loads(run(['docker','exec','-w','/app','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-worker-1','tsx','--tsconfig','/app/tsconfig.json','/tmp/v061-account.ts']));save('account-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json',data);emit(data)
