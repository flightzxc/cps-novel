from pathlib import Path
import subprocess,json
out=Path('.tmp/v060-release/phase2');assert json.loads((out/'upload.meta.json').read_text())['exitCode']==0 and json.loads((out/'backup.meta.json').read_text())['exitCode']==0
for name,script in [('remote-artifacts','remote-artifacts.py'),('predeploy-readiness','predeploy-readiness.py'),('env-two-lines','env-v060.py'),('launch-deploy','launch-deploy.py')]:
 subprocess.run(['python3',str(out/'run.py'),name,'python3',str(out/'remote-script-client.py'),str(out/script)],check=True)
 print('PHASE2_STAGE_PASS='+name,flush=True)
