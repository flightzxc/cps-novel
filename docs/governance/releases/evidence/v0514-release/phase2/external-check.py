import subprocess,json,pathlib,sys,re,datetime
from html.parser import HTMLParser
p=pathlib.Path(__file__).parent
class Parser(HTMLParser):
 def __init__(self): super().__init__();self.links=[];self.header=0;self.header_links=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='header':self.header+=1
  if tag=='link' and a.get('rel') in ('canonical','alternate'):self.links.append(a)
  if tag=='a' and self.header and a.get('href'):self.header_links.append(a['href'])
 def handle_endtag(self,tag):
  if tag=='header':self.header=max(0,self.header-1)
def request(name,path):
 ledger=p/'external-requests.json';rows=json.loads(ledger.read_text()) if ledger.exists() else []
 assert len(rows)<10,'External request budget exhausted'
 row={'number':len(rows)+1,'name':name,'url':'https://pulsenovels.com'+path,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'proxy':'http://127.0.0.1:7899'}
 rows.append(row);ledger.write_text(json.dumps(rows,indent=2)+'\n')
 out=subprocess.run(['curl','--silent','--show-error','--max-time','40','--proxy',row['proxy'],'--output',str(p/(name+'.html')),'--write-out','%{http_code} %{url_effective} %{num_redirects}',row['url']],capture_output=True,text=True)
 row.update({'exit':out.returncode,'result':out.stdout,'stderr':out.stderr});ledger.write_text(json.dumps(rows,indent=2)+'\n');assert out.returncode==0,out.stderr
 status,effective,redirects=out.stdout.split();assert redirects=='0'
 h=p.joinpath(name+'.html').read_text();a=Parser();a.feed(h)
 r={'name':name,'url':effective,'status':int(status),'seo':a.links,'headerLinks':a.header_links,'searchHeaderLinks':[x for x in a.header_links if re.search(r'(^|/)search(?:[/?#]|$)',x)]}
 p.joinpath(name+'.json').write_text(json.dumps(r,indent=2,ensure_ascii=False)+'\n');print(json.dumps(r,ensure_ascii=False));return h,r
if sys.argv[1]=='before':
 h,r=request('before-home','/');assert r['status']==200
 novels=re.findall(r'href="(/novel/[^"?#]+)"',h);assert novels,'No published novel URL'
 novel=novels[0];p.joinpath('frozen-pages.json').write_text(json.dumps({'category':'/category/female-audience','novel':novel},indent=2)+'\n')
 for kind,path in json.loads(p.joinpath('frozen-pages.json').read_text()).items():
  h,r=request('before-'+kind,path);assert r['status']==200 and any(x.get('rel')=='canonical' for x in r['seo'])
else:
 h,r=request('after-search','/search');assert r['status']==404
 h,r=request('after-home','/');assert r['status']==200 and not r['searchHeaderLinks'];assert '<header' in h
 for kind,path in json.loads(p.joinpath('frozen-pages.json').read_text()).items():
  h,r=request('after-'+kind,path);b=json.loads(p.joinpath('before-'+kind+'.json').read_text());assert r['status']==200 and (r['url'],r['seo'])==(b['url'],b['seo']),kind+' URL/SEO drift'
 print('EXTERNAL_ACCEPTANCE=PASS requests='+str(len(json.loads(p.joinpath('external-requests.json').read_text()))))
