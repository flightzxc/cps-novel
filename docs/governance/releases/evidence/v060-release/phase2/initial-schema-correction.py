import subprocess,json,pathlib,hashlib
SQL="BEGIN READ ONLY; SELECT json_build_object('new_column_exists',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='promo_link' AND column_name='upstream_code_present'),'new_function_exists',to_regprocedure('public.code_mode_upstream_code(text)') IS NOT NULL); COMMIT;"
r=subprocess.run(['docker','exec','-i','cps-novel-postgres-1','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','cps_novel','-At'],input=SQL,text=True,capture_output=True);print(r.stdout);print(r.stderr);assert r.returncode==0
a=next(json.loads(x) for x in r.stdout.splitlines() if x.startswith('{'));assert not a['new_column_exists'] and not a['new_function_exists']
print('NEW_SCHEMA_ABSENT=PASS')
print('NGINX_BEFORE_HASHES='+json.dumps({p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in ['/etc/nginx/conf.d/cps-novel-preprod.conf','/etc/nginx/nginx.conf']}))
