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


CONTENT='import {createRequire} from \'node:module\';\nimport fs from \'node:fs\';\nimport path from \'node:path\';\nimport {randomInt} from \'node:crypto\';\nconst req=createRequire(\'/app/package.json\'),{PrismaClient}=req(\'@prisma/client\');\nconst {createSitemapFamilyBuilder}=req(\'./src/lib/seo/sitemap.ts\');\nconst {buildArticlePath}=req(\'./src/lib/slug/article-path.ts\');\nconst {getStaticSitemapCurrentDir}=req(\'./src/lib/seo/static-sitemap-cache.ts\');\nconst db=new PrismaClient();\nasync function main(){\n const targets=JSON.parse(fs.readFileSync(\'/tmp/v061-coverage-input.json\',\'utf8\'));\n const m=JSON.parse(fs.readFileSync(\'/tmp/plotnovel-b47-20261016-manifest.json\',\'utf8\'));\n const result=await db.$transaction(async(tx:typeof db)=>{\n  await tx.$executeRawUnsafe(\'SET TRANSACTION READ ONLY\');\n  const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_setting(\'transaction_read_only\') readonly");if(role.role!==\'web_app\'||role.readonly!==\'on\')throw Error(\'role\');\n  const articles=await tx.article.findMany({where:{status:\'published\',deletedAt:null,promoLink:{channelAppId:m.appId}},select:{id:true,novelId:true,locale:true,slug:true,publicPageShortId:true,promoLink:{select:{publicRedirectCode:true}}}});\n  const extra=await tx.article.findMany({where:{status:\'published\',deletedAt:null,novelId:{in:targets.extraNovelIds}},select:{id:true,novelId:true,locale:true,slug:true,publicPageShortId:true}});\n  const extraBooks=new Set(extra.map((a:any)=>\'https://pulsenovels.com\'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));\n  const books=new Set(articles.map((a:any)=>\'https://pulsenovels.com\'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));\n  // Same production visibility, chapter window and nonempty-content rules as the refresh worker.\n  const family=await createSitemapFamilyBuilder(tx)({type:\'novelpage\',locale:\'en\'});\n  const expectedBooks=new Set<string>(),expectedChapters=new Set<string>();\n  for(const f of family)for(const e of f.entries){if(books.has(e.loc))expectedBooks.add(e.loc);else if(books.has(e.loc.split(\'/chapter/\')[0]))expectedChapters.add(e.loc);}\n  const dir=getStaticSitemapCurrentDir(),index=fs.readFileSync(path.join(dir,\'sitemap.xml\'),\'utf8\');\n  const files=[...index.matchAll(/<loc>([^<]+)<\\/loc>/g)].map((x:any)=>new URL(x[1]).pathname.split(\'/\').pop()).filter((x:string)=>/^site_novelpage_en(?:_\\d+)?\\.xml$/.test(x));\n  const actual=new Set<string>();for(const file of files){const xml=fs.readFileSync(path.join(dir,\'sitemap\',file),\'utf8\');for(const match of xml.matchAll(/<loc>([^<]+)<\\/loc>/g))actual.add(match[1].replaceAll(\'&amp;\',\'&\'));}\n  const extraExpectedBooks=new Set<string>(),extraExpectedChapters=new Set<string>();for(const f of family)for(const e of f.entries){if(extraBooks.has(e.loc))extraExpectedBooks.add(e.loc);else if(extraBooks.has(e.loc.split(\'/chapter/\')[0]))extraExpectedChapters.add(e.loc);}\n  const extraMissingBooks=[...extraExpectedBooks].filter(u=>!actual.has(u)),extraMissingChapters=[...extraExpectedChapters].filter(u=>!actual.has(u));\n  const missingBooks=[...expectedBooks].filter(u=>!actual.has(u)),missingChapters=[...expectedChapters].filter(u=>!actual.has(u));\n  const manifestIds=new Set(m.waves.flatMap((w:any)=>w.chunks.flatMap((c:any)=>c.novelIds))),created=articles.filter((a:any)=>manifestIds.has(a.novelId));\n  const createdBookUrls=new Set(created.map((a:any)=>\'https://pulsenovels.com\'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));\n  const newChapterPages=[...expectedChapters].filter(u=>createdBookUrls.has(u.split(\'/chapter/\')[0])).length;\n  const indices=new Set<number>();while(indices.size<3)indices.add(randomInt(created.length));\n  const samples=[...indices].map(i=>{const a=created[i];return {articleId:a.id,novelId:a.novelId,bookPath:buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId}),goCode:a.promoLink.publicRedirectCode}});\n  return {extraArticleCount:extra.length,extraBuilderBooks:extraExpectedBooks.size,extraExpectedChapters:extraExpectedChapters.size,extraMissingBooks:extraMissingBooks.length,extraMissingChapters:extraMissingChapters.length,at:new Date().toISOString(),databaseRole:role.role,transactionReadOnly:role.readonly,publishedTotal:articles.length,newPublished:created.length,existingPublished:articles.length-created.length,newValidIndexableChapterPages:newChapterPages,existingValidIndexableChapterPages:expectedChapters.size-newChapterPages,expectedExisting:1977,originalBuilderBooks:expectedBooks.size,expectedValidIndexableChapters:expectedChapters.size,missingBookCount:missingBooks.length,missingChapterCount:missingChapters.length,unexpectedPlotChapterCount:[...actual].filter(u=>u.includes(\'/chapter/\')&&books.has(u.split(\'/chapter/\')[0])&&!expectedChapters.has(u)).length,goUrlsInNovelSitemaps:[...actual].filter(u=>u.includes(\'/go/\')).length,allPublishedBooksAreCandidates:expectedBooks.size===articles.length,staticRelease:path.basename(fs.realpathSync(dir)),shards:files.length,samples};\n },{isolationLevel:\'RepeatableRead\',timeout:120000});\n console.log(JSON.stringify(result));\n}\nmain().catch(()=>{console.error(JSON.stringify({status:\'STOP\',code:\'final_coverage_failed\'}));process.exitCode=1}).finally(()=>db.$disconnect());\n'
p=OUT/'v061-coverage-v2.ts'
if p.exists():assert p.read_text()==CONTENT
else:p.write_text(CONTENT);p.chmod(0o644);run(['docker','cp',str(p),web+':/tmp/v061-coverage-v2.ts'])
a=json.loads((ROOT/'phase3a-result.json').read_text());b=json.loads((OUT/'baseline.json').read_text());inp={'since':b['start'],'extraNovelIds':[i['novelId'] for i in a['grouping']['rows']]};p=OUT/'coverage-input-v2.json';p.write_text(json.dumps(inp));p.chmod(0o644);run(['docker','cp',str(p),web+':/tmp/v061-coverage-input.json'])
protect();x=json.loads(run(['docker','exec','-w','/app','-e','PGOPTIONS=-c default_transaction_read_only=on',web,'tsx','--tsconfig','/app/tsconfig.json','/tmp/v061-coverage-v2.ts']));save('coverage-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json',x);emit(x)
