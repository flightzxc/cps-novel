from pathlib import Path
import subprocess,json,hashlib,shlex,datetime
P=Path('.tmp/v061-release/phase3b');sample=json.loads((P/'public-result.json').read_text())['samples'][0]
remote=r'''import json,subprocess,sys,html,re,collections
from html.parser import HTMLParser
q="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_object_agg(a.id::text,p.upstream_code) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL; COMMIT;"
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=q,capture_output=True,text=True);assert r.returncode==0;codes=json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0];assert len(codes)==2035
print('{"ready":true}',flush=True)
o=json.loads(sys.stdin.readline());text=html.unescape(o['body']);text=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),text);matched={k:c for k,c in codes.items() if c in text}
class Scan(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.tag='';self.chunks=[]
 def handle_starttag(self,t,attrs):
  self.tag=t
  for a,v in attrs:
   if v:self.chunks.append((t+':'+a,v))
 def handle_data(self,d):self.chunks.append((self.tag+':data',d))
s=Scan();s.feed(text);categories=collections.Counter();lengths=collections.Counter();boundary=0;own=0;embedded=0
for k,c in matched.items():
 lengths[str(len(c))]+=1
 own+=k==o['articleId']
 for kind,v in s.chunks:
  if c in v:
   categories[kind]+=1
   boundary+=len(re.findall(r'(?<![A-Za-z0-9])'+re.escape(c)+r'(?![A-Za-z0-9])',v))
   embedded+=len(re.findall(r'[A-Za-z0-9]'+re.escape(c)+r'|'+re.escape(c)+r'[A-Za-z0-9]',v))
print(json.dumps({'checkedCodes':len(codes),'matchedCodes':len(matched),'ownCodeMatched':own,'otherCodesMatched':len(matched)-own,'codeLengthCounts':dict(lengths),'matchContexts':dict(categories),'boundedTokenMatches':boundary,'embeddedInLongerTokenMatches':embedded,'rawMatchingCodes':sum(c in o['body'] for c in codes.values()),'htmlUnescapeMatchingCodes':sum(c in html.unescape(o['body']) for c in codes.values()),'rawCodeValuesPrinted':0,'rawBodySaved':False}),flush=True)
'''
ssh=['ssh','-o','KexAlgorithms=curve25519-sha256','-o','BatchMode=yes','-o','ConnectTimeout=20','haiyue-vps'];p=subprocess.Popen(ssh+['python3 -u -c '+shlex.quote(remote)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
 assert json.loads(p.stdout.readline())['ready'];ledger=P/'external-requests.jsonl';n=len(ledger.read_text().splitlines());assert n<10
 with ledger.open('a') as f:f.write(json.dumps({'sequence':n+1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'read-only-leak-diagnostic','url':'https://pulsenovels.com'+sample['bookPath'],'proxy':'http://127.0.0.1:7899','followRedirects':False})+'\n')
 r=subprocess.run(['curl','--silent','--show-error','--proxy','http://127.0.0.1:7899','--noproxy','','--retry','0','--connect-timeout','15','--max-time','40','--write-out','\n__HTTP__%{http_code}','https://pulsenovels.com'+sample['bookPath']],capture_output=True);assert r.returncode==0
 body,status=r.stdout.rsplit(b'\n__HTTP__',1);assert status==b'200';p.stdin.write(json.dumps({'body':body.decode(),'articleId':sample['articleId']})+'\n');p.stdin.flush();x=json.loads(p.stdout.readline());p.wait(timeout=20);x.update(httpStatus=200,requests=n+1,bodySha256=hashlib.sha256(body).hexdigest());(P/'public-diagnostic-exact-normalization.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x))
finally:
 if p.poll() is None:p.terminate()
