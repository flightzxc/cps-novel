import subprocess,json,base64,pathlib
remote="import pathlib,json,base64; b='/opt/cps-novel/logs/release-v0.5.15-db62350'; suffixes=['.log','.timeline.json','.exit.json','.wrapper.log']; print(json.dumps({s:base64.b64encode(pathlib.Path(b+s).read_bytes()).decode() for s in suffixes}))"
r=subprocess.run(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps','python3','-c',__import__('shlex').quote(remote)],capture_output=True,text=True)
print(r.stderr,end='');assert r.returncode==0,r.returncode
x=json.loads(r.stdout);p=pathlib.Path('.tmp/v0515-release/phase2')
for s,b in x.items():
 target=p/('release'+s);assert not target.exists();target.write_bytes(base64.b64decode(b))
exit=json.loads((p/'release.exit.json').read_text());assert exit['exit']==0,exit
print('DEPLOY_ORIGINAL_FILES=PASS RELEASE_EXIT=0');print((p/'release.timeline.json').read_text())
