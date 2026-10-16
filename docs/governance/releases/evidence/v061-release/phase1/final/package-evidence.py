from pathlib import Path
import json,hashlib,re,shutil,subprocess
out=Path('.tmp/v061-release/phase1');dest=Path('docs/governance/releases/evidence/v061-release/phase1/final');dest.mkdir(parents=True,exist_ok=True)
assert not any(dest.iterdir()),'refusing to overwrite final evidence'
for p in sorted(out.iterdir()):
 if p.is_file() and p.suffix in ['.log','.json','.py','.sh','.txt'] and p.name!='reference-baseline.json':
  s=p.read_text();s=re.sub(r'0x4[A-Za-z0-9_-]+','[TURNSTILE_REDACTED]',s);(dest/p.name).write_text(s)
ops=Path('/Users/chenweifeng/Documents/cps海阅/plotnovel-b47-ops/.tmp/v061-release/phase1');d=dest/'ops';d.mkdir()
for p in sorted(ops.iterdir()):
 if p.is_file() and p.suffix in ['.log','.json','.py']:
  s=p.read_text();s=re.sub(r'0x4[A-Za-z0-9_-]+','[TURNSTILE_REDACTED]',s);(d/p.name).write_text(s)
manifest=Path('.tmp/preproduction-archive/cb255e0f1c93041eda6aefeefbb541d7eddfc15f.json');shutil.copyfile(manifest,dest/'release-manifest.json')
files=[]
for p in sorted(dest.rglob('*')):
 if p.is_file():
  assert not re.search(r'0x4[A-Za-z0-9_-]+',p.read_text())
  files.append({'file':str(p.relative_to(dest)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(dest/'evidence-sha256.json').write_text(json.dumps(files,indent=2)+'\n')
print('FINAL_EVIDENCE=PASS files='+str(len(files))+' turnstile_matches=0')
