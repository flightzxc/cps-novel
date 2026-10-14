root=pathlib.Path('/opt/cps-novel/releases')/FINAL
manifest=pathlib.Path('/opt/cps-novel/shared/artifacts/verified/v060')/(FINAL+'.json')
before={s:json.loads(run(['docker','inspect',n]).stdout)[0] for s,n in NAMES.items()}
prefix='set -euo pipefail; set +x; source '+str(root/'scripts/preproduction/lib.sh')+'; preprod_read_release_manifest '+str(manifest)+'; export GIT_COMMIT="$PREPROD_RELEASE_COMMIT" CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF" PREPROD_RELEASE_MANIFEST='+str(manifest)+'; preprod_load_env; '
pre=run(['bash','-c',prefix+str(root/'scripts/preproduction/preflight.sh')]);assert 'PREPROD_PREFLIGHT=PASS' in pre.stdout
print('C_PREFLIGHT_STDOUT='+re.sub(r'0x4[A-Za-z0-9_-]+','[REDACTED]',pre.stdout),flush=True)
started=stamp();print('C_RECREATE_STARTED='+started,flush=True)
up=run(['bash','-c',prefix+'preprod_compose_app_up --force-recreate web worker worker-light; preprod_wait_for_service_health web worker worker-light; preprod_assert_container_image web worker worker-light scheduler'])
print('C_RUNTIME_ORIGINAL_STDOUT='+re.sub(r'0x4[A-Za-z0-9_-]+','[REDACTED]',up.stdout),flush=True)
after={s:json.loads(run(['docker','inspect',n]).stdout)[0] for s,n in NAMES.items()}
for s in ['postgres','scheduler','backup-timer']:assert before[s]['Id']==after[s]['Id'], 'unexpected other container recreation'
for s in ['web','worker','worker-light']:
 assert before[s]['Id']!=after[s]['Id'] and after[s]['State']['Health']['Status']=='healthy'
 a=dict(v.split('=',1) for v in before[s]['Config']['Env']);b=dict(v.split('=',1) for v in after[s]['Config']['Env'])
 assert b.pop('MOBOREADER_PREVIEW_SOURCE_APP_CODES')=='moboreader,plotnovel';a.pop('MOBOREADER_PREVIEW_SOURCE_APP_CODES',None);assert a==b, 'other runtime env changed'
 assert before[s]['Image']==after[s]['Image'] and after[s]['Config']['Image']=='cps-novel:0.6.0-493eb23'
health=json.loads(run(['docker','exec',NAMES['web'],'wget','-qO-','http://127.0.0.1:3000/api/health']).stdout)
assert health['ok'] and health['build']['version']=='0.6.0' and health['build']['commit']==FINAL and health['metadataConsistency']['status']=='passed'
x={'startedAt':started,'finishedAt':stamp(),'recreated':['web','worker','worker-light'],'unchanged':['postgres','scheduler','backup-timer'],'beforeIds':{s:v['Id'] for s,v in before.items()},'afterIds':{s:v['Id'] for s,v in after.items()},'otherEnvIdentical':True,'sameImages':True,'health':health['build'],'metadataConsistency':health['metadataConsistency']['status'],'envSha256':ENV_SHA}
opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15');(opdir/'c-runtime.json').write_text(json.dumps(x)+'\n')
print('C_RUNTIME_READBACK='+json.dumps(x),flush=True);print('C_RUNTIME=PASS',flush=True)
