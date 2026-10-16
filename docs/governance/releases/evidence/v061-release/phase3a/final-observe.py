import subprocess,json,re
run=lambda a:subprocess.check_output(a,text=True)
since='2026-10-16T14:08:03.925223+00:00';rows=[]
for service in ['web','worker','worker-light','scheduler','backup-timer','postgres']:
 r=subprocess.run(['docker','logs','--since',since,'cps-novel-'+service+'-1'],capture_output=True,text=True,check=True);lines=(r.stdout+r.stderr).splitlines();errors=0
 for line in lines:
  try:
   e=json.loads(line)
   if isinstance(e,dict) and (e.get('level') in ('error','fatal') or e.get('severity') in ('ERROR','FATAL','PANIC')):errors+=1
  except ValueError:
   if re.search(r'(^|\s)(?:ERROR|FATAL|PANIC|Error:|Unhandled)',line):errors+=1
 denied=sum('permission denied' in line.lower() for line in lines);row={'service':service,'error':errors,'permissionDenied':denied};rows.append(row);assert errors==denied==0,row
status=json.loads(run(['docker','exec','cps-novel-worker-light-1','tsx','scripts/indexnow-status.ts']));assert not status['control']['breaker']['open'] and not status['control']['rateLimit']['waiting'] and not status['outbox']['deadLetters'] and status['outbox']['dueUrls']==0
print(json.dumps({'status':'PASS','since':since,'logs':rows,'indexnow':status}));print('POST_REHEARSAL_OBSERVE=PASS')
