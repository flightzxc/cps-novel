from pathlib import Path
import subprocess,sys,json
out=Path('.tmp/v061-release/phase1');runner=out/'run-step.py'
def step(name,*cmd):return subprocess.call([sys.executable,str(runner),name,*cmd])
assert step('docker-space-home-resume','docker','system','df')==0
name='brand-econnreset-retry-home-resume'
rc=step(name,'/bin/bash','scripts/preproduction/verify-brand-image.sh')
assert rc==0,'resumed network retry failed; no additional retry authorized'
(out/'effective-brand.json').write_text(json.dumps({'brand-image':name})+'\n')
assert step('image-e2e','/bin/bash',str(out/'image-e2e.sh'))==0
print('HOME_IMAGE_GATES=PASS',flush=True)
