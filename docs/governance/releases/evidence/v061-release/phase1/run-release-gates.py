from pathlib import Path
import subprocess,sys
root=Path.cwd();runner=root/'.tmp/v061-release/phase1/run-step.py'
steps=[('build',['npm','run','build']),('dictionary-static',['node','scripts/check-database-dictionary-drift.mjs','--static'])]
scripts=sorted(p for p in Path('scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh')
assert len(scripts)==37
steps.extend((p.stem,['/bin/bash',str(p)]) for p in scripts)
steps.extend([('compose',['/bin/bash','.tmp/v061-release/phase1/compose-check.sh']),('b21',['/bin/bash','scripts/measure-tagging-task-memory.sh']),('nginx-matrix',['/bin/bash','scripts/preproduction/verify-nginx-matrix.sh']),('public-cutover-mutations',['node','scripts/preproduction/verify-public-cutover-mutations.mjs'])])
for name,cmd in steps:
 rc=subprocess.call([sys.executable,str(runner),name,*cmd])
 if rc:print('RELEASE_GATE_STOP='+name,flush=True);sys.exit(rc)
print('RELEASE_NON_IMAGE_GATES=PASS',flush=True)
