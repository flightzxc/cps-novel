from pathlib import Path
import subprocess,json,hashlib
final='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==final
assert not subprocess.check_output(['git','status','--porcelain=v1'])
out=Path('.tmp/preproduction-archive');out.mkdir(parents=True,exist_ok=True)
file=out/'cps-novel-code-cb255e0.bundle';assert not file.exists()
subprocess.run(['git','bundle','create',str(file),'HEAD'],check=True)
subprocess.run(['git','bundle','verify',str(file)],check=True)
h=hashlib.sha256()
with file.open('rb') as f:
 for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
result={'file':str(file.resolve()),'sha256':h.hexdigest(),'bytes':file.stat().st_size,'final':final}
Path('.tmp/v061-release/phase1/code-bundle.json').write_text(json.dumps(result,indent=2)+'\n')
print('CODE_BUNDLE=PASS sha256='+result['sha256'],flush=True)
