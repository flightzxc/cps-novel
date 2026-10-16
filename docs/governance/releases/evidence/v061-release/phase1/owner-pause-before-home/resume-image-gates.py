from pathlib import Path
import subprocess,sys,json
out=Path('.tmp/v061-release/phase1');runner=out/'run-step.py'
def step(name,*cmd):return subprocess.call([sys.executable,str(runner),name,*cmd])
assert step('docker-space-brand-owner-resume-1','docker','system','df')==0
name='brand-owner-resume-1'
rc=step(name,'/bin/bash','scripts/preproduction/verify-brand-image.sh')
if rc and 'ECONNRESET' in (out/(name+'.log')).read_text():
 assert step('docker-space-brand-owner-resume-econnreset-1','docker','system','df')==0
 name='brand-owner-resume-econnreset-1'
 rc=step(name,'/bin/bash','scripts/preproduction/verify-brand-image.sh')
assert rc==0,'brand image gate failed'
(out/'effective-brand.json').write_text(json.dumps({'brand-image':name})+'\n')
assert step('image-e2e','/bin/bash',str(out/'image-e2e.sh'))==0
print('IMAGE_GATES_RESUMED=PASS',flush=True)
