from pathlib import Path
import json,subprocess,hashlib,datetime,urllib.parse,re
out=Path('.tmp/v060-release/phase2');before=json.loads((out/'go-before.json').read_text());sample={'slug': 'contract-baby-and-billionaire', 'public_page_short_id': 'g15q11wz', 'public_redirect_code': 'hpsuxf95w4'};ledger=out/'external-requests.jsonl'
def request(kind,url,headers=False):
 count=len(ledger.read_text().splitlines());assert count<10
 with ledger.open('a') as f:f.write(json.dumps({'sequence':count+1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,'url':url})+'\n')
 args=['curl','--silent','--show-error','--proxy','http://127.0.0.1:7899','--noproxy','','--max-time','40']
 if headers:args+=['--dump-header','-','--output','/dev/null']
 else:args+=['--write-out','\n__HTTP__%{http_code}']
 r=subprocess.run(args+[url],capture_output=True);assert r.returncode==0,('curl exit',r.returncode)
 return r.stdout
h=request('go-after',before['url'],True);statuses=[int(x.split()[1]) for x in h.splitlines() if x.startswith(b'HTTP/')];loc=[x.split(b':',1)[1].strip() for x in h.splitlines() if x.lower().startswith(b'location:')];assert len(loc)==1
after=dict(before,status=statuses[-1],locationSha256=hashlib.sha256(loc[0]).hexdigest());(out/'go-after.json').write_text(json.dumps(after,indent=2)+'\n');print('GO_AFTER='+json.dumps(after));assert after['status']==before['status'] and after['locationSha256']==before['locationSha256']
results=[]
book='/novel/'+urllib.parse.quote(sample['slug']+'-p'+sample['public_page_short_id'],safe='')
for kind,path in [('english-book',book),('category','/category/adventure'),('sitemap-index','/sitemap.xml')]:
 url='https://pulsenovels.com'+path;raw=request(kind,url);body,status=raw.rsplit(b'\n__HTTP__',1);status=int(status);text=body.decode('utf-8',errors='replace');row={'kind':kind,'url':url,'status':status,'bodySha256':hashlib.sha256(body).hexdigest(),'plotnovelOccurrences':len(re.findall('PlotNovel',text,re.I)),'continueReading':('Continue reading' in text) if kind=='english-book' else None};results.append(row);print('EXTERNAL='+json.dumps(row));assert status==200 and row['plotnovelOccurrences']==0
 if kind=='english-book':assert row['continueReading']
(out/'external-results.json').write_text(json.dumps(results,indent=2)+'\n');print('EXTERNAL_ACCEPTANCE=PASS requests='+str(len(ledger.read_text().splitlines())))
