import subprocess,json,pathlib,hashlib,datetime,re,sys
FINAL='493eb23b034b0410780228535b3e293e4ee91f9a'
ENV_SHA='f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369'
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args,allowed=(0,)):
 r=subprocess.run(args,stdin=subprocess.DEVNULL,text=True,capture_output=True)
 if r.returncode not in allowed:
  print('COMMAND_REFUSED='+json.dumps({'command':args,'exit':r.returncode,'stderrSha256':hashlib.sha256(r.stderr.encode()).hexdigest()}),flush=True)
  raise RuntimeError('remote command failed; unfiltered stderr withheld')
 return r
assert run(['hostname']).stdout.strip()=='haiyue-vps'
NAMES={}
for name in run(['docker','ps','--format','{{.Names}}']).stdout.splitlines():
 info=json.loads(run(['docker','inspect',name]).stdout)[0];labels=info['Config'].get('Labels') or {}
 if labels.get('com.docker.compose.project')=='cps-novel':NAMES[labels['com.docker.compose.service']]=name
assert all(k in NAMES for k in ['web','worker','worker-light','scheduler','backup-timer','postgres']), 'production container set incomplete'
assert pathlib.Path('/opt/cps-novel/current').resolve().name==FINAL
assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV_SHA, 'env sha mismatch; no changes made'
health=json.loads(run(['docker','exec',NAMES['web'],'wget','-qO-','http://127.0.0.1:3000/api/health']).stdout)
assert health['ok'] and health['build']['version']=='0.6.0' and health['build']['commit']==FINAL and health['metadataConsistency']['status']=='passed', 'release identity mismatch'
def sql(query):
 assert '\nPLOTNOVEL_SQL\n' not in query
 command="psql -X -v ON_ERROR_STOP=1 -U postgres -d cps_novel -At <<'PLOTNOVEL_SQL'\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"+query+'\nCOMMIT;\nPLOTNOVEL_SQL\n'
 return run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on',NAMES['postgres'],'bash','-c',command]).stdout
print('REMOTE_CONTEXT='+json.dumps({'at':stamp(),'final':FINAL,'envSha256':ENV_SHA,'containers':NAMES,'health':health['build'],'metadataConsistency':health['metadataConsistency']['status']}),flush=True)
