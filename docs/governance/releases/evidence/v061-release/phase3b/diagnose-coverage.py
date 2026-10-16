import subprocess,json
for c in ['cps-novel-web-1','cps-novel-worker-1']:
 info=json.loads(subprocess.check_output(['docker','inspect',c],text=True))[0];print(json.dumps({'container':c,'user':info['Config']['User']}))
 if c.endswith('web-1'):
  print(subprocess.check_output(['docker','exec','-u','0',c,'stat','-c','%a %u %g %n','/tmp/v061-account-input.json','/tmp/plotnovel-b47-20261016-manifest.json','/tmp/v061-coverage.ts'],text=True))
for c in ['cps-novel-web-1','cps-novel-postgres-1']:
 r=subprocess.run(['docker','logs','--since','2026-10-16T14:54:44.264981+00:00',c],capture_output=True,text=True,check=True);lines=(r.stdout+r.stderr).splitlines();print(json.dumps({'container':c,'permissionDenied':sum('permission denied' in l.lower() for l in lines),'error':sum('ERROR:' in l or '"level":"error"' in l for l in lines)}))
