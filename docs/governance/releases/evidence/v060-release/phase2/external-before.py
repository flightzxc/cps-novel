from pathlib import Path
import subprocess,json,hashlib,datetime,re
out=Path('.tmp/v060-release/phase2');baseline=json.loads((out/'baseline.json').read_text());code=baseline['counts']['sample']['public_redirect_code'];url='https://pulsenovels.com/go/'+code
ledger=out/'external-requests.jsonl';count=len(ledger.read_text().splitlines()) if ledger.exists() else 0;assert count<10
with ledger.open('a') as f:f.write(json.dumps({'sequence':count+1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'go-before','url':url})+'\n')
r=subprocess.run(['curl','--silent','--show-error','--proxy','http://127.0.0.1:7899','--noproxy','','--max-time','40','--dump-header','-','--output','/dev/null',url],capture_output=True);assert r.returncode==0,('curl exit',r.returncode)
headers=r.stdout.splitlines();statuses=[int(x.split()[1]) for x in headers if x.startswith(b'HTTP/')];loc=[x.split(b':',1)[1].strip() for x in headers if x.lower().startswith(b'location:')];assert statuses[-1]==302 and len(loc)==1
result={'status':statuses[-1],'locationSha256':hashlib.sha256(loc[0]).hexdigest(),'url':url,'proxy':'http://127.0.0.1:7899','followRedirects':False};(out/'go-before.json').write_text(json.dumps(result,indent=2)+'\n');print('GO_BEFORE='+json.dumps(result))
