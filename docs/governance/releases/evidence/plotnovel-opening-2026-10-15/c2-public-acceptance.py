from pathlib import Path
import json,subprocess,datetime,re,hashlib,shlex,html,sys,xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit
P=Path('.tmp/plotnovel-opening-2026-10-15');SITE='https://pulsenovels.com';PROXY='http://127.0.0.1:7899'
LEDGER=P/'external-requests.jsonl';RESULT=P/'c2-public-result.json';RESUME=P/'c2-http-cache-free-state.json'
SAMPLES=json.loads((P/'c2-samples.json').read_text());BATCH=json.loads((P/'c2-batch-readback.json').read_text())['articles']
LABEL='Read on PlotNovel App';HINT='Free app · your book code is on the next page'
APPSTORE='https://apps.apple.com/app/plotnovel/id6749878264';PLAYSTORE='https://play.google.com/store/apps/details?id=com.plot.novel_app'
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
def bookurl(a):return SITE+'/novel/'+a['slug']+'-p'+a['public_page_short_id']
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
results=[];checker=None;current=None
state={'startedAt':stamp(),'samples':[a['article_id'] for a in SAMPLES],'results':results,'status':'RUNNING','rawBodiesSaved':False,'redirectsFollowed':False,'retries':0}
def save():
 state['requestCount']=len(LEDGER.read_text().splitlines());RESULT.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
def check(ok,name):
 if not ok:raise Stop(name)
def get(url,kind,article=None):
 global current
 check(urlsplit(url).netloc=='pulsenovels.com' and urlsplit(url).scheme=='https','request_origin')
 entries=[json.loads(l) for l in LEDGER.read_text().splitlines() if l.strip()];check(len(entries)<30,'request_budget')
 current={'sequence':len(entries)+1,'at':stamp(),'kind':kind,'method':'GET','url':url,'proxy':PROXY,'followRedirects':False}
 if article:current['articleId']=article['article_id']
 with LEDGER.open('a') as f:f.write(json.dumps(current,ensure_ascii=False)+'\n');f.flush()
 r=subprocess.run(['curl','--silent','--show-error','--include','--suppress-connect-headers','--compressed','--request','GET','--proxy',PROXY,'--noproxy','','--retry','0','--connect-timeout','15','--max-time','40',url],stdin=subprocess.DEVNULL,capture_output=True)
 check(r.returncode==0,'http_transport_exit_'+str(r.returncode))
 data=r.stdout
 while True:
  sep=b'\r\n\r\n';pos=data.find(sep)
  if pos<0:sep=b'\n\n';pos=data.find(sep)
  check(pos>=0,'http_headers_parse');head=data[:pos].decode('iso-8859-1');body=data[pos+len(sep):]
  first=head.splitlines()[0];m=re.match(r'HTTP/\S+ (\d{3})',first);check(bool(m),'http_status_parse');status=int(m[1])
  if 100<=status<200:data=body;continue
  break
 headers={}
 for row in head.splitlines()[1:]:
  if ':' in row:
   key,val=row.split(':',1);headers[key.lower().strip()]=val.strip()
 entry={'sequence':current['sequence'],'kind':kind,'url':url,'status':status,'checks':{}}
 if article:entry['articleId']=article['article_id']
 results.append(entry);save()
 return status,headers,body.decode('utf8'),entry
def protect(body,kind='html',a=None,card=None):
 obj={'kind':kind,'body':body}
 if a:obj['articleId']=a['article_id']
 if card is not None:obj['card']=card
 checker.stdin.write(json.dumps(obj)+'\n');checker.stdin.flush();line=checker.stdout.readline()
 out=json.loads(line);check(not out.get('error'),'secret_checker');check(out.get('checkedCodes')==50,'secret_checker_scope')
 return out
def cta(dom,a):
 go='/go/'+a['go_code'];anchors=[n for n in dom.anchors() if n.norm()==LABEL]
 check(bool(anchors) and all(n.attrs.get('href')==go for n in anchors),'cta_label_and_href')
 check(HINT in dom.root.norm(),'cta_hint')
 return {'ctaLabel':LABEL,'ctaHint':HINT,'ctaAnchors':len(anchors),'stationHrefMatches':True}
