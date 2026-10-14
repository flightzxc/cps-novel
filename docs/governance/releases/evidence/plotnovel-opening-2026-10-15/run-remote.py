from pathlib import Path
import subprocess,json,time,sys,re,hashlib
out=Path('.tmp/plotnovel-opening-2026-10-15');name=sys.argv[1];script=out/sys.argv[2];log=out/(name+'.log');assert not log.exists(), 'refusing to overwrite evidence'
payload=(out/'remote-common.py').read_text()+'\n'+script.read_text();start=time.time()
r=subprocess.run(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','haiyue-vps','python3','-u','-'],input=payload,text=True,capture_output=True)
safe=re.sub(r'0x4[A-Za-z0-9_-]+','[REDACTED]',r.stdout)
log.write_text(safe+('SSH_OR_WRAPPER_STDERR_SHA256='+hashlib.sha256(r.stderr.encode()).hexdigest()+'\n' if r.stderr else ''))
(out/(name+'.meta.json')).write_text(json.dumps({'name':name,'startedAt':start,'finishedAt':time.time(),'exit':r.returncode,'host':'haiyue-vps','script':str(script),'sshOrWrapperStderrSha256':hashlib.sha256(r.stderr.encode()).hexdigest() if r.stderr else None},indent=2)+'\n')
print('STEP='+name+' EXIT='+str(r.returncode),flush=True)
if r.returncode:raise SystemExit(r.returncode)
