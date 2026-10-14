from pathlib import Path
import subprocess
out=Path('.tmp/v060-release/phase2')
for name,script in [('pull-deploy','pull-deploy.py'),('step0','step0.py'),('post-before-probe','post-check-v060.py'),('expected-denial','permission-negative.py')]:
 subprocess.run(['python3',str(out/'run.py'),name,'python3',str(out/'remote-script-client.py'),str(out/script)],check=True)
 print('PHASE2_STAGE_PASS='+name,flush=True)
subprocess.run(['python3',str(out/'run.py'),'external-after','python3',str(out/'external-after.py')],check=True)
subprocess.run(['python3',str(out/'run.py'),'post-final','python3',str(out/'remote-script-client.py'),str(out/'post-check-v060.py')],check=True)
print('PHASE2_ACCEPTANCE=PASS')
