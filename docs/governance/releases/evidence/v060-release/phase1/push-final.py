import subprocess,json
from pathlib import Path
root=Path.cwd(); out=root/'.tmp/v060-release/phase1'
def step_file(name,suffix):
 actual='brand-owner-resume-2' if name=='brand-image' else name
 return out/(actual+suffix)
final='493eb23b034b0410780228535b3e293e4ee91f9a'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==final
assert not subprocess.check_output(['git','status','--porcelain=v1'])
names=[p.stem for p in Path('scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh'];assert len(names)==37
names+=['npm-ci','prisma-generate','typecheck','lint','test-full','build','b21','nginx-matrix','public-cutover-mutations','brand-image','compose','image-e2e','archive-build','archive-verify']
for name in names: assert json.loads(step_file(name,'.meta.json').read_text())['exitCode']==0,name
r=json.loads((out/'test-full.json').read_text());assert r['success'] and r['numFailedTests']==0
s=(out/'test-full.log').read_text(); assert 'Unhandled Errors' not in s and 'Unhandled Rejection' not in s
brand=step_file('brand-image','.log').read_text();assert 'RUNTIME_IMAGE_DEPS=PASS' in brand and 'BRAND_IMAGE=PASS' in brand
for name in ['audit-production','audit-all']:
 r=json.loads(step_file(name,'.log').read_text()); assert r['metadata']['vulnerabilities']['critical']==0
 if name=='audit-production':assert r['metadata']['vulnerabilities']['high']==4
print('PRE_PUSH_GATES=PASS',flush=True)
branch='release/v0.6.0-2026-10-14'
subprocess.run(['git','-c','core.sshCommand=ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes','push','-u','origin',branch],check=True)
remote=subprocess.check_output(['git','-c','core.sshCommand=ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes','ls-remote','--heads','origin','refs/heads/'+branch],text=True)
assert remote.split()[0]==final,remote
print('GITHUB_FINAL_PUSH=PASS '+remote.strip(),flush=True)
