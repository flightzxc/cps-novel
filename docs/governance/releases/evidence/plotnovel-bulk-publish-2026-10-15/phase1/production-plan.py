import subprocess,json,pathlib,hashlib,datetime
FINAL='493eb23b034b0410780228535b3e293e4ee91f9a'; ENV_SHA='f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369'
def run(args):
 r=subprocess.run(args,stdin=subprocess.DEVNULL,text=True,capture_output=True)
 if r.returncode:
  print('COMMAND_FAILED='+json.dumps({'command':args,'exit':r.returncode,'stderrSha256':hashlib.sha256(r.stderr.encode()).hexdigest(),'stdoutSha256':hashlib.sha256(r.stdout.encode()).hexdigest()}),flush=True)
  raise RuntimeError('command failed; raw stderr withheld')
 return r.stdout
assert run(['hostname']).strip()=='haiyue-vps'
assert pathlib.Path('/opt/cps-novel/current').resolve().name==FINAL
assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV_SHA
names=run(['docker','ps','--filter','label=com.docker.compose.project=cps-novel','--filter','label=com.docker.compose.service=web','--format','{{.Names}}']).splitlines();assert len(names)==1
web=names[0];info=json.loads(run(['docker','inspect',web]))[0];assert info['State']['Health']['Status']=='healthy' and info['Config']['Labels']['org.opencontainers.image.revision']==FINAL
q="""SELECT json_build_object('at',clock_timestamp(),'manualCount',(SELECT count(*) FROM side_effect_intent WHERE channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND status='manual_review_required'),'manualDigest',(SELECT encode(sha256(convert_to(string_agg(id::text||status||response_shape::text,'|' ORDER BY id),'UTF8')),'hex') FROM side_effect_intent WHERE channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND status='manual_review_required'),'publishedCount',(SELECT count(*) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL),'publishedDigest',(SELECT encode(sha256(convert_to(string_agg(a.id::text||a.status||a.slug||a.public_page_short_id||a.published_at::text||a.body,'|' ORDER BY a.id),'UTF8')),'hex') FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL));"""
def snapshot():
 pg=run(['docker','ps','--filter','label=com.docker.compose.project=cps-novel','--filter','label=com.docker.compose.service=postgres','--format','{{.Names}}']).splitlines();assert len(pg)==1
 cmd="psql -X -v ON_ERROR_STOP=1 -U postgres -d cps_novel -At <<'BULK_SQL'\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"+q+"\nCOMMIT;\nBULK_SQL\n"
 raw=run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on',pg[0],'bash','-c',cmd]);return json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
before=snapshot();assert before['manualCount']==635 and before['publishedCount']==50
ops=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-bulk-publish-2026-10-15');ops.mkdir(mode=0o700,exist_ok=True);assert ops.stat().st_mode & 0o777==0o700
# SCRIPT_CONTENT is supplied by the local uploader; it contains code, no production data.
script=ops/'plotnovel-bulk-generate-publish.ts';script.write_text(SCRIPT_CONTENT);script.chmod(0o644)
assert hashlib.sha256(script.read_bytes()).hexdigest()==SCRIPT_SHA
run(['docker','cp',str(script),web+':/tmp/plotnovel-bulk-generate-publish.ts'])
assert run(['docker','exec',web,'sha256sum','/tmp/plotnovel-bulk-generate-publish.ts']).split()[0]==SCRIPT_SHA
manifest='/tmp/plotnovel-bulk-20261015-manifest.json'
raw=run(['docker','exec','-w','/app','-e','PGOPTIONS=-c default_transaction_read_only=on',web,'tsx','--tsconfig','/app/tsconfig.json','/tmp/plotnovel-bulk-generate-publish.ts','plan','--actor-id','71f0e655-0640-4f07-bcbb-041f027fa7cb','--output',manifest])
plan=json.loads(raw);assert plan['command']=='plan' and plan['databaseRole']=='web_app' and plan['transactionReadOnly']=='on'
assert plan['actor']=={'id':'71f0e655-0640-4f07-bcbb-041f027fa7cb','username':'admin','role':'super_admin','status':'active'}
assert plan['manualReview']==635 and plan['publishedBaseline']==50
run(['docker','cp',web+':'+manifest,str(ops/'manifest.json')]);(ops/'manifest.json').chmod(0o600)
assert hashlib.sha256((ops/'manifest.json').read_bytes()).hexdigest()==plan['manifestSha256']
after=snapshot();assert {k:v for k,v in before.items() if k!='at'}=={k:v for k,v in after.items() if k!='at'}
assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV_SHA
assert json.loads(run(['docker','inspect',web]))[0]['Id']==info['Id']
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':'haiyue-vps','webContainer':web,'webContainerId':info['Id'],'final':FINAL,'envSha256':ENV_SHA,'scriptSha256':SCRIPT_SHA,'plan':plan,'protectedBefore':before,'protectedAfter':after,'protectedIdentical':True,'hostManifest':str(ops/'manifest.json'),'manifestMode':'0600','commandsExecuted':['plan'],'generateCalls':0,'publishCalls':0,'getcodeCalls':0,'activeExternalHttp':0}
(ops/'phase1-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');(ops/'phase1-result.json').chmod(0o600)
print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)
