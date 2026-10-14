import subprocess,json,pathlib,datetime
SQL="\\pset null NULL\nBEGIN READ ONLY;\nSET LOCAL application_name='v060_expected_permission_probe';\nSELECT pg_backend_pid();\nSET ROLE web_app;\nSAVEPOINT expected_denial;\n\\set ON_ERROR_STOP off\nSELECT upstream_code FROM promo_link LIMIT 1;\n\\set ON_ERROR_STOP on\nROLLBACK TO SAVEPOINT expected_denial;\nSELECT public.code_mode_upstream_code('__not_a_real_code__');\nROLLBACK;\n"
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on','cps-novel-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=SQL,text=True,capture_output=True)
# Never emit stdout: it could contain sensitive data if privilege regression succeeds.
assert r.returncode==0,('permission probe exit',r.returncode)
assert r.stderr.strip()=='ERROR:  permission denied for table promo_link', 'expected denial absent or extra error (output withheld)'
rows=r.stdout.splitlines();assert 'NULL' in rows,'fake lookup was not NULL (output withheld)';pid=next(int(x) for x in rows if x.isdigit())
result={'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backendPid':pid,'directRead':'EXPECTED_PERMISSION_DENIED','fakeCodeResult':'NULL','savepointRecovery':'PASS','expectedPostgresErrorCount':1,'expectedStderr':r.stderr.strip()}
p=pathlib.Path('/opt/cps-novel/logs/release-v0.6.0-493eb23.expected-denial.json');assert not p.exists();p.write_text(json.dumps(result,indent=2)+'\n');print('EXPECTED_PERMISSION_PROBE='+json.dumps(result));print('WEB_APP_RESTRICTED_READ=PASS')
