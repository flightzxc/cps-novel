import os,sys,time,json,subprocess
from pathlib import Path
root=Path.cwd(); evidence=root/'.tmp/v0515-release/phase1'; evidence.mkdir(parents=True,exist_ok=True)
env=os.environ.copy()
for key in ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','npm_config_proxy','npm_config_https_proxy']:
 env[key]='http://127.0.0.1:7899'
env['NO_PROXY']=env['no_proxy']='localhost,127.0.0.1,::1'
env['NEXT_TELEMETRY_DISABLED']='1'
mode=sys.argv[1]
if mode=='deps': steps=[('npm-ci',['npm','ci']),('prisma-generate',['npx','--no-install','prisma','generate'])]
elif mode=='gates': steps=[('typecheck',['npm','run','typecheck']),('lint',['npm','run','lint']),('test-full',['npm','test','--','--maxWorkers=2','--reporter=default','--reporter=json','--outputFile='+str(evidence/'test-full.json')]),('build',['npm','run','build']),('audit-production',['npm','audit','--omit=dev','--json']),('audit-all',['npm','audit','--json'])]
elif mode=='runners':
 scripts=sorted(p for p in (root/'scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh')
 assert len(scripts)==36,len(scripts)
 steps=[(p.stem,['/bin/bash',str(p)]) for p in scripts]
elif mode=='extra': steps=[('b21',['/bin/bash','scripts/measure-tagging-task-memory.sh']),('nginx-matrix',['/bin/bash','scripts/preproduction/verify-nginx-matrix.sh']),('public-cutover-mutations',['node','scripts/preproduction/verify-public-cutover-mutations.mjs']),('docker-space-brand',['docker','system','df']),('brand-image',['/bin/bash','scripts/preproduction/verify-brand-image.sh'])]
elif mode=='one': steps=[(sys.argv[2],sys.argv[3:])]
else: raise SystemExit('unknown mode')
for name,cmd in steps:
 while os.getloadavg()[0]>=18:
  print(f'LOAD_WAIT task={name} load1={os.getloadavg()[0]:.2f} threshold=18',flush=True);time.sleep(15)
 print(f'START={name} load1={os.getloadavg()[0]:.2f}',flush=True)
 start=time.time(); log=evidence/(name+'.log')
 if log.exists(): raise SystemExit('refuse to overwrite '+str(log))
 with log.open('wb') as f: rc=subprocess.run(cmd,env=env,stdout=f,stderr=subprocess.STDOUT).returncode
 end=time.time(); metadata={'name':name,'command':cmd,'startedAt':start,'finishedAt':end,'durationSeconds':end-start,'exitCode':rc}
 (evidence/(name+'.meta.json')).write_text(json.dumps(metadata,indent=2)+'\n')
 print(f'END={name} exit={rc} duration={end-start:.1f} log={log}',flush=True)
 if name.startswith('audit-'):
  data=json.loads(log.read_text()); vulns=data['metadata']['vulnerabilities']; assert vulns['critical']==0,vulns
  if name=='audit-production':
   assert vulns['high']==4,vulns
   names={n for n,v in data['vulnerabilities'].items() if v['severity']=='high'}
   assert names=={'@prisma/config','deepmerge-ts','effect','prisma'},names
  print(f'AUDIT_GATE=PASS name={name} vulnerabilities={vulns}',flush=True)
 elif rc:
  print(log.read_text(errors='replace')[-12000:],flush=True)
  raise SystemExit(rc)
