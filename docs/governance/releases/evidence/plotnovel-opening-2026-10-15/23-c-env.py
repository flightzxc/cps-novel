root=pathlib.Path('/opt/cps-novel/releases')/FINAL
manifest=pathlib.Path('/opt/cps-novel/shared/artifacts/verified/v060')/(FINAL+'.json')
assert manifest.is_file()
script="set -euo pipefail; set +x; source "+str(root/'scripts/preproduction/lib.sh')+"; preprod_read_release_manifest "+str(manifest)+"; export GIT_COMMIT=\"$PREPROD_RELEASE_COMMIT\" CPS_NOVEL_APP_IMAGE=\"$PREPROD_RELEASE_IMAGE_REF\"; preprod_load_env; preprod_compose config --format json"
cfg=json.loads(run(['bash','-c',script]).stdout)
for service in ['web','worker','worker-light']:
 assert cfg['services'][service]['environment'].get('MOBOREADER_PREVIEW_SOURCE_APP_CODES')=='moboreader'
 print('COMPOSE_PREVIEW_PASSTHROUGH=PASS service='+service,flush=True)
p=pathlib.Path('/opt/cps-novel/shared/env/preprod.env');old=p.read_bytes();assert hashlib.sha256(old).hexdigest()==ENV_SHA
key=b'MOBOREADER_PREVIEW_SOURCE_APP_CODES=';lines=old.splitlines(keepends=True);found=[l for l in lines if l.startswith(key)]
assert len(found)<=1
if found:
 assert found[0].rstrip(b'\r\n')==key+b'moboreader'
 ending=b'\r\n' if found[0].endswith(b'\r\n') else b'\n' if found[0].endswith(b'\n') else b''
 new=b''.join(key+b'moboreader,plotnovel'+ending if l.startswith(key) else l for l in lines)
else:
 assert old.endswith(b'\n');new=old+key+b'moboreader,plotnovel\n'
normalize=lambda b:b''.join(l for l in b.splitlines(keepends=True) if not l.startswith(key))
assert normalize(new)==normalize(old)
import shutil,os,tempfile,difflib
backup=p.with_name(p.name+'.bak-plotnovel-preview-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
assert not backup.exists();shutil.copy2(p,backup);backup.chmod(0o600);assert backup.read_bytes()==old
st=p.stat();tmp=p.with_name(p.name+'.new-plotnovel-preview')
with tmp.open('xb') as f:os.chmod(tmp,st.st_mode & 0o777);os.chown(tmp,st.st_uid,st.st_gid);f.write(new)
os.replace(tmp,p);assert p.read_bytes()==new
with tempfile.TemporaryDirectory(prefix='plotnovel-preview-cmp-',dir=p.parent) as d:
 a=pathlib.Path(d)/'before';b=pathlib.Path(d)/'after';a.write_bytes(normalize(backup.read_bytes()));b.write_bytes(normalize(p.read_bytes()));run(['cmp',str(a),str(b)])
before=[l.decode() for l in lines if l.startswith(key)];after=[l.decode() for l in new.splitlines(keepends=True) if l.startswith(key)]
print('ENV_SAFE_DIFF='+''.join(difflib.unified_diff(before,after,fromfile='before-whitelist-only',tofile='after-whitelist-only')),flush=True)
x={'at':stamp(),'beforeSha256':hashlib.sha256(old).hexdigest(),'afterSha256':hashlib.sha256(new).hexdigest(),'backup':str(backup),'backupMode':'0600','otherBytesCmp':'PASS','onlyChangedKey':'MOBOREADER_PREVIEW_SOURCE_APP_CODES','afterValue':'moboreader,plotnovel'}
opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15');(opdir/'c-env-change.json').write_text(json.dumps(x)+'\n');(opdir/'c-env-change.json').chmod(0o600)
print('ENV_PREVIEW_CHANGE='+json.dumps(x),flush=True);print('ENV_ONE_WHITELIST_ONLY=PASS',flush=True)