try:
 # Exclusive marker prevents accidental full replay and HTTP budget reuse.
 with (P/'c2-public-started.json').open('x') as f:json.dump({'at':stamp(),'fixedSamples':[a['article_id'] for a in SAMPLES]},f)
 remote=(P/'remote-common-c.py').read_text()+'\n'+(P/'c2-secret-checker.py').read_text()
 checker=subprocess.Popen(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','haiyue-vps','python3 -u -c '+shlex.quote(remote)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
 context=checker.stdout.readline();check(context.startswith('REMOTE_CONTEXT='),'checker_remote_context')
 hello=json.loads(checker.stdout.readline());check(hello=={'ready':True,'protectedCodes':50},'checker_ready')
 chapterUrls={}
 for a in SAMPLES:
  u=bookurl(a);status,h,body,e=get(u,'plotnovel-book-article',a);check(status==200,'book_status')
  dom=DOM(body);c=cta(dom,a);links=[n.attrs.get('href') for n in dom.nodes() if n.tag=='link' and n.attrs.get('rel')=='canonical'];check(links==[u],'book_canonical')
  chapters=[urljoin(u,n.attrs['href']) for n in dom.tid('chapter-list-link')];check(len(chapters)==3 and len(set(chapters))==3 and all(x.startswith(u+'/chapter/') for x in chapters),'book_three_preview_links')
  chapterUrls[a['article_id']]=chapters
  leak=protect(body);check(leak['leakMatchingLines']==0,'book_code_leak');e['checks'].update(c,canonicalMatches=True,previewChapterLinks=3,upstreamCodeMatchingLines=0);save()
  status,h,body,e=get(chapters[0],'plotnovel-preview-chapter',a);check(status==200,'chapter_status');dom=DOM(body);c=cta(dom,a)
  reader=dom.tid('reader-body');check(len(reader)==1 and bool(reader[0].norm()),'chapter_nonempty_reader')
  leak=protect(body);check(leak['leakMatchingLines']==0,'chapter_code_leak');e['checks'].update(c,readerNonempty=True,upstreamCodeMatchingLines=0);save()
  go=SITE+'/go/'+a['go_code'];status,h,body,e=get(go,'plotnovel-go',a);check(status==302,'go_status');check(h.get('location')=='/go/'+a['go_code']+'/app','go_relative_location');e['checks'].update(relativeLocationMatches=True,noFollow=True);save()
  status,h,body,e=get(go+'/app','plotnovel-interstitial',a);check(status==200,'interstitial_status');check('no-store' in h.get('cache-control','').lower(),'interstitial_no_store');dom=DOM(body)
  roots=dom.tid('code-mode-interstitial');check(len(roots)==1,'interstitial_root');card=dom.tid('code-mode-code');check(len(card)==1 and bool(card[0].norm()),'interstitial_card')
  leak=protect(body,'interstitial',a,card[0].norm());check(leak['codeCardMatches'] and leak['ownCodePresent'] and leak['leakMatchingLines']==0,'interstitial_code_identity')
  robots=[n.attrs.get('content','') for n in dom.nodes() if n.tag=='meta' and n.attrs.get('name','').lower()=='robots'];check(any(set(re.split(r'\s*,\s*',v.lower()))=={'noindex','nofollow','nocache'} for v in robots),'interstitial_robots')
  copy=dom.tid('code-mode-copy');check(len(copy)==1 and copy[0].norm()=='Copy code','interstitial_copy_button')
  steps=dom.tid('code-mode-steps');check(len(steps)==1,'interstitial_steps');items=[n for n in steps[0].nodes() if n.tag=='li'];expected=['Copy the code above.','Get the free PlotNovel app.','Open the app, tap Search and paste the code. The book opens right away.'];check(len(items)==3 and all(text in n.norm() for n,text in zip(items,expected)),'interstitial_three_steps')
  store=dom.tid('code-mode-store-links');check(len(store)==1,'interstitial_store_container');buttons={n.attrs.get('href'):n.norm() for n in store[0].nodes() if n.tag=='a'};check(buttons.get(APPSTORE)=='Download on the App Store' and buttons.get(PLAYSTORE)=='Get it on Google Play','interstitial_store_buttons')
  text=dom.root.norm();disclaimer=len(re.findall(r'third[- ]party|commission|disclaimer|not affiliated',text,re.I));check(disclaimer==0,'interstitial_disclaimer')
  e['checks'].update(cacheControlNoStore=True,robots=['noindex','nofollow','nocache'],codeCardMatchesDatabase=True,copyButton='Copy code',steps=expected,appStoreLinkMatches=True,googlePlayLinkMatches=True,disclaimerMatches=0,otherUpstreamCodeMatchingLines=0);save()
  print('FIXED_SAMPLE_PASS='+a['article_id'],flush=True)
 # Verify unchanged MoboReader redirect, hash-only.
 status,h,body,e=get(SITE+'/go/hpsuxf95w4','moboreader-go-after');digest=hashlib.sha256(h.get('location','').encode()).hexdigest();check(status==302 and digest=='cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5','moboreader_redirect_unchanged');e['checks'].update(locationSha256=digest,baselineMatches=True);save()
 # Only fetch index and deduplicated shards preselected by readonly coverage.
 log=(P/'35a-c2-sitemap-coverage.log').read_text();plan=json.loads(next(l.split('=',1)[1] for l in log.splitlines() if l.startswith('C2_SITEMAP_PLAN=')))
 status,h,body,e=get(SITE+'/sitemap.xml','sitemap-index');check(status==200,'sitemap_index_status');root=ET.fromstring(body);locs=[n.text for n in root.iter() if n.tag.endswith('}loc') or n.tag=='loc'];leak=protect(body);check(leak['leakMatchingLines']==0,'sitemap_index_code_leak');check(not any('/go/' in x for x in locs),'sitemap_index_go_leak');e['checks'].update(upstreamCodeMatchingLines=0,goUrlCount=0);save()
 for shard in plan['sampleSitemaps']:
  matches=[x for x in locs if urlsplit(x).path.endswith('/'+shard['fileName'])];check(len(matches)==1,'sitemap_shard_in_index')
  status,h,body,e=get(matches[0],'sitemap-related-shard');check(status==200,'sitemap_shard_status');root=ET.fromstring(body);urls={n.text for n in root.iter() if n.tag.endswith('}loc') or n.tag=='loc'};leak=protect(body);check(leak['leakMatchingLines']==0,'sitemap_shard_code_leak');check(not any('/go/' in x for x in urls),'sitemap_shard_go_leak')
  for sampleUrl in shard['sampleUrls']:
   a=next(a for a in SAMPLES if bookurl(a)==sampleUrl);check(sampleUrl in urls and all(x in urls for x in chapterUrls[a['article_id']]),'sitemap_sample_book_and_three_chapters')
  e['checks'].update(upstreamCodeMatchingLines=0,goUrlCount=0,sampleBooksCovered=len(shard['sampleUrls']),sampleChaptersCovered=3*len(shard['sampleUrls']));save()
 status,h,body,e=get(SITE+'/','homepage');check(status==200,'homepage_status');dom=DOM(body);heroes=dom.tid('featured-hero');check(len(heroes)==1,'homepage_carousel_present');allbookurls={bookurl(a) for a in BATCH};heroLinks=[urljoin(SITE,n.attrs.get('href','')) for n in heroes[0].nodes() if n.tag=='a'];plotMatches=sum(u in allbookurls for u in heroLinks);check(plotMatches==0 and 'PlotNovel' not in heroes[0].norm(),'homepage_carousel_plot_exclusion');leak=protect(body);check(leak['leakMatchingLines']==0,'homepage_code_leak');e['checks'].update(carouselPresent=True,plotnovelCarouselMatches=0,upstreamCodeMatchingLines=0);save()
 state.update(status='PASS',completedAt=stamp(),fixedSamplesPassed=5,sampledChapterUrls=chapterUrls);save();check(state['requestCount']==29,'expected_request_total')
 print('C2_PUBLIC_ACCEPTANCE=PASS REQUESTS='+str(state['requestCount']),flush=True)
except Stop as exc:
 state.update(status='STOP',failedCheck=str(exc),stoppedAt=stamp(),failedSequence=current['sequence'] if current else None);save();print('C2_PUBLIC_ACCEPTANCE=STOP CHECK='+str(exc)+' REQUESTS='+str(state['requestCount']),flush=True);sys.exit(1)
except Exception as exc:
 state.update(status='WRAPPER_ERROR',errorType=type(exc).__name__,stoppedAt=stamp(),failedSequence=current['sequence'] if current else None);save();print('C2_PUBLIC_WRAPPER_ERROR='+type(exc).__name__+' REQUESTS='+str(state['requestCount']),flush=True);sys.exit(2)
finally:
 if checker:
  try:checker.stdin.write('{"kind":"quit"}\n');checker.stdin.flush();checker.stdin.close();checker.wait(timeout=10)
  except Exception:checker.terminate()
