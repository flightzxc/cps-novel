from pathlib import Path
from html.parser import HTMLParser
import subprocess,json,datetime,re,hashlib,html,shlex,sys
SITE='https://pulsenovels.com';PROXY='http://127.0.0.1:7899';P=Path('.tmp/v061-release/phase3b-resume')
coverage=json.loads(Path('.tmp/v061-release/phase3b/coverage-final.json').read_text());SAMPLES=coverage['samples'];ledger=P/'external-requests.jsonl';results=[];checker=None
class Stop(Exception):pass
class Node:
 def __init__(self,tag='',attrs=None):self.tag=tag;self.attrs=dict(attrs or []);self.children=[]
 def nodes(self):
  yield self
  for c in self.children:
   if isinstance(c,Node):yield from c.nodes()
 def text(self):
  if self.tag in ('script','style','template'):return ''
  return ' '.join(c.text() if isinstance(c,Node) else c for c in self.children)
 def norm(self):return ' '.join(self.text().split())
class DOM(HTMLParser):
 def __init__(self,body):
  super().__init__(convert_charrefs=True);self.root=Node();self.stack=[self.root];self.feed(body);self.close()
 def handle_starttag(self,t,a):
  n=Node(t,a);self.stack[-1].children.append(n)
  if t not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:self.stack.append(n)
 def handle_startendtag(self,t,a):self.handle_starttag(t,a);self.handle_endtag(t)
 def handle_endtag(self,t):
  for i in range(len(self.stack)-1,0,-1):
   if self.stack[i].tag==t:self.stack=self.stack[:i];break
 def handle_data(self,d):self.stack[-1].children.append(d)
 def nodes(self):return list(self.root.nodes())
 def tid(self,s):return [n for n in self.nodes() if n.attrs.get('data-testid')==s]
 def anchors(self):return [n for n in self.nodes() if n.tag=='a']

def check(ok,reason):
 if not ok:raise Stop(reason)
def save(status='RUNNING',reason=None):
 (P/'public-result.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':status,'reason':reason,'samples':SAMPLES,'results':results,'requests':len(ledger.read_text().splitlines()) if ledger.exists() else 0,'stageCumulativeRequests':3+(len(ledger.read_text().splitlines()) if ledger.exists() else 0),'rawBodiesSaved':False,'upstreamCodesSaved':False,'redirectsFollowed':False,'retries':0},ensure_ascii=False,indent=2)+'\n')
def get(url,kind,a):
 check(url.startswith(SITE+'/'),'origin');count=len(ledger.read_text().splitlines()) if ledger.exists() else 0;check(count<9 and 3+count<12,'request_budget')
 row={'sequence':count+1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'GET','url':url,'kind':kind,'articleId':a['articleId'],'proxy':PROXY,'followRedirects':False}
 with ledger.open('a') as f:f.write(json.dumps(row)+'\n')
 r=subprocess.run(['curl','--silent','--show-error','--include','--suppress-connect-headers','--compressed','--request','GET','--proxy',PROXY,'--noproxy','','--retry','0','--connect-timeout','15','--max-time','40',url],stdin=subprocess.DEVNULL,capture_output=True)
 check(r.returncode==0,'transport_'+str(r.returncode));data=r.stdout
 while True:
  sep=b'\r\n\r\n';i=data.find(sep)
  if i<0:sep=b'\n\n';i=data.find(sep)
  check(i>=0,'headers');head=data[:i].decode('iso-8859-1');body=data[i+len(sep):];m=re.match(r'HTTP/\S+ (\d{3})',head.splitlines()[0]);check(bool(m),'status');status=int(m[1])
  if 100<=status<200:data=body;continue
  break
 h={}
 for line in head.splitlines()[1:]:
  if ':' in line:k,v=line.split(':',1);h[k.lower().strip()]=v.strip()
 e={**row,'status':status,'checks':{}};results.append(e);save();return status,h,body.decode('utf8'),e
def secret(body,kind='html',a=None,card=None):
 obj={'body':body,'kind':kind,'articleId':a['articleId'] if a else None,'card':card,'sequence':len(ledger.read_text().splitlines())};checker.stdin.write(json.dumps(obj)+'\n');checker.stdin.flush();x=json.loads(checker.stdout.readline());check(not x.get('error'),'secret_checker');evidence={'sequence':len(ledger.read_text().splitlines()),'kind':kind,'articleId':a['articleId'] if a else None,'result':x};
 with (P/'boundary-scans.jsonl').open('a') as f:f.write(json.dumps(evidence)+'\n')
 return x
