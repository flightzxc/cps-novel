from pathlib import Path
import subprocess,json,shlex,hashlib,re,datetime,urllib.parse
out=Path('.tmp/v061-release/phase2');ledger=out/'external-requests.jsonl';assert not ledger.exists()
remote=r'''import subprocess,json,sys,html,re
q="""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('samples',(SELECT json_agg(x) FROM (SELECT DISTINCT ON(sa.code) sa.code AS theater,a.id AS article_id,a.slug,a.public_page_short_id,p.public_redirect_code FROM article a JOIN promo_link p ON p.id=a.promo_link_id JOIN channel_app ca ON ca.id=p.channel_app_id JOIN source_app sa ON sa.id=ca.source_app_id WHERE sa.code IN ('plotnovel','moboreader') AND a.locale='en' AND a.status='published' AND a.deleted_at IS NULL AND a.seo_visibility='public' AND p.deleted_at IS NULL AND p.status='fetched' ORDER BY sa.code,a.id) x),'codes',(SELECT json_agg(p.upstream_code) FROM promo_link p WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND p.upstream_code IS NOT NULL AND btrim(p.upstream_code)<>''));COMMIT;"""
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=q,text=True,capture_output=True);assert r.returncode==0,'readonly_query_failed'
x=json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0];codes=x.pop('codes');assert len(x['samples'])==2 and len(codes)>=1977
print(json.dumps(x),flush=True)
for line in sys.stdin:
 try:
  o=json.loads(line)
  if o.get('quit'):break
  t=html.unescape(o['text']);t=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),t)
  print(json.dumps({'checkedCodes':len(codes),'matchingLines':sum(sum(c in row for row in t.splitlines()) for c in codes)}),flush=True)
 except Exception:print(json.dumps({'error':'secret_check_failed'}),flush=True);sys.exit(1)
'''
ssh=['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps']
checker=subprocess.Popen(ssh+['python3 -u -c '+shlex.quote(remote)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def secret(text):
 checker.stdin.write(json.dumps({'text':text})+'\n');checker.stdin.flush();x=json.loads(checker.stdout.readline());assert x.get('matchingLines')==0,'upstream_code_exposure';return x
try:
 first=checker.stdout.readline()
 if not first:
  err=checker.stderr.read();print('CHECKER_START_FAILED='+json.dumps({'exit':checker.wait(),'stderr':err[-2000:]}));raise RuntimeError('checker_start_failed')
 samples=json.loads(first)['samples'];sample={x['theater']:x for x in samples};assert set(sample)=={'plotnovel','moboreader'}
 results=[]
 paths=[('plotnovel-book','/novel/'+urllib.parse.quote(sample['plotnovel']['slug']+'-p'+sample['plotnovel']['public_page_short_id'],safe='')),('moboreader-book','/novel/'+urllib.parse.quote(sample['moboreader']['slug']+'-p'+sample['moboreader']['public_page_short_id'],safe='')),('sitemap-index','/sitemap.xml'),('plotnovel-go','/go/'+sample['plotnovel']['public_redirect_code'])]
 for kind,path in paths:
  count=len(ledger.read_text().splitlines()) if ledger.exists() else 0;assert count<6
  row={'sequence':count+1,'kind':kind,'path':path,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'proxy':'http://127.0.0.1:7899','followRedirects':False}
  with ledger.open('a') as f:f.write(json.dumps(row)+'\n')
  res=subprocess.run(['curl','--silent','--show-error','--include','--suppress-connect-headers','--compressed','--proxy','http://127.0.0.1:7899','--noproxy','','--retry','0','--connect-timeout','15','--max-time','40','https://pulsenovels.com'+path],capture_output=True);assert res.returncode==0,('curl_exit',res.returncode)
  data=res.stdout
  while True:
   sep=b'\r\n\r\n' if b'\r\n\r\n' in data else b'\n\n';head,body=data.split(sep,1);status=int(head.splitlines()[0].split()[1])
   if 100<=status<200:data=body;continue
   break
  headers=dict((l.split(b':',1)[0].strip().lower().decode(),l.split(b':',1)[1].strip().decode('iso8859-1')) for l in head.splitlines()[1:] if b':' in l)
  text=body.decode('utf8',errors='replace');checks=secret(text+'\n'+headers.get('location',''));assert status==(302 if kind=='plotnovel-go' else 200),(kind,status)
  if kind=='plotnovel-book':assert 'Read on PlotNovel App' in text
  if kind=='moboreader-book':assert 'Continue reading' in text
  if kind=='sitemap-index':assert '<sitemapindex' in text
  if kind=='plotnovel-go':
   loc=urllib.parse.urlsplit(headers['location']);assert loc.path==path+'/app' and loc.netloc in ('','pulsenovels.com') and not loc.query
  result={**row,'status':status,'bodySha256':hashlib.sha256(body).hexdigest(),'locationSha256':hashlib.sha256(headers.get('location','').encode()).hexdigest(),'codeCheck':checks};results.append(result);(out/'external-results.json').write_text(json.dumps({'status':'PASS' if len(results)==4 else 'RUNNING','requests':len(results),'results':results,'rawBodiesSaved':False,'rawCodesSaved':False},indent=2)+'\n');print('EXTERNAL='+json.dumps(result),flush=True)
 print('EXTERNAL_ACCEPTANCE=PASS requests=4')
finally:
 if checker.poll() is None:
  try:checker.stdin.write('{"quit":true}\n');checker.stdin.flush();checker.wait(timeout=20)
  except Exception:checker.terminate()
