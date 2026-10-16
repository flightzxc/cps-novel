from pathlib import Path
import subprocess,json,sys
out=Path('.tmp/v061-release/phase1');final='cb255e0f1c93041eda6aefeefbb541d7eddfc15f';branch='release/v0.6.1-2026-10-16'
ops=Path('/Users/chenweifeng/Documents/cps海阅/plotnovel-b47-ops');opsbranch='ops/plotnovel-b47-republish-2026-10-16'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==final
assert not subprocess.check_output(['git','status','--porcelain=v1'])
assert subprocess.call([sys.executable,str(out/'validate-phase1.py'),'--prepush'])==0
for name in ['unit-esm-fixed','typecheck-esm-fixed','lint-esm-fixed','ops-postgres','unit-after-mutations']:
 assert json.loads((ops/'.tmp/v061-release/phase1'/f'{name}.meta.json').read_text())['exitCode']==0,name
assert 'OPS_MUTATIONS=PASS groups=2 restored_clean=yes' in (ops/'.tmp/v061-release/phase1/mutation-summary.log').read_text()
assert not subprocess.check_output(['git','-C',str(ops),'status','--porcelain=v1'])
source='scripts/ops/plotnovel-bulk-generate-publish.ts'
assert (ops/source).read_bytes()==subprocess.check_output(['git','-C',str(ops),'show','HEAD:'+source])
opshead=subprocess.check_output(['git','-C',str(ops),'rev-parse','HEAD'],text=True).strip()
ssh='core.sshCommand=ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes'
print('PRE_PUSH_GATES=PASS',flush=True)
subprocess.run(['git','-c',ssh,'push','origin',final+':refs/heads/'+branch],check=True)
remote=subprocess.check_output(['git','-c',ssh,'ls-remote','--heads','origin','refs/heads/'+branch],text=True)
assert remote.split()[0]==final
print('GITHUB_FINAL_PUSH=PASS commit='+final,flush=True)
subprocess.run(['git','-C',str(ops),'-c',ssh,'push','-u','origin',opsbranch],check=True)
remote=subprocess.check_output(['git','-C',str(ops),'-c',ssh,'ls-remote','--heads','origin','refs/heads/'+opsbranch],text=True)
assert remote.split()[0]==opshead
(out/'push-result.json').write_text(json.dumps({'final':final,'releaseBranch':branch,'opsHead':opshead,'opsBranch':opsbranch,'verified':True},indent=2)+'\n')
print('GITHUB_OPS_PUSH=PASS commit='+opshead,flush=True)
