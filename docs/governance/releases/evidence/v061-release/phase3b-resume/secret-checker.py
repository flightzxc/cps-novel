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


"""One-off read-only public checker. Receives protected codes in memory only."""
import re,json,html,collections
from html.parser import HTMLParser

def normalize(text):
 text=html.unescape(text)
 return re.sub(re.escape(chr(92)+'u')+r'([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),text)
def mask_digits(value):return re.sub('[0-9]','#',value)
def boundary(code):return re.compile(r'(?<![0-9])'+re.escape(code)+r'(?![0-9])')
class Positions(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.stack=[];self.chunks=[]
 def handle_starttag(self,tag,attrs):
  for name,value in attrs:
   if value:self.chunks.append(({'positionCategory':'attribute','attributeName':mask_digits(name),'tag':mask_digits(tag)},value))
  if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:self.stack.append(tag)
 def handle_startendtag(self,tag,attrs):self.handle_starttag(tag,attrs);self.handle_endtag(tag)
 def handle_endtag(self,tag):
  if tag in self.stack:self.stack=self.stack[:len(self.stack)-1-self.stack[::-1].index(tag)]
 def handle_comment(self,data):self.chunks.append(({'positionCategory':'html_comment','tag':'comment'},data))
 def handle_data(self,data):
  tag=self.stack[-1] if self.stack else ''
  self.chunks.append(({'positionCategory':'script_json' if tag=='script' else 'style' if tag=='style' else 'visible_text','tag':mask_digits(tag)},data))
def script_key(text,offset):
 # Only expose a key name, never its value or the surrounding JSON.
 keys=list(re.finditer(r'"([A-Za-z0-9_.:-]{1,100})"\s*:',text[:offset].replace(chr(92)+'"','"')))
 return mask_digits(keys[-1][1]) if keys else 'unresolved'
def scan(codes,body,kind='html',article_id=None,card=None):
 normalized=normalize(body);parsed=Positions()
 if kind!='location':parsed.feed(normalized)
 else:parsed.chunks=[({'positionCategory':'attribute','attributeName':'Location','tag':'http_header'},normalized)]
 contexts=[];boundary_total=0;forbidden=0;accidental=0;allowed=0;matched_values=set();accidental_values=set()
 for owner,code in codes.items():
  pat=boundary(code);hits=list(pat.finditer(normalized));total=len(list(re.finditer(re.escape(code),normalized)));embedded=total-len(hits);accidental+=embedded
  if embedded:accidental_values.add(code)
  if not hits:continue
  matched_values.add(code);boundary_total+=len(hits);permitted=kind=='interstitial' and owner==article_id
  if permitted:allowed+=len(hits)
  else:forbidden+=len(hits)
  for position,text in parsed.chunks:
   for hit in pat.finditer(text):
    c={'ownership':'self' if owner==article_id else 'other','allowedOwnInterstitial':permitted,**position}
    if c['positionCategory']=='script_json':c['scriptJsonKey']=script_key(text,hit.start())
    contexts.append(c)
 # Retain only metadata with all digits masked in names. No excerpt or code value.
 out={'checkedCodes':len(codes),'matchingRule':'(?<![0-9])CODE(?![0-9])','boundaryOccurrences':boundary_total,'boundaryMatchingCodeValues':len(matched_values),'forbiddenBoundaryOccurrences':forbidden,'allowedOwnInterstitialOccurrences':allowed,'accidentalCoincidenceOccurrences':accidental,'accidentalCoincidenceCodeValues':len(accidental_values),'boundaryContexts':contexts,'rawCodeValuesPrinted':0}
 if kind=='interstitial':out.update(codeCardMatches=card==codes.get(article_id),ownCodePresent=bool(boundary(codes[article_id]).search(normalized)))
 # On a forbidden hit, redact EVERY protected code substring, including embedded
 # coincidences, from normalized HTML before any persistence.
 snapshot=None
 if forbidden:
  snapshot=normalized
  for code in sorted(set(codes.values()),key=len,reverse=True):snapshot=snapshot.replace(code,'[CODE]')
  snapshot=re.sub(r'0x4[A-Za-z0-9_-]+','[TURNSTILE_REDACTED]',snapshot)
  assert not any(code in snapshot for code in codes.values())
 return out,snapshot

import sys,hashlib
protect()
codes=sql("SELECT json_object_agg(a.id::text,p.upstream_code) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL;")
assert len(codes)==2035 and all(re.fullmatch('[0-9]{6}',c) for c in codes.values()),'code_scope_or_shape_changed'
emit({'protectedCodes':len(codes),'sixDigitNumericCodes':len(codes)})
for line in sys.stdin:
 try:
  obj=json.loads(line)
  if obj.get('kind')=='quit':break
  result,snapshot=scan(codes,obj['body'],obj.get('kind','html'),obj.get('articleId'),obj.get('card'))
  if snapshot is not None:
   folder=OUT/'sanitized-html';folder.mkdir(mode=0o700,exist_ok=True);name='request-'+str(obj['sequence'])+'-'+obj['kind']+'.html';p=folder/name
   with p.open('x') as f:f.write(snapshot)
   p.chmod(0o600);result['sanitizedHtml']={'path':str(p),'sha256':hashlib.sha256(snapshot.encode()).hexdigest(),'allProtectedCodesRedacted':True}
  else:result['sanitizedHtml']=None
  emit(result)
 except Exception:emit({'error':'boundary_checker_failed'});sys.exit(1)
