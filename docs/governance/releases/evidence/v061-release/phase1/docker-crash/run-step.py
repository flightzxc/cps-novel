from pathlib import Path
import os,sys,time,subprocess,json,re,signal
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
lock=Path('/Users/chenweifeng/Documents/cps海阅/.heavy-test.lock')
name=sys.argv[1];cmd=sys.argv[2:];own=False
try:
 while True:
  try:lock.mkdir();own=True;break
  except FileExistsError:time.sleep(15)
 while os.getloadavg()[0]>18:time.sleep(15)
 env=dict(os.environ,DEVELOPER_DIR='/Library/Developer/CommandLineTools',HTTP_PROXY='http://127.0.0.1:7899',HTTPS_PROXY='http://127.0.0.1:7899',http_proxy='http://127.0.0.1:7899',https_proxy='http://127.0.0.1:7899',NO_PROXY='localhost,127.0.0.1,::1',no_proxy='localhost,127.0.0.1,::1',NEXT_TELEMETRY_DISABLED='1',NEXT_PROBE_STRICT='1',npm_config_proxy='http://127.0.0.1:7899',npm_config_https_proxy='http://127.0.0.1:7899')
 if (out/(name+'.log')).exists(): raise SystemExit('Refusing to overwrite evidence: '+name)
 started=time.time();print('START '+name,flush=True)
 def redact(s):
  s=re.sub(r'0x4[A-Za-z0-9_-]+','[TURNSTILE_REDACTED]',s)
  return re.sub(r'(postgres(?:ql)?://[^:/\s]+:)[^@\s]+@',r'\1[REDACTED]@',s)
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(cmd,cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,errors='replace')
  for line in p.stdout:log.write(redact(line));log.flush()
  rc=p.wait()
 meta={'name':name,'command':cmd,'startedAt':started,'finishedAt':time.time(),'exitCode':rc};meta['durationSeconds']=meta['finishedAt']-started
 (out/(name+'.meta.json')).write_text(json.dumps(meta,indent=2)+'\n')
 print('END '+name+' exit='+str(rc)+' seconds='+str(round(meta['durationSeconds'],1)),flush=True)
 sys.exit(rc)
finally:
 if own:lock.rmdir()
