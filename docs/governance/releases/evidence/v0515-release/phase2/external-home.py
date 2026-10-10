from pathlib import Path
import subprocess,json,sys,datetime
from html.parser import HTMLParser
phase=Path('.tmp/v0515-release/phase2');label=sys.argv[1];assert label in ['before','after'];ledger=phase/'external-requests.json';rows=json.loads(ledger.read_text()) if ledger.exists() else [];assert len(rows)<10;assert not any(r['label']==label for r in rows)
rows.append({'label':label,'url':'https://pulsenovels.com/','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'proxy':'http://127.0.0.1:7899','retry':0,'redirects':False});ledger.write_text(json.dumps(rows,indent=2)+'\n')
result=subprocess.run(['curl','--proxy','http://127.0.0.1:7899','--silent','--show-error','--fail','--connect-timeout','20','--max-time','60','--dump-header',str(phase/(label+'-home.headers')),'--output',str(phase/(label+'-home.html')),'https://pulsenovels.com/']);assert result.returncode==0,result.returncode
class Nav(HTMLParser):
 def __init__(self):super().__init__();self.active=False;self.count=0;self.slugs=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='nav' and a.get('data-testid')=='home-category-nav':self.active=True;self.count+=1
  if self.active and tag=='a':
   href=a['href'];assert href.startswith('/category/'),href;self.slugs.append(href[len('/category/'):])
 def handle_endtag(self,tag):
  if tag=='nav':self.active=False
parser=Nav();parser.feed((phase/(label+'-home.html')).read_text());assert parser.count==1 and parser.slugs and parser.slugs[0]=='adventure'
(phase/(label+'-home-nav.json')).write_text(json.dumps({'count':len(parser.slugs),'slugs':parser.slugs},indent=2)+'\n')
if label=='after':assert parser.slugs==json.loads((phase/'before-home-nav.json').read_text())['slugs'];print('HOMEPAGE_NAV_ZERO_CHANGE=PASS')
print('HOME_NAV='+json.dumps({'label':label,'count':len(parser.slugs),'first':parser.slugs[0],'slugs':parser.slugs}));print('EXTERNAL_REQUEST_COUNT='+str(len(rows)))
