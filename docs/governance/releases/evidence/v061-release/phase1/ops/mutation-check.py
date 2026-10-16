from pathlib import Path
import subprocess,json,sys
root=Path.cwd();source=root/'scripts/ops/plotnovel-bulk-generate-publish.ts';original=source.read_bytes()
assert subprocess.call(['git','diff','--quiet'])==0
runner=root/'.tmp/v061-release/phase1/run-step.py'
cases=[('identity-version-mutation','meta.version === "0.6.1"','meta.version === "0.6.0"','owner_admin_refused'),('failure-policy-mutation','knownTemplateFailures === 0','knownTemplateFailures * 20 <= expected','rejects every template failure')]
for name,old,new,needle in cases:
 try:
  s=original.decode();assert s.count(old)==1;source.write_text(s.replace(old,new))
  rc=subprocess.call([sys.executable,str(runner),name,'npx','--no-install','vitest','run','--project','node','tests/backend/ops/plotnovel-bulk-generate-publish.test.ts','--reporter=default','--reporter=json','--outputFile=.tmp/v061-release/phase1/'+name+'.json'])
  assert rc!=0,name+' unexpectedly survived'
  report=json.loads((root/'.tmp/v061-release/phase1'/f'{name}.json').read_text())
  failed=[a['fullName'] for t in report['testResults'] for a in t['assertionResults'] if a['status']=='failed']
  assert any(needle in x for x in failed),(name,failed)
  print('MUTATION_CAUGHT=PASS name='+name+' failures='+str(len(failed)),flush=True)
 finally:source.write_bytes(original)
 assert subprocess.call(['git','diff','--quiet'])==0
rc=subprocess.call([sys.executable,str(runner),'unit-after-mutations','npx','--no-install','vitest','run','--project','node','tests/backend/ops/plotnovel-bulk-generate-publish.test.ts'])
assert rc==0
assert subprocess.call(['git','diff','--quiet'])==0
print('OPS_MUTATIONS=PASS groups=2 restored_clean=yes',flush=True)
