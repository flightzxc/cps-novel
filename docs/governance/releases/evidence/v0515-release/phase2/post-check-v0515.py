import subprocess, json, pathlib, re, hashlib

final = 'db623505539c3ca55f55b1270aab829b8db102d7'
root = pathlib.Path('/opt/cps-novel/releases') / final
timeline = json.loads(pathlib.Path('/opt/cps-novel/logs/release-v0.5.15-db62350.timeline.json').read_text())
since = timeline[0]['at']
run = lambda args: subprocess.check_output(args, text=True)
services = ['web','worker','worker-light','scheduler','backup-timer','postgres']
for service in services:
    name = 'cps-novel-' + service + '-1'
    info = json.loads(run(['docker','inspect',name]))[0]
    logs = subprocess.run(['docker','logs','--since',since,name], capture_output=True, text=True, check=True)
    lines = (logs.stdout + logs.stderr).splitlines()
    errors = []
    allowlists = []
    for line in lines:
        try:
            event = json.loads(line)
            if isinstance(event,dict):
                if event.get('level') in ('error','fatal') or event.get('severity') in ('ERROR','FATAL','PANIC'):
                    errors.append(line)
                if event.get('event') == 'worker_task_allowlist': allowlists.append(event)
        except ValueError:
            if re.search(r'(^|\s)(?:ERROR|FATAL|PANIC|Error:|Unhandled)',line): errors.append(line)
    denied = sum('permission denied' in line.lower() for line in lines)
    row = {'service':service,'id':info['Id'],'state':info['State']['Status'],'health':info['State'].get('Health',{}).get('Status'),'error_lines':len(errors),'permission_denied':denied,'since':since}
    print(json.dumps(row),flush=True)
    assert row['state']=='running' and row['health']=='healthy' and row['error_lines']==row['permission_denied']==0, row
    if service=='postgres': assert info['Id']=='691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e'
    if service in ('worker','worker-light'):
        assert len(allowlists)==1 and not allowlists[0]['invalid']
        print('STARTUP_ALLOWLIST='+json.dumps(dict(service=service,**allowlists[0])))
    if service in ('web','worker','worker-light','scheduler'):
        env=dict(x.split('=',1) for x in info['Config']['Env'])
        if service in ('web','worker','worker-light'):
            assert env.get('FEATURE_INDEXNOW_OUTBOX')=='true' and env.get('INDEXNOW_OUTBOX_ALLOW_WRITE')=='true'
            print('INDEXNOW_OUTBOX_UNCHANGED=PASS service='+service)
        assert info['Config']['Image']=='cps-novel:0.5.15-db62350'
        result=subprocess.run(['docker','exec','-i',name,'node','--input-type=module','-'], input=(root/'scripts/preproduction/verify-runtime-image-deps.mjs').read_text(), text=True,capture_output=True,check=True)
        print('service='+service+' '+result.stdout.strip())
health=json.loads(run(['docker','exec','cps-novel-web-1','wget','-qO-','http://127.0.0.1:3000/api/health']))
print('HEALTH='+json.dumps(health))
assert health['build']['version']=='0.5.15' and health['build']['commit']==final
assert health['ok'] and health['metadataConsistency']['status']=='passed' and health['database']['status']=='passed'
version=run(['docker','exec','cps-novel-web-1','node','-e',"console.log(JSON.stringify({next:require('next/package.json').version,nanoid:require('nanoid/package.json').version}))"])
print('WEB_VERSIONS='+version.strip());assert json.loads(version)=={'next':'16.3.8','nanoid':'3.3.18'}
expected={'/etc/nginx/conf.d/cps-novel-preprod.conf':'d2825477d359d905a77ebabaa3cfcb3200ab938379ed955d418a07b4e32a0dfe','/etc/nginx/nginx.conf':'ad9580d1ad6592cf7e4927e0b4049bed025f131e00aa370677e3c2231d5a5e9e'}
actual={p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in expected}
print('POST_NGINX_HASHES='+json.dumps(actual));assert actual==expected
assert pathlib.Path('/opt/cps-novel/current').resolve()==root
assert not pathlib.Path('/opt/cps-novel/shared/maintenance/enabled').exists()
print('BACKUP_TIMER=RUNNING')
print('POST_CHECK=PASS')

import os
pre=subprocess.run([str(root/'scripts/preproduction/preflight.sh')],env=dict(os.environ,GIT_COMMIT=final,CPS_NOVEL_APP_IMAGE='cps-novel:0.5.15-db62350'),text=True,capture_output=True)
print(pre.stdout);print(pre.stderr);assert pre.returncode==0
assert 'PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox,indexnow_delivery open=catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox,indexnow_delivery' in pre.stdout
print('POST_PREFLIGHT_UNCHANGED=PASS')
subprocess.run(['docker','exec','cps-novel-worker-1','tsx','scripts/ops/effective-tag-projection.ts','check'],check=True)
status=json.loads(run(['docker','exec','cps-novel-worker-light-1','tsx','scripts/indexnow-status.ts']))
print('INDEXNOW_STATUS='+json.dumps(status,ensure_ascii=False))
assert not status['control']['breaker']['open'] and not status['control']['rateLimit']['waiting']
assert status['keyValidation']['state']!='none' and not status['outbox']['deadLetters'] and status['outbox']['dueUrls']==0
assert not status['tasks']['inFlightBatchTasks']
assert all(status['tasks']['deliveryTaskItemsByStatus'].get(k,0)==0 for k in ['pending','processing'])
print('INDEXNOW_POST_STATUS=PASS')
