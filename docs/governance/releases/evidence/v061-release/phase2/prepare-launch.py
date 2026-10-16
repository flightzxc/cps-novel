from pathlib import Path
r=Path.cwd();o=r/'.tmp/v061-release/phase2'
s=(o/'deploy-v061.py').read_text()
(o/'launch-deploy.py').write_text("import pathlib,subprocess\np=pathlib.Path('/opt/cps-novel/shared/artifacts/verified/v061/deploy-v061.py');assert not p.exists();p.write_text("+repr(s)+");p.chmod(0o600)\nwith pathlib.Path('/opt/cps-novel/logs/release-v0.6.1-cb255e0.wrapper.log').open('x') as f:\n proc=subprocess.Popen(['python3','-u',str(p)],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)\nprint('DEPLOY_WRAPPER_PID='+str(proc.pid))\n")
(o/'pull-deploy.py').write_text((r/'docs/governance/releases/evidence/v060-release/phase2/pull-deploy.py').read_text().replace('0.6.0-493eb23','0.6.1-cb255e0'))
print('LAUNCH_HELPERS_READY')
