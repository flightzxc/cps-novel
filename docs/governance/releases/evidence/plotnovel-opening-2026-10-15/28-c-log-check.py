from collections import Counter
counts={}
for service in ['worker','worker-light']:
 r=subprocess.run(['docker','logs','--since','2026-10-14T18:40:08.732307Z','--until','2026-10-14T18:40:27Z',NAMES[service]],stdin=subprocess.DEVNULL,text=True,capture_output=True)
 assert r.returncode==0
 c=Counter();failures=0
 for l in (r.stdout+'\n'+r.stderr).splitlines():
  try:x=json.loads(l)
  except ValueError:continue
  if x.get('event')=='upstream_call' and x.get('endpoint') in ['getbydataid','getchapterinfo','getcode','getlistpc']:
   c[(x['endpoint'],x.get('httpStatus'),x.get('outcome'))]+=1
  if x.get('event')=='preview_read_failed':failures+=1
 counts[service]={'observations':[{'endpoint':a,'httpStatus':b,'outcome':c0,'count':n} for (a,b,c0),n in c.items()],'previewFailureEvents':failures}
print('PREVIEW_TASK_WINDOW_LOG_COUNTS='+json.dumps(counts),flush=True)
print('C_FINAL_READONLY=PASS',flush=True)
