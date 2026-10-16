from pathlib import Path
import subprocess,sys,json
out=Path('.tmp/v061-release/phase1');runner=out/'run-step.py'
def step(name,*cmd):return subprocess.call([sys.executable,str(runner),name,*cmd])
rc=subprocess.call([sys.executable,str(out/'run-audit.py')]);assert rc==0
assert step('docker-space-brand','docker','system','df')==0
rc=step('brand-image','/bin/bash','scripts/preproduction/verify-brand-image.sh')
if rc and 'ECONNRESET' in (out/'brand-image.log').read_text():
 assert step('docker-space-brand-econnreset-retry','docker','system','df')==0
 rc=step('brand-image-econnreset-retry-1','/bin/bash','scripts/preproduction/verify-brand-image.sh')
 if rc==0:(out/'effective-brand.json').write_text(json.dumps({'brand-image':'brand-image-econnreset-retry-1'})+'\n')
assert rc==0,'brand image gate failed'
assert step('image-e2e','/bin/bash',str(out/'image-e2e.sh'))==0
print('IMAGE_AND_AUDIT_GATES=PASS',flush=True)
