from pathlib import Path
import subprocess,sys,json,time
out=Path('.tmp/v061-release/phase1');runner=out/'run-step.py'
scripts=sorted(p for p in Path('scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh');assert len(scripts)==37
passed={}
for p in scripts:
 meta=out/(p.stem+'.meta.json')
 if meta.exists() and json.loads(meta.read_text())['exitCode']==0:passed[p.stem]=p.stem
assert len(passed)==9
remaining=[p for p in scripts if p.stem not in passed];assert len(remaining)==28
for p in remaining:
 if p.stem=='run-p1-05b-postgres-verification':
  for attempt in range(1,4):
   if attempt>1:
    deadline=time.time()+300;print('P1_05B_NETWORK_WAIT=300_SECONDS attempt='+str(attempt),flush=True)
    while time.time()<deadline:time.sleep(min(15,max(0,deadline-time.time())))
   name=p.stem+'-network-retry-'+str(attempt)
   rc=subprocess.call([sys.executable,str(runner),name,'/bin/bash',str(p)])
   if rc==0:passed[p.stem]=name;break
   log=(out/(name+'.log')).read_text()
   if not ('registry-1.docker.io/v2/' in log and 'EOF' in log):print('RUNNER_NON_NETWORK_FAILURE='+name,flush=True);sys.exit(rc)
  else:print('P1_05B_NETWORK_RETRIES_EXHAUSTED=3',flush=True);sys.exit(1)
 else:
  name=p.stem;rc=subprocess.call([sys.executable,str(runner),name,'/bin/bash',str(p)])
  if rc:print('RUNNER_STOP='+name,flush=True);sys.exit(rc)
  passed[p.stem]=name
 (out/'effective-runners.json').write_text(json.dumps(passed,indent=2)+'\n')
 print('RUNNER_PROGRESS='+str(len(passed))+'/37',flush=True)
print('RUNNERS_ALL=PASS count=37',flush=True)
for name,cmd in [('compose',['/bin/bash',str(out/'compose-check.sh')]),('b21',['/bin/bash','scripts/measure-tagging-task-memory.sh']),('nginx-matrix',['/bin/bash','scripts/preproduction/verify-nginx-matrix.sh']),('public-cutover-mutations',['node','scripts/preproduction/verify-public-cutover-mutations.mjs'])]:
 rc=subprocess.call([sys.executable,str(runner),name,*cmd])
 if rc:print('EXTRA_GATE_STOP='+name,flush=True);sys.exit(rc)
print('RELEASE_NON_IMAGE_GATES=PASS',flush=True)
