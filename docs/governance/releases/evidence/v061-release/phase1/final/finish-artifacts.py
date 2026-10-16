from pathlib import Path
import subprocess,sys,json,hashlib
out=Path('.tmp/v061-release/phase1');runner=out/'run-step.py';final='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'
def step(name,*cmd):return subprocess.call([sys.executable,str(runner),name,*cmd])
assert step('git-push-final',sys.executable,str(out/'push-phase1.py'))==0
assert step('docker-space-archive','docker','system','df')==0
name='archive-build'
cmd=['env','APPROVED_GIT_COMMIT='+final,'RELEASE_TARGET_PLATFORM=linux/amd64','/bin/bash','scripts/preproduction/build-release-archive.sh']
rc=step(name,*cmd)
brand=json.loads((out/'effective-brand.json').read_text())['brand-image']
if rc and 'ECONNRESET' in (out/(name+'.log')).read_text() and 'econnreset' not in brand:
 assert step('docker-space-archive-econnreset-retry','docker','system','df')==0
 name='archive-build-econnreset-retry-1';rc=step(name,*cmd)
 if rc==0:(out/'effective-artifact.json').write_text(json.dumps({'archive-build':name})+'\n')
assert rc==0,'archive build gate failed'
manifest=Path('.tmp/preproduction-archive')/(final+'.json');m=json.loads(manifest.read_text());archive=manifest.parent/m['archive_filename']
h=hashlib.sha256()
with archive.open('rb') as f:
 for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
sha=h.hexdigest();assert sha==m['archive_sha256']
assert step('archive-verify','/bin/bash','scripts/preproduction/verify-release-archive.sh','--manifest',str(manifest.resolve()),'--dir',str(manifest.parent.resolve()),'--expected-archive-sha256',sha,'--approved-commit',final,'--load')==0
assert step('code-bundle',sys.executable,str(out/'code-bundle.py'))==0
assert step('phase1-validation',sys.executable,str(out/'validate-phase1.py'))==0
result={'status':'phase1_complete_not_deployed','final':final,'tree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip(),'archive':str(archive.resolve()),'archiveSha256':sha,'manifest':str(manifest.resolve()),'ociTarget':m['oci']['target']['digest'],'ociPlatformManifest':m['oci']['platform_manifest']['digest'],'ociConfig':m['oci']['config']['digest'],'platform':m['image_platform'],'opsHead':json.loads((out/'push-result.json').read_text())['opsHead'],'runnersPassed':37,'productionConnected':False,'deploymentRequires':'Owner says 批准部署','generationRequires':'Owner reviews dry-run and says 批准补发'}
(out/'phase1-final-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('PHASE1=PASS NOT_DEPLOYED=yes',flush=True)
print(json.dumps(result,ensure_ascii=False),flush=True)