try:
 with (P/'public-started.json').open('x') as f:json.dump({'samples':SAMPLES,'maxRequests':9},f)
 remote=(P/'secret-checker.py').read_text();checker=subprocess.Popen(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','BatchMode=yes','-o','ConnectTimeout=20','haiyue-vps','python3 -u -c '+shlex.quote(remote)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
 hello=json.loads(checker.stdout.readline());check(hello.get('protectedCodes')==coverage['publishedTotal'],'secret_scope')
 for a in SAMPLES:
  status,h,body,e=get(SITE+a['bookPath'],'book',a);check(status==200,'book_status');dom=DOM(body);go='/go/'+a['goCode'];anchors=[n for n in dom.anchors() if n.norm()=='Read on PlotNovel App'];check(anchors and all(n.attrs.get('href')==go for n in anchors),'book_cta');check('Free app · your book code is on the next page' in dom.root.norm(),'book_hint');canonical=[n.attrs.get('href') for n in dom.nodes() if n.tag=='link' and n.attrs.get('rel')=='canonical'];check(canonical==[SITE+a['bookPath']],'book_canonical');leak=secret(body,'html',a);e['checks']['boundaryScan']=leak;save();check(leak['forbiddenBoundaryOccurrences']==0,'book_upstream_code_leak');e['checks']={'cta':True,'hint':True,'canonicalMatches':True,'forbiddenBoundaryOccurrences':0,'accidentalCoincidenceOccurrences':leak['accidentalCoincidenceOccurrences'],'boundaryScan':leak};save()
  status,h,body,e=get(SITE+go,'go',a);check(status==302 and h.get('location')==go+'/app','go_relative_302');leak=secret(body+'\n'+h.get('location',''),'location',a);e['checks']={'relativeLocationMatches':True,'redirectFollowed':False,'boundaryScan':leak};save();check(leak['forbiddenBoundaryOccurrences']==0,'go_upstream_code_leak')
  status,h,body,e=get(SITE+go+'/app','interstitial',a);check(status==200 and 'no-store' in h.get('cache-control','').lower(),'app_status_cache');dom=DOM(body);cards=dom.tid('code-mode-code');check(len(cards)==1 and cards[0].norm(),'code_card');leak=secret(body,'interstitial',a,cards[0].norm());e['checks']['boundaryScan']=leak;save();check(leak['codeCardMatches'] and leak['ownCodePresent'] and leak['forbiddenBoundaryOccurrences']==0,'app_code_identity')
  robots=[n.attrs.get('content','').lower() for n in dom.nodes() if n.tag=='meta' and n.attrs.get('name','').lower()=='robots'];check(any('noindex' in x for x in robots),'app_noindex');stores={n.attrs.get('href'):n.norm() for n in dom.anchors()};check(stores.get('https://apps.apple.com/app/plotnovel/id6749878264')=='Download on the App Store' and stores.get('https://play.google.com/store/apps/details?id=com.plot.novel_app')=='Get it on Google Play','app_stores');check(not re.search(r'third[- ]party|commission|disclaimer|not affiliated',dom.root.norm(),re.I),'app_disclaimer');e['checks']={'noStore':True,'noindex':True,'codeCardMatches':True,'stores':True,'disclaimerMatches':0,'forbiddenBoundaryOccurrences':0,'accidentalCoincidenceOccurrences':leak['accidentalCoincidenceOccurrences'],'boundaryScan':leak};save();print('SAMPLE_PASS='+a['articleId'],flush=True)
 check(len(results)==9,'request_total');save('PASS');print('BULK_PUBLIC_ACCEPTANCE=PASS REQUESTS=9',flush=True)
except Stop as e:save('STOP',str(e));print('BULK_PUBLIC_ACCEPTANCE=STOP CHECK='+str(e),flush=True);sys.exit(1)
except Exception as e:save('WRAPPER_ERROR',type(e).__name__);print('PUBLIC_WRAPPER_ERROR='+type(e).__name__,flush=True);sys.exit(2)
finally:
 if checker:
  try:checker.stdin.write('{"kind":"quit"}\n');checker.stdin.flush();checker.stdin.close();checker.wait(timeout=10)
  except Exception:checker.terminate()
