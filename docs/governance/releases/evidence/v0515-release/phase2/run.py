from pathlib import Path
import subprocess,sys,json,time,os
root=Path.cwd();out=root/'.tmp/v0515-release/phase2';name=sys.argv[1];cmd=sys.argv[2:];log=out/(name+'.log');assert not log.exists(),log
start=time.time();print('START='+name,flush=True)
with log.open('wb') as f: rc=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT).returncode
meta={'name':name,'command':cmd,'exitCode':rc,'startedAt':start,'finishedAt':time.time()};(out/(name+'.meta.json')).write_text(json.dumps(meta,indent=2)+'\n')
print('END='+name+' EXIT='+str(rc),flush=True)
if rc:print(log.read_text(errors='replace')[-16000:]);raise SystemExit(rc)
