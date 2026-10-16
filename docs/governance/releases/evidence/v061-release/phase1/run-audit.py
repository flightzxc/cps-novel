from pathlib import Path
import subprocess,sys,json
out=Path('.tmp/v061-release/phase1')
for name,extra in [('audit-production',['--omit=dev']),('audit-all',[])]:
 rc=subprocess.call([sys.executable,str(out/'run-step.py'),name,'npm','audit',*extra,'--json','--proxy','http://127.0.0.1:7899'])
 assert rc in [0,1]
 data=json.loads((out/(name+'.log')).read_text());assert 'metadata' in data,data.get('error',{}).get('code')
 v=data['metadata']['vulnerabilities'];assert v['critical']==0,v
 if name=='audit-production':
  assert v['high']==4,v
  assert {n for n,x in data['vulnerabilities'].items() if x['severity']=='high'}=={'@prisma/config','deepmerge-ts','effect','prisma'}
 print('AUDIT_GATE=PASS name='+name+' critical='+str(v['critical'])+' high='+str(v['high']),flush=True)
