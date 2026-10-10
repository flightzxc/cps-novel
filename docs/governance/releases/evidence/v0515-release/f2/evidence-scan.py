import subprocess,json,pathlib,base64,shlex
out=pathlib.Path('docs/governance/releases/evidence/v0515-release/f2')
blob=b'\n'.join(p.read_bytes() for p in out.rglob('*') if p.is_file())
remote='''import json,sys,base64,pathlib,re,subprocess
blob=base64.b64decode(json.load(sys.stdin)['blob']);secrets=set()
for line in pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_text().splitlines():
 if '=' not in line or line.lstrip().startswith('#'):continue
 k,v=line.split('=',1)
 if re.search(r'PASSWORD|TOKEN|SECRET|ENCRYPTION_KEY|HASH_SALT|INDEXNOW_KEY$',k) and not k.endswith('_FILE') and len(v)>8:secrets.add(v.encode())
for service in ['web','worker','worker-light','scheduler','backup-timer','postgres']:
 name='cps-novel-'+service+'-1';info=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
 for m in info['Mounts']:
  if m['Destination'].startswith('/run/secrets/'):
   raw=subprocess.check_output(['docker','exec','-u','0',name,'cat',m['Destination']]).strip()
   if len(raw)>8:secrets.add(raw)
   if m['Destination'].endswith('pgpass'):
    for line in raw.splitlines():
     v=line.split(b':')[-1]
     if len(v)>8:secrets.add(v)
leaks=[hash(__import__('hashlib').sha256(s).digest()) for s in secrets if s in blob]
assert not leaks,'actual secret value detected in evidence'
print(json.dumps({'actualSecretValuesChecked':len(secrets),'bytesScanned':len(blob),'leaks':len(leaks)}));print('EVIDENCE_SECRET_SCAN=PASS')
'''
r=subprocess.run(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps','python3','-c',shlex.quote(remote)],input=json.dumps({'blob':base64.b64encode(blob).decode()}).encode());raise SystemExit(r.returncode)
