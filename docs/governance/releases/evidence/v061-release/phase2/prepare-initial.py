from pathlib import Path
import ast,json,hashlib
root=Path.cwd();out=root/'.tmp/v061-release/phase2'
def literal(path,name):
 tree=ast.parse(Path(path).read_text())
 return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
old=root/'docs/governance/releases/evidence/v060-release/phase2'
base=literal(old/'predeploy-readiness.py','SQL')
gate=base.split("SELECT 'PUBLIC_CUTOVER_PAUSE_GATE=PASS';")[0]
gate=gate.replace('END $$;',"IF EXISTS (SELECT 1 FROM generic_task WHERE task_type='moboreader.preview_refresh.v1' AND status IN ('pending','processing')) THEN RAISE EXCEPTION 'PREVIEW_INFLIGHT=FAIL'; END IF;\nEND $$;")
q=literal(root/'docs/governance/releases/evidence/plotnovel-bulk-publish-2026-10-15/phase1/production-plan.py','q')
expected=[{'name':p.parent.name,'checksum':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((root/'prisma/migrations').glob('*/migration.sql'))]
source='''import subprocess,json,pathlib,hashlib,datetime,os,time
run=lambda a:subprocess.check_output(a,text=True).strip()
assert run(['hostname'])=='haiyue-vps'
p=pathlib.Path('/opt/cps-novel/shared/env/preprod.env'); raw=p.read_bytes(); sha=hashlib.sha256(raw).hexdigest();print('ENV_BEFORE_SHA256='+sha);assert sha=='f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369'
root=pathlib.Path('/opt/cps-novel/current').resolve();assert root.name=='493eb23b034b0410780228535b3e293e4ee91f9a'
lines=raw.decode().splitlines(); keys=['FEATURE_SITEMAP_AUTO_REFRESH','FEATURE_INDEXNOW_OUTBOX','INDEXNOW_OUTBOX_ALLOW_WRITE','FEATURE_INDEXNOW_DELIVERY','INDEXNOW_DELIVERY_ALLOW_WRITE','PREPROD_APPROVED_OPEN_WRITE_GATES','WORKER_TASK_ALLOWLIST','WORKER_LIGHT_TASK_ALLOWLIST']; flags={k:next((l.split('=',1)[1] for l in lines if l.startswith(k+'=')),None) for k in keys};print('APPROVED_FLAGS='+json.dumps(flags))
health=json.loads(run(['docker','exec','cps-novel-web-1','wget','-qO-','http://127.0.0.1:3000/api/health']));assert health['ok'] and health['build']['version']=='0.6.0' and health['build']['commit']==root.name;print('HEALTH_BEFORE='+json.dumps(health))
pg=json.loads(run(['docker','inspect','cps-novel-postgres-1']))[0]['Id'];print('POSTGRES_BEFORE_ID='+pg)
for i in range(3):
 n=len(run(['ss','-Htn','state','established','( sport = :80 or sport = :443 )']).splitlines()); print('TRAFFIC_SAMPLE='+json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'publicEstablished':n}),flush=True);assert n<=2,'LOW_TRAFFIC_WINDOW_NOT_READY'
 if i<2:time.sleep(10)
def sql(q):
 r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=q,text=True,capture_output=True);print(r.stdout);print(r.stderr);assert r.returncode==0;return [json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')]
'''
source+='rows=sql('+repr(gate+"SELECT 'PUBLIC_CUTOVER_PAUSE_GATE=PASS';\n"+q+"\nSELECT json_build_object('migrations',(SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolled_back',rolled_back_at IS NOT NULL) ORDER BY migration_name) FROM _prisma_migrations),'previewInflight',(SELECT count(*) FROM generic_task WHERE task_type='moboreader.preview_refresh.v1' AND status IN ('pending','processing')),'latestSitemap',(SELECT row_to_json(x) FROM (SELECT id,status,created_at,updated_at FROM generic_task WHERE task_type='sitemap_refresh' ORDER BY created_at DESC LIMIT 1) x)); COMMIT;")+')\n'
source+="assert rows[0]['manualCount']==635 and rows[0]['publishedCount']==1977\nx=rows[1]; assert [{'name':m['name'],'checksum':m['checksum']} for m in x['migrations']]=="+repr(expected)+"\nassert len(x['migrations'])==27 and all(m['finished'] and not m['rolled_back'] for m in x['migrations']) and x['previewInflight']==0\n"
source+='''status=json.loads(run(['docker','exec','cps-novel-worker-light-1','tsx','scripts/indexnow-status.ts']));print('INDEXNOW_BEFORE='+json.dumps(status));assert not status['control']['breaker']['open'] and not status['control']['rateLimit']['waiting'] and status['outbox']['dueUrls']==0 and not status['outbox']['deadLetters'] and not status['tasks']['inFlightBatchTasks']
pre=subprocess.run([str(root/'scripts/preproduction/preflight.sh')],env=dict(os.environ,GIT_COMMIT=root.name,CPS_NOVEL_APP_IMAGE='cps-novel:0.6.0-493eb23'),text=True,capture_output=True);print(pre.stdout);print(pre.stderr);assert pre.returncode==0
print('PREDEPLOY_READ_ONLY=PASS')
'''
(out/'remote-initial.py').write_text(source)
(out/'remote-client.py').write_text((old/'remote-script-client.py').read_text())
runner=(old/'run.py').read_text().replace('.tmp/v060-release/phase2','.tmp/v061-release/phase2');(out/'run.py').write_text(runner)
print('INITIAL_HELPERS_READY')
